'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { validateConfig } = require('../src/config');
const { parseFields, pickPartner } = require('../src/matcher');

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
  const pick = pickPartner(me, [sameParty, far, near1, near2], cond, 100);
  assert.strictEqual(pick.partner, near2);
  assert.deepStrictEqual(pick.satisfied, ['differ: party', 'overlap: top3']);
  assert.deepStrictEqual(pick.scores, [-2]);
  assert.strictEqual(pickPartner(me, [sameParty], cond, 100), null);
});

test('relax_after waives relaxable rules and drops prefer', () => {
  const noOverlap = P({ party: 'R', top3: ['y'], age: 30 }, 0);
  const me = P({ party: 'D', top3: ['x'], age: 30 }, 5000);
  assert.strictEqual(pickPartner(me, [noOverlap], cond, 5000), null);
  const pick = pickPartner(me, [noOverlap], cond, 10000);
  assert.deepStrictEqual(pick.waived, ['overlap: top3']);

  const late = P({ party: 'D', top3: ['x'], age: 30 }, 0);
  const first = P({ party: 'R', top3: ['x'], age: 70 }, 1);
  const closer = P({ party: 'R', top3: ['x'], age: 31 }, 2);
  assert.strictEqual(pickPartner(late, [first, closer], cond, 5000).partner, closer);
  const relaxed = pickPartner(late, [first, closer], cond, 10000);
  assert.strictEqual(relaxed.partner, first, 'relaxed searcher takes the earliest valid partner');
  assert.deepStrictEqual(relaxed.prefer, []);
});
