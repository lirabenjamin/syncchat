'use strict';

const { sharedItems } = require('./rules');

const PLACEHOLDER = /\{([^{}]*)\}/g;
const VALID = /^(shared|partner|me)\.([A-Za-z_][A-Za-z0-9_]*)$/;

function formatList(items) {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

function formatValue(v) {
  if (Array.isArray(v)) return formatList(v);
  return v === null || v === undefined ? '' : String(v);
}

// List the placeholders in a template as { raw, scope, field }; scope is null if malformed.
function placeholders(template) {
  return [...template.matchAll(PLACEHOLDER)].map(([, raw]) => {
    const m = raw.trim().match(VALID);
    return { raw, scope: m ? m[1] : null, field: m ? m[2] : null };
  });
}

// Render a reveal/intro template from `me`'s point of view.
function render(template, me, partner) {
  return template.replace(PLACEHOLDER, (whole, raw) => {
    const m = raw.trim().match(VALID);
    if (!m) return whole;
    const [, scope, field] = m;
    if (scope === 'shared') return formatList(sharedItems(me[field], partner[field]));
    return formatValue((scope === 'me' ? me : partner)[field]);
  });
}

module.exports = { render, placeholders, formatList };
