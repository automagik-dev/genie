# Holdout check — gen-4, run twice, reporting only

The gen-4 recipe on the two **held-out** training tasks, run after the fitness
replicates were complete. **Nothing in this directory may inform a mutation, a
revert, a Pareto comparison or a model choice.** If it did, there would no
longer be a holdout. It is here to be reported and read, and that is all.

| | |
|---|---|
| Recipe | gen-4 — `SYSTEM.md` `640dfa69` / `agent.yaml` `20f8e018`, from `optimizer/gens/gen-4/recipe` |
| Model | `khal/deepseek-v4-flash` |
| Tasks | **1 and 2**, the two `fitnessSet.heldOut` entries of `train-tasks/authored-run.json` |
| Root | `/home/namastex/prod/rlmx` (both) — pre-existing `.rlmx/`, nothing scaffolded |
| Protocol | 2 replicates, sequential, `--concurrency 1`, separate scratch HOMEs, `--allow-drift` |
| rlmx HEAD | `6ec4822` |

```bash
export KHAL_API_KEY=…                       # shell only, never in a file
for rep in 1 2; do
  node round2/run-train-round.mjs --gen 4 --holdout --allow-drift \
    --recipe  optimizer/gens/gen-4/recipe \
    --gen-dir optimizer/holdout-gen4/rep-$rep \
    --label   gen4-holdout-rep$rep-khal-deepseek-v4-flash --concurrency 1
done
node optimizer/union-report.mjs --label "gen-4 holdout (reporting only)" \
  --out optimizer/holdout-gen4 optimizer/holdout-gen4/rep-1 optimizer/holdout-gen4/rep-2
```

## The number

```
TASK 1 union=2/7 per-replicate=[2, 2] spawns=[0, 4] iters=[14, 14] cites=[10, 19]
  UNIONMISS F2 src/rlm.ts:436        `maxIterations: opts.maxIterations`
  UNIONMISS F3 src/rlm.ts:438        `config.budget.maxDepth ?? 3`
  UNIONMISS F5 src/mcp/server.ts:487 `provider: parsed.provider`
  UNIONMISS F6 src/cli.ts:35         `CLI flags > settings.json > rlmx.yaml`
  UNIONMISS F7 src/config.ts:122     `DEFAULT_MODEL`
TASK 2 union=6/7 per-replicate=[6, 6] spawns=[4, 0] iters=[7, 12] cites=[20, 20]
  UNIONMISS F7 src/khal-provider.ts:103 `NON_CHAT_MODES`
UNION facts=8/14 coverage=0.5714 perReplicate=[8, 8] spread=0 unionLift=+0
      runsOk=[2, 2]/2 c2fail=0 c3fail=0 fabrications=0 citeFail=0
      cites=[30/30, 39/39] cost=[$0.04, $0.05]
```

| | facts | coverage | runsOk | c2/c3 | cites |
|---|---|---|---|---|---|
| gen-1 holdout (n=1) | 10/14 | 0.7143 | 2/2 | 0 / 0 | 44/44 |
| gen-4 rep-1 | 8/14 | 0.5714 | 2/2 | 0 / 0 | 30/30 |
| gen-4 rep-2 | 8/14 | 0.5714 | 2/2 | 0 / 0 | 39/39 |
| **gen-4 union** | **8/14** | **0.5714** | **2/2** | **0 / 0** | — |

**gen-4 is 2 facts below gen-1 on the holdout, and it is the flattest result in
the campaign: both replicates scored 8/14, spread 0, and on the same six facts.**
That is the opposite of the fitness set's behaviour and worth stating: where
gen-1's holdout gap could be argued down as n=2 noise, this one reproduces
exactly.

Task 1's ground truth is drifted — `F5 src/mcp/server.ts:487` is **unreachable
by construction** since `6ec4822` removed the literal from that file
(`optimizer/holdout/README.md`, *Task 1's ground truth drifted*). Drift-adjusted:
**8/13 = 0.615**. Both numbers are stated; neither is presented alone.

## Where the two facts went, against gen-1

gen-1's holdout scored task 1 at 4/7 and task 2 at 6/7. gen-4 scores task 1 at
**2/7** and task 2 at **6/7**. The whole regression is on task 1, and both
replicates hit the **iteration cap at 14** there.

That is the budget note in `EVOLUTION.md` → *Budget* coming due. The entry held
`max_iterations` at 14 on the ground that gen-1's parent path topped out at 10,
and flagged: *"if gen-4 reaches 14 on a task, that is the number to revisit."*
It reached 14 on both holdout task-1 runs. Task 1 spreads seven facts across
five files of the largest root in the suite, the ensemble adds a block, and the
harvest adds a mark-off step — the tail got squeezed.

**This is an observation, not a mutation input.** Nothing here may change the
recipe. It is recorded so that a *future* generation, selected on the fitness
set, can be checked against it.

## `NON_CHAT_MODES` did not convert — and the probe says it should have

`src/khal-provider.ts:103` `NON_CHAT_MODES` is the miss `optimizer/holdout/README.md`
called *"the cleanest signal in the whole record"* and the one gen-4's change 2
was built for. `optimizer/verify-recipe-blocks.py` confirms `decls()` surfaces
it, with its line number, from the file the answer already opens.

It missed in **both** replicates. In rep-2 task 2 the fan-out never fired
(`spawns=0`), so `SEEN` — built from `A + B` — never existed and the harvest
could not run at all. In rep-1 it fired and the fact still missed. Both are
covered by the first defect recorded in `gens/gen-4/README.md`: **the harvest is
coupled to the fan-out and should not be.**

## Every non-coverage guard held

- `runsOk` **2/2 in both replicates** — no lost runs, no REPL-wall failures,
  unlike the fitness rep-2.
- **criterion 3 (no fabrication): PASS on all four runs**, 0 failures. Five
  generations of prompt edits and the ensemble's union operator — the change
  most capable of breaking it — and it has never regressed.
- **criterion 2: PASS on all four, 30/30 and 39/39.** Not one citation failed to
  resolve.
- The fan-out fired on **2 of 4** runs (`spawns=[0, 4]` and `[4, 0]`). Reported,
  not weighed — see `EVOLUTION.md` → *gen-3, closed*.

## Verdict

> **gen-4 was rejected on 2026-07-27, and this directory did not decide it.**
> The rejection rests on a defect in the *fitness* measurement — four
> training-suite anchoring terms verbatim in the recipe's own prompt against a
> substring fact rule — and on the fitness union tying the pooled parent on the
> identical two residual facts. This holdout is cited in that entry as a
> recorded, reproducing regression and is explicitly marked as not load-bearing;
> the contract tension in citing it at all is stated there rather than stepped
> around. `EVOLUTION.md` → *gen-4, closed · REJECTED* → *(b)*.

**Report the gap; do not tune on it.** Coverage is 0.571 here against 0.941
union / 0.882 best-single on the fitness set — a wider gap than gen-1's, and
this time it reproduces across replicates rather than sitting inside the noise.
Taken with the fitness result — where the union did not move and the same two
facts survived — the honest reading is that **gen-4 buys the declaration
conversion and pays for it in tail budget, and it does not generalise better
than its parent.** Changing the recipe on the strength of this directory is what
the holdout exists to prevent.
