# Holdout check — the overfitting tripwire, run once

The selected recipe on the two **held-out** training tasks. Run after the recipe
and the model were chosen, never before, and **never fed back**: nothing in this
directory may inform a mutation, a revert, a Pareto comparison or a model
choice. If it did, there would no longer be a holdout.

| | |
|---|---|
| Recipe | gen-1 — `SYSTEM.md` `02184f35` / `agent.yaml` `20f8e018`, from the frozen snapshot `optimizer/gens/gen-1/recipe` |
| Model | `khal/deepseek-v4-flash` — the matrix winner *(corrected 2026-07-27: the **cost** winner, robustly — 9x–19x cheaper than every other arm and the only arm besides qwen to finish all six runs. It is **not** established as the accuracy winner; see the correction below and `matrix/README.md`.)* |
| Tasks | **1 and 2**, the two `fitnessSet.heldOut` entries of `train-tasks/authored-run.json` |
| Root | `/home/namastex/prod/rlmx` (both) — pre-existing `.rlmx/`, nothing scaffolded |
| rlmx HEAD | `6ec4822` |
| Records | `round.json`, `summary.{txt,json}`, `runs/task-{1,2}.{json,score.json}`, `logs/` |

```bash
export KHAL_API_KEY=…                       # shell only, never in a file
node .genie/wishes/rlmx-explore-offload/parity/round2/run-train-round.mjs \
  --gen 1 --holdout --allow-drift \
  --gen-dir .genie/wishes/rlmx-explore-offload/parity/round2/optimizer/holdout \
  --recipe  .genie/wishes/rlmx-explore-offload/parity/round2/optimizer/gens/gen-1/recipe \
  --label holdout-gen1-khal-deepseek-v4-flash --concurrency 2
```

## The number

```
TASK 1 ok=true facts=4/7 weak=1 anchorsCited=2/7 c2=PASS c3=PASS cites=23/23 iters=13 spawns=3 wall=521.0s cost=$0.04
TASK 2 ok=true facts=6/7 weak=0 anchorsCited=6/7 c2=PASS c3=PASS cites=21/21 iters=10 spawns=3 wall=375.5s cost=$0.03
ROUND  facts=10/14 fitness=0.7143 runsOk=2/2 c2fail=0 c3fail=0 cites=44/44 spawns=6 cost=$0.07 wall=521.2s
```

Against the same recipe on the same model on the **fitness** set:

| | facts | coverage | tasksPassed | c2/c3 | cites |
|---|---|---|---|---|---|
| gen-1 fitness round | 29/34 | 0.8529 | 3/6 | 0 / 0 | 97/97 |
| matrix flash arm (same recipe, same model, 84 min later) | 32/34 | 0.9412 | 4/6 | 0 / 0 | 109/109 |
| **pooled fitness** | **61/68** | **0.8971** | — | 0 / 0 | 206/206 |
| **this holdout** | **10/14** | **0.7143** | 0/2 | **0 / 0** | **44/44** |

> **Correction — 2026-07-27, round-2 campaign verifier.** The matrix flash row
> (and therefore the pooled row) is the **top** of that arm's range, not its
> level. Three live task-4 replicates on the identical (recipe, model, task)
> triple scored **3/6, 5/6, 4/6** against the published 6/6, putting the arm at
> **29–31/34 (0.85–0.91)**. Substituting the band into the rows above:
>
> | | facts | coverage |
> |---|---|---|
> | matrix flash arm — published | 32/34 | 0.9412 |
> | matrix flash arm — **corrected band** | **29–31/34** | **0.853–0.912** |
> | pooled fitness — published | 61/68 | 0.8971 |
> | pooled fitness — **corrected band** | **58–60/68** | **0.853–0.882** |
>
> Replicate records are not committed (verifier-reported scores only); detail in
> `matrix/README.md` and `matrix/khal_deepseek-v4-flash/README.md`. **The
> holdout's own 10/14 is untouched** — it was measured here and is not in
> dispute. The gap narrows and the conclusion below does not change.

**Coverage is 0.714 on the holdout against 0.853–0.941 on the fitness set — a
drop of 0.14 to 0.23.** That is a real gap and it is reported as one. What it is
*not* is a collapse: every quality guard the optimizer was watched against held
on tasks the recipe was never selected on.

> **Correction, continued.** Against the corrected fitness band the drop is
> **0.14 to 0.20** (0.714 vs 0.853–0.912), not 0.14 to 0.23. The floor of the
> comparison — gen-1's own 0.853 round — is unchanged, so the *smallest* honest
> statement of the gap is the same in both readings; only the largest shrinks.

- `runsOk` **2/2** — no lost runs, no REPL-wall failures.
- **criterion 3 (no fabrication): PASS on both**, 0 failures. Four generations
  of prompt edits, none of which ever regressed this, and it holds off-fitness.
- **criterion 2 (citations resolve): PASS on both, 44/44.** Not one citation in
  either answer failed to resolve.
- **The fan-out fired on both runs, 3 spawns each, at iteration 2** — the same
  shape gen-1 shows on the fitness set. The agent's identity survives off-set.

## The gap is 4 fact-instances. One of them is not the recipe's fault.

| Task | Fact | Anchor | Term | Verdict |
|---|---|---|---|---|
| 1 | F2 | `src/rlm.ts:436` | `maxIterations: opts.maxIterations` | **WEAK** — 1/2 long tokens |
| 1 | F5 | `src/mcp/server.ts:487` | `provider: parsed.provider` | **MISS** — ground truth invalidated, see below |
| 1 | F6 | `src/cli.ts:35` | `CLI flags > settings.json > rlmx.yaml` | **MISS** — 0/3 long tokens |
| 2 | F7 | `src/khal-provider.ts:103` | `NON_CHAT_MODES` | **MISS** — path named, term never written |

### Task 1's ground truth drifted under the product fix, and one fact is unscoreable

`verify-native.mjs --dir round2/train-tasks` at `6ec4822` reports **task 1:
4/7 fact anchors still resolve with their recorded text**; task 2 is 7/7 and
every fitness task is clean. The round was run with `--allow-drift` and the
drift is recorded verbatim in `round.json`. Three anchors moved, and they are
not the same kind of move:

| Fact | Recorded anchor | Today | Effect on the score |
|---|---|---|---|
| F1 | `src/llm.ts:667` `MAX_CONCURRENT` | line only — term is at `src/llm.ts:710` | **none.** `facts=` matches on *path + term*, not on the line. Scored **HIT**. |
| F4 | `src/llm.ts:563` `detached` | line only — term is at `src/llm.ts:616` | **none.** Scored **HIT**. |
| F5 | `src/mcp/server.ts:487` `provider: parsed.provider` | **the literal is gone from that file.** `6ec4822` routed `applyAgent` through `applyModelRef`, and the only `provider: parsed.provider` in the tree is now `src/config.ts:290` | **fatal to this fact.** A truthful answer about today's `src/mcp/server.ts` cannot contain that literal. |

So **F5 is unreachable by construction**, and the honest denominator is 13, not
14: **10/13 = 0.769 drift-adjusted.** Both numbers are stated; neither is
presented alone.

That still leaves **three genuine misses** on intact ground truth, and they are
the finding:

- **T2 F7 `NON_CHAT_MODES`** is the cleanest signal in the whole record. Task 2
  is undrifted, the answer scored 6/7 with 21/21 citations resolving, it named
  `src/khal-provider.ts` — and it never wrote the one module constant. This is
  the *identical* failure shape the fitness set has been showing since gen-0
  (`RECORD_SCHEMA_VERSION`, `RECORD_KIND`, `RESERVED_ENV_KEYS`, `SUITE`): a
  module-level declaration, printed, in a file the answer already had open, that
  never becomes a claim. **The residual failure mode generalises — the four
  generations of fixes aimed at it have not.**
- **T1 F6** (`src/cli.ts:35`, the precedence comment) scored 0/3 long tokens:
  the answer never wrote `settings.json` or `rlmx.yaml` anywhere. It is also the
  fact whose verified text exists *only* because this same change corrected
  `src/settings.ts` — which is precisely why task 1 was held out.
- **T1 F2** is WEAK, not MISS: the claim was made, the exact spelling was not.

## Why this is a gap and not proof of overfitting

Three reasons, and none of them make the gap go away:

1. **n = 2.** Fourteen fact-instances against the fitness set's 34, and the
   fitness set's own run-to-run spread on this recipe+model is **29 → 32 of 34**
   (0.853 → 0.941) with nothing changed but the clock. A 2-task holdout has no
   power to separate a 0.14 gap from that variance.

   > **Correction — 2026-07-27.** This argument got *stronger*, not weaker. The
   > three task-4 replicates (3/6, 5/6, 4/6 against a published 6/6) show a
   > single task swinging **three fact-instances** on a fixed triple, so the
   > run-to-run band is at least ±3 of 34 and is now measured on five
   > observations rather than inferred from two rounds. A 14-instance holdout
   > separates nothing from that.
2. **Task 1 is the harder task and it is the drifted one.** Both holdouts sit in
   `~/prod/rlmx` — one root, not three — and task 1's seven facts are spread
   across five files in the tree that was actively rewritten under it.
3. **Every non-coverage guard held**: 0 fabrications, 44/44 citations resolving,
   2/2 runs completing, fan-out on both. If the recipe had been overfitted into
   brittleness, this is where it would show, and it did not.

**Verdict: report the gap, do not tune on it.** The recipe stands as selected;
the holdout is a caution attached to the fitness number, not a reason to change
the recipe — changing it here is what the holdout exists to prevent.

## What the harness change was

`run-train-round.mjs` grew `--holdout`. **Without the flag its behaviour is
byte-identical**: a held-out task is refused with its recorded reason, as
before, and re-running any existing generation's summary reproduces
`summary.{txt,json}` byte for byte (checked on gen-1). With the flag, three
structural guards apply — held-out tasks only (no mixing with fitness tasks),
`--gen-dir` required and refused anywhere under `optimizer/gens/`, and
`holdout: true` recorded in `round.json` with a banner in the summary.
`summarize-train-round.mjs` gained that banner and nothing else; its extra keys
are emitted only when the round is a holdout.

`parity/score-task.mjs` and `parity/verify-native.mjs` were **not touched** — no
flags, no defaults, no bytes. The frozen eval tasks were not read, run or
referenced. `examples/agents/explore-r/**` and `optimizer/current/` are
unchanged.

> **Correction — 2026-07-27, round-2 campaign verifier.** "no flags, no defaults,
> no bytes" is **false as a statement about those files**, and is left above so
> the corrected claim reads against it: `score-task.mjs` gained `--tasks-dir` and
> `verify-native.mjs` gained `--dir` in commit `4cfb587` (round-2 prep). True as
> narrowed, and true of *this round*: **this change touched no scorer byte**,
> `4cfb587` predates gen-0 and the whole optimizer loop, both flags default to
> the frozen eval suite, and no rubric, threshold or fact rule moved.
> `train-tasks/README.md` (*How to run it*) has always stated it correctly.
>
> `optimizer/current/` is likewise unchanged **by this round** — but note it was
> reset to gen-1 at `09:47:43Z` — during the matrix window, 45 minutes before
> this holdout started (`10:32:37Z`) — by something that recorded nothing. It
> does not hold gen-3, as two matrix arm docs claim. See `optimizer/README.md` →
> *State of `current/`*.
