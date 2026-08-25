#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

grep -q 'runAgentSyncSafe' src/genie-commands/update.ts || { echo "FAIL: update.ts lacks runAgentSyncSafe"; exit 1; }
grep -q 'GENIE_UPDATE_SYNC_ONLY' src/genie-commands/update.ts || { echo "FAIL: update.ts does not honor GENIE_UPDATE_SYNC_ONLY"; exit 1; }
grep -Eq 'shortCircuit|already at the latest' src/genie-commands/update.ts || { echo "FAIL: cannot locate short-circuit path"; exit 1; }
grep -q 'normalizeAuxLayout' src/genie-commands/install.ts || { echo "FAIL: install.ts lacks normalizeAuxLayout"; exit 1; }
grep -Eq 'runAgentSync|agent-sync' src/genie-commands/install.ts || { echo "FAIL: install.ts does not run agent sync"; exit 1; }

test ! -f scripts/smart-install.js || { echo "FAIL: scripts/smart-install.js still exists"; exit 1; }
! grep -q 'smart-install' scripts/build.js || { echo "FAIL: build.js still copies smart-install"; exit 1; }

grep -q 'resolveStampInputs' plugins/genie/scripts/council-stamp.cjs || { echo "FAIL: council-stamp.cjs lacks resolveStampInputs"; exit 1; }
grep -q 'resolveStampInputs' plugins/genie/scripts/smart-install.js || { echo "FAIL: smart-install.js does not use resolveStampInputs"; exit 1; }
grep -q 'genie update' plugins/genie/scripts/smart-install.js || { echo "FAIL: smart-install.js does not delegate to genie update"; exit 1; }
grep -q 'GENIE_UPDATE_SYNC_ONLY' plugins/genie/scripts/smart-install.js || { echo "FAIL: smart-install.js delegation lacks the sync-only env"; exit 1; }

grep -q 'GENIE_HOME' skills/review/SKILL.md || { echo "FAIL: review skill lacks the lens-root anchor"; exit 1; }
grep -q 'GENIE_HOME' skills/brainstorm/SKILL.md || { echo "FAIL: brainstorm skill lacks the lens-root anchor"; exit 1; }

bash .genie/wishes/council-workflow/validate/g4-consumers.sh
bash .genie/wishes/council-workflow/validate/g2-engine.sh
bun test src/lib/council-workflow-stamp.test.ts src/lib/agent-sync.test.ts

echo "G2 PASS"
