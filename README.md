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
  `/rooms/:id/:bot_key/messages` — the reply target *with auth baked in* — so
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
- **Tailnet-only security.** Campfire signs nothing, so the `?token=` shared
  secret (`MUSTER_WEBHOOK_TOKEN`) on each webhook URL is the app-level gate, on
  top of the host not being publicly reachable. (On macOS/launchd bind `0.0.0.0`,
  not the tailscale IP — see deploy notes — so the token is doing real work.)

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

> Deployed live 2026-06-17: receiver on **Itachi** under launchd, bot **ironquill**
> in room **muster** (id 3), full loop verified. The steps below are exactly what
> worked (incl. the macOS gotchas the live bring-up exposed).

### 1. Deploy the receiver on Itachi (macOS, tailnet `100.70.94.58`)

Prereqs: `node >=18`, **Claude Code installed + authenticated** as the login user
(the receiver runs `claude -p`). The runtime has **no npm deps** (pure node).

**macOS TCC:** a launchd agent **cannot read `~/Documents`** and **cannot bind a
specific non-loopback IP** (Local Network privacy). So run from outside
`~/Documents` and bind `0.0.0.0`:

```sh
git clone https://github.com/BlueFenixProductions/muster-receiver.git ~/srv/muster-receiver
cd ~/srv/muster-receiver
cp config.env.example config.env     # MUSTER_BIND_HOST=0.0.0.0, set MUSTER_WEBHOOK_TOKEN
cp roster.example.json roster.json   # one entry per bot; cwd/persona/model per agent

sed "s#__DIR__#$PWD#g" bin/muster-receiver.plist.tmpl \
  > ~/Library/LaunchAgents/net.bluefenix.muster-receiver.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/net.bluefenix.muster-receiver.plist
curl -fsS http://100.70.94.58:8788/health   # -> ok
```

### 2. Create the bot

Either the admin UI (**Settings → Bots → New bot**) or, since the Campfire
container is on madara, programmatically via `rails runner` (no UI):

```ruby
# docker exec -i <campfire-container> bin/rails runner -
token = "<MUSTER_WEBHOOK_TOKEN>"
chris = User.find_by!(email_address: "you@example.com")
room  = Rooms::Open.find_or_create_by!(name: "muster") { |r| r.creator = chris }
bot   = User.create_bot!(name: "ironquill",
          webhook_url: "http://100.70.94.58:8788/campfire/ironquill?token=#{token}")
room.memberships.grant_to(bot) unless room.users.exists?(bot.id)
puts bot.bot_key   # secret; you don't store it — it rides in room.path
```

> **The one wiring rule:** the webhook URL slug (`/campfire/<slug>`) must equal the
> `roster.json` key. That pairing keeps the right agent answering as the right bot.

### 3. Container → Itachi reachability

Campfire's `Net::HTTP` POST must reach Itachi. Verified working over the tailnet
with no docker-network changes:

```sh
docker exec <campfire-container> \
  ruby -rnet/http -e 'puts Net::HTTP.get(URI("http://100.70.94.58:8788/health"))'   # -> ok
```

If it can't reach, the webhook times out and Campfire posts *"Failed to respond
within 7 seconds."* in the bot's name.
