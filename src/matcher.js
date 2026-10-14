'use strict';

// Turn raw URL params into typed participant fields, per `participant.fields`.
// Missing or unparseable values become null (hard rules on a null field fail).
// Throws if a category value is outside its declared `values`.
function parseFields(params, fieldDefs) {
  const out = {};
  for (const [name, def] of Object.entries(fieldDefs)) {
    const raw = params[name];
    const str = raw === undefined || raw === null ? '' : String(raw).trim();
    if (!str) {
      out[name] = def.type === 'list' ? [] : null;
      continue;
    }
    if (def.type === 'number') {
      const n = Number(str);
      out[name] = Number.isFinite(n) ? n : null;
    } else if (def.type === 'list') {
      out[name] = str.split(def.sep).map((s) => s.trim()).filter(Boolean);
    } else {
      if (def.values && !def.values.includes(str)) {
        throw new Error(`"${str}" is not an allowed value for ${name}`);
      }
      out[name] = str;
    }
  }
  return out;
}

function intersect(lists) {
  return lists.reduce((acc, l) => acc.filter((v) => l.includes(v)));
}

// Evaluate a whole group under a condition. Semantics are "pairwise all": a require rule holds
// for the group only if it holds for every pair in it, and a prefer score is summed over pairs.
// Returns null if a hard rule fails, otherwise which rules held, which were waived by relaxing,
// the items shared by every pair (per rule), and the score vector (one entry per prefer rule).
function evaluateGroup(members, cond, { relaxed, usePrefer }) {
  const pairs = [];
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) pairs.push([members[i], members[j]]);
  }
  const satisfied = [];
  const waived = [];
  const shared = {};
  for (const r of cond.require) {
    const results = pairs.map(([a, b]) => r.test(a, b));
    if (results.every((x) => x.pass)) {
      satisfied.push(r.label);
      if (results.every((x) => x.shared)) shared[r.label] = intersect(results.map((x) => x.shared));
    } else if (r.relaxable && relaxed) waived.push(r.label);
    else return null;
  }
  const scores = usePrefer
    ? cond.prefer.map((r) => pairs.reduce((sum, [a, b]) => sum + r.test(a, b).score, 0))
    : [];
  return { satisfied, waived, shared, scores };
}

function compareScores(x, y) {
  for (let i = 0; i < x.length; i++) {
    if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  }
  return 0;
}

// The group-forming step, and the only dyad-specific code: pick the best waiting partner for
// `searcher` among `candidates` (same condition). Hard rules filter, soft rules rank, earliest
// arrival breaks ties. Relaxation: a group whose longest-waiting member has waited >= relax_after
// drops relaxable hard rules; a searcher who has waited >= relax_after ignores `prefer` (takes the
// first valid partner). Returns { members (earliest arrival first), satisfied, waived, shared,
// scores, prefer } or null.
function formGroup(searcher, candidates, cond, now) {
  const relax = cond.relax_after_ms;
  const usePrefer = relax == null || now - searcher.arrivedAt < relax;
  const ordered = [...candidates].sort((x, y) => x.arrivedAt - y.arrivedAt);
  let best = null;
  for (const c of ordered) {
    const members = [c, searcher].sort((x, y) => x.arrivedAt - y.arrivedAt);
    const relaxed = relax != null && now - Math.min(...members.map((m) => m.arrivedAt)) >= relax;
    const res = evaluateGroup(members.map((m) => m.fields), cond, { relaxed, usePrefer });
    if (res && (!best || compareScores(res.scores, best.scores) > 0)) {
      best = { members, ...res, prefer: usePrefer ? cond.prefer.map((r) => r.label) : [] };
    }
  }
  return best;
}

module.exports = { parseFields, evaluateGroup, formGroup };
