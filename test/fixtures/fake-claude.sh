#!/bin/sh
# Test stub for `claude -p`. Reads the prompt on stdin and prints a canned reply
# that echoes the head of the prompt, so tests can prove stdin reached it.
# Honors FAKE_CLAUDE_EXIT to simulate a failed run.
prompt="$(cat)"
if [ -n "$FAKE_CLAUDE_EXIT" ] && [ "$FAKE_CLAUDE_EXIT" != "0" ]; then
  echo "boom" >&2
  exit "$FAKE_CLAUDE_EXIT"
fi
printf 'ack: %s' "$(printf '%s' "$prompt" | head -c 40)"
