#!/usr/bin/env bash
# Wave 1 Consolidated Smoke — power-outage recovery rehearsal launcher.
#
# Runs the bun test at .genie/qa/wave-1-power-outage-smoke.test.ts against
# an isolated PG database (cloned from the test template). Writes per-step
# evidence to /tmp/genie-recover/wave-1-consolidated-smoke-evidence.json.
#
# Usage:
#   bash .genie/qa/wave-1-power-outage-smoke.sh
#
# Exits 0 if every assertion passed, non-zero otherwise.
# See README at .genie/qa/wave-1-power-outage-smoke.md.

set -euo pipefail

WORKTREE_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
EVIDENCE_DIR=/tmp/genie-recover
EVIDENCE_FILE="$EVIDENCE_DIR/wave-1-consolidated-smoke-evidence.json"

mkdir -p "$EVIDENCE_DIR"

cd "$WORKTREE_ROOT"

echo "[wave-1-smoke] worktree=$WORKTREE_ROOT"
echo "[wave-1-smoke] evidence-file=$EVIDENCE_FILE"
echo "[wave-1-smoke] running bun test..."

# bun test exits non-zero if any test fails. The test file writes the
# JSON evidence in afterAll, so it persists regardless of pass/fail.
# Path-prefixed (./) so bun treats this as a file path rather than a filter
# pattern; .genie/qa/ lives outside src/ and bun's default test discovery.
bun test ./.genie/qa/wave-1-power-outage-smoke.test.ts 2>&1 || rc=$?
rc=${rc:-0}

echo ""
if [ -f "$EVIDENCE_FILE" ]; then
  verdict=$(grep -o '"verdict": *"[^"]*"' "$EVIDENCE_FILE" | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
  passed=$(grep -o '"passed": *[0-9]*' "$EVIDENCE_FILE" | head -1 | awk '{print $2}')
  total=$(grep -o '"total": *[0-9]*' "$EVIDENCE_FILE" | head -1 | awk '{print $2}')
  echo "[wave-1-smoke] verdict=$verdict ($passed/$total assertions passed)"
else
  echo "[wave-1-smoke] WARNING: evidence file not written — test setup may have aborted before afterAll ran" >&2
fi

exit $rc
