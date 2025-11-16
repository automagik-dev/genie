#!/usr/bin/env bash
set -euo pipefail

# Quick QA validation for Genie CLI Bug #1
# Validates that `genie run <agent> "<prompt>"`:
#  - returns within ~5–10 seconds (non-hanging background launch)
#  - creates/updates a background task entry in tasks.json
#  - creates a log file for the run
#  - optionally detects a printed banner (best-effort; may depend on TTY)

AGENT="plan"
PROMPT=${1:-"Bug #1 QA: session id banner timeout"}
OUTDIR=".genie/reports/evidence-cli-bugfixes"
mkdir -p "$OUTDIR"

TS=$(date -u +%Y%m%d%H%M%S)
OUTFILE="$OUTDIR/bug1-qa-${TS}.txt"

echo "[Bug1 QA] Starting validation at $(date -u -Iseconds)" | tee "$OUTFILE"
echo "[Bug1 QA] Command: genie run $AGENT \"$PROMPT\"" | tee -a "$OUTFILE"

start_ts=$(date +%s)
set +e
timeout 12s genie run "$AGENT" "$PROMPT" >"$OUTDIR/bug1-qa-run-${TS}.stdout" 2>"$OUTDIR/bug1-qa-run-${TS}.stderr"
rc=$?
set -e
end_ts=$(date +%s)
elapsed=$(( end_ts - start_ts ))

echo "[Bug1 QA] Exit code: $rc" | tee -a "$OUTFILE"
echo "[Bug1 QA] Elapsed seconds: $elapsed" | tee -a "$OUTFILE"

# 1) Check elapsed time (should be <= 10s)
if [ "$elapsed" -le 10 ]; then
  echo "[PASS] Command returned within expected timeout window (<=10s)" | tee -a "$OUTFILE"
else
  echo "[FAIL] Command exceeded expected timeout window (>10s)" | tee -a "$OUTFILE"
fi

attempt_id=""
stdout_file="$OUTDIR/bug1-qa-run-${TS}.stdout"
stderr_file="$OUTDIR/bug1-qa-run-${TS}.stderr"

if command -v jq >/dev/null 2>&1; then
  attempt_id=$(jq -r '.task_id // ""' "$stdout_file" 2>/dev/null || echo "")
fi

if [ -z "$attempt_id" ]; then
  attempt_id=$(grep -Eo 'genie resume [0-9a-f-]+' "$stdout_file" "$stderr_file" 2>/dev/null | awk '{print $3}' | tail -n1 || echo "")
fi

if [ -n "$attempt_id" ]; then
  echo "[INFO] Extracted attempt ID: $attempt_id" | tee -a "$OUTFILE"
else
  echo "[WARN] Could not extract attempt ID from output" | tee -a "$OUTFILE"
fi

# 3) Check tasks.json updated and contains agent entry
TASK_FILE=".genie/state/tasks.json"
LEGACY_SESSIONS_FILE=".genie/state/agents/sessions.json"
if [ ! -f "$TASK_FILE" ] && [ -f "$LEGACY_SESSIONS_FILE" ]; then
  TASK_FILE="$LEGACY_SESSIONS_FILE"
fi

if [ -f "$TASK_FILE" ]; then
  echo "[INFO] Task store present at $TASK_FILE" | tee -a "$OUTFILE"
  
  if command -v jq >/dev/null 2>&1; then
    store_version=$(jq -r '.version // 0' "$TASK_FILE" 2>/dev/null || echo "0")
    echo "[INFO] Task store version: $store_version" | tee -a "$OUTFILE"
  fi
  
  # Try to validate agent entry with jq if available; otherwise grep
  if command -v jq >/dev/null 2>&1; then
    if [ -n "$attempt_id" ]; then
      agent_present=$(jq -r --arg id "$attempt_id" --arg a "$AGENT" \
        'if (.sessions[$id] and .sessions[$id].agent == $a) then "yes" else "no" end' "$TASK_FILE")
    else
      agent_present=$(jq -r --arg a "$AGENT" \
        '[.sessions[]? | select(.agent == $a)] | length | if . > 0 then "yes" else "no" end' "$TASK_FILE")
    fi
  else
    agent_present=$(grep -q '"agent"[[:space:]]*:[[:space:]]*"'"$AGENT"'"' "$TASK_FILE" && echo yes || echo no)
  fi
  
  if [ "$agent_present" = "yes" ]; then
    echo "[PASS] Task store contains agent entry: $AGENT" | tee -a "$OUTFILE"
  else
    echo "[FAIL] Task store missing agent entry: $AGENT" | tee -a "$OUTFILE"
  fi
else
  echo "[FAIL] Task store not found at .genie/state/tasks.json (checked legacy path too)" | tee -a "$OUTFILE"
fi

LOG_FILE=""
if [ -n "$attempt_id" ]; then
  LOG_FILE=$(find .genie -type f -iname "*${attempt_id}*.log" -print -quit 2>/dev/null || echo "")
fi

if [ -n "$LOG_FILE" ] && [ -f "$LOG_FILE" ]; then
  echo "[PASS] Log file exists: $LOG_FILE" | tee -a "$OUTFILE"
else
  echo "[WARN] Log file missing or unknown (attempt_id='$attempt_id', LOG_FILE='$LOG_FILE')" | tee -a "$OUTFILE"
fi

# 5) Best-effort: detect banner text or JSON output in stdout/stderr
if rg -n "session pending|task pending|task_id|Resume: genie resume|View: genie view|Stop: genie stop|genie task monitor" "$stdout_file" "$stderr_file" >/dev/null 2>&1; then
  echo "[PASS] Found background banner, JSON output, or actions in output" | tee -a "$OUTFILE"
else
  echo "[WARN] No banner or JSON output detected (may depend on TTY rendering or output format)" | tee -a "$OUTFILE"
fi

echo "[Bug1 QA] Evidence files:" | tee -a "$OUTFILE"
echo "  - $OUTFILE" | tee -a "$OUTFILE"
echo "  - $stdout_file" | tee -a "$OUTFILE"
echo "  - $stderr_file" | tee -a "$OUTFILE"

echo "[Bug1 QA] Done." | tee -a "$OUTFILE"
