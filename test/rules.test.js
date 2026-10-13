'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { PRIMITIVES, check, score } = require('../src/rules');

const rule = (kind, arg) => ({ kind, ...PRIMITIVES[kind].parse(arg) });

test('same', () => {
  const r = rule('same', 'party');
  assert.ok(check(r, { party: 'D' }, { party: 'D' }));
  assert.ok(!check(r, { party: 'D' }, { party: 'R' }));
  assert.ok(!check(r, { party: null }, { party: null }), 'missing values never match');
});

test('differ', () => {
  const r = rule('differ', 'party');
  assert.ok(check(r, { party: 'D' }, { party: 'R' }));
  assert.ok(!check(r, { party: 'D' }, { party: 'D' }));
  assert.ok(!check(r, { party: 'D' }, { party: null }));
});

test('equals', () => {
  const r = rule('equals', { field: 'party', value: 'D' });
  assert.ok(check(r, { party: 'D' }, { party: 'D' }));
  assert.ok(!check(r, { party: 'D' }, { party: 'R' }));
  assert.throws(() => rule('equals', { field: 'party' }), /value/);
});

test('overlap', () => {
  const r = rule('overlap', { field: 't', min: 2 });
  assert.ok(check(r, { t: ['a', 'b', 'c'] }, { t: ['b', 'c'] }));
  assert.ok(!check(r, { t: ['a', 'b'] }, { t: ['b', 'x'] }));
  assert.strictEqual(score(r, { t: ['a', 'b', 'c'] }, { t: ['c', 'b', 'a'] }), 3);
  assert.strictEqual(rule('overlap', { field: 't' }).min, 1, 'min defaults to 1');
  assert.throws(() => rule('overlap', { field: 't', min: 0 }), /min/);
});

test('within', () => {
  const r = rule('within', { field: 'age', max: 5 });
  assert.ok(check(r, { age: 30 }, { age: 35 }));
  assert.ok(!check(r, { age: 30 }, { age: 36 }));
  assert.ok(!check(r, { age: 30 }, { age: null }));
  assert.strictEqual(score(r, { age: 30 }, { age: 31 }), 1);
});

test('closest', () => {
  const r = rule('closest', 'age');
  assert.ok(PRIMITIVES.closest.softOnly);
  assert.ok(score(r, { age: 30 }, { age: 32 }) > score(r, { age: 30 }, { age: 40 }));
  assert.strictEqual(score(r, { age: 30 }, { age: null }), -Infinity);
});
