# Round-2 training suite — 8 tasks, disjoint from the frozen eval suite

**This suite is a training input. It is never a gate input.** The gate is
`.genie/wishes/rlmx-explore-offload/tasks/{1..6}.md`, which is frozen, and
nothing here may be scored against it or folded into it.

| | |
|---|---|
| Tasks | 8 (`1.md` … `8.md`) |
| Required facts | 48, every one re-resolved with its recorded text |
| Roots | 4 — `~/prod/rlmx`, `~/prod/xdna-top`, `~/prod/genie-desktop`, `~/prod/fde-station` |
| Provenance | **all 8 authored**; 0 mined |
| Optimizer fitness set | **6** — `3.md`…`8.md`. `1.md` and `2.md` are **held out** (see *Known limits* 1) |
| Records | `train-mining-run.json` (the mining run that produced nothing), `authored-run.json` (the 8) |
| Ground truth | `node parity/verify-native.mjs --dir parity/round2/train-tasks` → 8/8 tasks, 48/48 anchors |

## What this suite can and cannot measure

Stated first, because it is the thing most easily overstated. **No task here has
a native arm.** All 8 are authored, so none carries a real premium-model session
answer. That removes three things the round-1 gate reported, and they are not
recoverable by running this suite harder:

| | Frozen eval suite | This suite |
|---|---|---|
| Criterion 1 (fact coverage), rlmx arm | yes | **yes** — this is the whole signal |
| Criteria 2 and 3 (citations resolve, no fabrication), rlmx arm | yes | **yes** |
| Native arm scored by the same rubric | yes | **no** — `score-task.mjs --native` has no trace to read |
| D6/P3 conservative asymmetry (native 100% on c1 by construction) | yes | **no** — there is no native score to be asymmetric against |
| Premium-token reduction (native tokens ÷ rlmx host tokens) | yes | **no** — no native token accounting exists |

So a round-2 claim of the form *"the optimizer improved token reduction"* or
*"the optimizer closed the gap to native"* **cannot be made from this suite at
all.** What it can support is: *"prompt A states more of the required facts than
prompt B, on tasks neither prompt's author had in view, with citations that
resolve."* That is a real and sufficient optimizer signal — it is just a
strictly smaller claim than the gate's, and the difference must not be blurred
in a summary.

The gate remains the only place a parity number comes from.

## Why every task is authored, and none is mined

Mining is the right way to build an eval suite and it is how the frozen six were
cut. It has one failure mode and this host hit it: **the corpus runs out.**

Measured 2026-07-27, over the whole of `~/.claude/projects` (751 transcript
files, none older than 8 days, so a 720h window is the entire corpus), under the
miner's **default** disjointness mode, `--disjoint-by session+subject`:

```
# mine-explore-tasks: disjointness on (--disjoint-by session+subject) — 4 excluded session(s), subjects from 6 task file(s)
#  — excluded session 55c38d33-784e-49eb-8e39-7042e9fc806a (166 segment(s) dropped)
#  — excluded session a9cb6b2e-8b66-459a-b27f-e58377dcc7ea (55 segment(s) dropped)
#  — excluded session 9e70f460-c422-4fe5-b509-6f59e027508f (5 segment(s) dropped)
#  — excluded session 63144f8d-854f-49fa-9740-9d612f1067e8 (3 segment(s) dropped)
# mine-explore-tasks: scanned 751 transcript(s) over 720h → 0 explore-class task(s)
```

**Zero selectable tasks, at every window rung from 24h to 720h.** The single
explore-class candidate this corpus contains belongs to session
`55c38d33-784e-49eb-8e39-7042e9fc806a` — which is the sitting **two frozen eval
tasks came from** (`tasks/3.md` and `tasks/4.md`, same root `~/prod/brain`, same
branch `brainstorm/brain-lxc`, the three questions asked within 35 seconds of
each other). It is the candidate the frozen mining run itself dropped for the
per-session cap.

So the remaining eight are authored, by `scripts/author-explore-tasks.mjs`,
under a fact bar **stricter than the miner's**: the term that links a claim to
its line must be *on that line* — no ±3 slack, no re-anchoring to where the term
lives today, no falling back to another line the claim cites — it must appear in
the claim as written, it must occur on at most 8 lines (or 5% of the file), and
the reference answer must itself pass criteria 2 and 3 before the task is
written at all. Nothing in that script can write a fact it could not verify.

### The earlier version of this suite claimed disjointness it did not have

Recorded because the correction is the point, not the outcome.

A first cut of this suite shipped **9** tasks, one of them mined, by running the
miner with `--disjoint-by subject` instead of the default. That swaps the
session gate for an anchor-file subject test, and it was argued for on the
grounds that a session gate makes disjointness true-by-emptiness while a subject
test can be recomputed from both suites' checklists.

The argument is reasonable and the result was not disjoint. The one task it
produced was `55c38d33…` — the sitting above. Its own header said so. Round 2's
acceptance criterion is *disjoint from the frozen 6 **by session***, and
`--disjoint-by subject` does not satisfy that criterion, it **amends** it. The
run record made the amendment visible (`excludedSessions: []`,
`sharedSessionsNotExcluded` listing all four eval sittings) and was honest about
the trade — but an honest change of the bar is still a change of the bar, and
nobody had authorised it.

The suite was therefore re-mined under the default, which yields nothing, and
the mined task was dropped. `train-mining-run.json` now records
`"mode": "session+subject"`, all four eval sittings under `excludedSessions`,
and `written: 0`.

## What "disjoint" means here, and how it was checked

Two independent gates, both recomputable from the records:

**1. By session.** The miner excludes all four eval sittings outright
(`disjointFrom.excludedSessions` in `train-mining-run.json`). No mined task
survives, so no task in this suite comes from a session an eval task came from.
The authored eight carry synthetic session ids (`authored-<slug>`), which are
not session ids at all and cannot collide.

**2. By subject.** `scripts/author-explore-tasks.mjs` refuses a task when ≥34%
of the files its facts anchor on are also anchor files of an eval task in the
same root. All eight authored tasks are in roots no eval task uses
(`~/prod/rlmx`, `~/prod/xdna-top`, `~/prod/genie-desktop`, `~/prod/fde-station`
vs the eval suite's `~/prod/brain` and `~/workspace/repos/genie`), so their
overlap is structurally n/a — a weak negative on its own. A deliberately-clashing
control was therefore run through the tool (anchored on files eval task `4.md`
uses, in the same root) and refused:

```
$ node scripts/author-explore-tasks.mjs --spec <control> \
    --exclude-tasks .genie/wishes/rlmx-explore-offload/tasks --dry-run
# author-explore-tasks: 1 problem(s), nothing written
#   ✗ clash-control: subject clash: 100% of its anchor files are also anchor files
#     of eval task 4.md in the same root (src/lib/init.ts, src/lib/lazy-init.ts)
```

The control lives outside the repo on purpose — it is anchored on eval subject
matter, so it is run and reported, never committed.

## How to reproduce

Both records carry their own `argv`. Order matters: **the miner deletes every
`<n>.md` in its output directory** before writing, so it must run first.

```bash
cd ~/prod/rlmx

# 1. the mining run that produces nothing (exits 1: 0 tasks against the 8-task
#    floor). It is run, and its record committed, because "the corpus is empty
#    once the eval sittings are excluded" is a measurement, not an assumption.
node scripts/mine-explore-tasks.mjs \
  --hours 24 --min-tasks 8 --host-read-idioms --disjoint-by session+subject \
  --exclude-tasks .genie/wishes/rlmx-explore-offload/tasks \
  --out .genie/wishes/rlmx-explore-offload/parity/round2/train-tasks \
  --run-json train-mining-run.json

# 2. the authored tasks, numbered from 1
node scripts/author-explore-tasks.mjs \
  --spec .genie/wishes/rlmx-explore-offload/parity/round2/authored-spec.json \
  --exclude-tasks .genie/wishes/rlmx-explore-offload/tasks \
  --out .genie/wishes/rlmx-explore-offload/parity/round2/train-tasks \
  --run-json authored-run.json

# 3. ground truth — the same bar the eval suite clears
node .genie/wishes/rlmx-explore-offload/parity/verify-native.mjs \
  --dir .genie/wishes/rlmx-explore-offload/parity/round2/train-tasks
```

Re-run step 3 before trusting the suite: these are four live checkouts and they
move. The authored tasks record the revision they were verified at
(`tasks[].rootGit` in `authored-run.json`).

## How to run it

`parity/run-task.mjs` and `parity/score-task.mjs` both take `--tasks-dir`, added
as a deliberate round-2 change. Without it they read `<wish>/tasks/` — the
frozen suite — unconditionally.

```bash
export KHAL_API_KEY=…                       # env only, never in a file
export RLMX_MCP_RUN_TIMEOUT_MS=900000       # or runs get cut at 300s

TRAIN=.genie/wishes/rlmx-explore-offload/parity/round2/train-tasks
node .genie/wishes/rlmx-explore-offload/parity/run-task.mjs \
  3 khal/deepseek-v4-flash <round-label> --tasks-dir "$TRAIN"
node .genie/wishes/rlmx-explore-offload/parity/score-task.mjs \
  .genie/wishes/rlmx-explore-offload/parity/runs/<round-label>/task-3.json 3 \
  --tasks-dir "$TRAIN"
```

Every run records the `tasksDir` it came from, and `score-task.mjs` **refuses**
to score a run against a different suite's task file rather than silently
producing a number for a comparison nobody made:

```
suite mismatch: …/runs/<round>/task-1.json
  the run was produced from …/round2/train-tasks
  but this scorer was pointed at …/rlmx-explore-offload/tasks
  pass --tasks-dir … — scoring a run against another suite's task file is a wrong number, not a comparison.
```

Proven end to end on 2026-07-27: `1.md` driven through
`run-task.mjs --tasks-dir`, 24 iterations, 121.1s, $0.02, scored `c2 PASS /
c3 PASS`, 19 citations — record under
`parity/runs/round2-runner-check/`. That run exists to show the suite is
executable and is **not** a result: `1.md` is held out of the fitness set, and
the recipe was round 1's `explore`, not `explore-r`.

## Known limits — read before using these to tune anything

1. **`1.md` and `2.md` are held out of the fitness set — do not select on
   them.** Both are authored about `~/prod/rlmx`: the same working tree the
   round-2 prompt was written in, by the same author, in the same sitting.
   `1.md` is the worse of the two — its F1–F7 anchor on
   `src/llm.ts:667`, `src/rlm.ts:436`, `src/rlm.ts:438`, `src/llm.ts:563`,
   `src/mcp/server.ts:487`, `src/cli.ts:35`, `src/config.ts:122`, which is the
   *identical line set* `recursion-recon.md` §2/§3/§4 is built from, and F6's
   verified text (`* Priority: CLI flags > settings.json > rlmx.yaml >
   hardcoded defaults.`) exists **only because this same change corrected
   `src/settings.ts`**. Tuning a prompt against ground truth authored by the
   investigation that produced the prompt is a self-consistency loop, not a
   training signal. `2.md` (`src/khal-provider.ts`) is a looser version of the
   same problem — different files, same tree, same sitting — and is held out
   too, because a fitness set should not have to argue about degree.

   The exclusion is machine-readable, not a README asking a human to remember:
   `fitnessSet.included` / `fitnessSet.heldOut` in `authored-run.json`, and an
   `| Optimizer fitness set | **HELD OUT** … |` row in each task file's header.
   **The fitness set is 6 tasks, 34 facts, in 3 roots the round-2 work never
   touched.** Scoring the held-out two is reporting; selecting on them is not.

2. **No task has a native arm** — see *What this suite can and cannot measure*
   above. `score-task.mjs --native` has nothing to read on any of the eight, so
   the only arm this suite scores is rlmx.

3. **Three of the four roots have no `.rlmx/`, and a run will create one.**
   `~/prod/xdna-top`, `~/prod/genie-desktop` and `~/prod/fde-station` are the
   user's live checkouts and none carries `.rlmx/`; `runQuery` auto-scaffolds
   when the cwd has no config (`src/cli.ts:313-321`), so the first run against
   each **writes into a repository this wish does not own**. The frozen gate hit
   the same thing (`recursion-recon.md` §6 — `~/workspace/repos/genie`'s
   `.rlmx/` is untracked and auto-scaffolded). Decide deliberately before the
   first sweep; the runner-check run above was deliberately pointed at
   `~/prod/rlmx`, which already has one, so nothing was written anywhere else.

4. **`run-task.mjs` still drives `examples/agents/explore/`, not `explore-r`.**
   The recipe is hardcoded. `--tasks-dir` makes the suite runnable; it does not
   make it run the round-2 recipe. That is a separate change and has not been
   made.

5. **Diversity is 4 roots for 8 tasks — 2 per root.** The miner's per-root cap
   exists so a *gate* cannot end up measuring one subsystem. This is a training
   suite, so the cap was not applied to the authored set; within the 6-task
   fitness set that is 2 tasks in each of 3 roots, and a prompt that happens to
   suit one of those three subsystems will move the aggregate more than it
   should. Read per-task, not only in aggregate.

6. **The authored questions are one author's idea of an explore-class question.**
   A mined question is evidence that somebody needed the answer; an authored one
   is not. The facts are machine-verified, so the *ground truth* is not at
   issue — the *question distribution* is, and it is narrower than the frozen
   suite's.
