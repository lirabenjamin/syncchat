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

test('live: gallery lists all 9 studies', opts, async () => {
  const health = await (await fetch(`${url}/healthz`)).json();
  assert.strictEqual(health.ok, true);
  const html = await (await fetch(`${url}/`)).text();
  assert.strictEqual(html.match(/<article class="card"/g).length, 9);
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

test('live: untimed-min-messages ends when both click Done after 3 messages each', opts, async () => {
  const t = tag();
  const a = joinLive({ study: 'untimed-min-messages', id: `a-${t}`, cond: 'open', topic: 'food' });
  await a.next('waiting');
  const b = joinLive({ study: 'untimed-min-messages', id: `b-${t}`, cond: 'open', topic: 'music' });
  try {
    const [ma] = await Promise.all([a.next('matched'), b.next('matched')]);
    assert.deepStrictEqual([ma.stage.end_when, ma.stage.min_messages, ma.ends_at], ['both_done', 3, null]);
    for (const p of [a, b]) {
      for (let i = 0; i < 3; i++) {
        const got = Promise.all([a.next('message'), b.next('message')]);
        p.socket.emit('message', `message ${i}`);
        await got;
      }
    }
    a.socket.emit('done');
    await b.next('doneUpdate');
    b.socket.emit('done');
    const [ea, eb] = await Promise.all([a.next('chatEnded'), b.next('chatEnded')]);
    assert.deepStrictEqual([ea.outcome, ea.end_reason, ea.met_min_messages, eb.met_min_messages], ['completed', 'both_done', true, true]);
  } finally {
    a.socket.close();
    b.socket.close();
  }
});

// The /demo interstitial's "Continue to stage 2" reloads the chat page with stage=discuss and the same id.
test('live: two-stage rejoins the same partner after the Qualtrics interstitial', { ...opts, timeout: 300000 }, async () => {
  const t = tag();
  const params = (id, party, extra = {}) => ({ study: 'two-stage', id, party, ...extra });
  const a = joinLive(params(`a-${t}`, 'Democrat'));
  await a.next('waiting');
  const b = joinLive(params(`b-${t}`, 'Republican'));
  const later = [];
  try {
    const [ma] = await Promise.all([a.next('matched'), b.next('matched')]);
    assert.strictEqual(ma.stage.id, 'intro');
    const got = b.next('message');
    a.socket.emit('message', 'hello in stage 1');
    await got;
    const [sa] = await Promise.all([a.next('stageEnded', 200000), b.next('stageEnded', 200000)]);
    assert.deepStrictEqual([sa.stage, sa.next_stage, sa.end_reason], ['intro', 'discuss', 'timer']);
    const a2 = joinLive(params(`a-${t}`, 'Democrat', { stage: 'discuss' }));
    later.push(a2);
    await a2.next('waitingPartner');
    const b2 = joinLive(params(`b-${t}`, 'Republican', { stage: 'discuss' }));
    later.push(b2);
    const [ca, cb] = await Promise.all([a2.next('chatState'), b2.next('chatState')]);
    assert.strictEqual(ca.match_id, ma.match_id);
    assert.strictEqual(ca.stage.id, 'discuss');
    assert.deepStrictEqual(cb.transcript.map((m) => m.text), ['hello in stage 1']);
    for (const p of [a2, b2]) {
      for (let i = 0; i < 2; i++) {
        const both = Promise.all([a2.next('message'), b2.next('message')]);
        p.socket.emit('message', `stage 2 message ${i}`);
        await both;
      }
    }
    a2.socket.emit('done');
    b2.socket.emit('done');
    const [ea] = await Promise.all([a2.next('chatEnded'), b2.next('chatEnded')]);
    assert.deepStrictEqual([ea.outcome, ea.stage, ea.end_reason], ['completed', 'discuss', 'both_done']);
  } finally {
    for (const p of [a, b, ...later]) p.socket.close();
  }
});
