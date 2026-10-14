'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig, validateConfig } = require('../src/config');
const { createStorage } = require('../src/storage');
const { createApp } = require('../src/app');
const { renderDemo } = require('../src/demo');

test('demo form is built from fields and conditions', () => {
  const html = renderDemo(loadConfig(path.join(__dirname, '..', 'examples', 'demo.yaml')));
  for (const o of ['coffee', 'hiking', 'cooking', 'jazz', 'soccer', 'travel', 'reading', 'movies']) {
    assert.match(html, new RegExp(`class="chip" data-value="${o}"`));
  }
  assert.match(html, /data-pick="3"/);
  assert.match(html, /type="hidden" name="cond" value="shared"/); // one condition -> hidden

  const multi = renderDemo(validateConfig({
    study: { id: 'm' },
    participant: { fields: {
      party: { type: 'category', values: ['Democrat', 'Republican'] },
      age: { type: 'number' },
      likes: { type: 'list' },
    } },
    conditions: { same: { require: [{ same: 'party' }] }, cross: { require: [{ differ: 'party' }] } },
    timing: { match_timeout: '10s', chat_duration: '1m' },
    embed: { allowed_origins: ['https://*.qualtrics.com'] },
  }));
  assert.match(multi, /<select id="f-party" name="party" required>.*Democrat.*Republican/);
  assert.match(multi, /name="age" type="number"/);
  assert.match(multi, /name="likes" type="text"/); // list without options -> free text
  assert.match(multi, /<select id="f-cond" name="cond"><option value="same">same<\/option><option value="cross">/);
});

test('GET /demo serves the form and / with no params redirects to it', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncchat-demo-'));
  const config = loadConfig(path.join(__dirname, '..', 'examples', 'demo.yaml'));
  const storage = await createStorage({ dataDir, studyId: config.study.id });
  const app = createApp({ config, storage, log: () => {} });
  const url = `http://127.0.0.1:${await app.listen(0)}`;
  try {
    const demo = await fetch(`${url}/demo`);
    assert.strictEqual(demo.status, 200);
    assert.match(await demo.text(), /data-value="jazz"/);
    const root = await fetch(`${url}/`, { redirect: 'manual' });
    assert.strictEqual(root.status, 302);
    assert.strictEqual(root.headers.get('location'), '/demo');
    const chat = await fetch(`${url}/?id=a&cond=shared&top3=jazz`);
    assert.strictEqual(chat.status, 200);
    assert.match(await chat.text(), /Finding a conversation partner/);
  } finally {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
