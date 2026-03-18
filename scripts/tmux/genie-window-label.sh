#!/usr/bin/env bash
# Genie TUI — per-window agent enrichment label
# Called from window-status-format via #() for each window tab.
# Must be fast (< 50ms) — single jq query, early exit on missing data.
#
# Usage: genie-window-label.sh <session_name> <window_name>
# Output: " ×count emoji" (e.g., " ×3 🔨") or empty string
#
# Env: GENIE_WORKERS — override path to workers.json (for testing)

session="${1:-}"
window="${2:-}"

# Early exit if no args
if [ -z "$session" ] || [ -z "$window" ]; then
  exit 0
fi

workers_file="${GENIE_WORKERS:-${HOME}/.genie/workers.json}"

# Early exit if no workers file
if [ ! -f "$workers_file" ]; then
  exit 0
fi

# Single jq pass: filter by session + window, count + worst state emoji
result=$(jq -r --arg sess "$session" --arg win "$window" '
  def state_priority:
    {"error": 7, "permission": 6, "working": 5, "spawning": 4, "idle": 3, "done": 2, "suspended": 1};
  def state_emoji:
    {"spawning": "⏳", "working": "🔨", "idle": "⏸", "done": "✓", "error": "✗", "permission": "❓", "suspended": "💤"};

  .workers // {} | to_entries
  | map(select(.value.session == $sess and (.value.windowName // .value.team // "unknown") == $win))
  | if length == 0 then ""
    else
      length as $count
      | map(.value.state // "idle")
      | map(. as $s | state_priority[$s] // 0)
      | max as $max_pri
      | (state_priority | to_entries | map(select(.value == $max_pri)) | .[0].key // "idle") as $worst
      | " ×\($count) \(state_emoji[$worst] // "")"
    end
' "$workers_file" 2>/dev/null) || exit 0

# Only print if non-empty
if [ -n "$result" ]; then
  printf '%s' "$result"
fi
