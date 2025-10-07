#!/usr/bin/env bash
set -euo pipefail
if [[ "${GENIE_SKIP_IDENTITY_SMOKE:-0}" == "1" ]]; then
  echo 'Skipping identity smoke test (GENIE_SKIP_IDENTITY_SMOKE=1)'
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="$REPO_DIR/.genie/state/agents/logs"

mkdir -p "$LOG_DIR"

AGENT="plan"
PROMPT=${1:-"Identity smoke test"}
LOG_PREFIX=${AGENT//\//-}

before_snapshot=$(ls "$LOG_DIR"/"$LOG_PREFIX"-*.log 2>/dev/null || true)

# Launch the agent in background; suppress stdout
genie run "$AGENT" "$PROMPT" > /dev/null &
run_pid=$!

log_file=""
for _ in {1..60}; do
  sleep 0.5
  candidate=$(ls -t "$LOG_DIR"/"$LOG_PREFIX"-*.log 2>/dev/null | head -n1 || true)
  if [ -n "$candidate" ] && ! grep -Fxq "$candidate" <<< "$before_snapshot"; then
    log_file="$candidate"
    break
  fi
  if ! kill -0 "$run_pid" 2>/dev/null; then
    break
  fi

done

# Fallback: resolve the log file from the session store if pattern match failed
if [ -z "$log_file" ]; then
  sessions_path="$REPO_DIR/.genie/state/agents/sessions.json"
  for _ in {1..60}; do
    if [ -f "$sessions_path" ]; then
      # Use Node to robustly parse JSON and read the agent logFile
      log_candidate=$(node -e '
        try {
          const fs = require("fs");
          const p = process.argv[1];
          const agent = process.argv[2];
          if (!fs.existsSync(p)) { process.exit(0); }
          const data = JSON.parse(fs.readFileSync(p, "utf8"));
          const entry = data && data.agents && data.agents[agent];
          if (entry && entry.logFile) { console.log(entry.logFile); }
        } catch {}
      ' "$sessions_path" "$AGENT" 2>/dev/null || true)
      if [ -n "$log_candidate" ]; then
        # sessions.json stores a repo-relative path; normalize to absolute
        if [[ "$log_candidate" != /* ]]; then
          cand_abs="$REPO_DIR/$log_candidate"
        else
          cand_abs="$log_candidate"
        fi
        if [ -f "$cand_abs" ]; then
          log_file="$cand_abs"
          break
        fi
      fi
    fi
    sleep 0.5
  done
fi

wait "$run_pid" 2>/dev/null || true

if [ -z "$log_file" ]; then
  echo "Failed to capture $AGENT log" >&2
  exit 1
fi

session_id=""
for _ in {1..120}; do
  session_id=$(rg -o '"session_id":"([^"]+)"' -r '$1' "$log_file" 2>/dev/null | head -n1 || true)
  if [ -n "$session_id" ]; then
    break
  fi
  sleep 0.5

done

if [ -z "$session_id" ]; then
  echo "Failed to extract session id from $log_file" >&2
  tail -n 40 "$log_file" >&2
  exit 1
fi

for _ in {1..300}; do
  if rg -q '"turn.completed"' "$log_file"; then
    break
  fi
  sleep 0.5

done

identity_found=0
if rg -q '\*\*Identity\*\*' "$log_file" && rg -q 'Name: GENIE' "$log_file"; then
  identity_found=1
fi

genie stop "$session_id" > /dev/null || true

if [ "$identity_found" -ne 1 ]; then
  echo "Identity block not found in $log_file" >&2
  echo "--- log excerpt ---" >&2
  tail -n 80 "$log_file" >&2
  exit 1
fi

echo "Identity smoke test passed"
