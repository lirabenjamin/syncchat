'use strict';

// Origin patterns like "https://*.qualtrics.com" or "http://localhost:3000".
// "*." matches one or more subdomain labels; no bare "*" is allowed.
const PATTERN = /^https?:\/\/(\*\.)?[a-z0-9.-]+(:\d+)?$/i;

function isValidPattern(p) {
  return typeof p === 'string' && PATTERN.test(p);
}

function patternToRegexSource(p) {
  const escaped = p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace('*\\.', '(?:[a-z0-9-]+\\.)+');
  return `^${escaped}$`;
}

function makeOriginMatcher(patterns) {
  const regexes = patterns.map((p) => new RegExp(patternToRegexSource(p), 'i'));
  return (origin) => typeof origin === 'string' && regexes.some((re) => re.test(origin));
}

module.exports = { isValidPattern, patternToRegexSource, makeOriginMatcher };
