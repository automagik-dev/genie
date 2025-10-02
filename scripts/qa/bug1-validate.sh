#!/usr/bin/env bash
set -euo pipefail

# Quick QA validation for Genie CLI Bug #1
# Validates that `./genie run <agent> "<prompt>"`:
#  - returns within ~5–10 seconds (non-hanging background launch)
#  - creates/updates a background session entry in sessions.json
#  - creates a log file for the run
#  - optionally detects a printed banner (best-effort; may depend on TTY)

AGENT="plan"
PROMPT=${1:-"Bug #1 QA: session id banner timeout"}
OUTDIR=".genie/reports/evidence-cli-bugfixes"
mkdir -p "$OUTDIR"

TS=$(date -u +%Y%m%d%H%M%S)
OUTFILE="$OUTDIR/bug1-qa-${TS}.txt"

echo "[Bug1 QA] Starting validation at $(date -u -Iseconds)" | tee "$OUTFILE"
echo "[Bug1 QA] Command: ./genie run $AGENT \"$PROMPT\"" | tee -a "$OUTFILE"

start_ts=$(date +%s)
set +e
timeout 12s ./genie run "$AGENT" "$PROMPT" >"$OUTDIR/bug1-qa-run-${TS}.stdout" 2>"$OUTDIR/bug1-qa-run-${TS}.stderr"
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

# 2) Check sessions.json updated and contains agent entry
SESS_FILE=".genie/state/agents/sessions.json"
if [ -f "$SESS_FILE" ]; then
  echo "[INFO] sessions.json present" | tee -a "$OUTFILE"
  # Try to extract agent block with jq if available; otherwise grep
  if command -v jq >/dev/null 2>&1; then
    agent_present=$(jq -r --arg a "$AGENT" '.agents[$a] | if . == null then "no" else "yes" end' "$SESS_FILE")
  else
    agent_present=$(grep -q '"agent"\s*:\s*"'"$AGENT"'"' "$SESS_FILE" && echo yes || echo no)
  fi
  if [ "$agent_present" = "yes" ]; then
    echo "[PASS] sessions.json contains agent entry: $AGENT" | tee -a "$OUTFILE"
  else
    echo "[FAIL] sessions.json missing agent entry: $AGENT" | tee -a "$OUTFILE"
  fi
else
  echo "[FAIL] sessions.json not found at $SESS_FILE" | tee -a "$OUTFILE"
fi

# 3) Check log file existence for that agent entry
LOG_FILE=""
if command -v jq >/dev/null 2>&1 && [ -f "$SESS_FILE" ]; then
  LOG_FILE=$(jq -r --arg a "$AGENT" '.agents[$a].logFile // ""' "$SESS_FILE")
fi

if [ -n "$LOG_FILE" ] && [ -f "$LOG_FILE" ]; then
  echo "[PASS] Log file exists: $LOG_FILE" | tee -a "$OUTFILE"
else
  echo "[WARN] Log file missing or unknown (LOG_FILE='$LOG_FILE')" | tee -a "$OUTFILE"
fi

# 4) Best-effort: detect banner text in stdout/stderr
stdout_file="$OUTDIR/bug1-qa-run-${TS}.stdout"
stderr_file="$OUTDIR/bug1-qa-run-${TS}.stderr"

if rg -n "session pending|Resume: genie resume|View: genie view|Stop: genie stop" "$stdout_file" "$stderr_file" >/dev/null 2>&1; then
  echo "[PASS] Found background banner or actions in output" | tee -a "$OUTFILE"
else
  echo "[WARN] No banner detected (may depend on TTY rendering)" | tee -a "$OUTFILE"
fi

echo "[Bug1 QA] Evidence files:" | tee -a "$OUTFILE"
echo "  - $OUTFILE" | tee -a "$OUTFILE"
echo "  - $stdout_file" | tee -a "$OUTFILE"
echo "  - $stderr_file" | tee -a "$OUTFILE"

echo "[Bug1 QA] Done." | tee -a "$OUTFILE"

