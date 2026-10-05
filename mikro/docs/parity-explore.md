# Parity gate — `mikro_explore` against native Explore

Wish A (`mikro-explore-offload`), Group 4. This report records the gate that
decides whether mikro is a real offload target for Claude Code's explore-class
work, and whether Wish B (`mikro-microagent-plugin`) starts.

The thesis under test: **a cheap khal model, driven by the `explore`
microagent through the MCP tool surface, answers real explore-class questions
about a real repository at the same standard as the premium model that
originally answered them.** The token win is not in question — it is reported
below and it is enormous. Quality is the discriminator (design M2, decision 7).

**Each gate verdict is stated once, in one line.** Round 1's is `Gate: FAIL`
(*Gate verdict*); round 2's single frozen-suite shot is `Round-2 gate: FAIL`
(*Round 2 — the frozen-suite shot*, at the bottom). They agree, and round 1's
line is unchanged by round 2.

---

## The suite

Six tasks, mined by `scripts/mine-explore-tasks.mjs` from this host's own
Claude Code transcripts (past 168h) and frozen before any parity run. No
synthetic tasks (design D8). Each task file carries the verbatim question, the
native answer trace, a repo-verified required-facts checklist, and the rubric.

| Task | Root | Required facts | Pass needs | Native premium tokens |
|------|------|----------------|-----------|----------------------|
| [1](../.genie/wishes/rlmx-explore-offload/tasks/1.md) | `/home/namastex/prod/brain` | 14 | 13 | 2,943,691 |
| [2](../.genie/wishes/rlmx-explore-offload/tasks/2.md) | `/home/namastex/workspace/repos/genie` | 10 | 9 | 3,098,197 |
| [3](../.genie/wishes/rlmx-explore-offload/tasks/3.md) | `/home/namastex/prod/brain` | 11 | 10 | 2,976,188 |
| [4](../.genie/wishes/rlmx-explore-offload/tasks/4.md) | `/home/namastex/prod/brain` | 12 | 11 | 2,186,864 |
| [5](../.genie/wishes/rlmx-explore-offload/tasks/5.md) | `/home/namastex/workspace/repos/genie` | 5 | 5 | 1,499,747 |
| [6](../.genie/wishes/rlmx-explore-offload/tasks/6.md) | `/home/namastex/workspace/repos/genie` | 8 | 8 | 3,319,167 |

**Gate arithmetic.** The wish sets pass at ≥4 of 5, and ≥80% for larger suites
(WISH.md:70-71, restated as acceptance criterion A4b at WISH.md:137-138).
Six tasks → **≥5 of 6 must pass**.

---

## Method

### The mikro arm

Every run goes through the real MCP path, the pattern `scripts/smoke-explore.mjs`
established: an MCP SDK client over `node dist/src/cli.js mcp --dir <task
root>`, one `tools/call` of `mikro_explore` carrying the task's verbatim
question as `prompt`. Harness:
[`parity/run-task.mjs`](../.genie/wishes/rlmx-explore-offload/parity/run-task.mjs).

The recipe is installed into a **scratch `HOME`'s `~/.mikro/agents/explore/`** —
discovery root #1 (`src/mcp/agents.ts:56-68`) — with only its `model:` line
pinned per round. No `MIKRO_AGENTS_DIR` override, so discovery stays the real
precedence path; and nothing is written into the task repositories, which are
the user's other checkouts.

Each task runs against its own recorded root, so a `file:line` the agent emits
is resolvable against the very tree the agent read.

**Two exposures in this arm, disclosed rather than corrected for:**

- **The task roots are live checkouts and they moved during the gate window.**
  `/home/namastex/prod/brain/src/lib/server.ts` was last written at 19:28 on the
  run day; the rounds span roughly 20:00–23:55. Citations from an early round
  were therefore resolved against a tree that may not be byte-identical to the
  one that round's model read. `parity/verify-native.mjs` covers drift in the
  *ground truth*; it does not cover drift in *citation resolution* for the mikro
  arm. Rounds r1–r15 recorded no root revision, so the exposure cannot be
  bounded retrospectively — only stated. `run-task.mjs` now records each task
  root's git HEAD, branch and dirty flag in every run JSON (`provenance.rootGit`),
  so future rounds are re-resolvable.
- **No round before the audit recorded the prompt it ran under.** `run-task.mjs`
  logged the question, footer, progress and answer, but not `SYSTEM.md` or
  `agent.yaml`. "What changed in round N and what it did" is therefore prose
  only, and **no round from r1 to r15 can be re-run or re-scored against its
  actual prompt** — the intermediate versions were edited in place and are gone.
  `run-task.mjs` now records a SHA-256 of both files and snapshots the SYSTEM.md
  body under `parity/prompts/<sha>.md`; the only prompt with a recorded digest
  is the final committed one
  (`22334876a626ea3952674bca3d4ec26abffb3491b992354992aaf2fab3bdc77d`).

### The native arm

Scored from the native answer trace recorded in each task file — the premium
Explore work that originally answered the question. Per decision 6 the rubric
is applied identically to both arms, and the ground truth is derived from this
arm, so native scores 100% on criterion 1 by construction. That is a
**disclosed, deliberately conservative asymmetry** (P3): it makes the gate
harder for mikro and cannot manufacture a false pass.

The ground truth was re-verified against the trees as they stand rather than
assumed —
[`parity/verify-native.mjs`](../.genie/wishes/rlmx-explore-offload/parity/verify-native.mjs)
reopens every checklist anchor and checks the recorded line text is still there:

```text
task 1: 14/14 fact anchors still resolve with their recorded text
task 2: 10/10 fact anchors still resolve with their recorded text
task 3: 11/11 fact anchors still resolve with their recorded text
task 4: 12/12 fact anchors still resolve with their recorded text
task 5: 5/5 fact anchors still resolve with their recorded text
task 6: 8/8 fact anchors still resolve with their recorded text

NATIVE GROUND TRUTH VERIFIED
```

Criteria 2 and 3 were then re-derived mechanically from the recorded traces, by
the same scorer that scores the mikro arm.

**The native trace is capped at 4,000 characters at mining time.** Every task
file's trace ends in `[… truncated at 4000 chars]`, so the native arm is scored
on the first 4,029 characters of an answer that was originally much longer. That
cap is a property of the mining step, not of this gate, and it cuts *both* ways:
it hides native findings (which cannot help native's criterion-1 score, since
the checklist is lifted from the full answer) and it hides native citations
(which can only help native's criteria 2 and 3, because a citation that is never
scored can never fail). The second effect favours native and is the reason it is
stated here.

**A scorer defect compounded it, and it favoured native too.** The extractor
used a non-greedy match that stopped at the first *nested* code fence inside the
trace, so on tasks 2, 3 and 4 it scored only 1,027 / 693 / 776 characters — a
further 3.0k, 3.3k and 3.3k characters per task never reached the scorer at all.
That is why the first publication of this report recorded "native task 2/3/4:
cites=2" while mikro answers were being scored on 26–129 citations across their
full text, and why its claim that all six native answers pass "by the same
scorer that scores the mikro arm" overstated what had been checked. The extractor
is now fence-aware. Re-scored on the whole (still 4,000-char-capped) trace:

```text
native task 1: 4029 chars, 52 citations — c2 PASS, c3 PASS
native task 2: 4029 chars, 12 citations — c2 PASS, c3 PASS
native task 3: 4029 chars, 20 citations — c2 FAIL, c3 FAIL (bench/api.ts:900)
native task 4: 4029 chars, 27 citations — c2 PASS, c3 PASS
native task 5: 4029 chars, 17 citations — c2 PASS, c3 PASS
native task 6: 4029 chars, 14 citations — c2 PASS, c3 PASS
```

**Five of six, not six of six.** With its whole trace visible, the native arm
fails criteria 2 and 3 on task 3, on `bench/api.ts:900` and `:919`. This is not
a native fabrication: the real file is `src/bench/api.ts`, it has 942 lines, and
both cited lines exist there. It is a *partial-path* shorthand — the same class
of shorthand the published basename convention already forgives, penalised only
because it contains a slash, so that writing more of the true path is scored
harder than writing less of it. The convention was **not** changed to rescue it;
the incoherence is reported, and the alternative reading is quantified in
*Scoring conventions* below.

### The rubric (fixed before scoring, identical on both arms)

Verbatim from the task files:

1. **Required facts** — the answer states ≥90% of the checklist facts
   (⌈0.9 × N⌉). A fact counts as stated when the answer makes the same claim;
   wording may differ, the anchor may not.
2. **Citations resolve** — every `path:line` in the answer naming a file under
   the task root must resolve to a real line there. One that does not fails the
   task.
3. **No fabrication** — no invented path, symbol, or line number. One
   fabrication fails the task regardless of the other two.

Pass = all three.

### Scoring conventions

Criteria 2 and 3 are decided mechanically by
[`parity/score-task.mjs`](../.genie/wishes/rlmx-explore-offload/parity/score-task.mjs),
which opens the files. The conventions below are stated once and applied to
both arms:

- **Citation extraction.** `path.ext:N`, extension ≥2 letters (so `10.10.10.x:3000`
  — a host and port — is not read as a citation). Ranges and lists (`:61-115`,
  `:43,52,91`) expand to every anchor they name.
- **Shorthand back-references.** Both arms write `embedding.ts:28` once
  `src/lib/embedding.ts` has been named in the same answer. A bare basename is
  resolved against the directory of every directory-qualified path the answer
  itself supplies, then against a tree-wide basename index; it counts as a
  fabrication only when no directory the answer gave, and no file anywhere in
  the tree, has it. Without this rule the *native* arm fails criterion 2 on
  tasks 1 and 6 — which is how the convention was found.
- **Out-of-scope trees.** A native session that ranged over more than one tree
  has the other trees listed in its task file. `mikro mcp --dir` shows the mikro
  arm exactly one, so citations into those trees are scored on **neither** arm.
- **Partial-path shorthand — the one convention question left open.** A citation
  whose path is a *suffix* of a real path (`bench/api.ts` for the real
  `src/bench/api.ts`) currently fails, while the same file cited as a bare
  `api.ts` would resolve through the basename index. Every run and both arms
  were scored a second time with suffix resolution enabled
  (`SUFFIX_SHORTHAND=1`, `.score.suffix.json` beside every `.score.json`,
  both arms — the native pair was regenerated at final review after the
  audit found the default-variant file had been clobbered by its suffix
  run).
  Across all 97 recorded task-runs it changes **exactly one mikro run**
  (`r3-flash-tune2` task 1, c2/c3 FAIL → PASS, a run that names 0 of 14 anchor
  files and so is nowhere near its threshold either way) and **one native run**
  (task 3, FAIL → PASS). It changes no task verdict on either arm and it does
  not change the gate. The committed convention is the one reported above; this
  paragraph exists so that the choice is visible rather than silent.
- **Criterion 1** is a claim-level judgement, so it is judged rather than
  computed. The mechanical pass reports two proxies per fact — whether the
  answer names the anchor file at all, and whether it carries the term the fact
  was anchored on — and the judgement is recorded fact-by-fact in
  [evidence-group-4.md](../.genie/wishes/rlmx-explore-offload/evidence-group-4.md).
  Both a strict reading (the claim's named subject must appear) and a generous
  one (claim substance only, added detail not required) were scored. **No task
  verdict in this report differs between the two readings.**
- **"Anchor files named" is a screening bound, and it is only a bound under the
  strict reading.** The first publication of this report used it to settle five
  of six tasks "without a judgement call". That was too strong, twice over:
  1. The bound counts *full-path* mentions, while the citation convention
     accepts bare basenames. Under the basename variant the bound is higher, and
     8 runs reach their task's threshold instead of none. Both columns are now
     printed in the matrix.
  2. The report's own generous readings exceeded the bound — task 3 judged at 9
     facts on a run naming 8 anchor files, task 4 at 7 on a run naming 4 —
     because an answer can state a claim while referring to the file by
     basename, or by describing it. Under the generous reading it is therefore
     not a bound at all.

  So the bound is used for **screening only**, and every run that reaches its
  threshold under *either* column has been judged fact by fact. Under the strict
  column **no run among the 97 recorded task-runs reaches its task's
  threshold** — with one known exception outside the record: the overwritten
  `r8-mimo-tune3` task-2 invocation (`task-2.score.orphaned.json`, full=9
  against need=9, c2/c3 clean) reached the strict bound but its answer text
  was clobbered before judgement and is unrecoverable (§11). The bound is
  also a property of this sample, not of the configuration: a post-gate
  audit re-run of task 2 on the shipped flash default reached 9/10 anchor
  files by full path on its first attempt, so any future round must judge,
  not screen, every c2/c3-clean run within 2 facts of threshold on either
  column. Under the
  basename column 8 recorded runs do (5 on task 2, 2 on task 5, 1 on the post-gate re-check),
  and all 8 judgements are published in
  [evidence-group-4.md §4](../.genie/wishes/rlmx-explore-offload/evidence-group-4.md).
  Every one of them fails, under both readings.
- **The answer is what the tool returned.** When a run ends on mikro's
  forced-final path (`src/rlm.ts:857`), the returned text can contain REPL
  scaffolding, and citations inside it are scored like any other, because that
  text is what the host receives. This is a further conservative asymmetry
  against mikro — the native traces carry no scaffolding — and it is disclosed
  rather than corrected for. It changed no verdict: no run that failed only on
  scaffolding citations would have passed criterion 1.

### Environment corrections (not tuning rounds)

Two harness defects were found and fixed mid-run. Neither is a prompt or budget
change, and both are recorded here because they changed results:

1. **Concurrency capped** (
   [`parity/run-round.sh`](../.genie/wishes/rlmx-explore-offload/parity/run-round.sh)).
   Six concurrent explore agents against one khal key produced first-call
   timeouts — `0 in / 0 out` after ~300s — which had nothing to do with the
   model's answer and would have been scored as task failures. It affected
   `r2-flash-tune1` t6 and `r3-flash-tune2` t4/t6, marked in the round log. Two
   to three at a time never reproduced it.
2. **`MIKRO_MCP_RUN_TIMEOUT_MS=900000`.** `rlmLoop`'s wall-clock default is 300s
   (`src/rlm.ts:84`); the MCP server only overrides it from that env var
   (`src/mcp/server.ts:551-554`). Left at the default it cut runs mid-search and
   handed them to the forced-final path — a property of the harness, not of the
   model, and the native arm ran under no such cap. **Rounds r1–r5 ran under the
   300s default**; every round from r6 on runs at 900s.

Because rounds r1–r5 were flash's and mimo's, `r15-flash-control` re-runs the
whole suite on `khal/deepseek-v4-flash` under the corrected environment with the
final prompt, so that no tier's verdict rests on a cap it ran under and a later
tier did not. That control is the **best round in the entire gate**, and it
still fails — see below.

---

## Round log

16 rounds, 4 model tiers, **96 recorded task-runs**, $11.43 of khal spend — plus
7 re-runs whose records were overwritten ($0.81) and one post-gate re-check
($0.07), for **104 model invocations and $12.31 in total**. Every round is a
full sweep of all six tasks: a tuning change applies to all of them, so
previously passing tasks are always re-run to catch regressions.

Per tier: flash $0.34, mimo $3.46 (including the discarded round and the
overwritten re-runs), kimi $1.55, haiku $6.89.

> **Correction.** The first publication of this report said "15 rounds, 90
> task-runs, $11.00" and "every round is logged". Both were wrong. A sixteenth
> round directory (`r6-partial-300s-cap`, 6 runs, $0.43) was on disk, staged
> into the commit, and silently excluded from the matrix by a hard-coded filter;
> and seven runs had been re-run after scoring, overwriting the run JSON while
> the score JSON beside it kept describing the earlier run. Both are logged
> below and in [evidence-group-4.md §11](../.genie/wishes/rlmx-explore-offload/evidence-group-4.md).

Per-round, per-task mechanical results are in
[evidence-group-4.md](../.genie/wishes/rlmx-explore-offload/evidence-group-4.md);
the summaries below name what changed, why, and what it did.

### Tier 1 — `khal/deepseek-v4-flash` (the shipped default)

**r1 · baseline.** `examples/agents/explore/` exactly as Group 3 committed it
(`max_iterations: 10`). **0 of 6.** Tasks 5 and 6 returned the literal word
`answer`: `FINAL(answer)` written in prose submits the variable *name*, not the
string — a failure SYSTEM.md already warned about and the model made anyway.
Task 4 answered in one iteration, from memory, with 8 fabricated anchors
(`src/lib/config.ts:22`, `migrations/001-init.sql:1`, …) — precisely the failure
this recipe exists to prevent. Tasks 1–3 were clean on citations but stated 1,
6–8 and 8–9 of the 14, 10 and 11 required facts.

**r2 · tuning 1** — added an explicit turn protocol (turn 1 is the starter block;
never cite an unprinted line); replaced the 250-word answer cap with a coverage
rule, since the mined questions have up to six numbered parts and a word cap
argues against answering them; `max_iterations` 10 → 16. **0 of 6.** Citation
volume on task 1 more than doubled (41 → 92) but one fabricated anchor
(`memory/mnemosyne/docs/api/configuration.mdx:49`) failed it outright. Task 3
regressed to a one-iteration answer. Task 6 hit the concurrency artefact.

**r3 · tuning 2** — added a mandatory verification block (re-open every line you
are about to cite and print it back, drop what does not print) and a
print-small rule, after r2's context-limit warnings. **0 of 6.** Fabrications
dropped to one anchor on task 1 and none on task 3, so the verification idea
worked; but tasks 4 and 6 hit the concurrency artefact and task 5 spent all 16
iterations and ended on a repl block.

**r4 · tuning 3** — budget the run in thirds, and verification is the
second-to-last block, never the last. **0 of 6.** Tasks 3 and 6 produced their
best flash answers so far (4/11 and 5/8 anchor files named, citations clean);
tasks 1 and 4 returned the literal `answer` again.

Flash's three tuning rounds are spent. Escalate.

### Tier 2 — `khal/mimo-v2.5`

**r5 · escalation**, prompt as of flash tuning 3. **0 of 6.** A new failure
dominated: four of six runs ended *on the verification block*. The step
introduced in r3 consumed the budget, and mikro's forced-final path returned the
last message — which was a `CITES = [...]` listing, not an answer. My own tuning
had created this.

**r6 · discarded attempt (`r6-partial-300s-cap`).** The r6 prompt change was
first swept across all six tasks while `MIKRO_MCP_RUN_TIMEOUT_MS` was still at
the 300s default. Four of the six runs hit the cap at exactly 300s and returned
a 1-character answer; the round was discarded and re-run at 900s. It is kept and
logged because it happened and because $0.43 of khal spend is attributable to
it, not because it means anything: the two runs that *did* finish are the best
task-4 answer of the whole gate (10,095 characters, 6 of 12 anchor files, the
highest task-4 bound recorded) and a 15,786-character task-6 answer at 6 of 8.
Both are still far below their thresholds of 11 and 8, so nothing in the verdict
turns on it. It was omitted from the first publication of this report by a
hard-coded `!d.includes("partial")` filter in `matrix.mjs`; that filter is gone.

**r6 · tuning 1** — `max_iterations` 16 → 24, and an explicit override: when a
message says this is your last iteration, answer in plain prose, no block, no
`FINAL` (this is what `src/rlm.ts:912` actually asks for, and the prompt had
been telling the model to do the opposite). Also the 900s environment
correction. **0 of 6.** Five of this round's six runs were later re-run and the
originals overwritten, so what is on disk for tasks 1, 2, 3, 5 and 6 is the
*second* attempt, not the one first scored (see §11 of the evidence file). As
recorded now, five of the six returned a 1-character answer and only task 4
(4 of 12 anchor files) and task 6 (5 of 8) produced usable reports. The
first publication credited this round with "task 4 produced a 10k-character
cited report through exactly that path" — that report belongs to
`r6-partial-300s-cap`, not here; r6-mimo-tune1's task 4 is 5,436 characters.

**r7 · tuning 2** — `rlm_query_batched` fan-out: a six-part question is six
investigations, and done serially the run ends after two. One batch, early, one
self-contained sub-prompt per part, every returned citation re-verified locally
before use. **0 of 6.** Coverage on task 1 rose from 4 to 7 of 14 anchors — the
lever was real — but four tasks regressed to the literal `answer`.

**r8 · tuning 3** — removed the variable indirection entirely: `FINAL("""…""")`
with the answer written out inline, so there is no name left to misresolve.
**0 of 6.** Task 3 reached 8 of 11 anchor files named and task 6 6 of 8, both with
clean citations; task 1 named 10 of 14 — the highest strict bound in the gate —
and lost the task on a single fabricated `helm/values-hml.yaml:54`. Tasks 2 and
5 were also re-run after scoring and their originals overwritten; what is on
disk is a 1-character task-2 answer and a 576-character task-5 REPL block. The
first publication's claim that this round's task 2 "stated 7 of 10 facts" was
made against the overwritten run, whose text no longer exists — see the
correction under *Final scores*.

Mimo's three tuning rounds are spent. Escalate.

### Tier 3 — `khal/kimi-code`

**r9 · escalation.** **0 of 6.** A distinct failure: the model reported that
*every* REPL block returned no output, and — creditably — refused to invent
anything ("Any specific citations I gave would be fabricated"). Zero
fabrications across all six tasks, and almost zero facts. A direct probe
outside the harness confirmed the model executes code only sporadically: over
11 iterations of a trivial task it emitted a runnable block twice.

**r10 · tuning 1** — made the fence contract explicit (only ```` ```repl ````
executes; a `python`/`bash`/untagged block is read as prose) and added a
recovery rule for the "no output" symptom: re-send one small block, never
conclude the filesystem is unreadable. **0 of 6.** Citations appeared where
there had been none (task 1: 0 → 20), but coverage stayed far below threshold.

Kimi was given **1 of its 3 permitted rounds**. The reason is recorded rather
than assumed: its binding constraint is that the model does not reliably emit
executable blocks, its best task named 7 of 10 anchor files against a 9-of-10
requirement, and the decisive tier above it had not yet been measured. Rounds
were spent there instead.

### Tier 4 — `khal/claude-haiku` (top of the ladder)

**r11 · escalation.** **0 of 6.** Tasks 1 and 2 answered in 1–3 iterations from
priors, fabricating 24 and 18 anchors (`src/lib/models.ts`, `src/agents/main.ts`,
`lib/codex/init.js` — none exist). Three tasks hit **`budget hit: max-cost`**
after 5–7 iterations.

**r12 · tuning 1** — `max_cost` 0.25 → 2.00, because that rail was set to
flash's prices and on haiku it was ending the search rather than catching a
run that had stopped converging; plus two countable rules (no `FINAL` before
the fifth block; every citation must appear in an `OK` line your own
verification printed). **0 of 6.** The cost rail stopped binding — task 3 ran 14
iterations at $0.64 — but tasks 1 and 3 returned the literal `answer` and tasks
2 and 4 answered in one iteration with fabrications.

**r13 · tuning 2** — closed the `FINAL(<a word>)` failure by rule ("the
characters right after `FINAL(` are `\"\"\"`, always") plus a fallback: if you
cannot manage the block, write plain prose and no `FINAL` at all. **0 of 6.** The
literal-`answer` failure went away; **five of six tasks fabricated**, most in
one or two iterations.

**r14 · tuning 3** — moved the four countable rules to the very top of the
prompt, before the description of the job, addressed to a model that reads a
codebase question and believes it already knows the answer. **0 of 6.** Tasks 2,
4 and 5 came back clean on citations (6/10, 2/12 and 2/5 anchors named); tasks
1, 3 and 6 fabricated. Task 1 ran the full 24 iterations, burned 1.18M input
tokens and $1.53, and still cited `src/lib/providers.ts:9`, which does not exist.

Haiku's three tuning rounds are spent. The ladder is exhausted.

### Control — `khal/deepseek-v4-flash` under the corrected environment

**r15 · flash control**, final prompt, 900s timeout, capped concurrency. This
exists so flash's failure is not attributed to a cap that later tiers did not
run under. **0 of 6 — and the cleanest round of the whole gate:** all six tasks
pass criteria 2 and 3, zero fabrications, 24 iterations on five of six, at
$0.02–$0.04 per task. Criterion 1 is what fails, on every task:

| Task | Facts needed | Anchor files named, full path | …by basename | Criteria 2, 3 |
|------|--------------|-------------------------------|--------------|---------------|
| 1 | 13 of 14 | 5 | 5 | PASS, PASS |
| 2 | 9 of 10 | 8 | **9** | PASS, PASS |
| 3 | 10 of 11 | 5 | 5 | PASS, PASS |
| 4 | 11 of 12 | 2 | 2 | PASS, PASS |
| 5 | 5 of 5 | 4 | **5** | PASS, PASS |
| 6 | 8 of 8 | 5 | 5 | PASS, PASS |

Four of the six are below threshold on both columns. Tasks 2 and 5 reach it on
the basename column, so neither is settled mechanically and **both were judged
fact by fact** — task 2 at 6 strict / 8 generous against a threshold of 9, task 5
at 2 strict / 3 generous against a threshold of 5. The judgements are in
[evidence-group-4.md §4](../.genie/wishes/rlmx-explore-offload/evidence-group-4.md).

---

## Final scores

Both arms, scored by the same rubric. The mikro row is each task's **best result
across all 16 rounds and all four tiers** — not one round's — because a gate
that any configuration could have passed should be recorded as passed. "Best"
means: passes criteria 2 and 3 first, then the highest criterion-1 score. The
discarded `r6-partial-300s-cap` round is included in that search, and it wins
task 4; excluding it, as the first publication silently did, understated the
mikro arm's best task-4 result.

| Task | Arm | Criterion 1 (facts) | Criterion 2 | Criterion 3 | Verdict |
|------|-----|---------------------|-------------|-------------|---------|
| 1 | native | 14/14 ✓ | PASS (52 citations) | PASS | **PASS** |
| 1 | mikro — best clean run `r7-mimo-tune2` | ≤7 of 14, needs 13 | PASS | PASS | **FAIL** |
| 2 | native | 10/10 ✓ | PASS (12) | PASS | **PASS** |
| 2 | mikro — best clean run `r15-flash-control` | **6 of 10 judged** (8 generous), needs 9 | PASS | PASS | **FAIL** |
| 3 | native | 11/11 ✓ | **FAIL** (`bench/api.ts:900`) | **FAIL** | **FAIL**\* |
| 3 | mikro — best clean run `r1-flash-baseline` | ≤8 of 11 strict / ≤9 basename, needs 10 | PASS | PASS | **FAIL** |
| 4 | native | 12/12 ✓ | PASS (27) | PASS | **PASS** |
| 4 | mikro — best clean run `r6-partial-300s-cap` | ≤6 of 12, needs 11 | PASS | PASS | **FAIL** |
| 5 | native | 5/5 ✓ | PASS (17) | PASS | **PASS** |
| 5 | mikro — best clean run `r15-flash-control` | **2 of 5 judged** (3 generous), needs 5 | PASS | PASS | **FAIL** |
| 6 | native | 8/8 ✓ | PASS (14) | PASS | **PASS** |
| 6 | mikro — best clean run `r8-mimo-tune3` | ≤6 of 8, needs 8 | PASS | PASS | **FAIL** |

\* Native task 3 fails the mechanical criteria only because the scorer does not
resolve partial-path shorthand; the file and both lines it cites are real. See
*The native arm*. Under the suffix reading it passes. Either way the mikro arm's
task-3 verdict is unchanged.

The `≤` rows are screened out by the anchor-file count. Corrected
best-clean-run margins (final-review audit): task 1 = 6, task 3 = 2 strict /
1 basename, task 4 = 5, task 6 = 2 — the original "within 2 facts" claim was
wrong for tasks 1, 3 and 6. Task 3's closest run (`r1-flash-baseline`, 8
full / 9 basename against need 10) was therefore judged fact by fact at
audit: F1–F6, F8 stated = 7 strict; +F9, F11 = 9 generous; F7 and F10
contradicted outright (it denies a remote-URL knob, missing
`BRAIN_ENDPOINT`, and claims the MCP binary talks to the serve HTTP API
rather than Postgres) — 7/9 against threshold 10, still FAIL, so the
screening error does not move the gate. For the remaining screened rows the
strict bound argument holds (a fact cannot be stated by an answer that never
mentions the file it is about). Tasks 2 and 5
reach their thresholds on the basename column and were judged fact by fact, as
were the four other task-2 runs that do the same (`r1`, `r2`, `r3`, `r14`) and
the post-gate re-check. Every one fails, under both readings; the judgements are
in [evidence-group-4.md §4](../.genie/wishes/rlmx-explore-offload/evidence-group-4.md).

> **Correction.** The first publication named `r8-mimo-tune3` as task 2's best
> clean run and reported "7 of 10 judged". That judgement was made against an
> 18,841-character answer that no longer exists: the run was re-run after
> scoring and the record overwritten, leaving a 1-character answer on disk with
> the earlier run's score JSON beside it. The judged text is unrecoverable, so
> that number cannot be re-derived and is withdrawn. Task 2's ceiling is
> restated from `r15-flash-control`, whose text is intact — **8 of 10 under the
> generous reading, 6 strict**. A fresh `khal/mimo-v2.5` run of task 2 under the
> committed prompt (`r16-mimo-t2-recheck`, 24 iterations, $0.07, 294s) reaches
> 8 of 10 anchor files and states ~5 of 10 claims generously, well below the
> bar; it is a new data point, not a reproduction, because r8's prompt was not
> snapshotted and no longer exists.

**native 5 of 6 (6 of 6 on the suffix reading). mikro 0 of 6, in every round, on
every tier.**

The gap is not fabrication and it is not citation hygiene — by the last rounds
the best configurations emit dozens of citations that all resolve. The gap is
**coverage**: a single delegated run of a few hundred seconds states between a
third and three-quarters of the specific line-anchored findings that a native
Explore session produced over 30–46 tool calls and ~2.2–3.3M premium tokens. On
the two smallest checklists — tasks 5 and 6, which require *every* fact — no arm
but native came close.

The closest any mikro run came to a passing task was **task 2 at 8 of 10 facts
under the generous reading, 6 strict** (needs 9), by `khal/deepseek-v4-flash` in
`r15-flash-control`. One fact short under the most permissive reading available,
three short under the strict one, on one task, is the high-water mark of 97
recorded runs. The three facts nothing ever stated on task 2 are `F1` (childCwd
fed by `const cwd = options.cwd ?? process.cwd()` in `runtime-integrations.ts`),
`F3` (`syncOneSkill`) and `F6` (`stampWorkflowTemplate`) — no run in any round
names the last two at all.

---

## Premium-token accounting (reported, never gated)

Decision 7: this is reported data, never the gate. Method:

- **native** = the Explore segment's assistant turns as recorded in each task
  file — `input + cacheRead + cacheCreate + output`. These are the tokens the
  premium model was actually billed for.
- **mikro** = the **host-session delta for the tool call**: the characters the
  host sent (the request arguments) plus the characters it got back (the whole
  result text, answer plus footer), divided by 4. Nothing the delegated agent
  burned on khal appears in this column — that is the entire point of the
  offload, and it is reported separately as khal tokens and dollars.

Figures below are the `r15-flash-control` round (the final flash control);
per-round figures for every other round are in the evidence file.

| Task | Native premium tokens | mikro host chars (req + res) | mikro premium tokens | Ratio | khal tokens (in/out) | khal cost | Wall |
|------|----------------------|------------------------------|---------------------|-------|----------------------|-----------|------|
| 1 | 2,943,691 | 1,595 + 14,545 | 4,035 | **730×** | 59,901 / 8,788 | $0.02 | 117s |
| 2 | 3,098,197 | 1,818 + 12,575 | 3,598 | **861×** | 68,454 / 11,585 | $0.02 | 161s |
| 3 | 2,976,188 | 1,918 + 7,829 | 2,437 | **1,221×** | 75,290 / 5,163 | $0.02 | 149s |
| 4 | 2,186,864 | 1,568 + 5,037 | 1,651 | **1,325×** | 106,394 / 5,959 | $0.02 | 139s |
| 5 | 1,499,747 | 1,685 + 14,708 | 4,098 | **366×** | 197,337 / 7,899 | $0.04 | 205s |
| 6 | 3,319,167 | 1,858 + 4,432 | 1,573 | **2,110×** | 70,243 / 10,753 | $0.02 | 280s |
| **total** | **16,023,854** | — | **17,392** | **921×** | — | **$0.14** | — |

The offload economics are exactly as the design predicted and are not in
dispute: a three-order-of-magnitude reduction in premium context for fourteen
cents of gateway spend. **It buys an answer that fails the quality bar.** That is
why the token column was never allowed to be the gate.

For completeness, the whole gate — 96 recorded task-runs across four tiers —
cost $11.43 of khal spend: flash $0.34, mimo $2.65, kimi $1.55, haiku $6.89.
Counting the 7 overwritten re-runs ($0.81) and the post-gate re-check ($0.07),
104 model invocations and $12.31.

---

## Gate verdict

The escalation ladder was run to its end: `khal/deepseek-v4-flash` (3 tuning
rounds), `khal/mimo-v2.5` (3), `khal/kimi-code` (1, with the reason recorded),
`khal/claude-haiku` (3), plus a flash control under the corrected environment, a
discarded 300s-capped mimo attempt, and one post-gate mimo re-check of task 2.
No tier passed a single task. The suite requires 5 of 6.

This verdict survived an audit that re-scored every run JSON on disk, un-hid a
round, judged every run reaching its threshold under either reading of the
anchor bound, and withdrew two published numbers whose evidence had been
overwritten. Nothing it found moved a task from FAIL to PASS; what it changed is
recorded in
[evidence-group-4.md §11](../.genie/wishes/rlmx-explore-offload/evidence-group-4.md).

Per decision 5, the "parity model" is whichever tier passed the gate. **No tier
passed, so there is no parity model**, and Wish B's shootout has no
gate-passing tier to key its fallback off.

Gate: FAIL

**Consequences, per the wish's failure branch (WISH.md:70-74, and the risk-table
row that anticipated it at WISH.md:475):**

- A4b stays unchecked. **Wish B (`mikro-microagent-plugin`) does not start.**
- Nothing else in Wish A is invalidated. The khal provider (A3), the live MCP
  refresh, the Agent-tool isomorphism, `--dir`, and the `explore` recipe are all
  independently evidenced and green; what failed is the claim that a cheap model
  reaches native-Explore quality on this suite, and that claim is now falsified
  with 97 logged runs behind it.
- **The tuning was not wasted, and the tree is green with it.** `npm test`
  489/489, `node scripts/smoke-mcp.mjs` PASS, `npm audit --omit=dev` 0
  vulnerabilities, and `node scripts/smoke-explore.mjs` passes on both arms —
  with the khal arm now `correct=true`, which it was not before. On a
  single-part question a cheap model answers correctly and cites resolvably.
  What eleven tuning rounds could not do is carry a six-part mined question to
  ≥90% fact coverage. That distinction is the finding.
- The thesis is falsified **as scoped**, not universally. What was measured is
  one delegated run, on one khal tier, against checklists derived from
  multi-million-token native sessions. Three specific things were never tried
  and are not ruled out: multi-turn delegation (the `session_id` resume path
  exists and this gate used a single call per task), a premium khal tier above
  haiku (`claude-sonnet` is in the catalog), and decomposing a six-part question
  into six separate `mikro_explore` calls at the host rather than inside the
  agent. Each is a different experiment, and none of them is what this gate
  tested.

---

## Frozen-suite handoff for Wish B

The suite is frozen as of this report and is the regression and shootout input
for whatever comes next. Nothing in it was changed by Group 4: the task files
and their checklists are exactly as Group 3 mined them.

**What is frozen**

- `.genie/wishes/rlmx-explore-offload/tasks/{1..6}.md` — 6 tasks, 60 required
  facts, repo-verified. All 60 anchors re-verified against their trees at gate
  time (`parity/verify-native.mjs`, output above). Re-run that script before
  trusting the suite again: it is the tripwire for ground truth drifting under
  the gate as those repositories move on.
- The rubric and the scoring conventions in this report. A future run that
  changes them is not comparable to this one.
- Provenance caveat: only the final prompt survives
  (`parity/prompts/22334876….md`). Rounds r1–r15 carry no per-round prompt or
  task-root provenance, so their round-log deltas are unverifiable narrative —
  any Wish B comparison must compare against the frozen final prompt and the
  raw run records, never against the r1–r15 prose.

**How to re-run it**

```bash
export KHAL_API_KEY=…                       # env only, never in a file
export MIKRO_MCP_RUN_TIMEOUT_MS=900000       # or runs get cut at 300s
cd ~/prod/mikro && npm run build
node .genie/wishes/rlmx-explore-offload/parity/verify-native.mjs
bash .genie/wishes/rlmx-explore-offload/parity/run-round.sh <model> <round-label>
bash .genie/wishes/rlmx-explore-offload/parity/score-round.sh <round-label>
node .genie/wishes/rlmx-explore-offload/parity/tokens.mjs <round-label>
```

Concurrency is capped at 3 in `run-round.sh` for the reason in *Environment
corrections*; raise it and gateway timeouts start being scored as model
failures.

**What Wish B should know**

1. **There is no parity model to key a fallback off.** Decision 5 defines the
   term as the tier that passed; none did. Any Wish B logic written against
   "the parity model" needs a different anchor or a passing gate first.
2. **The discriminator is fact coverage, not citation hygiene.** By the final
   rounds, `khal/deepseek-v4-flash` returned six-for-six clean citation sets. A
   shootout that ranks models on "does it fabricate" will find them all
   equivalent; rank on required-facts-stated or it measures nothing.
3. **The measured ceiling is 8 of 10 facts on task 2 under the generous reading
   (6 strict)**, from `r15-flash-control`, whose answer text is intact and whose
   judgement is re-derivable. Treat that as the number to beat, and treat any
   configuration claiming a pass without beating it as a scoring change rather
   than a result. The earlier "7 of 10, reached independently by two tiers"
   figure is withdrawn — half of it rested on a run whose text was overwritten.
4. **Tasks 5 and 6 require every fact** (5/5 and 8/8, from small checklists).
   They are the least forgiving and the fastest signal that something has
   genuinely improved.
5. **The prompt in `examples/agents/explore/` is the tuned one**, not Group 3's.
   Eleven tuning rounds are folded into it, and the four that demonstrably fixed
   something are worth keeping whatever the gate says: `FINAL("""…""")` inline
   rather than a variable name (killed the literal-`answer` failure outright),
   the last-iteration plain-prose override (matches what `src/rlm.ts:912` asks
   for), the verification block (fabrications fell sharply wherever it ran), and
   `max_cost: 2.00` (0.25 was flash's price, and it truncated every haiku run).
6. **Almost every run is kept.** 97 result JSONs with the full returned text,
   footers, progress and scores are under
   `.genie/wishes/rlmx-explore-offload/parity/runs/`, and every number in this
   report can be recomputed from them without re-running a model — **with one
   stated exception**: 7 runs were re-run after scoring and their text
   overwritten before anyone read it back. What survives of those 7 is their
   score JSON, kept as `task-N.score.orphaned.json`, which carries the citation
   list and per-fact signals but not the answer. Any claim that depended on
   their text has been withdrawn rather than restated. Re-score before trusting
   the matrix:

   ```bash
   for r in .genie/wishes/rlmx-explore-offload/parity/runs/r*/; do
     bash .genie/wishes/rlmx-explore-offload/parity/score-round.sh "$(basename "$r")"
   done
   node .genie/wishes/rlmx-explore-offload/parity/matrix.mjs
   ```

   `run-task.mjs` now refuses to overwrite an existing run record unless
   `PARITY_OVERWRITE=1` is set explicitly, so the defect cannot recur silently.
7. **Rounds r1–r15 carry no prompt or root provenance.** Neither the prompt they
   ran under nor the task roots' revisions were recorded, so no pre-audit round
   can be reproduced. Every run from the audit forward records
   `provenance.promptSha256`, `provenance.agentYamlSha256`,
   `provenance.rootGit` and `provenance.mikroGit`, and snapshots the prompt under
   `parity/prompts/<sha>.md`. A shootout that wants to compare configurations
   needs that provenance; this gate did not have it.

---

## Round 2 — the frozen-suite shot

Round 1 ended `Gate: FAIL` after 16 tuning rounds and the user overrode the stop.
Round 2 did **not** re-tune against the gate. It built a separate *training*
suite (`parity/round2/train-tasks/`), evolved a recursive `explore-r` recipe
against it over four generations, ran a four-model matrix and a two-task
holdout — and then spent **exactly one shot** on the frozen six. This section is
that shot, and the shot is the only round-2 number that bears on A4b.

The frozen suite, the rubric and the scoring conventions are **unchanged**: same
six task files, same 60 required facts, same `parity/score-task.mjs`, same gate
arithmetic (≥5 of 6). What moved is the recipe — a recursive agent that
partitions the question across sub-agents instead of reading the tree itself —
and the two environment corrections that recursion requires.

### The shot rules, pre-registered and immutable

Fixed in writing before the first run, reproduced here verbatim:

> **PRE-REGISTERED SHOT RULES (immutable):** recipe = gens/gen-1/recipe snapshot
> (SYSTEM.md 02184f35, agent.yaml 20f8e018) installed verbatim — no edits of any
> kind; model = khal/deepseek-v4-flash for parent and children
> (`--pin-child-model` semantics as the harness supports post-6ec4822);
> concurrency 1; MIKRO_REPL_TIMEOUT_MS=600000; ONE run per frozen task, in task
> order 1..6. ONE retry allowed per task ONLY for documented infrastructure
> death (REPL-timeout wall / connection failure with the error string recorded)
> — never for content quality; a second infrastructure death counts as the run.
> No tuning, no prompt reading beyond installing the snapshot, no peeking at
> scores before all six runs complete.
>
> **Scoring:** the round-1 gate scorer `parity/score-task.mjs`, default
> invocation, both readings (default + `SUFFIX_SHORTHAND=1` to
> `.score.suffix.json`). Gate math per the wish: a task passes at ≥90% of its
> required facts with every citation resolving and zero fabrications; the suite
> passes at ≥5 of 6 tasks. Run `parity/verify-native.mjs` first; any drifted
> anchor is recorded and the affected facts reported both raw and drift-adjusted
> (the round-1 convention).

**The retry was never used.** All six runs exited 0 on the first attempt; no
infrastructure death occurred, so nothing was re-run and no run record was
overwritten. This is the discipline round 1's audit found missing — seven of its
runs had been re-run after scoring, leaving score JSONs describing text that no
longer existed (§11).

### What actually ran

| | |
|---|---|
| Round label | `r2-shot-gen1-flash` — records under [`parity/runs/r2-shot-gen1-flash/`](../.genie/wishes/rlmx-explore-offload/parity/runs/r2-shot-gen1-flash/) |
| Recipe | `parity/round2/optimizer/gens/gen-1/recipe`, installed verbatim |
| `sha256 SYSTEM.md` | `02184f35…` (27,840 chars) — snapshot at `parity/prompts/02184f35….md` |
| `sha256 agent.yaml` (installed) | `20f8e018…` — identical to the recipe's, because the recipe already declares `khal/deepseek-v4-flash` and the runner's model rewrite was a no-op |
| Agent / tool | installed as `explore-r`, called as `mikro_explore-r` |
| Model | `khal/deepseek-v4-flash`, parent **and** children (`--pin-child-model` wrote `model.provider`/`model.model`/`model.sub-call-model` into each scratch `HOME`) |
| Suite recorded per run | `frozen-eval`, `tasksDir` = `<wish>/tasks` |
| Concurrency | 1 — each task ran to completion before the next started, in order 1..6 |
| Env | `MIKRO_REPL_TIMEOUT_MS=600000`, `MIKRO_MCP_RUN_TIMEOUT_MS=900000`, `PARITY_CALL_TIMEOUT_MS=600000`, `PARITY_MAX_TOTAL_TIMEOUT_MS=2400000` — all four recorded in every run record |
| mikro HEAD | `6ec4822` |
| Task-root HEADs | `/home/namastex/prod/brain` `040bb83`; `/home/namastex/workspace/repos/genie` `71dd019` |
| Window | 2026-07-27 13:35:02Z → 14:16:22Z, 41 min, **$0.22** of khal spend |
| Runner | [`parity/runs/r2-shot-gen1-flash/shot.sh`](../.genie/wishes/rlmx-explore-offload/parity/runs/r2-shot-gen1-flash/shot.sh) — a serial specialization of `run-round.sh`; the frozen gate's own runner was not edited |

`PARITY_CALL_TIMEOUT_MS=600000` deserves naming rather than burying: it raises
the MCP client's *go-silent* tolerance from the frozen gate's 300 s. A recursive
fan-out emits no progress for the whole blocking wave, so at 300 s the harness
would kill a recursive run for being quiet — scoring the harness, not the model.
It is the same correction `round2/run-train-round.mjs` applies to every
generation, and it is disclosed here because it is a difference from round 1's
command line.

### Checked before spending anything

**Ground truth: verified, zero drift.** `parity/verify-native.mjs` at
`6ec4822`, immediately before the shot:

```
task 1: 14/14 fact anchors still resolve with their recorded text
task 2: 10/10 fact anchors still resolve with their recorded text
task 3: 11/11 fact anchors still resolve with their recorded text
task 4: 12/12 fact anchors still resolve with their recorded text
task 5: 5/5 fact anchors still resolve with their recorded text
task 6: 8/8 fact anchors still resolve with their recorded text

NATIVE GROUND TRUTH VERIFIED
```

All 60 anchors resolve with their recorded text. **No anchor drifted, so the raw
and drift-adjusted readings are the same numbers** — the round-1 convention is
satisfied with nothing to adjust.

**Train-set leakage: checked, and it does not reach this suite.** gen-4 was
rejected partly because four *training*-suite anchoring terms sat verbatim in
its own `SYSTEM.md` while the fact rule is a substring test — a defect gen-1
inherits (`optimizer/README.md`, *Inherited debt*). All **60** frozen-suite
anchoring terms were tested against gen-1's `SYSTEM.md`: **0 appear**, including
the four named ones (`MAX_ATTEMPTS`, `findCmd`, `FETCH_BODY_TIMEOUT_MS`,
`RECORD_SCHEMA_VERSION`), none of which occurs anywhere in the frozen task files
either. The number below is clean of the defect that sank gen-4.

### Mechanical results — all six runs, both readings

| Task | need | ok | iters | spawns | wall | cost | answer | citations | c2 | c3 | c2 (suffix) | c3 (suffix) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 13/14 | ✓ | 8 | 4 | 514.9s | $0.05 | 11,517 ch | 62 | PASS | PASS | PASS | PASS |
| 2 | 9/10 | ✓ | 14 | 3 | 480.8s | $0.03 | 8,088 ch | 28 | PASS | PASS | PASS | PASS |
| 3 | 10/11 | ✓ | 14 | 4 | 340.4s | $0.04 | 4,427 ch | 19 | PASS | PASS | PASS | PASS |
| 4 | 11/12 | ✓ | 4 | 4 | 390.8s | $0.03 | 5,674 ch | 32 | PASS | PASS | PASS | PASS |
| 5 | 5/5 | ✓ | 13 | 4 | 441.2s | $0.05 | 9,497 ch | 47 | PASS | PASS | PASS | PASS |
| 6 | 8/8 | ✓ | 11 | **0** | 310.1s | $0.02 | 8,987 ch | 27 | PASS | PASS | PASS | PASS |

**Criteria 2 and 3 pass on all six tasks, in both readings: 215 citations, zero
unresolvable, zero fabricated.** The suffix reading changes nothing — no
citation in this shot depends on partial-path resolution.

That result is **not new, and should not be reported as progress**. Seven
round-1 rounds were also 6/6 citation-clean (`r5`, `r6-mimo-tune1`,
`r6-partial-300s-cap`, `r7`, `r9`, `r10`, `r15`), and `r15-flash-control` did it
with 260 citations against this shot's 215. Citation hygiene was already solved
by the last rounds of round 1; the shot reproduces it, and reproducing it on a
recursive recipe whose children are separate processes is worth knowing, but it
moves no verdict.

**The fan-out fired on 5 of 6 tasks and did not fire at all on task 6** (0
spawns, 11 iterations). That is the known `SEEN`-seeding defect the gen-4
closeout logged for gen-5 (`EVOLUTION.md` → *What survives*), observed here on
the frozen suite for the first time. Task 6 still produced its best-of-campaign
generous score, so the miss is recorded, not blamed.

### Criterion 1, judged

Criterion 1 is a claim-level judgement and `score-task.mjs` deliberately does not
decide it. Screening follows the rule round 1's audit pre-registered for every
future round — **judge, do not screen, every c2/c3-clean run within 2 facts of
threshold on either column** — with the two screening columns (facts whose anchor
path the answer names in full; facts whose anchor basename it names):

| Task | need | strict column | basename column | screened |
|---|---|---|---|---|
| 1 | 13 | 3/14 | 3/14 | **screened out** — 10 short |
| 2 | 9 | 8/10 | 8/10 | judged |
| 3 | 10 | 6/11 | 8/11 | judged |
| 4 | 11 | 2/12 | 2/12 | **screened out** — 9 short |
| 5 | 5 | 4/5 | 4/5 | judged |
| 6 | 8 | 6/8 | 6/8 | judged |

Tasks 1 and 4 are screened out on the round-1 bound argument: a fact cannot be
stated by an answer that never mentions the file it is about, and both are far
outside the judge window (3 against 13, 2 against 11). Every other task was
judged fact by fact, under both readings — strict (the claim's named subject
must appear) and generous (claim substance only, added detail not required).

**Task 2 — 5 strict / 7 generous, needs 9. FAIL.**

| Fact | Anchoring subject | Verdict |
|---|---|---|
| F1 | `const cwd = options.cwd ?? process.cwd()` (`runtime-integrations.ts`) | **MISS** both — the file is never named |
| F2 | `codexFailed` | STATED both |
| F3 | `syncOneSkill` | **MISS** both — never named |
| F4 | doctor's digest-currency conjunction (`summarizeManagedSkills`) | generous only — the answer states mismatch→stale, not the conjunction |
| F5 | `__GENIE_LENS_ROOT__` | STATED both |
| F6 | `stampWorkflowTemplate` | generous only — the answer says `stampWorkflow` at a different line |
| F7 | `councilStampState` | **MISS** both — never named |
| F8 | `isInteractive` | STATED both |
| F9 | `uninstallCommand` | STATED both |
| F10 | `codexFailed` (A2, sync gated on codex failure) | STATED both |

F1 and F3 are two of the facts round 1 recorded as never stated by any run in
any round (round 1's never-stated set was F1/F3/F6); F7 was stated by round 1's
r15-flash-control and r1-flash-baseline but is missed by this shot. (Corrected
at final review — an earlier revision misattributed F7 to round 1's
never-stated set.)

**Task 3 — 6 strict / 9 generous, needs 10. FAIL, one short under the most
permissive reading available.**

| Fact | Anchoring subject | Verdict |
|---|---|---|
| F1 | `httpServer` = `Bun.serve` at `server.ts:395` | generous only |
| F2 | `const port = opts.port ?? 3847;` | STATED both |
| F3 | `handleRequest` | STATED both |
| F4 | `POST /api/search` | STATED both |
| F5 | `/^\/api\/brains\/([^/]+)\/ask$/` | generous only — route stated, regex not |
| F6 | `const principal = extractPrincipal(req);`, never enforced | STATED both |
| F7 | `BRAIN_ENDPOINT` is **the one true remote knob** | **MISS both — contradicted.** The answer names `BRAIN_ENDPOINT` and locates it correctly, then calls it "status-only … used only for display". That is a different claim about the same variable, and the two cannot both be true |
| F8 | `getDb`, everything DSN-direct | STATED both |
| F9 | `BRAIN_ADMIN_DATABASE_URL` / `readPrimaryDsn` | **MISS** both — `db.ts` never named |
| F10 | stdio MCP entry point, Postgres-direct | STATED both |
| F11 | `discoverHookBaseUrl()` — the hook already speaks HTTP to serve | generous only — same claim via `discoverBaseUrl` in `common.ts` |

F7 is the same fact round 1 recorded as "contradicted outright" on its own best
task-3 run. A different recipe, a different failure of the same fact.

**Task 5 — 3 of 5, both readings, needs 5 (every fact). FAIL.**

F1 (`workflow_call` at `:34`), F2 (the `TARBALL=` line) and F3 (`-C "${STAGE}" .`
and its `./` root entry) are stated exactly. F4 misses: the answer describes the
`workflow_run` trigger as firing on CI **completion** and never states the gate's
`conclusion == 'success'`, `event == 'push'` and `[auto-version]` exclusion —
"completed" is not "succeeded". F5 misses outright: `sign-attest.yml` and the
`admit` job appear nowhere in the answer.

**Task 6 — 3 strict / 7 generous, needs 8 (every fact). FAIL.**

Strict: F2 (`~/.genie/.last-agent-sync`), F4 (`runAgentSyncSafe`), F5
(`CLAUDE_EXCLUDED_SKILLS`). Generous adds F3 (install triggers sync via
`runSync`), F6 (uninstall removes managed mirrors, never syncs), F7 (setup takes
an agent-sync lifecycle lease, never syncs) and F8 (plugin hooks never sync) —
each stated in substance without the anchoring identifier. **F1 misses under
both readings**: the Hermes `skills.external_dirs` → `$GENIE_HOME/skills`
mechanism is never stated, and `hermes-skills-config.ts` is never named. Seven of
eight is the campaign's best generous score on any frozen task, and the task
requires eight.

### Per task, against round 1's best

Round 1's "best" is its best result on that task **across all 16 rounds and four
tiers**; round 2's is its single shot. The comparison is therefore
16-rounds-of-search against one run, and it flatters round 1 by construction.

| Task | need | Round-1 best (judged) | Round-1 round | Round-2 shot (judged) | Δ generous |
|---|---|---|---|---|---|
| 1 | 13 | ≤7 of 14 | `r7-mimo-tune2` | ≤3 of 14 | **−4** |
| 2 | 9 | 6 strict / **8** generous | `r15-flash-control` | 5 strict / **7** generous | **−1** |
| 3 | 10 | 7 strict / **9** generous | `r1-flash-baseline` | 6 strict / **9** generous | **0** |
| 4 | 11 | ≤6 of 12 | `r6-partial-300s-cap` | ≤2 of 12 | **−4** |
| 5 | 5 | 2 strict / **3** generous | `r15-flash-control` | 3 strict / **3** generous | **0** (strict +1) |
| 6 | 8 | ≤6 of 8 | `r8-mimo-tune3` | 3 strict / **7** generous | **+1** |

**The recursive recipe does not beat the round-1 ceiling.** It ties on tasks 3
and 5, betters task 6 by one fact, and is materially worse on tasks 1 and 4 —
where the fan-out returned answers naming 3 and 2 of the required anchor files
against round 1's 7 and 6. No task moved within reach of its threshold, and the
closest approach in the whole campaign remains round 1's task 2 at 8 of 10
generous. This shot's closest is task 3 at 9 of 10 needed 10 — the same margin,
on a different task, from the other direction.

### Premium-token accounting (reported, never gated)

Same method as round 1: native = the Explore segment's billed assistant turns;
mikro = the host-session delta for the one tool call, `(requestChars +
resultChars) / 4`. Nothing the delegated agent and its children burned on khal
appears in the mikro column — it is reported separately.

| Task | Native premium tokens | mikro premium tokens | Ratio | khal tokens (in/out) | khal cost | Wall |
|---|---|---|---|---|---|---|
| 1 | 2,943,691 | 3,314 | **888×** | 298,509 / 42,250 | $0.05 | 514.9s |
| 2 | 3,098,197 | 2,512 | **1,233×** | 166,728 / 40,080 | $0.03 | 480.8s |
| 3 | 2,976,188 | 1,622 | **1,835×** | 246,914 / 24,437 | $0.04 | 340.4s |
| 4 | 2,186,864 | 1,846 | **1,185×** | 198,872 / 29,128 | $0.03 | 390.8s |
| 5 | 1,499,747 | 2,831 | **530×** | 282,480 / 39,967 | $0.05 | 441.2s |
| 6 | 3,319,167 | 2,747 | **1,208×** | 116,897 / 14,173 | $0.02 | 310.1s |
| **total** | **16,023,854** | **14,872** | **1,077×** | 1,310,400 / 190,035 | **$0.22** | 2,478s |

1,077× against round 1's 921×, for 22 cents. The offload economics are, if
anything, better under recursion — the children's tokens are entirely off the
premium ledger. It still buys an answer that fails the quality bar, which is why
this column was never allowed to be the gate.

### Gate arithmetic

Every task requires all three criteria. Criteria 2 and 3 pass on all six.
Criterion 1 passes on none:

| Task | c1 (strict) | c1 (generous) | need | c2 | c3 | Verdict |
|---|---|---|---|---|---|---|
| 1 | ≤3 | ≤3 | 13 | PASS | PASS | **FAIL** |
| 2 | 5 | 7 | 9 | PASS | PASS | **FAIL** |
| 3 | 6 | 9 | 10 | PASS | PASS | **FAIL** |
| 4 | ≤2 | ≤2 | 11 | PASS | PASS | **FAIL** |
| 5 | 3 | 3 | 5 | PASS | PASS | **FAIL** |
| 6 | 3 | 7 | 8 | PASS | PASS | **FAIL** |

**0 of 6 tasks pass. The suite requires 5 of 6.** No task verdict differs between
the strict and generous readings, and none differs between the default and
suffix citation readings.

Round-2 gate: FAIL

**Consequences.** A4b stays unchecked and **Wish B (`mikro-microagent-plugin`)
does not start** — the same design failure branch round 1 landed in
(WISH.md:70-74). The round-1 verdict line above is unchanged; this section
states round 2's own line, and the two agree.

### What this shot establishes, and what it does not

- **Establishes:** the recursive `explore-r` recipe, on the model the round-2
  matrix selected on cost, does not reach ≥90% fact coverage on any of the six
  mined tasks. Recursion is not the missing lever. The failure is the same one
  round 1 diagnosed — coverage, not fabrication — and it survives partitioning
  the question across sub-agents.
- **Establishes:** the offload economics hold under recursion (1,077×, $0.22),
  and citation discipline holds across process boundaries (215/215).
- **Does not establish** that gen-1 is the best available recipe. It is the
  incumbent selected on a tie, over a four-generation range (`[28, 29, 28, 29]`
  facts of 34) narrower than the ±3-fact run-to-run noise measured on a single
  fixed triple. A different generation could plausibly have scored ±3 here.
- **Does not establish** anything about `khal/deepseek-v4-flash` versus the other
  matrix arms on accuracy — that comparison was never resolved (see the campaign
  summary).
- **Is one run per task.** The round-2 optimizer's own README concedes that one
  round is not a measurement. This shot is one round, deliberately, because the
  gate rules were pre-registered as a single shot to prevent selection over
  repeats. A FAIL from a single shot is a FAIL; a PASS from one would have
  needed replication before it could be believed.
- **Untested by this shot**, exactly as after round 1: multi-turn delegation via
  `session_id`, a khal tier above haiku, and host-side decomposition of a
  six-part question into six calls.

### The round-2 campaign, in one paragraph

Round 2 built a training suite rather than tuning against the gate: 8 authored
tasks in `parity/round2/train-tasks/`, of which 6 form the fitness set (34
facts, 3 live roots) while `1.md`/`2.md` are held out by a harness that refuses
to read them; four generations of a recursive `explore-r` recipe were run
against that fitness set, one round each — gen-0 (the shipped recipe) 28/34,
gen-1 29/34, gen-2 28/34, gen-3 29/34 — and **gen-1 was selected on the explicit
ground that a tie does not displace an incumbent**, not on a margin, because the
entire four-generation range is narrower than the ±3-fact run-to-run spread later
measured on one fixed (recipe, model, suite) triple. A four-model matrix then ran
gen-1's frozen snapshot once per model, and **its cost ranking is robust and
large while its accuracy ranking decides nothing**: flash is 8.7× cheaper per
round than `deepseek-v4-pro`, 13× than `glm-5.2` and 18.8× than `qwen3.7-max`
(≈10×/19×/19.5× per fact even taking flash at the pessimistic end of its band and
every rival at its published best), and flash and qwen were the only arms to
finish all six runs while pro and glm each lost one to the 600 s REPL wall —
but every arm is n=1, flash's headline 32/34 failed to reproduce (three live
task-4 replicates scored 3/6, 5/6, 4/6 against the published 6/6, correcting the
arm to **29–31/34**), and the flash-versus-qwen margin collapses to +1..+3 inside
a ±3 band, so "flash is the matrix winner" is true on cost and undetermined on
facts. The holdout — run once, after the recipe and model were chosen, never fed
back — scored **10/14 (coverage 0.714) against 0.853–0.912 on the fitness set, a
real drop of 0.14–0.20**, with `runsOk` 2/2, criteria 2 and 3 clean on both runs,
44/44 citations resolving and the fan-out firing on both. gen-4, an ensemble
mutation measured as two replicates instead of one round, was **rejected**: four
training anchoring terms sit verbatim in its own prompt and the fact rule is a
substring test, so its one positive claim cannot be distinguished from the model
reading its own instructions; its holdout regressed to 8/14 identically in both
replicates; and its fitness union tied the pooled parent at 32/34 on the
identical two residual facts — so `optimizer/current/` was reset to gen-1 and
that write is, for the first time on this pointer, attributed. 67 recorded
round-2 run records and $7.46 of khal spend went into choosing what to shoot
with; the shot itself cost $0.22 and **failed the gate**.
