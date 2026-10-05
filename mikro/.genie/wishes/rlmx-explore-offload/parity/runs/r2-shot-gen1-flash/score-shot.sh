#!/usr/bin/env bash
# score-shot.sh — both readings of the round-1 gate scorer over this shot.
#
# Order matters and is the point of this file. `score-task.mjs` writes to
# `<run>.score.json` in BOTH readings — the suffix reading has no separate
# output path — so running default-then-suffix leaves the suffix result sitting
# in the default file. That is exactly the defect the round-1 audit found
# (`docs/parity-explore.md`, Scoring conventions: "the native pair was
# regenerated at final review after the audit found the default-variant file had
# been clobbered by its suffix run").
#
# So: suffix FIRST, moved aside, then default LAST. The default reading is the
# committed convention and is therefore the file left on disk under the default
# name.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
parity="$(cd "$here/../.." && pwd)"

for n in 1 2 3 4 5 6; do
  run="$here/task-$n.json"
  [ -f "$run" ] || { echo "t$n: (no run)"; continue; }

  SUFFIX_SHORTHAND=1 node "$parity/score-task.mjs" "$run" "$n" > /dev/null
  mv "$here/task-$n.score.json" "$here/task-$n.score.suffix.json"

  node "$parity/score-task.mjs" "$run" "$n" > /dev/null
  echo "t$n scored (default + suffix)"
done
