'use strict';

// Plain-English summary of a validated config, printed by `npm run explain`.

function formatDuration(ms) {
  if (ms > 0 && ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return s % 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s / 60}m`;
}

// "(1) a AND (2) b" for several items, just "a" for one.
function numbered(items, joiner) {
  if (items.length === 1) return items[0];
  return items.map((x, i) => `(${i + 1}) ${x}`).join(joiner);
}

function explainCondition(name, cond) {
  const req = cond.require;
  const parts = [];
  parts.push(req.length
    ? `Condition "${name}": partners must ${numbered(req.map((r) => r.describe), ' AND ')}.`
    : `Condition "${name}": any two participants in this condition can be partners.`);
  parts.push(cond.prefer.length
    ? `Among valid partners, rank by ${numbered(cond.prefer.map((r) => r.rank), ', then ')}; ties go to whoever has waited longest.`
    : 'The valid partner who has waited longest is chosen.');

  if (cond.relax_after_ms !== null) {
    const dropped = [];
    const relaxable = req.map((r, i) => (r.relaxable ? (req.length > 1 ? `rule (${i + 1})` : 'the rule') : null)).filter(Boolean);
    if (relaxable.length) dropped.push(`${relaxable.join(' and ')} ${relaxable.length > 1 ? 'are' : 'is'} dropped for pairs that include them`);
    if (cond.prefer.length) dropped.push('preferences are dropped (they take the first valid partner)');
    if (dropped.length) parts.push(`After someone has waited ${formatDuration(cond.relax_after_ms)}, ${dropped.join(' and ')}.`);
  }
  parts.push(cond.reveal ? `Participants see: "${cond.reveal}"` : 'Participants are not told why they were matched.');
  return parts.join(' ');
}

// How one chat stage runs and ends, e.g. "lasts 5m" or "has no time limit and ends when both click Done".
function describeChat(st) {
  const who = st.end_when === 'both_done' ? 'both participants click Done' : 'either participant clicks Done';
  const parts = [];
  if (st.chat_duration_ms === null) parts.push(`has no time limit and ends when ${who} (at most ${formatDuration(st.max_duration_ms)})`);
  else if (st.end_when === 'timer') parts.push(`lasts ${formatDuration(st.chat_duration_ms)}`);
  else parts.push(`lasts up to ${formatDuration(st.chat_duration_ms)}, or until ${who}`);
  if (st.min_messages > 0) {
    const n = `${st.min_messages} message${st.min_messages > 1 ? 's' : ''}`;
    if (st.end_when !== 'timer') parts.push(`Done unlocks once that person has sent ${n}`);
    else if (st.extend_until_min_ms) parts.push(`if someone has sent fewer than ${n} when time runs out, it runs up to ${formatDuration(st.extend_until_min_ms)} longer until both have`);
    else parts.push(`whether each person sent at least ${n} is recorded (met_min_messages)`);
  }
  return parts.join('; ');
}

// The chat a condition runs: one sentence, or one per stage.
function describeStages(cond) {
  if (!cond.staged) return [`The chat ${describeChat(cond.stages[0])}.`];
  const n = cond.stages.length;
  const lines = [`The chat has ${n} stages with the same partner.`];
  cond.stages.forEach((st, i) => {
    let line = `Stage ${i + 1} "${st.id}" ${describeChat(st)}.`;
    if (st.prompt) line += ` Prompt: "${st.prompt}"`;
    if (st.reveal && i > 0) line += ` Banner: "${st.reveal}"`;
    if (st.then === 'continue') line += ` Then stage ${i + 2} starts in the same chat window.`;
    if (st.then === 'qualtrics') {
      line += ` Then the survey moves on; a later chat question (stage=${cond.stages[i + 1].id}) reunites the same pair for stage ${i + 2}. ` +
        `Whoever returns waits up to ${formatDuration(cond.timing.rejoin_timeout_ms)} for the partner, or the chat ends (outcome: partner_left).`;
    }
    lines.push(line);
  });
  return lines;
}

function explainConfig(config) {
  const { study, participant, conditions } = config;
  const fields = Object.entries(participant.fields).map(([k, d]) =>
    `${k} (${d.type}${d.values ? `: ${d.values.join(', ')}` : ''})`);
  const lines = [
    `Study "${study.id}": groups of ${study.group_size}. Every rule must hold for every pair in a group.`,
    `Fields from Qualtrics: ${fields.length ? fields.join('; ') : 'none'}.`,
  ];
  const names = Object.keys(conditions);
  if (names.length > 1) {
    lines.push(`Participants only match within their own condition (URL parameter "${participant.condition_param}").`);
  }
  // Timing shared by every condition is stated once at the end; otherwise each condition states its own.
  const chats = names.map((n) => describeStages(conditions[n]));
  const waits = names.map((n) => conditions[n].timing.match_timeout_ms);
  const sameChat = chats.every((c) => c.join() === chats[0].join());
  const sameWait = waits.every((w) => w === waits[0]);
  const noMatch = (ms) => `Anyone without a partner after ${formatDuration(ms)} sees a "no partner" screen (outcome: nomatch).`;
  lines.push('');
  names.forEach((name, i) => {
    lines.push(explainCondition(name, conditions[name]));
    if (!sameWait) lines.push(noMatch(waits[i]));
    if (!sameChat) lines.push(...chats[i]);
  });
  lines.push('');
  const simple = sameChat && !conditions[names[0]].staged;
  const last = [];
  if (sameWait) last.push(noMatch(waits[0]));
  if (simple) last.push(chats[0][0].replace(/^The chat lasts /, 'Chats last '));
  if (last.length) lines.push(last.join(' '));
  if (sameChat && !simple) lines.push(...chats[0]);
  return lines.join('\n');
}

module.exports = { explainConfig, formatDuration };
