# gen-4 — the ensemble recipe, measured twice · **REJECTED**

The first generation of this loop reported as **replicates rather than a round**.
Rationale, changes and pre-registered guards: `EVOLUTION.md` →
*gen-1 → gen-4*. This file is the result and the layout.

> **Verdict: REJECTED, 2026-07-27** — `EVOLUTION.md` → *gen-4, closed ·
> REJECTED*. Three findings, and the first is the blocker: **(a)** four
> training-suite anchoring terms sit verbatim in this recipe's own `SYSTEM.md`
> (`MAX_ATTEMPTS` `:465`, `findCmd` `:612`, `FETCH_BODY_TIMEOUT_MS` `:616`,
> `RECORD_SCHEMA_VERSION` `:617`), the fact rule is a substring test
> (`parity/score-task.mjs:341`), and the `RECORD_SCHEMA_VERSION` conversion
> claimed below as *"that is the harvest"* therefore cannot be told apart from
> the model reading the term off its own prompt; **(b)** the holdout regresses
> **8/14 against gen-1's 10/14, identically in both replicates** — recorded,
> and explicitly not the reason (see the entry); **(c)** the fitness union ties
> the pooled parent at 32/34 on the identical two residual facts. Selected
> recipe remains **gen-1** (`02184f35` / `20f8e018`), and `optimizer/current/`
> was reset to it at 13:22:44Z. Everything below is left as measured.

| | |
|---|---|
| Status | **REJECTED** — kept as a record; a rejected generation is still a generation |
| Parent | **gen-1** — the selected recipe (`SYSTEM.md` `02184f35` / `agent.yaml` `20f8e018`). gen-2 and gen-3 deliberately not carried |
| Recipe — `SYSTEM.md` | **`640dfa69`** — **new**. This is the mutation; it is not byte-identical to any previous generation (gen-1's is `02184f35`) |
| Recipe — `agent.yaml` | `20f8e018` — **byte-identical to gen-0/1/2/3**, held unchanged a fifth generation. The budget is not what moved |
| Model | `khal/deepseek-v4-flash` |
| Suite | `round2/train-tasks/`, six fitness tasks, 34 facts. `1.md` / `2.md` refused by the harness, never read |
| Protocol | 2 independent replicates, **sequential**, `--concurrency 1`, separate scratch HOMEs |
| rlmx HEAD | `6ec4822` |

```bash
export KHAL_API_KEY=…                       # shell only, never in a file
for rep in 1 2; do
  node round2/run-train-round.mjs --gen 4 \
    --recipe  optimizer/gens/gen-4/recipe \
    --gen-dir optimizer/gens/gen-4/rep-$rep \
    --label   gen4-rep$rep-khal-deepseek-v4-flash --concurrency 1
done
node optimizer/union-report.mjs --label "gen-4 fitness" --out optimizer/gens/gen-4 \
  optimizer/gens/gen-4/rep-1 optimizer/gens/gen-4/rep-2
```

## The numbers

```
UNION facts=32/34 coverage=0.9412 perReplicate=[30, 26]/34 spread=4 unionLift=+2
      runsOk=[6, 5]/6 c2fail=0 c3fail=0 vacuousCriteria=1 fabrications=0 citeFail=0
      cites=[91/91, 54/54] spawns=[18, 24] perRun=0..6 cost=[$0.167, $0.14]

TASK 5 … c2=PASS! c3=PASS! …
  VACUOUS   c2=PASS/c3=PASS from rep-2 — run !ok — no answer to decide
            criteria 2/3 over; the marked `c2=PASS!`/`c3=PASS!` above is that
            PASS pooled, not corroborated
```

`vacuousCriteria` and the `VACUOUS` line were added to `union-report.mjs` at the
gen-4 closeout and `union.{txt,json}` regenerated with them. **No verdict
changed** — the combining rules are byte-identical and no scorer was re-run;
what changed is that a criterion decided over a run that produced nothing is now
labelled instead of silently pooled.

| | facts | coverage | tasksPassed | runsOk | c2/c3 | cites | spawns | $ | wall |
|---|---|---|---|---|---|---|---|---|---|
| rep-1 | **30/34** | 0.8824 | 3/6 | 6/6 | 0 / 0 | 91/91 | 18 | $0.167 | 1426.8 s |
| rep-2 | 26/34 | 0.7647 | 3/6 | **5/6** | 0 / 0 ‡ | 54/54 | 24 | $0.14 | 2002 s |
| **union** | **32/34** | **0.9412** | — | — | **0 / 0** ‡ | — | — | $0.31 | — |

‡ rep-2's task 5 contributes a **vacuous** `c2/c3` pass: the run is `!ok` with a
67-character answer and 0 citations, so `score-task.mjs` had nothing to fail.
Guard 5's *"citations 100 % in BOTH replicates"* is therefore one replicate's
real pass and one replicate's vacuum, on that task.

Against the parent, pooled the same way from its own two recorded rounds
(`gens/gen-1/` + `matrix/khal_deepseek-v4-flash/`, same digests, same model):

| | union | per replicate | spread | facts missed by **both** |
|---|---|---|---|---|
| gen-1 (parent) | 32/34 | [29, 32] | 3 | `npu_power.py:84`, `enroll.sh:23` |
| **gen-4** | **32/34** | [30, 26] | 4 | **`npu_power.py:84`, `enroll.sh:23`** |

**The union did not move and the residual is the same two facts.** gen-4's
single-round *floor* rose (30 and 26-with-a-lost-run against 29 and 32), and its
ceiling did not.

> The gen-1 union's `32` replicate is the flash matrix arm, whose task-4 6/6 is
> documented as not reproducing (`matrix/README.md`). Read the parent row as an
> upper reading. The *shape* — same two residual facts — is unaffected.

## Read guards 2 and 3 through guard 6

rep-2 lost task 5 to the 600 s REPL wall (650 s, 4 spawns, a 67-character
answer), which zeroes five facts. On the five tasks **both** replicates
completed:

| | needed | per replicate | spread | union |
|---|---|---|---|---|
| tasks 3, 4, 6, 7, 8 | 29 | **[25, 26]** | **1** | 27 |

Change 1's variance claim is supported where it can be read — spread **1**
against the parent's **3**. The headline spread of 4 is one harness failure, not
a coverage result.

## What each change bought

- **Change 2 (the harvest) converted the declaration residual.**
  `record.py:22` `RECORD_SCHEMA_VERSION` and `record.py:23` `RECORD_KIND` are
  **HIT in both replicates**; gen-1 missed both in its own round and gen-3
  converted one. Task 4 scored **6/6** in rep-2.

  > **Voided, 2026-07-27.** `RECORD_SCHEMA_VERSION` is at `SYSTEM.md:617` of
  > this very recipe, and `HIT` is `namesAnchorPath && answer.includes(term)`.
  > The harvest and the prompt predict the same observation and this round
  > cannot separate them. Two facts cut against a simple "it copied": gen-3's
  > prompt contains the term **nowhere** and hit the fact anyway, and gen-1's
  > contains it and missed — so the leak is neither necessary nor sufficient.
  > That does not restore the claim; it confirms the measurement has no power
  > here. And the flash matrix arm, running gen-1's own digests, hit
  > `record.py:22` **and** `:23`, so the parent's pooled record already had both
  > (upper reading — that arm's task-4 6/6 does not reproduce,
  > `EVOLUTION.md` → *Corrections* 5). `RECORD_KIND` is **not** leaked and is
  > the one uncontaminated half of this bullet.
- **Change 1 (the ensemble) did not reach a new fact.** Asking every partition
  twice produced the coverage that pooling two *rounds* of the unmodified parent
  already had. It converts variance into a single round's number; it does not
  extend the recipe's reach.

## Two defects in the shipped recipe, both checkable

1. **The harvest is coupled to the fan-out.** `SEEN` is built from `A + B`, so a
   run that skips the fan-out has no candidate list and no harvest. This recipe
   line skips the fan-out on roughly one run in six in every generation
   recorded, and it happened here on rep-1 task 7 — the run that missed `SUITE`,
   a fact the committed probe shows `decls()` surfaces. gen-1's phase-4 block
   referenced only `CLAIMS` and was robust to this. Seed `SEEN` from `CLAIMS`
   when `A`/`B` are absent.
2. **Three partitions is too wide for the 600 s wall.** rep-2 task 5 died at
   650 s with 4 children at concurrency 1, while rep-1 task 5 finished the same
   4 children in 264.7 s. Child latency alone spans that range and the ensemble
   doubles the exposure to a wall whose failure mode is total loss. Two
   partitions is the width the evidence supports.

## Spawns

`0, 2, 2, 4, 4, 4, 4, 4, 4, 4, 4, 6` across the twelve runs — median 4, one 6
(three partitions asked twice, spawned 4 + 2 as `src/llm.ts:713-714` slices
them), one 0. **Reported, not weighed**: `EVOLUTION.md` → *gen-3, closed*
withdrew `spawns` as a selection reason after three matrix arms broke the same
guard on gen-1's own snapshot, and that withdrawal stands. The `PARTS` template
in `recipe/SYSTEM.md` shows two example entries against prose saying "two or
three", and the runs cluster on two — that template is the lever, not the prose.

## The concurrency correction

The first attempt ran at gen-1's `--concurrency 2` and lost task 4 to the same
wall (`REPL execution timed out after 600000ms`, 656.5 s). At concurrency 1 the
identical task finished in 254.2 s. `run-train-round.mjs` at concurrency 2 puts
two parents on one khal key, so gen-1's rounds carried ~8 concurrent streams and
gen-4's carry 10–14 — past the four-child point where `recursion-recon.md` §6.1
measured latency reaching ~8.5 s/iteration. **`RLMX_REPL_TIMEOUT_MS` stays at
600000**; raising it would move the wall instead of measuring whether the recipe
fits inside it. Wall clocks here are therefore **not** comparable with gen-1's
rounds; facts, spawns and criteria 2/3 are.

That aborted round was discarded, not scored — its partial output was removed
and the roots restored before the recorded campaign started.

## Layout

```
gen-4/
  recipe/{SYSTEM.md,agent.yaml}   the mutation under test (640dfa69 / 20f8e018)
  rep-1/, rep-2/                  one full round each — runs/, logs/, round.json,
                                  recipe/ snapshot, summary.{txt,json}
  union.{txt,json}                optimizer/union-report.mjs over both
```

Replicates are `rep-<k>/`, **not** new generation numbers: this is one
generation measured twice, and the totals history must not read as if the prompt
had mutated between them.
