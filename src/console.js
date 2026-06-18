'use strict';
// Campfire console client — the Operator-seat bridge behind `/muster ahoy`.
//
// READ path: bots can't read (deny_bots blocks every non-bot route), so we
// authenticate as a USER (session cookie) and GET the messages index. That index
// returns rendered HTML (Hotwire, `layout false` — there is NO JSON API), so
// parseMessages() extracts {id, author, text} keyed on the stable data-* targets
// the app itself relies on:
//   <div id="message_<ID>" class="message" data-message-id="<ID>" data-user-id=…>
//     <strong data-reply-target="author">NAME</strong>
//     <div id="message_<ID>_presentation" data-reply-target="body">…BODY…</div>
// Grounded in the fork's app/views/messages/_message.html.erb + messages_helper
// #message_tag. RE-CHECK that view if Campfire is bumped — this is the one piece
// coupled to the server's HTML.
//
// WRITE path: POST as a BOT via bot_key (CSRF-exempt — verified, the simplest
// solid path). The login/CSRF-token dance is the only seam validated live on the
// first `ahoy`; everything below it (cookie threading, the HTML parse) is tested.

const http = require('http');
const https = require('https');
const { URL } = require('url');

function request(method, urlStr, opts = {}) {
  const url = new URL(urlStr);
  const lib = url.protocol === 'https:' ? https : http;
  const body = opts.body != null ? Buffer.from(opts.body) : null;
  const headers = { ...(opts.headers || {}) };
  if (body) headers['Content-Length'] = body.length;
  if (opts.cookie) headers['Cookie'] = opts.cookie;
  return new Promise((resolve, reject) => {
    const req = lib.request(url, { method, headers, timeout: opts.timeoutMs || 10000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
          setCookies: res.headers['set-cookie'] || [],
        })
      );
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    if (body) req.write(body);
    req.end();
  });
}

// Merge Set-Cookie headers into a "name=value; name2=value2" jar string.
function mergeCookies(jar, setCookies) {
  const map = new Map();
  for (const pair of (jar || '').split(';').map((s) => s.trim()).filter(Boolean)) {
    const i = pair.indexOf('=');
    if (i > 0) map.set(pair.slice(0, i), pair.slice(i + 1));
  }
  for (const sc of setCookies || []) {
    const first = sc.split(';')[0];
    const i = first.indexOf('=');
    if (i > 0) map.set(first.slice(0, i).trim(), first.slice(i + 1));
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function extractCsrfToken(html) {
  const hidden = html.match(/name="authenticity_token"[^>]*value="([^"]*)"/);
  if (hidden) return decodeEntities(hidden[1]);
  const meta = html.match(/name="csrf-token"[^>]*content="([^"]*)"/);
  return meta ? decodeEntities(meta[1]) : null;
}

// Log in as a user → returns a cookie jar string usable for reads. Two hops, the
// standard Rails login: GET the form (cookie + CSRF token), POST the credentials.
async function login(base, email, password, opts = {}) {
  const form = await request('GET', new URL('/session/new', base).href, opts);
  let jar = mergeCookies('', form.setCookies);
  const token = extractCsrfToken(form.body);
  const body = new URLSearchParams({
    email_address: email,
    password,
    ...(token ? { authenticity_token: token } : {}),
  }).toString();
  const res = await request('POST', new URL('/session', base).href, {
    ...opts,
    cookie: jar,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(token ? { 'X-CSRF-Token': token } : {}) },
    body,
  });
  jar = mergeCookies(jar, res.setCookies);
  // sessions#create redirects on success, re-renders the form (401/422) on
  // failure. Key on the redirect TARGET, not a cookie name: a 30x whose Location
  // isn't /session/new means we're in. (Verified live: the session cookie is
  // _campfire_session, not the source's session_token — so don't depend on the
  // name, just carry every cookie the server set.)
  const loc = res.headers.location || '';
  const redirected = res.status >= 300 && res.status < 400;
  if (redirected && !/\/session\/new/.test(loc)) return jar;
  throw new Error(`login failed: HTTP ${res.status}${loc ? ` → ${loc}` : ''}`);
}

// Post a message AS A BOT (CSRF-exempt). Body is the raw message text.
// Path is /rooms/:id/:bot_key/messages — NO "bot" segment (verified live against
// the deployed route helper room_bot_messages_path).
function say(base, roomId, botKey, text, opts = {}) {
  const url = new URL(`/rooms/${roomId}/${botKey}/messages`, base).href;
  return request('POST', url, { ...opts, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: String(text) }).then(
    (r) => ({ status: r.status })
  );
}

// Poll the room as the logged-in user; returns parsed messages after afterId.
async function poll(base, roomId, cookie, afterId, opts = {}) {
  const path = afterId ? `/rooms/${roomId}/messages?after=${encodeURIComponent(afterId)}` : `/rooms/${roomId}/messages`;
  const res = await request('GET', new URL(path, base).href, { ...opts, cookie });
  return { status: res.status, messages: res.status === 204 ? [] : parseMessages(res.body), raw: res.body };
}

// The console's own user id (so watch can skip the agent's own posts). The
// bot_key is "<id>-<token>", so the id is the part before the first "-".
function ownIdFromBotKey(botKey) {
  const id = String(botKey || '').split('-')[0];
  return /^\d+$/.test(id) ? Number(id) : null;
}

const maxId = (messages, start = 0) => messages.reduce((m, x) => (x.id > m ? x.id : m), start);

// Stream new messages: poll on an interval and invoke onMessage for each message
// newer than the cursor that isn't the console's own post. Blocks until the
// deadline (forMs) or, with once=true, the first fresh message. Timers/clock are
// injectable for tests. Returns {stopped, cursor}.
async function watch(opts) {
  const {
    base, roomId, cookie, botKey, afterId,
    intervalMs = 3000, forMs = Infinity, once = false, onMessage,
    _poll = poll,
    _sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    _now = () => Date.now(),
  } = opts;
  const ownId = ownIdFromBotKey(botKey);
  let cursor = afterId;
  if (cursor == null) {
    // Prime from the latest message so we stream from the join point, not history.
    const first = await _poll(base, roomId, cookie);
    cursor = maxId(first.messages, 0);
  }
  const deadline = forMs === Infinity ? Infinity : _now() + forMs;
  while (_now() < deadline) {
    const r = await _poll(base, roomId, cookie, cursor);
    if (r.status === 401) return { stopped: 'unauthorized', cursor };
    const fresh = r.messages.filter((m) => m.id > cursor && m.userId !== ownId);
    for (const m of fresh) if (onMessage) onMessage(m);
    cursor = maxId(r.messages, cursor);
    if (once && fresh.length) return { stopped: 'once', cursor };
    if (_now() >= deadline) break;
    await _sleep(intervalMs);
  }
  return { stopped: 'deadline', cursor };
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function stripTags(html) {
  return decodeEntities(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

// Balanced <div> scan from a starting index (depth begins at 1 = the open div we
// just matched). Returns the inner HTML up to the matching </div>. Same spirit as
// core.js's balanced-brace JSON extraction — tolerant of nested divs in the body.
function innerOfDiv(html, fromIndex) {
  const tag = /<\/?div\b[^>]*>/g;
  tag.lastIndex = fromIndex;
  let depth = 1;
  let m;
  while ((m = tag.exec(html))) {
    if (m[0][1] === '/') {
      depth--;
      if (depth === 0) return html.slice(fromIndex, m.index);
    } else {
      depth++;
    }
  }
  return html.slice(fromIndex); // unterminated — take the rest
}

// Parse Campfire's messages-index HTML into [{id, userId, author, text}].
// Keyed on the stable data-* attributes, NOT element ids: verified live, the
// container id is a UUID dom_id (message_<uuid>) while the numeric id rides in
// data-message-id, and the body div is data-reply-target="body" (its id is
// presentation_message_<uuid>). Keying on the targets survives both.
function parseMessages(html) {
  const out = [];
  const container = /<div\b[^>]*\bdata-message-id="(\d+)"[^>]*>/g;
  const starts = [];
  let m;
  while ((m = container.exec(html))) {
    const userId = (m[0].match(/data-user-id="(\d+)"/) || [])[1];
    starts.push({ id: Number(m[1]), userId: userId ? Number(userId) : null, index: m.index });
  }
  for (let i = 0; i < starts.length; i++) {
    const slice = html.slice(starts[i].index, i + 1 < starts.length ? starts[i + 1].index : undefined);
    const authorM = slice.match(/data-reply-target="author"\s*>([\s\S]*?)<\/strong>/);
    const author = authorM ? stripTags(authorM[1]) : '';
    const bodyM = slice.match(/<div\b[^>]*\bdata-reply-target="body"[^>]*>/);
    const text = bodyM ? stripTags(innerOfDiv(slice, bodyM.index + bodyM[0].length)) : '';
    out.push({ id: starts[i].id, userId: starts[i].userId, author, text });
  }
  return out;
}

module.exports = { login, say, poll, watch, parseMessages, mergeCookies, extractCsrfToken, stripTags, ownIdFromBotKey, maxId };
