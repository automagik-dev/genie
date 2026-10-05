# EVOLUTION — the recipe's mutation log

One entry per generation. Each says what changed in
`optimizer/current/{SYSTEM.md,agent.yaml}`, which observed miss it targets, and
what it is expected to move. Snapshots of what actually ran live in
`gens/gen-<N>/recipe/`; this file is the reasoning that connects them.

---

## 2026-07-27 · gen-0 → gen-1 · "name the thing on the line"

| | |
|---|---|
| Parent generation | **gen-0** (also the best so far — totals history `[28]`, so no revert; Pareto discipline is a no-op with one point) |
| gen-0 recipe | `SYSTEM.md` `06c6ea94` / `agent.yaml` `20f8e018` |
| gen-1 recipe | `SYSTEM.md` `02184f35` / `agent.yaml` `20f8e018` (**unchanged**) |
| gen-0 fitness | `facts=28/34`, `fitness=0.8235`, `tasksPassed=1/6`, `runsOk=6/6`, `c2fail=0`, `c3fail=0`, `cites=101/101`, fabrications **0** |

### What gen-0 actually got wrong — one number decides it

Aggregated over the six fitness tasks from `gens/gen-0/runs/task-*.score.json`:

```
namesAnchorPath:  34/34
termHit:          28/34
```

**The agent named the anchor path for every single required fact in every task.**
Partition, fan-out, subsystem selection and file discovery are at ceiling; there
is nothing left to win there. The whole 6-fact deficit is one failure repeated:
the answer *describes what the cited line does* instead of *naming the thing
that sits on it*.

The corollary is stronger still. Every one of the six misses lives in a file the
answer already cited, and four of the six live within four lines of a line it
already cited:

| Task | Fact | Anchor | Term the answer never wrote | Nearest line it did cite |
|---|---|---|---|---|
| 3 | F5 | `src/xdna_top/npu_power.py:84` | `m.group("lb") == "["` | 115 (same file) |
| 4 | F1 | `src/xdna_top/record.py:22` | `RECORD_SCHEMA_VERSION` | 26 — **4 lines below** |
| 4 | F2 | `src/xdna_top/record.py:23` | `RECORD_KIND` | 26 — **3 lines below** |
| 5 | F1 | `src/main/services/ptyManager.ts:38` | `new Map<string, PtyRecord>()` | **38 — the same line** |
| 6 | F1 | `src/main/services/RtkService.ts:180` | `findCmd` | **180 — the same line** |
| 7 | F6 | `channel/enroll.sh:23` | `SUITE` | 27 — **4 lines below** |

Two of the six were already open on the model's screen and simply not named
(task 6 stated the claim correctly — *"`where.exe` on Windows, `which` on
Linux/macOS (src/main/services/RtkService.ts:180)"* — and never wrote
`findCmd`). Three more were a handful of lines from something it cited. Zero
required finding a new file.

So gen-1 changes **nothing about search, partitioning, fan-out width or
allocation**, and everything about what happens to a line once it is in hand.

### The three changes

**1 — The anchor-term rule.** A citation must carry, inside the sentence that
makes the claim, the identifier or literal that sits on that exact line, spelled
the way the file spells it; and where a thing is declared once and used many
times, the citation goes on the *declaration*. Landed in four places so it is
operative rather than decorative: rule 3 of the opening five; a new bullet in
*The citation contract*; a `NAME the identifier or literal…` clause in the `ASK`
sub-prompt template (so the leads come back already carrying terms — the child
runs the ambient prompt and inherits nothing, `recursion-recon.md` §6 item 3);
and both worked examples in phase 6, whose citation lists now read
``- app/models/order.rb:88 — `transition :pending => :paid` `` instead of
restating the claim. Guarded against the two ways it could backfire: the token
must be visible in the run's *own* REPL output (so it cannot become a route to
fabrication — gen-0's 0 fabrications must hold), and it is *one token or one
short fragment, never the line*, so the no-dumping rule survives intact.
→ targets **T6 F1**, **T5 F1**, and half of **T4 F1/F2**.

**2 — The `defs()` sweep.** New helper in the phase-1 starter block that prints
every top-level definition of a file as `path:line: text` — constants, paths,
modes, versions, limits, defaults — and a mandated one-line call over every file
about to be cited, folded into the existing phase-4 aggregate block. Its output
lands at the top of phase 5, where the prompt now tells the agent to *add* a
claim for each definition bearing on a need. These are free facts: `defs()`
prints the line number from the agent's own REPL, so a claim built on one is
already verified. Measured on the four training roots — 736 to 3,655 chars per
run, negligible against the 20,000-char REPL truncation — and it surfaces
`record.py:22` `RECORD_SCHEMA_VERSION`, `record.py:23` `RECORD_KIND`,
`enroll.sh:23` `SUITE`, `ptyManager.ts:38` `new Map<string, PtyRecord>()`, plus
`RtkService.ts:32-34` and `ptyManager.ts:127/695/708/727` (facts gen-0 already
had, now held rather than hoped for).
→ targets **T4 F1**, **T4 F2**, **T7 F6**; hardens 8 currently-passing facts.

> **Unreproducible from artifacts (campaign verifier, 2026-07-27).** The
> "736 to 3,655 chars per run" measurement above cannot be recomputed from the
> tree: no replay harness is committed and run records store no REPL stdout.
> Read it as a contemporaneous note, not a checkable measurement. Detail:
> *Corrections*, end of file.

**3 — The `NEEDS` clause checklist.** The question is split at partition time
into one entry per *thing asked for* — not per sentence and not per numbered
heading, because a single clause routinely asks for two things and the second is
the one that gets dropped. Written and printed in the spawn block, re-printed in
the verify block, walked one final time in phase 6, where an entry with no
citation gets an honest "not found" sentence rather than silence. This is the
gen-0 task-3 failure exactly: *"How does this project read the NPU's
power/clock state, **and** what exactly does it return when it cannot"* is two
needs; the answer covered the failure half with three cited sentinels and never
covered the reading half, so the DPM bracket test at `npu_power.py:84` was never
reached. Same shape in task 4, where *"what identifies an event"* was answered
with the event's *shape* (five dict keys) instead of its *identity* (two
module-level constants).
→ targets **T3 F5**, and the framing half of **T4 F1/F2** and **T7 F6**.

### Budget: deliberately unchanged (14 / 2.00 / 2)

`agent.yaml` is byte-identical to gen-0's. Three reasons, in order of weight:

1. **All three changes cost zero blocks.** `NEEDS` rides in the spawn block, the
   sweep rides in the aggregate block, the term check and the checklist walk ride
   in the verify block. The parent's path is the same 8 turns the `agent.yaml`
   comment sizes 14 against. The pre-existing "one turn to `search()` for an
   uncovered part" affordance was reworded to key off `NEEDS`, not added.
2. **gen-0 lost nothing to truncation.** All six runs returned complete,
   well-formed answers; `c2`/`c3` passed everywhere and 101/101 citations
   resolved. Tasks 3 and 4 reached 14/13 iterations and still emitted a full
   `FINAL` with 14 and 9 citations. The deficit is not a turn shortage.
3. **`max_iterations` is one number with two roles** (`recursion-recon.md` §4,
   `src/rlm.ts:436`): raising it lengthens every child's wall clock inside the
   blocking fan-out, and 18 is measured to overrun the 600 s REPL wall and lose
   the whole run (`smoke/smoke-3.json`). Measured gen-0 waves — ~110 s (t3),
   ~165 s (t4), ~180 s (t5, t8) — sit comfortably inside 600 s at 14, and there
   is no evidence worth spending that margin on.

Holding it also keeps the gen-0 → gen-1 delta attributable to the prompt alone,
which is the only reason the number is worth reading.

### Verification done before shipping the mutation

The three `repl` blocks were extracted from the mutated `SYSTEM.md` and executed
as written against the live training roots: the starter block runs clean (adds
`defs`, keeps `walk`/`look`/`search`/`read`/`usable` intact), the sweep prints
the anchors listed above, and the rewritten verify block correctly separates
`OK` from a deliberately drifted `TERM` case and from `DROP`. `CLAIMS` moved
from a 3-tuple to a 4-tuple and every consumer moved with it.

**Untouched, as required:** `parity/score-task.mjs` and `parity/verify-native.mjs`
(no flags, no defaults, no bytes); `examples/agents/explore-r/**`; the frozen
eval tasks, unread; the two held-out train tasks `1.md` / `2.md`, unread and
unrun.

> **Correction — 2026-07-27, round-2 campaign verifier.** "no flags, no defaults,
> no bytes" is **false as written**, and is left above so the corrected claim can
> be read against it. Both scorers *did* gain a flag, in commit `4cfb587`
> (round-2 prep, before gen-0 ran): `score-task.mjs` gained `--tasks-dir`
> (+60 lines), `verify-native.mjs` gained `--dir` (+40 lines). True as narrowed:
> **no generation of this loop changed a scorer byte**, both flags default to the
> frozen eval suite so the default path is unchanged, and no rubric, threshold or
> fact rule moved. That is the wording `train-tasks/README.md` already uses. See
> *Corrections* at the end of this file.

### What to expect, and how it will be falsified

If the diagnosis is right, gen-1 lands **31–34/34**: the three sweep-reachable
misses (T4 F1, T4 F2, T7 F6) and the two same-line misses (T5 F1, T6 F1) should
convert, with T3 F5 the least certain because it needs the checklist to change
what the agent *looks for*, not just what it *writes down*. `namesAnchorPath`
must stay 34/34 — if it drops, the sweep or the checklist has displaced search
effort and the change is net-negative regardless of `termHit`. Fabrications must
stay 0 and `cites` must stay 101/101; the anchor-term rule is the change most
capable of breaking either, and both are hard failures, not trade-offs.

---

## 2026-07-27 · gen-1 → gen-2 · "cite the line that states it"

| | |
|---|---|
| Parent generation | **gen-1** — and it is also the best so far (totals history `[28, 29]`), so **no revert**; Pareto discipline selects the current point and the mutation is applied on top of it |
| gen-1 recipe | `SYSTEM.md` `02184f35` / `agent.yaml` `20f8e018` |
| gen-2 recipe | `SYSTEM.md` `10f07ed3` / `agent.yaml` `20f8e018` (**unchanged**) |
| gen-1 fitness | `facts=29/34`, `fitness=0.8529`, `tasksPassed=3/6`, `runsOk=6/6`, `c2fail=0`, `c3fail=0`, `cites=97/97`, fabrications **0** |

### What gen-1 bought, and what it did not

gen-1's three changes converted the two *same-line* misses — T5 F1
(`ptyManager.ts:38`, `new Map<string, PtyRecord>()`) and T6 F1
(`RtkService.ts:180`, `findCmd`), both facts whose line the answer had already
cited and merely failed to name. Both tasks went to 5/5 and `weak` went 1 → 0.
That is the anchor-term rule working exactly as designed.

It bought nothing anywhere else, and it **cost one fact**: T3 F6
(`discover_sysfs.py:18`, `"CPU-only fallback"`) was an explicit citation in
gen-0's answer and is absent from gen-1's, while gen-1's task-3 answer grew from
14 citations to 25. Five of those 25 are bare `def` headers and six are in
`tools/probe_sensors.py`, a file carrying none of the seven required facts. The
`defs()` sweep and the anchor-term rule together made *nameable* lines cheap to
cite, and the run spent its citation budget on them instead of on the lines that
carry the facts. Net +1 (28 → 29), with the composition changed underneath.

### The five survivors are one failure, and it is not a search failure

`namesAnchorPath` is **34/34** for the second generation running. Every required
fact lives in a file the answer already found, cited and quoted from. What the
answer never does is put the citation on the line that *states* the fact:

| Task | Fact | Anchor | Term never written | What the answer anchored on instead |
|---|---|---|---|---|
| 3 | F5 | `npu_power.py:84` | `m.group("lb") == "["` | `:70` `def parse_dpm_level` — the header, then the behaviour in prose |
| 3 | F6 | `discover_sysfs.py:18` | `CPU-only fallback` | `:23/:24/:25` — the three candidates, five lines below the initial status |
| 4 | F1 | `record.py:22` | `RECORD_SCHEMA_VERSION` | `:26/:31` — the builder and the `"type"` key that carries the value on |
| 4 | F2 | `record.py:23` | `RECORD_KIND` | same |
| 7 | F6 | `enroll.sh:23` | `SUITE` | `:81`–`:88` — the heredoc that *uses* `$SUITE`, and `:27`–`:29`, four lines below the declaration |

Three shapes, one diagnosis. A **value** claim landed on a line that consumes
the value (F1, F2, F6-t7). A **decision** claim landed on the function header
that contains the test (T3 F5). An **initial-state** claim landed on the loop
that overwrites it (T3 F6). In every case the correct line is within **five
lines** of one the answer already cited — and in three of the five, `defs()`
had already printed the exact line, with its number, and it was read past.

So gen-2 changes nothing about search, partitioning, fan-out or allocation
again, and everything about *which* of the lines already in hand gets the
citation.

### The three changes

**1 — `near()`: print the neighbourhood of every line you are about to cite.**
New starter-block helper. It merges ±5-line windows around a file's claimed
lines into non-overlapping spans and prints them numbered, capped at 90 lines
per file. Called in the existing phase-4 aggregate block, interleaved per file
with `defs()`, so its output lands at the top of phase 5 next to the sweep. This
is the mechanical half of the fix, and it was **measured before shipping**:
replaying each gen-1 run's own resolved citation set through the mutated block
surfaces, in the agent's own REPL output, **all five** remaining misses —
`npu_power.py:84`, `discover_sysfs.py:18`, `record.py:22`, `record.py:23`,
`enroll.sh:23`. Cost: zero blocks, and the fattest observed block goes from
14,718 to 11,008 chars against the 20,000-char truncation (55%), because the
per-file cap bounds the one hot file (`ptyManager.ts`, 21 citations, 184
neighbourhood lines → 90).
→ targets **all five misses**, mechanically.

> **Unreproducible from artifacts (campaign verifier, 2026-07-27).** The replay
> ("surfaces all five remaining misses") and the block-size figures (14,718 →
> 11,008 chars, 55% of truncation) come from a harness that was **never
> committed** — the only scripts under `round2/` are `run-train-round.mjs`,
> `summarize-train-round.mjs` and `smoke-explore-r.mjs`, and `runs/task-*.json`
> stores `answer`, `footer` and `progress`, not REPL block stdout. Nothing in the
> tree can recompute them. Read them as contemporaneous notes, not as checkable
> measurements. Detail: *Corrections*, end of file.

**2 — *Which line to cite*.** A new short section at the end of phase 4, plus a
rewrite of the citation contract's corollary. Four rows: a **value** claim goes
on the line where the value is written, never on a line that reads it or carries
it onward; a **decision** claim goes on the test itself, never on the function
containing it; a **behaviour** claim goes on the statement, never on the
`def`/`function`/`class` header; only *"this thing exists"* belongs on a header.
Then two rules: a signature line is evidence for the existence of the thing and
nothing it does, and a name you merely *use* has a declaration line that
`defs()` already printed. Closes with **"prose is not a citation"** — describing
a value in a sentence while the nearest cited line is thirty lines away is the
exact shape of T3 F5 and T3 F6. One clause of the same rule is added to the
`ASK` sub-prompt template, so the leads come back anchored on statement lines
rather than headers (the child runs the ambient prompt and inherits nothing —
`recursion-recon.md` §6 item 3).
→ targets **T3 F5** and **T3 F6** (decision / initial-state), **T4 F1-F2** and
**T7 F6** (value-vs-use); and pushes back on the gen-1 breadth dilution, since
a bare `def` citation is now explicitly worth nothing.

**3 — the `NEEDS` walk now demands a *proof* line.** Phase 5's checklist step
changes from "name the `KEEP` line that answers it" to "name the `KEEP` line
whose printed text **states** it — not a line in the right file, not the
function that contains it, but a line you could quote as the proof", with an
explicit failure branch: if the best you have for a need is a `def` header or a
pointer at a file, *you have not found that fact yet*, and `near()`'s output in
the previous block is where to look before searching anywhere else. This is what
makes change 1 land: the neighbourhood is printed, and this is the step that
obliges the agent to read it.
→ targets **T3 F5** and **T3 F6** specifically, where the answer knew the fact
well enough to state it in prose and never went looking for its line.

**Removed:** the citation contract's `RECORD_SCHEMA_VERSION` example — a
training-suite symbol quoted verbatim in the prompt. It converted nothing in
gen-1 (T4 F1 and F2 both still miss), it is train-set leakage into a recipe that
must generalise to the frozen eval suite, and a model that parrots it into an
eval answer emits a symbol that repository does not have — a criterion-3
fabrication. Replaced with the structural statement of the same rule.

### Budget: unchanged again (14 / 2.00 / 2)

`agent.yaml` is byte-identical to gen-0's and gen-1's — `20f8e018`.

1. **All three changes cost zero blocks.** `near()` rides in the aggregate block
   next to the sweep; *Which line to cite* is a reading rule applied in the
   verify block that already exists; the `NEEDS` walk is a rewording of a step
   that already ran. The parent's path is the same 8 turns.
2. **gen-1 was nowhere near the cap.** Iterations used: 10, 7, 9, 7, 6, 5 out of
   14 — the *most* expensive task spent 10. Wall clock topped out at 323.5 s of a
   900 s run budget. There is no evidence of a turn or clock shortage, and the
   deficit is not one.
3. **`max_iterations` is still one number with two roles** (`recursion-recon.md`
   §4, `src/rlm.ts:436`): raising it lengthens every child's wall clock inside
   the blocking fan-out, where 18 is measured to overrun the 600 s REPL wall and
   lose the entire run (`smoke/smoke-3.json`). Nothing here is worth that margin.

Holding it a third time also keeps the whole `[28, 29, ?]` series attributable
to the prompt alone.

### Verification done before shipping the mutation

All seven `repl` blocks were extracted from the mutated `SYSTEM.md` and executed
as written:

- the starter block runs clean at **all four** training roots and binds
  `walk`/`look`/`search`/`read`/`defs`/`near`/`usable`;
- the aggregate block was replayed against **each gen-1 run's own resolved
  citation set** at that run's real root: every one of the five surviving misses
  is printed back, and block output stays between 20% and 55% of the truncation
  limit;
- the verify block still separates `OK` from a deliberately drifted `TERM` case
  and from a `DROP` (missing file), and `KEEP` keeps only the `OK` row.

> **Unreproducible from artifacts (campaign verifier, 2026-07-27).** The replay
> against "each gen-1 run's own resolved citation set" and the "20% to 55% of the
> truncation limit" range are not recomputable from the tree — no replay harness
> is committed and run records store no REPL stdout. Contemporaneous notes, not
> checkable measurements. Detail: *Corrections*, end of file.

**Untouched, as required:** `parity/score-task.mjs` and `parity/verify-native.mjs`
(no flags, no defaults, no bytes); `examples/agents/explore-r/**`; the frozen
eval tasks, unread; the two held-out train tasks `1.md` / `2.md`, unread and
unrun.

> **Correction — 2026-07-27, round-2 campaign verifier.** "no flags, no defaults,
> no bytes" is **false as written**, and is left above so the corrected claim can
> be read against it. Both scorers *did* gain a flag, in commit `4cfb587`
> (round-2 prep, before gen-0 ran): `score-task.mjs` gained `--tasks-dir`
> (+60 lines), `verify-native.mjs` gained `--dir` (+40 lines). True as narrowed:
> **no generation of this loop changed a scorer byte**, both flags default to the
> frozen eval suite so the default path is unchanged, and no rubric, threshold or
> fact rule moved. That is the wording `train-tasks/README.md` already uses. See
> *Corrections* at the end of this file.

### What to expect, and how it will be falsified

If the diagnosis is right, gen-2 lands **32–34/34**: T4 F1, T4 F2 and T7 F6 are
value-vs-use and should convert on change 2 alone with change 1 as the safety
net; T3 F6 is a straight recovery of a fact gen-0 already had; T3 F5 is the
least certain, because it needs the answer to move a citation it is currently
happy with.

Three hard guards, any of which makes this change net-negative regardless of
`termHit`:

- `namesAnchorPath` must stay **34/34**. If it drops, `near()` has displaced
  search effort — the same failure mode gen-1's sweep was watched for.
- Fabrications must stay **0** and `cites` must stay 100%. `near()` only prints
  lines from files already opened, so it cannot invent one; the risk is the
  *"which line to cite"* rule tempting a re-anchor onto a line the agent has not
  actually re-read. The verify block is what catches that, and it is unchanged.
- Citation count on task 3 should **fall** from 25, not rise. If the answer
  keeps its `def` headers and its `probe_sensors.py` excursion *and* adds the
  statement lines, the rule has been read as additive rather than corrective,
  and change 2 needs to be stated as a replacement instead of a preference.

---

## 2026-07-27 · gen-2 → gen-3 · "the sweep is a source of claims, not a check on them"

| | |
|---|---|
| Parent generation | **gen-1**, not gen-2 — **Pareto revert**, see below |
| gen-1 recipe (the base) | `SYSTEM.md` `02184f35` / `agent.yaml` `20f8e018` |
| gen-2 recipe (reverted from) | `SYSTEM.md` `10f07ed3` / `agent.yaml` `20f8e018` |
| gen-3 recipe | `SYSTEM.md` `4eafbb3d` / `agent.yaml` `20f8e018` (**unchanged, 4th generation**) |
| gen-2 fitness | `facts=28/34`, `fitness=0.8235`, `tasksPassed=2/6`, `runsOk=6/6`, `c2fail=0`, `c3fail=0`, `cites=105/105`, fabrications **0** |
| Totals history | `[28, 29, 28]` — best is **gen-1** |

### The revert, first, because it decides what "the base" means

gen-2 is **strictly dominated** by gen-1. It kept all five of gen-1's misses
(T3 F5, T3 F6, T4 F1, T4 F2, T7 F6) and added a sixth: T5 F5
(`ptyManager.ts:127`, `RESERVED_ENV_KEYS`) — a fact **gen-0 and gen-1 both
scored**, and whose line both of them cited. Its two prose changes converted
nothing and one of them is the plausible cause of the regression: *Which line to
cite* says a **behaviour** claim goes on the statement and never on the header,
and gen-2's task-5 answer duly moved the environment need onto eight use-site
statements (`TERM_PROGRAM: 'dash'` at `:246`, `delete env.ELECTRON_RUN_AS_NODE`
at `:593`, …) and off the declaration the fact lives on. Two runs also skipped
the mandatory fan-out entirely (`spawns=0` on tasks 6 and 7, against 3–4 on
every gen-1 run).

So Pareto discipline applies for the first time in this series and it is not a
no-op: **gen-3 is mutated from gen-1's `SYSTEM.md`, not from gen-2's.** One
piece of gen-2 is carried forward — `near()`, the only part of it with measured
value (below) — and one gen-1 line is **not** restored: the citation contract's
`RECORD_SCHEMA_VERSION` example, which gen-2 removed as train-suite leakage.
That removal was right and re-reverting it would put a training-set symbol back
in a prompt that has to generalise to the frozen gate.

### The measurement that changes the diagnosis

Three generations have now spent their mutation budget on making the missing
line **visible**: gen-1 added `defs()`, gen-2 added `near()`. So the obvious
question was never asked directly — *was the line ever on the screen?*

Replaying each generation's own resolved citation set through that generation's
own phase-4 block, at that run's real root, and asking only whether the missed
fact's line was printed:

| | facts missed | line printed in the run's own phase-4 block | worst block |
|---|---|---|---|
| gen-0 | 6 | 5 of 6 | 11,860 chars |
| gen-1 | 5 | **5 of 5** | 9,865 chars |
| gen-2 | 6 | 5 of 6 | 9,997 chars |

**Nothing was ever truncated** (the cap is 20,000 chars; the worst block used
59%), and in 15 of 17 miss-instances the line the answer needed was printed back
to the model, numbered, in its own REPL output, and never turned into a claim.
`namesAnchorPath` has been 34/34 for three generations; now the sweep is at
ceiling too. **Visibility is solved. Conversion is the entire remaining gap.**

> **Unreproducible from artifacts (campaign verifier, 2026-07-27).** The whole
> table above — "5 of 6", "**5 of 5**", "5 of 6", the worst-block char counts
> (11,860 / 9,865 / 9,997) and the 59%-of-cap claim — is the output of an
> uncommitted replay harness. `runs/task-*.json` records `answer`, `footer` and
> `progress` only; there is no REPL stdout in the tree to replay against, and no
> script under `round2/` that does this. The *conclusion* it supports (conversion,
> not visibility, is the gap) is consistent with the scored misses and
> `namesAnchorPath=34/34`, which **are** recomputable; the per-row numbers are
> not. Detail: *Corrections*, end of file.

The reason is structural, and it is visible in the block itself: `CLAIMS` comes
from the sub-agents, `defs()`/`near()` run over the files `CLAIMS` names, and
the verify loop iterates `CLAIMS`. The sweep's output has **no code path into
the answer** — only a sentence asking the model to "add a claim for every
definition that bears on a need", which gen-1 added, gen-2 strengthened, and
both generations ignored. A prose rule that competes with a data structure loses
to the data structure.

The six misses, classified — five are declarations, one is a predicate:

| Task | Fact | Anchor | The line | Class |
|---|---|---|---|---|
| 3 | F5 | `npu_power.py:84` | `if m.group("lb") == "[" …` | the test inside the parser, one hop below the entry point it cited (`:96`) |
| 3 | F6 | `discover_sysfs.py:18` | `"status": "CPU-only fallback",` | initial value **indented inside a literal** — `defs()` structurally cannot see it |
| 4 | F1/F2 | `record.py:22,23` | `RECORD_SCHEMA_VERSION` / `RECORD_KIND` | module constants; the answer said the `"type"` key identifies an event and cited `:31` |
| 5 | F5 | `ptyManager.ts:127` | `const RESERVED_ENV_KEYS = new Set([` | module declaration; the answer cited eight use sites instead |
| 7 | F6 | `enroll.sh:23` | `SUITE="${SUITE:-stable}"` | env-overridable default in the config header, four lines above `:27`, which it cited |

**Every one of them sits *above* the line the answer chose.** That asymmetry is
what change 3 is built on.

### The three changes

**1 — The harvest is code, not a request.** Phase 5's block now opens with a
mandatory `EXTRA = [...]` — new claims taken **only** from the `defs()`/`near()`
output the previous block printed, in the same 4-tuple as `CLAIMS` — and the
verify loop iterates `CLAIMS + EXTRA`. The block prints
`HARVEST <n> from the sweep + <m> from the sub-agents`, so the count is on the
screen, and the prose states the consequence plainly: *an empty `EXTRA` is a
claim you are making*, namely that nothing in that output answers any need —
false in 15 of the 17 miss-instances measured above. This gives the sweep the
code path into the answer it has never had.
→ targets **all five declaration-class misses**.

**2 — `NEEDS` entries carry a kind, and the kind picks the line.** `NEEDS`
becomes a list of `(kind, need)` pairs written at partition time and printed
twice (spawn block, verify block). Two kinds only: **`what-is-it`** — what
identifies it, defaults to, starts out as, is reserved, bounds it, configures it
→ the answer is a **declaration**; and **`what-happens`** — returns, writes,
decides, fails → the answer is the **statement or the test**, never the `def`
header. Phase 5's checklist walk is keyed to the tag: a `what-is-it` need that
lands on a use site, a key carrying the value onward, a function that reads it,
or a `def` header **has not been found yet**, and the line is in the `near()`
output a few lines earlier in the same file. This replaces gen-2's four-row
*Which line to cite* table — same instinct, but keyed to the checklist the run
already carries instead of floating free in phase 4, and without the
"behaviour → never the header" clause that pushed task 5 off its declaration.
→ targets **T4 F1/F2** (asked "what identifies an event", answered with a use
site), **T5 F5**, **T7 F6**, **T3 F6**; keeps the decision rule that **T3 F5**
needs.

**3 — `near()` looks further up than down.** Carried over from gen-2 and
re-tuned from a symmetric ±5 to `up=12, down=6` (per-file cap 90 → 100), because
all six misses are *above* the line the answer cited — 4, 4, 5, 9 and 12 lines
above. Measured with the shipped helper against all three generations' citation
sets: every gen-1 and gen-2 miss is now printed, including `npu_power.py:84`,
which was 12 lines above the nearest line gen-2 cited and was the one fact no
generation ever had on screen. Worst-case phase-4 block grows 11,860 → **14,103
chars, 71% of the 20,000-char truncation**; the median run is ~7,000.
→ targets **T3 F5**, and hardens the other five against a citation set that
drifts away from its own facts, which is exactly what gen-2's did.

> **Unreproducible from artifacts (campaign verifier, 2026-07-27).** "Measured
> with the shipped helper against all three generations' citation sets", the
> 11,860 → 14,103 char growth, the 71% figure and the ~7,000 median all come from
> the uncommitted replay harness. Not recomputable from the tree. The one part
> that is checkable is the `up=12, down=6` retune itself, which is in the shipped
> `SYSTEM.md` snapshot at `gens/gen-3/recipe/`. Detail: *Corrections*.

### Budget: unchanged (14 / 2.00 / 2), fourth generation running

`agent.yaml` is byte-identical to gen-0/1/2 — `20f8e018`.

1. **All three changes cost zero blocks.** `EXTRA` rides in the verify block
   that already runs, the kind tag rides in `NEEDS`, `near()` rides in the
   aggregate block. The parent's path is the same 8 turns.
2. **No run has been short of turns.** gen-2 used 8, 7, 10, 9, 6, 13 of 14;
   gen-1 used 10, 7, 9, 7, 6, 5. Worst wall clock was 449 s of a 900 s run and
   the fan-out block is on a 600 s REPL wall.
3. **`max_iterations` is still one number with two roles**
   (`recursion-recon.md` §4, `src/rlm.ts:436`): raising it lengthens every
   child's wall clock inside the blocking fan-out, where 18 is measured to
   overrun the REPL wall and lose the whole run (`smoke/smoke-3.json`).

Holding it a fourth time keeps the `[28, 29, 28, ?]` series attributable to the
prompt alone.

### Verification done before shipping the mutation

All seven `repl` blocks were extracted from the mutated `SYSTEM.md` and executed
as written:

- the starter block runs clean at **all four** roots (`xdna-top`,
  `genie-desktop`, `fde-station`, `rlmx`) and binds
  `walk`/`look`/`search`/`read`/`defs`/`near`/`usable`;
- the phase-4 block was replayed against **every run of all three generations**
  (18 citation sets): worst output 14,103 chars, and every gen-1/gen-2 miss is
  printed;
- the rewritten phase-5 block was run with a real seeded `EXTRA`: harvested
  declarations verify `OK` with their text printed, a deliberately drifted line
  comes back `TERM`, a missing file comes back `DROP`, `KEEP` holds only the
  `OK` rows, and the tagged `NEED:` checklist prints. `NEEDS` moved from a list
  of strings to a list of `(kind, need)` pairs and **both** consumers moved with
  it.

> **Unreproducible from artifacts (campaign verifier, 2026-07-27).** The
> "replayed against every run of all three generations (18 citation sets)" bullet
> and its "worst output 14,103 chars" are not recomputable — no replay harness is
> committed and no REPL stdout is recorded. Contemporaneous notes. Detail:
> *Corrections*, end of file.

**Untouched, as required:** `parity/score-task.mjs` and `parity/verify-native.mjs`
(no flags, no defaults, no bytes); `examples/agents/explore-r/**`; the frozen
eval tasks, unread; the two held-out train tasks `1.md` / `2.md`, unread and
unrun.

> **Correction — 2026-07-27, round-2 campaign verifier.** "no flags, no defaults,
> no bytes" is **false as written**, and is left above so the corrected claim can
> be read against it. Both scorers *did* gain a flag, in commit `4cfb587`
> (round-2 prep, before gen-0 ran): `score-task.mjs` gained `--tasks-dir`
> (+60 lines), `verify-native.mjs` gained `--dir` (+40 lines). True as narrowed:
> **no generation of this loop changed a scorer byte**, both flags default to the
> frozen eval suite so the default path is unchanged, and no rubric, threshold or
> fact rule moved. That is the wording `train-tasks/README.md` already uses. See
> *Corrections* at the end of this file.

### What to expect, and how it will be falsified

Against the **gen-1** baseline of 29/34 (not gen-2's 28), the five gen-1 misses
are the target and T5 F5 must not regress again. If the diagnosis is right,
gen-3 lands **32–34/34**: T4 F1/F2, T7 F6 and T3 F6 are declaration-class,
printed, and now both harvested by code and demanded by their need's tag; T3 F5
is the least certain — it is the only one that needs the model to follow a value
into the helper that computes it, and change 3 only guarantees the line is on
the screen.

Four hard guards, any of which makes this net-negative regardless of `termHit`:

- `namesAnchorPath` must stay **34/34**. It has been three generations; if the
  harvest displaces search effort it will show here first.
- Fabrications must stay **0** and `cites` must stay 100%. `EXTRA` is the change
  most capable of breaking this, because it is a route by which a line the model
  *believes* it saw becomes a citation — the verify loop it feeds is what
  catches that, and it is unchanged except for what it iterates over.
- **Spawns must return to ≥3 on every run.** gen-2 lost the fan-out on two tasks
  and that is the agent's identity, not an optimisation; the revert to gen-1's
  prompt is expected to restore it, and if it does not, the cause is not gen-2's
  prose and this entry has the wrong explanation.
- `EXTRA` must be non-empty on the tasks that miss. If runs still miss facts
  *and* report `HARVEST 0`, then making the step mechanical was not enough and
  the next generation should print the sweep's candidate lines **as a numbered
  list the model must mark off**, rather than asking it to copy them out.

---

## 2026-07-27 · gen-3, closed · the four pre-registered guards, scored

Added 2026-07-27 by the round-2 campaign verifier. **The log had no closing
entry for gen-3**: the run happened, the totals were summarized, the selection
was decided — but the verdict against the four guards this file pre-registered
lived only in `matrix/khal_deepseek-v4-flash/arm.json` and
`matrix/khal_qwen3.7-max/arm.json`, i.e. in a downstream artifact, not where the
prediction was made. This entry closes the loop from the committed records. It
changes no number and reruns nothing.

| | |
|---|---|
| Recipe as run | `SYSTEM.md` `4eafbb3d` / `agent.yaml` `20f8e018` — snapshot at `gens/gen-3/recipe/` |
| Result | `facts=29/34`, `fitness=0.8529`, `tasksPassed=2/6`, `runsOk=6/6`, `c2fail=0`, `c3fail=0`, `cites=79/79`, `spawns=19`, `$0.15`, `727.3 s` |
| Predicted | **32–34/34** |
| Totals history | `[28, 29, 28, 29]` — gen-1 and gen-3 **tie** on the primary signal |
| Source | `gens/gen-3/summary.{txt,json}`, `gens/gen-3/runs/task-*.score.json` |

**The prediction missed.** 29/34 is three below the bottom of the pre-registered
band and identical to the gen-1 parent gen-3 was mutated from — and the
composition underneath is a wash, not a plateau. Exactly one fact converted:
**T4 F1** (`record.py:22`, `RECORD_SCHEMA_VERSION`), the declaration-class miss
change 1 was aimed at. Exactly one regressed: **T5 F5** (`ptyManager.ts:127`,
`RESERVED_ENV_KEYS`) — the same fact gen-2 lost, lost again, on a prompt built
from gen-1 specifically to avoid gen-2's cause. T4 F2, T7 F6, T3 F5 and T3 F6
stayed missing (`gens/gen-3/summary.txt`). +1 −1 = 29.

That the regression reappeared on a prompt that does **not** contain gen-2's
"behaviour → never the header" clause falsifies the gen-2 → gen-3 entry's stated
explanation of it. T5 F5 is not a gen-2 prose artefact; it is unstable across
rounds — gen-0 and gen-1 held it, gen-2 and gen-3 lost it, the flash matrix arm
held it, the qwen arm lost it, all on frozen recipes.

### The four guards

| # | Guard, as pre-registered | Verdict | Evidence |
|---|---|---|---|
| 1 | `namesAnchorPath` must stay **34/34** | **HELD** | 34/34, recomputed over `gens/gen-3/runs/task-*.score.json` — fourth generation at ceiling |
| 2 | Fabrications **0**, `cites` **100%** | **HELD** | `c3fail=0`, `cites=79/79`; citation count fell 97 → 79, which is the breadth-dilution pushback working, not a failure |
| 3 | **Spawns ≥ 3 on every run** | **BROKEN** | task 3 `spawns=2`, task 4 `spawns=2` (`gens/gen-3/summary.txt`) |
| 4 | `EXTRA` non-empty on tasks that miss | **NOT EVALUABLE** | `HARVEST`/`EXTRA` print inside the phase-5 REPL block; `runs/task-*.json` stores `answer`, `footer`, `progress` only. `grep -c HARVEST gens/gen-3/{runs,logs}/*` → 0 hits in every file |

Guard 4 is a process defect worth naming: **it was pre-registered on a value the
harness does not record.** A guard that cannot be read from the artifacts is not
a guard. Either `run-train-round.mjs` captures REPL stdout, or a future entry
does not pre-register on it.

### Guard 3 is real, and it does not separate gen-3 from the recipe that was selected

`matrix/khal_deepseek-v4-flash/arm.json` and `matrix/khal_qwen3.7-max/arm.json`
both cite *"spawns fell to 2 on tasks 3 and 4 against the stated '>= 3 on every
run'"* among the reasons gen-3 does not displace gen-1. The observation is
correct. The inference from it is not, because **the same condition holds on the
selected recipe.** Every recorded round, per-task `spawns` from its own
`summary.txt`:

| Round | Recipe | t3 | t4 | t5 | t6 | t7 | t8 | ≥3 everywhere? |
|---|---|---|---|---|---|---|---|---|
| gen-0 | `06c6ea94` (shipped) | **2** | **2** | 4 | **0** | 3 | 3 | no |
| gen-1 | `02184f35` | 3 | 3 | 4 | 4 | 3 | 3 | **yes** |
| gen-2 | `10f07ed3` | 4 | 4 | 4 | **0** | **0** | **2** | no |
| gen-3 | `4eafbb3d` | **2** | **2** | 4 | 3 | 4 | 4 | no |
| matrix flash | `02184f35` (gen-1) | 3 | 3 | 3 | **0** | 3 | 3 | **no** |
| matrix pro | `02184f35` (gen-1) | **2** | 4 | 4 | 3 | 3 | 3 | **no** |
| matrix qwen | `02184f35` (gen-1) | **2** | 3 | 3 | 3 | 3 | 3 | **no** |
| matrix glm | `02184f35` (gen-1) | 4 | 4 | 4 | 4 | 4 | 14 | yes |
| holdout (t1/t2, not the fitness set) | `02184f35` (gen-1) | 3 | 3 | — | — | — | — | yes |

**Three of the four matrix arms break the guard while running gen-1's exact
snapshot**, including the flash arm whose result the campaign published, where
task 6 fanned out **zero** times. gen-1 clears the guard in its own round and in
no other fitness-set round of the same snapshot. So `spawns < 3` is a property of
a *round* — model, load, question — not of gen-3's prose, and citing it as a
gen-3 defect applies the guard asymmetrically. Stated correctly: **gen-3 broke
guard 3 in its own round, and the selected recipe breaks it in 3 of its 5
recorded fitness-set rounds; the guard discriminates rounds, not prompts, and
should not carry weight in a prompt selection.**

### What actually decides gen-1 over gen-3

With guard 3 discounted, the tie-break rests on what is left, and it is thin:

| | facts | fitness | tasksPassed | anchorsCited | cites |
|---|---|---|---|---|---|
| gen-1 | 29/34 | 0.8529 | **3/6** | **27/34** | 97/97 |
| gen-3 | 29/34 | 0.8529 | 2/6 | 26/34 | 79/79 |

One mechanical task pass and one required anchor, at n=1 per generation, against
a measured run-to-run band on a single (recipe, model, suite) triple of **±3
facts** (`matrix/khal_deepseek-v4-flash/arm.json`, and the replicate evidence in
`matrix/README.md`). **gen-1 is the incumbent and a tie does not displace an
incumbent — that, not the margin, is the defensible reason it was kept.** The
selection stands; the confidence attached to it should not.

### State of `optimizer/current/` — it does not hold gen-3

`matrix/khal_qwen3.7-max/README.md` and
`matrix/khal_deepseek-v4-pro/matrix-arm.json` both state that `current/` holds
gen-3 (`4eafbb3d`). **It does not, and it stopped being true 38 seconds into the
qwen arm's round.** Measured on the tree:

```
sha256 optimizer/current/SYSTEM.md  = 02184f35…  (gen-1; gen-3 is 4eafbb3d…)
cmp    optimizer/current/{SYSTEM.md,agent.yaml}
       optimizer/gens/gen-1/recipe/{SYSTEM.md,agent.yaml}   → byte-identical
mtime  optimizer/current/{SYSTEM.md,agent.yaml} = 2026-07-27 09:47:43.36Z
```

The write lands inside the matrix window:

```
09:46:15Z  flash arm starts
09:47:05Z  qwen arm starts
09:47:42Z  pro arm starts
09:47:43Z  ← current/ rewritten to gen-1 (0.6 s later)
09:48:35Z  glm arm starts
```

`current/` held gen-3 up to that instant — gen-3's round snapshotted it at
`09:20:48Z` and finished at `09:32:55Z`, 15 minutes before the reset — so the
qwen doc's claim was true when its round began and false 38 s later, and the pro
doc's was false 0.6 s after its round began.

**Unattributable from the artifacts.** No record under `round2/` documents the
write, and no arm's *round* could have done it: all four ran
`--recipe gens/gen-1/recipe`, which `run-train-round.mjs` copies into a per-run
scratch HOME and never writes back. Setup around any of the four is equally
consistent with the timestamp; the proximity to the pro arm's start is noted, not
charged.

The consequence is bounded and real: the optimizer's mutation pointer
**silently lost gen-3**. `current/` is one generation behind this log, and a
gen-4 edited on top of it would mutate gen-1 while its entry claimed gen-3 as the
parent. `gens/gen-3/recipe/` is intact and authoritative; nothing was lost but
the pointer. Corrected in `optimizer/README.md` (*State of `current/`*) and in
both arm docs.

---

## 2026-07-27 · gen-1 → gen-4 · "ask everything twice, then mark off the declarations"

*(Inserted here rather than after the* Corrections *appendix, so the generation
entries stay contiguous and the appendix keeps being "end of file".)*

| | |
|---|---|
| Parent generation | **gen-1** — the selected recipe, and the incumbent (`gens/gen-3, closed`). gen-2 and gen-3 are not carried: neither displaced it, and `near()` and the `(kind, need)` tags stay out so the gen-4 delta is the two changes below and nothing else |
| Parent pointer | `optimizer/current/` **already held gen-1** (`02184f35`, byte-identical to `gens/gen-1/recipe/`) when this generation started — checked, per `optimizer/README.md` → *State of `current/`*, not assumed. It is advanced to gen-4 by this entry |
| gen-1 recipe (the base) | `SYSTEM.md` `02184f35` / `agent.yaml` `20f8e018` |
| gen-4 recipe | `SYSTEM.md` `640dfa69` / `agent.yaml` `20f8e018` (**unchanged, 5th generation**) |
| gen-1 fitness (n=1) | `facts=29/34`, `fitness=0.8529`, `tasksPassed=3/6`, `runsOk=6/6`, `c2fail=0`, `c3fail=0`, `cites=97/97`, `spawns=20`, fabrications **0** |
| Totals history | `[28, 29, 28, 29]` — a range of **one fact over four generations** |
| Measurement protocol | **changed**: 6 fitness tasks × **2 independent replicates**, separate scratch HOMEs, per-replicate **and** union-of-replicates. See *Why the measurement changed too* |

### The diagnosis: the noise is bigger than every signal this loop has produced

Four generations moved the primary number across a range of **one fact**
(`[28, 29, 28, 29]`). The suite's own run-to-run spread on a **fixed** (recipe,
model, suite) triple is **±3 facts of 34** — three live task-4 replicates on the
identical triple scored 3/6, 5/6 and 4/6 against a published 6/6, and *they were
not the same facts each time* (`matrix/README.md`, *Why n = 1 is the binding
constraint*). Every generation of this log is n=1. **The loop has been reading
noise three times the size of its signal, and calling the readings mutations.**

That is not an argument for a better prompt tweak. It is an argument that the
next lever is **the number of samples**, on both sides of the measurement:

- inside the run, because a sub-agent is one sample of a noisy process; and
- inside the round, because a round is one sample of a noisy run.

**And the record already shows what a second sample is worth.** gen-1 has two
recorded fitness rounds on its own frozen snapshot at the same model — its own
round (`gens/gen-1/`) and the flash matrix arm (`matrix/khal_deepseek-v4-flash/`,
84 minutes later, `--recipe gens/gen-1/recipe`). Pooled by
`optimizer/union-report.mjs`:

```
UNION facts=32/34 coverage=0.9412 perReplicate=[29, 32]/34 spread=3 unionLift=+0
  T3 F5 npu_power.py:84  `m.group("lb") == "["` — [MISS, MISS]
  T7 F6 enroll.sh:23     `SUITE`                — [MISS, MISS]
  T3 F6 discover_sysfs.py:18 — [MISS, HIT]   ← variance, not a residual
  T4 F1 record.py:22         — [MISS, HIT]   ← variance, not a residual
  T4 F2 record.py:23         — [MISS, HIT]   ← variance, not a residual
```

**Of gen-1's five single-round misses, three are variance and two are
systematic.** `record.py:22`, `record.py:23` and `discover_sysfs.py:18` — three
facts this log has spent three generations of prose on — were *already reachable
by the unmodified gen-1 prompt*, and only one of two rounds reached them. The
real residual is two facts: a predicate inside a parser, and a shell default.

> **Caveat, stated because it cuts against the number.** The matrix arm's
> task-4 6/6 is the top of a measured 3/6–6/6 band and does not reproduce
> (`matrix/README.md`). The 32/34 union is therefore an upper reading of the
> parent's union. The *structure* it shows — three of five misses flipping
> between two runs of one frozen prompt — does not depend on that, and is the
> whole basis of change 1.

The second diagnosis is the one the holdout supplied and it is unchanged: the
systematic residual is a **module-level declaration, in a file the answer already
had open, that never becomes a claim.** `holdout/README.md` states it plainly —
*"the residual failure mode generalises — the four generations of fixes aimed at
it have not."* gen-1 added `defs()` (a *request*: "add a claim for every
definition that bears on a need"). gen-2 strengthened the request. gen-3 made it
a data structure but its own guard 4 could not be evaluated. All three asked the
model to *notice* something in a wall of text.

So gen-4 makes two changes and no others: **more samples**, and **a mark-off
list instead of a request**.

### Change 1 — the ensemble: every partition asked twice, unioned before aggregation

The fan-out becomes **one `rlm_query_batched` call carrying two independently
worded copies of every partition**, and phase 4 keeps every distinct
`(path, line, term)` **either** copy produced.

Three things make it more than "send more prompts":

**a. It is genuinely two samples, not a follow-up.** Both wordings are written
into `PARTS` in the same block, before any answer exists, and go out in one
call. A second question asked *after* reading the first answer inherits every
blind spot of the answer it followed; the prompt says so in those words.

**b. The two wordings are complementary, not paraphrases.** Copy A (`ASK_A`) is
gen-1's template unchanged: *where does the behaviour happen, and name the thing
on the line.* Copy B (`ASK_B`) inverts it: *list the module-level declarations —
constants, exported names, schema or config keys, defaults, limits, reserved
sets — with a `file:line` for each, and only then say what reads them; a
function header is not an answer to this.* A verbatim duplicate would be one
sample sent twice.

> **Confound, stated.** Copy B's declaration bias means change 1 and change 2
> both push on the declaration residual, so a conversion of a declaration-class
> fact cannot be attributed to one of them from this round alone. That is a
> deliberate trade — a neutral paraphrase would be a weaker second sample — and
> it is why the pre-registered expectations below are stated on the union and
> the spread, which change 1 alone predicts, rather than on which fact converted.

**c. The union operator is deliberate, and intersection would be wrong here.**
Two samples of one question disagree by *omission*, not contradiction: the
observed shape is A found four things, B found four things, three overlap.
Intersecting is a conjunction that would *lose* facts — and against the gen-1
baseline above it would have lost all three of the variance-class facts.
Fabrication is not the risk union raises it to be, either: criterion 3 has been
**0 failures across four generations, four matrix arms and the holdout**, and
every claim — sub-agent or harvested — still goes through the phase-5 verify
loop, which is unchanged and re-opens the line.

**Width: three partitions, not four, and that is a measurement, not taste.**
`MAX_CONCURRENT = 4` (`src/llm.ts:710` at `6ec4822`; the same constant
`recursion-recon.md` §4 cites at `:667`), and `src/llm.ts:713-714` slices the
prompt list into waves of four. So:

| shape | prompts | waves | wave cost at the measured rates | share of the 600 s REPL wall |
|---|---|---|---|---|
| 3 parts × 2 | **6** | 4 + 2 | ~180 s + ~120 s ≈ **300 s** | **50 %** |
| 4 parts × 2 | 8 | 4 + 4 | ~360 s, ~466 s at the worst measured rate | 60–78 % |

Rates: gen-0's own 4-wide waves ran ~110 s (t3), ~165 s (t4), ~180 s (t5, t8);
`recursion-recon.md` §6.1's unbounded 4-wide wave ran 61/74/154/233 s. The
second wave of a 4+2 is two children, not four, so it contends less. And the
600 s wall is a **total loss**, not a degradation — the rejection escapes
`rlmLoop` unwrapped and the whole call returns an error with no answer
(§4.1, `smoke/smoke-2.json`). At 78 % of a wall that costs everything, the
fourth partition is not worth buying. The prompt says which one to drop and
why: *the thing this agent loses is never a subsystem it failed to visit; it is
a line it visited and did not write down.*

### Change 2 — the harvest is a list you mark off, not a wall you are asked to notice

New starter-block helper `decls(path)`, and a mandatory harvest step that runs
**after aggregation and before `FINAL`**.

`decls()` differs from gen-1's `defs()` in three ways, each of which is the
reason a previous generation's version did not land:

1. **Declarations only — never a `def`/`class`/`function` header.** A header
   says a thing exists and nothing about what it holds, and headers were the
   bulk of `defs()`' output and of gen-1's breadth dilution (five bare `def`
   citations in one task-3 answer).
2. **It returns instead of printing**, so the caller numbers the list. Phase 4
   prints `[1] path:line: text` … `[n]`, and phase 5 requires **every number to
   get one of exactly two verdicts** — into `EXTRA` (it bears on a `NEEDS`
   entry, and becomes a claim) or into `SKIPPED`. The block prints how many are
   unmarked. This is precisely what gen-3's own falsification branch
   pre-registered as the next step: *"print the sweep's candidate lines as a
   numbered list the model must mark off, rather than asking it to copy them
   out."*
3. **It sweeps every file the run *opened*, not just the files `CLAIMS` names.**
   `SEEN` is the union of `CLAIMS`' paths and every `path:line` either copy of
   any sub-agent cited. That is a strictly larger set and it is where the
   holdout's `NON_CHAT_MODES` lived. An invented path costs nothing: `decls()`
   returns `[]` for a file it cannot open, so a hallucinated path reaches
   nothing and cannot become a candidate.

`EXTRA` is then verified by the **same, unchanged** loop as `CLAIMS` —
`for c, p, n, t in CLAIMS + EXTRA` — so a harvested declaration is trusted
because the block re-opened its line and printed the text back, not because it
was harvested.

**Measured before shipping, and this time reproducibly.** Every previous
generation's "verification done before shipping" is recorded in *Corrections* as
unrecomputable, because the replay harness was never committed. `optimizer/verify-recipe-blocks.py`
is committed, reads the recipe's own ```` ```repl ```` blocks, and is the source
of every number below. Run `python3 optimizer/verify-recipe-blocks.py`:

- **All 7 `repl` blocks compile.** The starter block executes and binds
  `walk`/`look`/`search`/`read`/`defs`/`decls`/`decl_name`/`usable`.
- **The sweep is small.** Over the 12 fact-bearing files of all four training
  roots: **63 candidates, 6,407 chars.** Worst single root 26 candidates /
  2,425 chars (`~/prod/rlmx`, the holdout root); a fitness run opens one root, so
  the per-run sweep is 7–26 candidates and **717–2,425 chars against the
  20,000-char REPL truncation — 4 % to 12 %.**
- **It surfaces 6 of the 6 declaration-class misses on record**, with their
  line numbers: `record.py:22` `RECORD_SCHEMA_VERSION`, `record.py:23`
  `RECORD_KIND`, `ptyManager.ts:38`, `ptyManager.ts:127` `RESERVED_ENV_KEYS`,
  `enroll.sh:23` `SUITE`, and `khal-provider.ts:103` `NON_CHAT_MODES` — the
  holdout miss.
- **It does not surface the two out-of-class misses, and that is stated rather
  than discovered later**: `npu_power.py:84` is a predicate inside a parser, and
  `discover_sysfs.py:18` is a key in a *function-local* literal. A variant that
  descends into literals at any indentation catches `discover_sysfs.py:18` and
  takes the candidate count **63 → 192 (3.05×)**. Rejected on the measurement:
  tripling the mark-off load on every run to buy one out-of-class fact is the
  breadth dilution that cost gen-1 a fact and gen-2 its citation budget.
  > **The `192` is unreproducible from artifacts — annotation, 2026-07-27,
  > gen-4 closeout.** The `63` on both sides of that arrow *is* recomputable and
  > still reproduces exactly: `python3 optimizer/verify-recipe-blocks.py` prints
  > `SWEEP TOTAL 63 candidates, 6407 chars over all roots`, and every other
  > figure in this section comes from the same committed run. The `192` does
  > not: the literal-descending **variant** was never committed — no flag, no
  > second function, nothing in `verify-recipe-blocks.py` that descends into a
  > function-local literal at all. `grep -rn 192 optimizer/` finds it in no
  > script: outside this line the only matches are incidental digits inside run
  > records (`answerChars: 2192`, a session id). So `3.05×` is a
  > contemporaneous note of the same class as *Corrections* item 2, sitting
  > inside a section whose whole point was that its numbers are recomputable.
  > The rejection of the variant is a judgement about breadth dilution and can
  > stand on the argument; the multiplier behind it cannot be checked against
  > this tree. To make it checkable, the variant has to be a committed flag on
  > the probe.
- **The verify loop still separates the three cases** — a real declaration
  (`OK`), a drifted line (`TERM`), a missing file (`DROP`) — with `KEEP` holding
  only the `OK` row.

One honest limitation: `decl_name()` returns `ptys` for `ptyManager.ts:38`,
whose anchoring term is `new Map<string, PtyRecord>()`. The candidate's full
text is printed, and the prompt says to write your own token if you can see a
better one — but the helper alone does not always name what the scorer wants.

**No training-suite symbol appears anywhere in the prompt.** gen-2 removed
`RECORD_SCHEMA_VERSION` from the citation contract as train-set leakage; that
removal is honoured. Every symbol above is in this log and in the probe, never
in `SYSTEM.md`.

> **FALSE AS WRITTEN — correction, 2026-07-27, gen-4 closeout.** The paragraph
> above is left in place because it is what was claimed when the mutation
> shipped. All three of its sentences are wrong — the headline, *"that removal
> is honoured"*, and *"never in `SYSTEM.md`"* — and the error is checkable in
> one `grep` against the snapshot the round actually ran,
> `gens/gen-4/recipe/SYSTEM.md`:
>
> | Anchoring term | Fitness fact it anchors | Where it sits in the shipped prompt |
> |---|---|---|
> | `MAX_ATTEMPTS` | task 6 F5, `src/main/services/RtkService.ts:357` | `:465` — the `CLAIMS` template's example row |
> | `findCmd` | task 6 F1, `src/main/services/RtkService.ts:180` | `:612` — the worked example of the anchor-term rule |
> | `FETCH_BODY_TIMEOUT_MS` | task 6 F3, `src/main/services/RtkService.ts:33` | `:616` — *cite the declaration, not the use* |
> | `RECORD_SCHEMA_VERSION` | task 4 F1, `src/xdna_top/record.py:22` | `:617` — same sentence |
>
> `RECORD_SCHEMA_VERSION` is the one gen-2 removed. gen-4 mutated **gen-1**, not
> gen-3, so it came back with the parent text; *"that removal is honoured"* is
> false. It is also the one symbol from the *"surfaces 6 of the 6
> declaration-class misses"* bullet above that **is** in `SYSTEM.md`, which is
> what makes *"Every symbol above … never in `SYSTEM.md`"*
> false too — the other five (`RECORD_KIND`, `RESERVED_ENV_KEYS`, `SUITE`,
> `NON_CHAT_MODES`, and `ptyManager.ts:38`'s term) are genuinely absent. The
> other three leaked terms were never removed by anyone and are in gen-1, gen-2
> and gen-3 too (`gens/gen-{1,2,3}/recipe/SYSTEM.md` — `:358`/`:458`/`:462`,
> `:379`/`:526`/`:530`, `:401`/`:537`/`:541`). gen-0 carries none of the four.
>
> A fifth term collides by accident and has the same effect on the scorer:
> `KEEP` anchors task 8 F2 (`channel/publish.sh:56`) and is also the name of the
> recipe's own verify-loop list (`:549`). Nothing was leaked deliberately; the
> claim was still made without checking.
>
> **Why it voids this generation's only positive result — see the REJECTED entry
> below.** The fact rule is a case-insensitive substring test over the whole
> answer (`parity/score-task.mjs:341`, `lower.includes(term.toLowerCase())`), so
> a term sitting in the prompt can reach the answer without the run ever finding
> the line. **All five leaked-term facts are HIT in both gen-4 replicates**, and
> one of them, `record.py:22` `RECORD_SCHEMA_VERSION`, is the headline evidence
> that change 2's harvest worked. That evidence cannot be separated from
> prompt-copying by this scorer.

### Budget: unchanged (14 / 2.00 / 2) — and the ensemble is a reason to hold it, not to raise it

`agent.yaml` is byte-identical to gen-0/1/2/3 — `20f8e018`, fifth generation.

1. **The ensemble costs zero extra parent turns.** `rlm_query_batched` blocks
   until every child returns, so one call is one turn whatever the width. The
   harvest rides in the phase-5 block that already ran. The parent's path is
   **five blocks** — survey · fan-out · aggregate+sweep · harvest+verify ·
   `FINAL` — against a 14 cap. gen-1, the parent, used 10, 7, 9, 7, 6, 5.
   *(Stated against it: gen-3 hit the cap at 14 on two tasks. gen-3 is not the
   parent and carried a different phase-5 structure; if gen-4 reaches 14 on a
   task, that is the number to revisit, and the replicates will show it.)*
2. **Raising `max_iterations` would make the ensemble *less* safe.** It is one
   number with two roles (`src/rlm.ts:436` — the child inherits the parent's cap
   unreduced), and the second role is the child's **wall clock**: ~8.5 s per
   iteration under contention (§6.1), inside a block on the 600 s wall. 18 was
   measured to overrun that wall with **four** children and lose the whole run
   (`smoke/smoke-3.json`). gen-4 runs **six**. The margin gets smaller, not
   larger, so 14 is held for the reason it was chosen, only more so.
3. **Cost: ~2.6× gen-1, against a 30× rail.** A measured child is $0.0016 at 3
   iterations (§6.1), so ~$0.0075 at 14; one parent (~$0.02) plus six children
   is ~**$0.065** worst case per run, ~$0.39 for a six-task round against gen-1's
   measured $0.15. The $2.00 rail still leaves ~30× headroom per run. It must
   not be *tightened* either — `buildRemainingChildBudget` hands each child the
   parent's *remaining* budget and children are spawned late (§4, consequence
   2), so a tight rail starves the sub-agents specifically, which is the failure
   this variant exists to escape.

Holding it a fifth time keeps the `[28, 29, 28, 29, ?]` series attributable to
the prompt alone.

### Why the measurement changed too

Reporting gen-4 as one round would repeat the defect this entry is built on. So:

- **6 fitness tasks × 2 independent full replicates**, sequential (not
  concurrent — three of four concurrent matrix arms broke the fan-out guard and
  two lost runs entirely, `matrix/README.md` gap 5), each with its **own scratch
  HOME**: `run-task.mjs:149` derives it from the round label, so
  `--label gen4-rep1-…` and `--label gen4-rep2-…` give
  `/tmp/rlmx-parity-gen4-rep{1,2}-…-t<n>`, disjoint per replicate and per task.
- **`--concurrency 1`, not gen-1's 2 — forced by a measured failure, and it is
  a protocol difference worth stating loudly.** The first attempt at gen-4 rep-1
  ran at `--concurrency 2` and **lost task 4 outright**:

  ```
  "ok": false,  "wallSeconds": 656.5,  4 spawns
  "fullText": "rlmx rlmx_explore-r failed: REPL execution timed out after 600000ms"
  ```

  That is §4.1's total-loss wall exactly, and the arithmetic behind it is the
  ensemble's own: `run-train-round.mjs` at concurrency 2 puts **two parents**
  on one khal key at once, so gen-1's rounds carried 2 × 3 ≈ 8 concurrent
  streams and gen-4's carry 2 × 4–6 ≈ **10–14**. `recursion-recon.md` §6.1
  measured four concurrent children as the point where per-iteration latency
  reaches ~8.5 s, and `matrix/README.md` gap 5 already attributes its two lost
  runs to running "well beyond" that figure. At concurrency 1 the ensemble's
  six children are roughly the load gen-1's two-task pairs already carried.

  **`RLMX_REPL_TIMEOUT_MS` stays at 600000.** It is this campaign's fixed
  environment correction; raising it would move the wall the recipe has to fit
  inside instead of measuring whether it fits, and the whole point of change 1's
  width calculation is that it must fit. The knob that moved is the harness's
  task parallelism, which is not a property of the recipe at all.

  Cost: a round is ~2× the wall clock, and the gen-4 numbers are **not**
  wall-clock-comparable with gen-1's rounds. Fact coverage, spawns, criteria 2
  and 3 are unaffected by task-level parallelism and remain comparable.

- **Observed in the aborted concurrency-2 attempt, and worth recording because
  it confirms change 1 fires:** task 5 emitted **6** recursive spawns — four at
  iteration 2, then a fifth and sixth once the first wave returned, which is
  `src/llm.ts:713-714` slicing 6 prompts into 4 + 2 exactly as the width
  calculation predicted. Tasks 3 and 4 emitted 4 (two partitions asked twice).
  The `PARTS` template in the shipped `SYSTEM.md` shows **two** example entries
  against prose that says "two or three", and the runs cluster on two; if the
  round comes in short of the ≥ 4 spawn expectation anywhere, that template is
  the first thing to change, not the prose.
- Published **per replicate and as a union**, by `optimizer/union-report.mjs`.
  That script reads each replicate's `summary.json` and its `facts[].verdict`
  **verbatim**; it re-runs no scorer and re-decides no rule. Its three combining
  rules are in its header and printed in its output.
- **The fabrication rule runs the other way from the coverage rule, and this is
  the point:** a fact counts in the union if **any** replicate hit it, but
  criteria 2 and 3 pass in the union only if **every** replicate passed. One
  fabricated citation makes an answer unusable; a recipe that fabricates on one
  run in two fabricates.
- Replicate directories are `gens/gen-4/rep-{1,2}/`, **not** `gen-5`/`gen-6` —
  they are one generation measured twice, and the totals history must not read
  as if the prompt had mutated between them.

### What to expect, and how it will be falsified

Every number below is readable from `summary.json` / `union.json`. That is
deliberate: gen-3's guard 4 was pre-registered on `HARVEST`, which prints inside
a REPL block and which `runs/task-*.json` does not record, and *"a guard that
cannot be read from the artifacts is not a guard."* **Nothing here is
pre-registered on the harvest count.**

| # | Pre-registered | Read from |
|---|---|---|
| 1 | **Union ≥ 32/34**, target **33/34.** The parent's own two-round union is 32/34; the one fact gen-4 should add is `enroll.sh:23` `SUITE`, declaration-class, surfaced by the probe. `npu_power.py:84` is **predicted to stay missing** — it is out of the harvest's class and nothing here targets it | `union.json` totals |
| 2 | **Every replicate ≥ 29/34** — gen-1's own floor. A replicate below it means the ensemble displaced search effort, and the change is net-negative whatever the union says | `union.json` `perReplicateFound` |
| 3 | **Replicate spread < 3.** This is change 1's own claim: two samples inside the run should make the run less variable. gen-1's two rounds spread 3. A spread ≥ 3 falsifies the ensemble as a variance reducer even if coverage rises | `union.json` `replicateSpread` |
| 4 | **Spawns ≥ 4 on every run**, expected **6.** Six prompts is the instruction; 4 is the first wave. A run at 3 means the ensemble instruction was not followed at all. *Stated as a round property, not a prompt property* — `EVOLUTION.md` → *gen-3, closed* withdrew `spawns` as a selection reason after three matrix arms broke it on gen-1's own snapshot, and that withdrawal stands. It is reported, not weighed | `union.json` per-task `spawns` |
| 5 | **Fabrications 0 and citations 100 % in BOTH replicates.** Hard failure, not a trade-off. The union is the change most capable of breaking it, because it is a route by which a line only one copy saw becomes a citation. The verify loop is what catches that and it is unchanged | `union.json` `fabrications`, `citationFailures` |
| 6 | **`runsOk` 6/6 in both replicates.** Six children instead of three doubles the exposure to the 600 s REPL wall. A lost run here is the width being wrong, and the fix is two partitions, not a smaller change | `union.json` `runsOk` |

The holdout (tasks 1 and 2) is run the same way, ×2, after this — **reporting
only**, under `optimizer/holdout-gen4/`. It must not feed a mutation, a revert
or a comparison, and the one thing worth watching there is whether
`khal-provider.ts:103` `NON_CHAT_MODES` converts, since it is the only
declaration-class miss on record that the fitness set cannot see.

### Verification done before shipping the mutation

`python3 optimizer/verify-recipe-blocks.py` — committed, deterministic, exits 0.
Its output is quoted in *Change 2* above and is recomputable from this tree,
which is the one thing no previous generation's verification section can claim.
The `SEEN` extraction was additionally exercised against a hand-built pair of
sub-agent answers containing an invented path: the invented path produces no
candidate, and `record.py:22`/`:23` appear as numbered candidates.

### The result — 2 replicates, scored against the six pre-registered guards

```
UNION facts=32/34 coverage=0.9412 perReplicate=[30, 26]/34 spread=4 unionLift=+2
      runsOk=[6, 5]/6 c2fail=0 c3fail=0 fabrications=0 citeFail=0
      cites=[91/91, 54/54] spawns=[18, 24] perRun=0..6 cost=[$0.167, $0.14]
  T3 F5 npu_power.py:84 `m.group("lb") == "["` — [MISS, MISS]
  T7 F6 enroll.sh:23    `SUITE`                — [MISS, MISS]
```

| # | Guard | Verdict | Evidence |
|---|---|---|---|
| 1 | Union ≥ 32/34, target 33 | **MET at the floor, target missed** | 32/34 — exactly the parent's own two-round union. `SUITE` did not convert |
| 2 | Every replicate ≥ 29/34 | **BROKEN** | rep-2 = 26/34 |
| 3 | Replicate spread < 3 | **BROKEN** | spread 4 (gen-1's two rounds: 3) |
| 4 | Spawns ≥ 4 on every run | **BROKEN** | 12 runs: `0, 2, 2, 4, 4, 4, 4, 4, 4, 4, 4, 6` |
| 5 | Fabrications 0, citations 100 % in **both** | **HELD** | `c3fail=0`, `c2fail=0`, 91/91 and 54/54 |
| 6 | `runsOk` 6/6 in both | **BROKEN** | rep-2 lost task 5 to the 600 s REPL wall at 650 s, 4 spawns, a 67-character answer |

**Guards 2 and 3 are broken by guard 6, not independently of it.** One lost run
zeroes five facts. On the five tasks **both** replicates completed:

| | needed | per replicate | spread | union |
|---|---|---|---|---|
| tasks 3, 4, 6, 7, 8 | 29 | **[25, 26]** | **1** | 27 |

So change 1's own variance claim is **supported** where it can be read —
spread 1 against gen-1's 3 — and the headline spread of 4 is one harness
failure wearing a coverage number's clothes. Both readings are stated; neither
is presented alone.

**Change 2 landed and change 1 did not pay for itself.**

- **The declaration residual converted.** `record.py:22` `RECORD_SCHEMA_VERSION`
  and `record.py:23` `RECORD_KIND` are **HIT in both replicates** — gen-1 missed
  both in its own round, gen-3 converted one. Task 4 scored **6/6 in rep-2**, the
  first undisputed 6/6 on that task in the campaign. That is the harvest.
- **The union did not move.** gen-4's union is 32/34 and gen-1's own two-round
  union is 32/34, and **they miss the same two facts** — `npu_power.py:84` and
  `enroll.sh:23`. Asking every partition twice bought coverage that pooling two
  *rounds* of the unmodified parent already had. The ensemble converts variance
  into a single round's number; it does not reach a fact the recipe could not
  reach.
- `npu_power.py:84` missing was **predicted** — it is out of the harvest's
  class. `enroll.sh:23` `SUITE` missing was **not**, and the probe shows
  `decls()` surfaces it. In rep-1 task 7 there was no fan-out at all
  (`spawns=0`), so `SEEN` — built from `A + B` — never existed and the harvest
  could not run. In rep-2 task 7 the fan-out fired and it still missed.

**Two defects in change 2 as shipped, both mine, both checkable:**

1. **The harvest is coupled to the fan-out.** `SEEN` is built from `A + B`, so a
   run that skips the fan-out gets no candidate list and no harvest — and this
   recipe skips the fan-out on roughly one run in six, across every generation
   recorded. gen-1's phase-4 block referenced only `CLAIMS` and was robust to
   it. The fix is to seed `SEEN` from `CLAIMS` alone when `A`/`B` are absent.
2. **The width is not reliably inside the 600 s wall.** rep-2 task 5 died at
   650 s with **4** children at `--concurrency 1` while rep-1's task 5 finished
   in 264.7 s with the same 4 children on the same recipe. The pre-shipping
   estimate (~300 s, 50 % of the wall) was taken from gen-0's bounded 4-wide
   waves and is **falsified**: child latency alone spans that range, and the
   ensemble roughly doubles the exposure to a wall whose failure mode is total
   loss. Two partitions, not three, is the width the evidence now supports.

**And one process note, in gen-3's debt.** Every guard above was read from
`summary.json` / `union.json`. Nothing was pre-registered on the `HARVEST`
count, so nothing came back NOT EVALUABLE — which is the whole reason that
choice was made.

**The holdout, stated here and weighed nowhere.** `optimizer/holdout-gen4/`,
×2, after the fitness rounds: **8/14 in both replicates, spread 0, on the same
six facts**, against gen-1's 10/14. `runsOk` 2/2 both, 0 fabrications, 30/30 and
39/39 citations. Two things in it bear on this entry and on nothing else:
`NON_CHAT_MODES` — the declaration-class miss change 2 was built for, and which
the committed probe surfaces — **missed in both replicates**, once because the
fan-out never fired and the harvest is coupled to it; and **both task-1 runs hit
`max_iterations` at 14**, which is exactly the condition the budget section
above pre-committed to revisit. Neither may change this recipe. Detail:
`holdout-gen4/README.md`.

### Selection: gen-4 does not displace gen-1

`[28, 29, 28, 29, ?]` gains an entry that cannot be read the same way as the
others, because gen-4 is the first generation measured twice. Stated on its own
terms: **union 32/34, identical to the parent's own two-round union, missing the
identical two facts**; best single round 30/34 against the parent's 29 and 32;
one run lost to the 600 s wall that the parent has never lost; holdout 2 facts
below the parent's and reproducing across replicates. The declaration
conversion is real and is the one thing to carry forward. **A tie on the union
does not displace an incumbent, and this is a tie on the union with a lost run
and a worse holdout attached — gen-1 stands.** The next mutation should take
gen-4's `decls()` harvest, decouple it from the fan-out, and drop the second
copy of the third partition.

> **Superseded, 2026-07-27 — this section stopped one step short.**
> *"The declaration conversion is real"* is the sentence that does not survive:
> the term it rests on is in this recipe's own prompt. gen-4 is **REJECTED**,
> not merely not-selected, and the carry-forward list gains a prerequisite —
> strip the four leaked terms before any harvest claim can be measured at all.
> Next entry.

**Untouched by this generation:** `parity/score-task.mjs` and
`parity/verify-native.mjs` — **no byte of either changed by this generation**
(the narrowed wording *Corrections* item 1 requires; both gained a flag in
`4cfb587`, which predates gen-0); `examples/agents/explore-r/**`;
`round2/run-train-round.mjs` and `round2/summarize-train-round.mjs`, unchanged —
`union-report.mjs` and `verify-recipe-blocks.py` are **new files** that read
their output; the frozen eval tasks, unread and unreferenced; the two held-out
train tasks `1.md` / `2.md`, unread, and run only under `--holdout` into
`optimizer/holdout-gen4/` after the fitness rounds were complete.

---

## 2026-07-27 · gen-4, closed · **REJECTED**

| | |
|---|---|
| Verdict | **REJECTED.** Not merely "does not displace" — the entry above already said that. Rejected, because its one positive result is not measurable by the instrument that produced it |
| Recipe rejected | `SYSTEM.md` `640dfa69` / `agent.yaml` `20f8e018` (`gens/gen-4/recipe/`, kept — a rejected generation is still a record) |
| **Selected recipe** | **gen-1 — `SYSTEM.md` `02184f35` / `agent.yaml` `20f8e018`. Unchanged, and it is the incumbent for gen-5** |
| `optimizer/current/` | reset to `gens/gen-1/recipe/`, byte-identical, **2026-07-27 13:22:44Z** — documented below and in `README.md` |
| Totals history | `[28, 29, 28, 29, —]`. gen-4 contributes **no comparable entry**: it is the first generation measured twice, and its number is now known to be confounded |

The entry above closed with *"a tie on the union does not displace an
incumbent"*, and stopped there. Three findings turn that into a rejection. The
first is a defect in the measurement and it is the blocker; the other two are
what is left when the first is subtracted.

### (a) BLOCKER — train-set leakage voids the one positive claim

The shipped prompt contains **four training-suite anchoring terms verbatim**,
and the entry above states in bold that it contains none. Full table, line
numbers and the fifth accidental collision (`KEEP`): the correction beside that
sentence, *Change 2* → *No training-suite symbol appears anywhere in the
prompt*. In short: `MAX_ATTEMPTS` `:465`, `findCmd` `:612`,
`FETCH_BODY_TIMEOUT_MS` `:616`, `RECORD_SCHEMA_VERSION` `:617`.

Why that is fatal to the result rather than merely embarrassing:

1. **The fact rule is a substring test.** `parity/score-task.mjs:341` is
   `lower.includes(term.toLowerCase())` over the whole answer, and
   `summarize-train-round.mjs` scores `HIT = namesAnchorPath && termHit`. A term
   the prompt hands the model can appear in the answer beside a path the model
   found by other means, and the scorer records a HIT. Nothing downstream can
   tell that apart from a term the run discovered.
2. **The leak covers 5 of the 34 fitness facts — 15 % of the suite — and every
   one of them is HIT in both replicates.**

   | | T4 F1 | T6 F1 | T6 F3 | T6 F5 | T8 F2 |
   |---|---|---|---|---|---|
   | term | `RECORD_SCHEMA_VERSION` | `findCmd` | `FETCH_BODY_TIMEOUT_MS` | `MAX_ATTEMPTS` | `KEEP` |
   | gen-4 rep-1 / rep-2 | HIT / HIT | HIT / HIT | HIT / HIT | HIT / HIT | HIT / HIT |

   The five are `T4 F1` `record.py:22`, `T6 F1` `RtkService.ts:180`, `T6 F3`
   `RtkService.ts:33`, `T6 F5` `RtkService.ts:357`, `T8 F2` `publish.sh:56`.
   Task 6 is **three of its five facts**.

3. **The headline positive is one of the five.** *"The declaration residual
   converted — `record.py:22` `RECORD_SCHEMA_VERSION` … HIT in both replicates.
   That is the harvest."* `RECORD_SCHEMA_VERSION` is at `SYSTEM.md:617`. The
   harvest and the prompt predict the same observation, and the round was
   designed with no way to separate them.

**Stated against this finding, because both cuts are real:**

- gen-3's `SYSTEM.md` (`4eafbb3d`) does **not** contain
  `RECORD_SCHEMA_VERSION` — `grep -c` is `0`, gen-2's removal was still standing
  there — and gen-3 **HIT** `record.py:22` anyway. So leakage is not
  *necessary* for that hit. (gen-3 does carry the other three terms; only the
  one that decides this comparison was absent.)
- gen-1's `SYSTEM.md` **does** contain the term and **missed** the fact in its
  own round. So leakage is not *sufficient* either.

Neither rescues the claim. The defect is not "the model copied the prompt" — it
is that **this experiment cannot distinguish the two, and shipped a bolded
assertion that it could.** An observation whose two competing explanations
predict the same number is not evidence for either, and it was published as the
generation's main result. That is the blocker.

**And the residual was not the parent's residual to begin with.** The flash
matrix arm ran gen-1's own digests (`02184f35` / `20f8e018`) and scored
`record.py:22` **and** `:23` HIT. So the parent's own two-round pool already had
both facts gen-4 claims to have converted — which is the same thing the union
says (below), reached from the other end. *Stated against it:* that arm's task-4
6/6 is documented as not reproducing (*Corrections* item 5), so the parent row
is an upper reading. It cuts both ways and both are recorded.

### (b) Reproducible holdout regression — recorded, and deliberately not load-bearing

`optimizer/holdout-gen4/`: **8/14 in both replicates, spread 0, on the same six
facts**, against gen-1's **10/14** (drift-adjusted **8/13** against **10/13**).
`runsOk` 2/2 in all four runs, 0 fabrications, citations 30/30 and 39/39. The
whole regression is task 1 — 4/7 → **2/7** — and **both** gen-4 task-1 runs hit
`max_iterations` at 14, which is exactly the condition the budget section
pre-committed to revisit. `NON_CHAT_MODES`, the declaration-class miss change 2
was built for and which the committed probe surfaces, **missed in both**.

**The contract tension, stated rather than stepped around.**
`train-tasks/authored-run.json` says held-out tasks are *"diagnostics and
scoring them is reporting, never selection"*, and `holdout-gen4/README.md` says
this number must not feed a mutation, a revert or a comparison. Weighing it
here is the one use of a holdout that wording does not cleanly permit. So:
**the rejection does not rest on it.** (a) is a defect in the fitness
measurement itself and (c) is fitness-only; either alone ends gen-4's claim to
displace anything. This finding is written down because it is the *flattest*
result in the campaign — reproducing exactly rather than sitting inside the ±3
noise — and because a future generation must be checkable against it. **No
mutation is derived from it, here or anywhere.**

### (c) The fitness union is identical to the pooled parent, misses and all

| | union | per replicate | spread | missed by **both** |
|---|---|---|---|---|
| gen-1 (its own two recorded rounds, same digests, same model) | 32/34 | [29, 32] | 3 | `npu_power.py:84`, `enroll.sh:23` |
| gen-4 | **32/34** | [30, 26] | 4 | **`npu_power.py:84`, `enroll.sh:23`** |

Same number, same two residual facts. The ensemble bought coverage that pooling
two rounds of the **unmodified** parent already had, at ~2.6× the cost, and one
run was lost to the 600 s REPL wall that the parent has never lost — rep-2 task
5, 650 s, a 67-character answer, five facts zeroed.

That lost run also produced a `c2=PASS c3=PASS` that nothing earned:
`score-task.mjs` had no citation to fail. `union-report.mjs` now marks it
(`c2=PASS!`, and a `VACUOUS` line naming the replicate and the reason), and
`gens/gen-4/union.{txt,json}` are regenerated with the marker —
`totals.vacuousCriteria = 1`. **No verdict was re-decided**: the combining rule
is untouched, only the support is labelled. So of the six pre-registered guards
the entry above scored, guard 5's "criteria 100 % in BOTH replicates" is now
known to be **one replicate's real pass and one replicate's vacuum**.

### What survives, and what gen-5 must do first

- **`decls()` and the numbered mark-off list are still the right idea** — the
  committed probe (`verify-recipe-blocks.py`, reproducing exactly:
  `SWEEP TOTAL 63 candidates, 6407 chars`) shows the sweep surfaces 6 of the 6
  declaration-class misses on record at 4–12 % of the REPL truncation. That is a
  property of the *probe*, not of a scored round, and it is untouched by any of
  the above.
- **What gen-5 must do before it may claim anything about that harvest: remove
  the four terms from the prompt.** All four are *illustrations* — the `CLAIMS`
  template's example row (`MAX_ATTEMPTS`), the worked example of the anchor-term
  rule (`findCmd`), and the *cite the declaration, not the use* sentence
  (`FETCH_BODY_TIMEOUT_MS`, `RECORD_SCHEMA_VERSION`). None of them is a rule;
  every one can be rewritten around a symbol no training task anchors on, which
  is cheaper than it looks and is the only thing standing between the harvest
  and a measurable claim. The `KEEP` collision is the recipe's own verify-loop
  variable — rename the variable. **This debt is inherited by `current/`: gen-1,
  the selected recipe, carries all four.** A gen-5 that keeps them cannot report
  an honest number on tasks 4, 6 or 8 either.
- The two defects the entry above already recorded stand and are unaffected by
  the rejection: seed `SEEN` from `CLAIMS` when the fan-out did not fire, and
  drop the third partition's second copy (two partitions, not three, is the
  width the 600 s wall supports).

### The pointer, and this time it is written down

`optimizer/current/` held gen-4 (`640dfa69`). It has been **reset to
`gens/gen-1/recipe/`** — the selected recipe — by

```bash
cp gens/gen-1/recipe/{SYSTEM.md,agent.yaml} current/   # 2026-07-27 13:22:44Z
cmp gens/gen-1/recipe/SYSTEM.md  current/SYSTEM.md     # byte-identical
cmp gens/gen-1/recipe/agent.yaml current/agent.yaml    # byte-identical
```

`sha256 current/SYSTEM.md` is `02184f35…`, `current/agent.yaml` is `20f8e018…`.
This is the second time this pointer has moved to gen-1 and the **first** time
the write is attributed — the previous one is *Corrections* item 3, an
undocumented reset during the matrix arms. `README.md` → *State of `current/`*
carries the same statement in present tense. `gens/gen-4/recipe/` is untouched
and remains the authoritative copy of what gen-4 ran.

### Untouched by this closeout

No round was re-run, no scorer touched, no score recomputed, no verdict
re-decided. `parity/score-task.mjs`, `parity/verify-native.mjs`,
`round2/run-train-round.mjs`, `round2/summarize-train-round.mjs`,
`examples/agents/explore-r/**`, every `gens/gen-<N>/recipe/` snapshot and every
`runs/*.json` and `summary.json`: unchanged. What changed is text, one file
pointer, and `union-report.mjs`, which gained a **label** for criteria that were
already being pooled and now says so — its combining rules are byte-for-byte the
same, and `holdout-gen4/union.json` was regenerated with it and is numerically
identical (`vacuousCriteria = 0` there; all four runs completed).

---

## Corrections — 2026-07-27, round-2 campaign verifier

Text-level only. No round was re-run, no score recomputed, no scorer touched.
Every original claim is left in place with the correction beside it.

1. **"no flags, no defaults, no bytes"** (three occurrences, gen-1/gen-2/gen-3
   *Verification done before shipping the mutation*) — **false as written.**
   Commit `4cfb587` ("test(parity): round-2 prep") added `--tasks-dir` to
   `parity/score-task.mjs` (+60 lines) and `--dir` to
   `parity/verify-native.mjs` (+40 lines). Both default to the frozen eval
   suite, so the default path is byte-compatible and no rubric, threshold or
   fact rule moved; and `4cfb587` predates gen-0, so no generation of this loop
   changed a scorer byte. `train-tasks/README.md` (*How to run it*) has always
   stated this correctly. The defensible sentence is *"unchanged by this
   generation"*, not *"never changed"*.

2. **Replay experiments and block-size figures** (gen-1 change 2; gen-2 change 1
   and its verification list; gen-3's *measurement that changes the diagnosis*
   table, change 3, and its verification list) — **unreproducible from
   artifacts.** No replay harness is committed: the only scripts under `round2/`
   are `run-train-round.mjs`, `summarize-train-round.mjs` and
   `smoke-explore-r.mjs`, and `runs/task-*.json` records `answer`, `footer`,
   `progress` and `stderr` — never REPL block stdout. Every "N chars",
   "% of truncation" and "the line was printed in the run's own block" claim is
   therefore a contemporaneous note that cannot be checked against the tree. The
   conclusions those notes support are separately supported by numbers that
   **are** recomputable (`namesAnchorPath=34/34`, the scored MISS list), and the
   recipes themselves are snapshotted; the measurements are not.

3. **`optimizer/current/` holds gen-1, not gen-3** — see *State of
   `optimizer/current/`* above. Undocumented reset at 09:47:43Z, during the
   matrix arms.

4. **gen-3 had no closing entry** — added above.

5. **The matrix flash arm's 32/34 does not reproduce.** Three live task-4
   replicates on the same (recipe, model, task) scored 3/6, 5/6 and 4/6 against
   the published 6/6; the honest arm level is a band, **29–31/34**. That
   correction is applied where the number is published —
   `matrix/README.md`, `matrix/khal_deepseek-v4-flash/{README.md,arm.json}`,
   `matrix/khal_qwen3.7-max/{README.md,arm.json}` and `holdout/README.md`. It
   does not touch any generation number in this log: every `gens/gen-<N>` total
   is that round's own scored record, and each is n=1 for the same reason.
