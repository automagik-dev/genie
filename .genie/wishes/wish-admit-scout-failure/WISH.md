# Wish: A failed admission scout reports instead of crashing

| Field | Value |
|-------|-------|
| **Status** | APPROVED |
| **Slug** | `wish-admit-scout-failure` |
| **Date** | 2026-09-22 |
| **Author** | Felipe Rosa |
| **Appetite** | small |
| **Branch** | `wish/wish-admit-scout-failure` |
| **Repos touched** | automagik-dev/genie |
| **Design** | _No brainstorm — direct wish_ |

## Summary

When the admission scout in `.claude/workflows/wish.js` throws or answers nothing, the two early `return finish(...)` calls meant to report that failure run before `const scout` is initialised, and `finish()` reads `scout.mikro`, so the run dies with `ReferenceError: Cannot access 'scout' before initialization` instead of returning `missed` or `refused` with a report. This wish hoists the one binding `finish()` reads from a later stage beside the other run-state `let`s, so every early return renders, and adds behavior tests for the four admission failure paths. Closes #3040.

## Scope

### IN

- In `.claude/workflows/wish.js`: declare `let scoutMikro = null` beside the other run-state `let` bindings (after `let stageReached = 'Admit'`), assign `scoutMikro = scout.mikro` right after `const scout = objectOf(scoutStep.value)`, and change the `finish()` view to `scoutMikro: offloadOrAbsent(scoutMikro, MIKRO_SCOUT_AGENT)`.
- In `scripts/wish-workflow-behavior.test.ts`: let the fake agent answer `null` (the stage returned nothing) or throw (the canned value is an `Error`) without schema validation, widen `WishResult` with `route`, `stageReached` and `notConvened`, and add four cases: scout null, scout throws, judge null, judge throws.
- In `scripts/wish-workflow-mikro.test.ts`: update the one pinned literal at line 85 to the new `finish()` spelling.

### OUT

- The gate's hook-system assumption (the separate `wish-gate-no-hook-system` wish owns `gatePrompt` and the `hooksLive` stops).
- Any restructuring of `finish()` into a stage-populated view object; the issue offers it as an alternative, and one hoisted binding is the whole defect.
- Any change to the refusal/missed wording, the states, the stage roster, the prompts, the schemas, or the model/effort policy.
- `skills/wish/SKILL.md` and the front-door parity files: the documented states already promise `missed` when a stage throws or returns nothing.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Hoist one `let scoutMikro = null` and have `finish()` read it, instead of hoisting `scout` itself | `finish()` reads exactly one field of the scout; a hoisted `scout` would turn a `const` the rest of the Admit stage relies on into a mutable binding. The mechanical sweep of every top-level `const`/`let` declared after line 1037 found `scout` as the only real read from `finish()`/`render()` (the other name hits are prose inside prompt strings or `view.*` properties). |
| 2 | When the scout never answered, the report still shows `Offload: wish-context — not reported by the stage` | `offloadOrAbsent(null, …)` already renders absence as a fact, which is this file's rule ("absence is a fact the report shows, never silence"); the footer names `admit:scout` as silent for the null case. No new branch in `render()`. |
| 3 | Test null and throw through the existing label-keyed fake agent rather than a second harness | The harness already records every unexpected label and every schema problem; teaching it `null` and `Error` answers keeps every scenario asserting both lists stay empty. |

## Simplicity Case

- **Simplest complete design:** one hoisted `let`, one assignment, one changed read in `finish()`; four behavior tests; one pinned literal updated.
- **Added machinery:** none. The fake agent gains two early returns (`Error` → throw, `null` → return null), which is the smallest way to drive the two failure branches the file already has.
- **Deferred until measured:** a stage-populated view object (issue #3040's alternative) — adopt only if a second `finish()` read of a late binding appears.
- **Complexity removed:** the temporal-dead-zone failure mode on the two Admit early returns; a crash replaced by the `missed`/`refused` report the code already writes.

## Dependencies

**depends-on:** none
**blocks:** none

## Success Criteria

- [ ] A scout that answers nothing ends the run `refused`, route `report`, with the existing "The scout returned nothing" `blockedReason`, `notConvened` equal to `['admit:scout']`, the judge never called, and a rendered report.
- [ ] A scout that throws ends the run `missed`, `stageReached` `Admit`, `blockedReason` "The Admit stage threw: <message>", and the report carries `Stage reached: Admit`.
- [ ] A judge that answers nothing ends `refused`, route `report`; a judge that throws ends `missed` at `Admit`; both render a report.
- [ ] No `ReferenceError` from any early return: the new cases fail against the unpatched `wish.js` with `Cannot access 'scout' before initialization` and pass after the change.
- [ ] Every existing case in `scripts/wish-workflow-behavior.test.ts`, `scripts/wish-workflow-mikro.test.ts`, `scripts/wish-workflow-logic.test.ts` and `scripts/wish-workflow-parity.test.ts` stays green.

## Execution Strategy

### Wave 1 (sequential)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 1 | engineer | Low risk: three lines in one workflow file plus tests; the file is a trust-boundary path (workflows), so review is mandatory; effort medium | inherit | Hoist the scout offload binding and pin the four admission failure paths with behavior tests |

**Global constraints:**
- Base is `origin/dev`; conventional commits; commit messages end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Never run the full `bun test` or `bun run check` locally; run the focused test files and `bun run check:fast`, and let CI own the full gate.
- Never bypass a hook (`--no-verify`, `HUSKY=0`, `-c core.hooksPath`), never force-push, never merge.
- `.claude/workflows/wish.js` must stay a plain script whose leading `export const meta` is a pure literal (the behavior harness slices it off by regex).
- Public text names no private repository, other project or person.

## Execution Groups

### Group 1: Hoist the scout offload binding and test the admission failure paths

**Goal:** Every early `return finish(...)` in the Admit stage returns its report instead of throwing a `ReferenceError`.

**Deliverables:**
1. `.claude/workflows/wish.js`: `let scoutMikro = null` beside the run-state lets; `scoutMikro = scout.mikro` immediately after `const scout = objectOf(scoutStep.value)`; `finish()` reads `scoutMikro: offloadOrAbsent(scoutMikro, MIKRO_SCOUT_AGENT)`.
2. `scripts/wish-workflow-behavior.test.ts`: the fake agent throws a canned `Error` and returns a canned `null` before schema validation; `WishResult` gains `route: string`, `stageReached: string`, `notConvened: string[]`; a new `describe('wish.js admission failures report instead of crashing')` with cases (15) scout null, (16) scout throws, (17) judge null, (18) judge throws — each built from `canned()` with the stages after the failing one removed, and each run through `clean()` so `unexpected` and `problems` stay empty.
3. `scripts/wish-workflow-mikro.test.ts`: line 85's literal becomes `'scoutMikro: offloadOrAbsent(scoutMikro, MIKRO_SCOUT_AGENT)'`.
4. `.genie/wishes/wish-admit-scout-failure/WISH.md`: this document.

**Interfaces:**
- Consumes: none
- Produces: none (the returned result shape and the states are unchanged; only the crash path now returns them)

**Acceptance Criteria:**
- [ ] Case (15): `state` `refused`, `route` `report`, `blockedReason` contains `The scout returned nothing`, `notConvened` equals `['admit:scout']`, no `admit:judge` prompt recorded, `report` contains `# Wish delivery` and `## Why this stopped`.
- [ ] Case (16): `state` `missed`, `stageReached` `Admit`, `blockedReason` contains `The Admit stage threw: <sentinel>`, `report` contains `Stage reached: Admit`.
- [ ] Case (17): `state` `refused`, `route` `report`, `blockedReason` contains `The judge returned nothing`, `notConvened` equals `['admit:judge']`.
- [ ] Case (18): `state` `missed`, `stageReached` `Admit`, `blockedReason` contains `The Admit stage threw: <sentinel>`.
- [ ] Cases (15) and (16) fail against the unchanged `wish.js` with `ReferenceError: Cannot access 'scout' before initialization` (watched failing first).
- [ ] The diff touches only the four files listed under Files to Create/Modify.

**Validation:**
```bash
bun test scripts/wish-workflow-behavior.test.ts scripts/wish-workflow-mikro.test.ts scripts/wish-workflow-logic.test.ts scripts/wish-workflow-parity.test.ts scripts/workflows-model-policy.test.ts scripts/workflows-meta.test.ts && bun run check:fast
```

**depends-on:** none

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] A `/wish` run whose scout agent fails (a transient upstream error) returns `missed` with `Stage reached: Admit` and a report, not a crash.
- [ ] A normal `/wish` run on dev still reaches `merge-ready` or `pr-open` with the scout offload line in its Admission section.
- [ ] `genie update` delivers the fixed `wish.js` to `~/.claude/workflows/wish.js` unchanged in shape (leading `export const meta` literal intact).

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| `/wish` refuses to deliver this change itself: `.claude/workflows/**` is on its consequence denylist, so admission routes `plan` | Low | Deliver through `work` or by hand with the same stages; the review is mandatory for a trust-boundary path. |
| The sibling wish for the hook-system gate edits the same two files (`wish.js`, the behavior test) | Medium | Land this one first (smaller, independent lines: ~1007, ~1057, ~1530); the sibling rebases onto it. The edited regions do not overlap. |
| A later edit adds another `finish()` read of a stage-local `const` | Low | The four new cases drive both Admit early returns; the Decision 1 sweep method is recorded in the PR body for reviewers. |

---

## Review Results

_The read-only reviewer returns evidence; the invoking orchestrator appends a timestamped block here after plan, execution, and PR reviews._

### Plan review — 2026-09-22T17:24:10Z

- **Verdict:** SHIP → status APPROVED (orchestrator plan review of the triage draft; the reviewer did not author the plan).
- **Evidence:** triage reproduced both crashes against the `origin/dev` body (`scout-null` and `scout-throw` → `ReferenceError: Cannot access 'scout' before initialization`; the judge paths already resolve); the TDZ sweep of every binding `finish()`/`render()` read found `scout` as the only late one; regression origin e1fadf651 / 09e9f6556 (#2944); open issue #3040 is the same defect with no linked PR.
- **Order:** this wish lands first; the sibling `wish-gate-no-hook-system` merges `dev` in after it.
- **Base:** `origin/dev` @ `4b3cf03ed85a65d4f50157fbbe887984cee4775a` (recorded here: `genie context` resolves the local `dev`, which is behind the remote on this host).


---

## Files to Create/Modify

```
.claude/workflows/wish.js
scripts/wish-workflow-behavior.test.ts
scripts/wish-workflow-mikro.test.ts
.genie/wishes/wish-admit-scout-failure/WISH.md
```
