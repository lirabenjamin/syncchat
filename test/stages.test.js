'use strict';
// v0.3: per-condition timing, untimed chats with Done, end_when, max_duration, server-side
// min_messages, extend_until_min, and stages (continue in the same window, or hand over to Qualtrics
// and rejoin the same partner).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io: connect } = require('socket.io-client');
const { validateConfig, loadConfig, ConfigError } = require('../src/config');
const { createStorage } = require('../src/storage');
const { createApp } = require('../src/app');
const { explainConfig } = require('../src/explain');
const { simulate, formatSimulation, parseCsv } = require('../src/simulate');
const { generateQualtrics } = require('../src/qualtrics');

const root = path.join(__dirname, '..');
const gallery = (f) => path.join(root, 'examples', 'gallery', f);
const base = (id, extra) => ({
  study: { id },
  participant: { fields: { party: { type: 'category' } } },
  timing: { match_timeout: '2s', chat_duration: '5s' },
  embed: { allowed_origins: ['https://*.qualtrics.com'] },
  limits: { joins_per_ip_per_minute: 1000, messages_per_10s: 100 },
  ...extra,
});

const STUDIES = [
  base('untimed', {
    conditions: {
      both: { timing: { chat_duration: 'none', min_messages: 2 } },
      either: { timing: { chat_duration: 'none', end_when: 'either_done' } },
      capped: { timing: { chat_duration: 'none', max_duration: '300ms' } },
      ext: { timing: { chat_duration: '200ms', min_messages: 1, extend_until_min: '2s' } },
      timed: { timing: { chat_duration: '200ms', min_messages: 1 } },
    },
  }),
  base('cont', {
    conditions: { c: { reveal: 'Your partner is a {partner.party}.' } },
    stages: [
      { id: 's1', prompt: 'Get to know each other.', chat_duration: '300ms', then: 'continue' },
      { id: 's2', prompt: 'Discuss the topic.', chat_duration: 'none' },
    ],
  }),
  base('qual', {
    timing: { match_timeout: '2s', chat_duration: '5s', rejoin_timeout: '600ms' },
    conditions: { c: {} },
    stages: [
      { id: 'intro', chat_duration: 'none', end_when: 'either_done', then: 'qualtrics' },
      { id: 'discuss', chat_duration: 'none', min_messages: 1 },
    ],
  }),
];

let app, url, dataDir;
const sockets = [];
const tag = () => Math.random().toString(36).slice(2, 8);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EVENTS = ['waiting', 'matched', 'joinError', 'message', 'chatEnded', 'chatState', 'stageStarted', 'stageEnded',
  'stageExtended', 'waitingPartner', 'doneUpdate', 'doneRejected', 'partnerAway', 'partnerBack'];

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncchat-stages-'));
  const studies = [];
  for (const raw of STUDIES) {
    const config = validateConfig(raw);
    studies.push({ config, source: '', storage: await createStorage({ dataDir, studyId: config.study.id }) });
  }
  app = createApp({ studies, log: () => {} });
  url = `http://127.0.0.1:${await app.listen(0)}`;
});

test.after(async () => {
  for (const s of sockets) s.close();
  await app.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// Connect a participant; next(event) resolves with that event's next payload.
function join(params) {
  const socket = connect(url, { transports: ['websocket'], forceNew: true, reconnection: false });
  sockets.push(socket);
  const queues = Object.fromEntries(EVENTS.map((ev) => [ev, []]));
  for (const ev of EVENTS) socket.on(ev, (p) => queues[ev].push(p));
  socket.on('connect', () => socket.emit('join', params));
  const next = (ev, ms = 3000) => new Promise((resolve, reject) => {
    const start = Date.now();
    (function poll() {
      if (queues[ev].length) return resolve(queues[ev].shift());
      if (Date.now() - start > ms) return reject(new Error(`timed out waiting for ${ev}`));
      setTimeout(poll, 10);
    })();
  });
  return { socket, next, seen: (ev) => queues[ev].length, say: (t) => socket.emit('message', t), done: () => socket.emit('done') };
}

// Two participants matched in `study`/`cond`.
async function pair(study, cond) {
  const t = tag();
  const ids = [`a-${t}`, `b-${t}`];
  const a = join({ study, cond, id: ids[0], party: 'Democrat' });
  await a.next('waiting');
  const b = join({ study, cond, id: ids[1], party: 'Republican' });
  const [ma, mb] = await Promise.all([a.next('matched'), b.next('matched')]);
  return { a, b, ma, mb, ids };
}

async function exchange(a, b, text) {
  const got = Promise.all([a.next('message'), b.next('message')]);
  a.say(text);
  return got;
}

const records = (kind) => fs.readFileSync(path.join(dataDir, `${kind}.jsonl`), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));

// ---- config ----

test('timing merges global -> condition -> stage, with defaults for untimed and timed chats', () => {
  const c = validateConfig(STUDIES[0]);
  const st = (cond) => c.conditions[cond].stages[0];
  assert.deepStrictEqual([st('both').chat_duration_ms, st('both').end_when, st('both').max_duration_ms, st('both').min_messages],
    [null, 'both_done', 3600000, 2]);
  assert.strictEqual(st('either').end_when, 'either_done');
  assert.strictEqual(st('capped').max_duration_ms, 300);
  assert.deepStrictEqual([st('ext').chat_duration_ms, st('ext').end_when, st('ext').extend_until_min_ms], [200, 'timer', 2000]);
  assert.strictEqual(c.conditions.both.timing.match_timeout_ms, 2000);

  const q = validateConfig(STUDIES[2]);
  assert.deepStrictEqual(q.conditions.c.stages.map((s) => [s.id, s.then, s.end_when, s.min_messages]),
    [['intro', 'qualtrics', 'either_done', 0], ['discuss', null, 'both_done', 1]]);
  assert.strictEqual(q.conditions.c.timing.rejoin_timeout_ms, 600);
  assert.strictEqual(q.conditions.c.staged, true);

  const cont = validateConfig(STUDIES[1]);
  assert.deepStrictEqual(cont.conditions.c.stages.map((s) => s.reveal), ['Your partner is a {partner.party}.', false]);

  // A condition's timing overrides the global match_timeout, and the lobby honors it.
  const per = validateConfig(base('per', { conditions: { fast: { timing: { match_timeout: '1s' } }, slow: {} } }));
  assert.deepStrictEqual([per.conditions.fast.timing.match_timeout_ms, per.conditions.slow.timing.match_timeout_ms], [1000, 2000]);
  const sim = simulate(per, parseCsv('id,cond,party,arrival_s\np1,fast,x,0\np2,slow,x,0\n'));
  assert.deepStrictEqual(sim.events.map((e) => [e.id, e.at]), [['p1', 1000], ['p2', 2000]]);
});

test('timing and stage settings are validated', () => {
  const bad = (raw, pattern) => assert.throws(() => validateConfig(raw),
    (e) => e instanceof ConfigError && e.errors.some((m) => pattern.test(m)), `expected ${pattern}`);
  bad(base('x', { conditions: { c: { timing: { chat_duration: 'none', end_when: 'timer' } } } }), /end_when: "timer" needs a time limit/);
  bad(base('x', { conditions: { c: { timing: { max_duration: '5m' } } } }), /max_duration: only applies when chat_duration is none/);
  bad(base('x', { conditions: { c: { timing: { chat_duration: 'none', extend_until_min: '1m' } } } }), /extend_until_min: only applies to timed/);
  bad(base('x', { conditions: { c: {} }, timing: { match_timeout: '2s', chat_duration: '5s', rejoin_timeout: '1m' } }), /rejoin_timeout: only applies to chats with stages/);
  bad(base('x', { conditions: { c: { timing: { end_when: 'sometimes' } } } }), /end_when: must be one of timer, both_done, either_done/);
  bad(base('x', { conditions: { c: {} }, stages: [{ id: 'a', then: 'qualtrics' }] }), /the last stage ends the chat, so it has no then/);
  bad(base('x', { conditions: { c: {} }, stages: [{ id: 'a' }, { id: 'a' }] }), /"a" is used by another stage/);
  bad(base('x', { conditions: { c: {} }, stages: [{ id: 'a', then: 'later' }, { id: 'b' }] }), /then: must be one of continue, qualtrics/);
  bad(base('x', { conditions: { c: {} }, stages: [{ id: 'a' }], participant: { fields: { stage: { type: 'category' } } } }),
    /"stage" is reserved in a study with stages/);
});

// ---- untimed chats, Done, min_messages ----

test('both_done: Done is rejected server-side until min_messages, then each waits for the other', async () => {
  const { a, b, ma } = await pair('untimed', 'both');
  assert.deepStrictEqual([ma.stage.end_when, ma.stage.min_messages, ma.stage.ends_at, ma.ends_at], ['both_done', 2, null, null]);
  a.done();
  assert.deepStrictEqual(await a.next('doneRejected'), { sent: 0, min_messages: 2 });
  await exchange(a, b, 'one');
  await exchange(a, b, 'two');
  a.done();
  const [ua, ub] = await Promise.all([a.next('doneUpdate'), b.next('doneUpdate')]);
  assert.deepStrictEqual([ua, ub], [{ done: true, partner_done: false }, { done: false, partner_done: true }]);
  b.done();
  assert.deepStrictEqual(await b.next('doneRejected'), { sent: 0, min_messages: 2 });
  await exchange(b, a, 'three');
  await exchange(b, a, 'four');
  b.done();
  const [ea, eb] = await Promise.all([a.next('chatEnded'), b.next('chatEnded')]);
  assert.deepStrictEqual([ea.outcome, ea.end_reason, ea.message_count, ea.met_min_messages], ['completed', 'both_done', 2, true]);
  assert.strictEqual(eb.end_reason, 'both_done');
  assert.strictEqual(ea.stage, undefined, 'unstaged chats carry no stage');
});

test('either_done ends the chat for both when one clicks Done', async () => {
  const { a, b } = await pair('untimed', 'either');
  b.done();
  const [ea, eb] = await Promise.all([a.next('chatEnded'), b.next('chatEnded')]);
  assert.deepStrictEqual([ea.outcome, ea.end_reason, eb.end_reason], ['completed', 'either_done', 'either_done']);
});

test('max_duration caps an untimed chat', async () => {
  const { a, b, ma } = await pair('untimed', 'capped');
  assert.ok(ma.stage.max_ends_at - ma.stage.started_at === 300);
  const [ea] = await Promise.all([a.next('chatEnded'), b.next('chatEnded')]);
  assert.deepStrictEqual([ea.outcome, ea.end_reason], ['completed', 'max_duration']);
});

test('timed chats: Done is ignored, met_min_messages is recorded, extend_until_min runs on until everyone has sent enough', async () => {
  const t = await pair('untimed', 'timed');
  t.a.done();
  await exchange(t.a, t.b, 'hi');
  const [ta, tb] = await Promise.all([t.a.next('chatEnded'), t.b.next('chatEnded')]);
  assert.deepStrictEqual([ta.end_reason, ta.met_min_messages, tb.met_min_messages], ['timer', true, false]);
  assert.strictEqual(t.a.seen('doneRejected') + t.a.seen('doneUpdate'), 0);

  const e = await pair('untimed', 'ext');
  await exchange(e.a, e.b, 'hi');
  const ext = await e.b.next('stageExtended');
  assert.strictEqual(ext.min_messages, 1);
  assert.strictEqual(e.b.seen('chatEnded'), 0);
  await exchange(e.b, e.a, 'hello');
  const [xa, xb] = await Promise.all([e.a.next('chatEnded'), e.b.next('chatEnded')]);
  assert.deepStrictEqual([xa.end_reason, xa.met_min_messages, xb.met_min_messages], ['min_reached', true, true]);
});

// ---- stages ----

test('then: continue runs the next stage in the same window; messages and stage records carry the stage', async () => {
  const { a, b, ma, mb, ids } = await pair('cont', 'c');
  assert.deepStrictEqual([ma.stage.id, ma.stage.index, ma.stage.count, ma.stage.prompt], ['s1', 0, 2, 'Get to know each other.']);
  assert.strictEqual(mb.reveal, 'Your partner is a Democrat.');
  await exchange(a, b, 'in stage one');
  const [sa] = await Promise.all([a.next('stageStarted'), b.next('stageStarted')]);
  assert.deepStrictEqual([sa.id, sa.index, sa.prompt, sa.reveal, sa.ends_at, sa.end_when], ['s2', 1, 'Discuss the topic.', null, null, 'both_done']);
  await exchange(b, a, 'in stage two');
  a.done();
  b.done();
  const [ea] = await Promise.all([a.next('chatEnded'), b.next('chatEnded')]);
  assert.deepStrictEqual([ea.outcome, ea.stage, ea.message_count, ea.stage_message_count], ['completed', 's2', 1, 0]);

  const msgs = records('messages').filter((m) => m.match_id === ea.match_id);
  assert.deepStrictEqual(msgs.map((m) => [m.participant_id, m.stage]), [[ids[0], 's1'], [ids[1], 's2']]);
  const stages = records('stages').filter((s) => s.match_id === ea.match_id);
  assert.deepStrictEqual(stages.map((s) => [s.stage, s.end_reason]), [['s1', 'timer'], ['s2', 'both_done']]);
  assert.deepStrictEqual(stages[0].message_counts, { [ids[0]]: 1, [ids[1]]: 0 });
  assert.ok(stages[0].started_at && stages[0].ended_at);
  const outcomes = records('outcomes').filter((o) => o.match_id === ea.match_id);
  assert.ok(outcomes.every((o) => o.stage === 's2' && o.end_reason === 'both_done'));
});

// End stage "intro" of a matched `qual` pair; both see stageEnded.
async function toBetween() {
  const p = await pair('qual', 'c');
  await exchange(p.a, p.b, 'before the survey');
  p.a.done();
  const [sa, sb] = await Promise.all([p.a.next('stageEnded'), p.b.next('stageEnded')]);
  assert.deepStrictEqual([sa.stage, sa.next_stage, sa.end_reason, sa.message_count, sb.message_count], ['intro', 'discuss', 'either_done', 1, 0]);
  return p;
}

for (const order of ['a-then-b', 'b-then-a']) {
  test(`then: qualtrics rejoins the same partner (${order}, with a delay) and restores the transcript`, async () => {
    const { ids, ma } = await toBetween();
    const [first, second] = order === 'a-then-b' ? ids : [...ids].reverse();
    await sleep(150); // time on the survey questions in between
    const x = join({ study: 'qual', cond: 'c', id: first, party: 'Democrat', stage: 'discuss' });
    await x.next('waitingPartner');
    await sleep(200);
    const y = join({ study: 'qual', cond: 'c', id: second, party: 'Republican', stage: 'discuss' });
    const [cx, cy] = await Promise.all([x.next('chatState'), y.next('chatState')]);
    assert.strictEqual(cx.match_id, ma.match_id);
    assert.deepStrictEqual([cx.partner_id, cy.partner_id], [second, first]);
    assert.deepStrictEqual([cx.stage.id, cx.stage.index, cx.stage.min_messages], ['discuss', 1, 1]);
    assert.deepStrictEqual(cx.transcript.map((m) => [m.text, m.stage_index]), [['before the survey', 0]]);
    x.done();
    assert.deepStrictEqual(await x.next('doneRejected'), { sent: 0, min_messages: 1 });
    await exchange(x, y, 'after the survey');
    await exchange(y, x, 'agreed');
    x.done();
    y.done();
    const [ex] = await Promise.all([x.next('chatEnded'), y.next('chatEnded')]);
    const total = first === ids[0] ? 2 : 1; // A also sent one message in stage "intro"
    assert.deepStrictEqual([ex.outcome, ex.stage, ex.end_reason, ex.message_count, ex.stage_message_count], ['completed', 'discuss', 'both_done', total, 1]);
    const stages = records('stages').filter((s) => s.match_id === ma.match_id);
    assert.deepStrictEqual(stages.map((s) => s.stage), ['intro', 'discuss']);
  });
}

test('a partner who never rejoins: the returner gets partner_left after rejoin_timeout; the absent one, no_rejoin', async () => {
  const { ids, b } = await toBetween();
  const x = join({ study: 'qual', cond: 'c', id: ids[0], party: 'Democrat', stage: 'discuss' });
  const w = await x.next('waitingPartner');
  assert.ok(w.timeout_at > Date.now());
  const ex = await x.next('chatEnded');
  assert.deepStrictEqual([ex.outcome, ex.end_reason, ex.stage], ['partner_left', 'no_rejoin', 'intro']);
  assert.strictEqual((await b.next('chatEnded')).outcome, 'no_rejoin');
  // Arriving late at the later chat question shows the same ending instead of a new match.
  const late = join({ study: 'qual', cond: 'c', id: ids[1], party: 'Republican', stage: 'discuss' });
  assert.strictEqual((await late.next('chatEnded')).outcome, 'no_rejoin');
  assert.strictEqual(late.seen('waiting'), 0);
});

test('reconnecting mid-stage restores the transcript; a stage param with no pair or an unknown stage is an error', async () => {
  const { a, b, ids } = await pair('qual', 'c');
  await exchange(a, b, 'first');
  await exchange(b, a, 'second');
  a.socket.close();
  assert.ok((await b.next('partnerAway')).grace_ms === 600);
  const back = join({ study: 'qual', cond: 'c', id: ids[0], party: 'Democrat' });
  const st = await back.next('chatState');
  assert.deepStrictEqual(st.transcript.map((m) => [m.mine, m.text]), [[true, 'first'], [false, 'second']]);
  assert.strictEqual(st.stage.id, 'intro');
  await b.next('partnerBack');
  await exchange(back, b, 'still here');

  const nobody = join({ study: 'qual', cond: 'c', id: `n-${tag()}`, party: 'Democrat', stage: 'discuss' });
  assert.strictEqual((await nobody.next('joinError')).code, 'no_pair');
  const unknown = join({ study: 'qual', cond: 'c', id: `u-${tag()}`, party: 'Democrat', stage: 'nope' });
  assert.strictEqual((await unknown.next('joinError')).code, 'unknown_stage');

  // A partner who stays away past rejoin_timeout ends the chat.
  back.socket.close();
  const eb = await b.next('chatEnded');
  assert.deepStrictEqual([eb.outcome, eb.end_reason], ['partner_left', 'left']);
});

// ---- explain, simulate, Qualtrics ----

test('explain and simulate describe the new gallery examples', () => {
  const untimed = loadConfig(gallery('08-untimed-min-messages.yaml'));
  const text = explainConfig(untimed);
  assert.match(text, /The chat lasts 2m\./);
  assert.match(text, /The chat has no time limit and ends when both participants click Done \(at most 20m\); Done unlocks once that person has sent 3 messages\./);
  const twoStage = explainConfig(loadConfig(gallery('09-two-stage.yaml')));
  assert.match(twoStage, /The chat has 2 stages with the same partner\./);
  assert.match(twoStage, /Stage 1 "intro" lasts 3m\. Prompt: .* a later chat question \(stage=discuss\) reunites the same pair for stage 2\. Whoever returns waits up to 3m/);
  assert.match(twoStage, /Stage 2 "discuss" has no time limit and ends when both participants click Done \(at most 60m\); Done unlocks once that person has sent 2 messages\./);

  const rows = parseCsv('id,cond,topic,arrival_s\np1,short,food,0\np2,open,food,1\np3,short,food,2\np4,open,food,3\n');
  assert.match(formatSimulation(simulate(untimed, rows)), /MATCH +\[short\] p1 \+ p3[\s\S]*MATCH +\[open\] p2 \+ p4/);
  const twoRows = parseCsv('id,cond,party,arrival_s\np1,cross,Democrat,0\np2,cross,Republican,1\n');
  assert.match(formatSimulation(simulate(loadConfig(gallery('09-two-stage.yaml')), twoRows)), /p1 sees: "Your partner is a Republican\."/);
});

test('qualtrics generator: one chat question per Qualtrics stage, per-stage embedded data, and a staged QSF', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'syncchat-q-stages-'));
  try {
    const config = loadConfig(gallery('09-two-stage.yaml'));
    const files = generateQualtrics(config, { url: 'https://my-study.onrender.com', outDir: out });
    assert.deepStrictEqual(files.map((f) => path.basename(f)).sort(),
      ['CHECKLIST.md', 'chat-question-2.js', 'chat-question.html', 'chat-question.js', 'syncchat_template.qsf']);
    const read = (n) => fs.readFileSync(path.join(out, n), 'utf8');
    const first = read('chat-question.js');
    const second = read('chat-question-2.js');
    assert.doesNotMatch(first, /PARAMS\.stage/);
    assert.match(first, /d\.type === "stage_ended"[\s\S]*qEngine\.clickNextButton\(\)/);
    assert.match(second, /var STAGE = \{"cross":"discuss"\}\[PARAMS\["cond"\]\];/);
    assert.match(second, /"\$\{e:\/\/Field\/chat_outcome\}" !== ""/);
    assert.match(read('CHECKLIST.md'), /One chat block per stage[\s\S]*`chat-question-2\.js`.*stage `discuss`/);

    const qsf = JSON.parse(read('syncchat_template.qsf'));
    const el = (kind) => qsf.SurveyElements.filter((e) => e.Element === kind);
    const flow = el('FL')[0].Payload.Flow;
    const ed = flow[0].EmbeddedData.map((e) => e.Field);
    for (const f of ['chat_intro_end_reason', 'chat_intro_message_count', 'chat_intro_met_min_messages',
      'chat_discuss_end_reason', 'chat_discuss_message_count', 'chat_discuss_met_min_messages']) assert.ok(ed.includes(f), f);
    const blocks = Object.values(el('BL')[0].Payload);
    const byId = Object.fromEntries(blocks.map((b) => [b.ID, b]));
    assert.deepStrictEqual(flow.filter((x) => x.Type === 'Standard').map((x) => byId[x.ID].Description),
      ['Chat', 'Between stages 1', 'Chat 2', 'After the chat']);
    const qs = Object.fromEntries(el('SQ').map((q) => [q.Payload.DataExportTag, q.Payload]));
    assert.strictEqual(qs.chat.QuestionJS, first);
    assert.strictEqual(qs.chat_2.QuestionJS, second);
    assert.ok(!qs.between_1.QuestionJS);
    assert.strictEqual(el('QC')[0].SecondaryAttribute, '4');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});


test('gallery documents timing and stages: settings, annotated YAML with explain output, and the Qualtrics stage blocks', () => {
  const { renderGallery } = require('../src/gallery');
  const { loadStudyDir } = require('../src/config');
  const html = renderGallery(loadStudyDir(path.join(root, 'examples', 'gallery')));
  const conf = html.slice(html.indexOf('<section id="configuration"'), html.indexOf('<section id="setup"'));
  for (const k of ['conditions.&lt;name&gt;.timing', 'conditions.&lt;name&gt;.stages', 'timing.end_when', 'timing.max_duration',
    'timing.extend_until_min', 'timing.rejoin_timeout', 'stages', 'stages[].id', 'stages[].prompt', 'stages[].reveal', 'stages[].then']) {
    assert.ok(conf.includes(`<td><code>${k}</code></td>`), k);
  }
  assert.match(conf, /<h2>Timing and stages<\/h2>/);
  assert.match(conf, /Stage 1 &quot;intro&quot; lasts 3m/);
  const setup = html.slice(html.indexOf('<section id="setup"'));
  assert.match(setup, /<b>one chat block per stage<\/b>/);
  assert.match(setup, /all five tables/);
});
