'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadRoster, resolveAgent } = require('../src/roster');

function tmpRoster(obj) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'roster-')), 'roster.json');
  fs.writeFileSync(f, JSON.stringify(obj));
  return f;
}

describe('loadRoster', () => {
  test('reads a slug → identity object', () => {
    const f = tmpRoster({ ironquill: { name: 'ironquill' } });
    expect(loadRoster(f)).toEqual({ ironquill: { name: 'ironquill' } });
  });

  test('throws on a non-object roster (fails closed)', () => {
    const f = tmpRoster([1, 2, 3]);
    expect(() => loadRoster(f)).toThrow(/object of slug/);
  });

  test('throws on a missing file (fails closed)', () => {
    expect(() => loadRoster('/no/such/roster.json')).toThrow();
  });
});

describe('resolveAgent', () => {
  const roster = {
    ironquill: { name: 'ironquill', model: 'sonnet', cwd: '/tmp/iq', persona: 'be terse' },
    bare: {},
  };

  test('returns the full identity for a known slug', () => {
    expect(resolveAgent('ironquill', roster)).toEqual({
      slug: 'ironquill',
      name: 'ironquill',
      model: 'sonnet',
      cwd: '/tmp/iq',
      persona: 'be terse',
    });
  });

  test('applies defaults for sparse entries', () => {
    const a = resolveAgent('bare', roster);
    expect(a.name).toBe('bare'); // falls back to slug
    expect(a.persona).toBe('');
    expect(a.model).toBeNull();
    expect(a.cwd).toBe(process.cwd());
  });

  test('returns null for an unknown slug (never a default identity)', () => {
    expect(resolveAgent('ghost', roster)).toBeNull();
  });
});
