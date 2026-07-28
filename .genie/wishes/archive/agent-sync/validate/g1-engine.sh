#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

test -f src/lib/genie-home.ts || { echo "FAIL: missing src/lib/genie-home.ts"; exit 1; }
test -e src/lib/agent-sync.ts || test -d src/lib/agent-sync || { echo "FAIL: missing agent-sync module"; exit 1; }
test -f src/lib/agent-sync.test.ts || { echo "FAIL: missing src/lib/agent-sync.test.ts"; exit 1; }

# (retired) This line asserted src/genie-commands/ carried NO GENIE_UPDATE_SYNC_ONLY
# wiring — a G1-phase guard. G2 landed that wiring by design (update.ts sync-only
# fast path), so the assertion is obsolete and intentionally removed. Kept as a
# note so the gate stays re-runnable and the history of the check is legible.

bun test src/lib/agent-sync.test.ts
bun run typecheck
bunx biome check src/lib/genie-home.ts src/lib/agent-sync.ts src/lib/agent-sync.test.ts 2>/dev/null || bunx biome check src/lib/

echo "G1 PASS"
