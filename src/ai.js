'use strict';

// AI chat partners: prompt variables, and the model call. The server makes every call; the API key
// is read from the environment variable named in `ai.api_key_env` and never leaves the server.

const { formatList } = require('./reveal');

const PROVIDERS = {
  anthropic: { url: 'https://api.anthropic.com/v1/messages', key: 'ANTHROPIC_API_KEY', model: 'claude-sonnet-5-5', effort: 'low' },
  openai: { url: 'https://api.openai.com/v1/chat/completions', key: 'OPENAI_API_KEY', model: 'gpt-5-mini', effort: 'low' },
  openrouter: { url: 'https://openrouter.ai/api/v1/chat/completions', key: 'OPENROUTER_API_KEY', model: null, effort: null },
};
// Claude models that accept the server-side refusal fallback (`fallbacks: "default"`).
const FALLBACK_MODELS = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1'];

// Prompt placeholders are a bare name in braces, e.g. {party} or {prior_answer}. Braces around
// anything else (JSON in a prompt, say) are left alone.
const VAR = /\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}/g;

function promptVars(template) {
  return [...new Set([...String(template || '').matchAll(VAR)].map((m) => m[1]))];
}

function renderPrompt(template, values) {
  return template.replace(VAR, (whole, name) => (Object.hasOwn(values, name) ? values[name] : whole));
}

// The values one participant's prompt can use: matching fields (as parsed) and the declared prompt
// vars (raw URL params, trimmed, control characters removed, capped at max_var_length).
// Returns { values, missing } where missing lists the names the prompts use but the URL left empty.
function promptValues(ai, params, fields) {
  const values = {};
  for (const [name, v] of Object.entries(fields)) {
    values[name] = Array.isArray(v) ? formatList(v) : v === null || v === undefined ? '' : String(v);
  }
  for (const name of Object.keys(ai.vars)) {
    const raw = params[name] === undefined || params[name] === null ? '' : String(params[name]);
    values[name] = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, ai.max_var_length);
  }
  const missing = ai.uses.filter((n) => !values[n]);
  return { values, missing };
}

// Chat history as model turns: the participant is "user", the AI is "assistant". Anthropic needs
// the first turn to be the user's, so an AI opening line gets a short user turn before it.
function toTurns(messages) {
  const turns = messages.map((m) => ({ role: m.from.bot ? 'assistant' : 'user', content: m.text }));
  if (turns.length && turns[0].role === 'assistant') turns.unshift({ role: 'user', content: '[The participant joined the chat.]' });
  return turns;
}

class AiError extends Error {
  constructor(message, retry = false) {
    super(message);
    this.retry = retry;
  }
}

async function post(url, headers, body, timeoutMs) {
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new AiError(`request failed: ${e.name === 'TimeoutError' ? 'timed out' : e.message}`, true);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = String(data?.error?.message || res.statusText || '').slice(0, 200);
    throw new AiError(`HTTP ${res.status}: ${msg}`, res.status === 429 || res.status >= 500);
  }
  return data;
}

// One model call: { system, messages } -> { text, model, usage: { input_tokens, output_tokens } }.
async function callModel(ai, { system, messages }) {
  const key = process.env[ai.api_key_env];
  if (!key) throw new AiError(`environment variable ${ai.api_key_env} is not set`);
  const turns = toTurns(messages);
  if (ai.provider === 'anthropic') {
    const fallback = FALLBACK_MODELS.includes(ai.model);
    const data = await post(PROVIDERS.anthropic.url, {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      ...(fallback ? { 'anthropic-beta': 'server-side-fallback-2026-07-01' } : {}),
    }, {
      model: ai.model,
      max_tokens: ai.max_tokens,
      system,
      messages: turns,
      ...(ai.effort ? { output_config: { effort: ai.effort } } : {}),
      ...(ai.temperature !== null ? { temperature: ai.temperature } : {}),
      ...(fallback ? { fallbacks: 'default' } : {}),
    }, ai.timeout_ms);
    if (data.stop_reason === 'refusal') throw new AiError('the model declined to answer (stop_reason: refusal)');
    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    return { text, model: data.model || ai.model, usage: { input_tokens: data.usage?.input_tokens ?? 0, output_tokens: data.usage?.output_tokens ?? 0 } };
  }
  // openai and openrouter share the Chat Completions format.
  const data = await post(PROVIDERS[ai.provider].url, { authorization: `Bearer ${key}` }, {
    model: ai.model,
    messages: [{ role: 'system', content: system }, ...turns],
    [ai.provider === 'openai' ? 'max_completion_tokens' : 'max_tokens']: ai.max_tokens,
    ...(ai.effort ? { reasoning_effort: ai.effort } : {}),
    ...(ai.temperature !== null ? { temperature: ai.temperature } : {}),
  }, ai.timeout_ms);
  const text = String(data.choices?.[0]?.message?.content || '').trim();
  return { text, model: data.model || ai.model, usage: { input_tokens: data.usage?.prompt_tokens ?? 0, output_tokens: data.usage?.completion_tokens ?? 0 } };
}

module.exports = { PROVIDERS, promptVars, renderPrompt, promptValues, toTurns, callModel, AiError };
