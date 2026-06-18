'use strict';
// Campfire webhook glue. Payload shape verified against the BFP fork
// (app/models/webhook.rb#payload):
//
//   { user:    { id, name },
//     room:    { id, name, path: "/rooms/:id/:bot_key/messages" },
//     message: { id, body: { html, plain }, path } }
//
// (Verified live: the path is /rooms/:id/:bot_key/messages — NO "bot" segment.)
// room.path is the reply target with the bot_key ALREADY baked in — so the
// receiver never has to store bot_keys. Campfire tells us how to reply as the
// bot that was addressed; posting to that path authenticates via the key
// (by_bots_controller's allow_bot_access).

const http = require('http');
const https = require('https');
const { URL } = require('url');

// Normalize a raw webhook body into what the wake loop needs, or null to ignore.
function parseWebhook(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const room = payload.room || {};
  const message = payload.message || {};
  const body = message.body || {};
  if (!room.path) return null; // no reply target — nothing we can do
  return {
    roomId: room.id,
    roomName: room.name || '',
    replyPath: room.path, // POST target; contains the bot_key
    user: { id: payload.user && payload.user.id, name: (payload.user && payload.user.name) || '' },
    text: (body.plain || '').trim(),
    html: body.html || '',
    messageId: message.id,
  };
}

// POST the reply back to Campfire. by_bots_controller reads the raw request body
// AS the message text, so we send text/plain with the message as the whole body.
function postReply(base, replyPath, text, opts = {}) {
  const url = new URL(replyPath, base);
  const lib = url.protocol === 'https:' ? https : http;
  const payload = Buffer.from(String(text), 'utf8');
  return new Promise((resolve, reject) => {
    const req = lib.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Length': payload.length,
        },
        timeout: opts.timeoutMs || 10000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('postReply timed out')));
    req.end(payload);
  });
}

module.exports = { parseWebhook, postReply };
