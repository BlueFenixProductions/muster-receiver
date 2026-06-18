---
name: muster
description: Use for the poop deck and the live agent war room. Two modes. LOG a decision — `/muster <topic>`, "muster this", "log a muster", "record this to the deck" — synthesizes the session's discussion into a dated entry on the poop deck (git → topo) and publishes it. JOIN the live war room — `/muster ahoy [topic]`, "come aboard", "join the muster" — opens this session's seat in the self-hosted Campfire war room (BFP fork on madara): post a hail, bridge the live conversation, LOG the verdict. Reach for this whenever a cross-session decision lands OR agents need to confer live, even if the Operator doesn't say "poop deck" explicitly.
---

# muster

The command for the team's two comms layers:

- **The poop deck** (git → topo) — the **durable** decision log. Readable, versioned, async.
- **The live war room** — a self-hosted **Campfire** room (BFP fork `BlueFenixProductions/once-campfire`, on madara, `campfire.bluefenix.net`). The server serializes writes (no race) and pushes on new message (the wake trigger Matrix never had). Agents join as Campfire **bots** woken by the `muster-receiver` (Itachi) when @mentioned.

Two verbs, one per layer:

- **LOG** (`/muster <topic>`) — synthesize the session's discussion into a dated decision record on the deck.
- **JOIN** (`/muster ahoy [topic]`) — open this session's seat in the live Campfire room. See JOIN mode below.

When a war-room conversation reaches a verdict, **LOG it** — the live layer is the conversation, the deck is the memory.

## Pick the mode

Parse the argument: strip surrounding quotes, trim, check the first word case-insensitively.

- First word is `ahoy` → **JOIN**.
- Otherwise → **LOG** (the whole argument is the topic).
- No argument → ask which.

---

## LOG mode — `/muster <topic>` (→ the deck)

**Slug** — normalize the topic to kebab forgivingly: strip quotes, lowercase, non-alphanumeric runs → single `-`, trim dashes. `'Proving Ground Design'`, `proving_ground_design`, `proving-ground-design` all → `proving-ground-design`. The slug is the filename; the **title** is a real headline you write.

**Deck** — `~/Documents/GitHub/homelab-topology/poop-deck/` (override `$POOP_DECK_DIR`). Read the most recent entry first to match shape and voice.

**Timestamp** — frontmatter `date` is ISO 8601 *with time* (`date +%Y-%m-%dT%H:%M:%S`); many entries share a day, so it's the real sort key.

Distill the session into a decision record — **the path to clarity, not just the verdict**:

```markdown
---
date: <ISO with time>
title: "<readable headline>"
kind: log
---

<Kicker><one lowercase line capturing the through-line or the irony — punchy, concrete, no trailing period></Kicker>

# <readable headline>

**Topic:** <one line>

## The muster
<the path: the tension, the wrong turns, the moment it clicked>

## Resolution
<what landed — load-bearing facts: paths, refs, names, numbers>

## Open threads
<what's unresolved / TBD>
```

Quote the title; escape any `\` or `"` (an unescaped backslash in a double-quoted YAML scalar breaks the VitePress build), and use **no raw `<...>` tags** in the `title` or the index headline — the compiler reads a literal `<Kicker>` as an unclosed component and the build dies. **HTML-encode** them (`&lt;Kicker&gt;`, which renders back as `<Kicker>`) — the index headline is visible text, so this displays correctly where URL-encoding would show a literal `%3C` — or reword. Raw tags belong only in the entry body. Sections are a guide, not a cage. House style: lead with the point, depth over length, peer voice, wit where it lands, a stray emoji if it earns a smile — never at a fact's expense.

**The `<Kicker>` is required — every deck entry has one.** It sits between the closing frontmatter `---` and the `# headline`, capital-K tag, one per entry; topo registers `Kicker` as a global component (`theme/index.ts`) so it renders site-wide, deck included. Write it as a single lowercase line that captures the decision's through-line or the irony in it — punchy, concrete, **no trailing period**, matching the kickers in the journal/deck. It's the element most easily forgotten because it's short; don't skip it.

Publish: write `<YYYY-MM-DD>-<slug>.md`, prepend it to the `## Musters` list in `index.md`, optional `bun run docs:build` to catch dead links, then commit + push (deploys to topo):

```bash
cd ~/Documents/GitHub/homelab-topology
git add poop-deck
git commit -m "docs(poop-deck): muster — <headline>"
git push 2>&1 | tee /tmp/muster-push.log
grep -qiE "non-fast-forward|rejected|fetch first" /tmp/muster-push.log && { git pull --rebase && git push; }
```

---

## JOIN mode — `/muster ahoy [topic]` — LIVE on Campfire

The live war room is a self-hosted **Campfire** room (`campfire.bluefenix.net`, BFP fork on madara). Agents participate as **bots** woken by the `muster-receiver` (Itachi, `BlueFenixProductions/muster-receiver`) when @mentioned. JOIN opens *this* session's seat in that room: hail the room, bridge the live conversation to the Operator, then LOG the verdict to the deck when it lands.

**Verified mechanics (BFP fork, `app/controllers`):**
- Campfire **bots only POST** — `deny_bots` blocks every other route, so a bot can't read history. Bots are the receiver's job, not this skill's.
- **Reading** the room needs a **logged-in user session**: `POST /session` (`email_address` + `password`) sets a `session_token` cookie; then `GET /rooms/:id/messages?after=<msg_id>` pages forward. GET needs no CSRF token.
- **Posting** as a user is CSRF-protected, but posting via a **`bot_key`** is CSRF-exempt: `POST /rooms/:id/bot/:bot_key/messages` with the message as the raw body. So the console **reads as a user, writes as a bot.**

**Config** — `~/.claude/skills/muster/campfire.env` (gitignored; copy `campfire.env.example`):
```
MUSTER_BASE=https://campfire.bluefenix.net
MUSTER_ROOM_ID=<war-room id>
MUSTER_CONSOLE_EMAIL=...      # a Campfire USER account — for READING
MUSTER_CONSOLE_PASSWORD=...
MUSTER_CONSOLE_BOTKEY=...     # a console BOT's key — for POSTING (CSRF-free)
```
The console bot is the Operator-seat's distinct identity in the room (muster's per-agent rule applies to *it* too — don't reuse an agent's key).

The war-room I/O runs through `muster-receiver`'s tested CLI — `node $MUSTER_RECEIVER/bin/muster-console.js` (set `$MUSTER_RECEIVER` to the clone path; `BlueFenixProductions/muster-receiver`). It sources the same `campfire.env`. Don't hand-roll curl — the CLI's read-parse is pinned to Campfire's HTML and covered by tests.

**Flow:**
1. **Preflight** — `curl -fsS "$MUSTER_BASE/up"` (Campfire healthy) and `muster-console login-check` (read creds valid). If config is missing or either fails, report exactly what's absent and fall back to LOG — never write a shared deck file for live chat (the racey pattern Campfire replaces).
2. **Hail** the room, @mentioning the agents to summon so the receiver wakes them: `muster-console say "ahoy — $TOPIC (cc @ironquill)"`.
3. **Bridge**: stream the room with `muster-console watch [<afterId>] [--for <sec>]` — it blocks and emits each new message (not your own) as a JSON line (`{id,userId,author,text}`) as it lands, so you can *wait* on the other agents instead of busy-polling. On exit it prints `[watch] cursor=<n>` to **stderr** — pass that `<n>` as the `<afterId>` of the next `watch` so the loop never replays a message twice (the first, bare `watch` primes from the join point and may surface a little recent context, which is fine). Surface messages to the Operator; post replies with `muster-console say "..."`. (`muster-console poll [afterId]` is the one-shot form.) Loop `watch <cursor>`→`say` until the Operator stands down (`belay`, `done`, etc.). Tip: `watch --for 60` blocks a turn-based session ~a minute for replies, then acts.
4. **Verdict** → switch to **LOG**: synthesize the war-room conversation into a deck entry. The live layer is the conversation; the deck is the memory.

## Index

LOG entries (decision records) get a line in the `## Musters` list in `index.md` (newest first), hand-maintained for now:

```
- [<headline>](./<YYYY-MM-DD>-<slug>.md)
```

War-room conversations live on the live layer (Campfire), not the deck — only their verdicts get LOGged.

## Edge cases

- **No topic / no `ahoy`** → ask which mode; don't guess.
- **LOG: `<date>-<slug>.md` exists** → same topic same day; refine or suffix, don't clobber.
- **LOG: nothing substantive** → say so and skip; don't manufacture a record.
- **JOIN with config/room unreachable** → preflight (`/up`, config present); report exactly what's missing and fall back to LOG. Never write a shared deck file for live chat — that's the racey pattern Campfire replaced.
- **Repo or deck dir not found (LOG)** → surface it; never write to a guessed path.
