# Wish: Opus 5.5 / Sonnet 5.5 worker routing, per-model refine, and a wish run report

| Field | Value |
|-------|-------|
| **Status** | IN_PROGRESS |
| **Slug** | `sonnet-opus-worker-routing` |
| **Date** | 2026-09-28 |
| **Author** | Felipe Rosa |
| **Appetite** | medium |
| **Branch** | `wish/sonnet-opus-worker-routing` (one branch per group: `wish/sonnet-opus-worker-routing-g<n>`) |
| **Repos touched** | automagik-dev/genie |
| **Design** | [sonnet-opus-worker-routing](../../brainstorms/sonnet-opus-worker-routing/DESIGN.md) |

## Summary

This wish routes the saved workflows' agents by role: Sonnet 5.5 for reading and mechanical stages, Opus 5.5 for judging, synthesis, review and code. It rewrites each stage's prompt through `refine --target <model>`, using the guide for that model. Every wish run then gets a report of tokens and time, read from the run record the runtime already writes, and a ledger row, so averages per wish can be tracked and the workflow tuned against them.

## Scope

### IN

- `refine --for claude --target sonnet|opus`, with one guidance overlay per target and a refreshed `Checked:` line.
- A `TIERS` table and a tier on every `agent()` call in the 10 scripts under `.claude/workflows/`, each stage prompt refined for its tier's model (per-stage `effort` unchanged), and `workfly`'s SPEC requiring a new `tier` field.
- `genie wish report <runId> [--append] [--summary]` over the run record, the machine-local `<GENIE_HOME>/metrics/wish-runs.jsonl` ledger (design D9/D10), and the `wish` skill's Relay step that calls it.
- One paired `wish` run (routed vs all-Opus) and one routed `research-sweep` run, recorded in the ledger and the README's Measured runs.

### OUT

- Monetary cost or a pricing table; new Phoenix code (the ledger's `runId` + session id join to existing `backfill.ts` traces).
- The skills' native subagent dispatch; `xhigh`/`max` effort; Haiku or Fable as workers.
- Delivering this through `wish.js` (it refuses its own trust-boundary path; `/work` runs these groups).

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Settled in the design, D1–D10: a `TIERS` table per script; precedence `gateModel`/`publishModel` > `args.model` > `TIERS[tier].model`. | The design passed independent review. |
| 2 | worker (Sonnet 5.5): readers, shards, characterizers, signals, locate, facts, plan:shard, verify:static, gate, publisher, reporters. reasoner (Opus 5.5): judges, synthesis, spec, review, refuters, lenses, executor and fix. Every stage keeps its current effort. | Design D2 and D3. |
| 3 | The report counts only tokens and time from the run record. The row shape, required and nullable fields, and summary semantics follow design D9; the ledger is machine-local (D10). | The operator ruled out monetary cost and needless code (D8). |

## Simplicity Case

- **Simplest complete design:** a constant table per script, two overlay files, one read-only verb over an existing JSON file, and one append-only JSONL ledger.
- **Added machinery:** `--target`, because the operator requires refinement specific to each model; the ledger, because averages must outlive a session directory.
- **Deferred until measured:** a Phoenix dataset for wish runs, at ≥ 20 ledger rows; `xhigh` for reasoners, once a paired run shows a quality gain.
- **Complexity removed:** the pricing table, a shared routing module, a model allowlist and any daemon.

## Dependencies

**depends-on:** none
**blocks:** none

## Success Criteria

- [ ] Every Success Criterion in the linked design holds.
- [ ] `bun run check` exits 0 on the integrated branch.
- [ ] The ledger and the README carry the paired `wish` run and the `research-sweep` run, with tokens and minutes per stage.

## Execution Strategy

### Wave 1 (parallel)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 1 | engineer | low — two markdown overlays, a switch rule in one skill, one static test | sonnet | Per-model refine + routing test |
| 2 | engineer | medium — new CLI verb, fixture-pinned record format, skill relay step | opus | Wish run report and ledger |

### Wave 2 (parallel, after Group 1)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 3 | engineer | high — trust-boundary scripts, prompt contracts, parity tests | opus | Route and refine wish, workfly, evidence-gate, council, pm-ledger-verify |
| 4 | engineer | high — same shape across the fan-out scripts | opus | Route and refine docs-audit, research-sweep, skill-audit-sweep, skill-intake, observability-review, plus the README routing note |

### Wave 3 (after Groups 2–4)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 5 | engineer | medium — live runs, measurement only | opus | Paired evaluation, ledger rows and Measured runs |

**Global constraints:**
- Model ids are the aliases `'sonnet'` and `'opus'`. Each stage keeps its current `effort`.
- Precedence: `gateModel`/`publishModel` (wish.js, their own stages) > `args.model` (every stage) > `TIERS[tier].model`.
- A prompt rewrite never changes a `schema`, an injection fence, a read-only or permission rule, or an exact string.
- Biome: single quotes, 2-space indent, 120-column lines, trailing commas; no `console.log` in `src/`.
- The report reads only these fields: `runId, workflowName, durationMs, totalTokens, totalToolCalls, agentCount, result.state, workflowProgress[type == workflow_agent].{label, model, tokens, toolCalls, durationMs}`.
- Linux and macOS both stay green.

## Execution Groups

### Group 1: Per-model refine

**Goal:** `refine` rewrites a Claude prompt using the method for its destination model.

**Deliverables:**
1. `skills/refine/prompts/claude-sonnet-5-5.md`: the Sonnet 5.5 clauses from design D6, with the official URL.
2. `skills/refine/prompts/claude-opus-5-5.md`: Opus 5.5 guidance taken from the official page ([Opus 5.5 guide](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5)).
3. `skills/refine/SKILL.md`: `--target sonnet|opus` under `--for claude` only, loading both files. The baseline row moves to the 5.5 models. `Checked: 2026-09-28`.
4. `skills/refine/prompts/claude.md` line 3: the baseline header moves to Opus 5.5 with its guide URL and the checked date 2026-09-28, so it matches the SKILL.md table.
5. `scripts/workflow-routing.test.ts`: for every `.claude/workflows/*.js` that declares `const TIERS`, every `agent(` call derives `model` from `TIERS` under the D1 precedence (wish.js: gate/publish overrides first). It fails on a call without one. Scripts without `TIERS` are listed as skipped, not failed.

**Interfaces:**
- Consumes: none
- Produces: `refine --for claude --target <sonnet|opus> @<file>`, used by Groups 3 and 4 on each prompt builder.

**Acceptance Criteria:**
- [ ] `--target` without `--for claude`, a duplicate `--target`, or an unknown value is refused before any file is read.
- [ ] The skill parity and authoring tests pass; the routing test passes with all 10 scripts skipped.

**Validation:**
```bash
bun test scripts/workflow-routing.test.ts && bun test scripts/ src/__tests__ && bun run lint
```

**depends-on:** none

---

### Group 2: Wish run report and ledger

**Goal:** Every wish run leaves a tokens-and-time report and one ledger row. Averages are one command away.

**Deliverables:**
1. `genie wish report <runId> [--append] [--summary] [--variant <name>]` in `src/term-commands/wish.ts`. It finds `~/.claude/projects/*/*/workflows/<runId>.json` (or takes `--record <path>`), prints totals and per-stage rows, and takes `state` from `result.state` when present.
2. `--append` writes one row, in the design D9 shape, to `<GENIE_HOME>/metrics/wish-runs.jsonl`. It refuses a `runId` that is already there. A record with `result: null` appends with `state: null`.
3. `--summary` groups by `workflowName` and `variant`, and prints n, mean tokens and mean minutes for each group, plus the merge-ready rate for wish rows (a null state counts as not merge-ready), per design D9.
4. A colocated test with a fixture record, including one record with a required field removed, which must exit 2, and one with `result: null`.
5. In `skills/wish/SKILL.md`, the Relay section runs `genie wish report <runId> --append` after every run and relays its output. The `CLAUDE.md` row for `wish` names the verb (run the drift guard).

**Interfaces:**
- Consumes: none
- Produces: the ledger row shape above; Group 5 appends with `--variant routed|all-opus`.

**Acceptance Criteria:**
- [ ] The totals and stage rows equal the fixture's fields. An unknown `runId` or a missing field exits 2.
- [ ] `--append` run twice on the same `runId` writes one row.
- [ ] `bun test src/__tests__/claude-md-drift.test.ts` passes.

**Validation:**
```bash
bun test src/term-commands/wish.test.ts src/__tests__/claude-md-drift.test.ts && bun run typecheck && bun run lint
```

**depends-on:** none

---

### Group 3: Route and refine: wish, workfly, evidence-gate, council, pm-ledger-verify

**Goal:** These five scripts run each stage on its tier's model, with its prompt refined for that model.

**Deliverables:**
1. A `TIERS` table in each script. Every `agent()` call takes `model` from its tier under the D1 precedence and keeps its current `effort`. `council`, `pm-ledger-verify` and `evidence-gate` gain the `model` arg.
2. Each `*Prompt()` builder in these scripts rewritten through `refine --for claude --target <tier model>`.
3. `workfly`'s SPEC gains a required `tier: enum(worker, reasoner)` on every agent (the free-text `role` stays), and the drafted script is told to emit `TIERS`.
4. These five scripts declare `TIERS`, so Group 1's `scripts/workflow-routing.test.ts` now checks them; this group does not edit the test.

**Interfaces:**
- Consumes: Group 1's `--target`.
- Produces: none. (`TIERS` shape: `{ worker: { model: 'sonnet' }, reasoner: { model: 'opus' } }`; effort stays per call.)

**Acceptance Criteria:**
- [ ] The routing test passes for these five scripts. The existing workflow parity tests pass unchanged.
- [ ] A diff review confirms no schema, fence or exact-string change in any prompt.

**Validation:**
```bash
for w in wish workfly evidence-gate council pm-ledger-verify; do grep -q 'const TIERS' .claude/workflows/$w.js || exit 1; done && bun test scripts/ && bun run lint
```

**depends-on:** Group 1

---

### Group 4: Route and refine: docs-audit, research-sweep, skill-audit-sweep, skill-intake, observability-review

**Goal:** The fan-out scripts get the same routing and refinement as Group 3.

**Deliverables:**
1. `TIERS` and tier-derived `model`, current `effort` on every `agent()` call in these five scripts. `observability-review` gains the `model` arg.
2. Each `*Prompt()` builder refined for its tier's model.
3. `.claude/workflows/README.md`: one routing paragraph (tiers, the precedence) and an updated `args` column wherever `model` was added.

**Interfaces:**
- Consumes: Group 1's `--target` and routing test, and the `TIERS` shape `{ worker: { model: 'sonnet' }, reasoner: { model: 'opus' } }`.
- Produces: none

**Acceptance Criteria:**
- [ ] `scripts/workflow-routing.test.ts` checks these five scripts and passes. The parity tests pass.
- [ ] No schema, fence or exact-string change in any prompt.

**Validation:**
```bash
for w in docs-audit research-sweep skill-audit-sweep skill-intake observability-review; do grep -q 'const TIERS' .claude/workflows/$w.js || exit 1; done && bun test scripts/ && bun run lint
```

**depends-on:** Group 1

---

### Group 5: Paired evaluation

**Goal:** Measure whether routing fits more work into fewer tokens and minutes without losing review quality.

**Deliverables:**
1. One `wish` run on a small open issue with the integrated branch's `wish.js` (`--variant routed`). One control run on the same objective with `args.model: 'opus'` (`--variant all-opus`), whose PR is closed as the control. Both are appended with `bun src/genie.ts wish report <runId> --append --variant <routed|all-opus>`. The Relay default `unlabeled` cannot separate the arms, so the variant flag is mandatory here.
2. One routed `research-sweep` run, appended with `bun src/genie.ts wish report <runId> --append --variant routed`.
3. Group 5 adds one assertion to `scripts/workflow-routing.test.ts`: all 10 scripts declare `TIERS`, with none skipped.
4. Rows in the README's Measured runs with tokens and minutes per stage, and one sentence reading the result with n stated.

**Interfaces:**
- Consumes: Group 2's verb and ledger; the scripts from Groups 3 and 4.
- Produces: the first ledger rows.

**Acceptance Criteria:**
- [ ] `bun src/genie.ts wish report --summary` prints the wish `routed` and `all-opus` groups and the research-sweep `routed` group.
- [ ] Both wish arms reach `merge-ready`, or the report names the stage that failed.

**Validation:**
```bash
bun src/genie.ts wish report --summary && bun run check
```

**depends-on:** Group 2, Group 3, Group 4

---

## QA Criteria

- [ ] On dev, `genie wish report <a real runId>` matches the run record by hand.
- [ ] A routed `wish` run's record shows Sonnet 5.5 and Opus 5.5 model ids on the planned stages.
- [ ] `refine --for claude --target sonnet` on a sample worker prompt keeps its schema and limits.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| The run-record format changes | Medium | The verb reads named fields only, exits 2 when one is missing, and a fixture pins the format |
| A refined prompt loses a contract clause | High | Parity tests, plus a reviewer diff of each prompt |
| n = 1 per arm is noisy | Low | The result is reported as a direction, and the ledger keeps accumulating |

---

## Review Results

_The read-only reviewer returns evidence; the invoking orchestrator appends a timestamped block here after plan, execution, and PR reviews._

### 2026-09-28T20:33:03Z — plan review — SHIP

- Reviewer: claude-opus-5-5-design-reviewer (independent, read-only), against DESIGN.md digest `9116cf65f972763cc7518e46908e79c38d0269f1cffee98c64f393e05d171c04`.
- Round 1 (20:32:05Z) FIX-FIRST, 3 blocking: the routing test failed during the parallel wave; Group 5 called the installed `genie`; `--summary` grouping contradicted D9. All three were fixed.
- Round 2: SHIP. Minors applied (effort wording, Wave 2 label, Group 5 numbering, `claude.md` in Files). Groups 3 and 4 run `bun test scripts/` one after the other, never at the same time.

### 2026-09-28T21:25:23Z — execution review (Groups 1–4) — SHIP

- Reviewer: claude-opus-5-5-design-reviewer (independent, read-only), at `0263d0c37`.
- **Gate:** `bun run check` exited 0 at `dca0441f8` (3016 pass / 0 fail).
- **Round 1 — FIX-FIRST at `dca0441f8`.** One blocking finding: `skills/wish/SKILL.md` and the README `wish` row still said an unset model inherits the session model, which contradicts D1. Six non-blocking findings:
  - `wish report` crashed on malformed input;
  - missing stage fields were recorded as 0;
  - a positional runId was silently ignored under `--record`;
  - the routing test had no label→tier map;
  - an unrelated log wording changed;
  - four parity tests were edited, and all of them stayed equal or got stricter.
  All were fixed in `16aecb9a8`.
- **Round 2 — FIX-FIRST.** Refusing stages with no `tokens` or `durationMs` rejected 31 of the 254 real run records on this host, which are replayed or interrupted stages. Those fields are now nullable (`0263d0c37`), and a replay of all 254 records appends with 0 refused.
- **Round 3 — SHIP.**
- **Historical baseline** from the host's run records: 58 `wish` runs, 510,873 mean tokens, 22.1 mean minutes, merge-ready 14/58.
- **Confound for Group 5:** the all-Opus control also runs the worker prompts' think-first line on Opus.

---

## Files to Create/Modify

```
skills/refine/SKILL.md
skills/refine/prompts/claude.md
skills/refine/prompts/claude-sonnet-5-5.md
skills/refine/prompts/claude-opus-5-5.md
src/term-commands/wish.ts
src/term-commands/wish.test.ts
skills/wish/SKILL.md
CLAUDE.md
# ledger is machine-local: <GENIE_HOME>/metrics/wish-runs.jsonl (not in the repo)
.claude/workflows/{wish,workfly,evidence-gate,council,pm-ledger-verify}.js
.claude/workflows/{docs-audit,research-sweep,skill-audit-sweep,skill-intake,observability-review}.js
.claude/workflows/README.md
scripts/workflow-routing.test.ts
```
