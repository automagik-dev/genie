#!/usr/bin/env bash
# Genie TUI — project session tabs for tmux top status bar
# Stub: reads tmux list-sessions and counts windows per session.
# Full enrichment (agent counts from workers.json) added in Group 4.
#
# Output format per session:
#   Active:   #[bg=#7b2ff7,fg=#e0e0e0,bold] name (N) #[bg=#1a1a2e,fg=#7b2ff7]
#   Inactive: #[fg=#b8a9c9,bg=#1a1a2e] name (N)

set -euo pipefail

# Get the currently active session name
active_session=$(tmux display-message -p '#{client_session}' 2>/dev/null) || active_session=""

# List all sessions with window counts
output=""
while IFS=$'\t' read -r session_name window_count; do
  # Skip empty lines
  [[ -z "$session_name" ]] && continue

  if [[ "$session_name" == "$active_session" ]]; then
    # Active session: purple highlight
    output+="#[bg=#7b2ff7,fg=#e0e0e0,bold] ${session_name} (${window_count}) #[bg=#1a1a2e,fg=#7b2ff7] "
  else
    # Inactive session: dim lavender
    output+="#[fg=#b8a9c9,bg=#1a1a2e] ${session_name} (${window_count}) "
  fi
done < <(tmux list-sessions -F "#{session_name}	#{session_windows}" 2>/dev/null)

echo -n "$output"
