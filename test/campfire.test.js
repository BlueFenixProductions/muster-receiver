'use strict';
const http = require('http');
const { parseWebhook, postReply } = require('../src/campfire');

// A realistic webhook body, shaped exactly like the BFP fork's
// Webhook#payload (app/models/webhook.rb).
const SAMPLE = {
  user: { id: 7, name: 'Captain' },
  room: { id: 5, name: 'muster', path: '/rooms/5/bot/abc123KEY/messages' },
  message: { id: 99, body: { html: '<div>@ironquill status?</div>', plain: '  status?  ' }, path: '/rooms/5@99' },
};

describe('parseWebhook', () => {
  test('extracts reply path, user, and trimmed text', () => {
    const m = parseWebhook(SAMPLE);
    expect(m.replyPath).toBe('/rooms/5/bot/abc123KEY/messages');
    expect(m.roomId).toBe(5);
    expect(m.roomName).toBe('muster');
    expect(m.user).toEqual({ id: 7, name: 'Captain' });
    expect(m.text).toBe('status?'); // trimmed
    expect(m.messageId).toBe(99);
  });

  test('returns null without a reply path (nothing to reply to)', () => {
    expect(parseWebhook({ room: {}, message: {} })).toBeNull();
    expect(parseWebhook(null)).toBeNull();
  });

  test('tolerates a missing user / empty body', () => {
    const m = parseWebhook({ room: { id: 1, path: '/p' }, message: {} });
    expect(m.user).toEqual({ id: undefined, name: '' });
    expect(m.text).toBe('');
  });
});

describe('postReply', () => {
  test('POSTs the text as the raw body to <base><replyPath>', async () => {
    const seen = {};
    const srv = http.createServer((req, res) => {
      seen.method = req.method;
      seen.url = req.url;
      seen.ctype = req.headers['content-type'];
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        seen.body = Buffer.concat(chunks).toString('utf8');
        res.writeHead(201);
        res.end('created');
      });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}`;

    const res = await postReply(base, '/rooms/5/bot/KEY/messages', 'hello room');
    expect(res.status).toBe(201);
    expect(seen.method).toBe('POST');
    expect(seen.url).toBe('/rooms/5/bot/KEY/messages');
    expect(seen.ctype).toMatch(/text\/plain/);
    expect(seen.body).toBe('hello room');

    await new Promise((r) => srv.close(r));
  });
});
