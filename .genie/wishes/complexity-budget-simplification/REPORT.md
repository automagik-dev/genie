# Wish: Complexity Budget Simplification — Execution Report

**Branch:** `complexity-budget-simplification`
**Base:** `f5d7da63` (origin/dev)
**Engineer:** single-engineer manual orchestration (recovery dispatch after the
autonomous-team attempt lost work)

## Group 1 — Baseline + Budget Calibration

**Status:** DONE
**Commit:** `a5540129 feat(lint): raise cognitive-complexity budget to 25 + capture baseline`

### Files
- `biome.json` — `noExcessiveCognitiveComplexity` set to `{ level: "warn", options: { maxAllowedComplexity: 25 } }` for `src/**` and `packages/**` overrides.
- `.genie/wishes/complexity-budget-simplification/complexity-baseline.md` — created.

### Validation transcript

```
$ node_modules/.bin/biome check . --diagnostic-level=warn --max-diagnostics=none
Checked 778 files in 402ms. No fixes applied.
Found 27 warnings.

# 7 retained noExcessiveCognitiveComplexity (scores 26, 29, 29, 31, 36, 37, 42).
# 11 unused-suppression warnings introduced — fed into Group 3.
```

Acceptance criteria:
- [x] Baseline file present (`complexity-baseline.md`).
- [x] Retained >25 hotspots listed with scores.
- [x] `biome.json` valid against Biome 1.9.4 (no parse error, all 778 files checked).
- [x] `bunx biome check . --reporter=summary` exits 0.

## Group 2 — Complexity Budget Drift Check

**Status:** DONE
**Commit:** `492cdcf0 feat(scripts): add complexity-budget drift check`

### Files
- `scripts/complexity-budget.ts` — drift detector (parses biome diagnostics, counts suppressions via `git grep`, evaluates against ratcheted budget, exits non-zero on regression).
- `scripts/complexity-budget.test.ts` — 12 unit tests.
- `package.json` — `lint:complexity-budget` script added.

### Validation transcript

```
$ bun test scripts/complexity-budget.test.ts
 12 pass
 0 fail
 26 expect() calls
Ran 12 tests across 1 file. [134.00ms]

$ bun run lint:complexity-budget
Warnings (score > threshold): 7 / 7
Max observed score:           42 / 42
Explicit suppressions:        19 / 19      # before Group 3 cleanup
OK: budget intact.

$ bun run typecheck   # tsc --noEmit, no errors
```

Acceptance criteria:
- [x] Script exits 0 when current state ≤ ratcheted budget.
- [x] Script exits non-zero on regression of warning count, max score, or suppression count (covered by unit tests).
- [x] Output prints actionable file/function lines (each retained hotspot listed with score, path:line, function name).
- [x] No DB / tmux / TUI / network access — `existsSync`, `child_process.execSync` over biome and git grep only.

## Group 3 — Obsolete Suppression Cleanup

**Status:** DONE
**Commit:** `76f9191b chore(lint): remove 11 unused complexity suppressions`

### Files
- `src/lib/scheduler-daemon.ts` — removed `stop()` suppression.
- `src/services/executors/claude-sdk.ts` — removed `_processDelivery` suppression.
- `src/services/omni-bridge.ts` — removed `spawnSession` suppression.
- `src/term-commands/agents.ts` — removed `createTmuxPane`, `launchTmuxSpawn`, `resolveTeamAndResume` suppressions.
- `packages/genie-app/views/scheduler/ui/SchedulerView.tsx` — removed `statusBadge`, `RunStatusIcon` suppressions.
- `packages/genie-app/views/sessions/ui/SessionsView.tsx` — removed `groupTurns`, `buildTimelineSegments`, `onKey` suppressions.
- `scripts/complexity-budget.ts` — `maxSuppressionCount` ratcheted from 19 to 8 to lock in the cleanup.

### Validation transcript

```
$ node_modules/.bin/biome check . --reporter=summary
  Rule Name                                                    Diagnostics
  lint/complexity/noExcessiveCognitiveComplexity               7 (warning)
  lint/correctness/noUnusedVariables                           1 (warning)
  lint/suspicious/noExplicitAny                                1 (warning)
  suppressions/unused                                          5 (warning)
Checked 780 files in 368ms. Found 16 warnings.

# 0 unused complexity suppressions remain.
# The 5 remaining suppressions/unused warnings are pre-existing,
# non-complexity (noExplicitAny / noConsoleLog) and out of scope.

$ bun run lint:complexity-budget
Warnings (score > threshold): 7 / 7
Max observed score:           42 / 42
Explicit suppressions:        8 / 8
OK: budget intact.

$ bun run typecheck   # tsc --noEmit, no errors

$ bun test scripts/complexity-budget.test.ts
 12 pass / 0 fail
```

Acceptance criteria:
- [x] No unused complexity suppressions remain (5 unused suppressions left over are non-complexity, pre-existing).
- [x] Remaining 8 complexity suppressions still have explicit, descriptive reasons in their comments.
- [x] No optional helper inlining performed (kept Group 3 limited to suppression cleanup; the wish allowed only one low-risk inline if all four conditions held).
- [x] No behavior-oriented test snapshots changed.

## Group 4 — Policy and Hotspot Follow-Up

**Status:** DONE
**Commit:** _final group commit_

### Files
- `CLAUDE.md` — added `## Cognitive-complexity budget` section (5 bullet points, well under the 15-line cap).
- `.genie/wishes/complexity-budget-simplification/hotspots.md` — created with one verdict per retained >25 hotspot.

### Validation transcript

```
$ rg -n "complexity budget|cognitive complexity|maxAllowedComplexity" CLAUDE.md biome.json .genie/wishes/complexity-budget-simplification
biome.json:75:            "noExcessiveCognitiveComplexity": {
biome.json:77:              "options": { "maxAllowedComplexity": 25 }
biome.json:114:            "noExcessiveCognitiveComplexity": {
biome.json:116:              "options": { "maxAllowedComplexity": 25 }
CLAUDE.md:172:## Cognitive-complexity budget
…
.genie/wishes/complexity-budget-simplification/WISH.md:* multiple hits *
.genie/wishes/complexity-budget-simplification/hotspots.md:* multiple hits *
.genie/wishes/complexity-budget-simplification/complexity-baseline.md:* multiple hits *

$ bun run lint:complexity-budget
OK: budget intact.
```

Acceptance criteria:
- [x] `CLAUDE.md` policy ≤ 15 lines (5 bullet points + heading + intro).
- [x] `hotspots.md` has one row per retained >25 function (7 rows).
- [x] Each row carries a named verdict (`leave linear for now` / `simple local refactor candidate` / `needs separate architecture wish`).
- [x] No large refactor performed inside this group.

## Final budget snapshot

| Metric | Before | After | Budget |
|--------|-------:|------:|-------:|
| Unsuppressed cognitive-complexity warnings | 17 | 7 | 7 |
| Highest observed score | 42 | 42 | 42 |
| Explicit `biome-ignore` suppressions for the rule | 19 | 8 | 8 |
| Total Biome warnings (all rules) | 26 | 16 | n/a |
