# Round-2 optimizer — the training harness

One generation is one recipe, run over the six **fitness** tasks of
`round2/train-tasks/`, scored by the frozen scorer, summarized machine-readably.
Everything a round needs is in three files:

| | |
|---|---|
| The recipe under test | `optimizer/current/{agent.yaml,SYSTEM.md}` |
| The round driver | `round2/run-train-round.mjs` |
| The summary emitter | `round2/summarize-train-round.mjs` |

Two more sit beside them, added at gen-4. Neither is in the round's path —
both only read what a round already wrote, and neither touches a scorer:

| | |
|---|---|
| Pool N replicates of one round | `optimizer/union-report.mjs` |
| Execute a recipe's own `repl` blocks | `optimizer/verify-recipe-blocks.py` |

## One round is not a measurement (added at gen-4)

The suite's run-to-run spread on a **fixed** (recipe, model, suite) triple is
**±3 facts of 34** — wider than the whole four-generation range `[28, 29, 28, 29]`
(`matrix/README.md`, *Why n = 1 is the binding constraint*). So from gen-4 a
generation is run **twice**, sequentially, each replicate with its own scratch
HOME, and reported per replicate **and** as a union:

```bash
for rep in 1 2; do
  node round2/run-train-round.mjs --gen 4 \
    --recipe  optimizer/gens/gen-4/recipe \
    --gen-dir optimizer/gens/gen-4/rep-$rep \
    --label   gen4-rep$rep-khal-deepseek-v4-flash --concurrency 2
done
node optimizer/union-report.mjs --label "gen-4 fitness" \
  optimizer/gens/gen-4/rep-1 optimizer/gens/gen-4/rep-2
```

The scratch HOME comes from the run label (`parity/run-task.mjs:149`), so two
labels are two disjoint `/tmp/rlmx-parity-<label>-t<n>` trees — that is the whole
of the independence, and it is why the labels must differ. Replicates go in
`rep-<k>/` under the generation, **never** in a new `gen-<N>`: they are one
generation measured twice, and the totals history must not read as if the prompt
had mutated between them.

`union-report.mjs` reads each replicate's `summary.json` and its
`facts[].verdict` verbatim — it re-runs no scorer and re-decides no rule. Its
two combining rules run in opposite directions on purpose: **coverage unions**
(a fact counts if **any** replicate hit it), while **criteria 2 and 3 intersect**
(they pass only if **every** replicate passed, because one fabricated citation
makes an answer unusable). `WEAK` never counts, in a replicate or in the union.

It also **labels a criterion that decided nothing** (added at the gen-4
closeout). Criteria 2 and 3 are failures found in the citations of an answer, so
a run that died on the REPL wall and returned a 67-character non-answer is
written down as `c2=PASS c3=PASS` — the absence of a measurement, which under
the intersect rule then reads as corroboration. Such a task prints
`c2=PASS! c3=PASS!` and a `VACUOUS` line naming the replicate and the reason,
and carries `criteriaVacuous` in the JSON with `totals.vacuousCriteria` beside
it. **The combining rule is unchanged** — only the support is named.

Both tools were added at gen-4 and both **outlive it**: gen-4's *recipe* is
rejected (`gens/gen-4/README.md`), its harness is not. Neither script is in a
round's path and neither touches a scorer.

`verify-recipe-blocks.py` extracts the ```` ```repl ```` blocks from a recipe's
`SYSTEM.md`, compiles all of them, executes the starter block, and measures the
declaration sweep against the live training roots. It exists because
`EVOLUTION.md` → *Corrections* item 2 records that gen-1's, gen-2's and gen-3's
"verification done before shipping" measurements **cannot be recomputed from
this tree** — the replay harness was never committed. This one is.

```bash
export KHAL_API_KEY=…                     # shell only, never in a file
cd ~/prod/rlmx

# gen 0 — the shipped explore-r recipe, on flash
node .genie/wishes/rlmx-explore-offload/parity/round2/run-train-round.mjs --gen 0

# edit optimizer/current/SYSTEM.md, then:
node .genie/wishes/rlmx-explore-offload/parity/round2/run-train-round.mjs --gen 1

# re-print any generation's summary (also written as summary.txt/summary.json)
node .genie/wishes/rlmx-explore-offload/parity/round2/summarize-train-round.mjs --gen 1
```

`--model khal/<id>` changes the model (default `khal/deepseek-v4-flash`),
`--concurrency 1..3` the width, `--tasks 3,5` a subset, `--dry-run` prints the
plan and spawns nothing.

## Generation 0 is the shipped recipe, byte for byte

`optimizer/current/` was seeded from `examples/agents/explore-r/` — SHA-256
`06c6ea94…` (`SYSTEM.md`) and `20f8e018…` (`agent.yaml`), the digests
`recursion-recon.md` §8 records for the shipped files. `examples/agents/explore-r/`
is never written by this loop; `optimizer/current/` is the only thing that moves,
and every generation snapshots what it ran into `gens/gen-<N>/recipe/`.

## State of `current/` — it holds **gen-1**, the selected recipe

| | |
|---|---|
| `sha256 current/SYSTEM.md` | **`02184f35…` — gen-1** |
| `sha256 current/agent.yaml` | `20f8e018…` — unchanged since gen-0 |
| `cmp` against `gens/gen-1/recipe/` | **byte-identical, both files** |
| Last write | `cp gens/gen-1/recipe/{SYSTEM.md,agent.yaml} current/` — **2026-07-27 13:22:44Z**, gen-4 closeout, reverting gen-4 |
| Recorded in | `EVOLUTION.md` → *gen-4, closed · REJECTED* → *The pointer, and this time it is written down* |

**`current/` is the selected recipe, not the head of the log.** The head is
**gen-4, and gen-4 is rejected** (`gens/gen-4/`): its one positive result is
confounded by four training-suite anchoring terms sitting verbatim in its own
prompt, its fitness union ties the pooled parent on the identical two residual
facts, and its holdout reproduces 2 facts below the parent's. gen-1 stands, so
`current/` holds gen-1 — deliberately, and this write is attributed.

**Before mutating:** restore the intended parent explicitly and say which it is,
e.g. `cp gens/gen-<N>/recipe/{SYSTEM.md,agent.yaml} current/`, and record the
write in `EVOLUTION.md`. Do not assume this pointer is where the last generation
left it — it has now moved twice without being part of a generation.

**Inherited debt, before gen-5 edits this file:** gen-1 carries the same four
leaked terms gen-4 was rejected for — `MAX_ATTEMPTS`, `findCmd`,
`FETCH_BODY_TIMEOUT_MS`, `RECORD_SCHEMA_VERSION`, plus the accidental `KEEP`
collision. They anchor 5 of the 34 fitness facts. Removing them is the first
task of the next generation; see `EVOLUTION.md` → *What survives, and what gen-5
must do first*.

### How this pointer has moved — the history, kept

The two paragraphs below are the round-2 campaign verifier's original correction
(2026-07-27), left as written. They describe the **first**, undocumented reset;
the table above describes the current state after the **second**, documented one.

> **`current/` is one generation behind `EVOLUTION.md`, and nothing recorded the
> write that put it there.** `sha256 current/SYSTEM.md` was `02184f35…` — gen-1
> — where gen-3, the last generation run, is `4eafbb3d…`; `cmp` against
> `gens/gen-1/recipe/` was byte-identical in both files; and
> `mtime current/{SYSTEM.md,agent.yaml}` was `2026-07-27 09:47:43Z` — 88 s after
> the flash matrix arm started (09:46:15Z), 38 s after the qwen arm (09:47:05Z).
>
> Two arm docs state the opposite — `matrix/khal_qwen3.7-max/README.md` ("it
> holds gen-3's `SYSTEM.md`, `4eafbb3d`") and
> `matrix/khal_deepseek-v4-pro/matrix-arm.json` ("it holds gen-3 (4eafbb3d)") —
> and both are corrected in place. Neither arm *wrote* it: all four matrix arms
> ran `--recipe gens/gen-1/recipe`, which copies into a per-run scratch HOME and
> never touches `current/`. The reset is real, undocumented, and lands inside
> the matrix window. **Consequence, and it is the only one:** the mutation
> pointer lost gen-3. Nothing else broke — `gens/gen-3/recipe/` is intact and is
> the authoritative copy of what gen-3 ran, and every arm and generation ran
> from a `gens/` snapshot, not from `current/`.

Every write to this pointer that is on record:

| When | Write | Attributed |
|---|---|---|
| `2026-07-27 09:47:43Z` | gen-3 → **gen-1** (`4eafbb3d` → `02184f35`) | **no** — found by the verifier, author unknown |
| `2026-07-27` (gen-4 mutation) | gen-1 → **gen-4** (`02184f35` → `640dfa69`) | yes — gen-4 checked the pointer before mutating rather than trusting it, found it already byte-identical to `gens/gen-1/recipe/`, and mutated gen-1 deliberately, gen-1 being the incumbent |
| `2026-07-27 13:22:44Z` | gen-4 → **gen-1** (`640dfa69` → `02184f35`) | yes — gen-4 closeout, on the REJECTED verdict. The command and both `cmp` checks are in `EVOLUTION.md` |

## Layout

```
optimizer/
  current/{agent.yaml,SYSTEM.md}     the recipe under test — edit this
  gens/gen-<N>/
    recipe/{agent.yaml,SYSTEM.md}    what actually ran (snapshot, not a link)
    runs/task-<n>.json               verbatim MCP run record
    runs/task-<n>.score.json         parity/score-task.mjs output
    logs/task-<n>.log                runner stdout+stderr, plus the score line
    round.json                       manifest: model, digests, env, roots, per-task
    summary.{txt,json}               the emitter's output
```

## What the harness does that a plain loop would not

- **It cannot run the frozen eval suite.** `--tasks-dir` defaults to
  `round2/train-tasks/` and refuses `<wish>/tasks/` outright.
- **It cannot run a held-out task.** The fitness set is read from
  `train-tasks/authored-run.json` (`fitnessSet.included` / `heldOut`), not from
  a list in the script. **`1.md` and `2.md` are held out** — both authored about
  `~/prod/rlmx`, the tree the round-2 prompt was written in, in the same sitting;
  task 1's facts anchor on the exact line set `recursion-recon.md` §2–§4 is built
  from. Selecting on either is a self-consistency loop.
- **It checks ground truth before spending anything.** Every fact anchor of the
  tasks in *this* round is re-resolved against its live checkout with the same
  test `parity/verify-native.mjs` uses. Drift is a refusal, not a low score
  (`--allow-drift` records it and continues).
- **It sets the two environment corrections** on every `rlmx mcp` process:
  `RLMX_REPL_TIMEOUT_MS=600000` (without it a fan-out block is killed at 30s and
  the whole run returns nothing — `recursion-recon.md` §4.1) and
  `RLMX_MCP_RUN_TIMEOUT_MS=900000`. It raises the MCP client's go-silent
  tolerance to match (`PARITY_CALL_TIMEOUT_MS`), because a fan-out is silent for
  the whole blocking wave. All three are recorded in every run record.
- **It puts the task roots back.** Three of the training roots are the user's
  live checkouts with no `.rlmx/`; `runQuery` auto-scaffolds one
  (`src/cli.ts:317-324`). The round records what it found, and removes exactly
  what it created — only when nothing unexpected appeared inside.
  `--keep-scaffold` opts out.
- **Its exit code is honest.** Non-zero if any task failed to run or to score.
  A low fitness number is data and exits 0.

## Reading the summary

```
TASK 3 ok=true facts=5/7 weak=1 anchorsCited=4/7 c2=PASS c3=PASS cites=11/12 pass=false …
  MISS F2 src/xdna_top/npu_power.py:115 — names the path but not the anchoring term `debugfs_accel_absent`
ROUND gen=0 facts=28/34 fitness=0.8235 …
```

`facts=` is a **mechanical proxy for criterion 1**, defined once in
`summarize-train-round.mjs`: HIT = the answer names the fact's anchor path *and*
contains the term the fact was anchored on. `score-task.mjs` deliberately does
not decide criterion 1 (it is a claim-level judgement) and nothing here changes
that — the proxy sits on top of its unmodified signals. It is strictly harsher
than the rubric (a correct claim in other words, or citing a neighbouring line,
scores MISS) and it is blind to whether the claim is *true*.

**So `facts=` compares two prompts on the same tasks, and is not a parity
number.** Criteria 2 and 3 in the same line *are* the rubric's, decided
mechanically and completely by `score-task.mjs`. The gate number comes from the
frozen suite only — see `train-tasks/README.md`, *What this suite can and cannot
measure*.
