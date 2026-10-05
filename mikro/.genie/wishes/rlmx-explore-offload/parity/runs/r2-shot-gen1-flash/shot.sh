#!/usr/bin/env bash
# shot.sh — the round-2 frozen-suite shot, exactly as pre-registered.
#
# A serial specialization of parity/run-round.sh. It is a separate file rather
# than a flag on run-round.sh because run-round.sh hardcodes
# `run-task.mjs <n> <model> <round>` with no recipe argument, and the frozen
# gate's own runner must not be edited to run this shot — the round-1 command
# line has to keep meaning what it meant.
#
# What it keeps from run-round.sh: `timeout 2400` per task, one log per task,
# per-pid exit aggregation (a bare `wait` would report a round of timeouts as
# clean), and RLMX_MCP_RUN_TIMEOUT_MS=900000.
#
# What it changes, and why each is pre-registered rather than chosen here:
#   · concurrency 1 — the shot rules fix it. Implemented by running each task to
#     completion before the next starts, so the six also run in task order 1..6.
#   · --recipe gens/gen-1/recipe --agent explore-r — the selected round-2 recipe
#     (SYSTEM.md 02184f35, agent.yaml 20f8e018), installed verbatim. The tool
#     name follows the agent directory (src/mcp/agents.ts), so the two are one
#     choice.
#   · --pin-child-model — INSTALL REQUIREMENT 2 of the recipe's own agent.yaml.
#     Belt-and-braces since 6ec4822 pins a child by its own argv.
#   · RLMX_REPL_TIMEOUT_MS=600000 — INSTALL REQUIREMENT 1. Without it the parent
#     REPL block is killed at 30s mid-fan-out and the run returns no answer.
#   · PARITY_CALL_TIMEOUT_MS=600000 — the MCP client's go-silent tolerance. A
#     fan-out emits no progress for the whole blocking wave, so the frozen
#     gate's 300s default would kill a recursive run for being quiet. Same four
#     env corrections round2/run-train-round.mjs sets on every generation.
#
# KHAL_API_KEY is inherited from the environment and is never written here.
set -u

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
parity="$(cd "$here/../.." && pwd)"
round="r2-shot-gen1-flash"
model="khal/deepseek-v4-flash"
recipe="$parity/round2/optimizer/gens/gen-1/recipe"

export RLMX_REPL_TIMEOUT_MS=600000
export RLMX_MCP_RUN_TIMEOUT_MS=900000
export PARITY_CALL_TIMEOUT_MS=600000
export PARITY_MAX_TOTAL_TIMEOUT_MS=2400000

logs="$here/logs"
mkdir -p "$logs"

failed=()
for n in 1 2 3 4 5 6; do
  echo "== task $n starting $(date -u +%Y-%m-%dT%H:%M:%SZ) =="
  timeout 2400 node "$parity/run-task.mjs" "$n" "$model" "$round" \
    --recipe "$recipe" --agent explore-r --pin-child-model \
    > "$logs/task-$n.log" 2>&1
  rc=$?
  echo "== task $n exit=$rc $(date -u +%Y-%m-%dT%H:%M:%SZ) =="
  tail -3 "$logs/task-$n.log"
  [ $rc -eq 0 ] || failed+=("$n")
done

echo "== shot $round ($model) complete =="
if [ ${#failed[@]} -gt 0 ]; then
  echo "FAILED tasks: ${failed[*]}" >&2
  exit 1
fi
