'use strict';
const path = require('path');
const { wakeAgent, buildPrompt } = require('../src/agent');

const FAKE = path.join(__dirname, 'fixtures', 'fake-claude.sh');

const AGENT = { slug: 'ironquill', name: 'ironquill', cwd: process.cwd(), persona: 'be terse', model: 'sonnet' };
const MSG = { roomName: 'muster', user: { name: 'Captain' }, text: 'status?' };

describe('buildPrompt', () => {
  test('names the agent, the asker, and carries the message text', () => {
    const p = buildPrompt(AGENT, MSG);
    expect(p).toMatch(/You are "ironquill"/);
    expect(p).toMatch(/Captain just addressed you/);
    expect(p).toMatch(/status\?/);
    expect(p).toMatch(/system\s+posts it for you/); // tells the agent not to self-post
  });

  test('folds in recent conversation when context is supplied', () => {
    const ctx = [
      { author: 'Captain', text: 'should we bump rikudo ctx to 16k?' },
      { author: 'hinata', text: 'bench says 16k is stable' },
    ];
    const p = buildPrompt(AGENT, MSG, { context: ctx });
    expect(p).toMatch(/Recent conversation/);
    expect(p).toMatch(/Captain: should we bump rikudo ctx to 16k\?/);
    expect(p).toMatch(/hinata: bench says 16k is stable/);
    expect(p).toMatch(/just @mentioned/);
  });
});

describe('wakeAgent', () => {
  test('spawns claude, feeds the prompt on stdin, resolves with stdout', async () => {
    const out = await wakeAgent(AGENT, MSG, { claudeBin: FAKE });
    // fake-claude echoes the head of the stdin prompt back.
    expect(out).toMatch(/^ack: You are "ironquill"/);
  });

  test('rejects when claude exits non-zero', async () => {
    await expect(
      wakeAgent(AGENT, MSG, { claudeBin: FAKE, spawn: spawnWithExit(1) })
    ).rejects.toThrow(/exited 1/);
  });
});

// spawn wrapper that injects FAKE_CLAUDE_EXIT so the stub fails on cue.
function spawnWithExit(code) {
  const { spawn } = require('child_process');
  return (bin, args, opts) =>
    spawn(bin, args, { ...opts, env: { ...process.env, ...(opts && opts.env), FAKE_CLAUDE_EXIT: String(code) } });
}
