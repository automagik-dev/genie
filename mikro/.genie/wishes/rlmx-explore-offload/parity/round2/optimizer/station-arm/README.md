# Station arm — the $0 local option, n = 2

Measurement only. The recipe under test was **not** edited: it is the snapshot
of **gen-1**, byte for byte, supplied with `--recipe` — the same triple every
khal matrix arm ran.

| | |
|---|---|
| Recipe | `optimizer/gens/gen-1/recipe/` — `SYSTEM.md` `02184f35` / `agent.yaml` `20f8e018` |
| Suite | `round2/train-tasks/`, fitness set `3,4,5,6,7,8` (34 facts); `1.md` / `2.md` refused as held out, never read |
| Provider | `station/<model>` — local Lemonade gateway at `http://localhost:13305/api/v1`, **keyless**, `cost: {input: 0, output: 0}` by construction (`src/station-provider.ts`) |
| Protocol | **n = 2 independent replicates**, sequential, `--concurrency 1`, separate scratch HOMEs — identical to gen-4's replicate protocol |
| Env | `RLMX_REPL_TIMEOUT_MS=600000` `RLMX_MCP_RUN_TIMEOUT_MS=900000` `PARITY_CALL_TIMEOUT_MS=600000` `PARITY_MAX_TOTAL_TIMEOUT_MS=2400000` |
| Ground truth | preflight re-resolved every fact anchor of tasks 3–8: `groundTruthDrift: []`, no `--allow-drift` needed |
| rlmx | branch `wish/rlmx-microagent-plugin`, at `8c1b2e3` + this wish's working tree |
| Wish | `rlmx-microagent-plugin`, Group 4 (B2 amended) |

```bash
# keyless — no KHAL_API_KEY is exported here and none is needed
cd ~/prod/rlmx && npm run build
R=.genie/wishes/rlmx-explore-offload/parity/round2
for rep in 1 2; do
  node $R/run-train-round.mjs --gen 1 \
    --model    station/qwen3.5-2b-FLM \
    --recipe   $R/optimizer/gens/gen-1/recipe \
    --gen-dir  $R/optimizer/station-arm/rep-$rep \
    --label    station-arm-rep$rep --concurrency 1
done
node $R/optimizer/union-report.mjs --label "station arm" \
  --out $R/optimizer/station-arm $R/optimizer/station-arm/rep-1 $R/optimizer/station-arm/rep-2
```

`--gen 1` names *which generation's recipe ran* — it is not a new generation
and deliberately takes no number in the `gens/` series, which is what
`--gen-dir` is for. The same distinction `matrix/README.md` had to make after
the fact for `khal_glm-5.2`.

## Two deliberate differences from the khal matrix arms

1. **`--concurrency 1`, not 2.** One local gateway serving one model cannot
   host two tasks' worth of streams — a single task is already a parent plus
   up to four concurrent children (`src/llm.ts`). The frozen shot used
   concurrency 1 for the same reason. **Wall clocks here are therefore not
   comparable to the matrix's**, which were measured with four arms contending
   on one khal key.
2. **n = 2, not n = 1.** Which is why this arm is marked
   **not-rank-comparable** everywhere it appears.

## What n = 2 buys, and what it does not

| establishes | does **not** establish |
|---|---|
| **Feasibility** — whether the recursive recipe completes at all on a local model inside this harness's walls | **A rank against the khal arms.** They are n = 1 on a suite whose measured run-to-run spread is ±3 facts of 34; a 2-replicate pool against a 1-round observation is not a comparison |
| **Cost** — $0.00, by construction, not by measurement | **That this station model is better or worse than any khal model** on coverage. Nothing here tests that |
| **A first noise estimate** — the spread *between* the replicates on one fixed (recipe, model, suite) triple | **A level.** Two observations bound a spread loosely and estimate a mean badly |

## The model, and why it is this small

**`station/qwen3.5-2b-FLM`** — a static baseline in `src/station-provider.ts`
("the NPU gate model"), running on the XDNA 2 NPU via FastFlowLM.

It was not the first choice. It was the **only station model that would serve
on this host on 2026-07-27**. Five larger candidates were tried first and every
one failed to load — `Brain-35B` wedged the gateway's model loader for ~31
minutes, `Qwen3.6-35B-A3B-MTP-GGUF` got its 22 GB of weights into GTT and then
returned an empty body after 600 s, and `qwen3.6-moe-35b-a3b-FLM`,
`Qwen3.5-4B-MTP-GGUF` and `qwen3.5-9b-FLM` never produced a token. The ordered
record, with timestamps and the GTT readings that distinguish the failures, is
in [`evidence-group-4.md`](../../../../../rlmx-microagent-plugin/evidence-group-4.md)
§3.

**A 2 B model is below the capability floor this recipe was written for**, and
that is not a retrospective excuse — `scripts/smoke-explore.mjs` states it in
its own source comment: *"a 4 B model runs the protocol fine and fails the
task, which would make this gate about model capacity instead of the recipe."*

So read this arm as **feasibility, cost and replicate spread**. Its coverage
number is a **floor** for the station provider, not an estimate of it. It is
not rank-comparable to the n = 1 khal arms, and it is not comparable to larger
*station* models either — because none of them ran.

**Re-run it against a bigger local model** by changing one flag; the wish
pre-registered this exact contingency ("n=2 re-runnable any time; bench is
additive, not blocking").

## Model selection

Recorded in full in
[`.genie/wishes/rlmx-microagent-plugin/evidence-group-4.md`](../../../../../rlmx-microagent-plugin/evidence-group-4.md)
§3, including the measured throughput table from
`~/workspace/minipc-llm-benchmarks/RESULTS.md` (this same host, this same
gateway) and the ordered record of every candidate tried.

## Result

Ran `2026-07-27T17:59:52Z` → `19:12:33Z`. Both replicates exited **0**, no
task failed, no task timed out.

```
UNION facts=0/34 coverage=0 perReplicate=[0, 0]/34 spread=0 unionLift=+0
      runsOk=[6, 6]/6 c2fail=1 c3fail=1 vacuousCriteria=6 fabrications=1 citeFail=1
      cites=[0/1, 0/0] spawns=[0, 0] cost=[$0, $0] wall=[2082, 2277]s
```

| | rep-1 | rep-2 |
|---|---|---|
| window (UTC) | 17:59:52 → 18:34:34 | 18:34:35 → 19:12:33 |
| `runsOk` | 6/6 | 6/6 |
| `exitCode` | 0 | 0 |
| facts | 0/34 | 0/34 |
| citations | 0 resolved of 1 | 0 of 0 |
| c2 / c3 failures | 1 / 1 | 0 / 0 |
| recursive spawns | 0 | 0 |
| cost | $0.00 | $0.00 |
| wall | 2,082 s | 2,277 s |

Per-task wall clock, the two replicates side by side (same recipe, same model,
same question):

| task | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|
| rep-1 | **893.9 s** | 170.8 s | 207.6 s | 414.0 s | 259.8 s | 135.4 s |
| rep-2 | 187.3 s | **900.6 s** | 405.2 s | 292.7 s | 304.2 s | 186.8 s |

### What the arm establishes

- **The plumbing works.** 12 of 12 runs completed and scored, both rounds exit
  0, nothing lost. Two of the four khal arms could not finish their six runs.
  The keyless `station/` provider, the scratch-HOME install, the child-model
  pin and the scorer all work end to end at $0.
- **Cost is $0.00** for 4,359 s of wall clock.
- **The replicate spread is in the clock, not the score.** Coverage spread is
  0 — both replicates found nothing. But task 3 swings **893.9 s → 187.3 s**
  and task 4 swings **170.8 s → 900.6 s** on the identical triple. On this
  model, *timing* is not reproducible even when the answer is.

### What it does not establish

Everything in the *what n = 2 buys* table above, plus: **nothing about larger
station models**, because none of them ran (see *The model, and why it is this
small*). And **nothing about recursion** — see below.

### Two findings about the recipe, not the model

- **The fan-out never fired.** `spawns=[0, 0]` on every run in both replicates.
  The recursive half of `explore-r` is entirely unexercised by this arm.
- **The first fabrication in the round-2 record.** rep-1 task 8 emitted exactly
  one citation, `app/models/order.rb:88`, failing **both** criterion 2 and
  criterion 3 (`missing-file`). That path is a **worked example inside this
  recipe's own `SYSTEM.md`** — `gens/gen-1/recipe/SYSTEM.md` lines 500, 510 and
  514. The model recited its instructions. All four khal arms were
  0-fabrication on this suite, so the difference is the model; but the
  *mechanism* is prompt leakage, which is what got gen-4 rejected.

### The one thing not to misread

The other eleven runs show `c2=PASS` / `c3=PASS`. **They emitted zero
citations**, so the scorer had nothing to fail. `union-report.mjs` marks all
six task-level cases `VACUOUS` by design and `union.txt` carries the marks.
Those PASSes are not citation discipline.

Qualitatively, the model does not use the REPL at all — it declines and prints
the survey code as text:

> "I apologize. I do not have access to any codebase or files. The query asks
> me to analyze a repository that is inaccessible, so all citations would be
> \"NOT FOUND\"." — rep-1 task 4
