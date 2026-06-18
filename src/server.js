'use strict';
// muster-receiver — the war room's wake trigger.
//
// Campfire (madara) POSTs a webhook when one of our bots is @mentioned. We ACK
// within Campfire's 7s ENDPOINT_TIMEOUT (HTTP 204 — no inline reply), then wake
// the addressed agent with `claude -p` and post its reply back out-of-band to
// room.path. The agent run takes far longer than 7s; the ack-then-async split is
// the whole point.
//
// Routing: POST /campfire/<agent-slug>  → roster[slug] picks the identity.
// Security: TAILNET-ONLY. Bind to the tailscale interface (MUSTER_BIND_HOST),
// never a public one. Campfire signs nothing, so an optional shared token
// (?token=…, MUSTER_WEBHOOK_TOKEN) is the only app-level check.

const http = require('http');
const { URL } = require('url');
const { parseWebhook, postReply } = require('./campfire');
const { loadRoster, resolveAgent } = require('./roster');
const { wakeAgent } = require('./agent');

const PORT = Number(process.env.MUSTER_PORT) || 8788;
const BIND_HOST = process.env.MUSTER_BIND_HOST || '0.0.0.0';

const SLUG_RE = /^\/campfire\/([a-z0-9][a-z0-9_-]*)$/i;

function campfireBase() {
  return process.env.CAMPFIRE_BASE || 'https://campfire.bluefenix.net';
}
function webhookToken() {
  return process.env.MUSTER_WEBHOOK_TOKEN || '';
}
function ignoredUsers() {
  return new Set(
    (process.env.MUSTER_IGNORE_USERS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Wake the agent and post its reply. Returns a small result for the log.
async function handleMessage(agent, msg, base) {
  const reply = await wakeAgent(agent, msg);
  if (!reply || !reply.trim()) return { action: 'empty-reply' };
  const res = await postReply(base, msg.replyPath, reply);
  return { action: 'posted', status: res.status };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200);
    return res.end('ok');
  }

  const url = new URL(req.url, 'http://localhost');
  const match = url.pathname.match(SLUG_RE);
  if (req.method !== 'POST' || !match) {
    res.writeHead(404);
    return res.end();
  }

  const token = webhookToken();
  if (token && url.searchParams.get('token') !== token) {
    res.writeHead(401);
    return res.end('bad token');
  }

  const slug = match[1];
  const raw = await readBody(req);
  let payload;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    res.writeHead(400);
    return res.end('bad json');
  }

  const msg = parseWebhook(payload);

  // ACK FAST — inside Campfire's 7s window. 204 == no inline reply. (A 200 with
  // an empty text/plain body would make Campfire post a BLANK message in the
  // bot's name: "" is truthy in Ruby's extract_text_from.) The real reply is
  // posted async to room.path below.
  res.writeHead(204);
  res.end();

  if (!msg) return;
  if (!msg.text) return; // nothing to answer (e.g. attachment-only)
  if (ignoredUsers().has(msg.user.name.toLowerCase())) {
    return console.log(`[muster] ${slug}: ignoring message from "${msg.user.name}"`);
  }

  let agent;
  try {
    agent = resolveAgent(slug, loadRoster());
  } catch (e) {
    return console.error('[muster] roster load failed:', e.message);
  }
  if (!agent) return console.error(`[muster] unknown agent slug "${slug}" — not waking`);

  const base = campfireBase();
  handleMessage(agent, msg, base)
    .then((r) => console.log('[muster]', slug, '→', JSON.stringify(r)))
    .catch((e) => {
      console.error('[muster] wake failed:', (e && e.message) || e);
      // Best-effort: tell the room we choked rather than dying silently. This
      // reply @mentions no one, so it can't re-trigger a webhook.
      postReply(base, msg.replyPath, `⚠️ ${agent.name} hit an error: ${(e && e.message) || e}`).catch(() => {});
    });
});

if (require.main === module) {
  server.listen(PORT, BIND_HOST, () =>
    console.log(
      `muster-receiver on ${BIND_HOST}:${PORT} → ${campfireBase()} (token ${webhookToken() ? 'set' : 'OFF'})`
    )
  );
}

module.exports = { server, handleMessage };
