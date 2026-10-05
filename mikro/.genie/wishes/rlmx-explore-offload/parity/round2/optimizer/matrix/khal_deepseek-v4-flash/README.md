# Model-matrix arm — `khal/deepseek-v4-flash`

Measurement only. The recipe under test was **not** edited for this arm: it is
the snapshot of **gen-1**, byte for byte, supplied with `--recipe`.

| | |
|---|---|
| Recipe | `optimizer/gens/gen-1/recipe/` — `SYSTEM.md` `02184f35` / `agent.yaml` `20f8e018` |
| Model | `khal/deepseek-v4-flash`, `--pin-child-model` |
| Suite | `round2/train-tasks/`, fitness set `3,4,5,6,7,8`; `1.md` / `2.md` refused as held out, never read |
| Harness | `round2/run-train-round.mjs --gen 33820 … --concurrency 2 --task-timeout-s 2400` |
| Env | `RLMX_REPL_TIMEOUT_MS=600000` `RLMX_MCP_RUN_TIMEOUT_MS=900000` `PARITY_CALL_TIMEOUT_MS=600000` `PARITY_MAX_TOTAL_TIMEOUT_MS=2400000` |
| rlmx | `6ec4822`, branch `wish/rlmx-explore-offload` |
| Ran | `2026-07-27T09:46:15Z` → `09:58:10Z`, concurrently with the pro, qwen and glm arms on the same khal key |
| Ground truth | preflight re-resolved all 34 fact anchors; `groundTruthDrift: []` |

This README was written on 2026-07-27 by the round-2 campaign verifier, after
the arm's headline number failed to reproduce. `arm.json` is the arm's original
record and is left byte-exact apart from an appended `corrections` block.

## The number as published, and the number to quote

```
ROUND gen=33820 facts=32/34 fitness=0.9412 weak=0 tasksPassed=4/6 runsOk=6/6 \
      c2fail=0 c3fail=0 cites=109/109 spawns=15 cost=$0.15 wall=714.4s
```

**That round really did score 32/34.** `runs/`, `logs/`, `round.json` and
`summary.*` are the honest record of one execution and nothing in them is
retracted. What is withdrawn is the *reading* of 32/34 as this arm's level.

**Quote the band: `29–31/34` (coverage 0.85–0.91).**

### The replicate evidence

Three live re-runs of **task 4** on the identical triple — recipe
`gens/gen-1/recipe` (`02184f35` / `20f8e018`), model `khal/deepseek-v4-flash`,
task `round2-train/4.md` — scored:

| observation | task 4 | arm total with this task-4 value substituted into **this arm's** other five (26) |
|---|---|---|
| **this arm, published** (09:46Z) | **6/6** | **32/34** — the published headline |
| replicate 1 | **3/6** | 29/34 |
| replicate 2 | **5/6** | 31/34 |
| replicate 3 | **4/6** | 30/34 |
| gen-1's own round (08:22Z), for context | 4/6 | n/a — that round's other five differ (t3 was 5/7, not 6/7); it scored **29/34** in total |

Task 4 alone spans **3/6 → 6/6** on the same recipe, the same model and the same
question, with nothing changed but the clock. The published 6/6 is the maximum of
five observations and was not reproduced in three attempts.

**How the band is built:** the five non-task-4 tasks are held at their published
values (6 + 5 + 5 + 5 + 5 = 26 facts) and each replicate is substituted for task
4 → 26+3 = 29, 26+4 = 30, 26+5 = 31. Those five tasks were **not** replicated, so
`29–31` is a lower bound on the true spread, not an interval estimate.

**The replicate run records are not committed.** They were executed live by the
campaign verifier and their run/score JSON is not in this tree; the three scored
totals above are the whole of the evidence. Treat the band as verifier-reported
and not re-derivable from the artifacts here — the same standard this README
applies to everything else.

### What the band changes, and what it does not

| | status |
|---|---|
| `facts=32/34` as this round's record | **stands** |
| 32/34 as the arm's level | **withdrawn** → 29–31/34 |
| `cost=$0.15`, cheapest arm by 8.7x–18.8x | **stands** (see *Cost*) |
| `cites=109/109`, `c2fail=0`, `c3fail=0`, `runsOk=6/6` | **stands** — properties of these runs |
| "flash beats qwen3.7-max by 4 facts" | **withdrawn** → +1 to +3, inside noise |
| "single-round differences of 1–2 facts are inside noise" (`arm.json`) | **strengthened** → up to ~3 facts |

The last row is the point. This arm's own stated conclusion was already that a
+3-fact swing on an identical triple is larger than the entire spread of the four
recorded generations (`[28, 29, 28, 29]`). The replicates confirm it from the
other side, and the conclusion that follows is unchanged and now better
supported: **fitness differences of this size cannot select a prompt.**

## Cost — the one ranking that survives n=1

| arm | facts | $/round | $/fact | vs flash, $/round | vs flash, $/fact¹ |
|---|---|---|---|---|---|
| **`deepseek-v4-flash`** | 32/34 published, **29–31 band** | **$0.15** | $0.0047 published, $0.0048–$0.0052 across the band | — | — |
| `deepseek-v4-pro` | 25/34 (`runsOk=5/6`) | $1.30² | $0.052 | **8.7x** | **10x** |
| `glm-5.2` | 20/34 (`runsOk=5/6`) | $1.95² | $0.098 | **13x** | **19x** |
| `qwen3.7-max` | 28/34 | $2.82 | $0.1007 | **18.8x** | **19.5x** |

¹ computed against flash at the **pessimistic** end of its band ($0.0052/fact,
i.e. 29/34) and every rival at its published best — the reading least favourable
to flash.

² undercounted — the pro arm's task 5 and the glm arm's task 6 each died with no
cost footer, so a parent plus four children are missing from each sum. The pro
case is documented (`khal_deepseek-v4-pro/matrix-arm.json` → `costCaveat`); the
glm case is visible as `cost=$?` on its task-6 row and is documented nowhere,
because that arm has no arm document. Both undercounts run *against* flash; the
true gaps are larger.

A ±3-fact band moves cost-per-fact by about 10%. It cannot reorder an 8.7x–18.8x
spread. **Cost ranking: robust at n=1. Fact ranking: not resolved at n=1.**

## The spawns caveat, and why it is published here

**Task 6 of this arm fanned out zero times** (`spawns=0`, 14 iterations, 74.9 s)
and still scored 5/5 with 13/13 citations resolving. `arm.json` records it as
*"the mandatory fan-out is not reliably mandatory at this model."*

That matters beyond this arm, because `arm.json`'s own
`recipeUnderTest.whyThisGeneration` cites *"spawns fell to 2 on tasks 3 and 4
against the stated '>= 3 on every run'"* as a reason gen-3 does not displace
gen-1 — a guard `EVOLUTION.md` pre-registered in its gen-3 entry. **The same
condition holds on the selected recipe, including in this very arm:**

| round on the gen-1 snapshot | t3 | t4 | t5 | t6 | t7 | t8 |
|---|---|---|---|---|---|---|
| gen-1's own round | 3 | 3 | 4 | 4 | 3 | 3 |
| **this arm** | 3 | 3 | 3 | **0** | 3 | 3 |
| pro arm | **2** | 4 | 4 | 3 | 3 | 3 |
| qwen arm | **2** | 3 | 3 | 3 | 3 | 3 |
| glm arm | 4 | 4 | 4 | 4 | 4 | 14 |

Three of the four matrix arms break the guard while running gen-1's exact
snapshot; gen-0, the shipped recipe, ran 2 / 2 / 0 on tasks 3 / 4 / 6. So
`spawns < 3` is a property of a **round** — model, load, question — not of a
prompt, and it is withdrawn as a reason to prefer gen-1 over gen-3. The
selection is unchanged: a tie does not displace the incumbent.
See `EVOLUTION.md` → *Guard 3 is real, and it does not separate gen-3 from the
recipe that was selected*.

## Reproduce

```bash
export KHAL_API_KEY=…                       # shell only, never in a file
cd ~/prod/rlmx
node .genie/wishes/rlmx-explore-offload/parity/round2/run-train-round.mjs \
  --gen <unused-number> --model khal/deepseek-v4-flash \
  --recipe .genie/wishes/rlmx-explore-offload/parity/round2/optimizer/gens/gen-1/recipe \
  --label matrix-khal-deepseek-v4-flash --concurrency 2 --pin-child-model \
  --task-timeout-s 2400
```

`--gen 33820` is `sha256('matrix-arm:khal/deepseek-v4-flash')` truncated into
10000..99999 — a scratch directory name chosen so concurrent arms could not
collide. **It is not a generation.** The tree was moved from
`optimizer/gens/gen-33820` to here after the round exited 0, and
`summarize-train-round.mjs` was re-run in place; `round.json` is byte-exact as
written and still names the pre-move path.

**Expect a different number.** Three replicates of one task produced three
different scores. Run the whole set more than once before quoting anything from
it.

## Wall clock

`wall=714.4s` was measured with three sibling arms (`pro`, `qwen`, `glm`)
executing against the same khal key and the same three task roots. It is an upper
bound under contention and is not comparable to the flash *generations*, which
ran alone. Facts, citation resolution and cost are unaffected by contention.
