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
    assert.strictEqual(config.timing.match_timeout_ms, 120000);
    assert.strictEqual(config.timing.chat_duration_ms, 300000);
  }
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
    assert.match(html, /Open in two tabs or two phones/);
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
