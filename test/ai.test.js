'use strict';
// AI partner: config validation, prompt variables, the provider request format, the runtime with
// the model call mocked, and the Qualtrics/explain/simulate output for examples/ai-partner.yaml.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io: connect } = require('socket.io-client');
const { loadConfig, validateConfig, ConfigError } = require('../src/config');
const { promptVars, renderPrompt, promptValues, toTurns, callModel } = require('../src/ai');
const { createStorage } = require('../src/storage');
const { createApp } = require('../src/app');
const { explainConfig } = require('../src/explain');
const { simulate, formatSimulation } = require('../src/simulate');
const { generateQualtrics } = require('../src/qualtrics');

const root = path.join(__dirname, '..');

// A minimal valid study with an AI condition; `edit` changes the raw YAML object before validation.
function raw(edit = () => {}) {
  const r = {
    study: { id: 'aitest' },
    participant: { fields: { party: { type: 'category', values: ['Democrat', 'Republican'] }, top3: { type: 'list' } } },
    conditions: {
      human: { require: [{ differ: 'party' }] },
      bot: {
        partner: 'ai',
        ai: {
          system_prompt: 'You chat with a {party} who likes {top3}. They wrote: "{prior}".',
          opening_message: 'Hi! I hear you are a {party}.',
          vars: ['prior'],
          reply_delay: { min: '0s', max: '0s' },
        },
      },
    },
    timing: { match_timeout: '300ms', chat_duration: '20s' },
    embed: { allowed_origins: ['https://*.qualtrics.com'] },
  };
  edit(r);
  return r;
}
const valid = (edit) => validateConfig(raw(edit), { baseDir: path.join(root, 'examples') });
function expectError(edit, pattern) {
  assert.throws(() => valid(edit), (e) => e instanceof ConfigError && e.errors.some((m) => pattern.test(m)),
    `expected an error matching ${pattern}`);
}

test('ai config: defaults, vars as a list or a mapping, prompt from a file', () => {
  const ai = valid().conditions.bot.ai;
  assert.strictEqual(ai.provider, 'anthropic');
  assert.strictEqual(ai.model, 'claude-sonnet-5-5');
  assert.strictEqual(ai.api_key_env, 'ANTHROPIC_API_KEY');
  assert.deepStrictEqual(ai.vars, { prior: '${e://Field/prior}' });
  assert.deepStrictEqual(ai.uses, ['party', 'top3', 'prior']);
  assert.deepStrictEqual([ai.max_turns, ai.max_tokens, ai.missing_vars, ai.effort, ai.temperature], [20, 1000, 'error', 'low', null]);
  assert.strictEqual(valid().conditions.human.ai, null, 'no ai for a human condition without on_timeout: bot');

  const c = loadConfig(path.join(root, 'examples', 'ai-partner.yaml'));
  assert.match(c.conditions.ai.ai.system_prompt, /^You are taking part in a research study/);
  assert.strictEqual(c.conditions.ai.ai.system_prompt_file, 'prompts/outgroup.md');
  assert.deepStrictEqual(c.conditions.ai.ai.vars, { issue_text: '${q://QID5/ChoiceTextEntryValue}' });
  assert.ok(c.conditions.human.ai, 'on_timeout: bot gives the human condition the fallback AI');

  const oa = valid((r) => Object.assign(r.conditions.bot.ai, { provider: 'openai', temperature: 0.7, effort: null }));
  assert.deepStrictEqual([oa.conditions.bot.ai.model, oa.conditions.bot.ai.api_key_env, oa.conditions.bot.ai.temperature], ['gpt-5-mini', 'OPENAI_API_KEY', 0.7]);
  // A top-level ai block, overridden per condition.
  const top = valid((r) => { r.ai = { ...r.conditions.bot.ai, max_turns: 5 }; r.conditions.bot.ai = { max_turns: 7 }; r.on_timeout = 'bot'; });
  assert.deepStrictEqual([top.conditions.bot.ai.max_turns, top.conditions.human.ai.max_turns], [7, 5]);
});

test('ai config: clear errors', () => {
  expectError((r) => { delete r.conditions.bot.ai.system_prompt; }, /system_prompt: is missing/);
  expectError((r) => { r.conditions.bot.ai.system_prompt = 'prompts/nope.md'; }, /file not found: prompts\/nope.md/);
  expectError((r) => { r.conditions.bot.ai.system_prompt += ' {age}'; }, /placeholder \{age\} is not a field or a declared var/);
  expectError((r) => { r.conditions.bot.ai.vars.push('unused'); }, /"unused" is not used/);
  expectError((r) => { r.conditions.bot.ai.vars.push('party'); }, /"party" is already a field/);
  expectError((r) => { r.conditions.bot.ai.vars.push('study'); }, /"study" is reserved/);
  expectError((r) => { r.conditions.bot.ai.temperature = 0.5; }, /current Claude models reject temperature/);
  expectError((r) => { r.conditions.bot.ai.provider = 'gemini'; }, /provider: must be one of anthropic, openai, openrouter/);
  expectError((r) => { r.conditions.bot.ai.provider = 'openrouter'; }, /model: is missing \(openrouter has no default model\)/);
  expectError((r) => { r.conditions.bot.ai.api_key_env = 'sk-ant-abc123'; }, /NAME of an environment variable/);
  expectError((r) => { r.conditions.bot.ai.mdoel = 'x'; }, /ai.mdoel: unknown key/);
  expectError((r) => { r.conditions.bot.ai.missing_vars = 'skip'; }, /missing_vars: must be error or empty/);
  expectError((r) => { r.conditions.bot.ai.reply_delay = { min: '5s', max: '1s' }; }, /min must not exceed max/);
  expectError((r) => { r.conditions.bot.require = [{ same: 'party' }]; }, /partner: ai has no matching rules/);
  expectError((r) => { r.conditions.bot.reveal = 'Your partner is a {partner.party}'; }, /AI partner has no fields/);
  expectError((r) => { delete r.conditions.bot.ai; }, /conditions.bot.ai: is missing/);
  expectError((r) => { r.conditions.human.ai = r.conditions.bot.ai; }, /conditions.human.ai: only applies with partner: ai/);
  expectError((r) => { r.ai = r.conditions.bot.ai; delete r.conditions.bot; }, /^ai: only applies/);
  expectError((r) => {
    r.conditions.bot.stages = [{ id: 'a', chat_duration: '1m', then: 'qualtrics' }, { id: 'b', chat_duration: '1m' }];
  }, /then: qualtrics is not supported yet/);
  expectError((r) => {
    r.on_timeout = 'bot';
    r.conditions.human.ai = { ...r.conditions.bot.ai, vars: { prior: '${q://QID9/ChoiceTextEntryValue}' } };
  }, /"prior" is piped from/);
  expectError((r) => { r.on_timeout = 'robot'; }, /on_timeout: must be nomatch or bot/);
});

test('prompt variables: placeholders, rendering, values, turns', () => {
  assert.deepStrictEqual(promptVars('Hi {party}, { prior } and {"json": 1} {party}'), ['party', 'prior']);
  assert.strictEqual(renderPrompt('A {party} said {prior}. {"k": 1} {other}', { party: 'Democrat', prior: 'x' }),
    'A Democrat said x. {"k": 1} {other}');
  const ai = valid().conditions.bot.ai;
  const { values, missing } = promptValues(ai, { prior: `  "quoted"\nline\u0007 ${'z'.repeat(2000)}` }, { party: 'Republican', top3: ['jazz', 'chess'] });
  assert.strictEqual(values.top3, 'jazz and chess');
  assert.ok(values.prior.startsWith('"quoted"\nline z'), 'keeps quotes and line breaks, drops control characters');
  assert.strictEqual(values.prior.length, 1000, 'capped at max_var_length');
  assert.deepStrictEqual(missing, []);
  assert.deepStrictEqual(promptValues(ai, {}, { party: null, top3: [] }).missing, ['party', 'top3', 'prior']);

  const human = {};
  const bot = { bot: true };
  assert.deepStrictEqual(toTurns([{ from: bot, text: 'hi' }, { from: human, text: 'hello' }]),
    [{ role: 'user', content: '[The participant joined the chat.]' }, { role: 'assistant', content: 'hi' }, { role: 'user', content: 'hello' }]);
});

test('callModel: request format per provider; the key goes only in a header', async () => {
  const realFetch = global.fetch;
  const seen = [];
  global.fetch = async (url, opts) => {
    seen.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
    const anthropic = url.includes('anthropic');
    return {
      ok: true,
      json: async () => (anthropic
        ? { model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: ' Hello! ' }], usage: { input_tokens: 12, output_tokens: 3 } }
        : { model: 'gpt-5-mini', choices: [{ message: { content: 'Hey' } }], usage: { prompt_tokens: 9, completion_tokens: 2 } }),
    };
  };
  process.env.SYNCCHAT_TEST_KEY = 'sk-test-secret-123';
  try {
    const msgs = [{ from: {}, text: 'hi' }];
    const a = { ...valid().conditions.bot.ai, api_key_env: 'SYNCCHAT_TEST_KEY' };
    const ra = await callModel(a, { system: 'SYS', messages: msgs });
    assert.deepStrictEqual(ra, { text: 'Hello!', model: 'claude-sonnet-5-5', usage: { input_tokens: 12, output_tokens: 3 } });
    assert.strictEqual(seen[0].url, 'https://api.anthropic.com/v1/messages');
    assert.strictEqual(seen[0].headers['x-api-key'], 'sk-test-secret-123');
    assert.strictEqual(seen[0].headers['anthropic-version'], '2023-06-01');
    assert.deepStrictEqual([seen[0].body.system, seen[0].body.max_tokens, seen[0].body.output_config, seen[0].body.temperature],
      ['SYS', 1000, { effort: 'low' }, undefined]);
    assert.deepStrictEqual(seen[0].body.messages, [{ role: 'user', content: 'hi' }]);

    const o = { ...valid((r) => Object.assign(r.conditions.bot.ai, { provider: 'openai', temperature: 0.4 })).conditions.bot.ai, api_key_env: 'SYNCCHAT_TEST_KEY' };
    const ro = await callModel(o, { system: 'SYS', messages: msgs });
    assert.deepStrictEqual(ro.usage, { input_tokens: 9, output_tokens: 2 });
    assert.strictEqual(seen[1].headers.authorization, 'Bearer sk-test-secret-123');
    assert.deepStrictEqual(seen[1].body.messages, [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hi' }]);
    assert.deepStrictEqual([seen[1].body.max_completion_tokens, seen[1].body.temperature, seen[1].body.reasoning_effort], [1000, 0.4, 'low']);
    for (const s of seen) assert.ok(!JSON.stringify(s.body).includes('sk-test-secret'), 'key is not in the body');

    global.fetch = async () => ({ ok: false, status: 401, statusText: 'Unauthorized', json: async () => ({ error: { message: 'invalid x-api-key' } }) });
    await assert.rejects(callModel(a, { system: 'S', messages: msgs }), (e) => /HTTP 401/.test(e.message) && !e.retry && !e.message.includes('sk-test'));
    await assert.rejects(callModel({ ...a, api_key_env: 'SYNCCHAT_NOT_SET' }, { system: 'S', messages: msgs }),
      /environment variable SYNCCHAT_NOT_SET is not set/);
  } finally {
    global.fetch = realFetch;
    delete process.env.SYNCCHAT_TEST_KEY;
  }
});

// ---- runtime, with the model call mocked ----

function startServer(config, callModel) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncchat-ai-'));
  const logs = [];
  return createStorage({ dataDir, studyId: config.study.id }).then(async (storage) => {
    const app = createApp({ config, storage, log: (l) => logs.push(l), callModel });
    const url = `http://127.0.0.1:${await app.listen(0)}`;
    const clients = [];
    const read = (kind) => (fs.existsSync(path.join(dataDir, `${kind}.jsonl`))
      ? fs.readFileSync(path.join(dataDir, `${kind}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
    function join(params) {
      const socket = connect(url, { transports: ['websocket'], forceNew: true });
      clients.push(socket);
      const queues = {};
      for (const ev of ['waiting', 'matched', 'noMatch', 'joinError', 'message', 'chatEnded']) {
        queues[ev] = [];
        socket.on(ev, (p) => queues[ev].push(p));
      }
      socket.on('connect', () => socket.emit('join', params));
      const next = (ev, ms = 3000) => new Promise((resolve, reject) => {
        const start = Date.now();
        (function poll() {
          if (queues[ev].length) return resolve(queues[ev].shift());
          if (Date.now() - start > ms) return reject(new Error(`timed out waiting for ${ev}`));
          setTimeout(poll, 10);
        })();
      });
      return { socket, next, seen: (ev) => queues[ev].length };
    }
    const stop = async () => {
      for (const c of clients) c.close();
      await app.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    };
    return { url, join, read, logs, stop };
  });
}

const echo = (calls = []) => async (ai, req) => {
  calls.push(req);
  return { text: `echo: ${req.messages[req.messages.length - 1].text}`, model: 'fake-model-1', usage: { input_tokens: 20, output_tokens: 5 } };
};

test('AI condition: rendered opening message, a mocked reply, stored prompt, sender, model, and usage', async () => {
  const calls = [];
  const s = await startServer(valid(), echo(calls));
  try {
    const p = s.join({ id: 'p1', cond: 'bot', party: 'Democrat', top3: 'jazz,chess', prior: 'Taxes are "too high".' });
    const m = await p.next('matched');
    assert.strictEqual(p.seen('waiting'), 0, 'no waiting room');
    assert.deepStrictEqual([m.partner_id, m.reveal], ['ai', null]);
    const opening = await p.next('message');
    assert.deepStrictEqual([opening.mine, opening.text], [false, 'Hi! I hear you are a Democrat.']);
    p.socket.emit('message', 'Hello bot');
    assert.strictEqual((await p.next('message')).text, 'Hello bot');
    const reply = await p.next('message');
    assert.deepStrictEqual([reply.mine, reply.text], [false, 'echo: Hello bot']);
    assert.strictEqual(calls[0].system, 'You chat with a Democrat who likes jazz and chess. They wrote: "Taxes are "too high".".');
    assert.deepStrictEqual(calls[0].messages.map((x) => x.text), ['Hi! I hear you are a Democrat.', 'Hello bot']);

    const match = s.read('matches').find((x) => x.participant_ids.includes('p1'));
    assert.deepStrictEqual([match.partner, match.ai_fallback, match.participant_ids], ['ai', false, ['p1', 'ai']]);
    assert.strictEqual(match.ai.system_prompt, calls[0].system, 'the rendered prompt is stored with the conversation');
    assert.deepStrictEqual(match.ai.vars, { party: 'Democrat', top3: 'jazz and chess', prior: 'Taxes are "too high".' });
    assert.deepStrictEqual(s.read('arrivals').find((x) => x.participant_id === 'p1').prompt_vars, { prior: 'Taxes are "too high".' });
    const msgs = s.read('messages').filter((x) => x.match_id === match.match_id);
    assert.deepStrictEqual(msgs.map((x) => [x.participant_id, x.sender]), [['ai', 'ai'], ['p1', 'participant'], ['ai', 'ai']]);
    assert.deepStrictEqual([msgs[2].model, msgs[2].usage], ['fake-model-1', { input_tokens: 20, output_tokens: 5 }]);

    p.socket.close();
    await new Promise((r) => setTimeout(r, 100));
    const out = s.read('outcomes').find((x) => x.participant_id === 'p1');
    assert.deepStrictEqual([out.outcome, out.partner, out.message_count], ['left', 'ai', 1]);
    assert.ok(!s.read('outcomes').some((x) => x.participant_id === 'ai'), 'no outcome record for the AI');
  } finally {
    await s.stop();
  }
});

test('AI condition: missing prompt var fails the join; missing_vars: empty fills a blank', async () => {
  const s = await startServer(valid(), echo());
  try {
    const e = await s.join({ id: 'm1', cond: 'bot', party: 'Democrat', top3: 'jazz' }).next('joinError');
    assert.strictEqual(e.code, 'missing_var');
    assert.match(e.message, /"prior"/);
  } finally {
    await s.stop();
  }
  const s2 = await startServer(valid((r) => { r.conditions.bot.ai.missing_vars = 'empty'; }), echo());
  try {
    const p = s2.join({ id: 'm2', cond: 'bot', party: 'Democrat', top3: 'jazz' });
    await p.next('matched');
    assert.strictEqual(s2.read('matches')[0].ai.system_prompt, 'You chat with a Democrat who likes jazz. They wrote: "".');
  } finally {
    await s2.stop();
  }
});

test('AI condition: a failed model call ends the chat with ai_error; the key never reaches the client or the logs', async () => {
  process.env.SYNCCHAT_TEST_KEY = 'sk-test-secret-456';
  let n = 0;
  const failing = async (ai) => {
    n += 1;
    const e = new Error(`HTTP 500: overloaded (key ${process.env[ai.api_key_env] ? 'present' : 'absent'})`);
    e.retry = true;
    throw e;
  };
  const s = await startServer(valid((r) => { r.conditions.bot.ai.api_key_env = 'SYNCCHAT_TEST_KEY'; }), failing);
  try {
    const p = s.join({ id: 'f1', cond: 'bot', party: 'Republican', top3: 'chess', prior: 'x' });
    const m = await p.next('matched');
    await p.next('message');
    p.socket.emit('message', 'hello?');
    await p.next('message');
    const end = await p.next('chatEnded', 5000);
    assert.deepStrictEqual([end.outcome, end.end_reason, end.partner, end.message_count], ['ai_error', 'ai_error', 'ai', 1]);
    assert.strictEqual(n, 2, 'one retry on a retryable error');
    const cfg = await (await fetch(`${s.url}/client-config.json`)).text();
    for (const text of [JSON.stringify(m), JSON.stringify(end), cfg, s.logs.join('\n'), ...['arrivals', 'matches', 'messages', 'outcomes'].map((k) => JSON.stringify(s.read(k)))]) {
      assert.ok(!text.includes('sk-test-secret'), 'no API key anywhere');
    }
    assert.ok(s.logs.some((l) => /\[ai_error\]/.test(l)));
  } finally {
    await s.stop();
    delete process.env.SYNCCHAT_TEST_KEY;
  }
});

test('AI condition: max_turns ends the chat as completed; budget_tokens fails closed with ai_budget_exhausted', { timeout: 15000 }, async () => {
  const s = await startServer(valid((r) => Object.assign(r.conditions.bot.ai, { max_turns: 1, budget_tokens: 10, opening_message: null })), echo());
  try {
    const p = s.join({ id: 't1', cond: 'bot', party: 'Democrat', top3: 'jazz', prior: 'x' });
    await p.next('matched');
    p.socket.emit('message', 'one');
    await p.next('message');
    assert.strictEqual((await p.next('message')).text, 'echo: one');
    p.socket.emit('message', 'two');
    await p.next('message');
    const end = await p.next('chatEnded', 8000);
    assert.deepStrictEqual([end.outcome, end.end_reason, end.message_count], ['completed', 'max_turns', 2]);
    // 25 tokens spent, budget 10: the next participant cannot start.
    const q = s.join({ id: 't2', cond: 'bot', party: 'Democrat', top3: 'jazz', prior: 'x' });
    const e2 = await q.next('chatEnded');
    assert.strictEqual(e2.outcome, 'ai_budget_exhausted');
    assert.strictEqual(q.seen('matched'), 0);
  } finally {
    await s.stop();
  }
});

test('on_timeout: bot pairs an unmatched participant with the AI, without the human reveal', async () => {
  const config = valid((r) => {
    r.on_timeout = 'bot';
    r.ai = r.conditions.bot.ai;
    delete r.conditions.bot.ai;
    r.conditions.human.reveal = 'Your partner is a {partner.party}.';
  });
  const s = await startServer(config, echo());
  try {
    const p = s.join({ id: 'h1', cond: 'human', party: 'Democrat', top3: 'jazz', prior: 'x' });
    await p.next('waiting');
    const m = await p.next('matched');
    assert.deepStrictEqual([m.partner_id, m.reveal], ['ai', null]);
    assert.ok(m.waited_ms >= 250);
    assert.strictEqual((await p.next('message')).text, 'Hi! I hear you are a Democrat.');
    assert.strictEqual(s.read('matches')[0].ai_fallback, true);
    // Two compatible humans still match each other.
    const a = s.join({ id: 'h2', cond: 'human', party: 'Democrat', top3: 'jazz', prior: 'x' });
    await a.next('waiting');
    const b = s.join({ id: 'h3', cond: 'human', party: 'Republican', top3: 'jazz', prior: 'x' });
    const [ma] = await Promise.all([a.next('matched'), b.next('matched')]);
    assert.deepStrictEqual([ma.partner_id, ma.reveal], ['h3', 'Your partner is a Republican.']);
  } finally {
    await s.stop();
  }
});

test('examples/ai-partner.yaml: explain, simulate, and Qualtrics files with the prompt var in the iframe URL', () => {
  const c = loadConfig(path.join(root, 'examples', 'ai-partner.yaml'));
  const text = explainConfig(c);
  assert.match(text, /Condition "ai": each participant chats with an AI partner/);
  assert.match(text, /\{issue_text\} \(from Qualtrics: \$\{q:\/\/QID5\/ChoiceTextEntryValue\}\)/);
  assert.match(text, /chats with the AI partner described above instead/);
  const sim = formatSimulation(simulate(c, [
    { id: 'p1', cond: 'human', party: 'Democrat', arrival_s: '0' },
    { id: 'p2', cond: 'ai', party: 'Republican', arrival_s: '1' },
  ]));
  assert.match(sim, /AI {7}\[ai\] p2 \(chats with the AI partner\)/);
  assert.match(sim, /AI {7}\[human\] p1 \(waited 1m 30s, no partner; chats with the AI instead\)/);

  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'syncchat-aiq-'));
  try {
    generateQualtrics(c, { url: 'https://example.onrender.com', outDir: out });
    const js = fs.readFileSync(path.join(out, 'chat-question.js'), 'utf8');
    const html = fs.readFileSync(path.join(out, 'chat-question.html'), 'utf8');
    assert.match(js, /var VARS = \{"issue_text":1000\};/);
    assert.match(js, /PARAMS\[k\] = el \? el\.textContent\.trim\(\)\.slice\(0, VARS\[k\]\)/);
    assert.match(html, /<div id="syncchat-var-issue_text" style="display:none">\$\{q:\/\/QID5\/ChoiceTextEntryValue\}<\/div>/);
    assert.match(fs.readFileSync(path.join(out, 'CHECKLIST.md'), 'utf8'), /### AI prompt variables/);
    // Run the generated question JS against a stub page and check the iframe URL.
    const doc = { 'chat-root': { innerHTML: '' }, 'syncchat-var-issue_text': { textContent: '  Health care: "costs" & more\nline 2 ' } };
    const Qualtrics = { SurveyEngine: { addOnload: (fn) => fn.call({ hideNextButton() {}, showNextButton() {}, clickNextButton() {} }), setEmbeddedData() {} } };
    new Function('Qualtrics', 'document', 'window', js)(Qualtrics, { getElementById: (id) => doc[id] }, { addEventListener() {} });
    const src = doc['chat-root'].innerHTML.match(/src="([^"]+)"/)[1];
    const params = new URL(src).searchParams;
    assert.strictEqual(params.get('issue_text'), 'Health care: "costs" & more\nline 2');
    assert.strictEqual(params.get('study'), 'ai-partner');
    const qsf = JSON.parse(fs.readFileSync(path.join(out, 'syncchat_template.qsf'), 'utf8'));
    assert.ok(JSON.stringify(qsf).includes('syncchat-var-issue_text'));
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
