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

function explainConfig(config) {
  const { study, participant, timing, conditions } = config;
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
  lines.push('');
  for (const name of names) lines.push(explainCondition(name, conditions[name]));
  lines.push('');
  lines.push(`Anyone without a partner after ${formatDuration(timing.match_timeout_ms)} sees a "no partner" screen (outcome: nomatch). Chats last ${formatDuration(timing.chat_duration_ms)}.`);
  return lines.join('\n');
}

module.exports = { explainConfig, formatDuration };
