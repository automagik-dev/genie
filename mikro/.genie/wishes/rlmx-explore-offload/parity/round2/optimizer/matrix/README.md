# Model matrix — one recipe, four models, n = 1 each

Written 2026-07-27 by the round-2 campaign verifier, after the arm that produced
the headline number failed to reproduce it. This is the summary the matrix should
have shipped with; the per-arm records under each directory are unchanged apart
from appended `corrections` blocks.

**What the matrix is.** The selected recipe — gen-1's frozen snapshot,
`SYSTEM.md` `02184f35` / `agent.yaml` `20f8e018`, supplied with `--recipe` and
never edited — run once per model over the six-task fitness set of
`round2/train-tasks/` (34 required facts; `1.md`/`2.md` held out, refused by the
harness, never read). All four arms executed **concurrently** on the same khal
key against the same three live checkouts, `09:46Z`–`10:24Z`, at rlmx `6ec4822`.

**What the matrix is not.** A ranking of models by accuracy. Every arm is a
single round, and a single round of this suite is worth ±3 facts (below).

## The four arms

| arm | facts | anchors cited | tasksPassed | runsOk | c2/c3 fail | cites | spawns | $/round | wall |
|---|---|---|---|---|---|---|---|---|---|
| `deepseek-v4-flash` | **32/34 published → 29–31/34 corrected** | 30/34 | 4/6 | 6/6 | 0 / 0 | 109/109 | 15 | **$0.15** | 714 s |
| `qwen3.7-max` | 28/34 | 25/34 | 2/6 | 6/6 | 0 / 0 | 64/64 | 17 | $2.82 | 1230 s |
| `deepseek-v4-pro` | 25/34 | 22/34 | 2/6 | **5/6** | 0 / 0 | 65/65 | 19 | $1.30¹ | 1162 s |
| `glm-5.2` | 20/34 | 20/34 | 1/6 | **5/6** | 0 / 0 | 101/101 | 34 | $1.95¹ | 2148 s |

¹ undercounted. `pro`'s task 5 and `glm`'s task 6 both died without a cost
footer, so a parent plus four children are missing from each sum. The true gap to
flash is larger than the table shows, in both cases.

Sources: each arm's `summary.txt` / `summary.json`; `facts` and `anchors cited`
recomputed from `runs/task-*.score.json`. `glm-5.2`'s `round.json` records
`gen=1` — that is a `--gen` label written to a `--gen-dir`, **not** the
optimizer's gen-1; `gens/gen-1/` was not touched (it still reads
`model=khal/deepseek-v4-flash`, started `08:22:45Z`).

## The flash arm's 32/34 does not reproduce

Three live re-runs of **task 4** on the identical triple (recipe `02184f35` +
`20f8e018`, model `khal/deepseek-v4-flash`, task `round2-train/4.md`) scored
**3/6, 5/6, 4/6** against the published **6/6**.

| task-4 observation | 3/6 | 4/6 | 5/6 | 6/6 |
|---|---|---|---|---|
| arm total with the other five held at 26 | **29/34** | **30/34** | **31/34** | 32/34 *(published)* |

**Publish `29–31/34`.** The 32/34 round record stands as the record of one
execution; what is withdrawn is reading it as the arm's level. Only task 4 was
replicated, so the band is a lower bound on the spread, not an interval estimate.
gen-1's own earlier flash round scored task 4 at 4/6 and 29/34 overall, which is
the same story from the other end.

**The replicate run records are not committed.** They were run live by the
campaign verifier; the three scored totals above are the whole of the evidence in
this tree. Detail: `khal_deepseek-v4-flash/README.md`.

## What the matrix decides, and what it does not

**Robust — quote this:**

| | |
|---|---|
| **Cost ranking** | flash is cheapest by **8.7x** (pro), **13x** (glm), **18.8x** (qwen) **per round**; **per fact**, taking flash at the *pessimistic* end of its band ($0.0052) and every rival at its published best, **10x** (pro), **19x** (glm), **19.5x** (qwen). A ±3-fact band moves cost-per-fact ~10%; it cannot reorder an order-of-magnitude spread. Both undercounted arms are undercounted *against* flash. |
| **Discipline** | criteria 2 and 3 are clean on all four arms: 0 fabrications, every citation resolving (109/109, 64/64, 65/65, 101/101). No model traded honesty for coverage. |
| **Reliability** | flash and qwen completed 6/6 runs; **pro lost task 5** to the 600 s REPL wall and **glm lost task 6**, with glm's task 8 returning a **1-character answer after 14 spawns and 1150 s**. Two of four arms cannot finish the suite under contention. This is a 2-fact-band-immune finding: those are zeroed tasks, not close calls. |
| **`glm-5.2` is last** | 20/34 with two zeroed tasks and $1.95. No plausible band closes 12 facts. |

**Not decided — do not quote as a ranking:**

| | |
|---|---|
| **flash vs `qwen3.7-max` on facts** | published margin +4 (32 vs 28). Against flash's corrected band the margin is **+1 to +3**, inside the ±3 run-to-run spread measured on flash itself — and qwen is n=1 with no band measured at all. The ordering is unresolved. |
| **flash vs `deepseek-v4-pro` on facts** | pro's 25/34 includes a zeroed task lost to an environment wall, not to the model. Its `rerun-task5-repl-wall/` scored 5/5 in 363 s at concurrency 1 — which would read 30/34, and is **not** protocol-identical, so it is a diagnosis and not a substitute measurement. |
| **"flash is the matrix winner"** | true on **cost**, undetermined on **facts**. Where that phrase was used unqualified — `holdout/README.md` — it is corrected in place. |

The defensible one-sentence summary: **`khal/deepseek-v4-flash` is the arm to run
because it is 9x–19x cheaper and finishes the suite, not because it was measured
to be the most accurate.**

## Why n = 1 is the binding constraint

The suite's own run-to-run spread on a fixed (recipe, model, suite) triple is
**±3 facts of 34** — gen-1's round scored 29/34 and the flash matrix arm scored
32/34 with nothing changed but the clock, and the task-4 replicates span 3/6 to
6/6 by themselves. That spread is **larger than the entire range of the four
optimizer generations** (`[28, 29, 28, 29]`) and larger than every cross-arm
fact margin in this matrix except glm's.

Anything smaller than ~3 facts, measured once, is noise. That applies to the
matrix, to the generation totals in `EVOLUTION.md`, and to the holdout gap.

## The fan-out guard is not a prompt property

`EVOLUTION.md`'s gen-3 entry pre-registered *"spawns must return to ≥ 3 on every
run"*, and both `khal_deepseek-v4-flash/arm.json` and
`khal_qwen3.7-max/arm.json` cite gen-3's `spawns=2` on tasks 3 and 4 as a reason
gen-3 does not displace gen-1. **Three of the four arms break the same guard
while running gen-1's exact snapshot:**

| arm (all on gen-1 `02184f35`) | t3 | t4 | t5 | t6 | t7 | t8 |
|---|---|---|---|---|---|---|
| `deepseek-v4-flash` | 3 | 3 | 3 | **0** | 3 | 3 |
| `deepseek-v4-pro` | **2** | 4 | 4 | 3 | 3 | 3 |
| `qwen3.7-max` | **2** | 3 | 3 | 3 | 3 | 3 |
| `glm-5.2` | 4 | 4 | 4 | 4 | 4 | 14 |

gen-1 clears the guard in its own round and in none of these. `spawns < 3` is a
property of a round — model, load, question — not of a prompt, so it is withdrawn
as a selection reason. **The selection of gen-1 is unchanged**, on the ground
that a tie does not displace the incumbent. Detail: `EVOLUTION.md` → *gen-3,
closed*.

## `optimizer/current/` was reset during this window

`khal_qwen3.7-max/README.md` and `khal_deepseek-v4-pro/matrix-arm.json` both say
`optimizer/current/` holds gen-3 (`4eafbb3d`). It holds **gen-1** (`02184f35`,
byte-identical to `gens/gen-1/recipe/`), with an `mtime` of
**`2026-07-27T09:47:43Z`** — inside this matrix window:

```
09:46:15Z  flash arm starts
09:47:05Z  qwen arm starts
09:47:42Z  pro arm starts
09:47:43Z  ← optimizer/current/{SYSTEM.md,agent.yaml} rewritten to gen-1
09:48:35Z  glm arm starts
```

**Unattributable from the artifacts.** No record under `round2/` documents the
write, and every arm ran `--recipe gens/gen-1/recipe`, which
`run-train-round.mjs` copies into a per-run scratch HOME and never writes back —
so no arm's *round* did it. The consequence is bounded and real: the optimizer's
mutation pointer silently lost gen-3, and a gen-4 edited on top of `current/`
would mutate gen-1 while claiming gen-3 as its parent. `gens/gen-3/recipe/` is
intact and authoritative. Detail: `optimizer/README.md` → *State of `current/`*.

## Known gaps in this matrix

1. **n = 1 per arm**, with a measured ±3-fact band. Nothing here separates models
   that are within ~3 facts of each other.
2. **Only task 4 was replicated**, and only on flash. The other five tasks and
   the other three arms have no replicate at all.
3. **The replicate records are not committed** — verifier-reported scores only.
4. **`glm-5.2` has no arm document.** It is the only arm with no `arm.json` /
   `matrix-arm.json`, so its run conditions are recoverable only from
   `round.json`. It is also the arm with the strangest failure (task 8: 14
   spawns, 1 iteration, 1150 s, a 1-character answer) and that failure is
   undiagnosed.
5. **All four arms ran concurrently on one key**, well beyond the 4-concurrent-
   children figure `recursion-recon.md` §6.1 measured. Wall clocks are upper
   bounds under contention; the two lost runs are plausibly contention effects,
   which is itself a finding about running the matrix this way.
6. **This suite cannot produce a parity number.** It is training data with no
   native arm — `train-tasks/README.md`, *What this suite can and cannot
   measure*. The gate is the frozen six, and nothing here touches it.
