'use strict';

// GET / and /gallery in multi-study mode: one page with three client-side tabs (linkable as
// #examples, #configuration, #setup).
//   Examples       one card per study: description, the plain-English logic from `npm run explain`,
//                  the URL Qualtrics sends, the raw study.yaml, and a "Try it" link.
//   Configuration  how a study.yaml works: flow, annotated YAML, field types, rules, settings,
//                  custom rules, and the validate -> explain -> simulate workflow.
//   Setup          a step-by-step guide from accounts to data export.

const yaml = require('js-yaml');
const { explainConfig } = require('./explain');
const { validateConfig } = require('./config');
const { simulate, formatSimulation, parseCsv } = require('./simulate');
const { esc } = require('./demo');
const { chatParams } = require('./qualtrics');

// The annotated example on the Configuration tab. Each line is [yaml, callout number or 0]. Kept as
// data so the explain/simulate samples below are computed from it and test/gallery.test.js can validate it.
const ANATOMY = [
  ['study:', 0],
  ['  id: debate', 0],
  ['', 0],
  ['participant:', 0],
  ['  fields:', 1],
  ['    party: {type: category, values: [Democrat, Republican]}', 0],
  ['    top3:  {type: list, options: [coffee, hiking, jazz, travel], pick: 3}', 0],
  ['    age:   {type: number, min: 18, max: 99}', 0],
  ['', 0],
  ['conditions:', 2],
  ['  cross:', 0],
  ['    require:', 3],
  ['      - differ: party', 0],
  ['      - overlap: {field: top3, min: 1}', 0],
  ['    prefer:', 4],
  ['      - closest: age', 0],
  ['    relax_after: 30s', 5],
  ['    reveal: "Your partner is a {partner.party}. You both picked {shared.top3}."', 6],
  ['  same:', 0],
  ['    require:', 0],
  ['      - same: party', 0],
  ['    reveal: false', 0],
  ['', 0],
  ['timing:', 7],
  ['  match_timeout: 120s', 0],
  ['  chat_duration: 300s', 0],
  ['', 0],
  ['chat:', 8],
  ['  intro: "Topic: immigration. Share your view, then ask for theirs."', 0],
  ['', 0],
  ['embed:', 9],
  ['  allowed_origins: ["https://*.qualtrics.com"]', 0],
];
const ANATOMY_YAML = ANATOMY.map(([l]) => l).join('\n') + '\n';

// The annotated timing and stages example on the Configuration tab (validated when the page renders).
const STAGES_YAML = `conditions:
  short:
    timing: {chat_duration: 2m}        # this condition only: a 2-minute chat
  open:
    timing:
      chat_duration: none              # no clock: elapsed timer and a Done button
      end_when: both_done              # or either_done; timed chats default to timer
      min_messages: 3                  # Done stays locked until you have sent 3
      max_duration: 20m                # safety cap (default 60m)
  staged:
    stages:                            # same partner throughout
      - id: intro
        prompt: "Get to know each other."
        chat_duration: 3m
        then: qualtrics                # survey questions, then rejoin with stage=discuss
      - id: discuss
        prompt: "Discuss the topic."
        chat_duration: none
        min_messages: 2

timing:                                # global defaults
  match_timeout: 120s
  chat_duration: 5m
  rejoin_timeout: 3m                   # chats with stages: wait this long for a returning partner

study: {id: timing-demo}                # study, participant, and embed as in the example above
participant: {}
embed: {allowed_origins: ["https://*.qualtrics.com"]}
`;

// Fake arrivals for the simulate sample, as they would appear in people.csv.
const PEOPLE_CSV = `id,cond,party,top3,age,arrival_s
p1,cross,Democrat,"coffee,hiking,jazz",34,0
p2,cross,Republican,"jazz,travel,coffee",52,5
p3,cross,Democrat,"hiking,travel,coffee",41,10
p4,same,Republican,"jazz,hiking,travel",38,15
p5,cross,Democrat,"coffee,jazz,travel",29,20
p6,cross,Republican,"travel,hiking,jazz",45,25
p7,same,Republican,"coffee,jazz,hiking",61,40
`;

const NOTES = [
  '<b>participant.fields</b>: the answers you match on. Each one arrives as a URL parameter on the chat iframe. Collect them in your survey (or from a panel) and store them as embedded data; the generated Qualtrics snippet puts them in the URL. Three types: <code>category</code>, <code>list</code>, and <code>number</code> (table below).',
  '<b>conditions</b>: one block per experimental condition. The condition also arrives in the URL (<code>cond=cross</code>), set as embedded data by a Qualtrics randomizer. People only match others in the same condition.',
  '<b>require</b>: hard rules. All must hold for two people to match.',
  '<b>prefer</b>: among everyone who passes <code>require</code>, rank partners. The first rule decides, later ones break ties, then longest wait wins.',
  '<b>relax_after</b>: once someone has waited this long, rules marked <code>relaxable: true</code> are dropped for them, and preferences are ignored (they take the first valid partner).',
  '<b>reveal</b>: the "why you matched" banner both people see when the chat opens, filled in with placeholders (table below). <code>false</code> shows no banner.',
  '<b>timing</b>: how long to wait for a partner before a "no partner" screen, and how long the chat lasts. A condition can override any of it, and a chat can have no time limit or several stages (see <a href="#timing-and-stages">Timing and stages</a>).',
  '<b>chat.intro</b>: a line pinned at the top of the chat, usually the topic.',
  '<b>embed</b>: the sites allowed to show the chat in an iframe (your Qualtrics domain). Optional <code>redirect_url</code> is where Continue goes if the chat is opened outside Qualtrics.',
];

const FIELD_TYPES = [
  ['category', 'one value', '<code>party=Democrat</code>',
    '<code>values: [Democrat, Republican]</code> (optional): any other value is rejected and the participant sees an error'],
  ['list', 'several items in one parameter', '<code>top3=jazz,hiking,coffee</code>',
    '<code>sep</code> (default <code>","</code>); <code>options</code> and <code>pick: N</code> set the chips on the <code>/demo</code> form'],
  ['number', 'a number; anything else counts as missing', '<code>age=34</code>',
    '<code>min</code> and <code>max</code> set the range on the <code>/demo</code> form'],
];

const RULES = [
  ['same', 'both have the same value', '- same: party'],
  ['differ', 'both have a value, and the values differ', '- differ: party'],
  ['equals', 'both have exactly this value', '- equals: {field: gender, value: Woman}'],
  ['overlap', 'lists share at least <code>min</code> items (default 1); under <code>prefer</code>, more shared ranks higher', '- overlap: {field: top3, min: 2}'],
  ['within', 'numbers differ by at most <code>max</code>', '- within: {field: age, max: 10}'],
  ['closest', '<code>prefer</code> only: a smaller gap ranks higher', '- closest: age'],
  ['any_of', 'at least one of the listed rules holds (OR)', '- any_of: [{same: party}, {overlap: top3}]'],
  ['not', 'the rule does not hold', '- not: {equals: {field: gender, value: Man}}'],
  ['custom', 'your own rule in a JavaScript file', '- custom: {file: ./rules/same_decade.js, field: age}'],
];

const PLACEHOLDERS = [
  ['{shared.top3}', 'items both people listed', '"jazz and hiking"'],
  ['{me.age}', 'the viewer\'s own value', '"34"'],
  ['{partner.party}', 'the partner\'s value', '"Republican"'],
];

// [setting, default, meaning]. Defaults match validateConfig in src/config.js.
const SETTINGS = [
  ['title, description', 'none', 'shown on the example card and the <code>/demo</code> form'],
  ['study.id', 'required', 'letters, numbers, <code>-</code> or <code>_</code>; stored on every record and sent as <code>study=</code>'],
  ['study.group_size', '2', 'only pairs are supported'],
  ['participant.id_param', 'id', 'URL parameter with the participant ID (the Qualtrics ResponseID)'],
  ['participant.condition_param', 'cond', 'URL parameter with the condition'],
  ['conditions.&lt;name&gt;.label', 'the name', 'text in the <code>/demo</code> condition dropdown'],
  ['conditions.&lt;name&gt;.relax_after', 'none', 'must be shorter than <code>timing.match_timeout</code>'],
  ['conditions.&lt;name&gt;.reveal', 'false', 'banner text with placeholders, or <code>false</code>'],
  ['conditions.&lt;name&gt;.timing', 'none', 'any <code>timing</code> key, for this condition only; it overrides the global value'],
  ['conditions.&lt;name&gt;.stages', 'stages', 'this condition\'s own stages; otherwise it uses the top-level <code>stages</code>, if any'],
  ['timing.match_timeout', 'required', 'how long to wait for a partner (<code>60s</code>, <code>2m</code>, <code>500ms</code>, or a number of seconds)'],
  ['timing.chat_duration', 'required', 'length of the chat, or <code>none</code> for no time limit: an elapsed timer and a Done button replace the countdown'],
  ['timing.end_when', 'timer', '<code>timer</code> (time runs out), <code>both_done</code> (both click Done; the first sees "Waiting for your partner to finish"), or <code>either_done</code>. Default <code>both_done</code> when <code>chat_duration</code> is <code>none</code>'],
  ['timing.min_messages', '0', 'messages each person must send. With Done, the server rejects Done until then and the button shows "2 of 3 messages sent"; with <code>timer</code>, it is recorded as <code>met_min_messages</code>'],
  ['timing.max_duration', '60m', 'safety cap on a chat with <code>chat_duration: none</code>'],
  ['timing.extend_until_min', '0', 'timed chats: if someone has sent fewer than <code>min_messages</code> when time runs out, keep going up to this long until both have'],
  ['timing.rejoin_timeout', '3m', 'chats with stages: how long a returning or reconnecting partner is waited for before the chat ends (<code>partner_left</code>)'],
  ['stages', 'none', 'a list of stages run in order with the same partner; each may set <code>chat_duration</code>, <code>min_messages</code>, <code>end_when</code>, <code>max_duration</code>, <code>extend_until_min</code>'],
  ['stages[].id', 'required', 'letters, numbers, or <code>_</code>; stored on messages and stage records, and sent as <code>stage=</code> by later chat questions'],
  ['stages[].prompt', 'none', 'banner for this stage; placeholders allowed'],
  ['stages[].reveal', 'stage 1 only', 'the condition\'s <code>reveal</code> shows in stage 1; a stage may set its own'],
  ['stages[].then', 'continue', '<code>continue</code>: next stage in the same window, after a divider; <code>qualtrics</code>: the survey moves on and a later chat question rejoins the same partner. The last stage has no <code>then</code>'],
  ['chat.intro', 'none', 'a line at the top of every chat; placeholders allowed'],
  ['on_timeout', 'nomatch', 'what happens after <code>match_timeout</code>: the "no partner" screen (the only option today)'],
  ['embed.allowed_origins', 'required', 'sites allowed to embed the chat and receive its messages, e.g. <code>https://*.qualtrics.com</code>'],
  ['embed.redirect_url', 'null', 'where Continue goes if the chat is opened outside an iframe; <code>{id}</code> and <code>{outcome}</code> are filled in'],
  ['embed.send_transcript_to_parent', 'false', 'also save the transcript in Qualtrics as <code>chat_transcript</code>'],
  ['limits.max_message_length', '500', 'characters per message'],
  ['limits.messages_per_10s', '10', 'per participant'],
  ['limits.joins_per_ip_per_minute', '60', 'raise it for labs where participants share one network'],
];

const CUSTOM_RULE = `// rules/same_decade.js
module.exports = {
  args: { field: { field: ['number'] } },
  describe: ({ field }) => \`be in the same \${field} decade (e.g. both in their 30s)\`,
  test: (a, b, { field }) => ({
    pass: a[field] != null && b[field] != null && Math.floor(a[field] / 10) === Math.floor(b[field] / 10),
  }),
};`;

const FLOW = ['Qualtrics survey<small>answers and randomizer saved as embedded data</small>',
  'Chat iframe URL<small><code>?study=…&amp;id=…&amp;cond=…&amp;party=…</code></small>',
  'syncchat matches<small>by your <code>require</code> / <code>prefer</code> rules</small>',
  'Live chat<small>with the reveal banner and intro</small>',
  'Back to Qualtrics<small><code>chat_outcome</code>, <code>chat_match_reason</code>, <code>chat_partner_id</code> as embedded data</small>'];

// [name, what it is, where to get it, required?]. test/gallery.test.js checks this covers every
// process.env variable read in src/.
const ENV_VARS = [
  ['MONGO_URI', 'Connection string for your MongoDB database, ending in the database name, e.g. <code>mongodb+srv://syncchat:PASSWORD@cluster0.abcde.mongodb.net/syncchat?retryWrites=true&amp;w=majority</code>',
    'Atlas &rarr; your cluster &rarr; <b>Connect</b> &rarr; <b>Drivers</b> (step 2)',
    '<b>Required on Render.</b> Without it records go to files on the server disk, which Render wipes on every deploy and restart. Optional on your computer.'],
  ['ADMIN_TOKEN', 'Password for downloading data at <code>/export</code>',
    'Any long random string, e.g. the output of <code>openssl rand -hex 24</code>. The Render Blueprint generates one for you (see the service\'s <b>Environment</b> page).',
    '<b>Required</b> to download data; without it <code>/export</code> is disabled.'],
  ['STUDY_CONFIG', 'Path to your study file, or to a folder of study files (one server, several studies)',
    'A path inside your repository, e.g. <code>studies/pilot.yaml</code>', 'Optional. Default: <code>study.yaml</code> in the repository root.'],
  ['STUDY_DIR', 'A folder of study files; the same as pointing <code>STUDY_CONFIG</code> at a folder', 'A path inside your repository', 'Optional'],
  ['DATA_DIR', 'Where record files go when <code>MONGO_URI</code> is empty', 'A folder on your computer', 'Optional. Default: <code>data/</code>. Local testing only.'],
  ['PORT', 'The port the server listens on', 'Render sets it for you', 'Optional. Default: 3000. Do not set it on Render.'],
  ['NODE_VERSION', 'The Node.js version Render installs (read by Render, not by syncchat)', '<code>render.yaml</code> sets it to 22',
    'Set it to 22 only if you create the Render service by hand.'],
];

const row = (cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
const table = (head, rows) => `<div class="scroll"><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>
${rows.map(row).join('\n')}
</tbody></table></div>`;

function configurationTab() {
  const code = ANATOMY.map(([line, n]) => highlightYaml(line) + (n ? ` <span class="n">${n}</span>` : '')).join('\n');
  const config = validateConfig(yaml.load(ANATOMY_YAML));
  const explained = explainConfig(config);
  const simulated = formatSimulation(simulate(config, parseCsv(PEOPLE_CSV)));
  return `<section id="configuration" class="tab">
  <div class="panel">
    <h2>How a study.yaml works</h2>
    <ol class="flow">${FLOW.map((f) => `<li>${f}</li>`).join('')}</ol>
    <p>Everything about matching lives in one YAML file. Here is a complete one, numbered by block:</p>
    <pre class="anatomy"><code>${code}</code></pre>
    <ol class="notes">${NOTES.map((n) => `<li>${n}</li>`).join('')}</ol>
  </div>

  <div class="panel">
    <h2>Field types</h2>
    <p>Every field arrives as one URL parameter with the same name. Any field may also give a <code>label:</code>, the question text on the <code>/demo</code> form.</p>
    ${table(['Type', 'Holds', 'In the URL', 'Options'], FIELD_TYPES.map(([t, h, u, o]) => [`<code>${t}</code>`, h, u, o]))}
    <p>A missing value fails every rule that uses that field. The <code>/demo</code>-only options do not restrict matching.</p>
  </div>

  <div class="panel">
    <h2>Rules</h2>
    <p>Write a rule as <code>- rule: field</code>, or <code>- rule: {field: ..., other settings}</code>. Any rule can go under <code>require</code> (filter) or <code>prefer</code> (rank). Mark a <code>require</code> rule <code>relaxable: true</code> to drop it after <code>relax_after</code>.</p>
    ${table(['Rule', 'Meaning', 'Example'], RULES.map(([r, m, e]) => [`<code>${r}</code>`, m, `<code>${esc(e)}</code>`]))}
    <h3>Reveal placeholders</h3>
    ${table(['Placeholder', 'Becomes', 'Example'], PLACEHOLDERS.map(([p, m, e]) => [`<code>${esc(p)}</code>`, m, e]))}
  </div>

  <div class="panel">
    <h2>All settings and defaults</h2>
    ${table(['Setting', 'Default', 'Meaning'], SETTINGS.map(([s, d, m]) => [`<code>${s}</code>`, d === 'required' ? '<b>required</b>' : `<code>${d}</code>`, m]))}
    <p>The validator rejects unknown keys, unknown fields, wrong field types, and bad durations, and lists every problem at once.</p>
  </div>

  <div class="panel" id="timing-and-stages">
    <h2>Timing and stages</h2>
    <p>Global <code>timing</code> applies to every condition; a condition's <code>timing</code> overrides it, and a stage overrides both. A chat without a clock ends when partners click Done, and <code>stages</code> run several rounds with the same partner:</p>
    <pre><code>${highlightYaml(STAGES_YAML)}</code></pre>
    <p><code>npm run explain</code> reads it back as:</p>
    <pre class="out"><code>${esc(explainConfig(validateConfig(yaml.load(STAGES_YAML))).split('\n').slice(3).join('\n').trim())}</code></pre>
    <p>With <code>then: qualtrics</code>, your survey needs one chat block per stage (<code>npm run qualtrics</code> writes a chat question for each; see <a href="#setup">Setup</a>, step 6). Whoever reaches the next chat question first waits for the partner, up to <code>rejoin_timeout</code>. A reload or dropped connection mid-stage reconnects to the same chat with its transcript. Outside Qualtrics (the <b>Try it</b> page), a <code>qualtrics</code> stage shows "In your study, your Qualtrics survey would show here" and a button to continue with the same partner.</p>
  </div>

  <div class="panel">
    <h2>Adding your own rule</h2>
    <p>Put a rule in a JavaScript file next to your study.yaml and point to it with <code>custom</code>. The file exports a plain-English <code>describe</code> (it completes "partners must ...") and a <code>test</code> that checks one pair and returns <code>{pass}</code>:</p>
    <pre><code>${esc(CUSTOM_RULE)}</code></pre>
    <pre><code>${highlightYaml('require:\n  - custom: {file: ./rules/same_decade.js, field: age}')}</code></pre>
    <p>The path is relative to the study file. <code>npm run validate</code> loads the file, checks its arguments, and calls <code>test</code> once with every field missing, so a rule that would crash on missing data fails before launch instead of mid-study.</p>
  </div>

  <div class="panel">
    <h2>Check your logic before launch</h2>
    <ol class="steps compact">
      <li><b><code>npm run validate</code></b> checks the file and lists every problem. Repeat until it prints <code>OK</code>.</li>
      <li><b><code>npm run explain</code></b> reads your rules back in plain English. If a sentence is not what you meant, fix the YAML. For the example above:
        <pre class="out"><code>${esc(explained)}</code></pre></li>
      <li><b><code>npm run simulate study.yaml people.csv</code></b> replays fake arrivals (one row per person, with an <code>arrival_s</code> column) through the same matcher the server uses, in simulated time. With this file:
        <pre class="out"><code>${esc(PEOPLE_CSV.trim())}</code></pre>
        it prints:
        <pre class="out"><code>${esc(simulated)}</code></pre>
        A low match rate means your rules are too strict for your sample: loosen a rule, mark it <code>relaxable</code>, or lengthen <code>match_timeout</code>.</li>
    </ol>
  </div>
</section>`;
}

function setupTab() {
  const step = (title, body) => `<li><h3>${title}</h3>${body}</li>`;
  return `<section id="setup" class="tab">
  <div class="panel">
    <h2>What you need</h2>
    ${table(['Account', 'Cost', 'What it is for'], [
      ['<b>GitHub</b>', 'free', 'Holds your copy of the code. Render deploys from it.'],
      ['<b>Render</b>', 'free to try; about $7/month (Starter plan) while collecting data. Check <a href="https://render.com/pricing">render.com/pricing</a>.',
        'Runs the chat server. Free instances sleep after about 15 minutes without visitors, take up to a minute to wake, and restart now and then; a restart ends every live chat. <code>render.yaml</code> already asks for Starter.'],
      ['<b>MongoDB Atlas</b>', 'free tier', 'Stores every arrival, match, message, and outcome. Render\'s own disk is wiped on every deploy and restart.'],
      ['<b>Qualtrics</b>', 'your institution\'s license', 'Hosts the survey. You need to import a <code>.qsf</code> file or add JavaScript to a question; some institutional accounts need an administrator to enable JavaScript.'],
      ['<b>Node.js 20.12 or newer</b>', 'free', 'On your own computer, to check your study.yaml and generate the Qualtrics files (<a href="https://nodejs.org">nodejs.org</a>). Nothing runs on your computer during the study.'],
    ])}
    <p class="callout">No AI or LLM API keys are needed. Participants chat with each other, and syncchat calls no outside services.</p>
  </div>

  <div class="panel">
    <h2>Keys and settings</h2>
    <p>These are the only environment variables syncchat reads. On Render, set them on the service's <b>Environment</b> page; on your computer, copy <code>.env.example</code> to <code>.env</code>.</p>
    ${table(['Variable', 'What it is', 'Where to get it', 'Required?'], ENV_VARS.map(([n, w, g, r]) => [`<code>${n}</code>`, w, g, r]))}
  </div>

  <div class="panel">
    <h2>Step by step</h2>
    <ol class="steps">
      ${step('Get the code', `<p>Make your own copy of the <a href="https://github.com/lirabenjamin/syncchat">syncchat repository</a> on GitHub: fork it, or download the ZIP and push it to a new repository. Then, on your computer:</p>
        <pre><code>git clone https://github.com/YOUR-NAME/syncchat.git
cd syncchat
npm install</code></pre>`)}
      ${step('Set up MongoDB Atlas', `<ol class="sub">
        <li>Sign up at <a href="https://www.mongodb.com/atlas">mongodb.com/atlas</a> and create a free cluster.</li>
        <li><b>Database Access</b>: add a database user with a password (role: read and write to any database). Avoid <code>@</code>, <code>:</code> and <code>/</code> in the password, or URL-encode them.</li>
        <li><b>Network Access</b>: add the address <code>0.0.0.0/0</code> (allow from anywhere). Render's outgoing addresses can change, so a narrower list can block your server; the database user's password still protects the data.</li>
        <li><b>Connect &rarr; Drivers</b>: copy the connection string, put your password in place of <code>&lt;db_password&gt;</code>, and add a database name such as <code>/syncchat</code> just before the <code>?</code>. That whole string is your <code>MONGO_URI</code>.</li>
        </ol>`)}
      ${step('Write your study.yaml and check it', `<p>Start from the example closest to your design (open its <b>study.yaml</b> on the <a href="#examples">Examples</a> tab) and save it as <code>study.yaml</code> in the repository root. Put your Qualtrics domain in <code>embed.allowed_origins</code>. Then run:</p>
        <pre><code>npm run validate    # until it prints OK
npm run explain     # read the rules back in plain English
npm run simulate study.yaml examples/people.csv   # edit or replace the CSV to match your study</code></pre>
        <p>Optional: <code>npm start</code>, then open <code>http://localhost:3000/demo</code> in two tabs to chat with yourself. See <a href="#configuration">Configuration</a> for every option. Commit and push when it looks right.</p>`)}
      ${step('Deploy to Render', `<p>In Render, choose <b>New &rarr; Blueprint</b> and pick your repository. Render reads <code>render.yaml</code>: Starter plan, build command <code>npm install --omit=dev</code>, start command <code>npm start</code>, health check <code>/healthz</code>, and a generated <code>ADMIN_TOKEN</code>. Paste your <code>MONGO_URI</code> when asked.</p>
        <p>Or choose <b>New &rarr; Web Service</b>, pick the repository, set runtime Node with those two commands, and add <code>MONGO_URI</code>, <code>ADMIN_TOKEN</code>, and <code>NODE_VERSION</code> = 22 by hand.</p>
        <p>When the deploy says <b>Live</b>, open <code>https://YOUR-APP.onrender.com/healthz</code>. It should show <code>"ok":true</code> and <code>"storage":"mongo"</code>. If it says <code>"jsonl"</code>, <code>MONGO_URI</code> is missing.</p>`)}
      ${step('Test the live app', `<p>Open <code>https://YOUR-APP.onrender.com/demo</code> in two browser tabs or on two phones, give compatible answers, and check that you get matched, see the reveal banner, and can chat.</p>`)}
      ${step('Add the chat to Qualtrics', `<p>Generate the Qualtrics files with your app's address:</p>
        <pre><code>npm run qualtrics -- --url https://YOUR-APP.onrender.com</code></pre>
        <p>This writes four files to <code>qualtrics/generated/</code>: <code>syncchat_template.qsf</code>, <code>chat-question.html</code>, <code>chat-question.js</code>, and <code>CHECKLIST.md</code> (plus one chat question per later stage, for chats with stages). Nothing in them needs editing. Then either:</p>
        <ul>
          <li><b>Import the template</b> (new survey): <b>Create a new project &rarr; Survey &rarr; Import a QSF file</b>. It already has the embedded data fields, a randomizer that sets <code>cond</code> evenly across your conditions, the chat question, and a block for post-chat questions. Add your own questions before the chat block and, in Survey Flow, set each matching field (e.g. <code>party</code>) from the matching answer with piped text.</li>
          <li><b>Add it to an existing survey</b>: at the top of Survey Flow add the embedded data fields listed in <code>CHECKLIST.md</code>; below them a Randomizer ("Randomly present 1", "Evenly present elements") with one Embedded Data element per condition (<code>cond = cross</code>, <code>cond = same</code>, ...); then a Text/Graphic question on its own page whose HTML is <code>chat-question.html</code> and whose JavaScript is <code>chat-question.js</code>.</li>
        </ul>
        <p>The chat iframe sends <code>study</code>, the ResponseID as <code>id</code>, <code>cond</code>, and your fields (see "What Qualtrics sends" on each example). Re-run the command whenever you change fields or conditions.</p>
        <p><b>Chats with stages:</b> if a stage has <code>then: qualtrics</code>, add <b>one chat block per stage</b>, with your between-stage questions in blocks between them. The command writes <code>chat-question-2.js</code> (and so on) for the later chat blocks, which send <code>stage=&lt;id&gt;</code> and reunite the same partners; the template already has these blocks. Each stage's result is saved as <code>chat_&lt;stage&gt;_end_reason</code>, <code>chat_&lt;stage&gt;_message_count</code>, and <code>chat_&lt;stage&gt;_met_min_messages</code>.</p>`)}
      ${step('Pilot', `<p>Preview the survey in two browser windows at the same time (for example one normal and one private window). Each preview gets its own ResponseID, so the two can match. Check that the chat appears, that you match, and that <code>chat_outcome</code> and <code>chat_match_id</code> show up in the Qualtrics data and in the export (step 9).</p>`)}
      ${step('Recruit', `<ul>
        <li><b>Launch in bursts</b> so people arrive together: open a batch of slots at a set time (or schedule sessions) rather than trickling participants in over a day.</li>
        <li><b>Set <code>timing.match_timeout</code></b> to the longest wait you will accept (often 2 to 5 minutes) and pay for waiting time, including for people who end up with no partner.</li>
        <li><b>Tell participants upfront</b> that the study involves a live chat with another participant and may include a short wait.</li>
        <li><b>Plan the no-match path</b>: branch on <code>chat_outcome = nomatch</code> in Survey Flow (or Display Logic) to send those participants to an alternate block or the end, with their completion code.</li>
        <li><b>Expect drop-outs</b>: some partners leave mid-chat (<code>partner_left</code>). Decide your exclusion rules before launch.</li>
        <li><b>Do not redeploy during a session</b>: a restart ends every live chat.</li>
        </ul>`)}
      ${step('Download the data', `<p>Open <code>https://YOUR-APP.onrender.com/export?token=YOUR_ADMIN_TOKEN</code> for all five tables as JSON: <code>arrivals</code>, <code>matches</code>, <code>messages</code>, <code>outcomes</code>, and <code>stages</code> (one record per chat stage, for studies with stages; messages and outcomes then carry a <code>stage</code> too). For one table as CSV, add <code>&amp;format=csv&amp;table=messages</code> (or any of the five). On a server hosting several studies, add <code>&amp;study=STUDY_ID</code>. Merge with Qualtrics on the participant ID (the ResponseID) or <code>chat_match_id</code>. The same records are in your Atlas database.</p>`)}
      ${step('IRB and privacy', `<ul>
        <li>Chat transcripts are stored in your own MongoDB database and pass through your own Render server. No data goes to the syncchat authors.</li>
        <li>Chat text is free text and can contain identifying information. Treat transcripts as identifiable until reviewed.</li>
        <li>Anything you show with <code>{partner.x}</code> in <code>reveal</code> or <code>chat.intro</code> discloses that answer to the partner. Say so in your consent form.</li>
        <li>Participants see no IDs, and the server never writes transcripts or participant IDs to its logs.</li>
        <li>Keep <code>ADMIN_TOKEN</code> and <code>MONGO_URI</code> private; <code>.env</code> is already in <code>.gitignore</code>.</li>
        </ul>`)}
    </ol>
  </div>

  <div class="panel trouble">
    <h2>Troubleshooting</h2>
    <dl>
      <dt>Nobody gets matched</dt>
      <dd>Check the iframe URL (Qualtrics preview &rarr; inspect the chat frame, or <code>chat-question.js</code>): <code>cond</code> must be one of your condition names, and every field must have a value spelled exactly as in <code>values</code>. Both people must be in the same condition and study, online at the same time, and pass every <code>require</code> rule; run <code>npm run explain</code> to see what that means.</dd>
      <dt>The chat box in Qualtrics is blank</dt>
      <dd>Your survey's domain is not in <code>embed.allowed_origins</code>. <code>https://*.qualtrics.com</code> covers addresses like <code>upenn.qualtrics.com</code>; add a custom survey domain if your institution uses one, then redeploy. Also check that <code>--url</code> was your Render address.</dd>
      <dt>Chats end suddenly</dt>
      <dd>The server restarted: a free Render instance slept or recycled, or a deploy ran. Use a paid plan during data collection and do not deploy while a session is live.</dd>
      <dt>"Too many attempts"</dt>
      <dd>Many participants share one network (a lab). Raise <code>limits.joins_per_ip_per_minute</code>.</dd>
    </dl>
  </div>
</section>`;
}

// A sample value for a field, shaped like what Qualtrics would pipe in.
function sampleValue(def) {
  if (def.type === 'number') {
    return def.min !== undefined && def.max !== undefined ? Math.round(def.min + (def.max - def.min) * 0.2) : 30;
  }
  if (def.type === 'list') return (def.options || ['a', 'b']).slice(0, def.pick || 2).join(def.sep);
  return (def.values || ['A'])[0];
}

// "What Qualtrics sends": the iframe URL for this study, in the parameter order of the generated snippet.
function exampleUrl(config) {
  const { id_param: idParam, condition_param: condParam, fields } = config.participant;
  const values = { study: config.study.id, [idParam]: 'R_abc123', [condParam]: Object.keys(config.conditions)[0] };
  for (const [f, def] of Object.entries(fields)) values[f] = sampleValue(def);
  const cls = (k) => (k === condParam ? 'cond' : Object.hasOwn(fields, k) ? 'f' : 'p');
  const url = '…/?' + chatParams(config).map(([k]) =>
    `<span class="${cls(k)}">${esc(k)}=${esc(encodeURIComponent(values[k]).replace(/%2C/g, ','))}</span>`).join('&amp;');
  const names = Object.keys(fields).map((f) => `<code>${esc(f)}</code>`);
  const fieldNote = names.length ? `${names.join(', ')} ${names.length > 1 ? 'come' : 'comes'} from embedded data (a survey answer or panel variable)` : '';
  const note = `<code>${esc(condParam)}</code> comes from your Qualtrics randomizer${fieldNote ? `; ${fieldNote}` : ''}. ` +
    `<code>${esc(idParam)}</code> is the Qualtrics ResponseID and <code>study</code> names this study.`;
  return `<div class="sends"><span class="label">What Qualtrics sends</span><code class="url">${url}</code><p>${note}</p></div>`;
}

// Light YAML highlighting on escaped text: comments, then keys.
function highlightYaml(source) {
  return source.replace(/\n$/, '').split('\n').map((line) => {
    let code = line;
    let comment = '';
    const m = line.match(/^(.*?)(^|\s+)(#.*)$/);
    if (m && !/["'][^"']*$/.test(m[1])) [code, comment] = [m[1] + m[2], m[3]]; // a # inside a quoted string is not a comment
    code = esc(code).replace(/^(\s*(?:-\s+)?)([A-Za-z_][\w-]*)(:)/, '$1<span class="k">$2</span>$3');
    return code + (comment ? `<span class="c">${esc(comment)}</span>` : '');
  }).join('\n');
}

function card({ config, source }) {
  const id = config.study.id;
  // Skip the first explain line ("Study x: groups of 2 ..."); the card title covers it.
  const logic = explainConfig(config).split('\n').slice(1).filter((l) => l.trim())
    .map((l) => `<p>${esc(l)}</p>`).join('');
  return `<article class="card" id="${esc(id)}">
  <h2>${esc(config.title || id)}</h2>
  ${config.description ? `<p class="desc">${esc(config.description)}</p>` : ''}
  <div class="logic">${logic}</div>
  ${exampleUrl(config)}
  <details><summary>study.yaml</summary><pre><code>${highlightYaml(source)}</code></pre></details>
  <a class="try" href="/demo?study=${encodeURIComponent(id)}">Try it</a>
</article>`;
}

// Show the tab named in the URL hash (or the tab containing the element it names, e.g. a card).
const TAB_SCRIPT = `(function () {
  var tabs = ['examples', 'configuration', 'setup'];
  function show() {
    var h = decodeURIComponent(location.hash.slice(1));
    var el = h && document.getElementById(h);
    var section = el && el.closest('.tab');
    var tab = section ? section.id : 'examples';
    document.querySelectorAll('.tab').forEach(function (s) { s.hidden = s.id !== tab; });
    document.querySelectorAll('.tabs a').forEach(function (a) {
      if (a.getAttribute('href') === '#' + tab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    if (el && tabs.indexOf(h) < 0) el.scrollIntoView(); else window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', show);
  show();
})();`;

function renderGallery(studies) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>syncchat: live chat pairing for Qualtrics studies</title>
<style>
  :root { --ink: #1f2328; --muted: #656d76; --line: #e4e7eb; --soft: #f5f6f8; --accent: #3b5bdb; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: var(--ink); background: var(--soft); }
  main { max-width: 860px; margin: 0 auto; padding: 0 20px 56px; }
  header { padding: 32px 0 0; }
  header h1 { font-size: 26px; margin: 0 0 6px; letter-spacing: -0.01em; }
  header p { margin: 0; color: var(--muted); }
  .tabs { position: sticky; top: 0; z-index: 1; display: flex; gap: 4px; margin: 20px -20px 0; padding: 10px 20px 0; background: var(--soft); border-bottom: 1px solid var(--line); overflow-x: auto; }
  .tabs a { padding: 8px 16px 10px; text-decoration: none; color: var(--muted); font-weight: 600; border-bottom: 3px solid transparent; white-space: nowrap; }
  .tabs a:hover { color: var(--ink); }
  .tabs a[aria-current="page"] { color: var(--accent); border-bottom-color: var(--accent); }
  .tab { padding-top: 22px; }
  .intro { margin: 0 0 18px; font-weight: 500; }
  .grid { display: grid; gap: 18px; }
  .card, .panel { background: #fff; border: 1px solid var(--line); border-radius: 14px; padding: 22px 22px 20px; }
  .panel { margin-bottom: 18px; }
  .card h2 { font-size: 19px; margin: 0 0 4px; }
  .panel h2 { font-size: 20px; margin: 0 0 10px; }
  .panel h3 { font-size: 16px; margin: 22px 0 6px; }
  .panel p, .panel li { font-size: 15px; }
  .panel p { margin: 10px 0; }
  .desc { margin: 0 0 14px; font-size: 16px; }
  .logic { font-size: 14px; color: var(--muted); border-left: 3px solid var(--line); padding-left: 12px; margin-bottom: 14px; }
  .logic p { margin: 0 0 6px; }
  details { margin-bottom: 16px; }
  summary { cursor: pointer; font-size: 14px; font-weight: 600; color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  pre { margin: 10px 0 0; padding: 14px 16px; background: #fbfbfc; border: 1px solid var(--line); border-radius: 10px; overflow-x: auto; font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; }
  pre.out { white-space: pre-wrap; word-break: break-word; color: #3d444d; }
  .k { color: #1c3faa; }
  .c { color: #8a929b; font-style: italic; }
  .try { display: inline-block; text-decoration: none; font-weight: 600; padding: 10px 22px; border-radius: 10px; background: var(--accent); color: #fff; }
  .try:hover { background: #2f4bc0; }
  a { color: var(--accent); }
  code { font: 0.9em ui-monospace, SFMono-Regular, Menlo, monospace; }
  .flow { list-style: none; padding: 0; margin: 16px 0; display: flex; flex-wrap: wrap; gap: 6px 22px; }
  .flow li { position: relative; flex: 1 1 100px; background: var(--soft); border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; font-size: 14px; font-weight: 600; }
  .flow li small { display: block; font-weight: 400; color: var(--muted); font-size: 12px; margin-top: 2px; word-break: break-word; }
  .flow li + li::before { content: "→"; position: absolute; left: -18px; top: 50%; transform: translateY(-50%); color: var(--accent); font-weight: 700; }
  .anatomy .n { display: inline-block; min-width: 18px; padding: 0 5px; border-radius: 9px; background: var(--accent); color: #fff; font: 600 11px/18px -apple-system, sans-serif; text-align: center; }
  .notes { padding-left: 0; list-style: none; counter-reset: note; display: grid; gap: 8px; font-size: 14px; }
  .notes li { counter-increment: note; position: relative; padding-left: 28px; font-size: 14px; }
  .notes li::before, .steps > li::before { content: counter(note); position: absolute; left: 0; top: 1px; min-width: 18px; height: 18px; border-radius: 9px; background: var(--accent); color: #fff; font: 600 11px/18px -apple-system, sans-serif; text-align: center; }
  .steps { padding-left: 0; list-style: none; counter-reset: note; margin: 0; }
  .steps > li { counter-increment: note; position: relative; padding: 0 0 18px 36px; }
  .steps > li::before { min-width: 24px; height: 24px; border-radius: 12px; font-size: 13px; line-height: 24px; top: 0; }
  .steps > li + li { border-top: 1px solid var(--line); padding-top: 16px; }
  .steps > li + li::before { top: 16px; }
  .steps h3 { margin: 0 0 4px; font-size: 17px; }
  .steps.compact > li { padding-bottom: 12px; }
  .steps ul, .steps .sub { padding-left: 20px; }
  .steps ul li, .steps .sub li { margin-bottom: 6px; }
  .callout { background: #eef2ff; border: 1px solid #d5ddfb; border-radius: 10px; padding: 10px 14px; font-weight: 500; }
  .trouble dt { font-weight: 600; margin-top: 12px; }
  .trouble dd { margin: 4px 0 0; font-size: 15px; color: #3d444d; }
  .scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { text-align: left; vertical-align: top; padding: 6px 10px 6px 0; border-bottom: 1px solid var(--line); }
  th { color: var(--muted); font-weight: 600; }
  td:first-child code { white-space: nowrap; }
  td code { word-break: break-word; }
  .sends { margin-bottom: 14px; font-size: 14px; }
  .sends .label { display: block; font-weight: 600; color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; margin-bottom: 4px; }
  .sends .url { display: block; padding: 8px 12px; background: #fbfbfc; border: 1px solid var(--line); border-radius: 8px; word-break: break-all; color: var(--muted); }
  .sends .cond { color: #a3460a; font-weight: 600; }
  .sends .f { color: #1c3faa; font-weight: 600; }
  .sends p { margin: 6px 0 0; color: var(--muted); }
  @media (max-width: 760px) { .flow { flex-direction: column; } .flow li + li::before { content: "↓"; left: 50%; top: -15px; transform: translateX(-50%); } .flow { gap: 18px; } }
  @media (max-width: 520px) { header { padding-top: 22px; } .card, .panel { padding: 18px 16px; } .try { display: block; text-align: center; } .tabs a { padding: 8px 10px 10px; } }
</style>
</head>
<body>
<main>
  <header>
    <h1>syncchat</h1>
    <p>Pairs participants in a Qualtrics study for a live one-on-one chat, using matching rules written in one short YAML file.</p>
  </header>
  <nav class="tabs" aria-label="Sections">
    <a href="#examples">Examples</a>
    <a href="#configuration">Configuration</a>
    <a href="#setup">Setup</a>
  </nav>
  <section id="examples" class="tab">
    <p class="intro">Open a card in two tabs or two phones and give compatible answers.</p>
    <div class="grid">
${studies.map(card).join('\n')}
    </div>
  </section>
  ${configurationTab()}
  ${setupTab()}
</main>
<script>
${TAB_SCRIPT}
</script>
</body>
</html>`;
}

module.exports = { renderGallery, ANATOMY_YAML, exampleUrl };
