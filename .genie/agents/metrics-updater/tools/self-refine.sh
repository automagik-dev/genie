#!/usr/bin/env bash
# self-refine.sh — Prepare refinement context and trigger /refine on AGENT.md
#
# This script:
# 1. Generates a performance report from runs.jsonl
# 2. Appends performance context to the bottom of AGENT.md temporarily
# 3. Calls /refine in file mode on AGENT.md (via the agent's Claude Code session)
# 4. Updates state.json with last_refined_at
#
# Usage:
#   bash self-refine.sh [--agent-dir <path>] [--dry-run]
#
# The agent should call this after run-metrics.sh completes.
# In dry-run mode, it prepares the context file but doesn't modify AGENT.md.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="${AGENT_DIR:-$(dirname "$SCRIPT_DIR")}"
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent-dir) AGENT_DIR="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

AGENT_FILE="$AGENT_DIR/AGENT.md"
STATE_FILE="$AGENT_DIR/state.json"
RUNS_FILE="$AGENT_DIR/runs.jsonl"
CONTEXT_FILE="$AGENT_DIR/refine-context.md"

log() { echo "[self-refine] $*" >&2; }

# --- Step 1: Generate performance report ---
log "Generating performance report..."
PERF_REPORT=""
if [[ -f "$RUNS_FILE" ]]; then
  PERF_REPORT=$(python3 "$SCRIPT_DIR/perf-analyzer.py" --runs-file "$RUNS_FILE" --format text 2>/dev/null || echo "Failed to generate perf report")
fi

# --- Step 2: Get latest run data ---
LATEST_RUN=""
if [[ -f "$RUNS_FILE" ]]; then
  LATEST_RUN=$(tail -1 "$RUNS_FILE")
fi

# --- Step 3: Count existing tools ---
TOOL_COUNT=$(find "$SCRIPT_DIR" -type f \( -name '*.sh' -o -name '*.py' \) | wc -l | tr -d ' ')

# --- Step 4: Build refinement context ---
log "Building refinement context..."
cat > "$CONTEXT_FILE" << CTXEOF
# Refinement Context — $(date -u +%Y-%m-%dT%H:%M:%SZ)

## Performance Data (Latest Run)
\`\`\`json
$LATEST_RUN
\`\`\`

## Performance Analysis
$PERF_REPORT

## Current Tool Inventory ($TOOL_COUNT tools)
$(ls -1 "$SCRIPT_DIR"/*.sh "$SCRIPT_DIR"/*.py 2>/dev/null | while read -r f; do
  basename "$f"
done)

## Refinement Request

Analyze the performance data above. Improve this agent prompt to be:
1. **Faster** — Identify the slowest step and add instructions to optimize it
2. **More resilient** — If errors occurred, add handling for those failure modes
3. **Tool-aware** — Reference any new tools that should be generated for slow steps
4. **Measurable** — Ensure the prompt tracks metrics that enable future refinement

Focus on the slowest step identified in the performance analysis. If API calls are slow,
instruct the agent to use the cached github-api.sh wrapper. If parsing is slow, generate
an optimized parser. If commits are slow, batch operations.

Do NOT change the core metrics (releases/day, bug-fix time, SHIP rate, parallel agents).
Do NOT remove the self-refinement protocol section.
Increment the version number in the frontmatter.
CTXEOF

log "Refinement context written to: $CONTEXT_FILE"

if [[ "$DRY_RUN" == "true" ]]; then
  log "DRY RUN — context file prepared but AGENT.md not modified"
  cat "$CONTEXT_FILE"
  exit 0
fi

# --- Step 5: Append context to AGENT.md for /refine ---
# The agent will call `/refine @AGENT.md` which reads this file.
# We append the context so the refiner has performance data.
log "Appending refinement context to AGENT.md..."

# Save original AGENT.md
cp "$AGENT_FILE" "$AGENT_FILE.pre-refine"

cat >> "$AGENT_FILE" << APPENDEOF

---

<!-- REFINE_CONTEXT_START — This section is temporary and will be replaced by /refine -->
$(cat "$CONTEXT_FILE")
<!-- REFINE_CONTEXT_END -->
APPENDEOF

log "AGENT.md prepared for /refine. The agent should now run:"
log "  /refine @$AGENT_FILE"
log ""
log "After /refine completes, update state.json with:"
log "  python3 -c \"import json; from datetime import datetime, timezone; s=json.load(open('$STATE_FILE')); s['last_refined_at']=datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'); json.dump(s, open('$STATE_FILE','w'), indent=2)\""

# --- Step 6: Update state.json ---
log "Updating last_refined_at in state.json..."
python3 -c "
import json
from datetime import datetime, timezone
with open('$STATE_FILE') as f:
    state = json.load(f)
state['last_refined_at'] = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
with open('$STATE_FILE', 'w') as f:
    json.dump(state, f, indent=2)
    f.write('\n')
"
log "state.json updated with last_refined_at"

echo "$CONTEXT_FILE"
