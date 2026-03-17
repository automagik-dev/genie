#!/usr/bin/env bash
# Genie TUI — project session tabs for tmux top status bar
# Reads workers.json for agent counts per session, merges with tmux sessions.
#
# Output format per session:
#   Active:   #[bg=#7b2ff7,fg=#e0e0e0,bold] name (N) ● #[bg=#1a1a2e,fg=#7b2ff7]
#   Inactive: #[fg=#b8a9c9,bg=#1a1a2e] name (N)
#
# Env: GENIE_WORKERS — override path to workers.json (for testing)

set -euo pipefail

workers_file="${GENIE_WORKERS:-${HOME}/.genie/workers.json}"

# Get agent counts per session from workers.json (single jq pass)
declare -A agent_counts=()
if [[ -f "$workers_file" ]]; then
  worker_data=$(jq -r '
    .workers // {} | to_entries
    | group_by(.value.session)
    | map({session: .[0].value.session, count: length})
    | map(.session + "\t" + (.count | tostring))
    | .[]
  ' "$workers_file" 2>/dev/null) || worker_data=""

  if [[ -n "$worker_data" ]]; then
    while IFS=$'\t' read -r sess count; do
      [[ -z "$sess" ]] && continue
      agent_counts["$sess"]="$count"
    done <<< "$worker_data"
  fi
fi

# Get the currently active session name
has_tmux=true
active_session=""
if command -v tmux &>/dev/null; then
  active_session=$(tmux display-message -p '#{client_session}' 2>/dev/null) || active_session=""
else
  has_tmux=false
fi

output=""
declare -A seen_sessions=()

if [[ "$has_tmux" == "true" ]]; then
  # Merge tmux sessions with agent counts
  while IFS=$'\t' read -r session_name window_count; do
    [[ -z "$session_name" ]] && continue
    seen_sessions["$session_name"]=1

    # Use agent count from workers.json; fall back to window count
    task_count="${agent_counts[$session_name]:-$window_count}"

    if [[ "$session_name" == "$active_session" ]]; then
      output+="#[bg=#7b2ff7,fg=#e0e0e0,bold] ${session_name} (${task_count}) ● #[bg=#1a1a2e,fg=#7b2ff7] "
    else
      output+="#[fg=#b8a9c9,bg=#1a1a2e] ${session_name} (${task_count}) "
    fi
  done < <(tmux list-sessions -F "#{session_name}	#{session_windows}" 2>/dev/null)
fi

# Also include sessions from workers.json not yet seen (no tmux session or testing mode)
for sess in "${!agent_counts[@]}"; do
  [[ -n "${seen_sessions[$sess]:-}" ]] && continue
  count="${agent_counts[$sess]}"
  output+="#[fg=#b8a9c9,bg=#1a1a2e] ${sess} (${count}) "
done

echo -n "$output"
