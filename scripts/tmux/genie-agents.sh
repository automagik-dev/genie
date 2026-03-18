#!/usr/bin/env bash
set -euo pipefail

session="${1:-}"
[[ -z "$session" ]] && exit 0

workers_file="${GENIE_WORKERS:-${HOME}/.genie/workers.json}"
[[ ! -f "$workers_file" ]] && exit 0

# Single jq pass: filter team-leads for this session, dedupe by team, map state to emoji
jq -r --arg sess "$session" '
  .workers // {} | to_entries
  | map(select(.value.role == "team-lead" and .value.session == $sess))
  | group_by(.value.team)
  | map(.[0])
  | map(
      .value.team + "\t" + (
        if .value.state == "working" then "🔨"
        elif .value.state == "idle" then "⏸"
        elif .value.state == "done" then "✓"
        elif .value.state == "error" then "✗"
        elif .value.state == "permission" then "❓"
        elif .value.state == "spawning" then "⏳"
        elif .value.state == "suspended" then "💤"
        else "?"
        end
      )
    )
  | .[]
' "$workers_file" 2>/dev/null | while IFS=$'\t' read -r team emoji; do
  printf '#[fg=#e0e0e0,bg=#1a1a2e] %s %s ' "$team" "$emoji"
done
