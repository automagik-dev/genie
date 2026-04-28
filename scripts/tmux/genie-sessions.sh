#!/usr/bin/env bash
# List all tmux sessions formatted for status bar display
# Active session gets accent highlight, others get dim text.
#
# Colors are read from the generated theme via `tmux show-environment -g`.
# Single source of truth — no hex literals in this script.

set -euo pipefail

_theme_conf_path() {
  local here
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  for candidate in \
    "${HOME}/.genie/.generated.theme.conf" \
    "${here}/.generated.theme.conf"; do
    [[ -f "$candidate" ]] && { printf '%s' "$candidate"; return; }
  done
}

resolve_color() {
  local var="$1" out conf
  if command -v tmux >/dev/null 2>&1; then
    out=$(tmux show-environment -g "$var" 2>/dev/null | sed -n "s/^${var}=//p") || out=""
    if [[ -n "$out" ]]; then
      printf '%s' "$out"
      return
    fi
  fi
  conf="$(_theme_conf_path)"
  if [[ -n "$conf" ]]; then
    sed -n "s/^set-environment -g ${var} \"\\(.*\\)\"$/\\1/p" "$conf"
  fi
}

BG=$(resolve_color GENIE_TMUX_BG)
BG_RAISED=$(resolve_color GENIE_TMUX_BG_RAISED)
ACCENT=$(resolve_color GENIE_TMUX_ACCENT)
TEXT_DIM=$(resolve_color GENIE_TMUX_TEXT_DIM)

current_session="${1:-}"
if [ -z "$current_session" ]; then
  current_session=$(tmux display-message -p '#{session_name}' 2>/dev/null)
fi

output=""
for sess in $(tmux list-sessions -F '#{session_name}' 2>/dev/null | sort); do
  if [ "$sess" = "$current_session" ]; then
    output+="#[bg=${ACCENT},fg=${BG},bold] $sess #[bg=${BG_RAISED},fg=${ACCENT},nobold]"
  else
    output+="#[fg=${TEXT_DIM},bg=${BG_RAISED}] $sess "
  fi
done

echo "$output"
