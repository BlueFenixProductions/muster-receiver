'use strict';
// End-to-end: a Campfire webhook in → fast 204 ack → the addressed agent woken
// (fake claude) → its reply POSTed back to room.path on a mock Campfire. No real
// claude, no real Campfire — but every seam in between is exercised.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FAKE_CLAUDE = path.join(__dirname, 'fixtures', 'fake-claude.sh');

function listen(srv) {
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
}
function close(srv) {
  return new Promise((r) => srv.close(r));
}

describe('webhook → ack → wake → reply (full loop)', () => {
  let mockCampfire, receiver, replyReceived, base;

  beforeAll(async () => {
    // Mock Campfire records the bot's reply POST and resolves replyReceived.
    let resolveReply;
    replyReceived = new Promise((r) => (resolveReply = r));
    mockCampfire = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        res.writeHead(201);
        res.end('created');
        resolveReply({ url: req.url, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    const cfPort = await listen(mockCampfire);
    base = `http://127.0.0.1:${cfPort}`;

    // Temp roster with one agent; env wires base + fake claude + roster.
    const rosterFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'muster-')), 'roster.json');
    fs.writeFileSync(rosterFile, JSON.stringify({ ironquill: { name: 'ironquill', cwd: process.cwd() } }));
    process.env.CAMPFIRE_BASE = base;
    process.env.ROSTER_FILE = rosterFile;
    process.env.CLAUDE_BIN = FAKE_CLAUDE;

    ({ server: receiver } = await import('../src/server.js'));
    await listen(receiver);
  });

  afterAll(async () => {
    await close(receiver);
    await close(mockCampfire);
  });

  test('acks 204 immediately, then posts the reply to room.path', async () => {
    const port = receiver.address().port;
    const payload = JSON.stringify({
      user: { id: 7, name: 'Captain' },
      room: { id: 5, name: 'muster', path: '/rooms/5/bot/KEY/messages' },
      message: { id: 1, body: { plain: 'status?', html: '<p>@ironquill status?</p>' } },
    });

    const ackStatus = await new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, method: 'POST', path: '/campfire/ironquill', headers: { 'Content-Type': 'application/json' } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        }
      );
      req.on('error', reject);
      req.end(payload);
    });
    expect(ackStatus).toBe(204);

    const reply = await replyReceived;
    expect(reply.url).toBe('/rooms/5/bot/KEY/messages');
    expect(reply.body).toMatch(/^ack: You are "ironquill"/);
  });

  test('GET /health → 200', async () => {
    const port = receiver.address().port;
    const code = await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port, path: '/health' }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
    });
    expect(code).toBe(200);
  });

  test('unknown route → 404', async () => {
    const port = receiver.address().port;
    const code = await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port, path: '/nope' }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
    });
    expect(code).toBe(404);
  });
});
