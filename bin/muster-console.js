#!/usr/bin/env node
'use strict';
// muster-console — thin CLI over src/console.js for the `/muster ahoy` bridge.
// The skill shells these subcommands so the war-room I/O runs tested code, not
// ad-hoc curl. Reads config from the environment (see campfire.env).
//
//   muster-console say  "<text>"           post to the room AS THE CONSOLE BOT
//   muster-console poll [afterId]          print messages after afterId as JSON lines
//   muster-console watch [afterId] [--for N] [--once] [--interval S]
//                                          stream new messages (not your own) as
//                                          JSON lines until --for seconds elapse
//                                          (default: forever) or --once sees one
//   muster-console login-check             verify the read (user) credentials
//
// Env: MUSTER_BASE, MUSTER_ROOM_ID, MUSTER_CONSOLE_BOTKEY (write),
//      MUSTER_CONSOLE_EMAIL, MUSTER_CONSOLE_PASSWORD (read).

const { login, say, poll, watch } = require('../src/console');

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

  if (cmd === 'poll' || cmd === 'login-check' || cmd === 'watch') {
    if (!env.MUSTER_CONSOLE_EMAIL || !env.MUSTER_CONSOLE_PASSWORD) die('MUSTER_CONSOLE_EMAIL/PASSWORD not set');
    const signIn = () => login(base, env.MUSTER_CONSOLE_EMAIL, env.MUSTER_CONSOLE_PASSWORD);
    let jar = await signIn();
    if (cmd === 'login-check') return console.log('ok');
    if (cmd === 'poll') {
      const r = await poll(base, room, jar, arg);
      if (r.status >= 400) die(`poll failed: HTTP ${r.status}`);
      for (const m of r.messages) process.stdout.write(JSON.stringify(m) + '\n');
      return;
    }

    // watch — parse [afterId] [--for N] [--once] [--interval S]
    const rest = process.argv.slice(3);
    const num = (flag) => {
      const i = rest.indexOf(flag);
      return i >= 0 ? Number(rest[i + 1]) : undefined;
    };
    const afterId = rest.find((a) => /^\d+$/.test(a));
    const forSec = num('--for');
    const intervalSec = num('--interval');
    const onMessage = (m) => process.stdout.write(JSON.stringify(m) + '\n');
    const emit = (line) => process.stderr.write(line + '\n');

    // Loop so an expired session re-logs-in and resumes from the cursor.
    let cursor = afterId != null ? Number(afterId) : undefined;
    const overallDeadline = forSec ? Date.now() + forSec * 1000 : Infinity;
    for (;;) {
      const res = await watch({
        base, roomId: room, cookie: jar, botKey: env.MUSTER_CONSOLE_BOTKEY,
        afterId: cursor,
        intervalMs: (intervalSec || 3) * 1000,
        forMs: overallDeadline === Infinity ? Infinity : Math.max(0, overallDeadline - Date.now()),
        once: rest.includes('--once'),
        onMessage,
      });
      cursor = res.cursor;
      if (res.stopped === 'unauthorized') {
        emit('[watch] session expired — re-authenticating');
        jar = await signIn();
        continue;
      }
      // Emit the resume cursor so the JOIN loop threads it into the next watch
      // (`watch <cursor> ...`) — no replay of messages already seen.
      emit(`[watch] cursor=${cursor}`);
      return;
    }
  }

  die('usage: muster-console <say|poll|watch|login-check> [arg]');
}

main().catch((e) => die(e && e.message ? e.message : String(e)));
