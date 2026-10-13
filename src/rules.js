'use strict';

// Matching rule primitives. Each primitive is a small set of pure functions:
//   types      field types the rule may be applied to
//   parse(arg) turn the YAML argument into { field, ...params } (throws on bad input)
//   check      hard test: does the pair (a, b) satisfy the rule?
//   score      soft score for `prefer` (higher is better); defaults to check ? 1 : 0
//   softOnly   true if the rule can only appear under `prefer`
// `a` and `b` are parsed participant field objects, e.g. { party: 'Democrat', age: 34 }.
// Adding a primitive means adding one entry here.

const known = (v) => v !== null && v !== undefined;

function sharedItems(x, y) {
  if (!Array.isArray(x) || !Array.isArray(y)) return [];
  const ys = new Set(y);
  return [...new Set(x.filter((v) => ys.has(v)))];
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function fieldOnly(arg) {
  if (typeof arg !== 'string' || !arg) throw new Error('expects a field name, e.g. `same: party`');
  return { field: arg };
}

function fieldWith(keys, example) {
  return (arg) => {
    if (!isObject(arg) || typeof arg.field !== 'string') throw new Error(`expects ${example}`);
    const extra = Object.keys(arg).filter((k) => k !== 'field' && !keys.includes(k));
    if (extra.length) throw new Error(`unknown key(s) ${extra.join(', ')}; expects ${example}`);
    return { ...arg };
  };
}

const PRIMITIVES = {
  same: {
    types: ['category', 'number'],
    parse: fieldOnly,
    check: (a, b, r) => known(a[r.field]) && a[r.field] === b[r.field],
  },
  differ: {
    types: ['category', 'number'],
    parse: fieldOnly,
    check: (a, b, r) => known(a[r.field]) && known(b[r.field]) && a[r.field] !== b[r.field],
  },
  equals: {
    types: ['category', 'number'],
    parse: (arg) => {
      const r = fieldWith(['value'], '`equals: {field: party, value: Democrat}`')(arg);
      if (!known(r.value)) throw new Error('needs a `value`');
      return r;
    },
    check: (a, b, r) => a[r.field] === r.value && b[r.field] === r.value,
  },
  overlap: {
    types: ['list'],
    parse: (arg) => {
      const r = fieldWith(['min'], '`overlap: {field: top3, min: 1}`')(arg);
      r.min = r.min ?? 1;
      if (!Number.isInteger(r.min) || r.min < 1) throw new Error('`min` must be a whole number >= 1');
      return r;
    },
    check: (a, b, r) => sharedItems(a[r.field], b[r.field]).length >= r.min,
    score: (a, b, r) => sharedItems(a[r.field], b[r.field]).length,
  },
  within: {
    types: ['number'],
    parse: (arg) => {
      const r = fieldWith(['max'], '`within: {field: age, max: 5}`')(arg);
      if (typeof r.max !== 'number' || r.max < 0) throw new Error('`max` must be a number >= 0');
      return r;
    },
    check: (a, b, r) =>
      known(a[r.field]) && known(b[r.field]) && Math.abs(a[r.field] - b[r.field]) <= r.max,
  },
  closest: {
    types: ['number'],
    softOnly: true,
    parse: fieldOnly,
    score: (a, b, r) =>
      known(a[r.field]) && known(b[r.field]) ? -Math.abs(a[r.field] - b[r.field]) : -Infinity,
  },
};

function check(rule, a, b) {
  return PRIMITIVES[rule.kind].check(a, b, rule);
}

function score(rule, a, b) {
  const p = PRIMITIVES[rule.kind];
  return p.score ? p.score(a, b, rule) : p.check(a, b, rule) ? 1 : 0;
}

module.exports = { PRIMITIVES, check, score, sharedItems, isObject };
