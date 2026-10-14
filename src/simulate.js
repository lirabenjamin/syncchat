'use strict';

const { parseFields } = require('./matcher');
const { createLobby } = require('./lobby');
const reveal = require('./reveal');
const { formatDuration } = require('./explain');

// Minimal CSV reader: header row, comma-separated, double quotes around cells that contain
// commas (e.g. a list field: "pizza,tacos"). Returns one object per row.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c !== '')) rows.push(row);
  const [header = [], ...body] = rows;
  const cols = header.map((h) => h.trim());
  return body.map((r) => Object.fromEntries(cols.map((c, i) => [c, (r[i] ?? '').trim()])));
}

// Discrete-event clock: timers run in time order (then in the order they were set).
function simulatedClock() {
  let t = 0;
  let seq = 0;
  const queue = [];
  return {
    now: () => t,
    setTimer(fn, ms) {
      const ev = { at: t + ms, seq: seq++, fn };
      queue.push(ev);
      return ev;
    },
    clearTimer(ev) {
      if (ev) ev.cancelled = true;
    },
    run() {
      while (queue.length) {
        queue.sort((x, y) => x.at - y.at || x.seq - y.seq);
        const ev = queue.shift();
        if (ev.cancelled) continue;
        t = ev.at;
        ev.fn();
      }
    },
  };
}

// Run the real lobby over a list of arrivals (rows from people.csv) in simulated time.
// Each row needs the id and condition columns named in `participant`, the declared fields,
// and arrival_s (seconds from the start). Returns { events, skipped, summary }.
function simulate(config, rows) {
  const { id_param: idCol, condition_param: condCol, fields } = config.participant;
  const condNames = Object.keys(config.conditions);
  const clock = simulatedClock();
  const events = [];
  const skipped = [];
  const summary = Object.fromEntries(condNames.map((c) => [c, { arrivals: 0, matched: 0, timed_out: 0 }]));

  const lobby = createLobby(config, {
    clock,
    onMatch: ({ cond, members, satisfied, waived, shared, scores, at }) => {
      const tmpl = config.conditions[cond].reveal;
      events.push({
        type: 'match', at, cond, satisfied, waived, shared, scores,
        members: members.map((m) => ({
          id: m.id,
          waited_ms: at - m.arrivedAt,
          reveal: tmpl ? reveal.render(tmpl, m.fields, members.find((x) => x !== m).fields) : null,
        })),
      });
      summary[cond].matched += members.length;
    },
    onTimeout: (entry, waitedMs) => {
      events.push({ type: 'timeout', at: clock.now(), cond: entry.cond, id: entry.id, waited_ms: waitedMs });
      summary[entry.cond].timed_out += 1;
    },
  });

  rows.forEach((row, i) => {
    const id = row[idCol] || `row${i + 2}`;
    const cond = row[condCol] || (condNames.length === 1 ? condNames[0] : '');
    const arrival = Number(row.arrival_s);
    if (!condNames.includes(cond)) return skipped.push({ id, reason: `condition "${cond}" is not in this config` });
    if (row.arrival_s === undefined || row.arrival_s === '' || !Number.isFinite(arrival) || arrival < 0) {
      return skipped.push({ id, reason: 'arrival_s must be a number of seconds >= 0' });
    }
    let parsed;
    try {
      parsed = parseFields(row, fields);
    } catch (e) {
      return skipped.push({ id, reason: e.message });
    }
    clock.setTimer(() => {
      summary[cond].arrivals += 1;
      lobby.join({ id, cond, fields: parsed });
    }, arrival * 1000);
  });
  clock.run();
  return { events, skipped, summary };
}

const secs = (ms) => `${(ms / 1000).toFixed(ms % 1000 ? 1 : 0)}s`;

function formatSimulation({ events, skipped, summary }) {
  const out = [];
  for (const e of events) {
    if (e.type === 'match') {
      const ids = e.members.map((m) => m.id).join(' + ');
      out.push(`t=${secs(e.at).padEnd(6)} MATCH    [${e.cond}] ${ids}`);
      const rules = e.satisfied.map((r) => (e.shared[r] ? `${r} (shared: ${e.shared[r].join(', ')})` : r));
      out.push(`           rules: ${rules.length ? rules.join('; ') : 'none'}${e.waived.length ? `; waived: ${e.waived.join('; ')}` : ''}`);
      if (e.scores.length) out.push(`           prefer scores: [${e.scores.join(', ')}]`);
      out.push(`           waited: ${e.members.map((m) => `${m.id} ${formatDuration(m.waited_ms)}`).join(', ')}`);
      for (const m of e.members) if (m.reveal) out.push(`           ${m.id} sees: "${m.reveal}"`);
    } else {
      out.push(`t=${secs(e.at).padEnd(6)} TIMEOUT  [${e.cond}] ${e.id} (waited ${formatDuration(e.waited_ms)}, no partner)`);
    }
  }
  if (skipped.length) {
    out.push('', `Skipped ${skipped.length} row(s):`);
    for (const s of skipped) out.push(`  ${s.id}: ${s.reason}`);
  }
  out.push('', 'Summary', '  condition        arrivals  matched  timed out  match rate');
  for (const [c, s] of Object.entries(summary)) {
    const rate = s.arrivals ? `${Math.round((100 * s.matched) / s.arrivals)}%` : '-';
    out.push(`  ${c.padEnd(16)} ${String(s.arrivals).padStart(8)} ${String(s.matched).padStart(8)} ${String(s.timed_out).padStart(10)} ${rate.padStart(11)}`);
  }
  return out.join('\n');
}

module.exports = { simulate, formatSimulation, parseCsv };
