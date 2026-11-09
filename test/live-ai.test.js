'use strict';
// Optional live smoke test of the real model call with a cheap model. Skipped unless a key is set:
//   ANTHROPIC_API_KEY=... node --test test/live-ai.test.js     (or OPENAI_API_KEY=...)
const test = require('node:test');
const assert = require('node:assert');
const { validateConfig } = require('../src/config');
const { callModel } = require('../src/ai');

const provider = process.env.ANTHROPIC_API_KEY ? 'anthropic' : process.env.OPENAI_API_KEY ? 'openai' : null;

test('live: one real reply from a cheap model', { skip: !provider, timeout: 60000 }, async () => {
  const config = validateConfig({
    study: { id: 'live-ai' },
    participant: { fields: { party: { type: 'category' } } },
    conditions: {
      bot: {
        partner: 'ai',
        ai: {
          provider,
          model: provider === 'anthropic' ? 'claude-haiku-5-5' : 'gpt-5-mini',
          system_prompt: 'You are chatting with a {party}. Reply in one short sentence.',
          max_tokens: 400,
        },
      },
    },
    timing: { match_timeout: '10s', chat_duration: '1m' },
    embed: { allowed_origins: ['https://*.qualtrics.com'] },
  });
  const res = await callModel(config.conditions.bot.ai, {
    system: 'You are chatting with a Democrat. Reply in one short sentence.',
    messages: [{ from: {}, text: 'Hi! What do you think about taxes?' }],
  });
  assert.ok(res.text.length > 0);
  assert.ok(res.usage.output_tokens > 0);
});
