// A custom matching rule: both people are in the same decade of a number field
// (e.g. both in their 30s). Used by examples/advanced-rules.yaml as
//   - custom: {file: ./rules/same_decade.js, field: age}
// A custom rule exports the same shape as a built-in rule (see README, "Adding a rule type").
// test() must handle missing values (null) without crashing; it is called once at startup to check.
module.exports = {
  args: { field: { field: ['number'] } },
  describe: ({ field }) => `be in the same ${field} decade (e.g. both in their 30s)`,
  test: (a, b, { field }) => ({
    pass: a[field] != null && b[field] != null && Math.floor(a[field] / 10) === Math.floor(b[field] / 10),
  }),
};
