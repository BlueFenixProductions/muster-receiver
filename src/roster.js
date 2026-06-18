'use strict';
// Agent roster — slug → identity. Distinct identity PER agent is muster's hard
// rule: a shared identity is crossed wires. The webhook URL path segment
// (/campfire/<slug>) selects which agent was addressed; an UNKNOWN slug is
// rejected (resolveAgent → null). We never wake a default identity, because a
// default identity is exactly the crossed wire the rule forbids.

const fs = require('fs');
const path = require('path');

const DEFAULT_FILE = path.join(__dirname, '..', 'roster.json');

function rosterFile(file) {
  return file || process.env.ROSTER_FILE || DEFAULT_FILE;
}

// Read + parse the roster. Throws on a missing/corrupt file — the caller fails
// closed (does not wake an agent) rather than guessing an identity.
function loadRoster(file) {
  const raw = fs.readFileSync(rosterFile(file), 'utf8');
  const data = JSON.parse(raw);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('roster must be a JSON object of slug → identity');
  }
  return data;
}

function resolveAgent(slug, roster) {
  const a = roster && roster[slug];
  if (!a) return null;
  return {
    slug,
    name: a.name || slug,
    cwd: a.cwd || process.cwd(),
    persona: a.persona || '',
    model: a.model || null,
  };
}

module.exports = { loadRoster, resolveAgent, rosterFile, DEFAULT_FILE };
