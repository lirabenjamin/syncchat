'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io: connect } = require('socket.io-client');
const { validateConfig } = require('../src/config');
const { createStorage } = require('../src/storage');
const { createApp } = require('../src/app');

const config = validateConfig({
  study: { id: 'itest', group_size: 2 },
  participant: {
    id_param: 'id',
    condition_param: 'cond',
    fields: {
      party: { type: 'category', values: ['Democrat', 'Republican'] },
      top3: { type: 'list', sep: ',' },
      age: { type: 'number' },
    },
  },
  conditions: {
    cross: {
      require: [{ differ: 'party' }, { overlap: { field: 'top3', min: 1 } }],
      prefer: [{ closest: 'age' }],
      reveal: 'You were matched because you both picked {shared.top3} in your top three.',
    },
    same: { require: [{ same: 'party' }], reveal: false },
  },
  timing: { match_timeout: '400ms', chat_duration: '5s', min_messages: 1 },
  embed: { allowed_origins: ['https://*.qualtrics.com'] },
});

let app, url, dataDir;
const clients = [];

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncchat-test-'));
  const storage = await createStorage({ dataDir, studyId: config.study.id });
  app = createApp({ config, storage, log: () => {} });
  url = `http://127.0.0.1:${await app.listen(0)}`;
});

test.after(async () => {
  for (const c of clients) c.close();
  await app.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// Connect a participant; `next(event)` resolves with the next payload of that event.
function join(params) {
  const socket = connect(url, { transports: ['websocket'], forceNew: true });
  clients.push(socket);
  const queues = {};
  for (const ev of ['waiting', 'matched', 'noMatch', 'joinError', 'message', 'chatEnded']) {
    queues[ev] = [];
    socket.on(ev, (p) => queues[ev].push(p));
  }
  socket.on('connect', () => socket.emit('join', params));
  const next = (ev, ms = 2000) => new Promise((resolve, reject) => {
    const start = Date.now();
    (function poll() {
      if (queues[ev].length) return resolve(queues[ev].shift());
      if (Date.now() - start > ms) return reject(new Error(`timed out waiting for ${ev}`));
      setTimeout(poll, 10);
    })();
  });
  return { socket, next, seen: (ev) => queues[ev].length };
}

const readJsonl = (kind) => fs.readFileSync(path.join(dataDir, `${kind}.jsonl`), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('(a) Dem + Rep with overlapping top3 match in cross and both see the reveal', async () => {
  const d = join({ id: 'a-dem', cond: 'cross', party: 'Democrat', top3: 'pizza,tacos,sushi', age: '30' });
  await d.next('waiting');
  const r = join({ id: 'a-rep', cond: 'cross', party: 'Republican', top3: 'sushi,ramen,pizza', age: '40' });
  const [md, mr] = await Promise.all([d.next('matched'), r.next('matched')]);
  assert.strictEqual(md.match_id, mr.match_id);
  assert.strictEqual(md.reveal, 'You were matched because you both picked pizza and sushi in your top three.');
  assert.strictEqual(mr.reveal, 'You were matched because you both picked sushi and pizza in your top three.');
  const match = readJsonl('matches').find((m) => m.match_id === md.match_id);
  assert.deepStrictEqual(match.participant_ids, ['a-dem', 'a-rep']);
  assert.deepStrictEqual(match.rules_satisfied, ['differ: party', 'overlap: top3']);
  assert.deepStrictEqual(match.scores, [-10]);
  assert.strictEqual(match.reveal['a-dem'], md.reveal);
  assert.strictEqual(md.partner_id, 'a-rep', 'partner_id goes to Qualtrics');
  assert.strictEqual(mr.partner_id, 'a-dem');
  assert.match(md.match_reason, /differ: party/);
  d.socket.close();
  r.socket.close();
});

test('(b) no top3 overlap means no match; both get nomatch after the timeout', async () => {
  const d = join({ id: 'b-dem', cond: 'cross', party: 'Democrat', top3: 'pizza', age: '30' });
  const r = join({ id: 'b-rep', cond: 'cross', party: 'Republican', top3: 'ramen', age: '30' });
  await Promise.all([d.next('noMatch'), r.next('noMatch')]);
  assert.strictEqual(d.seen('matched') + r.seen('matched'), 0);
  const outcomes = readJsonl('outcomes').filter((o) => o.participant_id.startsWith('b-'));
  assert.deepStrictEqual(outcomes.map((o) => o.outcome), ['nomatch', 'nomatch']);
});

test('(c) prefer closest age picks the closer of two valid waiting partners', async () => {
  const far = join({ id: 'c-far', cond: 'cross', party: 'Democrat', top3: 'chess', age: '25' });
  await far.next('waiting');
  const near = join({ id: 'c-near', cond: 'cross', party: 'Democrat', top3: 'chess', age: '58' });
  await near.next('waiting');
  const rep = join({ id: 'c-rep', cond: 'cross', party: 'Republican', top3: 'chess', age: '60' });
  const [mNear, mRep] = await Promise.all([near.next('matched'), rep.next('matched')]);
  assert.strictEqual(mNear.match_id, mRep.match_id);
  assert.strictEqual(far.seen('matched'), 0);
  await far.next('noMatch');
  near.socket.close();
  rep.socket.close();
});

test('(d) participants only match within their own condition', async () => {
  const x = join({ id: 'd-same', cond: 'same', party: 'Democrat' });
  await x.next('waiting');
  const y = join({ id: 'd-cross', cond: 'cross', party: 'Republican', top3: 'chess' });
  await Promise.all([x.next('noMatch'), y.next('noMatch')]);
  const z = join({ id: 'd-same2', cond: 'same', party: 'Democrat' });
  const w = join({ id: 'd-same3', cond: 'same', party: 'Democrat' });
  const [mz, mw] = await Promise.all([z.next('matched'), w.next('matched')]);
  assert.strictEqual(mz.match_id, mw.match_id);
  assert.strictEqual(mz.reveal, null);
  z.socket.close();
  w.socket.close();
});

test('(e) a duplicate concurrent ID is rejected; bad input is rejected', async () => {
  const first = join({ id: 'e-dup', cond: 'same', party: 'Democrat' });
  await first.next('waiting');
  const second = join({ id: 'e-dup', cond: 'same', party: 'Democrat' });
  assert.strictEqual((await second.next('joinError')).code, 'duplicate_id');
  assert.strictEqual((await join({ id: 'e-x', cond: 'nope' }).next('joinError')).code, 'unknown_condition');
  assert.strictEqual((await join({ cond: 'same' }).next('joinError')).code, 'missing_id');
  assert.strictEqual((await join({ id: 'e-y', cond: 'same', party: 'Green' }).next('joinError')).code, 'invalid_field');
  first.socket.close();
});

test('(f) messages are relayed and stored; outcomes and export work', async () => {
  const a = join({ id: 'f-a', cond: 'same', party: 'Republican' });
  const b = join({ id: 'f-b', cond: 'same', party: 'Republican' });
  const [m] = await Promise.all([a.next('matched'), b.next('matched')]);
  a.socket.emit('message', 'hello there');
  const [mineA, theirsB] = await Promise.all([a.next('message'), b.next('message')]);
  assert.deepStrictEqual([mineA.mine, mineA.text], [true, 'hello there']);
  assert.deepStrictEqual([theirsB.mine, theirsB.text], [false, 'hello there']);
  b.socket.emit('message', 'x'.repeat(5000));
  assert.strictEqual((await a.next('message')).text.length, config.limits.max_message_length);

  a.socket.close();
  const ended = await b.next('chatEnded');
  assert.strictEqual(ended.outcome, 'partner_left');
  assert.strictEqual(ended.message_count, 1);

  const stored = readJsonl('messages').filter((x) => x.match_id === m.match_id);
  assert.deepStrictEqual(stored.map((x) => [x.participant_id, x.seq]), [['f-a', 1], ['f-b', 2]]);
  assert.strictEqual(stored[0].text, 'hello there');
  const outcomes = readJsonl('outcomes').filter((o) => o.match_id === m.match_id);
  assert.deepStrictEqual(outcomes.map((o) => [o.participant_id, o.outcome]).sort(), [['f-a', 'left'], ['f-b', 'partner_left']]);

  process.env.ADMIN_TOKEN = 'test-token';
  assert.strictEqual((await fetch(`${url}/export?token=wrong`)).status, 403);
  const all = await (await fetch(`${url}/export?token=test-token`)).json();
  assert.ok(all.messages.some((x) => x.text === 'hello there'));
  const csv = await (await fetch(`${url}/export?token=test-token&format=csv&table=messages`)).text();
  assert.match(csv.split('\n')[0], /match_id/);
  delete process.env.ADMIN_TOKEN;
});

test('healthz, framing policy, and cross-origin socket rejection', async () => {
  const res = await fetch(`${url}/healthz`);
  assert.strictEqual((await res.json()).ok, true);
  assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'self' https:\/\/\*\.qualtrics\.com/);
  const bad = await fetch(`${url}/socket.io/?EIO=4&transport=polling`, { headers: { Origin: 'https://evil.example.com' } });
  assert.strictEqual(bad.status, 403);
  const good = await fetch(`${url}/socket.io/?EIO=4&transport=polling`, { headers: { Origin: 'https://upenn.qualtrics.com' } });
  assert.strictEqual(good.status, 200);
});
