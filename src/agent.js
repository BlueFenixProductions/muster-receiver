'use strict';
// wakeAgent — wake a `claude -p` headless run AS the addressed agent and return
// its reply text. Identity (persona, cwd, model) comes from the roster entry, so
// every agent answers as itself: no crossed wires. The prompt goes in on stdin
// (not argv) to dodge ARG_MAX and quoting. The spawn is injectable for tests.

const { spawn } = require('child_process');

function claudeBin(opts) {
  return (opts && opts.claudeBin) || process.env.CLAUDE_BIN || 'claude';
}

function agentTimeout(opts) {
  return (opts && opts.timeoutMs) || Number(process.env.AGENT_TIMEOUT_MS) || 300000;
}

function buildPrompt(agent, msg, opts = {}) {
  const ctx = (opts.context || []).filter((m) => m && m.text);
  const lines = [
    `You are "${agent.name}", a participant in the live muster war room (Campfire room: ${msg.roomName || 'muster'}).`,
  ];
  if (ctx.length) {
    lines.push('', 'Recent conversation (oldest first):');
    for (const m of ctx) lines.push(`${m.author || 'someone'}: ${m.text}`);
    lines.push('', 'You were just @mentioned. Reply to the message addressed to you, in the context above.');
  } else {
    lines.push(`${msg.user.name || 'Someone'} just addressed you:`, '', msg.text);
  }
  lines.push(
    '',
    'Write your reply to the room. Your reply is the text you output here — the system',
    'posts it for you automatically, so do NOT try to send it, do not mention webhooks,',
    'tokens, config files, or how messages are delivered. Just answer as yourself, in',
    'plain text: no preamble, no markdown fences, no sign-off. Be terse (1-3 sentences',
    'unless more is clearly needed).'
  );
  return lines.join('\n');
}

function wakeAgent(agent, msg, opts = {}) {
  const _spawn = opts.spawn || spawn;
  const bin = claudeBin(opts);
  const timeoutMs = agentTimeout(opts);
  const args = ['-p'];
  if (agent.persona) args.push('--append-system-prompt', agent.persona);
  if (agent.model) args.push('--model', agent.model);
  const prompt = (opts.buildPrompt || buildPrompt)(agent, msg, opts);

  return new Promise((resolve, reject) => {
    const child = _spawn(bin, args, { cwd: agent.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let settled = false;
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(v);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, new Error(`agent ${agent.slug} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('error', (e) => finish(reject, e));
    child.on('close', (code) => {
      if (code === 0) finish(resolve, out.trim());
      else finish(reject, new Error(`agent ${agent.slug} exited ${code}: ${(err.trim() || out.trim()).slice(0, 500)}`));
    });
    child.stdin.on('error', () => {}); // EPIPE if claude exits before reading stdin
    child.stdin.end(prompt);
  });
}

module.exports = { wakeAgent, buildPrompt };
