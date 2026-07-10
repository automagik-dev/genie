#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

test ! -e skills/council || { echo "FAIL: skills/council still exists"; exit 1; }

hits=$(git grep -il 'specialist-panel' -- ':!.genie/attic' ':!CHANGELOG.md' ':!.genie/wishes/council-workflow' ':!.genie/brainstorms' || true)
if [ -n "$hits" ]; then
  echo "FAIL: stale specialist-panel references:"
  echo "$hits"
  exit 1
fi

refs=$(git grep -l 'members/routing\.md\|members/config\.md\|council/templates/report\.md' -- skills plugins 2>/dev/null || true)
if [ -n "$refs" ]; then
  echo "FAIL: stale council-internals references:"
  echo "$refs"
  exit 1
fi

# G1+G2 are both done by now — first point where full 13-lens integrity is assertable.
bun run lint:council-workflow

echo "G3 PASS"
