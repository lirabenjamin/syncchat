'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { loadConfig, validateConfig, parseDuration, ConfigError } = require('../src/config');

const root = path.join(__dirname, '..');
const base = () => yaml.load(fs.readFileSync(path.join(root, 'study.yaml'), 'utf8'));

function expectError(mutate, pattern) {
  const raw = base();
  mutate(raw);
  assert.throws(() => validateConfig(raw), (e) => e instanceof ConfigError && e.errors.some((m) => pattern.test(m)),
    `expected an error matching ${pattern}`);
}

test('study.yaml and every example validate', () => {
  const files = ['study.yaml', ...fs.readdirSync(path.join(root, 'examples')).filter((f) => f.endsWith('.yaml')).map((f) => `examples/${f}`)];
  assert.ok(files.length >= 5);
  for (const f of files) assert.doesNotThrow(() => loadConfig(path.join(root, f)), f);
});

test('normalizes study.yaml', () => {
  const c = loadConfig(path.join(root, 'study.yaml'));
  assert.strictEqual(c.timing.match_timeout_ms, 60000);
  assert.strictEqual(c.conditions.cross.relax_after_ms, 30000);
  assert.deepStrictEqual(c.conditions.cross.require.map((r) => r.label), ['differ: party', 'overlap: top3']);
  assert.strictEqual(c.conditions.same.reveal, false);
  assert.strictEqual(c.limits.max_message_length, 500);
});

test('relaxable may sit beside the rule or inside its argument', () => {
  const c = loadConfig(path.join(root, 'examples/shared-top3.yaml'));
  assert.deepStrictEqual(c.conditions.shared.require.map((r) => r.relaxable), [false, true]);
  assert.match(c.conditions.shared.require[1].describe, /within 15/);
});

test('parseDuration', () => {
  assert.strictEqual(parseDuration('30s'), 30000);
  assert.strictEqual(parseDuration('2m'), 120000);
  assert.strictEqual(parseDuration('250ms'), 250);
  assert.strictEqual(parseDuration(5), 5000);
  assert.strictEqual(parseDuration('soon'), null);
});

test('bad configs give clear errors', () => {
  expectError((c) => { c.study.group_size = 3; }, /group_size: only 2 is supported/);
  expectError((c) => { c.conditions.cross.require.push({ differ: 'religion' }); }, /unknown field "religion"/);
  expectError((c) => { c.conditions.cross.require.push({ resemble: 'party' }); }, /unknown rule "resemble"/);
  expectError((c) => { c.conditions.cross.require.push({ overlap: { field: 'age' } }); }, /needs a list field/);
  expectError((c) => { c.conditions.cross.require.push({ closest: 'age' }); }, /belongs under prefer/);
  expectError((c) => { c.conditions.cross.require.push({ same: 'party', differ: 'party' }); }, /exactly one rule/);
  expectError((c) => { c.conditions.cross.require.push({ equals: { field: 'party', value: 'Green' } }); }, /not one of party's values/);
  expectError((c) => { c.conditions.cross.prefer.push({ closest: 'age', relaxable: true }); }, /only applies to require/);
  expectError((c) => { c.conditions.cross.relax_after = '2m'; }, /shorter than timing.match_timeout/);
  expectError((c) => { c.conditions.cross.reveal = 'Both like {shared.age}'; }, /needs a list field/);
  expectError((c) => { c.conditions.cross.reveal = 'Hi {partner.zodiac}'; }, /unknown field "zodiac"/);
  expectError((c) => { c.conditions.cross.relax_afer = '10s'; }, /relax_afer: unknown key/);
  expectError((c) => { c.participant.fields.age.type = 'integer'; }, /needs a type/);
  expectError((c) => { c.timing.chat_duration = 'three minutes'; }, /not a duration/);
  expectError((c) => { c.on_timeout = 'bot'; }, /not supported yet/);
  expectError((c) => { c.embed.allowed_origins = ['*']; }, /no bare \*/);
  expectError((c) => { c.conditions = {}; }, /at least one condition/);
  expectError((c) => { c.conditions.cross.require.push({ any_of: [{ same: 'party' }] }); }, /at least 2 rules/);
  expectError((c) => { c.conditions.cross.require.push({ any_of: [{ same: 'party' }, { closest: 'age' }] }); }, /rules\[1\]: "closest" only ranks/);
  expectError((c) => { c.conditions.cross.require.push({ not: { differ: 'zodiac' } }); }, /unknown field "zodiac"/);
  expectError((c) => { c.conditions.cross.require.push({ overlap: { field: 'top3', mn: 2 } }); }, /unknown argument\(s\) mn/);
  expectError((c) => { c.conditions.cross.require.push({ custom: './nope.js' }); }, /file not found/);
});

test('all errors are reported at once', () => {
  const raw = base();
  raw.study.group_size = 3;
  raw.timing.match_timeout = 'x';
  assert.throws(() => validateConfig(raw), (e) => e.errors.length === 2);
});

test('missing file and YAML syntax errors', () => {
  assert.throws(() => loadConfig(path.join(root, 'nope.yaml')), /file not found/);
});
