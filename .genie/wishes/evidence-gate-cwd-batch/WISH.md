# Wish: evidence-gate verifiers pinned to cwd, file checks batched

| Field | Value |
|-------|-------|
| **Status** | SHIPPED |
| **Slug** | `evidence-gate-cwd-batch` |
| **Date** | 2026-09-28 |
| **Author** | Felipe Rosa |
| **Appetite** | small |
| **Branch** | `wish/evidence-gate-cwd-batch` |
| **Repos touched** | automagik-dev/genie |
| **Design** | _No brainstorm — direct wish_ |

## Summary

The first routed `evidence-gate` run (`wf_211e745f-222`, reviewing PR #3073) exposed two defects:

- **Verifiers left the declared `cwd`.** Sonnet verifiers ran some checks from the repo root instead, and one diff compared `dev` against itself. Only the Opus synthesis caught it.
- **Every file check costs a full agent.** Six file-existence checks cost 337k of the run's 741k tokens, because each agent carries about 56k tokens of fixed context.

This wish pins every verifier command to `cwd` and checks that mechanically. It moves all declared file checks into one verifier. It also adds the two runtime rules the research-sweep audit found missing from the Sonnet refine overlay. This is the last fix before the stable cut.

## Scope

### IN

- In `evidence-gate.js`, verifier prompts require every shell command to start with `cd '<cwd>' && `. The script marks as `insufficient` any item whose reported `command` does not start with that prefix, never counting it as a pass.
- In `evidence-gate.js`, all declared file items go to ONE `verify:files` agent (worker tier, effort low), which returns one result per file id. Command items stay one verifier each. A file id missing from that agent's answer is `insufficient`.
- `meta` text, the README row and any pinning tests are updated to "one verifier for all declared files plus one per declared command".
- `skills/refine/prompts/claude-sonnet-5-5.md` gains, under its runtime/report concerns:
  - a `max_tokens` stop is a failed attempt even when the JSON is valid, so retry;
  - without structured outputs, parse the LAST JSON value in the text blocks, and retry once if expected fields are missing.

### OUT

- Any change to the synthesis or report stages, the verdict vocabulary, the contract shape or the `MAX_VERIFIERS` ceiling semantics for commands.
- Batching in other workflows (docs-audit, skill-audit); a follow-up once this is measured.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Enforce the `cd '<cwd>' && ` prefix mechanically in the script, not only in prose | The failure was a model ignoring prose. The script is the only fail-closed layer. |
| 2 | Batch the file items only. Commands stay isolated. | File checks are cheap and uniform. Commands can be slow or stateful, and each needs its own observed exit code. |
| 3 | Put the Sonnet overlay additions in the runtime-concerns section | They are caller-side parsing and retry rules, not prompt text (refine D6). |

## Simplicity Case

- **Simplest complete design:** one prompt clause, one prefix check, and one merged agent in place of N file agents.
- **Added machinery:** none. The batch reuses `VERIFY_SCHEMA` items as an array field.
- **Deferred until measured:** batching command items; batching in other fan-out workflows.
- **Complexity removed:** N−1 file agents per run, about 56k tokens each.

## Dependencies

**depends-on:** sonnet-opus-worker-routing
**blocks:** none

## Success Criteria

- [ ] A verifier result whose `command` lacks the `cd '<cwd>' && ` prefix is `insufficient`. A test proves it.
- [ ] A contract with k files and m commands dispatches exactly 1 + m verifier agents (m when k = 0). A test proves it.
- [ ] A file id missing from the batch answer is `insufficient`.
- [ ] The routing test still passes: `verify:files` is mapped to worker. The parity and meta tests pass.
- [ ] `grep -F 'even when its text holds valid JSON' skills/refine/prompts/claude-sonnet-5-5.md && grep -F 'parse the last JSON value' skills/refine/prompts/claude-sonnet-5-5.md` exits 0.
- [ ] A command result whose remainder after the prefix differs from `run` is `insufficient`. A null, missing, duplicate or unknown batch id behaves as the batch contract says. Tests prove both.
- [ ] `bun run check` exits 0.

## Execution Strategy

### Wave 1 (sequential)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 1 | engineer | medium — trust-boundary workflow script, fail-closed logic and its tests | opus | cwd pin, file batch and overlay rules |

**Global constraints:**
- Each existing stage keeps its effort. Routing uses `model: modelFor('worker'|'reasoner')` only.
- No schema field is removed. Fences and read-only rules stay verbatim, except for the one batch clause the batch contract names.
- Biome: single quotes, 2-space indent, 120 columns.

## Execution Groups

### Group 1: cwd pin, file batch, overlay rules

**Goal:** evidence-gate verifies inside `cwd` or reports `insufficient`, and it checks every declared file with one agent.

**Deliverables:**
1. `.claude/workflows/evidence-gate.js`: the prefix clause in the file and command prompts, the script-side prefix check, and a `verify:files` batch agent with per-id results mapped back onto the items.
2. `.claude/workflows/README.md`: the evidence-gate row and its section describe the new fan-out.
3. `scripts/workflow-routing.test.ts`: `verify:files` mapped to worker.
4. `plugins/dsh-workflow-loader/src/dialect.test.ts`: the evidence-gate effort count goes from 3 to 4, and the catalog total from 38 to 39.
5. The logic tests for the prefix check and the dispatch count (add `scripts/evidence-gate-workflow-logic.test.ts` if none exists, in the house style of `wish-workflow-logic.test.ts`).
6. `skills/refine/prompts/claude-sonnet-5-5.md`: the overlay edits above.

**Batch contract (binding):**
- **Prefix rule.** The reported command for a command item must be EXACTLY `cd <Q><cwd><Q> && <run>`, where <Q> is nothing, `'` or `"` (the same on both sides). The script checks both the prefix and that the remainder equals `item.run`; any mismatch makes the item `insufficient`. For file items, every check command starts with `cd '<cwd>' && `. `ITEM_RULE` and `commandPrompt` change from "verbatim, do not extend" to "exactly `cd '<cwd>' && ` followed by the command verbatim".
- **Batch clause.** Command verifiers keep `FROZEN`'s "judge ONLY the one item". The batch agent gets its own clause: "judge ONLY the declared file items listed, one result per id". This is the only exception to "fences stay verbatim".
- **Ceiling.** The batch uses ONE of the `MAX_VERIFIERS` slots, so when any file is declared, commands get `MAX_VERIFIERS - 1`. The batch holds at most `MAX_FILES_PER_BATCH = 64` files; files beyond that are `insufficient` with a ceiling reason. The 1 + m agent count holds under the ceilings, and a test covers the over-ceiling case.
- **Mapping.** The batch schema is `{results: [VERIFY item + required id]}`.
  - A null answer adds `verify:files` to `notConvened` once and makes every file `insufficient`.
  - Missing, duplicate and unknown ids:
    - duplicate ids: the first answer wins; later ones are ignored and logged;
    - unknown ids: rejected and logged;
    - any file left without a valid answer is `insufficient`.
  - Rows come back in declaration order, and the log line for responses counts AGENTS, not items.
- **Overlay.** Extend the existing line-21 sentence `a max_tokens stop is a failed attempt` with `, even when its text holds valid JSON — retry`. Add one sentence containing `parse the last JSON value` and `retry once`. Both phrases can be checked with grep.

**Interfaces:**
- Consumes: `TIERS`/`modelFor` from routing.
- Produces: the label `verify:files` (worker).

**Acceptance Criteria:**
- [ ] Every Success Criterion above.

**Validation:**
```bash
bun test --timeout 60000 scripts/workflow-routing.test.ts scripts/workflows-meta.test.ts scripts/workflows-model-policy.test.ts scripts/evidence-gate-workflow-logic.test.ts plugins/dsh-workflow-loader/src/dialect.test.ts && bun run check
```

**depends-on:** none

---

## QA Criteria

- [ ] A live `evidence-gate` run on a worktree that is not the repo root reports `cd '<that path>' && …` on every item, and dispatches one `verify:files` agent.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| The batch agent silently drops a file | Medium | A missing id is `insufficient`, and a test covers it |
| The prefix check rejects a correct but differently quoted `cd` | Low | The batch contract accepts exactly three quoting forms (none, `'` or `"`) around the exact cwd, and each form has a test |

---

## Review Results

_The read-only reviewer returns evidence; the invoking orchestrator appends a timestamped block here after plan, execution, and PR reviews._

### 2026-09-28T23:21:53Z — plan review — SHIP

- Round 1 (23:20:55Z) FIX-FIRST with five findings, all folded in: the dialect.test effort count, the undefined ceiling, the prompts contradicting the prefix, batch mapping, and the overlay duplicating line 21.
- Round 2 SHIP. One non-blocking inconsistency about quoting, resolved: three quoting forms are accepted.

### 2026-09-28T23:41:01Z — execution review — SHIP

- **Gate:** `bun run check` passed at `953f31990` (3049 pass / 0 fail).
- **Round 1 (23:38:36Z): SHIP**, with two fail-closed gaps.
  - Batching let a file borrow another file's evidence.
  - A pass was not compared against `expectExit`; this one predates the change.
  - Both are closed in `d937a52cf`.
- **Round 2: SHIP.** Its note 1 (the batch prompt now asks each check to name its path) is taken. Its note 2 (substring matching of paths) is deferred as narrow.
- **Live QA (`wf_2cfdabeb-3e7`):** every item was pinned `cd '<egate>' && …`, and 4 agents ran in total (1 `verify:files`). The run took 229k tokens and 0.7 min, against 741k and 1.9 min before the change.

### 2026-09-28 — SHIPPED

- PR #3077 merged into dev as `cb03c14e5`, with all 19 checks green (linux and darwin).

---

## Files to Create/Modify

```
.claude/workflows/evidence-gate.js
.claude/workflows/README.md
scripts/workflow-routing.test.ts
scripts/evidence-gate-workflow-logic.test.ts
plugins/dsh-workflow-loader/src/dialect.test.ts
skills/refine/prompts/claude-sonnet-5-5.md
```
