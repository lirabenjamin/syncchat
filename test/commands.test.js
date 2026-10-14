'use strict';
// explain, simulate, and the Qualtrics generator, run on study.yaml and every example config.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig } = require('../src/config');
const { explainConfig } = require('../src/explain');
const { simulate, formatSimulation, parseCsv } = require('../src/simulate');
const { generateQualtrics } = require('../src/qualtrics');

const root = path.join(__dirname, '..');
const configFiles = ['study.yaml', ...fs.readdirSync(path.join(root, 'examples'))
  .filter((f) => f.endsWith('.yaml')).map((f) => `examples/${f}`)];
const load = (f) => loadConfig(path.join(root, f));
const people = () => parseCsv(fs.readFileSync(path.join(root, 'examples', 'people.csv'), 'utf8'));

test('explain describes every condition, its rules, relax timing, and reveal', () => {
  for (const f of configFiles) {
    const c = load(f);
    const text = explainConfig(c);
    assert.ok(!/undefined|\[object/.test(text), `${f}: no broken text`);
    for (const [name, cond] of Object.entries(c.conditions)) {
      assert.ok(text.includes(`Condition "${name}"`), `${f}: ${name}`);
      for (const r of cond.require) assert.ok(text.includes(r.describe), `${f}: ${r.describe}`);
      if (cond.reveal) assert.ok(text.includes(cond.reveal), `${f}: reveal`);
    }
  }
  assert.strictEqual(explainConfig(load('examples/shared-top3.yaml')).split('\n')[3],
    'Condition "shared": partners must (1) share at least 1 item in top3 AND (2) have age within 15 of each other. '
    + 'Among valid partners, rank by (1) most shared items in top3, then (2) closest age; ties go to whoever has waited longest. '
    + 'After someone has waited 45s, rule (2) is dropped for pairs that include them and preferences are dropped '
    + '(they take the first valid partner). Participants see: "You were matched because you both picked {shared.top3} in your top three."');
  assert.match(explainConfig(load('examples/advanced-rules.yaml')),
    /either share at least 1 item in top3 OR be in the same age decade .* AND \(3\) NOT both have gender = Man/);
});

test('simulate is deterministic and uses the real matcher on examples/people.csv', () => {
  const c = load('examples/shared-top3.yaml');
  const run = () => formatSimulation(simulate(c, people()));
  const out = run();
  assert.strictEqual(out, run(), 'same input, same output');
  assert.match(out, /MATCH {4}\[shared\] p12 \+ p14/);
  assert.match(out, /p12 sees: "You were matched because you both picked hiking and cooking in your top three\."/);
  assert.match(out, /TIMEOUT {2}\[shared\] p15/);
  assert.match(out, /shared\s+5\s+4\s+1\s+80%/);

  const adv = formatSimulation(simulate(load('examples/advanced-rules.yaml'), people()));
  for (const m of adv.matchAll(/MATCH +\[cross\] (p\d+) \+ (p\d+)/g)) {
    const [a, b] = [m[1], m[2]].map((id) => people().find((p) => p.id === id));
    assert.notStrictEqual(a.party, b.party, 'differ: party holds');
    assert.ok(!(a.gender === 'Man' && b.gender === 'Man'), 'not both men holds');
  }
  for (const f of configFiles) assert.match(formatSimulation(simulate(load(f), people())), /match rate/, f);
});

test('qualtrics generator: filled-in JS/HTML/checklist and an importable QSF', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'syncchat-q-'));
  try {
    for (const f of configFiles) {
      const c = load(f);
      const files = generateQualtrics(c, { url: 'https://my-study.onrender.com/', outDir: out });
      assert.deepStrictEqual(files.map((x) => path.basename(x)).sort(),
        ['CHECKLIST.md', 'chat-question.html', 'chat-question.js', 'syncchat_template.qsf']);
      const read = (n) => fs.readFileSync(path.join(out, n), 'utf8');
      const js = read('chat-question.js');
      assert.ok(js.includes('"https://my-study.onrender.com"'), `${f}: origin filled in`);
      assert.ok(js.includes(`"${c.participant.condition_param}": "\${e://Field/${c.participant.condition_param}}"`));
      assert.ok(js.includes(`"study": "${c.study.id}"`), `${f}: iframe URL sends study=`);
      for (const field of Object.keys(c.participant.fields)) {
        assert.ok(js.includes(`"${field}": "\${e://Field/${field}}"`), `${f}: field ${field}`);
        assert.ok(read('CHECKLIST.md').includes(`\`${field}\``), `${f}: checklist lists ${field}`);
      }
      for (const n of ['chat-question.js', 'chat-question.html', 'CHECKLIST.md', 'syncchat_template.qsf']) {
        assert.ok(!/TODO|YOUR_|REPLACE_ME|<your/i.test(read(n)), `${f}: ${n} has no placeholders`);
      }

      const qsf = JSON.parse(read('syncchat_template.qsf'));
      assert.ok(qsf.SurveyEntry && Array.isArray(qsf.SurveyElements));
      const el = (kind) => qsf.SurveyElements.filter((e) => e.Element === kind);
      for (const kind of ['BL', 'FL', 'SO', 'SQ', 'QC', 'RS']) assert.ok(el(kind).length, `${f}: has ${kind}`);
      const flow = el('FL')[0].Payload.Flow;
      const ed = flow[0].EmbeddedData.map((e) => e.Field);
      for (const k of [...Object.keys(c.participant.fields), c.participant.condition_param,
        'chat_outcome', 'chat_match_reason', 'chat_partner_id']) assert.ok(ed.includes(k), `${f}: embedded ${k}`);
      const rnd = flow.find((x) => x.Type === 'BlockRandomizer');
      assert.strictEqual(rnd.SubSet, 1);
      assert.strictEqual(rnd.EvenPresentation, true);
      assert.deepStrictEqual(rnd.Flow.map((x) => x.EmbeddedData[0].Value), Object.keys(c.conditions));
      const chat = el('SQ').find((q) => q.Payload.DataExportTag === 'chat').Payload;
      assert.strictEqual(chat.QuestionJS, js, `${f}: the QSF carries the same question JS`);
      assert.match(chat.QuestionText, /chat-root/);
      const blockIds = Object.values(el('BL')[0].Payload).map((b) => b.ID);
      for (const s of flow.filter((x) => x.Type === 'Standard')) assert.ok(blockIds.includes(s.ID), 'flow points at real blocks');
    }
    assert.throws(() => generateQualtrics(load('study.yaml'), { url: 'my-study.onrender.com', outDir: out }), /--url must be/);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
