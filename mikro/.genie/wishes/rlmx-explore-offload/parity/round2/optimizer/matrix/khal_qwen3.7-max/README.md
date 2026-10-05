# Model-matrix arm — `khal/qwen3.7-max`

Measurement only. The recipe under test was **not** edited for this arm: it is
the snapshot of **gen-1**, byte for byte.

| | |
|---|---|
| Recipe | `optimizer/gens/gen-1/recipe/` — `SYSTEM.md` `02184f35` / `agent.yaml` `20f8e018` |
| Model | `khal/qwen3.7-max` (the recipe's own `model:` line is rewritten to it by `run-task.mjs`; `agent.yaml` in `recipe/` still reads `khal/deepseek-v4-flash`, which is what `20f8e018` digests) |
| Suite | `round2/train-tasks/`, fitness set `3,4,5,6,7,8`; `1.md` / `2.md` refused as held out |
| Harness | `round2/run-train-round.mjs`, concurrency 2, `--pin-child-model`, `--task-timeout-s 2400` |
| Env | `RLMX_REPL_TIMEOUT_MS=600000` `RLMX_MCP_RUN_TIMEOUT_MS=900000` `PARITY_CALL_TIMEOUT_MS=600000` `PARITY_MAX_TOTAL_TIMEOUT_MS=2400000` — identical to every flash generation |
| rlmx | `6ec4822`, branch `wish/rlmx-explore-offload` |
| Ground truth | preflight re-resolved all 34 fact anchors of the six tasks; `groundTruthDrift: []` |

## Why gen-1 is the recipe this arm ran

Fitness totals across the four generations recorded under `optimizer/gens/`:

| gen | facts | fitness | tasksPassed | weak | c2/c3 fail | cites |
|---|---|---|---|---|---|---|
| 0 | 28/34 | 0.8235 | 1/6 | 1 | 0 / 0 | 101/101 |
| **1** | **29/34** | **0.8529** | **3/6** | 0 | 0 / 0 | 97/97 |
| 2 | 28/34 | 0.8235 | 2/6 | 0 | 0 / 0 | 105/105 |
| 3 | 29/34 | 0.8529 | 2/6 | 0 | 0 / 0 | 79/79 |

gen-1 and gen-3 tie on the primary signal. gen-3 does **not** dominate gen-1 —
it passes one fewer task mechanically (2/6 vs 3/6) and cites one fewer required
anchor (26 vs 27) — so under the same Pareto discipline `EVOLUTION.md` used to
revert gen-2, the best point is **gen-1**. `optimizer/current/` was left
untouched (it holds gen-3's `SYSTEM.md`, `4eafbb3d`); the recipe was supplied to
the harness with `--recipe` instead, so this arm could not disturb an optimizer
generation in flight.

> **Correction — 2026-07-27, round-2 campaign verifier.** The parenthesis is
> **false**, and is left above so the corrected claim reads against it.
> `optimizer/current/` **holds gen-1, not gen-3**: `sha256 current/SYSTEM.md` is
> `02184f35…` and `cmp` against `gens/gen-1/recipe/` is byte-identical on both
> files. Its `mtime` is `2026-07-27 09:47:43Z` — **38 s after this arm started**
> (09:47:05Z) and 88 s after the flash arm did, so `current/` was reset to gen-1
> *during* the matrix window, by something that recorded nothing. To be exact:
> the sentence was **true when this round began** — gen-3's round put `4eafbb3d`
> there at 09:20:48Z — and false 38 s later, which is why it was written in good
> faith and still has to be corrected. **This arm did
> not do it** — the claim that survives is the one that matters here: the arm ran
> `--recipe gens/gen-1/recipe`, which copies into a per-run scratch HOME and never
> writes `current/`, so the arm could not and did not disturb an optimizer
> generation. What is wrong is only the description of what `current/` contained.
> The mutation pointer silently lost gen-3; `gens/gen-3/recipe/` is intact and is
> the authoritative copy. Full detail: `optimizer/README.md` (*State of
> `current/`*) and `EVOLUTION.md` (*gen-3, closed*).

The gen-1-over-gen-3 reasoning above also leans on a spawns argument that does
not survive scrutiny — see `arm.json` → `corrections.gen3SpawnsArgument`, and
`EVOLUTION.md` → *Guard 3 is real, and it does not separate gen-3 from the
recipe that was selected*. The **selection is unchanged** (a tie does not
displace the incumbent); one of its stated reasons is withdrawn.

## What this arm shows against flash — corrected 2026-07-27

`arm.json` concludes *"qwen3.7-max is 4 facts BEHIND deepseek-v4-flash on the
same recipe at 18.8x the round cost."* The cost half holds. **The 4-fact half
does not**, because the flash control's 32/34 is the top of its own range and
does not reproduce: three live task-4 replicates on the same (recipe, model,
task) scored **3/6, 5/6, 4/6** against the published **6/6**, putting the flash
arm's honest level at a band of **29–31/34** (`matrix/README.md`,
*The flash arm's 32/34 does not reproduce*).

| | facts | vs this arm | cost | cites | runsOk |
|---|---|---|---|---|---|
| this arm (`qwen3.7-max`) | 28/34, n=1 | — | **$2.82** | 64/64 | 6/6 |
| flash control, **as published** | 32/34, n=1 | +4 | **$0.15** | 109/109 | 6/6 |
| flash control, **corrected band** | **29–31/34** | **+1 to +3** | $0.15 | 109/109 | 6/6 |

Flash's own measured run-to-run spread on an identical (recipe, model, suite)
triple is **±3 facts** (29 in gen-1's round, 32 here, replicates below both).
A margin of +1 to +3 sits inside that band, and this arm is itself n=1 with no
band measured at all. **So flash is not established as the more accurate model
by this matrix — the fact ordering is not resolved at this sample size.**

What *is* robust is the price:

| | $/round | $/fact (facts as published) | $/fact (flash at its band) |
|---|---|---|---|
| flash | $0.15 | $0.0047 | $0.0048 – $0.0052 |
| this arm | $2.82 | $0.1007 | $0.1007 |
| **ratio** | **18.8x** | **21.5x** | **19x – 21x** |

The cost gap is an order of magnitude and the fact band moves it by ~10%.
**Cost ranking: robust. Winner on facts: not established.** The defensible
sentence about this arm is *"qwen3.7-max costs 18.8x more per round and 19–21x
more per fact than flash on the same recipe, and is not measurably better at
finding facts"* — not *"it is 4 facts behind"*.

Criteria 2 and 3 are clean on both arms (0 failures, all citations resolving),
so nothing here is a discipline finding either way.

## How these records got here

`run-train-round.mjs` hard-codes its output tree at `optimizer/gens/gen-<N>/`
and refuses to reuse a generation number that already has runs. The round was
therefore executed as `--gen 901` — an out-of-band id, not a generation — and
the directory was moved here afterwards, then `summarize-train-round.mjs` was
re-run in place so `summary.json`'s recorded paths point at this directory.
`round.json` is verbatim from the round and still reads `"gen": 901` and
`"genDir": …/gens/gen-901`. Nothing else was rewritten, and no file under
`gens/` was touched.

## Reproduce

```bash
export KHAL_API_KEY=…                       # shell only, never in a file
cd ~/prod/rlmx
node .genie/wishes/rlmx-explore-offload/parity/round2/run-train-round.mjs \
  --gen <unused-number> --model khal/qwen3.7-max \
  --recipe .genie/wishes/rlmx-explore-offload/parity/round2/optimizer/gens/gen-1/recipe \
  --label matrix-gen1-khal-qwen3-7-max --concurrency 2
```

## Caveat on wall clock and contention

Two sibling matrix arms (`matrix-khal-deepseek-v4-flash`,
`matrix-khal-deepseek-v4-pro`, recorded under `gens/gen-1302` and
`gens/gen-33820` while they ran) were executing against the same khal key and
the same three task roots during this round. Every `wall=` number here is
therefore an upper bound under contention and is **not** comparable to the flash
generations' wall clock, which ran alone. Fact counts, citation resolution and
cost are unaffected by contention.

One consequence is visible in the record: `/home/namastex/prod/xdna-top` is
logged as `rlmxExistedBefore: true` (a sibling had already scaffolded it) and
`createdByThisRound: false`, so this round removed nothing. All three roots are
`.rlmx`-free again.
