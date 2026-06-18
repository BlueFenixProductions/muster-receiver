#!/usr/bin/env node
'use strict';
// muster-console — thin CLI over src/console.js for the `/muster ahoy` bridge.
// The skill shells these subcommands so the war-room I/O runs tested code, not
// ad-hoc curl. Reads config from the environment (see campfire.env).
//
//   muster-console say  "<text>"     post to the room AS THE CONSOLE BOT
//   muster-console poll [afterId]    print messages after afterId as JSON lines
//   muster-console login-check       verify the read (user) credentials
//
// Env: MUSTER_BASE, MUSTER_ROOM_ID, MUSTER_CONSOLE_BOTKEY (write),
//      MUSTER_CONSOLE_EMAIL, MUSTER_CONSOLE_PASSWORD (read).

const { login, say, poll } = require('../src/console');

const env = process.env;
const base = env.MUSTER_BASE || 'https://campfire.bluefenix.net';
const room = env.MUSTER_ROOM_ID;

function die(msg) {
  console.error(`muster-console: ${msg}`);
  process.exit(1);
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (!room && cmd !== 'login-check') die('MUSTER_ROOM_ID is not set');

  if (cmd === 'say') {
    if (!arg) die('usage: muster-console say "<text>"');
    if (!env.MUSTER_CONSOLE_BOTKEY) die('MUSTER_CONSOLE_BOTKEY is not set');
    const r = await say(base, room, env.MUSTER_CONSOLE_BOTKEY, arg);
    if (r.status >= 200 && r.status < 300) return;
    die(`post failed: HTTP ${r.status}`);
  }

  if (cmd === 'poll' || cmd === 'login-check') {
    if (!env.MUSTER_CONSOLE_EMAIL || !env.MUSTER_CONSOLE_PASSWORD) die('MUSTER_CONSOLE_EMAIL/PASSWORD not set');
    const jar = await login(base, env.MUSTER_CONSOLE_EMAIL, env.MUSTER_CONSOLE_PASSWORD);
    if (cmd === 'login-check') return console.log('ok');
    const r = await poll(base, room, jar, arg);
    if (r.status >= 400) die(`poll failed: HTTP ${r.status}`);
    for (const m of r.messages) process.stdout.write(JSON.stringify(m) + '\n');
    return;
  }

  die('usage: muster-console <say|poll|login-check> [arg]');
}

main().catch((e) => die(e && e.message ? e.message : String(e)));
