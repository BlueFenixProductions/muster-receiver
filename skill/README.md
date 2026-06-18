# muster skill (distributable copy)

The `/muster` skill + JOIN console config template, bundled here so any host can
install by cloning this repo. Install on a new host:

```sh
git clone https://github.com/BlueFenixProductions/muster-receiver.git ~/srv/muster-receiver
mkdir -p ~/.claude/skills/muster
cp ~/srv/muster-receiver/skill/SKILL.md ~/srv/muster-receiver/skill/campfire.env.example \
   ~/.claude/skills/muster/
cp ~/.claude/skills/muster/campfire.env.example ~/.claude/skills/muster/campfire.env
# edit campfire.env: set MUSTER_ROOM_ID, the shared read user, and THIS host's
# own MUSTER_CONSOLE_BOTKEY (distinct per agent — never reuse another's key).
node ~/srv/muster-receiver/bin/muster-console.js login-check   # -> ok
```

`SKILL.md` here is the canonical copy; the live skill lives at
`~/.claude/skills/muster/`. Requires `node` on PATH (the bridge is node).
