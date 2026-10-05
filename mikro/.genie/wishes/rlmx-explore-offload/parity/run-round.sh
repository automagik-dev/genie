#!/usr/bin/env bash
# run-round.sh <model> <roundLabel> [tasks…]
#
# One parity round: every mined task through `rlmx_explore` on one model.
#
# Concurrency is capped at 2 deliberately. Six concurrent explore agents against
# one khal key produced first-call timeouts (`0 in / 0 out` after ~300s) that had
# nothing to do with the model's answer — a gateway-congestion artefact would
# have been scored as a task failure. Two at a time has not reproduced it.
set -u

# `rlmLoop`'s wall-clock default is 300s (src/rlm.ts:84) and the MCP server only
# overrides it from this env var (src/mcp/server.ts:551-554). Left at the
# default it cuts a run mid-search and hands it to the forced-final path, which
# is a property of the harness, not of the model — and the native arm ran under
# no such cap. Capping one arm and not the other would score the cap.
export RLMX_MCP_RUN_TIMEOUT_MS="${RLMX_MCP_RUN_TIMEOUT_MS:-900000}"

model="$1"
round="$2"
shift 2
tasks=("$@")
if [ ${#tasks[@]} -eq 0 ]; then tasks=(1 2 3 4 5 6); fi

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
logs="${TMPDIR:-/tmp}/parity-$round"
mkdir -p "$logs"

pids=()
for n in "${tasks[@]}"; do
  timeout 2400 node "$here/run-task.mjs" "$n" "$model" "$round" > "$logs/task-$n.log" 2>&1 &
  pids+=($!)
  while [ "$(jobs -rp | wc -l)" -ge "${PARITY_CONCURRENCY:-3}" ]; do sleep 5; done
done
# Bare `wait` exits 0 whatever the children did, so a round of timeouts, expired
# credentials or failed tasks read as a clean round. Wait on each collected pid
# instead and aggregate: a round is only successful if every task was.
failed=()
for i in "${!pids[@]}"; do
  if ! wait "${pids[$i]}"; then failed+=("${tasks[$i]}"); fi
done

echo "== round $round ($model) =="
for n in "${tasks[@]}"; do
  tail -2 "$logs/task-$n.log" | head -1
done

if [ ${#failed[@]} -gt 0 ]; then
  echo "round $round FAILED: task(s) ${failed[*]} (logs in $logs)" >&2
  exit 1
fi
