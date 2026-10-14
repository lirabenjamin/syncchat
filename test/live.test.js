'use strict';
// Optional smoke test against a deployed demo (examples/demo.yaml). Skipped unless LIVE_URL is set:
//   LIVE_URL=https://syncchat-demo.onrender.com node --test test/live.test.js
const test = require('node:test');
const assert = require('node:assert');
const { io: connect } = require('socket.io-client');

const url = process.env.LIVE_URL;

// Connect like a top-level browser tab on the app's own origin.
function join(params) {
  const socket = connect(url, { forceNew: true, extraHeaders: { origin: new URL(url).origin } });
  const once = (ev) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out waiting for ${ev}`)), 20000);
    socket.once(ev, (p) => { clearTimeout(t); resolve(p); });
  });
  socket.on('connect', () => socket.emit('join', params));
  return { socket, once };
}

test('live: pair, reveal, message, then a lone participant waits', { skip: !url }, async () => {
  const tag = Math.random().toString(36).slice(2, 8);
  const health = await (await fetch(`${url}/healthz`)).json();
  assert.strictEqual(health.ok, true);
  const demo = await fetch(`${url}/demo`);
  assert.strictEqual(demo.status, 200);
  assert.match(await demo.text(), /data-value="jazz"/);

  const a = join({ id: `live-a-${tag}`, cond: 'shared', top3: 'jazz,hiking,coffee' });
  const b = join({ id: `live-b-${tag}`, cond: 'shared', top3: 'jazz,soccer,movies' });
  const [ma, mb] = await Promise.all([a.once('matched'), b.once('matched')]);
  for (const m of [ma, mb]) assert.strictEqual(m.reveal, 'You were matched because you both picked jazz.');
  assert.match(ma.intro, /what do you love/);

  const got = b.once('message');
  a.socket.emit('message', 'hello from A');
  assert.deepStrictEqual(await got.then((m) => [m.mine, m.text]), [false, 'hello from A']);

  const c = join({ id: `live-c-${tag}`, cond: 'shared', top3: 'reading,travel,cooking' });
  const w = await c.once('waiting');
  assert.ok(w.timeout_at > Date.now());
  for (const p of [a, b, c]) p.socket.close();
});
