#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

grep -q '"lint:council-workflow"' package.json || { echo "FAIL: lint:council-workflow script missing from package.json"; exit 1; }

# Behavioral wiring proof: check must actually RUN the council lint, not merely coexist with it.
out="$(bun run check 2>&1)" || { echo "$out"; echo "FAIL: bun run check failed"; exit 1; }
echo "$out" | grep -q 'council-workflow' || { echo "FAIL: lint:council-workflow did not run as part of bun run check"; exit 1; }

test -s .genie/wishes/council-workflow/qa/deliberation-run.md || { echo "FAIL: missing live QA evidence (deliberation)"; exit 1; }
test -s .genie/wishes/council-workflow/qa/audit-run.md || { echo "FAIL: missing live QA evidence (audit)"; exit 1; }

echo "G5 PASS"
