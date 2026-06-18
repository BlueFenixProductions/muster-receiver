#!/bin/zsh
# Launcher for the muster-receiver. Self-locating; sources config.env; forces
# Homebrew + Claude onto PATH so launchd (minimal PATH) can find node and claude.
set -e
DIR="${0:A:h:h}"   # repo root (this script lives in <root>/bin/)
cd "$DIR"
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:$HOME/.asdf/shims:$HOME/.bun/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
if [ -f config.env ]; then
  set -a
  source config.env
  set +a
fi
exec node src/server.js
