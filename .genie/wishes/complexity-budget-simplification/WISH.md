# Wish: Complexity Budget Simplification

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `complexity-budget-simplification` |
| **Date** | 2026-05-01 |
| **Author** | Codex |
| **Appetite** | medium |
| **Branch** | `wish/complexity-budget-simplification` |
| **Repos touched** | `genie` |
| **Design** | _No brainstorm - direct wish_ (origin: 2026-05-01 council discussion on Biome cognitive complexity) |

## Summary

Recalibrate Genie's Biome cognitive-complexity budget so linear command/orchestration code can stay readable instead of being split purely to satisfy the default score of 15. Raise the product-code budget to 25, preserve visibility for true hotspots above 25, and add a lightweight drift check so the rule remains useful instead of becoming forgotten lint noise.

The goal is not to make complex code acceptable everywhere. The goal is to remove artificial fragmentation in the 16-25 range while keeping high-risk workflows visible for review and follow-up architecture work.

## Scope

### IN

- Configure `lint/complexity/noExcessiveCognitiveComplexity` for `src/**` and `packages/**` with `maxAllowedComplexity: 25` at warning level.
- Keep scripts/plugins exemptions as-is unless baseline evidence shows a specific reason to change them.
- Create a complexity budget baseline/report that records current warning count, max score, and explicit complexity suppression count.
- Add a small drift check script and package script that reports complexity warnings and fails only when the agreed budget regresses.
- Remove obsolete complexity suppressions and comments that exist only because the old threshold was 15, when Biome marks them unused under the new threshold.
- Document the policy: complexity >25 is a review trigger; complexity 16-25 is acceptable when the flow is linear and tested.

### OUT

- No broad refactor of `agents.ts`, `scheduler-daemon.ts`, `omni-bridge.ts`, or executor internals.
- No disabling of `noExcessiveCognitiveComplexity`.
- No hard CI failure on every existing complexity warning unless it exceeds the new ratcheted baseline.
- No architectural rewrite of the four current >25 hotspots in this wish.
- No changes to Biome rules unrelated to cognitive complexity, except removing an unused suppression if it blocks clean validation.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Raise product-code cognitive complexity max from 15 to 25 | Current warnings at 16-23 mostly reflect linear CLI/orchestration branches where splitting can increase indirection. A budget of 25 suppresses low-value churn while still exposing functions scored 29, 36, 37, and 42. |
| 2 | Keep the rule at `warn`, not `error`, for now | The rule is a maintainability signal, not a release gate. Making it an error before the baseline is stable would create mechanical refactor pressure. |
| 3 | Preserve high-hotspot visibility above 25 | The current >25 functions are real review targets: `checkPrerequisites`, `dbLsCommand`, `dbMigrateV1Command`, and `trustAction`. Raising the threshold should not hide them. |
| 4 | Add a drift check instead of relying on human memory | The repo already has discipline scripts. A small budget script keeps the new policy measurable without making every Biome warning a blocker. |
| 5 | Delete obsolete suppressions before deleting helpers | Suppression cleanup is low-risk and measurable. Inlining helpers should happen only where tests prove behavior is unchanged and LOC/readability actually improve. |

## Success Criteria

- [ ] `biome.json` sets `noExcessiveCognitiveComplexity` to warning level with `maxAllowedComplexity: 25` for `src/**` and `packages/**`.
- [ ] Baseline report exists at `.genie/wishes/complexity-budget-simplification/complexity-baseline.md`.
- [ ] Complexity warnings under the new budget are limited to scores above 25, with a documented expected count.
- [ ] A package script exists to run the complexity budget drift check.
- [ ] Obsolete complexity suppressions created by the threshold raise are removed or explicitly justified.
- [ ] `bun run lint`, `bun run typecheck`, and the new complexity budget script pass.
- [ ] Documentation explains when to prefer linear code over helper extraction and when complexity >25 requires a follow-up design/refactor.

## Execution Strategy

### Wave 1 (sequential)

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Capture baseline and update Biome complexity budget to 25 |
| 2 | engineer | Add complexity drift check and package script |
| 3 | engineer | Remove obsolete suppressions/comments exposed by the new threshold |
| 4 | engineer | Document policy and hotspot follow-ups |
| review | reviewer | Review the wish results against budget, behavior, and DX criteria |

## Execution Groups

### Group 1: Baseline and Budget Calibration

**Goal:** Prove the new threshold preserves signal before changing the rule.

**Deliverables:**
1. `.genie/wishes/complexity-budget-simplification/complexity-baseline.md` with:
   - current Biome wall time
   - current complexity warning count at max 15
   - projected retained warning count above max 25
   - explicit complexity suppression count
   - list of retained >25 hotspots
2. `biome.json` updated so `src/**` and `packages/**` use:
   - `level: "warn"`
   - `options.maxAllowedComplexity: 25`

**Acceptance Criteria:**
- [ ] Baseline report records the observed starting point: 12 unsuppressed complexity warnings and 16 explicit complexity suppressions.
- [ ] Baseline report lists the retained >25 functions and their scores.
- [ ] `biome.json` remains valid against Biome 1.9.4.
- [ ] `bunx biome check . --reporter=summary` still completes successfully.

**Validation:**
```bash
bunx biome check . --reporter=summary
bunx biome check . --diagnostic-level=warn --max-diagnostics=none
test -f .genie/wishes/complexity-budget-simplification/complexity-baseline.md
```

**depends-on:** none

---

### Group 2: Complexity Budget Drift Check

**Goal:** Make the new policy measurable without turning all complexity warnings into a hard gate.

**Deliverables:**
1. `scripts/complexity-budget.ts` that runs or parses Biome diagnostics and reports:
   - cognitive-complexity warning count
   - max observed score
   - number of explicit `biome-ignore lint/complexity/noExcessiveCognitiveComplexity` suppressions
   - retained hotspot list
2. `package.json` script, e.g. `lint:complexity-budget`.
3. Budget constants aligned to Group 1 baseline.

**Acceptance Criteria:**
- [ ] The script exits 0 when the current baseline is not worse.
- [ ] The script exits non-zero if warning count, max score, or suppression count exceeds the ratcheted budget.
- [ ] The script prints actionable file/function lines, not only counts.
- [ ] The script does not require a running database, tmux session, TUI, or network access.

**Validation:**
```bash
bun run lint:complexity-budget
bun run typecheck
```

**depends-on:** Group 1

---

### Group 3: Obsolete Suppression Cleanup

**Goal:** Reduce lint-era clutter that becomes unnecessary once the budget is 25.

**Deliverables:**
1. Remove unused `biome-ignore lint/complexity/noExcessiveCognitiveComplexity` comments surfaced by Biome after the threshold increase.
2. Remove stale comments that say code was extracted only to stay under the old complexity cap, when the helper/comment no longer explains a real boundary.
3. Optional: inline one low-risk helper only if all of these are true:
   - it was introduced solely for the old complexity budget
   - the resulting function remains at or below 25
   - nearby tests already cover the behavior
   - net LOC decreases

**Acceptance Criteria:**
- [ ] Biome reports no unused complexity suppressions.
- [ ] Any remaining complexity suppression explains why extraction would hurt clarity or safety.
- [ ] Any optional inline cleanup has before/after LOC recorded in the baseline report or a short note in the wish directory.
- [ ] No behavior-oriented test snapshots are changed without a specific rationale.

**Validation:**
```bash
bunx biome check . --diagnostic-level=warn --max-diagnostics=none
bun test
```

**depends-on:** Group 1

---

### Group 4: Policy and Hotspot Follow-Up

**Goal:** Turn the new budget into a durable engineering convention.

**Deliverables:**
1. Update `CLAUDE.md` with a short complexity-budget policy:
   - prefer linear code when it reads as one workflow
   - split when there is a real policy, IO, state-machine, or presentation boundary
   - suppress only with a concrete reason
   - treat >25 as review-triggering architecture debt
2. `.genie/wishes/complexity-budget-simplification/hotspots.md` with verdicts for the retained >25 functions:
   - leave as linear for now
   - simple local refactor candidate
   - needs a separate architecture wish

**Acceptance Criteria:**
- [ ] `CLAUDE.md` documents the budget and review expectations in 15 lines or fewer.
- [ ] `hotspots.md` has one row per retained >25 function.
- [ ] Every retained >25 hotspot has a named follow-up decision.
- [ ] No large refactor is performed inside this policy group.

**Validation:**
```bash
rg -n "complexity budget|cognitive complexity|maxAllowedComplexity" CLAUDE.md biome.json .genie/wishes/complexity-budget-simplification
bun run lint:complexity-budget
```

**depends-on:** Group 2

---

## QA Criteria

_Verified on dev after merge._

- [ ] `bun run lint` passes with the new Biome rule shape.
- [ ] `bun run typecheck` passes.
- [ ] `bun run lint:complexity-budget` passes and prints counts.
- [ ] Complexity warnings below or equal to 25 do not force helper extraction.
- [ ] Complexity warnings above 25 are still visible in the budget report.
- [ ] Existing command behavior is unchanged for any file touched outside config/docs/scripts.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Raising the threshold hides a genuinely tangled 20-25 function | Medium | Keep threshold at warning level, add drift script output, and require review judgment for changed functions near the budget. |
| The budget script becomes another brittle lint tool | Medium | Keep it read-only, dependency-light, and scoped to one rule. It should report clear file/function lines. |
| Cleanup inlines helpers that were serving real boundaries | Medium | Optional inline cleanup must show net LOC decrease, stay <=25, and pass nearby tests. Otherwise only remove obsolete suppressions/comments. |
| Future contributors treat 25 as permission to write dense code | Medium | Document that 25 is a ceiling for linear workflows, not a target. >25 remains architecture debt. |
| Biome output format changes | Low | Pin parsing to Biome 1.9.4 behavior already used by the repo; fall back to summary counts if detailed parsing fails. |

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
MODIFY  biome.json
MODIFY  package.json
MODIFY  CLAUDE.md
CREATE  scripts/complexity-budget.ts
CREATE  .genie/wishes/complexity-budget-simplification/complexity-baseline.md
CREATE  .genie/wishes/complexity-budget-simplification/hotspots.md
MODIFY  source files only if Group 3 finds obsolete complexity suppressions/comments
```
