'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadStudyDir, ConfigError } = require('../src/config');
const { createStorage } = require('../src/storage');
const { createApp } = require('../src/app');
const { matches, nonMatches, join } = require('./gallery-cases');
const yaml = require('js-yaml');
const { validateConfig } = require('../src/config');
const { explainConfig } = require('../src/explain');
const { ANATOMY_YAML } = require('../src/gallery');

const galleryDir = path.join(__dirname, '..', 'examples', 'gallery');
const IDS = ['shared-interest', 'cross-party', 'same-vs-cross', 'opposing-views', 'similar-age-relax', 'advice-pairs', 'combo'];

let app, url, dataDir;
const sockets = [];
const tag = () => Math.random().toString(36).slice(2, 8);
const joinHere = (params) => {
  const p = join(url, params);
  sockets.push(p.socket);
  return p;
};

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncchat-gallery-'));
  const studies = [];
  for (const s of loadStudyDir(galleryDir)) {
    studies.push({ ...s, storage: await createStorage({ dataDir, studyId: s.config.study.id }) });
  }
  app = createApp({ studies, log: () => {} });
  url = `http://127.0.0.1:${await app.listen(0)}`;
});

test.after(async () => {
  for (const s of sockets) s.close();
  await app.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('every gallery config validates, has a title and description, and ids are unique', () => {
  const studies = loadStudyDir(galleryDir);
  assert.deepStrictEqual(studies.map((s) => s.config.study.id), IDS);
  for (const { config } of studies) {
    assert.ok(config.title && config.description, config.study.id);
    assert.match(explainConfig(config), new RegExp(`^Study "${config.study.id}"`));
    assert.strictEqual(config.timing.match_timeout_ms, 120000);
    assert.strictEqual(config.timing.chat_duration_ms, 300000);
  }
});

test('the annotated anatomy YAML on the gallery page validates and explains', () => {
  const config = validateConfig(yaml.load(ANATOMY_YAML));
  assert.deepStrictEqual(Object.keys(config.conditions), ['cross', 'same']);
  assert.match(explainConfig(config), /After someone has waited 30s, preferences are dropped/);
});

test('gallery page has three linkable tabs: examples, configuration, setup', async () => {
  const html = await (await fetch(url + '/')).text();
  for (const id of ['examples', 'configuration', 'setup']) {
    assert.match(html, new RegExp(`<a href="#${id}">`));
    assert.match(html, new RegExp(`<section id="${id}" class="tab">`));
  }
  const at = (id) => html.indexOf(`<section id="${id}"`);
  const firstCard = html.indexOf('<article class="card"');
  assert.ok(at('examples') < firstCard && firstCard < at('configuration') && at('configuration') < at('setup'));
  assert.match(html, /Open a card in two tabs or two phones and give compatible answers\./);
});

test('configuration tab: anatomy, field types, rules, settings, custom rule, and real explain/simulate output', async () => {
  const html = await (await fetch(url + '/')).text();
  const conf = html.slice(html.indexOf('<section id="configuration"'), html.indexOf('<section id="setup"'));
  assert.match(conf, /<h2>How a study.yaml works<\/h2>/);
  assert.strictEqual(conf.match(/<span class="n">\d<\/span>/g).length, 9); // numbered callouts
  for (const t of ['category', 'list', 'number']) assert.match(conf, new RegExp(`<td><code>${t}</code></td>`));
  for (const r of ['same', 'differ', 'equals', 'overlap', 'within', 'closest', 'any_of', 'not', 'custom']) {
    assert.match(conf, new RegExp(`<td><code>${r}</code></td>`));
  }
  for (const p of ['shared.top3', 'me.age', 'partner.party']) assert.match(conf, new RegExp(`<td><code>\\{${p}\\}</code></td>`));
  // Defaults in the settings table match the validator's.
  const config = validateConfig(yaml.load(ANATOMY_YAML));
  const setting = (k) => conf.match(new RegExp(`<td><code>${k}</code></td><td>(.*?)</td>`))[1];
  assert.strictEqual(setting('participant.id_param'), `<code>${config.participant.id_param}</code>`);
  assert.strictEqual(setting('participant.condition_param'), `<code>${config.participant.condition_param}</code>`);
  assert.strictEqual(setting('timing.min_messages'), `<code>${config.timing.min_messages}</code>`);
  assert.strictEqual(setting('on_timeout'), `<code>${config.on_timeout}</code>`);
  for (const [k, v] of Object.entries(config.limits)) assert.strictEqual(setting(`limits.${k}`), `<code>${v}</code>`);
  assert.match(conf, /custom: \{file: \.\/rules\/same_decade\.js, field: age\}/);
  for (const cmd of ['npm run validate', 'npm run explain', 'npm run simulate']) assert.ok(conf.includes(cmd), cmd);
  assert.ok(conf.includes('Condition &quot;cross&quot;: partners must (1) have different party'));
  assert.match(conf, /MATCH +\[cross\] p3 \+ p6/); // prefer closest age picks p3 over p5
  assert.match(conf, /TIMEOUT +\[cross\] p5/);
});

test('setup tab: accounts, every env var the code reads, ordered steps, troubleshooting', async () => {
  const html = await (await fetch(url + '/')).text();
  const setup = html.slice(html.indexOf('<section id="setup"'), html.indexOf('</main>'));
  // Every process.env.X read in src/ (npm_config_* is set by npm itself, not by the researcher).
  const src = path.join(__dirname, '..', 'src');
  const vars = new Set(fs.readdirSync(src).flatMap((f) =>
    [...fs.readFileSync(path.join(src, f), 'utf8').matchAll(/process\.env\.([A-Za-z_]+)/g)].map((m) => m[1]))
    .filter((v) => !v.startsWith('npm_config_')));
  assert.deepStrictEqual([...vars].sort(), ['ADMIN_TOKEN', 'DATA_DIR', 'MONGO_URI', 'PORT', 'STUDY_CONFIG', 'STUDY_DIR']);
  for (const v of vars) assert.match(setup, new RegExp(`<td><code>${v}</code></td>`), v);
  assert.match(setup, /No AI or LLM API keys are needed/);
  for (const a of ['GitHub', 'Render', 'MongoDB Atlas', 'Qualtrics']) assert.match(setup, new RegExp(`<b>${a}</b>`));
  const steps = [...setup.matchAll(/<li><h3>(.*?)<\/h3>/g)].map((m) => m[1]);
  assert.deepStrictEqual(steps, ['Get the code', 'Set up MongoDB Atlas', 'Write your study.yaml and check it', 'Deploy to Render',
    'Test the live app', 'Add the chat to Qualtrics', 'Pilot', 'Recruit', 'Download the data', 'IRB and privacy']);
  for (const s of ['0.0.0.0/0', 'npm run qualtrics -- --url', '/export?token=', 'format=csv&amp;table=messages', 'chat_outcome = nomatch',
    'npm install --omit=dev', '/healthz']) assert.ok(setup.includes(s), s);
  assert.match(setup, /<h2>Troubleshooting<\/h2>/);
});

test('example cards show the URL Qualtrics sends', async () => {
  const html = await (await fetch(url + '/')).text();
  assert.strictEqual(html.match(/<span class="label">What Qualtrics sends/g).length, 7);
  for (const { config } of loadStudyDir(galleryDir)) {
    const card = html.slice(html.indexOf(`<article class="card" id="${config.study.id}"`));
    const sends = card.slice(card.indexOf('<code class="url">'), card.indexOf('</code>', card.indexOf('<code class="url">')));
    const params = new URLSearchParams(sends.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/^.*\?/, ''));
    assert.strictEqual(params.get('study'), config.study.id);
    assert.ok(Object.hasOwn(config.conditions, params.get('cond')), config.study.id);
    for (const f of Object.keys(config.participant.fields)) assert.ok(params.get(f), `${config.study.id}: ${f}`);
  }
  assert.match(html, /\?<span class="p">study=opposing-views<\/span>&amp;<span class="p">id=R_abc123<\/span>&amp;<span class="cond">cond=disagree<\/span>&amp;<span class="f">stance=2<\/span>/);
});

test('"study" is reserved as a field or parameter name', () => {
  const base = yaml.load(ANATOMY_YAML);
  base.participant.fields.study = { type: 'category' };
  base.participant.condition_param = 'study';
  assert.throws(() => validateConfig(base), (e) => e instanceof ConfigError &&
    e.errors.some((m) => m.startsWith('participant.fields.study')) && e.errors.some((m) => m.startsWith('participant.condition_param')));
});

test('a folder with two studies sharing an id is rejected', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncchat-dup-'));
  try {
    for (const n of ['a.yaml', 'b.yaml']) fs.copyFileSync(path.join(galleryDir, '02-cross-party.yaml'), path.join(dir, n));
    assert.throws(() => loadStudyDir(dir), (e) => e instanceof ConfigError && /used by both a.yaml and b.yaml/.test(e.message));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('gallery lists all studies with explanation, YAML, and a Try it link', async () => {
  for (const route of ['/', '/gallery']) {
    const res = await fetch(url + route);
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.strictEqual(html.match(/<article class="card"/g).length, 7);
    for (const id of IDS) assert.match(html, new RegExp(`href="/demo\\?study=${id}">Try it`));
    assert.match(html, /Open a card in two tabs or two phones/);
    assert.match(html, /partners must NOT have stance within 2 of each other/); // explain output
    assert.match(html, /<span class="c"># NOT within 2 points/);               // YAML comments kept
  }
  const bare = await fetch(`${url}/demo`, { redirect: 'manual' });
  assert.strictEqual(bare.headers.get('location'), '/gallery');
});

test('/demo?study=x renders that study\'s fields, hint, and study id', async () => {
  const views = await (await fetch(`${url}/demo?study=opposing-views`)).text();
  assert.match(views, /name="stance" type="number" inputmode="decimal" min="1" max="7"/);
  assert.match(views, /type="hidden" name="study" value="opposing-views"/);
  assert.match(views, /How matching works:<\/strong> You are paired only with someone whose stance/);
  assert.match(views, /href="\/gallery"/);
  assert.doesNotMatch(views, /name="party"/);

  const svc = await (await fetch(`${url}/demo?study=same-vs-cross`)).text();
  assert.match(svc, /Condition <span class="hint">\(in a real study, Qualtrics randomizes this\)/);
  assert.match(svc, /<option value="same">Same party<\/option><option value="cross">Cross party<\/option>/);

  const advice = await (await fetch(`${url}/demo?study=advice-pairs`)).text();
  assert.match(advice, /<select id="f-role" name="role" required>.*Seeking advice.*Giving advice/);
  assert.match(advice, /data-name="topic" data-sep="," data-pick="1"/);

  assert.strictEqual((await fetch(`${url}/client-config.json?study=combo`)).status, 200);
  assert.strictEqual((await fetch(`${url}/client-config.json?study=nope`)).status, 404);
  const health = await (await fetch(`${url}/healthz`)).json();
  assert.deepStrictEqual(Object.keys(health.studies), IDS);
});

for (const c of matches) {
  test(`${c.study}: compatible pair matches with the right reveal`, async () => {
    const t = tag();
    const a = joinHere({ study: c.study, id: `a-${t}`, ...c.a });
    await a.next('waiting');
    const b = joinHere({ study: c.study, id: `b-${t}`, ...c.b });
    const [ma, mb] = await Promise.all([a.next('matched'), b.next('matched')]);
    assert.deepStrictEqual([ma.reveal, mb.reveal], c.reveal);
  });
}

for (const c of nonMatches) {
  test(`${c.study}: incompatible pair keeps waiting`, async () => {
    const t = tag();
    const a = joinHere({ study: c.study, id: `a-${t}`, ...c.a });
    const b = joinHere({ study: c.study, id: `b-${t}`, ...c.b });
    await Promise.all([a.next('waiting'), b.next('waiting')]);
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(a.seen('matched') + b.seen('matched'), 0);
    a.socket.close();
    b.socket.close();
  });
}

test('studies are isolated: participants in different studies never match, and ids may repeat across studies', async () => {
  const t = tag();
  // Compatible on paper (Democrat + Republican, both "cross"), but in two different studies.
  const dem = joinHere({ study: 'cross-party', id: `x-${t}`, party: 'Democrat' });
  const rep = joinHere({ study: 'same-vs-cross', id: `x-${t}`, cond: 'cross', party: 'Republican' });
  await Promise.all([dem.next('waiting'), rep.next('waiting')]);
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(dem.seen('matched') + rep.seen('matched'), 0);
  // A Republican in the same study as the Democrat does match.
  const rep2 = joinHere({ study: 'cross-party', id: `y-${t}`, party: 'Republican' });
  const [md] = await Promise.all([dem.next('matched'), rep2.next('matched')]);
  assert.strictEqual(md.reveal, 'Your partner is a Republican.');
  assert.strictEqual(rep.seen('matched'), 0);
  rep.socket.close();

  const lost = joinHere({ study: 'nope', id: `z-${t}` });
  assert.strictEqual((await lost.next('joinError')).code, 'unknown_study');
});

test('each study writes to its own storage', async () => {
  const lines = fs.readFileSync(path.join(dataDir, 'matches.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  const crossParty = lines.filter((m) => m.study_id === 'cross-party');
  assert.ok(crossParty.length >= 2);
  assert.ok(crossParty.every((m) => m.condition === 'cross'));
});
