'use strict';

// GET /demo: a form built from the config's fields and conditions. Submitting opens the
// chat page top-level with the same URL params Qualtrics would pass in the iframe.

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fieldHtml(name, def) {
  const label = `<label class="q" for="f-${esc(name)}">${esc(name)}</label>`;
  if (def.type === 'number') {
    return `<div class="field">${label}<input id="f-${esc(name)}" name="${esc(name)}" type="number" inputmode="decimal" required></div>`;
  }
  if (def.type === 'category' && def.values) {
    const opts = def.values.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
    return `<div class="field">${label}<select id="f-${esc(name)}" name="${esc(name)}" required><option value="">Choose…</option>${opts}</select></div>`;
  }
  if (def.type === 'list' && def.options) {
    const n = def.pick;
    const hint = n ? `Pick ${n}` : 'Pick any';
    const chips = def.options.map((o) => `<button type="button" class="chip" data-value="${esc(o)}">${esc(o)}</button>`).join('');
    return `<div class="field list" data-name="${esc(name)}" data-sep="${esc(def.sep)}" data-pick="${n || ''}">` +
      `<span class="q">${esc(name)} <span class="hint">${hint}</span></span><div class="chips">${chips}</div></div>`;
  }
  const ph = def.type === 'list' ? `items separated by "${def.sep}"` : '';
  return `<div class="field">${label}<input id="f-${esc(name)}" name="${esc(name)}" type="text" placeholder="${esc(ph)}" required></div>`;
}

function renderDemo(config) {
  const { id_param: idParam, condition_param: condParam, fields } = config.participant;
  const conds = Object.keys(config.conditions);
  const condHtml = conds.length > 1
    ? `<div class="field"><label class="q" for="f-cond">condition</label><select id="f-cond" name="${esc(condParam)}">` +
      conds.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('') + '</select></div>'
    : `<input type="hidden" name="${esc(condParam)}" value="${esc(conds[0])}">`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>syncchat demo</title>
<style>
  :root { --ink: #1f2328; --muted: #656d76; --line: #cfd4da; --soft: #f5f6f8; --accent: #3b5bdb; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 16px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: var(--ink); }
  main { max-width: 480px; margin: 0 auto; padding: 28px 20px 40px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: var(--muted); margin: 0 0 22px; }
  .field { margin-bottom: 20px; }
  .q { display: block; font-weight: 600; margin-bottom: 8px; text-transform: capitalize; }
  .hint { font-weight: 400; color: var(--muted); text-transform: none; }
  input, select { width: 100%; padding: 12px; font: inherit; border: 1px solid var(--line); border-radius: 10px; background: #fff; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; }
  .chip { font: inherit; padding: 9px 15px; border-radius: 999px; border: 1px solid var(--line); background: #fff; color: var(--ink); cursor: pointer; }
  .chip.on { background: var(--accent); border-color: var(--accent); color: #fff; }
  .go { width: 100%; font: inherit; font-weight: 600; padding: 14px; border: 0; border-radius: 10px; background: var(--accent); color: #fff; cursor: pointer; }
  .go:disabled { opacity: .45; cursor: default; }
  .err { color: #c92a2a; min-height: 1.4em; margin: 8px 0 0; font-size: 14px; }
</style>
</head>
<body>
<main>
  <h1>Find a chat partner</h1>
  <p class="sub">Answer a few questions. You will be paired with someone who matches, then chat live.</p>
  <form id="form" novalidate>
    ${Object.entries(fields).map(([n, d]) => fieldHtml(n, d)).join('\n    ')}
    ${condHtml}
    <button class="go" type="submit">Start</button>
    <p class="err" id="err"></p>
  </form>
</main>
<script>
(function () {
  const form = document.getElementById('form');
  const lists = [...form.querySelectorAll('.field.list')];
  for (const box of lists) {
    const pick = Number(box.dataset.pick) || Infinity;
    box.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      const on = box.querySelectorAll('.chip.on');
      if (!chip.classList.contains('on') && on.length >= pick) {
        if (pick === 1) on[0].classList.remove('on'); else return;
      }
      chip.classList.toggle('on');
    });
  }
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const err = document.getElementById('err');
    const params = new URLSearchParams();
    params.set(${JSON.stringify(idParam)}, 'demo-' + Math.random().toString(36).slice(2, 10));
    for (const el of form.querySelectorAll('input[name], select[name]')) {
      if (el.required && !el.value.trim()) { err.textContent = 'Please answer every question.'; return el.focus(); }
      params.set(el.name, el.value.trim());
    }
    for (const box of lists) {
      const picked = [...box.querySelectorAll('.chip.on')].map((c) => c.dataset.value);
      const need = Number(box.dataset.pick);
      if (need ? picked.length !== need : !picked.length) {
        err.textContent = need ? 'Pick ' + need + ' for ' + box.dataset.name + '.' : 'Pick at least one for ' + box.dataset.name + '.';
        return;
      }
      params.set(box.dataset.name, picked.join(box.dataset.sep));
    }
    location.href = '/?' + params.toString();
  });
})();
</script>
</body>
</html>`;
}

module.exports = { renderDemo };
