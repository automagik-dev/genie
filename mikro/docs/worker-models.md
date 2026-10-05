# Worker models — which model to run a microagent on

**Default: `khal/deepseek-v4-flash`.** It is the arm to run because it is
8.7×–18.8× cheaper per round than every other model measured and it finished
every run, **not** because it was measured to be the most accurate — that
comparison was never resolved. `station/<model>` is the $0 offline option and
is documented below with what its measurement does and does not buy.

This page consolidates the round-2 worker-model evidence into one table. It
adds nothing new to the parity record: every number here traces to a run record
committed under `.genie/wishes/rlmx-explore-offload/parity/round2/`, and the
scoping is [`docs/parity-explore.md`](parity-explore.md)'s own.

---

## Read this before quoting anything below

Five facts frame every number on this page. They are stated first because each
one has already been overstated at least once during the campaign, and the
correction is the reason this page exists.

1. **The gate failed. Twice.** Round 1: 0 of 6 tasks passed against a bar of 5
   of 6. Round 2's recursive shot: **0 of 6** again — criteria 2 and 3
   (citations resolve, nothing fabricated) passed on all six tasks, criterion 1
   (fact coverage) passed on none (`parity-explore.md`, *Gate arithmetic*).
   Nothing on this page is a parity claim, and no model choice turns a FAIL
   into a PASS.
2. **The out-of-sample number is 0.714, not 0.9.** The holdout — run once,
   after the recipe and model were chosen, never fed back — scored **10/14
   (coverage 0.714)** against **0.853–0.912 on the fitness set the recipe was
   tuned on**: "a real drop of 0.14–0.20" (`parity-explore.md:1047-1048`). The
   fitness numbers in the table below are *in-sample*. Quote 0.714 when
   describing a question nobody has asked yet.
3. **"Zero fabrications" holds in the frozen configuration only.** The frozen
   shot produced "215 citations, zero unresolvable, zero fabricated"
   (`parity-explore.md:827-828`), and so did all four matrix arms on the
   training suite (109/109, 64/64, 65/65, 101/101). That is not a property of
   the tool: **earlier rounds fabricated**, repeatedly (`:426-427`), and the
   verification block in the tuned prompt is what fixed it — "fabrications fell
   sharply wherever it ran" (`:685`).
4. **Premium-token reduction, frozen configuration: 1,077×** aggregate over the
   six-task suite (per-task 530×–1,835×) for **$0.22** of gateway spend
   (`:960-970`). Round 1's `r15-flash-control` — a different, non-shipping
   configuration — measured 921× for $0.14 (`:554-562`). The two are not
   interchangeable, and the report prices the number in the same breath: "It
   still buys an answer that fails the quality bar."
5. **The campaign evaluated four generations and rejected a fifth.** gen-0
   28/34, gen-1 29/34, gen-2 28/34, gen-3 29/34 — gen-1 selected **on the
   explicit ground that a tie does not displace an incumbent**, not on a
   margin. gen-4 was **rejected**: four training anchoring terms sit verbatim in
   its own prompt while the fact rule is a substring test, and its holdout
   regressed to 8/14 (`:1049-1055`). Separately, the **recursion product fixes
   live in git, not in the harness**: commit **`6ec4822`** — child model
   pinning, the `rlm_query` model argument, and loud child failure. The parity
   report records harness corrections; `6ec4822` is the product change.

> **What ran is not what ships.** Every round-2 number below was produced by the
> optimizer's **gen-1** recipe (`SYSTEM.md` sha256 `02184f35…`). The recipe in
> [`examples/agents/explore-r/`](../examples/agents/explore-r/) is **gen-0**
> (`06c6ea94…`), which scored 28/34 and was never replaced by gen-1. Same
> `agent.yaml` (`20f8e018…`), different `SYSTEM.md`.

---

## The consolidated table

One recipe (gen-1's frozen snapshot, supplied with `--recipe`, never edited),
one suite (the six **fitness** tasks of
`parity/round2/train-tasks/`, 34 required facts; `1.md`/`2.md` held out and
refused by the harness), one scorer. All dates 2026-07-27 UTC.

| arm | n | facts /34 | anchors cited | tasksPassed | runsOk | c2/c3 fail | citations | spawns | $/round | wall | ran (UTC) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `khal/deepseek-v4-flash` | 1 | **29–31** *(published 32, withdrawn)* | 30/34 | 4/6 | 6/6 | 0 / 0 | 109/109 | 15 | **$0.15** | 714 s | 09:46–09:58 |
| `khal/qwen3.7-max` | 1 | 28 | 25/34 | 2/6 | 6/6 | 0 / 0 | 64/64 | 17 | $2.82 | 1,230 s | 09:47–10:07 |
| `khal/deepseek-v4-pro` | 1 | 25 | 22/34 | 2/6 | **5/6** | 0 / 0 | 65/65 | 19 | $1.30 ¹ | 1,162 s | 09:47–10:07 |
| `khal/glm-5.2` | 1 | 20 | 20/34 | 1/6 | **5/6** | 0 / 0 | 101/101 | 34 | $1.95 ¹ | 2,148 s | 09:48–10:24 |
| ─ *not rank-comparable with the rows above — different `n`, and a model class below the recipe's floor* ─ | | | | | | | | | | | |
| `station/qwen3.5-2b-FLM` | **2** | **0** *(0 in each replicate)* | 0/34 | 0/6 | 6/6 ×2 | **1 / 1** | 0/1 | **0** | **$0.00** | 2,082 s + 2,277 s | 17:59–19:12 |

¹ **Undercounted.** `pro`'s task 5 and `glm`'s task 6 each died without a cost
footer, so a parent plus four children are missing from each sum. Both arms are
undercounted *against* flash, so the cost gap is a lower bound.

Sources: each arm's `summary.json` under
`parity/round2/optimizer/matrix/<arm>/`; the corrections and the withdrawal of
flash's 32/34 are `parity/round2/optimizer/matrix/README.md`. Every cell above
is copied from a committed record — none is recomputed here.

### Per-arm pricing

Catalog prices read live from the khal LiteLLM gateway (`/v1/model/info`) on
2026-07-27, the same day every arm ran. mikro converts LiteLLM's per-token
prices ×1e6 on the way in (`src/khal-provider.ts`).

| model | input $/Mtok | output $/Mtok | context |
|---|---|---|---|
| `khal/deepseek-v4-flash` | **$0.10** | **$0.20** | 1,048,576 |
| `khal/glm-5.2` | $1.00 | $4.00 | 1,048,576 |
| `khal/deepseek-v4-pro` | $1.30 | $2.60 | 1,048,576 |
| `khal/qwen3.7-max` | $2.50 | $7.50 | 256,000 |
| `station/<any>` | **$0.00** | **$0.00** | local; mikro caps the window at 32,768 |

`station/*` is $0.00 by construction, not by measurement: the provider declares
`cost: { input: 0, output: 0, … }` because a keyless local gateway bills
nothing (`src/station-provider.ts`). Electricity and wall-clock are real and
are not in that number.

### What the table decides

**Robust — quote this:**

| | |
|---|---|
| **Cost ranking** | flash is cheapest by **8.7×** (pro), **13×** (glm), **18.8×** (qwen) **per round**. Per *fact*, taking flash at the **pessimistic** end of its band and every rival at its published best: **10×** (pro), **19×** (glm), **19.5×** (qwen). A ±3-fact band moves cost-per-fact ~10%; it cannot reorder an order-of-magnitude spread, and both undercounted arms are undercounted against flash. |
| **Discipline** | criteria 2 and 3 clean on all four arms: 0 fabrications, every citation resolving. No model traded honesty for coverage. |
| **Reliability** | flash and qwen finished 6/6 runs. **pro lost task 5** to the 600 s REPL wall and **glm lost task 6**; glm's task 8 returned a **1-character answer after 14 spawns and 1,150 s**. Two of four arms cannot finish the suite under contention. Those are zeroed tasks, not close calls — the finding survives any plausible noise band. |
| **`glm-5.2` is last** | 20/34 with two damaged tasks at $1.95. No band closes 12 facts. |

**Not decided — do not quote as a ranking:**

| | |
|---|---|
| **flash vs `qwen3.7-max` on facts** | published margin +4 (32 vs 28); against flash's corrected band it is **+1 to +3**, inside the ±3 run-to-run spread measured on flash itself — and qwen is n=1 with no band measured at all. Unresolved. |
| **flash vs `deepseek-v4-pro` on facts** | pro's 25/34 includes a task zeroed by an environment wall, not by the model. Its `rerun-task5-repl-wall/` scored 5/5 in 363 s at concurrency 1, which would read 30/34 — and is **not** protocol-identical, so it is a diagnosis, not a substitute measurement. |
| **"flash is the matrix winner"** | true on **cost**, undetermined on **facts**. |

### Why n = 1 is the binding constraint

The suite's run-to-run spread on a **fixed** (recipe, model, suite) triple is
**±3 facts of 34**: gen-1's round scored 29/34 and the flash matrix arm scored
32/34 with nothing changed but the clock, and three live replicates of task 4
alone span 3/6 → 6/6. That spread is **larger than the entire range of the four
optimizer generations** (`[28, 29, 28, 29]`) and larger than every cross-arm
fact margin here except glm's.

**Anything smaller than ~3 facts, measured once, is noise.** That applies to
the matrix, to the generation totals, and to the holdout gap.

Two further caveats that belong to the matrix and travel with these numbers:

- **All four arms ran concurrently on one khal key**, far beyond the
  4-concurrent-children figure `recursion-recon.md` §6.1 measured. Wall clocks
  are upper bounds under contention, and the two lost runs are plausibly
  contention effects.
- **Only task 4 was replicated, and only on flash.** The three replicate run
  records were produced live by the campaign verifier and **are not committed**
  — the three scored totals in `matrix/README.md` are the whole of that
  evidence.

---

## The station arm — and what n = 2 does *not* buy

`station/<model>` is the **$0 offline option**: a keyless local Lemonade
gateway, no key to leak, no per-token bill, no network. Every microagent in
[`examples/agents/`](../examples/agents/) runs on it by changing one `model:`
line, and three of them
([`codebase-qa`](../examples/agents/codebase-qa/),
[`changelog`](../examples/agents/changelog/),
[`log-triage`](../examples/agents/log-triage/)) already declare a station model
as their default.

The station arm is run at **n = 2 replicates** — two independent rounds of the
same six fitness tasks, sequential, `--concurrency 1`, separate scratch HOMEs —
and pooled by `optimizer/union-report.mjs`, the same protocol gen-4 used.

**The row is marked not-rank-comparable, and that marking is the point.** Two
replicates buy exactly three things:

| n = 2 **does** establish | n = 2 does **not** establish |
|---|---|
| **Feasibility** — whether the recursive recipe completes at all on a local model under this harness's walls (`MIKRO_REPL_TIMEOUT_MS=600000` for the fan-out, `MIKRO_MCP_RUN_TIMEOUT_MS=900000` for the run) | **A rank against the khal arms.** Those are n = 1 on a suite whose measured run-to-run spread is ±3 facts of 34. Comparing a 2-replicate mean to a 1-round observation is not a comparison |
| **Cost** — $0.00, by construction | **That the station model is better or worse** than any khal model on coverage. Nothing here tests that |
| **A first noise estimate** — the spread *between* the two replicates on one fixed (recipe, model, suite) triple | **A level.** Two observations bound a spread loosely and estimate a mean badly |

Reproduce it (keyless — no `KHAL_API_KEY` needed or used):

```bash
cd ~/prod/mikro && npm run build
R=.genie/wishes/rlmx-explore-offload/parity/round2
for rep in 1 2; do
  node $R/run-train-round.mjs --gen 1 \
    --model    station/<model> \
    --recipe   $R/optimizer/gens/gen-1/recipe \
    --gen-dir  $R/optimizer/station-arm/rep-$rep \
    --label    station-arm-rep$rep --concurrency 1
done
node $R/optimizer/union-report.mjs --label "station arm" \
  --out $R/optimizer/station-arm $R/optimizer/station-arm/rep-1 $R/optimizer/station-arm/rep-2
```

`--concurrency 1` is a deliberate difference from the khal matrix arms, which
ran at 2. One local gateway serving one model cannot host two tasks' worth of
streams — a task is already a parent plus up to four concurrent children — and
the frozen shot used concurrency 1 for the same reason. Wall clocks are
therefore not comparable to the matrix's contended ones in either direction.

### Result — `station/qwen3.5-2b-FLM`, 2026-07-27

```
UNION facts=0/34 coverage=0 perReplicate=[0, 0]/34 spread=0 unionLift=+0
      runsOk=[6, 6]/6 c2fail=1 c3fail=1 vacuousCriteria=6 fabrications=1 citeFail=1
      cites=[0/1, 0/0] spawns=[0, 0] cost=[$0, $0] wall=[2082, 2277]s
```

**Read the model first.** This is a **2 B** model, and it is the arm's central
caveat: it was **the only station model that would serve on this host that
day**. Five larger candidates were tried and none loaded — one of them
(`Brain-35B`) wedged the gateway's model loader for ~31 minutes; the
vulkan-pinned `Qwen3.6-35B-A3B-MTP-GGUF` got 22 GB of weights into GTT and then
returned an empty body after 600 s. `scripts/smoke-explore.mjs` already records
that even a **4 B** "runs the protocol fine and fails the task", so 0/34 here
is a statement about model capacity, not about the recipe, the provider, or
local inference in general. Full escalation record:
[`station-arm/README.md`](../.genie/wishes/rlmx-explore-offload/parity/round2/optimizer/station-arm/README.md).

What the two replicates therefore **do** establish:

| | |
|---|---|
| **Feasibility of the plumbing** | **12 of 12 runs completed and scored**, `runsOk` 6/6 in both replicates, both rounds `exitCode 0`, no timeout, no lost run. The keyless `station/` path, the scratch-HOME install, the child-model pin and the scorer all work end to end. Two of the four *cloud* arms could not say that. |
| **Cost** | **$0.00**, both replicates, by construction — 4,359 s of wall clock and no bill. |
| **Wall clock is the price** | 2,082 s and 2,277 s per six-task round, against flash's 714 s — and flash's number was measured under four-way contention. |
| **Replicate spread is in the clock, not the score** | Coverage spread is 0 (both 0/34), but per-task wall clock swings hard on the identical triple: task 3 **893 s → 187 s**, task 4 **167 s → 900 s**. On this model, timing is not reproducible even when the answer is. |

What it **does not** establish, beyond the n = 2 limits stated above: anything
about **larger station models**, because none of them ran. The comparison this
arm makes is `station/qwen3.5-2b-FLM` versus nothing.

Two findings that are about the *recipe*, not the model, and that no khal arm
surfaced:

- **The fan-out never fired: `spawns=[0, 0]`, every run, both replicates.** The
  recursive half of `explore-r` is completely unexercised here. Whatever this
  arm measures, it is not recursion.
- **The first fabrication in the whole round-2 record.** rep-1 task 8 emitted
  exactly one citation, `app/models/order.rb:88`, and it failed both criterion
  2 and criterion 3 (`missing-file`). That path is a **worked example inside
  the recipe's own `SYSTEM.md`** (lines 500, 510, 514) — the model recited its
  instructions. All four khal arms were 0-fabrication on this suite; the
  difference is the model, not the prompt. It is the same prompt-leakage
  mechanism that got gen-4 rejected.

**Do not read the other eleven runs' `c2=PASS`/`c3=PASS` as citation
discipline.** They emitted **zero citations**, so the scorer had nothing to
fail; `union-report.mjs` marks all six task-level cases `VACUOUS` for exactly
this reason.

---

## Reproducing any row

```bash
export KHAL_API_KEY=…          # shell only, never in a file — station needs none
cd ~/prod/mikro && npm run build

R=.genie/wishes/rlmx-explore-offload/parity/round2
node $R/run-train-round.mjs --gen 1 \
  --model    khal/deepseek-v4-flash \
  --recipe   $R/optimizer/gens/gen-1/recipe \
  --gen-dir  /tmp/my-arm \
  --label    my-arm --concurrency 1
```

`--gen 1` names *which generation's recipe ran*; `--gen-dir` is where the
records land. The two are separate on purpose: an arm re-runs an
already-selected recipe on another model, so it is not a new generation and
must not take a number in the `gens/` series.

The harness refuses, by construction, to run the frozen eval suite
(`<wish>/tasks/`) and to run a held-out training task without `--holdout` plus
a `--gen-dir` outside `gens/`. Those refusals are not flags to work around —
a training loop that touches the gate has no gate.
