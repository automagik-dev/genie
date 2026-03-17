#!/usr/bin/env bash
# Genie TUI — task window tabs for tmux bottom status bar
# Stub: reads tmux list-windows for the given session.
# Full enrichment (agent count + status emoji from workers.json) added in Group 4.
#
# Usage: genie-tasks.sh <session_name>
#
# Output format per window:
#   Active:   #[bg=#7b2ff7,fg=#e0e0e0,bold] idx:name #[bg=#16213e,fg=#7b2ff7]
#   Inactive: #[fg=#b8a9c9,bg=#16213e] idx:name

set -euo pipefail

session_name="${1:-}"
if [[ -z "$session_name" ]]; then
  echo -n ""
  exit 0
fi

# Verify session exists
if ! tmux has-session -t "$session_name" 2>/dev/null; then
  echo -n ""
  exit 0
fi

# Get active window index for this session
active_index=$(tmux display-message -t "$session_name" -p '#{window_index}' 2>/dev/null) || active_index=""

# List all windows in the session
output=""
while IFS=$'\t' read -r window_index window_name window_active; do
  [[ -z "$window_index" ]] && continue

  if [[ "$window_active" == "1" ]]; then
    # Active window: purple highlight
    output+="#[bg=#7b2ff7,fg=#e0e0e0,bold] ${window_index}:${window_name} #[bg=#16213e,fg=#7b2ff7] "
  else
    # Inactive window: dim lavender
    output+="#[fg=#b8a9c9,bg=#16213e] ${window_index}:${window_name} "
  fi
done < <(tmux list-windows -t "$session_name" -F "#{window_index}	#{window_name}	#{window_active}" 2>/dev/null)

echo -n "$output"
