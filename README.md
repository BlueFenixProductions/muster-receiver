# muster-receiver

The **wake trigger** for the muster war room. A Campfire bot is @mentioned →
Campfire POSTs a webhook → this receiver acks inside Campfire's 7-second window →
wakes a `claude -p` run **as the addressed agent** → posts the reply back to the
room. Modeled on `elf-dispatch/src/receiver/` (same ack-then-async shape, same
fail-closed instincts), but its own concern: elf-dispatch reviews GitHub diffs;
this drives the live agent war room.

```
Campfire (madara, container)                 muster-receiver (Itachi, tailnet)
   message: "@ironquill status?"
        │  webhook POST /campfire/ironquill
        ▼
   ┌─────────────┐   204 (no inline reply)   ┌──────────────────────────────┐
   │  webhook.rb │ ◀──────────────────────── │ ack fast, then async:         │
   │  7s timeout │                            │  roster[ironquill] → identity │
   └─────────────┘                            │  claude -p (persona, cwd)     │
        ▲   POST <base><room.path>            │  → reply text                 │
        └─────────────────────────────────── │  postReply to room.path       │
            "…" as the ironquill bot          └──────────────────────────────┘
```

## Why these shapes

- **Ack = HTTP 204.** Campfire's `Webhook#deliver` treats a `200` with a
  `text/plain` body as an *inline reply* — and an **empty** body still posts
  (Ruby's `"" ` is truthy), so a 200 would drop a blank message in the bot's
  name. `204` suppresses the inline path; the only reply is the async one we
  POST to `room.path`.
- **`room.path` carries the `bot_key`.** The webhook hands us
  `/rooms/:id/bot/:bot_key/messages` — the reply target *with auth baked in* — so
  the receiver never stores bot_keys. We reply *as* whichever bot was addressed.
- **@mention-gated wake.** In a normal room Campfire only delivers to
  `@message.mentionees.active_bots` (and never the message's own creator). So
  bots wake only when named — no wake-storm — and one agent can summon another by
  @mentioning it. That *is* the war-room addressing model.
- **Distinct identity per agent.** Each agent is its own Campfire bot (own name,
  own key, own webhook URL) and its own `roster.json` entry (own persona, cwd,
  model). The URL slug picks who was addressed; an unknown slug is refused —
  never a default identity. Shared identity = crossed wires; the design forbids
  it structurally.
- **Tailnet-only security.** Campfire signs nothing. Bind to Itachi's tailscale
  IP (`MUSTER_BIND_HOST`), never a public interface. Optional `?token=` shared
  secret as belt-and-suspenders.

## Layout

| path | role |
|------|------|
| `src/server.js` | HTTP front door: webhook in, 204 ack, async dispatch |
| `src/campfire.js` | parse the webhook payload; POST the reply to `room.path` |
| `src/roster.js` | slug → agent identity (fails closed on unknown/corrupt) |
| `src/agent.js` | wake `claude -p` as the agent; prompt on stdin |
| `roster.json` | per-install agent roster (gitignored; see `.example`) |
| `config.env` | per-install config (gitignored; see `.example`) |
| `bin/` | launchd launcher + plist template (Itachi/macOS) |

`bun run test` / `npm test` — vitest, `globals: true`. The e2e test drives the
whole loop with a fake `claude` and a mock Campfire.

## Standing it up

### 1. Create the bot (Campfire admin UI — one per agent)

`campfire.bluefenix.net` → **Settings → Bots → New bot**:

- **Name:** the agent handle, e.g. `ironquill`.
- **Webhook URL:** `http://100.70.94.58:8788/campfire/<slug>` — the `<slug>` must
  match the roster key and the agent's intent. With a token:
  `http://100.70.94.58:8788/campfire/ironquill?token=<MUSTER_WEBHOOK_TOKEN>`.

Campfire shows the bot's **`bot_key`** once. You don't paste it anywhere — it
arrives inside `room.path` on every webhook — but note it: it's a secret (anyone
with it can post as the bot). Add the bot to the war-room **room**, then
@mention it to test.

> **The one wiring rule:** the URL slug (`/campfire/<slug>`) must equal the
> `roster.json` key. That pairing is what keeps the right agent answering as the
> right bot.

### 2. Deploy on Itachi (macOS, tailnet `100.70.94.58`)

Prereqs: `node >=18`, and **Claude Code installed + authenticated** as the login
user (the receiver runs `claude -p` under launchd).

```sh
git clone https://github.com/BlueFenixProductions/muster-receiver.git
cd muster-receiver && npm install --omit=dev
cp config.env.example config.env        # set MUSTER_BIND_HOST, token, etc.
cp roster.example.json roster.json      # one entry per bot you created
npm test                                # sanity

# launchd
sed "s#__DIR__#$PWD#g" bin/muster-receiver.plist.tmpl \
  > ~/Library/LaunchAgents/net.bluefenix.muster-receiver.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/net.bluefenix.muster-receiver.plist
launchctl kickstart -k gui/$(id -u)/net.bluefenix.muster-receiver
tail -f receiver.log
```

### 3. Verify container → tailnet reach

Campfire runs in a **Coolify container on madara**; its `Net::HTTP` POST must
reach Itachi's tailscale IP. From madara:

```sh
docker exec <campfire-container> curl -s -o /dev/null -w '%{http_code}\n' \
  http://100.70.94.58:8788/health   # want 200
```

If the container can't see the tailnet, give it host networking or route the
tailscale CGNAT range (`100.64.0.0/10`) to the host — otherwise the webhook
silently times out and Campfire posts *"Failed to respond within 7 seconds."*
