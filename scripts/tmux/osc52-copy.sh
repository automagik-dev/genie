#!/usr/bin/env bash
# osc52-copy.sh — Write OSC 52 clipboard sequence directly to the SSH PTY,
# bypassing nested tmux layers that may absorb the sequence.
set -euo pipefail

buf=$(cat "$@")
encoded=$(printf '%s' "$buf" | base64 | tr -d '\n')
seq=$(printf '\033]52;c;%s\a' "$encoded")

# Try writing directly to the SSH connection's PTY
# Prefer $SSH_TTY (reliable in nested tmux) before falling back to who -m
if [ -n "$SSH_TTY" ]; then
  printf '%s' "$seq" > "$SSH_TTY" 2>/dev/null || true
fi
for tty in $(who -m 2>/dev/null | awk '{print $2}'); do
  printf '%s' "$seq" > "/dev/$tty" 2>/dev/null || true
done

# Fallback: emit to stdout (works if tmux allow-passthrough is on)
printf '%s' "$seq"
