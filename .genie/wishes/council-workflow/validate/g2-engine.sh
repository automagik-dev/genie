#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

t="plugins/genie/workflows/council.js"
test -f "$t" || { echo "FAIL: missing $t"; exit 1; }
grep -q "name: 'council'" "$t" || { echo "FAIL: meta.name !== 'council' in $t"; exit 1; }

# Deliberately broader than the spec: ALL `new Date(` is banned (not just argless) —
# timestamps travel via args; a seeded date in the script is a smell, and failing closed is cheap.
for banned in 'Date\.now' 'Math\.random' 'new Date\(' 'require\(' '^import ' 'process\.' '[^a-zA-Z.]fs\.'; do
  if grep -Eq "$banned" "$t"; then echo "FAIL: banned API matching '$banned' in $t"; exit 1; fi
done

# Parse check against the workflow RUNTIME shape, NOT module-legal ESM. The dynamic-workflow
# runtime runs the script as an async function body (top-level await/return are the contract)
# after extracting `export const meta` statically — so a plain ESM parse would REJECT the correct
# shape. --parse-only strips meta, forbids any other export (incl. `export default`), and
# transpiles the remainder as an async body; it fails on any syntax error.
bun scripts/council-workflow-lint.ts --parse-only "$t" || { echo "FAIL: $t does not parse as a workflow body"; exit 1; }

for card in questioner simplifier operator deployer measurer tracer; do
  c="plugins/genie/references/lenses/$card.md"
  test -f "$c" || { echo "FAIL: missing lens card $c"; exit 1; }
  grep -q '^name: ' "$c" || { echo "FAIL: no name frontmatter in $c"; exit 1; }
  grep -q '^modes: ' "$c" || { echo "FAIL: no modes frontmatter in $c"; exit 1; }
  grep -q '^voice: ' "$c" || { echo "FAIL: no voice frontmatter in $c"; exit 1; }
done

bun test src/lib/council-workflow-stamp.test.ts

# NOTE: full 13-lens integrity (ROUTING -> files on disk, incl. G1's lane skills) lives in
# `bun run lint:council-workflow`, exercised from G3 onward and permanently via `bun run check` —
# NOT here, so G2 stays validatable in parallel with G1 (Wave 1).
echo "G2 PASS"
