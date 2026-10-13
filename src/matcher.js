'use strict';

const rules = require('./rules');

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

const label = (r) => `${r.kind}: ${r.field}`;

// Evaluate one candidate pair under a condition.
// Returns null if a hard rule fails, otherwise which rules held, which were waived, and the
// soft-score vector (one entry per `prefer` rule, compared in order).
function evaluatePair(a, b, cond, { pairRelaxed, usePrefer }) {
  const satisfied = [];
  const waived = [];
  for (const r of cond.require) {
    if (rules.check(r, a, b)) satisfied.push(label(r));
    else if (r.relaxable && pairRelaxed) waived.push(label(r));
    else return null;
  }
  const scores = usePrefer ? cond.prefer.map((r) => rules.score(r, a, b)) : [];
  return { satisfied, waived, scores };
}

function compareScores(x, y) {
  for (let i = 0; i < x.length; i++) {
    if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  }
  return 0;
}

// Pick the best waiting partner for `searcher` among `candidates` (same condition).
// Hard rules filter, soft rules rank, earliest arrival breaks ties.
// Relaxation: a pair whose longer-waiting member has waited >= relax_after drops relaxable
// hard rules; a searcher who has waited >= relax_after ignores `prefer` (takes the first
// valid partner).
function pickPartner(searcher, candidates, cond, now) {
  const relax = cond.relax_after_ms;
  const usePrefer = relax == null || now - searcher.arrivedAt < relax;
  const ordered = [...candidates].sort((x, y) => x.arrivedAt - y.arrivedAt);
  let best = null;
  for (const c of ordered) {
    const pairRelaxed = relax != null && now - Math.min(searcher.arrivedAt, c.arrivedAt) >= relax;
    const res = evaluatePair(searcher.fields, c.fields, cond, { pairRelaxed, usePrefer });
    if (res && (!best || compareScores(res.scores, best.scores) > 0)) {
      best = { partner: c, ...res, prefer: usePrefer ? cond.prefer.map(label) : [] };
    }
  }
  return best;
}

module.exports = { parseFields, pickPartner };
