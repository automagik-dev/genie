#!/usr/bin/env bash
# run-metrics.sh — Orchestrator for velocity dashboard metrics pipeline.
#
# Collects git-based metrics, generates SVG charts, builds VELOCITY.md
# and README hero, then commits and pushes.
#
# Usage: bash run-metrics.sh [--dry-run]
#
# Steps:
#   1. collect-stats.sh --date today  → append to daily-stats.jsonl
#   2. If daily-stats.jsonl has <30 entries → run backfill.sh
#   3. generate-charts.py             → .genie/assets/*.svg
#   4. generate-velocity.py           → VELOCITY.md
#   5. generate-readme-hero.py        → README.md
#   6. git add + commit + push        (skipped with --dry-run)
#   7. Update state.json + append to runs.jsonl
#
# Exit codes:
#   0 — Success
#   1 — Fatal error

set -euo pipefail

# --- Configuration ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$(dirname "$SCRIPT_DIR")"
REPO_ROOT="$(git rev-parse --show-toplevel)"
DRY_RUN=false
ERRORS=()

# --- Step Timing ---
declare -a STEP_NAMES=()
declare -a STEP_DURATIONS=()
STEP_START=0

now_ms() {
  python3 -c 'import time; print(int(time.time()*1000))'
}

step_start() {
  STEP_START=$(now_ms)
}

step_end() {
  local name="$1"
  local end_ms
  end_ms=$(now_ms)
  local duration=$((end_ms - STEP_START))
  STEP_NAMES+=("$name")
  STEP_DURATIONS+=("$duration")
  log "  $name: ${duration}ms"
}

RUN_START=$(now_ms)

# --- Parse args ---
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

STATE_FILE="$AGENT_DIR/state.json"
RUNS_FILE="$AGENT_DIR/runs.jsonl"
STATS_FILE="$AGENT_DIR/daily-stats.jsonl"
ASSETS_DIR="$REPO_ROOT/.genie/assets"

log() { echo "[metrics-updater] $*" >&2; }
log_error() { ERRORS+=("$1"); log "ERROR: $1"; }

# --- Step 1: Collect today's stats ---
step_start
log "Step 1: Collecting stats for today..."
TODAY=$(date +%Y-%m-%d)
TODAY_STATS=$(bash "$SCRIPT_DIR/collect-stats.sh" --date "$TODAY") || {
  log_error "collect-stats.sh failed"
  exit 1
}

# Remove existing entry for today (idempotent), then append
if [[ -f "$STATS_FILE" ]]; then
  tmp=$(mktemp)
  grep -v "\"date\":\"$TODAY\"" "$STATS_FILE" > "$tmp" || true
  mv "$tmp" "$STATS_FILE"
fi
echo "$TODAY_STATS" >> "$STATS_FILE"
log "  Today's stats: $TODAY_STATS"
step_end "collect_stats"

# --- Step 2: Backfill if <30 entries ---
step_start
ENTRY_COUNT=$(wc -l < "$STATS_FILE" | tr -d ' ')
log "Step 2: daily-stats.jsonl has $ENTRY_COUNT entries"
if [[ "$ENTRY_COUNT" -lt 30 ]]; then
  log "  Running backfill (need 30, have $ENTRY_COUNT)..."
  bash "$SCRIPT_DIR/backfill.sh" || {
    log_error "backfill.sh failed"
    exit 1
  }
  ENTRY_COUNT=$(wc -l < "$STATS_FILE" | tr -d ' ')
  log "  After backfill: $ENTRY_COUNT entries"
fi
step_end "backfill_check"

# --- Step 3: Generate SVG charts ---
step_start
log "Step 3: Generating SVG charts..."
mkdir -p "$ASSETS_DIR"
python3 "$SCRIPT_DIR/generate-charts.py" \
  --input "$STATS_FILE" \
  --output-dir "$ASSETS_DIR" || {
  log_error "generate-charts.py failed"
  exit 1
}
CHARTS_COUNT=$(find "$ASSETS_DIR" -name '*.svg' | wc -l | tr -d ' ')
log "  Generated $CHARTS_COUNT charts in $ASSETS_DIR"
step_end "generate_charts"

# --- Step 4: Generate VELOCITY.md ---
step_start
log "Step 4: Generating VELOCITY.md..."
python3 "$SCRIPT_DIR/generate-velocity.py" \
  --stats-dir "$AGENT_DIR" \
  --assets-dir ".genie/assets" \
  --output "$REPO_ROOT/VELOCITY.md" || {
  log_error "generate-velocity.py failed"
  exit 1
}
step_end "generate_velocity"

# --- Step 5: Generate README hero ---
step_start
log "Step 5: Updating README.md hero..."
python3 "$SCRIPT_DIR/generate-readme-hero.py" \
  --stats-dir "$AGENT_DIR" \
  --readme "$REPO_ROOT/README.md" || {
  log_error "generate-readme-hero.py failed"
  exit 1
}
step_end "generate_readme"

# --- Step 6: Git commit + push ---
step_start
if [[ "$DRY_RUN" == "true" ]]; then
  log "Step 6: DRY RUN — skipping commit/push"
else
  log "Step 6: Committing and pushing..."
  cd "$REPO_ROOT"

  # Build compact commit summary from today's stats
  COMMITS=$(echo "$TODAY_STATS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['commits'])")
  RELEASES=$(echo "$TODAY_STATS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['releases'])")
  LOC_ADDED=$(echo "$TODAY_STATS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['loc_added'])")
  LOC_REMOVED=$(echo "$TODAY_STATS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['loc_removed'])")

  COMMIT_MSG="chore: update live metrics (${COMMITS} commits, ${RELEASES} releases, +${LOC_ADDED}/-${LOC_REMOVED} LoC)"

  git add README.md VELOCITY.md .genie/assets/ .genie/agents/metrics-updater/daily-stats.jsonl .genie/agents/metrics-updater/state.json
  git commit -m "$COMMIT_MSG" || log "No changes to commit"
  git push || log_error "git push failed"
fi
step_end "commit_push"

# --- Step 7: Update state.json + runs.jsonl ---
step_start
log "Step 7: Updating state.json and runs.jsonl..."

RUN_END=$(now_ms)
DURATION=$((RUN_END - RUN_START))

# Build steps JSON
STEPS_JSON=$(python3 -c "
import json
names = $(printf '%s\n' "${STEP_NAMES[@]}" | python3 -c "import sys,json; print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))")
durs = $(printf '%s\n' "${STEP_DURATIONS[@]}" | python3 -c "import sys,json; print(json.dumps([int(l.strip()) for l in sys.stdin if l.strip()]))")
print(json.dumps([{'name':n,'duration_ms':d} for n,d in zip(names,durs)]))
")

ERRORS_JSON="[]"
if [[ ${#ERRORS[@]} -gt 0 ]]; then
  ERRORS_JSON=$(printf '%s\n' "${ERRORS[@]}" | python3 -c "import sys,json; print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))")
fi

RUN_STATUS="success"
[[ ${#ERRORS[@]} -gt 0 ]] && RUN_STATUS="partial"

python3 << PYEOF
import json
from datetime import datetime, timezone

now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
entry_count = 0
with open("$STATS_FILE") as f:
    entry_count = sum(1 for line in f if line.strip())

# Update state.json
state = {}
try:
    with open("$STATE_FILE") as f:
        state = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    pass

state["last_run"] = now
state["last_run_status"] = "$RUN_STATUS"
state["daily_stats_count"] = entry_count
state["charts_generated"] = $CHARTS_COUNT
state["velocity_md_updated"] = True
state["duration_ms"] = $DURATION

with open("$STATE_FILE", "w") as f:
    json.dump(state, f, indent=2)
    f.write("\n")

# Append to runs.jsonl
run_entry = {
    "timestamp": now,
    "duration_ms": $DURATION,
    "status": "$RUN_STATUS",
    "dry_run": $( [[ "$DRY_RUN" == "true" ]] && echo "True" || echo "False" ),
    "daily_stats_count": entry_count,
    "charts_generated": $CHARTS_COUNT,
    "velocity_md_updated": True,
    "errors": json.loads('$ERRORS_JSON'),
    "steps": json.loads('$STEPS_JSON'),
}

with open("$RUNS_FILE", "a") as f:
    f.write(json.dumps(run_entry) + "\n")

print(f"[metrics-updater] State updated: {entry_count} stats, {$CHARTS_COUNT} charts", file=__import__('sys').stderr)
PYEOF

step_end "update_state"

# --- Summary ---
RUN_END=$(now_ms)
TOTAL=$((RUN_END - RUN_START))
log "Run complete: ${TOTAL}ms total, status=$RUN_STATUS"
log "Step breakdown:"
for i in "${!STEP_NAMES[@]}"; do
  log "  ${STEP_NAMES[$i]}: ${STEP_DURATIONS[$i]}ms"
done
