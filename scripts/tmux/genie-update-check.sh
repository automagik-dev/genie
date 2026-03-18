#!/usr/bin/env bash
# Genie TUI — version check with 30-minute cache
# Compares installed version against npm registry
# Self-contained — no external dependencies

set -euo pipefail

CACHE_DIR="${HOME}/.genie/cache"
CACHE_FILE="${CACHE_DIR}/update_check"
CACHE_TTL=1800  # 30 minutes in seconds

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

get_current_version() {
  genie --version 2>/dev/null | head -1 | sed 's/[^0-9.]//g' || echo ""
}

check_latest_version() {
  # Try npm registry
  local latest
  latest=$(npm view @automagik/genie version 2>/dev/null) || true
  echo "${latest:-}"
}

is_cache_valid() {
  if [[ ! -f "$CACHE_FILE" ]]; then
    return 1
  fi

  local now file_age cache_age
  now=$(date +%s)
  file_age=$(stat -c %Y "$CACHE_FILE" 2>/dev/null || stat -f %m "$CACHE_FILE" 2>/dev/null || echo 0)
  cache_age=$((now - file_age))

  [[ "$cache_age" -lt "$CACHE_TTL" ]]
}

main() {
  mkdir -p "$CACHE_DIR"

  local current_version
  current_version=$(get_current_version)

  if [[ -z "$current_version" ]]; then
    echo ""
    return 0
  fi

  # Check cache
  if is_cache_valid; then
    local cached_result
    cached_result=$(cat "$CACHE_FILE" 2>/dev/null) || true
    if [[ -n "$cached_result" ]]; then
      echo "$cached_result"
      return 0
    fi
  fi

  # Fetch latest version (run in background-safe way)
  local latest_version
  latest_version=$(check_latest_version)

  if [[ -z "$latest_version" ]]; then
    # Can't reach registry — show current version, cache empty result
    echo "v${current_version}" > "$CACHE_FILE"
    echo "v${current_version}"
    return 0
  fi

  # Compare versions — only show update if npm is newer
  local result="v${current_version}"
  if [[ "$current_version" != "$latest_version" ]]; then
    # Sort versions; if current comes first, npm is newer
    local older
    older=$(printf '%s\n%s\n' "$current_version" "$latest_version" | sort -V | head -1)
    if [[ "$older" == "$current_version" ]]; then
      result="v${current_version} ⬆ ${latest_version}"
    fi
  fi
  echo "$result" > "$CACHE_FILE"
  echo "$result"
}

main
