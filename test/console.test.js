'use strict';
const http = require('http');
const { login, say, poll, parseMessages, mergeCookies, extractCsrfToken } = require('../src/console');

// Fixture mirroring the fork's app/views/messages/_message.html.erb +
// messages_helper#message_tag (the real index HTML). If Campfire's view changes,
// THIS must change too — that coupling is the point of pinning it here.
function messageHTML({ id, userId, author, bodyHTML }) {
  return `
<div id="message_${id}" class="message" data-controller="reply" data-user-id="${userId}" data-message-id="${id}" data-message-timestamp="123" data-messages-target="message">
  <figure class="avatar message__avatar"></figure>
  <turbo-frame id="message_${id}_edit">
    <div class="message__body"><div class="message__body-content"><div class="message__meta">
      <h3 class="message__heading">
        <span class="message__author" title="${author}"><strong data-reply-target="author">${author}</strong></span>
      </h3>
    </div>
    <div id="message_${id}_presentation" dir="auto" data-reply-target="body" data-messages-target="body">${bodyHTML}</div>
    </div></div>
  </turbo-frame>
</div>`;
}

describe('parseMessages (grounded in the fork view)', () => {
  test('extracts id, userId, author, and tag-stripped text', () => {
    const html =
      messageHTML({ id: 10, userId: 3, author: 'Captain', bodyHTML: '<div>status?</div>' }) +
      messageHTML({ id: 11, userId: 7, author: 'ironquill', bodyHTML: '<div>all green, <em>16/16</em></div>' });
    const msgs = parseMessages(html);
    expect(msgs).toEqual([
      { id: 10, userId: 3, author: 'Captain', text: 'status?' },
      { id: 11, userId: 7, author: 'ironquill', text: 'all green, 16/16' },
    ]);
  });

  test('balanced-scans a body with nested divs and decodes entities', () => {
    const html = messageHTML({
      id: 20,
      userId: 1,
      author: 'Captain',
      bodyHTML: '<div class="a">ship &amp; <div class="b">test</div> &lt;done&gt;</div>',
    });
    expect(parseMessages(html)[0].text).toBe('ship & test <done>');
  });

  test('empty HTML → no messages', () => {
    expect(parseMessages('')).toEqual([]);
  });
});

describe('cookie + csrf helpers', () => {
  test('mergeCookies overlays Set-Cookie onto a jar', () => {
    const jar = mergeCookies('a=1; b=2', ['b=9; Path=/; HttpOnly', 'session_token=tok; Path=/']);
    expect(jar).toMatch(/a=1/);
    expect(jar).toMatch(/b=9/);
    expect(jar).toMatch(/session_token=tok/);
  });

  test('extractCsrfToken reads the hidden field or meta tag', () => {
    expect(extractCsrfToken('<input name="authenticity_token" value="abc123">')).toBe('abc123');
    expect(extractCsrfToken('<meta name="csrf-token" content="xyz789">')).toBe('xyz789');
  });
});

describe('login → say → poll (mock Campfire)', () => {
  let srv, base, posted;

  beforeAll(async () => {
    posted = [];
    srv = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        // GET /session/new → Rails session cookie (carries CSRF) + token in form.
        // Cookie name mirrors live: _campfire_session, not the source's guess.
        if (req.method === 'GET' && req.url === '/session/new') {
          res.writeHead(200, { 'Set-Cookie': '_campfire_session=seed; Path=/; HttpOnly', 'Content-Type': 'text/html' });
          return res.end('<input name="authenticity_token" value="TKN">');
        }
        // POST /session → 302 to root + auth cookie IF the token threaded through.
        if (req.method === 'POST' && req.url === '/session') {
          const ok = /authenticity_token=TKN/.test(body) && /_campfire_session=seed/.test(req.headers.cookie || '');
          if (!ok) return res.writeHead(422).end('csrf');
          return res.writeHead(302, { 'Set-Cookie': 'session_token=SESS; Path=/; HttpOnly', Location: '/' }).end();
        }
        // POST bot message — real path is /rooms/:id/:bot_key/messages (no /bot/)
        const botPost = req.url.match(/^\/rooms\/(\d+)\/([^/]+)\/messages$/);
        if (req.method === 'POST' && botPost) {
          posted.push({ room: botPost[1], key: botPost[2], text: body });
          return res.writeHead(201).end('created');
        }
        // GET messages (requires the session cookie)
        if (req.method === 'GET' && req.url.startsWith('/rooms/5/messages')) {
          if (!/session_token=SESS/.test(req.headers.cookie || '')) return res.writeHead(401).end('no session');
          return res
            .writeHead(200, { 'Content-Type': 'text/html' })
            .end(messageHTML({ id: 99, userId: 7, author: 'ironquill', bodyHTML: '<div>aye, Captain</div>' }));
        }
        res.writeHead(404).end();
      });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${srv.address().port}`;
  });

  afterAll(() => new Promise((r) => srv.close(r)));

  test('logs in, posts as a bot, reads the reply back', async () => {
    const jar = await login(base, 'captain@bf', 'pw');
    expect(jar).toMatch(/session_token=SESS/); // carried, even though login no longer keys on the name

    const sent = await say(base, 5, 'BOTKEY', 'ahoy — M2 status?');
    expect(sent.status).toBe(201);
    expect(posted).toContainEqual({ room: '5', key: 'BOTKEY', text: 'ahoy — M2 status?' });

    const got = await poll(base, 5, jar);
    expect(got.status).toBe(200);
    expect(got.messages).toEqual([{ id: 99, userId: 7, author: 'ironquill', text: 'aye, Captain' }]);
  });

  test('poll without a session cookie is rejected (read needs a user)', async () => {
    const got = await poll(base, 5, 'session_token=WRONG');
    expect(got.status).toBe(401);
  });
});
