'use strict';

const fs = require('fs');
const yaml = require('js-yaml');
const path = require('path');
const { compileRule, isObject } = require('./rules');
const { placeholders } = require('./reveal');
const { isValidPattern } = require('./origins');

class ConfigError extends Error {
  constructor(errors, file) {
    super(`Invalid study config${file ? ` (${file})` : ''}:\n  - ${errors.join('\n  - ')}`);
    this.errors = errors;
  }
}

const FIELD_TYPES = ['category', 'list', 'number'];
const TIMING_KEYS = ['match_timeout', 'chat_duration', 'min_messages', 'end_when', 'max_duration', 'extend_until_min', 'rejoin_timeout'];
const STAGE_TIMING_KEYS = ['chat_duration', 'min_messages', 'end_when', 'max_duration', 'extend_until_min'];
const STAGE_KEYS = ['id', 'prompt', 'reveal', 'then', ...STAGE_TIMING_KEYS];
const END_WHEN = ['timer', 'both_done', 'either_done'];
const THEN = ['continue', 'qualtrics'];
const UNTIMED = ['none', 'unlimited', 'null']; // chat_duration values meaning "no time limit"
const DEFAULT_MAX_MS = 60 * 60000; // safety cap on an untimed chat
const DEFAULT_REJOIN_MS = 3 * 60000;
// Settings that only make sense for some chats; set where they never apply, they are an error.
const USE_HINTS = {
  max_duration: 'only applies when chat_duration is none',
  extend_until_min: 'only applies to timed chats with min_messages above 0',
  rejoin_timeout: 'only applies to chats with stages',
};

// "30s", "2m", "500ms", or a bare number of seconds -> milliseconds.
function parseDuration(v) {
  if (typeof v === 'number' && v >= 0) return v * 1000;
  const m = typeof v === 'string' && v.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m)$/);
  if (!m) return null;
  return Math.round(Number(m[1]) * { ms: 1, s: 1000, m: 60000 }[m[2]]);
}

// baseDir: where `custom:` rule paths are resolved from (the config file's folder).
function validateConfig(raw, { baseDir = process.cwd() } = {}) {
  const errors = [];
  const err = (path, msg) => {
    const line = `${path}: ${msg}`;
    if (!errors.includes(line)) errors.push(line);
  };

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
  section(raw, '(top level)', ['title', 'description', 'study', 'participant', 'conditions', 'timing', 'stages', 'on_timeout', 'embed', 'chat', 'limits']);
  for (const k of ['title', 'description']) {
    if (raw[k] !== undefined && (typeof raw[k] !== 'string' || !raw[k].trim())) err(k, 'must be text');
  }

  // study
  const study = section(raw.study, 'study', ['id', 'group_size']);
  if (typeof study.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(study.id)) {
    err('study.id', 'must be a string of letters, numbers, - or _');
  }
  const groupSize = study.group_size ?? 2;
  if (groupSize !== 2) err('study.group_size', 'only 2 is supported for now (dyads); rules are pairwise, so larger groups need only a new group-forming step');

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
    const keys = { category: ['values'], list: ['sep', 'options', 'pick'], number: ['min', 'max'] }[def.type];
    section(def, path, ['type', 'label', ...keys]);
    const f = { type: def.type };
    // label, options/pick, and min/max only shape the /demo form; matching ignores them.
    if (def.label !== undefined) {
      if (typeof def.label !== 'string' || !def.label.trim()) err(`${path}.label`, 'must be text');
      else f.label = def.label;
    }
    if (def.type === 'number') {
      for (const k of ['min', 'max']) {
        if (def[k] === undefined) continue;
        if (typeof def[k] !== 'number') err(`${path}.${k}`, 'must be a number');
        else f[k] = def[k];
      }
      if (f.min !== undefined && f.max !== undefined && f.min > f.max) err(`${path}.min`, 'must not exceed max');
    }
    if (def.type === 'category' && def.values !== undefined) {
      if (!Array.isArray(def.values) || !def.values.length) err(`${path}.values`, 'must be a non-empty list');
      else f.values = def.values.map(String);
    }
    if (def.type === 'list') {
      if (def.sep !== undefined && (typeof def.sep !== 'string' || !def.sep)) err(`${path}.sep`, 'must be a non-empty string');
      f.sep = def.sep || ',';
      if (def.options !== undefined) {
        if (!Array.isArray(def.options) || !def.options.length) err(`${path}.options`, 'must be a non-empty list');
        else {
          f.options = def.options.map(String);
          if (new Set(f.options).size !== f.options.length) err(`${path}.options`, 'must not repeat items');
          const bad = f.options.find((o) => !o.trim() || o.includes(f.sep));
          if (bad !== undefined) err(`${path}.options`, `"${bad}" is empty or contains the separator "${f.sep}"`);
        }
      }
      if (def.pick !== undefined) {
        if (!f.options) err(`${path}.pick`, 'needs options');
        else if (!Number.isInteger(def.pick) || def.pick < 1 || def.pick > f.options.length) {
          err(`${path}.pick`, `must be a whole number from 1 to ${f.options.length}`);
        } else f.pick = def.pick;
      }
    }
    fields[name] = f;
  }

  // `study` is always sent in the chat URL, so it cannot be a field or a parameter name.
  if (fields.study) err('participant.fields.study', '"study" is reserved (the chat URL always sends study=<study.id>); rename the field');
  for (const k of ['id_param', 'condition_param']) {
    if (part[k] === 'study') err(`participant.${k}`, '"study" is reserved; pick another name');
  }

  function parseRule(entry, path, soft) {
    let rule;
    try {
      rule = compileRule(entry, { fields, baseDir });
    } catch (e) {
      err(path, e.message);
      return null;
    }
    if (rule.preferOnly && !soft) err(path, `"${rule.name}" ranks partners, so it belongs under prefer (use "within" as a hard rule)`);
    if (rule.relaxable !== undefined) {
      if (soft) err(`${path}.relaxable`, 'only applies to require rules');
      else if (typeof rule.relaxable !== 'boolean') err(`${path}.relaxable`, 'must be true or false');
    }
    rule.relaxable = rule.relaxable === true;
    return rule;
  }

  function template(t, path) {
    for (const p of placeholders(t)) {
      if (!p.scope) err(path, `bad placeholder {${p.raw}} (use {shared.f}, {partner.f}, or {me.f})`);
      else if (!fields[p.field]) err(path, `placeholder {${p.raw}} uses unknown field "${p.field}"`);
      else if (p.scope === 'shared' && fields[p.field].type !== 'list') err(path, `{shared.${p.field}} needs a list field`);
    }
  }

  const conditional = new Map(); // "path.key" -> key, for settings that only apply to some chats
  // timing: a global block, optionally overridden per condition (conditions.x.timing) and per stage.
  const timing = timingBlock(raw.timing, 'timing', TIMING_KEYS, true);
  for (const k of ['match_timeout', 'chat_duration']) {
    if (raw.timing?.[k] === undefined) err(`timing.${k}`, 'is missing');
  }
  const topStages = raw.stages === undefined ? null : parseStages(raw.stages, 'stages');
  const used = new Set(); // "path.key" of conditional settings that apply to at least one chat

  // conditions
  const conditions = {};
  const rawConds = section(raw.conditions, 'conditions', Object.keys(raw.conditions || {}));
  if (isObject(raw.conditions) && !Object.keys(raw.conditions).length) err('conditions', 'define at least one condition');
  for (const [name, c] of Object.entries(rawConds)) {
    const path = `conditions.${name}`;
    const cond = section(c, path, ['label', 'require', 'prefer', 'relax_after', 'reveal', 'timing', 'stages']);
    const out = { require: [], prefer: [], relax_after_ms: null, reveal: false };
    if (cond.label !== undefined) {
      if (typeof cond.label !== 'string' || !cond.label.trim()) err(`${path}.label`, 'must be text');
      else out.label = cond.label; // shown in the /demo condition dropdown
    }
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
    const condTiming = cond.timing === undefined ? {} : timingBlock(cond.timing, `${path}.timing`, TIMING_KEYS, false);
    const layers = [['timing', timing], [`${path}.timing`, condTiming]];
    const pick = (k) => layers.reduce((v, [, t]) => (Object.hasOwn(t, k) ? t[k] : v), undefined);
    const matchTimeoutMs = pick('match_timeout') ?? null;
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
    const stages = cond.stages === undefined ? topStages : parseStages(cond.stages, `${path}.stages`);
    out.staged = !!stages;
    out.timing = { match_timeout_ms: matchTimeoutMs, rejoin_timeout_ms: pick('rejoin_timeout') ?? DEFAULT_REJOIN_MS };
    if (out.staged) markUsed(layers, 'rejoin_timeout');
    out.stages = (stages || [{ id: null, prompt: null, then: null, timing: {} }])
      .map((st, i) => resolveStage(st, i, i === 0 ? out.reveal : false, [...layers, [st.path, st.timing]], path));
    out.reveal = out.stages[0].reveal;
    conditions[name] = out;
  }
  for (const [full, k] of conditional) if (!used.has(full)) err(full, USE_HINTS[k]);

  // Fill one stage's timing from the layers (global -> condition -> stage) and check the combination.
  function resolveStage(st, index, defaultReveal, layers, condPath) {
    const pick = (k) => layers.reduce((v, [, t]) => (Object.hasOwn(t, k) ? t[k] : v), undefined);
    const owner = (k) => [...layers].reverse().find(([, t]) => Object.hasOwn(t, k))?.[0];
    const durationMs = pick('chat_duration');
    const untimed = durationMs === null;
    const minMessages = pick('min_messages') ?? 0;
    const endWhen = pick('end_when') ?? (untimed ? 'both_done' : 'timer');
    if (untimed && endWhen === 'timer') {
      err(`${owner('end_when')}.end_when`, `"timer" needs a time limit, but chat_duration is none${st.path ? ` for stage "${st.id}"` : ` in ${condPath}`} (use both_done or either_done)`);
    }
    if (untimed) markUsed(layers, 'max_duration');
    if (!untimed && minMessages > 0) markUsed(layers, 'extend_until_min');
    return {
      id: st.id,
      prompt: st.prompt,
      reveal: st.reveal === undefined ? defaultReveal : st.reveal,
      then: st.then,
      chat_duration_ms: durationMs === undefined ? null : durationMs,
      min_messages: minMessages,
      end_when: endWhen,
      max_duration_ms: untimed ? pick('max_duration') ?? DEFAULT_MAX_MS : null,
      extend_until_min_ms: untimed ? 0 : pick('extend_until_min') ?? 0,
    };
  }

  // Mark the most specific layer that sets `k` as applying to some chat.
  function markUsed(layers, k) {
    const set = [...layers].reverse().find(([, t]) => Object.hasOwn(t, k));
    if (set) used.add(`${set[0]}.${k}`);
  }

  // A timing block: durations to ms, chat_duration none/unlimited/null to null; only keys present are set.
  function timingBlock(obj, path, allowed, required) {
    const t = section(obj, path, allowed, required);
    const out = {};
    for (const k of ['match_timeout', 'rejoin_timeout', 'max_duration', 'extend_until_min']) {
      if (!Object.hasOwn(t, k)) continue;
      const ms = duration(t[k], `${path}.${k}`, true);
      if (ms === null) continue;
      if (ms === 0 && k !== 'extend_until_min') err(`${path}.${k}`, 'must be longer than 0');
      else out[k] = ms;
      if (ms && USE_HINTS[k]) conditional.set(`${path}.${k}`, k);
    }
    if (Object.hasOwn(t, 'chat_duration')) {
      const v = t.chat_duration;
      if (v === null || (typeof v === 'string' && UNTIMED.includes(v.trim().toLowerCase()))) out.chat_duration = null;
      else {
        const ms = parseDuration(v);
        if (ms === null) err(`${path}.chat_duration`, `"${v}" is not a duration (use e.g. 30s, 2m, 500ms, or none for no time limit)`);
        else out.chat_duration = ms;
      }
    }
    if (Object.hasOwn(t, 'min_messages')) {
      if (!Number.isInteger(t.min_messages) || t.min_messages < 0) err(`${path}.min_messages`, 'must be a whole number >= 0');
      else out.min_messages = t.min_messages;
    }
    if (Object.hasOwn(t, 'end_when')) {
      if (!END_WHEN.includes(t.end_when)) err(`${path}.end_when`, `must be one of ${END_WHEN.join(', ')}`);
      else out.end_when = t.end_when;
    }
    return out;
  }

  // A stages list: [{ id, prompt, reveal, then, timing, path }], or null if it is unusable.
  function parseStages(list, path) {
    if (!Array.isArray(list) || !list.length) {
      err(path, 'must be a non-empty list of stages');
      return null;
    }
    const ids = new Set();
    return list.map((s, i) => {
      const p = `${path}[${i}]`;
      const st = section(s, p, STAGE_KEYS);
      const id = typeof st.id === 'string' && /^[A-Za-z0-9_]+$/.test(st.id) ? st.id : null;
      if (!id) err(`${p}.id`, 'must be a string of letters, numbers, or _');
      else if (ids.has(id)) err(`${p}.id`, `"${id}" is used by another stage`);
      ids.add(id);
      for (const k of ['prompt', 'reveal']) {
        if (st[k] === undefined || (k === 'reveal' && st[k] === false)) continue;
        if (typeof st[k] !== 'string' || !st[k].trim()) err(`${p}.${k}`, k === 'reveal' ? 'must be a text template or false' : 'must be text');
        else template(st[k], `${p}.${k}`);
      }
      const last = i === list.length - 1;
      if (last && st.then !== undefined) err(`${p}.then`, 'the last stage ends the chat, so it has no then');
      if (!last && st.then !== undefined && !THEN.includes(st.then)) err(`${p}.then`, `must be one of ${THEN.join(', ')}`);
      return {
        id,
        prompt: typeof st.prompt === 'string' ? st.prompt : null,
        reveal: st.reveal,
        then: last ? null : st.then ?? 'continue',
        timing: timingBlock(Object.fromEntries(Object.entries(st).filter(([k]) => STAGE_TIMING_KEYS.includes(k))), p, STAGE_TIMING_KEYS, false),
        path: p,
      };
    });
  }

  // With stages, later chat questions send stage=<id>, so it cannot be a field or a parameter name.
  if (Object.values(conditions).some((c) => c.staged)) {
    if (fields.stage) err('participant.fields.stage', '"stage" is reserved in a study with stages (later chat questions send stage=<id>); rename the field');
    for (const k of ['id_param', 'condition_param']) {
      if (part[k] === 'stage') err(`participant.${k}`, '"stage" is reserved in a study with stages; pick another name');
    }
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
    title: raw.title || null,
    description: raw.description || null,
    study: { id: study.id, group_size: groupSize },
    participant: { id_param: part.id_param || 'id', condition_param: part.condition_param || 'cond', fields },
    conditions,
    timing: {
      match_timeout_ms: timing.match_timeout ?? null,
      chat_duration_ms: timing.chat_duration ?? null,
      min_messages: timing.min_messages ?? 0,
      end_when: timing.end_when ?? (timing.chat_duration === null ? 'both_done' : 'timer'),
      max_duration_ms: timing.max_duration ?? DEFAULT_MAX_MS,
      extend_until_min_ms: timing.extend_until_min ?? 0,
      rejoin_timeout_ms: timing.rejoin_timeout ?? DEFAULT_REJOIN_MS,
    },
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
    return validateConfig(raw, { baseDir: path.dirname(path.resolve(file)) });
  } catch (e) {
    if (e instanceof ConfigError) throw new ConfigError(e.errors, file);
    throw e;
  }
}

// Every *.yaml / *.yml in `dir`, sorted by file name: [{ file, config, source }]. Study ids must be unique.
function loadStudyDir(dir) {
  let names;
  try {
    names = fs.readdirSync(dir).filter((f) => /\.ya?ml$/i.test(f)).sort();
  } catch (e) {
    throw new ConfigError([e.code === 'ENOENT' ? 'folder not found' : e.message], dir);
  }
  if (!names.length) throw new ConfigError(['no .yaml files in this folder'], dir);
  const studies = names.map((n) => {
    const file = path.join(dir, n);
    return { file, config: loadConfig(file), source: fs.readFileSync(file, 'utf8') };
  });
  const seen = new Map();
  for (const s of studies) {
    const id = s.config.study.id;
    if (seen.has(id)) throw new ConfigError([`study.id "${id}" is used by both ${seen.get(id)} and ${path.basename(s.file)}`], dir);
    seen.set(id, path.basename(s.file));
  }
  return studies;
}

module.exports = { loadConfig, loadStudyDir, validateConfig, parseDuration, ConfigError };
