#!/usr/bin/env bash
# Genie TUI — RAM usage for tmux status bar
# Supports Linux + macOS
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

ram_linux() {
  # Parse /proc/meminfo
  local total_kb available_kb
  total_kb=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)
  available_kb=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)

  if [[ -z "$total_kb" || "$total_kb" -eq 0 ]]; then
    echo "?G"
    return 0
  fi

  local used_kb=$((total_kb - available_kb))
  local total_gb used_gb pct

  # Integer math: multiply by 10 for one decimal place
  used_gb=$(( (used_kb * 10) / 1048576 ))
  total_gb=$(( (total_kb * 10) / 1048576 ))
  pct=$((used_kb * 100 / total_kb))

  # Format with one decimal: e.g. 82 -> 8.2
  local used_int=$((used_gb / 10))
  local used_dec=$((used_gb % 10))
  local total_int=$((total_gb / 10))
  local total_dec=$((total_gb % 10))

  echo "${used_int}.${used_dec}/${total_int}.${total_dec}G ${pct}%"
}

ram_macos() {
  # Use vm_stat for memory info
  local page_size
  page_size=$(sysctl -n hw.pagesize 2>/dev/null || echo 4096)

  local total_bytes
  total_bytes=$(sysctl -n hw.memsize 2>/dev/null) || {
    echo "?G"
    return 0
  }

  # Get pages from vm_stat
  local active inactive wired compressed
  local vmstat
  vmstat=$(vm_stat 2>/dev/null) || {
    echo "?G"
    return 0
  }

  active=$(echo "$vmstat" | awk '/Pages active:/ {gsub(/\./,"",$3); print $3}')
  inactive=$(echo "$vmstat" | awk '/Pages inactive:/ {gsub(/\./,"",$3); print $3}')
  wired=$(echo "$vmstat" | awk '/Pages wired down:/ {gsub(/\./,"",$4); print $4}')
  compressed=$(echo "$vmstat" | awk '/Pages occupied by compressor:/ {gsub(/\./,"",$5); print $5}')

  local used_pages=$(( ${active:-0} + ${wired:-0} + ${compressed:-0} ))
  local used_bytes=$((used_pages * page_size))

  local total_gb used_gb pct
  used_gb=$(( (used_bytes / 1073741824 * 10 + used_bytes % 1073741824 * 10 / 1073741824) ))
  total_gb=$(( (total_bytes / 1073741824 * 10 + total_bytes % 1073741824 * 10 / 1073741824) ))

  if [[ "$total_bytes" -gt 0 ]]; then
    pct=$((used_bytes * 100 / total_bytes))
  else
    pct=0
  fi

  local used_int=$((used_gb / 10))
  local used_dec=$((used_gb % 10))
  local total_int=$((total_gb / 10))
  local total_dec=$((total_gb % 10))

  echo "${used_int}.${used_dec}/${total_int}.${total_dec}G ${pct}%"
}

main() {
  case "$(uname -s)" in
    Linux)  ram_linux ;;
    Darwin) ram_macos ;;
    *)      echo "?G" ;;
  esac
}

main
