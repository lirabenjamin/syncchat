'use strict';

const fs = require('fs');
const yaml = require('js-yaml');
const { PRIMITIVES, isObject } = require('./rules');
const { placeholders } = require('./reveal');
const { isValidPattern } = require('./origins');

class ConfigError extends Error {
  constructor(errors, file) {
    super(`Invalid study config${file ? ` (${file})` : ''}:\n  - ${errors.join('\n  - ')}`);
    this.errors = errors;
  }
}

const FIELD_TYPES = ['category', 'list', 'number'];

// "30s", "2m", "500ms", or a bare number of seconds -> milliseconds.
function parseDuration(v) {
  if (typeof v === 'number' && v >= 0) return v * 1000;
  const m = typeof v === 'string' && v.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m)$/);
  if (!m) return null;
  return Math.round(Number(m[1]) * { ms: 1, s: 1000, m: 60000 }[m[2]]);
}

function validateConfig(raw) {
  const errors = [];
  const err = (path, msg) => errors.push(`${path}: ${msg}`);

  function section(obj, path, allowed, required = true) {
    if (obj === undefined || obj === null) {
      if (required) err(path, 'is missing');
      return {};
    }
    if (!isObject(obj)) {
      err(path, 'must be a mapping');
      return {};
    }
    for (const k of Object.keys(obj)) {
      if (!allowed.includes(k)) err(`${path}.${k}`, `unknown key (allowed: ${allowed.join(', ')})`);
    }
    return obj;
  }

  function duration(v, path, required) {
    if (v === undefined || v === null) {
      if (required) err(path, 'is missing');
      return null;
    }
    const ms = parseDuration(v);
    if (ms === null) err(path, `"${v}" is not a duration (use e.g. 30s, 2m, 500ms)`);
    return ms;
  }

  if (!isObject(raw)) throw new ConfigError(['the file must contain a YAML mapping']);
  section(raw, '(top level)', ['study', 'participant', 'conditions', 'timing', 'on_timeout', 'embed', 'chat', 'limits']);

  // study
  const study = section(raw.study, 'study', ['id', 'group_size']);
  if (typeof study.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(study.id)) {
    err('study.id', 'must be a string of letters, numbers, - or _');
  }
  const groupSize = study.group_size ?? 2;
  if (groupSize !== 2) err('study.group_size', 'v1 supports dyads only; set it to 2');

  // participant
  const part = section(raw.participant, 'participant', ['id_param', 'condition_param', 'fields']);
  for (const k of ['id_param', 'condition_param']) {
    if (part[k] !== undefined && (typeof part[k] !== 'string' || !part[k])) err(`participant.${k}`, 'must be a string');
  }
  const fields = {};
  const rawFields = section(part.fields, 'participant.fields', Object.keys(part.fields || {}), false);
  for (const [name, def] of Object.entries(rawFields)) {
    const path = `participant.fields.${name}`;
    if (!isObject(def) || !FIELD_TYPES.includes(def.type)) {
      err(path, `needs a type: one of ${FIELD_TYPES.join(', ')}`);
      continue;
    }
    section(def, path, { category: ['type', 'values'], list: ['type', 'sep'], number: ['type'] }[def.type]);
    const f = { type: def.type };
    if (def.type === 'category' && def.values !== undefined) {
      if (!Array.isArray(def.values) || !def.values.length) err(`${path}.values`, 'must be a non-empty list');
      else f.values = def.values.map(String);
    }
    if (def.type === 'list') {
      if (def.sep !== undefined && (typeof def.sep !== 'string' || !def.sep)) err(`${path}.sep`, 'must be a non-empty string');
      f.sep = def.sep || ',';
    }
    fields[name] = f;
  }

  function parseRule(entry, path, soft) {
    if (!isObject(entry)) {
      err(path, 'must be a rule like `differ: party`');
      return null;
    }
    const kinds = Object.keys(entry).filter((k) => k !== 'relaxable');
    if (kinds.length !== 1) {
      err(path, `must contain exactly one rule (found ${kinds.length ? kinds.join(', ') : 'none'})`);
      return null;
    }
    const kind = kinds[0];
    const prim = PRIMITIVES[kind];
    if (!prim) {
      err(path, `unknown rule "${kind}" (known: ${Object.keys(PRIMITIVES).join(', ')})`);
      return null;
    }
    // `relaxable` may sit next to the rule or inside its argument mapping.
    let arg = entry[kind];
    if (isObject(arg) && 'relaxable' in arg) {
      const { relaxable, ...rest } = arg;
      entry = { ...entry, relaxable };
      arg = rest;
    }
    let rule;
    try {
      rule = { kind, ...prim.parse(arg) };
    } catch (e) {
      err(`${path}.${kind}`, e.message);
      return null;
    }
    const field = fields[rule.field];
    if (!field) {
      err(`${path}.${kind}`, `unknown field "${rule.field}" (declare it under participant.fields)`);
      return null;
    }
    if (!prim.types.includes(field.type)) {
      err(`${path}.${kind}`, `needs a ${prim.types.join(' or ')} field, but "${rule.field}" is ${field.type}`);
      return null;
    }
    if (prim.softOnly && !soft) err(path, `"${kind}" ranks partners, so it belongs under prefer (use "within" as a hard rule)`);
    if (entry.relaxable !== undefined) {
      if (soft) err(`${path}.relaxable`, 'only applies to require rules');
      else if (typeof entry.relaxable !== 'boolean') err(`${path}.relaxable`, 'must be true or false');
    }
    if (kind === 'equals') {
      if (field.type === 'number' && typeof rule.value !== 'number') err(`${path}.equals.value`, 'must be a number');
      if (field.type === 'category') {
        rule.value = String(rule.value);
        if (field.values && !field.values.includes(rule.value)) {
          err(`${path}.equals.value`, `"${rule.value}" is not one of ${rule.field}'s values`);
        }
      }
    }
    rule.relaxable = entry.relaxable === true;
    return rule;
  }

  function template(t, path) {
    for (const p of placeholders(t)) {
      if (!p.scope) err(path, `bad placeholder {${p.raw}} (use {shared.f}, {partner.f}, or {me.f})`);
      else if (!fields[p.field]) err(path, `placeholder {${p.raw}} uses unknown field "${p.field}"`);
      else if (p.scope === 'shared' && fields[p.field].type !== 'list') err(path, `{shared.${p.field}} needs a list field`);
    }
  }

  // timing
  const timing = section(raw.timing, 'timing', ['match_timeout', 'chat_duration', 'min_messages']);
  const matchTimeoutMs = duration(timing.match_timeout, 'timing.match_timeout', true);
  const chatDurationMs = duration(timing.chat_duration, 'timing.chat_duration', true);
  const minMessages = timing.min_messages ?? 0;
  if (!Number.isInteger(minMessages) || minMessages < 0) err('timing.min_messages', 'must be a whole number >= 0');

  // conditions
  const conditions = {};
  const rawConds = section(raw.conditions, 'conditions', Object.keys(raw.conditions || {}));
  if (isObject(raw.conditions) && !Object.keys(raw.conditions).length) err('conditions', 'define at least one condition');
  for (const [name, c] of Object.entries(rawConds)) {
    const path = `conditions.${name}`;
    const cond = section(c, path, ['require', 'prefer', 'relax_after', 'reveal']);
    const out = { require: [], prefer: [], relax_after_ms: null, reveal: false };
    for (const key of ['require', 'prefer']) {
      if (cond[key] === undefined || cond[key] === null) continue;
      if (!Array.isArray(cond[key])) {
        err(`${path}.${key}`, 'must be a list of rules');
        continue;
      }
      cond[key].forEach((entry, i) => {
        const r = parseRule(entry, `${path}.${key}[${i}]`, key === 'prefer');
        if (r) out[key].push(r);
      });
    }
    out.relax_after_ms = duration(cond.relax_after, `${path}.relax_after`, false);
    if (out.relax_after_ms !== null && matchTimeoutMs !== null && out.relax_after_ms >= matchTimeoutMs) {
      err(`${path}.relax_after`, 'must be shorter than timing.match_timeout, or it never takes effect');
    }
    if (cond.reveal !== undefined && cond.reveal !== false) {
      if (typeof cond.reveal !== 'string') err(`${path}.reveal`, 'must be a text template or false');
      else {
        template(cond.reveal, `${path}.reveal`);
        out.reveal = cond.reveal;
      }
    }
    conditions[name] = out;
  }

  // on_timeout
  const onTimeout = raw.on_timeout ?? 'nomatch';
  if (onTimeout === 'bot') err('on_timeout', '"bot" is planned but not supported yet; use nomatch');
  else if (onTimeout !== 'nomatch') err('on_timeout', 'must be nomatch');

  // embed
  const embed = section(raw.embed, 'embed', ['allowed_origins', 'redirect_url', 'send_transcript_to_parent']);
  const origins = embed.allowed_origins;
  if (!Array.isArray(origins) || !origins.length) err('embed.allowed_origins', 'must list at least one origin, e.g. "https://*.qualtrics.com"');
  else {
    origins.forEach((o, i) => {
      if (!isValidPattern(o)) err(`embed.allowed_origins[${i}]`, `"${o}" is not an origin like https://*.qualtrics.com (no paths, no bare *)`);
    });
  }
  const redirect = embed.redirect_url ?? null;
  if (redirect !== null && (typeof redirect !== 'string' || !/^https?:\/\//.test(redirect))) {
    err('embed.redirect_url', 'must be null or an http(s) URL');
  }
  const sendTranscript = embed.send_transcript_to_parent ?? false;
  if (typeof sendTranscript !== 'boolean') err('embed.send_transcript_to_parent', 'must be true or false');

  // chat + limits (optional)
  const chat = section(raw.chat, 'chat', ['intro'], false);
  if (chat.intro !== undefined) {
    if (typeof chat.intro !== 'string') err('chat.intro', 'must be text');
    else template(chat.intro, 'chat.intro');
  }
  const limits = section(raw.limits, 'limits', ['max_message_length', 'messages_per_10s', 'joins_per_ip_per_minute'], false);
  const lim = { max_message_length: 500, messages_per_10s: 10, joins_per_ip_per_minute: 60, ...limits };
  for (const [k, v] of Object.entries(lim)) {
    if (!Number.isInteger(v) || v < 1) err(`limits.${k}`, 'must be a whole number >= 1');
  }

  if (errors.length) throw new ConfigError(errors);

  return {
    study: { id: study.id, group_size: groupSize },
    participant: { id_param: part.id_param || 'id', condition_param: part.condition_param || 'cond', fields },
    conditions,
    timing: { match_timeout_ms: matchTimeoutMs, chat_duration_ms: chatDurationMs, min_messages: minMessages },
    on_timeout: onTimeout,
    embed: { allowed_origins: origins, redirect_url: redirect, send_transcript_to_parent: sendTranscript },
    chat: { intro: chat.intro || null },
    limits: lim,
  };
}

function loadConfig(file) {
  let raw;
  try {
    raw = yaml.load(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new ConfigError([e.code === 'ENOENT' ? 'file not found' : `YAML syntax error: ${e.message}`], file);
  }
  try {
    return validateConfig(raw);
  } catch (e) {
    if (e instanceof ConfigError) throw new ConfigError(e.errors, file);
    throw e;
  }
}

module.exports = { loadConfig, validateConfig, parseDuration, ConfigError };
