'use strict';

// GET / and /gallery in multi-study mode: one card per study with its description, the
// plain-English matching logic from `npm run explain`, the raw study.yaml, and a "Try it" link.

const { explainConfig } = require('./explain');
const { esc } = require('./demo');

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
  @media (max-width: 520px) { main { padding-top: 24px; } .card { padding: 18px 16px; } .try { display: block; text-align: center; } }
</style>
</head>
<body>
<main>
  <header>
    <h1>syncchat examples</h1>
    <p>syncchat pairs participants in a Qualtrics study for a live chat, using matching rules written in one short YAML file.</p>
    <p class="how">Open in two tabs or two phones and pick compatible answers to get matched.</p>
  </header>
  <div class="grid">
${studies.map(card).join('\n')}
  </div>
</main>
</body>
</html>`;
}

module.exports = { renderGallery };
