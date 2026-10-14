'use strict';

// GET / and /gallery in multi-study mode: a "How a study.yaml works" primer, then one card per
// study with its description, the plain-English matching logic from `npm run explain`, an example
// of the URL Qualtrics sends, the raw study.yaml, and a "Try it" link.

const { explainConfig } = require('./explain');
const { esc } = require('./demo');
const { chatParams } = require('./qualtrics');

// The annotated example in the primer. Each line is [yaml, callout number or 0]. Kept as data
// so test/gallery.test.js can check that the YAML validates.
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

const NOTES = [
  '<b>participant.fields</b>: the answers you match on. Each one arrives as a URL parameter on the chat iframe. Collect them in your survey (or from a panel) and store them as embedded data; the generated Qualtrics snippet puts them in the URL. Three types: <code>category</code> (one value, optional <code>values</code> list), <code>list</code> (several items, <code>options</code> and <code>pick</code>), <code>number</code> (<code>min</code>/<code>max</code>).',
  '<b>conditions</b>: one block per experimental condition. The condition also arrives in the URL (<code>cond=cross</code>), set as embedded data by a Qualtrics randomizer. People only match others in the same condition.',
  '<b>require</b>: hard rules. All must hold for two people to match.',
  '<b>prefer</b>: among everyone who passes <code>require</code>, rank partners. The first rule decides, later ones break ties, then longest wait wins.',
  '<b>relax_after</b>: once someone has waited this long, rules marked <code>relaxable: true</code> are dropped for them, and preferences are ignored (they take the first valid partner).',
  '<b>reveal</b>: the "why you matched" banner both people see when the chat opens, filled in with placeholders (table below). <code>false</code> shows no banner.',
  '<b>timing</b>: how long to wait for a partner before a "no partner" screen, and how long the chat lasts.',
  '<b>chat.intro</b>: a line pinned at the top of the chat, usually the topic.',
  '<b>embed</b>: the sites allowed to show the chat in an iframe (your Qualtrics domain). Optional <code>redirect_url</code> is where Continue goes if the chat is opened outside Qualtrics.',
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

const FLOW = ['Qualtrics survey<small>answers and randomizer saved as embedded data</small>',
  'Chat iframe URL<small><code>?study=…&amp;id=…&amp;cond=…&amp;party=…</code></small>',
  'syncchat matches<small>by your <code>require</code> / <code>prefer</code> rules</small>',
  'Live chat<small>with the reveal banner and intro</small>',
  'Back to Qualtrics<small><code>chat_outcome</code>, <code>chat_match_reason</code>, <code>chat_partner_id</code> as embedded data</small>'];

function primer() {
  const code = ANATOMY.map(([line, n]) => highlightYaml(line) + (n ? ` <span class="n">${n}</span>` : '')).join('\n');
  const row = (cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
  return `<details class="primer" open>
    <summary>How a study.yaml works</summary>
    <ol class="flow">${FLOW.map((f) => `<li>${f}</li>`).join('')}</ol>
    <p>Everything about matching lives in one YAML file. Here is a complete one, numbered by block:</p>
    <pre class="anatomy"><code>${code}</code></pre>
    <ol class="notes">${NOTES.map((n) => `<li>${n}</li>`).join('')}</ol>
    <h3>Rules</h3>
    <p>Write a rule as <code>- rule: field</code>, or <code>- rule: {field: ..., other settings}</code>. Any rule can go under <code>require</code> (filter) or <code>prefer</code> (rank).</p>
    <div class="scroll"><table><thead><tr><th>Rule</th><th>Meaning</th><th>Example</th></tr></thead><tbody>
${RULES.map(([r, m, e]) => row([`<code>${r}</code>`, m, `<code>${esc(e)}</code>`])).join('\n')}
    </tbody></table></div>
    <h3>Reveal placeholders</h3>
    <div class="scroll"><table><thead><tr><th>Placeholder</th><th>Becomes</th><th>Example</th></tr></thead><tbody>
${PLACEHOLDERS.map(([p, m, e]) => row([`<code>${esc(p)}</code>`, m, e])).join('\n')}
    </tbody></table></div>
  </details>`;
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
  const values = { [idParam]: 'R_abc123', [condParam]: Object.keys(config.conditions)[0] };
  for (const [f, def] of Object.entries(fields)) values[f] = sampleValue(def);
  const parts = [['study', config.study.id, 'p'], ...chatParams(config).map(([k]) => [k, values[k],
    k === condParam ? 'cond' : k === idParam ? 'p' : 'f'])];
  const url = '…/?' + parts.map(([k, v, cls]) =>
    `<span class="${cls}">${esc(k)}=${esc(encodeURIComponent(v).replace(/%2C/g, ','))}</span>`).join('&amp;');
  const names = Object.keys(fields).map((f) => `<code>${esc(f)}</code>`);
  const fieldNote = names.length ? `${names.join(', ')} ${names.length > 1 ? 'come' : 'comes'} from embedded data (a survey answer or panel variable)` : '';
  const note = `<code>${esc(condParam)}</code> comes from your Qualtrics randomizer${fieldNote ? `; ${fieldNote}` : ''}. ` +
    `<code>${esc(idParam)}</code> is the Qualtrics ResponseID and <code>study</code> picks this example on the demo server.`;
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

function renderGallery(studies) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>syncchat examples</title>
<style>
  :root { --ink: #1f2328; --muted: #656d76; --line: #e4e7eb; --soft: #f5f6f8; --accent: #3b5bdb; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: var(--ink); background: var(--soft); }
  main { max-width: 820px; margin: 0 auto; padding: 36px 20px 56px; }
  header h1 { font-size: 26px; margin: 0 0 6px; letter-spacing: -0.01em; }
  header p { margin: 0 0 6px; color: var(--muted); }
  header .how { color: var(--ink); font-weight: 500; }
  .grid { display: grid; gap: 18px; margin-top: 28px; }
  .card { background: #fff; border: 1px solid var(--line); border-radius: 14px; padding: 22px 22px 20px; }
  .card h2 { font-size: 19px; margin: 0 0 4px; }
  .desc { margin: 0 0 14px; font-size: 16px; }
  .logic { font-size: 14px; color: var(--muted); border-left: 3px solid var(--line); padding-left: 12px; margin-bottom: 14px; }
  .logic p { margin: 0 0 6px; }
  details { margin-bottom: 16px; }
  summary { cursor: pointer; font-size: 14px; font-weight: 600; color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  pre { margin: 10px 0 0; padding: 14px 16px; background: #fbfbfc; border: 1px solid var(--line); border-radius: 10px; overflow-x: auto; font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .k { color: #1c3faa; }
  .c { color: #8a929b; font-style: italic; }
  .try { display: inline-block; text-decoration: none; font-weight: 600; padding: 10px 22px; border-radius: 10px; background: var(--accent); color: #fff; }
  .try:hover { background: #2f4bc0; }
  code { font: 0.9em ui-monospace, SFMono-Regular, Menlo, monospace; }
  .primer { background: #fff; border: 1px solid var(--line); border-radius: 14px; padding: 18px 22px; margin: 24px 0 0; }
  .primer > summary { font: 600 18px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: var(--ink); }
  .primer h3 { font-size: 16px; margin: 22px 0 6px; }
  .primer p { margin: 10px 0; font-size: 15px; }
  .flow { list-style: none; padding: 0; margin: 16px 0; display: flex; flex-wrap: wrap; gap: 6px 22px; }
  .flow li { position: relative; flex: 1 1 100px; background: var(--soft); border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; font-size: 14px; font-weight: 600; }
  .flow li small { display: block; font-weight: 400; color: var(--muted); font-size: 12px; margin-top: 2px; word-break: break-word; }
  .flow li + li::before { content: "→"; position: absolute; left: -18px; top: 50%; transform: translateY(-50%); color: var(--accent); font-weight: 700; }
  .anatomy .n { display: inline-block; min-width: 18px; padding: 0 5px; border-radius: 9px; background: var(--accent); font: 600 11px/18px -apple-system, sans-serif; text-align: center; }
  .notes { padding-left: 0; list-style: none; counter-reset: note; display: grid; gap: 8px; font-size: 14px; }
  .notes li { counter-increment: note; position: relative; padding-left: 28px; }
  .notes li::before { content: counter(note); position: absolute; left: 0; top: 1px; min-width: 18px; height: 18px; border-radius: 9px; background: var(--accent); color: #fff; font: 600 11px/18px -apple-system, sans-serif; text-align: center; }
  .scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { text-align: left; vertical-align: top; padding: 6px 10px 6px 0; border-bottom: 1px solid var(--line); }
  th { color: var(--muted); font-weight: 600; }
  td code { white-space: nowrap; }
  .sends { margin-bottom: 14px; font-size: 14px; }
  .sends .label { display: block; font-weight: 600; color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; margin-bottom: 4px; }
  .sends .url { display: block; padding: 8px 12px; background: #fbfbfc; border: 1px solid var(--line); border-radius: 8px; word-break: break-all; color: var(--muted); }
  .sends .cond { color: #a3460a; font-weight: 600; }
  .sends .f { color: #1c3faa; font-weight: 600; }
  .sends p { margin: 6px 0 0; color: var(--muted); }
  @media (max-width: 760px) { .flow { flex-direction: column; } .flow li + li::before { content: "↓"; left: 50%; top: -15px; transform: translateX(-50%); } .flow { gap: 18px; } }
  @media (max-width: 520px) { main { padding-top: 24px; } .card, .primer { padding: 18px 16px; } .try { display: block; text-align: center; } }
</style>
</head>
<body>
<main>
  <header>
    <h1>syncchat examples</h1>
    <p>syncchat pairs participants in a Qualtrics study for a live chat, using matching rules written in one short YAML file.</p>
    <p class="how">Open in two tabs or two phones and pick compatible answers to get matched.</p>
  </header>
  ${primer()}
  <div class="grid">
${studies.map(card).join('\n')}
  </div>
</main>
</body>
</html>`;
}

module.exports = { renderGallery, ANATOMY_YAML, exampleUrl };
