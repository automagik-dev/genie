#!/usr/bin/env bash
# run-metrics.sh — Main orchestrator for daily metrics update
# Fetches GitHub metrics, updates README.md, commits, and logs the run.
#
# Usage: bash run-metrics.sh [--dry-run] [--repo-root <path>]
#
# Exit codes:
#   0 — Success (README updated and committed)
#   1 — Fatal error
#   2 — No changes (metrics unchanged or fallback used with no diff)

set -euo pipefail

# --- Configuration ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$(dirname "$SCRIPT_DIR")"
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
OWNER="automagik-dev"
REPO="genie"
DRY_RUN=false
START_TIME=$(date +%s%3N 2>/dev/null || python3 -c 'import time; print(int(time.time()*1000))')
API_CALLS=0
ERRORS=()

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --repo-root) REPO_ROOT="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

STATE_FILE="$AGENT_DIR/state.json"
RUNS_FILE="$AGENT_DIR/runs.jsonl"
README_FILE="$REPO_ROOT/README.md"
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

log() { echo "[metrics-updater] $*" >&2; }
log_error() { ERRORS+=("$1"); log "ERROR: $1"; }

# --- Helper: safe gh API call with counting ---
gh_api() {
  local endpoint="$1"
  shift
  API_CALLS=$((API_CALLS + 1))
  gh api "$endpoint" "$@"
}

# --- Step 1: Load previous state for fallback ---
log "Loading state from $STATE_FILE"
LAST_METRICS=""
if [[ -f "$STATE_FILE" ]]; then
  LAST_METRICS=$(python3 -c "
import json, sys
with open('$STATE_FILE') as f:
    s = json.load(f)
m = s.get('last_metrics')
if m:
    print(json.dumps(m))
" 2>/dev/null || true)
fi

# --- Step 2: Fetch metrics from GitHub API ---
FETCH_OK=true

# 2a: Releases in last 24h
log "Fetching releases..."
RELEASES_JSON="$TMP_DIR/releases.json"
if gh_api "repos/$OWNER/$REPO/releases" --paginate > "$RELEASES_JSON" 2>&1; then
  log "Releases fetched OK"
else
  log_error "Failed to fetch releases"
  FETCH_OK=false
fi

# 2b: Closed/merged PRs in last 7 days
log "Fetching merged PRs..."
PRS_JSON="$TMP_DIR/prs.json"
if gh_api "repos/$OWNER/$REPO/pulls?state=closed&sort=updated&direction=desc&per_page=100" \
    > "$PRS_JSON" 2>&1; then
  log "PRs fetched OK"
else
  log_error "Failed to fetch PRs"
  FETCH_OK=false
fi

# 2c: Parallel agents (count active genie workers or tmux sessions)
log "Counting parallel agents..."
PARALLEL_AGENTS=0
if command -v genie &>/dev/null; then
  # Count active workers from the worker registry
  WORKERS_FILE="${GENIE_HOME:-$HOME/.genie}/workers.json"
  if [[ -f "$WORKERS_FILE" ]]; then
    PARALLEL_AGENTS=$(python3 -c "
import json
with open('$WORKERS_FILE') as f:
    workers = json.load(f)
active = [w for w in workers if w.get('status') in ('running', 'active', 'idle')]
print(len(active))
" 2>/dev/null || echo 0)
  fi
fi
# Fallback: count tmux sessions with genie prefix
if [[ "$PARALLEL_AGENTS" == "0" ]] && command -v tmux &>/dev/null; then
  PARALLEL_AGENTS=$(tmux list-sessions 2>/dev/null | grep -c 'genie' || echo 0)
fi
log "Parallel agents: $PARALLEL_AGENTS"

# --- Step 3: Parse and calculate metrics ---
METRICS_JSON="$TMP_DIR/metrics.json"
if [[ "$FETCH_OK" == "true" ]]; then
  log "Calculating metrics..."
  if python3 "$SCRIPT_DIR/parse-metrics.py" \
      --releases-json "$RELEASES_JSON" \
      --prs-json "$PRS_JSON" \
      --parallel-agents "$PARALLEL_AGENTS" \
      -o "$METRICS_JSON"; then
    log "Metrics calculated OK"
  else
    log_error "Metrics calculation failed"
    FETCH_OK=false
  fi
fi

# --- Step 3b: Fallback to last known metrics ---
if [[ "$FETCH_OK" != "true" ]]; then
  log "Falling back to cached metrics..."
  if [[ -n "$LAST_METRICS" ]]; then
    echo "$LAST_METRICS" > "$METRICS_JSON"
    log "Using cached metrics from state.json"
  else
    log_error "No cached metrics available — cannot update README"
    # Log the failed run
    END_TIME=$(date +%s%3N 2>/dev/null || python3 -c 'import time; print(int(time.time()*1000))')
    DURATION=$((END_TIME - START_TIME))
    ERRORS_JSON=$(printf '%s\n' "${ERRORS[@]}" | python3 -c "import sys,json; print(json.dumps([l.strip() for l in sys.stdin]))")
    echo "{\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"duration_ms\":$DURATION,\"api_calls\":$API_CALLS,\"tools_generated\":0,\"errors\":$ERRORS_JSON,\"status\":\"failed\",\"fallback\":true}" >> "$RUNS_FILE"
    exit 1
  fi
fi

# --- Step 4: Update README ---
log "Updating README at $README_FILE..."
README_CHANGED=false
if python3 "$SCRIPT_DIR/update-readme.py" --metrics "$METRICS_JSON" --readme "$README_FILE"; then
  README_CHANGED=true
fi

# --- Step 5: Update state.json ---
log "Updating state.json..."
METRICS_CONTENT=$(cat "$METRICS_JSON")
python3 -c "
import json
from datetime import datetime, timezone
with open('$STATE_FILE') as f:
    state = json.load(f)
state['last_metrics'] = json.loads('''$METRICS_CONTENT''')
state['last_run_at'] = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
state['run_count'] = state.get('run_count', 0) + 1
with open('$STATE_FILE', 'w') as f:
    json.dump(state, f, indent=2)
    f.write('\n')
"
log "State updated"

# --- Step 6: Commit (if not dry-run and README changed) ---
if [[ "$DRY_RUN" == "true" ]]; then
  log "DRY RUN — skipping commit"
  cat "$METRICS_JSON"
elif [[ "$README_CHANGED" == "true" ]]; then
  log "Generating commit message..."
  COMMIT_MSG=$(bash "$SCRIPT_DIR/commit-formatter.sh" "$METRICS_JSON")
  log "Committing: $COMMIT_MSG"

  cd "$REPO_ROOT"
  git add README.md
  git add .genie/agents/metrics-updater/state.json
  git commit -m "$COMMIT_MSG"
  log "Committed successfully"
else
  log "No README changes — skipping commit"
fi

# --- Step 7: Log run ---
END_TIME=$(date +%s%3N 2>/dev/null || python3 -c 'import time; print(int(time.time()*1000))')
DURATION=$((END_TIME - START_TIME))
ERRORS_JSON="[]"
if [[ ${#ERRORS[@]} -gt 0 ]]; then
  ERRORS_JSON=$(printf '%s\n' "${ERRORS[@]}" | python3 -c "import sys,json; print(json.dumps([l.strip() for l in sys.stdin]))")
fi
RUN_STATUS="success"
[[ "$README_CHANGED" != "true" ]] && RUN_STATUS="no_changes"

echo "{\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"duration_ms\":$DURATION,\"api_calls\":$API_CALLS,\"tools_generated\":0,\"errors\":$ERRORS_JSON,\"status\":\"$RUN_STATUS\",\"fallback\":false,\"metrics\":$METRICS_CONTENT}" >> "$RUNS_FILE"

log "Run complete: ${DURATION}ms, ${API_CALLS} API calls, status=$RUN_STATUS"
cat "$METRICS_JSON"
