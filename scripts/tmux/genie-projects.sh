#!/usr/bin/env bash
# Genie TUI — project session tabs for tmux top status bar
# Reads workers.json for agent counts per session, merges with tmux sessions.
#
# Colors are read from the generated theme via `tmux show-environment -g`,
# which is populated by sourcing scripts/tmux/.generated.theme.conf at server
# start. Single source of truth — no hex literals in this script.
#
# Output format per session:
#   Active:   #[bg=$ACCENT,fg=$BG,bold] name (N) ● #[bg=$BG,fg=$ACCENT]
#   Inactive: #[fg=$TEXT_DIM,bg=$BG] name (N)
#
# Env: GENIE_WORKERS — override path to workers.json (for testing)

set -euo pipefail

workers_file="${GENIE_WORKERS:-${HOME}/.genie/workers.json}"

# Resolve a tmux global env var to a color value. Reads from the running
# tmux server first; falls back to parsing the generated theme conf so the
# script still works in unit tests / dry-runs outside a tmux session.
# Either way, no hex literal lives in this file — single source of truth.
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
TEXT=$(resolve_color GENIE_TMUX_TEXT)
TEXT_DIM=$(resolve_color GENIE_TMUX_TEXT_DIM)
TEXT_MUTED=$(resolve_color GENIE_TMUX_TEXT_MUTED)

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

max_visible=8
output=""
declare -A seen_sessions=()
declare -a all_sessions=()
active_output=""

if [[ "$has_tmux" == "true" ]]; then
  # Collect all sessions with their rendered output
  while IFS=$'\t' read -r session_name window_count; do
    [[ -z "$session_name" ]] && continue
    seen_sessions["$session_name"]=1
    all_sessions+=("$session_name")

    # Use agent count from workers.json; fall back to window count
    task_count="${agent_counts[$session_name]:-$window_count}"

    if [[ "$session_name" == "$active_session" ]]; then
      active_output="#[bg=${ACCENT},fg=${BG},bold] ${session_name} (${task_count}) ● #[bg=${BG},fg=${ACCENT}] "
    fi
  done < <(tmux list-sessions -F "#{session_name}	#{session_windows}" 2>/dev/null)
fi

# Also include sessions from workers.json not yet seen (no tmux session or testing mode)
for sess in "${!agent_counts[@]}"; do
  [[ -n "${seen_sessions[$sess]:-}" ]] && continue
  all_sessions+=("$sess")
done

total=${#all_sessions[@]}

if [[ "$total" -le "$max_visible" ]]; then
  # No overflow — render all sessions
  for session_name in "${all_sessions[@]}"; do
    task_count="${agent_counts[$session_name]:-0}"
    # Prefer window count from tmux if available
    if [[ "$has_tmux" == "true" ]]; then
      wcount=$(tmux list-windows -t "$session_name" -F "x" 2>/dev/null | wc -l) || wcount=0
      task_count="${agent_counts[$session_name]:-$wcount}"
    fi

    if [[ "$session_name" == "$active_session" ]]; then
      output+="#[bg=${ACCENT},fg=${BG},bold] ${session_name} (${task_count}) ● #[bg=${BG},fg=${ACCENT}] "
    else
      output+="#[fg=${TEXT_DIM},bg=${BG}] ${session_name} (${task_count}) "
    fi
  done
else
  # Overflow — show up to max_visible with active session always included
  shown=0
  active_shown=false

  for session_name in "${all_sessions[@]}"; do
    if [[ "$shown" -ge "$((max_visible - 1))" && "$active_shown" == "false" && "$session_name" != "$active_session" ]]; then
      # Reserve last slot for active session
      continue
    fi
    if [[ "$shown" -ge "$max_visible" ]]; then
      break
    fi

    task_count="${agent_counts[$session_name]:-0}"
    if [[ "$has_tmux" == "true" ]]; then
      wcount=$(tmux list-windows -t "$session_name" -F "x" 2>/dev/null | wc -l) || wcount=0
      task_count="${agent_counts[$session_name]:-$wcount}"
    fi

    if [[ "$session_name" == "$active_session" ]]; then
      output+="#[bg=${ACCENT},fg=${BG},bold] ${session_name} (${task_count}) ● #[bg=${BG},fg=${ACCENT}] "
      active_shown=true
    else
      output+="#[fg=${TEXT_DIM},bg=${BG}] ${session_name} (${task_count}) "
    fi
    ((shown++)) || true
  done

  # If active session wasn't shown yet, append it
  if [[ "$active_shown" == "false" && -n "$active_session" ]]; then
    task_count="${agent_counts[$active_session]:-0}"
    if [[ "$has_tmux" == "true" ]]; then
      wcount=$(tmux list-windows -t "$active_session" -F "x" 2>/dev/null | wc -l) || wcount=0
      task_count="${agent_counts[$active_session]:-$wcount}"
    fi
    output+="#[bg=${ACCENT},fg=${BG},bold] ${active_session} (${task_count}) ● #[bg=${BG},fg=${ACCENT}] "
  fi

  # Append overflow indicator
  remaining=$((total - max_visible))
  output+="#[fg=${TEXT_MUTED},bg=${BG}] +${remaining} more "
fi

# Reference unused vars to keep linters happy without dropping the resolution
# code (they remain available for shells sourcing this script).
: "${BG_RAISED}" "${TEXT}"

echo -n "$output"
