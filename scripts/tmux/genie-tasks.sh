#!/usr/bin/env bash
# Genie TUI — task window tabs for tmux bottom status bar
# Reads workers.json for agent counts + status emoji per window.
#
# Usage: genie-tasks.sh <session_name>
#
# Output format per window:
#   Active:   #[bg=#7b2ff7,fg=#e0e0e0,bold] name ×count emoji #[bg=#16213e,fg=#7b2ff7]
#   Inactive: #[fg=#b8a9c9,bg=#16213e] name ×count emoji
#
# Env: GENIE_WORKERS — override path to workers.json (for testing)

set -euo pipefail

session_name="${1:-}"
if [[ -z "$session_name" ]]; then
  echo -n ""
  exit 0
fi

# Verify session exists (skip check when running with mock data and no tmux)
has_tmux=true
if ! command -v tmux &>/dev/null; then
  has_tmux=false
elif ! tmux has-session -t "$session_name" 2>/dev/null; then
  # Session doesn't exist in tmux — but if we have workers data, still render
  has_tmux=false
fi

workers_file="${GENIE_WORKERS:-${HOME}/.genie/workers.json}"

# If workers file doesn't exist, fall back to plain tmux window list
if [[ ! -f "$workers_file" ]]; then
  if [[ "$has_tmux" == "false" ]]; then
    echo -n ""
    exit 0
  fi
  # Fallback: plain window list without agent data
  output=""
  while IFS=$'\t' read -r window_index window_name window_active; do
    [[ -z "$window_index" ]] && continue
    if [[ "$window_active" == "1" ]]; then
      output+="#[bg=#7b2ff7,fg=#e0e0e0,bold] ${window_index}:${window_name} #[bg=#16213e,fg=#7b2ff7] "
    else
      output+="#[fg=#b8a9c9,bg=#16213e] ${window_index}:${window_name} "
    fi
  done < <(tmux list-windows -t "$session_name" -F "#{window_index}	#{window_name}	#{window_active}" 2>/dev/null)
  echo -n "$output"
  exit 0
fi

# State priority for worst-state-wins aggregation (higher = worse)
# error > permission > working > spawning > idle > done > suspended
#
# Single jq pass: filter workers by session, group by windowName,
# compute count + aggregate state per window.
# Output: tab-separated lines: windowName\tcount\tworst_state
worker_data=$(jq -r --arg sess "$session_name" '
  # State priority mapping
  def state_priority:
    {"error": 7, "permission": 6, "working": 5, "spawning": 4, "idle": 3, "done": 2, "suspended": 1};

  # Emoji mapping
  def state_emoji:
    {"spawning": "⏳", "working": "🔨", "idle": "⏸", "done": "✓", "error": "✗", "permission": "❓", "suspended": "💤"};

  .workers // {} | to_entries
  | map(select(.value.session == $sess))
  | group_by(.value.windowName // .value.team // "unknown")
  | map({
      window: (.[0].value.windowName // .[0].value.team // "unknown"),
      count: length,
      worst_state: (
        map(.value.state // "idle")
        | map(. as $s | state_priority[$s] // 0)
        | max
        | . as $max_pri
        | state_priority | to_entries | map(select(.value == $max_pri)) | .[0].key // "idle"
      ),
    })
  | map(.window + "\t" + (.count | tostring) + "\t" + (state_emoji[.worst_state] // ""))
  | .[]
' "$workers_file" 2>/dev/null) || worker_data=""

# Build lookup table from worker data (avoid subshells in loop)
declare -A window_counts=()
declare -A window_emojis=()

if [[ -n "$worker_data" ]]; then
  while IFS=$'\t' read -r wname wcount wemoji; do
    [[ -z "$wname" ]] && continue
    window_counts["$wname"]="$wcount"
    window_emojis["$wname"]="$wemoji"
  done <<< "$worker_data"
fi

# If tmux is available, render with live window info
if [[ "$has_tmux" == "true" ]]; then
  output=""
  while IFS=$'\t' read -r window_index window_name window_active; do
    [[ -z "$window_index" ]] && continue

    count="${window_counts[$window_name]:-}"
    emoji="${window_emojis[$window_name]:-}"

    # Build enriched label: name ×count emoji
    label="${window_name}"
    if [[ -n "$count" && "$count" -gt 0 ]]; then
      label+=" ×${count}"
    fi
    if [[ -n "$emoji" ]]; then
      label+=" ${emoji}"
    fi

    if [[ "$window_active" == "1" ]]; then
      output+="#[bg=#7b2ff7,fg=#e0e0e0,bold] ${label} #[bg=#16213e,fg=#7b2ff7] "
    else
      output+="#[fg=#b8a9c9,bg=#16213e] ${label} "
    fi
  done < <(tmux list-windows -t "$session_name" -F "#{window_index}	#{window_name}	#{window_active}" 2>/dev/null)
  echo -n "$output"
else
  # No tmux available (testing mode): render from workers.json data only
  output=""
  for wname in "${!window_counts[@]}"; do
    count="${window_counts[$wname]}"
    emoji="${window_emojis[$wname]:-}"
    label="${wname}"
    if [[ -n "$count" && "$count" -gt 0 ]]; then
      label+=" ×${count}"
    fi
    if [[ -n "$emoji" ]]; then
      label+=" ${emoji}"
    fi
    output+="#[fg=#b8a9c9,bg=#16213e] ${label} "
  done
  echo -n "$output"
fi
