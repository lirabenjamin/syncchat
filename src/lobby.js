'use strict';

const { formGroup } = require('./matcher');

// The waiting room: who is waiting in each condition, when to retry matching, when to give up.
// Shared by the live server (real clock) and `npm run simulate` (simulated clock), so a
// simulation runs exactly the matching logic participants will get.
//   clock      { now(), setTimer(fn, ms) -> handle, clearTimer(handle) }
//   onMatch    ({ cond, members, satisfied, waived, shared, scores, prefer, at }) once a group forms
//   onTimeout  (entry, waitedMs) when someone waits match_timeout without a partner
// An entry is any object with { cond, fields }; the lobby sets entry.arrivedAt.
function createLobby(config, { clock, onMatch, onTimeout }) {
  const waiting = Object.fromEntries(Object.keys(config.conditions).map((c) => [c, []]));

  function remove(entry) {
    const q = waiting[entry.cond];
    const i = q.indexOf(entry);
    if (i >= 0) q.splice(i, 1);
    clock.clearTimer(entry.relaxTimer);
    clock.clearTimer(entry.timeoutTimer);
  }

  function tryMatch(entry) {
    const now = clock.now();
    const pool = waiting[entry.cond].filter((e) => e !== entry);
    const group = formGroup(entry, pool, config.conditions[entry.cond], now);
    if (!group) return false;
    for (const m of group.members) remove(m);
    onMatch({ cond: entry.cond, ...group, at: now });
    return true;
  }

  function join(entry) {
    entry.arrivedAt = clock.now();
    if (tryMatch(entry)) return;
    waiting[entry.cond].push(entry);
    const relaxMs = config.conditions[entry.cond].relax_after_ms;
    if (relaxMs !== null) entry.relaxTimer = clock.setTimer(() => tryMatch(entry), relaxMs);
    entry.timeoutTimer = clock.setTimer(() => {
      remove(entry);
      onTimeout(entry, clock.now() - entry.arrivedAt);
    }, config.timing.match_timeout_ms);
  }

  return {
    join,
    leave: remove,
    counts: () => Object.fromEntries(Object.entries(waiting).map(([c, q]) => [c, q.length])),
    clear: () => Object.values(waiting).flat().forEach(remove),
  };
}

module.exports = { createLobby };
