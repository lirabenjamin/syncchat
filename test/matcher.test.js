'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { validateConfig } = require('../src/config');
const { parseFields, formGroup, evaluateGroup } = require('../src/matcher');

const config = validateConfig({
  study: { id: 't' },
  participant: { fields: { party: { type: 'category', values: ['D', 'R'] }, top3: { type: 'list' }, age: { type: 'number' } } },
  conditions: {
    cross: {
      require: [{ differ: 'party' }, { overlap: { field: 'top3' }, relaxable: true }],
      prefer: [{ closest: 'age' }],
      relax_after: '10s',
    },
  },
  timing: { match_timeout: '60s', chat_duration: '3m' },
  embed: { allowed_origins: ['https://*.qualtrics.com'] },
});
const cond = config.conditions.cross;
const P = (fields, arrivedAt) => ({ fields: { top3: [], age: null, ...fields }, arrivedAt });

test('parseFields types values and rejects undeclared categories', () => {
  const f = parseFields({ party: 'D', top3: 'a, b ,c', age: '41', extra: 'x' }, config.participant.fields);
  assert.deepStrictEqual(f, { party: 'D', top3: ['a', 'b', 'c'], age: 41 });
  assert.deepStrictEqual(parseFields({}, config.participant.fields), { party: null, top3: [], age: null });
  assert.throws(() => parseFields({ party: 'Green' }, config.participant.fields), /not an allowed value/);
});

test('hard rules filter, soft rules rank, earliest arrival breaks ties', () => {
  const me = P({ party: 'D', top3: ['x'], age: 30 }, 100);
  const sameParty = P({ party: 'D', top3: ['x'], age: 30 }, 1);
  const far = P({ party: 'R', top3: ['x'], age: 60 }, 2);
  const near1 = P({ party: 'R', top3: ['x'], age: 32 }, 4);
  const near2 = P({ party: 'R', top3: ['x'], age: 28 }, 3);
  const pick = formGroup(me, [sameParty, far, near1, near2], cond, 100);
  assert.deepStrictEqual(pick.members, [near2, me], 'earlier arrival first');
  assert.deepStrictEqual(pick.satisfied, ['differ: party', 'overlap: top3']);
  assert.deepStrictEqual(pick.scores, [-2]);
  assert.strictEqual(formGroup(me, [sameParty], cond, 100), null);
});

test('relax_after waives relaxable rules and drops prefer', () => {
  const noOverlap = P({ party: 'R', top3: ['y'], age: 30 }, 0);
  const me = P({ party: 'D', top3: ['x'], age: 30 }, 5000);
  assert.strictEqual(formGroup(me, [noOverlap], cond, 5000), null);
  const pick = formGroup(me, [noOverlap], cond, 10000);
  assert.deepStrictEqual(pick.waived, ['overlap: top3']);

  const late = P({ party: 'D', top3: ['x'], age: 30 }, 0);
  const first = P({ party: 'R', top3: ['x'], age: 70 }, 1);
  const closer = P({ party: 'R', top3: ['x'], age: 31 }, 2);
  assert.strictEqual(formGroup(late, [first, closer], cond, 5000).members[1], closer);
  const relaxed = formGroup(late, [first, closer], cond, 10000);
  assert.strictEqual(relaxed.members[1], first, 'relaxed searcher takes the earliest valid partner');
  assert.deepStrictEqual(relaxed.prefer, []);
});

test('evaluateGroup applies every rule to every pair (pairwise all)', () => {
  const opts = { relaxed: false, usePrefer: true };
  const d1 = { party: 'D', top3: ['x', 'y'], age: 30 };
  const r1 = { party: 'R', top3: ['x', 'y'], age: 33 };
  const r2 = { party: 'R', top3: ['x'], age: 40 };
  const pair = evaluateGroup([d1, r1], cond, opts);
  assert.deepStrictEqual(pair.shared, { 'overlap: top3': ['x', 'y'] });
  assert.deepStrictEqual(pair.scores, [-3]);
  assert.strictEqual(evaluateGroup([d1, r1, r2], cond, opts), null, 'r1 and r2 share a party, so the trio fails');
  const d2 = { party: 'D', top3: ['x'], age: 20 };
  const trio = { ...cond, require: cond.require.slice(1) }; // overlap only
  const res = evaluateGroup([d1, d2, r2], trio, opts);
  assert.deepStrictEqual(res.shared, { 'overlap: top3': ['x'] }, 'items shared by every pair');
  assert.deepStrictEqual(res.scores, [-(10 + 10 + 20)], 'prefer scores sum over pairs');
});
