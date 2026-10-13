'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { render, placeholders, formatList } = require('../src/reveal');

test('formatList', () => {
  assert.strictEqual(formatList([]), '');
  assert.strictEqual(formatList(['pizza']), 'pizza');
  assert.strictEqual(formatList(['pizza', 'tacos']), 'pizza and tacos');
  assert.strictEqual(formatList(['a', 'b', 'c']), 'a, b, and c');
});

test('shared, partner, and me placeholders', () => {
  const me = { top3: ['pizza', 'tacos', 'sushi'], party: 'Democrat', age: 30 };
  const them = { top3: ['sushi', 'ramen', 'pizza'], party: 'Republican', age: 41 };
  assert.strictEqual(
    render('You both picked {shared.top3}. You: {me.party}, partner: {partner.party}, age {partner.age}.', me, them),
    'You both picked pizza and sushi. You: Democrat, partner: Republican, age 41.',
  );
});

test('placeholders flags malformed ones', () => {
  const ps = placeholders('{shared.top3} {partner.age} {oops}');
  assert.deepStrictEqual(ps.map((p) => p.scope), ['shared', 'partner', null]);
});
