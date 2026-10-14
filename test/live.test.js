'use strict';
// Optional smoke test against a deployed gallery (STUDY_CONFIG=examples/gallery). Skipped unless LIVE_URL is set:
//   LIVE_URL=https://syncchat-demo.onrender.com node --test test/live.test.js
const test = require('node:test');
const assert = require('node:assert');
const { matches, nonMatches, join } = require('./gallery-cases');

const url = process.env.LIVE_URL;
const opts = { skip: !url };
const tag = () => `live-${Math.random().toString(36).slice(2, 8)}`;
// Connect like a top-level browser tab on the app's own origin.
const joinLive = (params) => join(url, params, { origin: new URL(url).origin });

test('live: gallery lists all 7 studies', opts, async () => {
  const health = await (await fetch(`${url}/healthz`)).json();
  assert.strictEqual(health.ok, true);
  const html = await (await fetch(`${url}/`)).text();
  assert.strictEqual(html.match(/<article class="card"/g).length, 7);
});

for (const c of matches) {
  test(`live: ${c.study} pairs a compatible pair with the right reveal`, opts, async () => {
    const t = tag();
    const a = joinLive({ study: c.study, id: `a-${t}`, ...c.a });
    await a.next('waiting');
    const b = joinLive({ study: c.study, id: `b-${t}`, ...c.b });
    try {
      const [ma, mb] = await Promise.all([a.next('matched'), b.next('matched')]);
      assert.deepStrictEqual([ma.reveal, mb.reveal], c.reveal);
      const got = b.next('message');
      a.socket.emit('message', 'hello from A');
      assert.strictEqual((await got).text, 'hello from A');
    } finally {
      a.socket.close();
      b.socket.close();
    }
  });
}

for (const c of nonMatches) {
  test(`live: ${c.study} keeps an incompatible pair waiting`, opts, async () => {
    const t = tag();
    const a = joinLive({ study: c.study, id: `a-${t}`, ...c.a });
    const b = joinLive({ study: c.study, id: `b-${t}`, ...c.b });
    try {
      await Promise.all([a.next('waiting'), b.next('waiting')]);
      await new Promise((r) => setTimeout(r, 3000));
      assert.strictEqual(a.seen('matched') + b.seen('matched'), 0);
    } finally {
      a.socket.close();
      b.socket.close();
    }
  });
}
