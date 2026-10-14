'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RULES, compileRule } = require('../src/rules');

const root = path.join(__dirname, '..');
const fields = {
  party: { type: 'category', values: ['D', 'R'] },
  gender: { type: 'category' },
  t: { type: 'list', sep: ',' },
  age: { type: 'number' },
};
const ctx = { fields, baseDir: root };
const rule = (raw) => compileRule(raw, ctx);
const pass = (r, a, b) => r.test(a, b).pass;

test('registry: every rule type has an args schema, describe, and test', () => {
  const sample = { same: 'party', differ: 'party', equals: { field: 'party', value: 'D' }, overlap: 't',
    within: { field: 'age', max: 5 }, closest: 'age', any_of: [{ same: 'party' }, { overlap: 't' }], not: { same: 'party' } };
  assert.deepStrictEqual(Object.keys(RULES).sort(), Object.keys(sample).sort(), 'every rule type has a sample here');
  for (const [name, entry] of Object.entries(RULES)) {
    assert.ok(Object.keys(entry.args).length >= 1, `${name}.args`);
    assert.strictEqual(typeof entry.describe, 'function', `${name}.describe`);
    assert.strictEqual(typeof entry.test, 'function', `${name}.test`);
    const r = rule({ [name]: sample[name] });
    assert.ok(r.describe.length > 0 && !/undefined/.test(r.describe), `${name} describes itself: ${r.describe}`);
    assert.strictEqual(typeof r.test({ party: 'D', t: ['a'], age: 1 }, { party: 'R', t: ['a'], age: 2 }).pass, 'boolean');
  }
});

test('same / differ / equals', () => {
  const same = rule({ same: 'party' });
  assert.ok(pass(same, { party: 'D' }, { party: 'D' }));
  assert.ok(!pass(same, { party: 'D' }, { party: 'R' }));
  assert.ok(!pass(same, { party: null }, { party: null }), 'missing values never match');
  const differ = rule({ differ: { field: 'party' } });
  assert.ok(pass(differ, { party: 'D' }, { party: 'R' }));
  assert.ok(!pass(differ, { party: 'D' }, { party: null }));
  const eq = rule({ equals: { field: 'party', value: 'D' } });
  assert.ok(pass(eq, { party: 'D' }, { party: 'D' }));
  assert.ok(!pass(eq, { party: 'D' }, { party: 'R' }));
  assert.throws(() => rule({ equals: { field: 'party' } }), /needs `value`/);
  assert.throws(() => rule({ equals: { field: 'party', value: 'G' } }), /not one of party's values/);
  assert.throws(() => rule({ same: 'nope' }), /unknown field "nope"/);
});

test('overlap / within / closest', () => {
  const ov = rule({ overlap: { field: 't', min: 2 } });
  assert.deepStrictEqual(ov.test({ t: ['a', 'b', 'c'] }, { t: ['c', 'b'] }), { pass: true, score: 2, shared: ['b', 'c'] });
  assert.ok(!pass(ov, { t: ['a', 'b'] }, { t: ['b', 'x'] }));
  assert.strictEqual(rule({ overlap: 't' }).describe, 'share at least 1 item in t', 'min defaults to 1');
  assert.throws(() => rule({ overlap: { field: 't', min: 0 } }), /whole number >= 1/);
  assert.throws(() => rule({ overlap: 'age' }), /needs a list field/);
  const w = rule({ within: { field: 'age', max: 5 } });
  assert.ok(pass(w, { age: 30 }, { age: 35 }));
  assert.ok(!pass(w, { age: 30 }, { age: 36 }));
  assert.strictEqual(w.test({ age: 30 }, { age: 31 }).score, 1, 'default score is pass ? 1 : 0');
  const c = rule({ closest: 'age' });
  assert.ok(c.preferOnly);
  assert.ok(c.test({ age: 30 }, { age: 32 }).score > c.test({ age: 30 }, { age: 40 }).score);
  assert.strictEqual(c.test({ age: 30 }, { age: null }).score, -Infinity);
  assert.strictEqual(c.rank, 'closest age');
});

test('any_of (OR) and not', () => {
  const any = rule({ any_of: [{ same: 'party' }, { overlap: 't' }] });
  assert.strictEqual(any.label, 'any_of(same: party, overlap: t)');
  assert.strictEqual(any.describe, 'either have the same party OR share at least 1 item in t');
  assert.ok(pass(any, { party: 'D', t: [] }, { party: 'D', t: [] }));
  assert.ok(pass(any, { party: 'D', t: ['x'] }, { party: 'R', t: ['x'] }));
  assert.ok(!pass(any, { party: 'D', t: ['x'] }, { party: 'R', t: ['y'] }));

  const not = rule({ not: { equals: { field: 'gender', value: 'Man' } } });
  assert.strictEqual(not.label, 'not(equals: gender)');
  assert.strictEqual(not.describe, 'NOT both have gender = Man');
  assert.ok(!pass(not, { gender: 'Man' }, { gender: 'Man' }));
  assert.ok(pass(not, { gender: 'Man' }, { gender: 'Woman' }));
  assert.ok(pass(rule({ not: { rule: { same: 'party' } } }), { party: 'D' }, { party: 'R' }), 'long form');

  assert.throws(() => rule({ not: { closest: 'age' } }), /only ranks partners/);
  assert.throws(() => rule({ any_of: [{ same: 'party', relaxable: true }, { overlap: 't' }] }), /goes on the outer rule/);
});

test('custom rule file is loaded, validated, and behaves like a built-in', () => {
  const r = compileRule({ custom: { file: './rules/same_decade.js', field: 'age' } }, { fields, baseDir: path.join(root, 'examples') });
  assert.strictEqual(r.label, 'same_decade: age');
  assert.match(r.describe, /same age decade/);
  assert.ok(pass(r, { age: 31 }, { age: 39 }));
  assert.ok(!pass(r, { age: 29 }, { age: 31 }));
  assert.ok(!pass(r, { age: null }, { age: 31 }));
  assert.throws(() => compileRule({ custom: { file: './rules/same_decade.js', field: 'party' } },
    { fields, baseDir: path.join(root, 'examples') }), /needs a number field/, 'the file\'s args schema is enforced');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncchat-rules-'));
  try {
    const write = (name, src) => { fs.writeFileSync(path.join(dir, name), src); return { custom: `./${name}` }; };
    const at = { fields, baseDir: dir };
    assert.throws(() => compileRule(write('no_test.js', 'module.exports = { describe: () => "x" };'), at), /must export/);
    assert.throws(() => compileRule(write('crash.js',
      'module.exports = { describe: () => "x", test: (a) => ({ pass: a.age.toFixed() === "1" }) };'), at),
    /crashed on participants with missing values/);
    assert.throws(() => compileRule(write('bad_return.js', 'module.exports = { describe: () => "x", test: () => true };'), at),
      /must return \{ pass/);
    write('free_args.js',
      'module.exports = { describe: (a) => "have " + a.field + " above " + a.min, test: (a, b, x) => ({ pass: a[x.field] > x.min && b[x.field] > x.min }) };');
    const free = compileRule({ custom: { file: './free_args.js', field: 'age', min: 40 } }, at);
    assert.strictEqual(free.describe, 'have age above 40', 'no schema: arguments passed as written');
    assert.ok(pass(free, { age: 41 }, { age: 50 }));
    assert.ok(!pass(free, { age: 41 }, { age: 30 }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
