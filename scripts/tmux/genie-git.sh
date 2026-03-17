#!/usr/bin/env bash
# Genie TUI — git status for tmux status bar
# Shows: branch, staged, modified, ahead/behind
# Self-contained — no external dependencies

set -euo pipefail

# Inline helper: get tmux option with default
get_tmux_option() {
  local option="$1"
  local default_value="${2:-}"
  local value
  value=$(tmux show-option -gqv "$option" 2>/dev/null) || true
  if [[ -n "$value" ]]; then
    echo "$value"
  else
    echo "$default_value"
  fi
}

# Find the git repo for the active pane's working directory
get_pane_path() {
  local pane_path
  pane_path=$(tmux display-message -p -F "#{pane_current_path}" 2>/dev/null) || true
  echo "${pane_path:-$PWD}"
}

main() {
  local pane_path
  pane_path=$(get_pane_path)

  # Check if we're in a git repo
  if ! git -C "$pane_path" rev-parse --is-inside-work-tree &>/dev/null; then
    echo ""
    return 0
  fi

  # Branch name
  local branch
  branch=$(git -C "$pane_path" symbolic-ref --short HEAD 2>/dev/null) || \
    branch=$(git -C "$pane_path" rev-parse --short HEAD 2>/dev/null) || \
    branch="?"

  local status_parts=()
  status_parts+=("$branch")

  # Staged count
  local staged
  staged=$(git -C "$pane_path" diff --cached --numstat 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$staged" -gt 0 ]]; then
    status_parts+=("+${staged}")
  fi

  # Modified (unstaged) count
  local modified
  modified=$(git -C "$pane_path" diff --numstat 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$modified" -gt 0 ]]; then
    status_parts+=("!${modified}")
  fi

  # Untracked count
  local untracked
  untracked=$(git -C "$pane_path" ls-files --others --exclude-standard 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$untracked" -gt 0 ]]; then
    status_parts+=("?${untracked}")
  fi

  # Ahead/behind
  local upstream
  upstream=$(git -C "$pane_path" rev-parse --abbrev-ref '@{upstream}' 2>/dev/null) || true
  if [[ -n "$upstream" ]]; then
    local ahead behind
    ahead=$(git -C "$pane_path" rev-list --count '@{upstream}..HEAD' 2>/dev/null) || ahead=0
    behind=$(git -C "$pane_path" rev-list --count 'HEAD..@{upstream}' 2>/dev/null) || behind=0
    if [[ "$ahead" -gt 0 ]]; then
      status_parts+=("^${ahead}")
    fi
    if [[ "$behind" -gt 0 ]]; then
      status_parts+=("v${behind}")
    fi
  fi

  # Join with spaces
  local IFS=' '
  echo "${status_parts[*]}"
}

main
