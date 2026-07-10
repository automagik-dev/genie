#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

grep -Eqi 'agent[ -]sync|agentSync' src/genie-commands/doctor.ts || { echo "FAIL: doctor lacks agent-sync freshness section"; exit 1; }
grep -Eqi 'agent[ -]sync|agentSync|genie-sync' src/genie-commands/uninstall.ts || { echo "FAIL: uninstall lacks managed-asset removal"; exit 1; }
grep -Eqi 'agent[ -]sync' plugins/genie/README.md || { echo "FAIL: plugin README lacks the distribution section"; exit 1; }
grep -Eqi 'agent[ -]sync' CLAUDE.md || { echo "FAIL: CLAUDE.md lacks the agent-sync row/gotchas"; exit 1; }
grep -q 'genie update' .genie/wishes/council-workflow/WISH.md || { echo "FAIL: council-workflow ritual not amended"; exit 1; }

bun run check

echo "G3 PASS"
