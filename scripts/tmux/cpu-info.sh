#!/usr/bin/env bash
# Genie TUI — CPU usage for tmux status bar
# Linux: reads /proc/stat (instant). macOS: falls back to ps.
# Self-contained — no external dependencies

set -euo pipefail

CACHE_DIR="${HOME}/.genie/cache"
CACHE_FILE="${CACHE_DIR}/cpu_stat_prev"

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

cpu_linux() {
  # Read current /proc/stat
  local line
  line=$(head -1 /proc/stat)
  # cpu  user nice system idle iowait irq softirq steal
  local -a fields
  read -ra fields <<< "$line"

  local user="${fields[1]}"
  local nice="${fields[2]}"
  local system="${fields[3]}"
  local idle="${fields[4]}"
  local iowait="${fields[5]:-0}"
  local irq="${fields[6]:-0}"
  local softirq="${fields[7]:-0}"
  local steal="${fields[8]:-0}"

  local total=$((user + nice + system + idle + iowait + irq + softirq + steal))
  local busy=$((total - idle - iowait))

  # Read previous sample from cache
  mkdir -p "$CACHE_DIR"
  if [[ -f "$CACHE_FILE" ]]; then
    local prev_busy prev_total
    read -r prev_busy prev_total < "$CACHE_FILE" 2>/dev/null || true

    if [[ -n "${prev_busy:-}" && -n "${prev_total:-}" ]]; then
      local diff_busy=$((busy - prev_busy))
      local diff_total=$((total - prev_total))

      if [[ "$diff_total" -gt 0 ]]; then
        local cpu_pct=$((diff_busy * 100 / diff_total))
        echo "$busy $total" > "$CACHE_FILE"
        echo "${cpu_pct}%"
        return 0
      fi
    fi
  fi

  # First run — store baseline, show current snapshot
  echo "$busy $total" > "$CACHE_FILE"
  if [[ "$total" -gt 0 ]]; then
    local cpu_pct=$((busy * 100 / total))
    echo "${cpu_pct}%"
  else
    echo "0%"
  fi
}

cpu_macos() {
  local cpu_pct
  cpu_pct=$(ps -A -o %cpu | awk '{sum += $1} END {printf "%.0f", sum / NR}')
  echo "${cpu_pct}%"
}

main() {
  case "$(uname -s)" in
    Linux)  cpu_linux ;;
    Darwin) cpu_macos ;;
    *)      echo "?%" ;;
  esac
}

main
