'use strict';

const fs = require('fs');
const path = require('path');

// Generates everything a researcher pastes into (or imports to) Qualtrics, from the config.
// Nothing in the output needs editing.

// Embedded data the chat writes back, in the order they are set.
const OUTPUT_FIELDS = [
  ['chat_match_id', 'match ID; merge key with the server export'],
  ['chat_partner_id', "partner's participant ID, or ai for an AI partner"],
  ['chat_match_reason', 'rules the pair satisfied (and any waived by relaxing)'],
  ['chat_reveal', 'the "why you were matched" text this participant saw'],
  ['chat_waited_ms', 'time spent waiting for a partner'],
  ['chat_outcome', 'completed, partner_left, nomatch, or error (with an AI partner also ai_error or ai_budget_exhausted)'],
  ['chat_message_count', 'messages this participant sent'],
  ['chat_met_min_messages', 'true if they sent at least timing.min_messages'],
  ['chat_start_ts', 'when the chat page loaded (ms since 1970)'],
  ['chat_end_ts', 'when the chat ended (ms since 1970)'],
];

function normalizeUrl(url) {
  const u = String(url || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^/\s?#]+$/.test(u)) {
    throw new Error(`--url must be your app's address with no path, e.g. https://my-study.onrender.com (got "${url || ''}")`);
  }
  return new URL(u).origin;
}

const piped = (field) => '${e://Field/' + field + '}';

// The AI prompt variables of every condition: name -> { pipe (Qualtrics piped text), max (characters) }.
function promptVars(config) {
  const out = {};
  for (const c of Object.values(config.conditions)) {
    for (const [n, pipe] of Object.entries(c.ai ? c.ai.vars : {})) {
      out[n] = { pipe, max: Math.max(out[n] ? out[n].max : 0, c.ai.max_var_length) };
    }
  }
  return out;
}

// The URL parameters the chat question sends, as [param, value or Qualtrics piped text].
// `study` picks the study on a server hosting several; a single-study server ignores it.
// withVars: also the AI prompt variables (the question JS reads those from the question HTML instead).
function chatParams(config, { withVars = true } = {}) {
  const { id_param: idParam, condition_param: condParam, fields } = config.participant;
  return [
    ['study', config.study.id],
    [idParam, piped('ResponseID')],
    [condParam, piped(condParam)],
    ...Object.keys(fields).map((f) => [f, piped(f)]),
    ...(withVars ? Object.entries(promptVars(config)).map(([n, v]) => [n, v.pipe]) : []),
  ];
}

// The chat questions a study needs: one, plus one more after each `then: qualtrics` stage.
// segments[k] maps each condition to the stage id that question k starts (k >= 1), or null.
function segments(config) {
  const starts = Object.fromEntries(Object.entries(config.conditions).map(([name, c]) =>
    [name, c.stages.slice(1).filter((st, i) => c.stages[i].then === 'qualtrics').map((st) => st.id)]));
  const n = Math.max(...Object.values(starts).map((a) => a.length));
  return Array.from({ length: n + 1 }, (_, k) => (k ? Object.fromEntries(Object.entries(starts).map(([c, a]) => [c, a[k - 1] ?? null])) : null));
}

// Stage ids reported back to Qualtrics: each stage that hands over to Qualtrics, and each last stage.
function reportedStages(config) {
  const ids = Object.values(config.conditions).filter((c) => c.staged)
    .flatMap((c) => c.stages.filter((st, i) => st.then === 'qualtrics' || i === c.stages.length - 1).map((st) => st.id));
  return [...new Set(ids)];
}

const stageFields = (id) => [
  [`chat_${id}_end_reason`, `how stage "${id}" ended: timer, max_duration, min_reached, both_done, either_done, left, or no_rejoin`],
  [`chat_${id}_message_count`, `messages this participant sent in stage "${id}"`],
  [`chat_${id}_met_min_messages`, `true if they sent at least the stage's min_messages in stage "${id}"`],
];

const questionFile = (k) => (k ? `chat-question-${k + 1}.js` : 'chat-question.js');

// The chat question's HTML. AI prompt variables are piped into hidden elements here rather than into
// the JavaScript, so an answer with quotes or line breaks cannot break the script.
function questionHtml(config, k = 0) {
  const vars = k ? [] : Object.entries(promptVars(config));
  return '<div id="chat-root"></div>\n' +
    vars.map(([n, v]) => `<div id="syncchat-var-${n}" style="display:none">${v.pipe}</div>\n`).join('');
}

// k: which chat question (0 = the first); stageMap: condition -> stage id it starts, for k >= 1.
function questionJs(config, url, k = 0, stageMap = null) {
  const params = chatParams(config, { withVars: false })
    .map(([key, v]) => `        ${JSON.stringify(key)}: ${JSON.stringify(v)}`)
    .join(',\n');
  const transcript = config.embed.send_transcript_to_parent
    ? '\n            set("chat_transcript", d.transcript);'
    : '';
  const staged = reportedStages(config).length > 0;
  const total = segments(config).length;
  const which = total > 1 ? ` (chat question ${k + 1} of ${total})` : '';
  const condParam = config.participant.condition_param;
  const vars = Object.fromEntries(Object.entries(promptVars(config)).map(([n, v]) => [n, v.max]));
  const readVars = !k && Object.keys(vars).length ? `
    // Prompt variables for the AI partner: Qualtrics pipes them into hidden elements of the question
    // HTML (chat-question.html). Each is trimmed and capped at the study's max_var_length.
    var VARS = ${JSON.stringify(vars)};
    Object.keys(VARS).forEach(function (k) {
        var el = document.getElementById("syncchat-var-" + k);
        PARAMS[k] = el ? el.textContent.trim().slice(0, VARS[k]) : "";
    });
` : '';
  const rejoin = stageMap ? `
    // This question rejoins the same partner at a later stage. It skips itself if the chat already
    // ended (no partner, or the partner left) or if this condition has no such stage.
    var STAGE = ${JSON.stringify(stageMap)}[PARAMS[${JSON.stringify(condParam)}]];
    if (!STAGE || "\${e://Field/chat_outcome}" !== "") {
        qEngine.clickNextButton();
        return;
    }
    PARAMS.stage = STAGE;
` : '';
  const stageData = staged ? `
            if (d.stage) {
                set("chat_" + d.stage + "_end_reason", d.end_reason);
                set("chat_" + d.stage + "_message_count", d.stage_message_count);
                set("chat_" + d.stage + "_met_min_messages", d.stage_met_min_messages);
            }` : '';
  const stageEnded = staged ? `
        } else if (d.type === "stage_ended") {
            // A stage ended with \`then: qualtrics\`: save it and move the survey on.
            set("chat_" + d.stage + "_end_reason", d.end_reason);
            set("chat_" + d.stage + "_message_count", d.message_count);
            set("chat_" + d.stage + "_met_min_messages", d.met_min_messages);
            qEngine.clickNextButton();` : '';
  return `// syncchat question JavaScript, generated by \`npm run qualtrics\` for study "${config.study.id}"${which}.
// Paste as-is into the JavaScript of a Text/Graphic question whose HTML is chat-question.html.
// To change anything, edit the study config and re-run the command.
Qualtrics.SurveyEngine.addOnload(function () {
    var qEngine = this;
    var CHAT_URL = ${JSON.stringify(url)};
    var PARAMS = {
${params}
    };
${readVars}${rejoin}
    qEngine.hideNextButton();
    var query = Object.keys(PARAMS).map(function (k) {
        return encodeURIComponent(k) + "=" + encodeURIComponent(PARAMS[k]);
    }).join("&");
    document.getElementById("chat-root").innerHTML = '<iframe id="syncchat-frame" src="' + CHAT_URL + '/?' + query + '" ' +
        'style="width:100%;height:70vh;min-height:520px;border:1px solid #e4e7eb;border-radius:12px;" ' +
        'allow="clipboard-write"></iframe>';

    var set = function (k, v) {
        if (v !== undefined && v !== null) {
            Qualtrics.SurveyEngine.setEmbeddedData(k, typeof v === "object" ? JSON.stringify(v) : String(v));
        }
    };
    set("chat_start_ts", Date.now());

    window.addEventListener("message", function (evt) {
        // Only trust messages from the chat app.
        if (evt.origin !== CHAT_URL || !evt.data || evt.data.source !== "syncchat") return;
        var d = evt.data;
        if (d.type === "chat_matched") {
            set("chat_match_id", d.match_id);
            set("chat_partner_id", d.partner_id);
            set("chat_match_reason", d.match_reason);
            set("chat_reveal", d.reveal);
            set("chat_waited_ms", d.waited_ms);
        } else if (d.type === "chat_ended" || d.type === "nomatch") {
            set("chat_outcome", d.outcome);
            set("chat_match_id", d.match_id);
            set("chat_message_count", d.message_count);
            set("chat_met_min_messages", d.met_min_messages);
            set("chat_waited_ms", d.waited_ms);${transcript}${stageData}
            set("chat_end_ts", Date.now());
            qEngine.showNextButton();${stageEnded}
        } else if (d.type === "chat_continue") {
            qEngine.clickNextButton();
        }
    });
});
`;
}

function outputFields(config) {
  return [
    ...OUTPUT_FIELDS,
    ...(config.embed.send_transcript_to_parent ? [['chat_transcript', 'the full chat, as JSON']] : []),
    ...reportedStages(config).flatMap(stageFields),
  ];
}

// Setup for a study whose chat hands over to Qualtrics between stages: one chat block per part.
function stagesNote(config) {
  const segs = segments(config);
  if (segs.length === 1) return '';
  const later = segs.slice(1).map((m, i) => {
    const ids = [...new Set(Object.values(m).filter(Boolean))];
    return `- Chat block ${i + 2}: the same HTML, with \`${questionFile(i + 1)}\` as its JavaScript (starts stage ${ids.map((x) => `\`${x}\``).join(' or ')}).`;
  });
  return `
**4. One chat block per stage.** Your chat has stages that hand over to Qualtrics (\`then: qualtrics\`).
Add one chat block for each part, with your own questions in blocks between them:
- Chat block 1: the question above (\`chat-question.js\`).
${later.join('\n')}

When a stage ends, the survey moves on by itself. The next chat question reunites the same partners; whoever
returns first waits up to the \`rejoin_timeout\` for the other. If the chat already ended, later chat questions skip themselves.
`;
}

function checklist(config, url) {
  const { condition_param: condParam, fields } = config.participant;
  const conds = Object.keys(config.conditions);
  const rows = [];
  let n = 0;
  for (const [f, def] of Object.entries(fields)) {
    const hint = def.type === 'list' ? ` One text value, items separated by "${def.sep}".`
      : def.values ? ` Must be one of: ${def.values.join(', ')}.` : '';
    rows.push(`| ${++n} | \`${f}\` | Your earlier question, as piped text (e.g. the question's "Selected Choices"), or a survey-link URL parameter.${hint} |`);
  }
  const vars = Object.entries(promptVars(config));
  for (const [v, { pipe }] of vars) {
    if (pipe === piped(v)) rows.push(`| ${++n} | \`${v}\` | AI prompt variable. Set it from your earlier question, as piped text (see "AI prompt variables" below). |`);
  }
  rows.push(`| ${++n} | \`${condParam}\` | The Randomizer (step 2). |`);
  for (const [f, what] of outputFields(config)) rows.push(`| ${++n} | \`${f}\` | Leave empty; the chat fills it: ${what}. |`);

  return `# Qualtrics setup for study "${config.study.id}"

Generated by \`npm run qualtrics\` for ${url}. Nothing here needs editing.
The chat accepts embedding only from ${config.embed.allowed_origins.join(', ')} (\`embed.allowed_origins\`).

## Fastest: import the template

1. In Qualtrics: **Create a new project > Survey > Import a QSF file**, and choose \`syncchat_template.qsf\`.
2. Add your own questions before the chat block, and set each matching field from them
   (Survey Flow > the first Embedded Data element). To test without questions, add them to
   the survey link instead, e.g. \`?${Object.keys(fields).map((f) => `${f}=...`).join('&') || 'x=...'}\`.
3. Preview in two browsers at once. Each preview gets its own ResponseID, so they can match.

## Or add the chat to an existing survey

**1. Embedded data.** In Survey Flow, add one Embedded Data element at the very top with these fields, in this order:

| # | Field | Where its value comes from |
|---|---|---|
${rows.join('\n')}

**2. Randomizer.** Below it, add a Randomizer, "Randomly present 1 of the following elements",
check "Evenly present elements", with one Embedded Data element per condition:
${conds.map((c) => `\`${condParam} = ${c}\``).join(', ')}.

**3. Chat question.** In the block where the chat happens, add a Text/Graphic question on its own page.
- Question text, HTML View: paste \`chat-question.html\`.
- Question JavaScript: paste \`chat-question.js\`.
${stagesNote(config)}
Use \`chat_outcome\` in Display or Branch Logic, e.g. to route \`nomatch\` participants elsewhere.
${aiNote(config)}`;
}

// How the AI prompt variables get their values, for the checklist.
function aiNote(config) {
  const vars = Object.entries(promptVars(config));
  if (!Object.values(config.conditions).some((c) => c.ai)) return '';
  const lines = vars.map(([v, { pipe, max }]) => (pipe === piped(v)
    ? `- \`${v}\`: from the embedded data field \`${v}\` (up to ${max} characters).`
    : `- \`${v}\`: from \`${pipe}\` (up to ${max} characters).`));
  return `
## AI partner

The server calls the model with the key in the environment variable named by \`ai.api_key_env\`
(set it on your server, e.g. Render > Environment). The key is never in the survey or the chat URL.
\`chat_partner_id\` is \`ai\` when the participant chatted with the AI${config.on_timeout === 'bot' ? ' (including the fallback after match_timeout)' : ''}.
Branch on \`chat_outcome\` = \`ai_error\` or \`ai_budget_exhausted\` like \`nomatch\`.
${vars.length ? `
### AI prompt variables

The chat question sends these to the server, which fills them into the AI's prompt:
${lines.join('\n')}

\`chat-question.html\` holds one hidden element per variable with its Qualtrics piped text, and the
JavaScript reads it from there, so answers with quotes or line breaks are safe. To use an earlier question:
1. Put the question on an **earlier page** than the chat (piped text only sees answers from earlier pages).
2. Either pipe it directly: set the variable in your study.yaml to the question's piped text, e.g.
   \`vars: {${vars[0][0]}: "\${q://QID5/ChoiceTextEntryValue}"}\` (Qualtrics: question > Piped Text > the question),
   then re-run \`npm run qualtrics\` (QID5 is an example: copy your question's piped text from Qualtrics);
   or keep \`vars: [${vars[0][0]}]\` and, in Survey Flow, add an Embedded Data element **after** that question's block that sets
   \`${vars[0][0]}\` to the question's piped text. Embedded data from a panel or the survey link works the same way.
3. Preview with an answer that includes quotes and a line break, then check \`prompt_vars\` in the server's \`arrivals\` export and
   \`ai.system_prompt\` in \`matches\` (the full prompt the model got).

If a variable the prompt uses arrives empty, the chat ${Object.values(config.conditions).some((c) => c.ai && c.ai.missing_vars === 'error') ? 'does not start (\`chat_outcome\` = \`error\`); set \`ai.missing_vars: empty\` to fill in a blank instead' : 'fills in a blank'}.
` : ''}`;
}

// ---- .qsf template ----

const BETWEEN = 'The first part of the chat is over. Put your between-stage questions in this block; the next block reunites you with the same partner.';

function edField(field, value) {
  const base = { Description: field, Field: field, VariableType: 'String', DataVisibility: [], AnalyzeText: false };
  return value === undefined ? { ...base, Type: 'Recipient' } : { ...base, Type: 'Custom', Value: value };
}

function question(qid, tag, text, js) {
  return {
    QuestionText: text,
    DefaultChoices: false,
    DataExportTag: tag,
    QuestionID: qid,
    QuestionType: 'DB',
    Selector: 'TB',
    DataVisibility: { Private: false, Hidden: false },
    Configuration: { QuestionDescriptionOption: 'UseText' },
    QuestionDescription: tag,
    ChoiceOrder: [],
    Validation: { Settings: { Type: 'None' } },
    GradingData: [],
    Language: [],
    NextChoiceId: 4,
    NextAnswerId: 1,
    ...(js ? { QuestionJS: js } : {}),
  };
}

// A minimal importable survey: embedded data, an even randomizer over the conditions, the chat
// block (one per stage that follows a `then: qualtrics`, with a placeholder block between), and a block for post-chat questions. Shapes follow a survey exported from Qualtrics.
function qsfTemplate(config, url) {
  const surveyId = 'SV_SyncChatTemplat';
  const { condition_param: condParam, fields } = config.participant;
  const el = (Element, PrimaryAttribute, Payload, SecondaryAttribute = null, TertiaryAttribute = null) =>
    ({ SurveyID: surveyId, Element, PrimaryAttribute, SecondaryAttribute, TertiaryAttribute, Payload });
  const segs = segments(config);
  // Blocks: trash, then per chat question k a chat block (and before each later one, a block for
  // between-stage questions), then the block after the chat. Question ids follow the same order.
  const blocks = { 1: { Type: 'Trash', Description: 'Trash / Unused Questions', ID: 'BL_SyncChatTrash01', BlockElements: [] } };
  const questions = [];
  const addBlock = (id, description, tag, text, js) => {
    const qid = `QID${questions.length + 1}`;
    questions.push(el('SQ', qid, question(qid, tag, text, js), description));
    blocks[Object.keys(blocks).length + 1] = {
      Type: 'Standard', SubType: '', Description: description, ID: id, BlockElements: [{ Type: 'Question', QuestionID: qid }],
    };
    return id;
  };
  const order = [];
  segs.forEach((stageMap, k) => {
    if (k) order.push(addBlock(`BL_SyncChatMid${String(k).padStart(4, '0')}`, `Between stages ${k}`, `between_${k}`, BETWEEN));
    order.push(addBlock(k ? `BL_SyncChatChat${String(k + 1).padStart(3, '0')}` : 'BL_SyncChatChat001', k ? `Chat ${k + 1}` : 'Chat',
      k ? `chat_${k + 1}` : 'chat', questionHtml(config, k).trim(), questionJs(config, url, k, stageMap)));
  });
  const after = 'The chat is over. Your outcome was: ${e://Field/chat_outcome}. Put your post-chat questions in this block.';
  order.push(addBlock('BL_SyncChatAfter01', 'After the chat', 'after_chat', after));
  let flowId = 1;
  const fid = () => `FL_${++flowId}`;
  const flow = {
    Type: 'Root',
    FlowID: 'FL_1',
    Flow: [
      {
        Type: 'EmbeddedData',
        FlowID: fid(),
        EmbeddedData: [
          ...Object.keys(fields).map((f) => edField(f)),
          ...Object.entries(promptVars(config)).filter(([v, { pipe }]) => pipe === piped(v)).map(([v]) => edField(v)),
          edField(condParam),
          ...outputFields(config).map(([f]) => edField(f)),
        ],
      },
      {
        Type: 'BlockRandomizer',
        FlowID: fid(),
        SubSet: 1,
        EvenPresentation: true,
        Flow: Object.keys(config.conditions).map((c) => ({
          Type: 'EmbeddedData', FlowID: fid(), EmbeddedData: [edField(condParam, c)],
        })),
      },
      ...order.map((ID) => ({ Type: 'Standard', ID, FlowID: fid(), Autofill: [] })),
    ],
  };
  flow.Properties = { Count: flowId };
  const options = {
    BackButton: 'false', SaveAndContinue: 'true', SurveyProtection: 'PublicSurvey',
    BallotBoxStuffingPrevention: 'false', NoIndex: 'Yes', SecureResponseFiles: 'true',
    SurveyExpiration: 'None', SurveyTermination: 'DefaultMessage', Header: '', Footer: '',
    ProgressBarDisplay: 'None', PartialData: '+1 week', NextButton: '', PreviousButton: '',
    SurveyTitle: `syncchat: ${config.study.id}`, ShowExportTags: 'false', CollectGeoLocation: 'false',
    PasswordProtection: 'No', AnonymizeResponse: 'No', RefererCheck: 'No', ConfirmStart: false,
    AutoConfirmStart: false, RelevantID: 'false', ResponseSummary: 'No', EmailThankYou: 'false',
    AvailableLanguages: { EN: [] },
  };
  return {
    SurveyEntry: {
      SurveyID: surveyId,
      SurveyName: `syncchat: ${config.study.id}`,
      SurveyDescription: null,
      SurveyOwnerID: null,
      SurveyBrandID: null,
      DivisionID: null,
      SurveyLanguage: 'EN',
      SurveyActiveResponseSet: 'RS_SyncChatDefault',
      SurveyStatus: 'Inactive',
      SurveyStartDate: '0000-00-00 00:00:00',
      SurveyExpirationDate: '0000-00-00 00:00:00',
      SurveyCreationDate: null,
      CreatorID: null,
      LastModified: null,
      LastAccessed: '0000-00-00 00:00:00',
      LastActivated: '0000-00-00 00:00:00',
      Deleted: null,
    },
    SurveyElements: [
      el('BL', 'Survey Blocks', blocks),
      el('FL', 'Survey Flow', flow),
      el('PROJ', 'CORE', { ProjectCategory: 'CORE', SchemaVersion: '1.1.0' }, null, '1.1.0'),
      el('QC', 'Survey Question Count', null, String(questions.length)),
      el('RS', 'RS_SyncChatDefault', null, 'Default Response Set'),
      el('SO', 'Survey Options', options),
      ...questions,
    ],
  };
}

// Write the files to outDir (four, plus one chat question per later stage); returns their paths.
function generateQualtrics(config, { url, outDir }) {
  const appUrl = normalizeUrl(url);
  fs.mkdirSync(outDir, { recursive: true });
  const files = {
    ...Object.fromEntries(segments(config).map((stageMap, k) => [questionFile(k), questionJs(config, appUrl, k, stageMap)])),
    'chat-question.html': questionHtml(config),
    'CHECKLIST.md': checklist(config, appUrl),
    'syncchat_template.qsf': JSON.stringify(qsfTemplate(config, appUrl), null, 2) + '\n',
  };
  return Object.entries(files).map(([name, content]) => {
    const file = path.join(outDir, name);
    fs.writeFileSync(file, content);
    return file;
  });
}

module.exports = { generateQualtrics, normalizeUrl, chatParams };
