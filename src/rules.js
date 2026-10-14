'use strict';

const fs = require('fs');
const path = require('path');

// The rule table. Every rule type is one entry:
//   args        argument schema (see ARG CHECKS below); the FIRST key is the shorthand,
//               so `same: party` means `same: {field: party}`
//   describe    args -> plain English that completes "partners must ..."
//   rank        optional, args -> plain English for `prefer`, completing "rank partners by ..."
//   test        (a, b, args) -> { pass, score?, shared? }   for one pair of participants
//               a and b are parsed fields, e.g. { party: 'Democrat', top3: ['pizza'], age: 34 }
//               score ranks partners under `prefer` (higher is better; default pass ? 1 : 0)
//               shared lists items the pair has in common (stored with the match)
//   preferOnly  true if the rule only ranks partners and cannot be a hard rule
// A `custom: ./rules/x.js` file exports the same shape (args optional).

const known = (v) => v !== null && v !== undefined;

function sharedItems(x, y) {
  if (!Array.isArray(x) || !Array.isArray(y)) return [];
  const ys = new Set(y);
  return [...new Set(x.filter((v) => ys.has(v)))];
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const RULES = {
  same: {
    args: { field: { field: ['category', 'number'] } },
    describe: ({ field }) => `have the same ${field}`,
    test: (a, b, { field }) => ({ pass: known(a[field]) && a[field] === b[field] }),
  },
  differ: {
    args: { field: { field: ['category', 'number'] } },
    describe: ({ field }) => `have different ${field}`,
    test: (a, b, { field }) => ({ pass: known(a[field]) && known(b[field]) && a[field] !== b[field] }),
  },
  equals: {
    args: { field: { field: ['category', 'number'] }, value: { valueFor: 'field' } },
    describe: ({ field, value }) => `both have ${field} = ${value}`,
    test: (a, b, { field, value }) => ({ pass: a[field] === value && b[field] === value }),
  },
  overlap: {
    args: { field: { field: ['list'] }, min: { integer: true, min: 1, default: 1 } },
    describe: ({ field, min }) => `share at least ${plural(min, 'item')} in ${field}`,
    rank: ({ field }) => `most shared items in ${field}`,
    test: (a, b, { field, min }) => {
      const shared = sharedItems(a[field], b[field]);
      return { pass: shared.length >= min, score: shared.length, shared };
    },
  },
  within: {
    args: { field: { field: ['number'] }, max: { number: true, min: 0 } },
    describe: ({ field, max }) => `have ${field} within ${max} of each other`,
    test: (a, b, { field, max }) => ({
      pass: known(a[field]) && known(b[field]) && Math.abs(a[field] - b[field]) <= max,
    }),
  },
  closest: {
    args: { field: { field: ['number'] } },
    preferOnly: true,
    describe: ({ field }) => `have the closest ${field}`,
    rank: ({ field }) => `closest ${field}`,
    test: (a, b, { field }) => {
      const pass = known(a[field]) && known(b[field]);
      return { pass, score: pass ? -Math.abs(a[field] - b[field]) : -Infinity };
    },
  },
  any_of: {
    args: { rules: { rules: true } },
    describe: ({ rules }) => `either ${rules.map((r) => r.describe).join(' OR ')}`,
    test: (a, b, { rules }) => ({ pass: rules.some((r) => r.test(a, b).pass) }),
  },
  not: {
    args: { rule: { rule: true } },
    describe: ({ rule }) => `NOT ${rule.describe}`,
    test: (a, b, { rule }) => ({ pass: !rule.test(a, b).pass }),
  },
};

// ---- compiling a YAML rule entry into { name, label, describe, rank, test, ... } ----

// ARG CHECKS: each key of an `args` schema is one of
//   { field: [types] }        the name of a declared participant field of one of these types
//   { valueFor: 'field' }      a value allowed for the field named by that argument
//   { integer|number: true, min, default }
//   { rule: true } / { rules: true }   one nested rule / a list of nested rules
// Every argument is required unless it has a default.
function checkArg(name, spec, value, args, ctx) {
  if (value === undefined && 'default' in spec) return spec.default;
  if (value === undefined || value === null) throw new Error(`needs \`${name}\``);
  if (spec.field) {
    const def = typeof value === 'string' ? ctx.fields[value] : undefined;
    if (!def) throw new Error(`unknown field "${value}" (declare it under participant.fields)`);
    if (!spec.field.includes(def.type)) {
      throw new Error(`needs a ${spec.field.join(' or ')} field, but "${value}" is ${def.type}`);
    }
    return value;
  }
  if (spec.valueFor) {
    const def = ctx.fields[args[spec.valueFor]];
    if (def && def.type === 'number' && typeof value !== 'number') throw new Error(`\`${name}\` must be a number`);
    if (def && def.type === 'category') {
      value = String(value);
      if (def.values && !def.values.includes(value)) {
        throw new Error(`"${value}" is not one of ${args[spec.valueFor]}'s values`);
      }
    }
    return value;
  }
  if (spec.integer || spec.number) {
    const ok = spec.integer ? Number.isInteger(value) : typeof value === 'number';
    if (!ok || (spec.min !== undefined && value < spec.min)) {
      throw new Error(`\`${name}\` must be a ${spec.integer ? 'whole number' : 'number'}${spec.min !== undefined ? ` >= ${spec.min}` : ''}`);
    }
    return value;
  }
  if (spec.rules) {
    if (!Array.isArray(value) || value.length < 2) throw new Error(`\`${name}\` must be a list of at least 2 rules`);
    return value.map((v, i) => compileNested(v, ctx, `${name}[${i}]: `));
  }
  if (spec.rule) return compileNested(value, ctx, '');
  return value;
}

function compileNested(raw, ctx, where) {
  let rule;
  try {
    rule = compileRule(raw, { ...ctx, nested: true });
  } catch (e) {
    throw new Error(where + e.message);
  }
  if (rule.preferOnly) throw new Error(`${where}"${rule.name}" only ranks partners and cannot be nested`);
  return rule;
}

function readArgs(entry, raw) {
  const keys = Object.keys(entry.args);
  const first = entry.args[keys[0]];
  // Long form is a mapping of argument names. A nested-rule shorthand (`not: {same: party}`)
  // is also a mapping, so for those only treat it as long form if it uses the argument names.
  const longForm = isObject(raw) && !((first.rule || first.rules) && !Object.keys(raw).every((k) => keys.includes(k)));
  const given = longForm ? raw : { [keys[0]]: raw };
  const unknown = Object.keys(given).filter((k) => !keys.includes(k));
  if (unknown.length) throw new Error(`unknown argument(s) ${unknown.join(', ')} (allowed: ${keys.join(', ')})`);
  return given;
}

function loadCustom(raw, ctx) {
  const spec = typeof raw === 'string' ? { file: raw } : raw;
  if (!isObject(spec) || typeof spec.file !== 'string') {
    throw new Error('expects a file path, e.g. `custom: ./rules/my_rule.js` or `custom: {file: ./rules/my_rule.js, field: age}`');
  }
  const file = path.resolve(ctx.baseDir, spec.file);
  if (!fs.existsSync(file)) throw new Error(`file not found: ${file}`);
  let mod;
  try {
    mod = require(file);
  } catch (e) {
    throw new Error(`could not load ${spec.file}: ${e.message}`);
  }
  if (!isObject(mod) || typeof mod.describe !== 'function' || typeof mod.test !== 'function') {
    throw new Error(`${spec.file} must export { describe(args), test(a, b, args) }`);
  }
  const { file: _file, ...rest } = spec;
  return { name: path.basename(file, path.extname(file)), entry: { args: {}, ...mod }, given: rest };
}

// An empty participant (every field missing), used to smoke-test custom rules at startup.
function emptyFields(fields) {
  return Object.fromEntries(Object.entries(fields).map(([k, d]) => [k, d.type === 'list' ? [] : null]));
}

// Compile one YAML rule entry, e.g. `{differ: party}` or `{overlap: {field: top3, min: 2}, relaxable: true}`.
// ctx: { fields, baseDir }. Throws an Error with a researcher-facing message.
function compileRule(raw, ctx) {
  if (!isObject(raw)) throw new Error('must be a rule like `differ: party`');
  const kinds = Object.keys(raw).filter((k) => k !== 'relaxable');
  if (kinds.length !== 1) throw new Error(`must contain exactly one rule (found ${kinds.length ? kinds.join(', ') : 'none'})`);
  const kind = kinds[0];
  let arg = raw[kind];
  let relaxable = raw.relaxable;
  if (isObject(arg) && 'relaxable' in arg) {
    ({ relaxable, ...arg } = arg); // `relaxable` may sit beside the rule or inside its arguments
  }
  if (relaxable !== undefined && ctx.nested) throw new Error('`relaxable` goes on the outer rule, not inside any_of/not');

  let name = kind;
  let entry = RULES[kind];
  let given;
  if (kind === 'custom') {
    ({ name, entry, given } = loadCustom(arg, ctx));
  } else if (!entry) {
    throw new Error(`unknown rule "${kind}" (known: ${[...Object.keys(RULES), 'custom'].join(', ')})`);
  } else {
    given = readArgs(entry, arg);
  }

  const args = {};
  for (const [k, spec] of Object.entries(entry.args)) args[k] = checkArg(k, spec, given[k], args, ctx);
  const extra = Object.keys(given).filter((k) => !(k in entry.args));
  if (extra.length && Object.keys(entry.args).length) {
    throw new Error(`unknown argument(s) ${extra.join(', ')} (allowed: ${Object.keys(entry.args).join(', ')})`);
  }
  for (const k of extra) args[k] = given[k]; // custom rules without an args schema get their arguments as written

  const describe = entry.describe(args);
  if (typeof describe !== 'string' || !describe) throw new Error(`describe() must return text (${name})`);
  const test = (a, b) => {
    const r = entry.test(a, b, args);
    return { pass: r.pass === true, score: r.score ?? (r.pass === true ? 1 : 0), shared: r.shared };
  };
  if (kind === 'custom') {
    let r;
    try {
      const empty = emptyFields(ctx.fields);
      r = entry.test(empty, empty, args);
    } catch (e) {
      throw new Error(`${name}.test crashed on participants with missing values: ${e.message}`);
    }
    if (!isObject(r) || typeof r.pass !== 'boolean') throw new Error(`${name}.test must return { pass: true|false }`);
  }

  const label = args.rules ? `${name}(${args.rules.map((r) => r.label).join(', ')})`
    : args.rule ? `${name}(${args.rule.label})`
      : args.field ? `${name}: ${args.field}` : name;
  return {
    name,
    label,
    describe,
    rank: entry.rank ? entry.rank(args) : `whether they ${describe}`,
    test,
    preferOnly: entry.preferOnly === true,
    relaxable,
  };
}

module.exports = { RULES, compileRule, sharedItems, isObject };
