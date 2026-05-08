# Complexity Baseline

**Date:** 2026-05-03
**Branch:** `complexity-budget-simplification`
**Biome version:** 1.9.4
**Source command:** `bunx biome check . --diagnostic-level=warn --max-diagnostics=none`
**Wall time:** 420 ms (778 files checked)

## Summary at the old threshold (`maxAllowedComplexity: 15`)

| Metric | Value |
|--------|-------|
| Total Biome warnings (all rules) | 26 |
| `noExcessiveCognitiveComplexity` warnings (unsuppressed) | 17 |
| Explicit `biome-ignore` suppressions for the rule | 19 (18 in product code, 1 in tests) |
| Highest observed complexity score | 42 (`dbMigrateV1Command`) |

> Note: the original wish text quoted 12 unsuppressed warnings and 16 suppressions. The baseline numbers above are what is actually present at the head of the worktree (`f5d7da63`); the wish text was an estimate from earlier in the cycle.

## Score distribution (unsuppressed)

| Score | Count |
|-------|-------|
| 16 | 4 |
| 17 | 2 |
| 18 | 1 |
| 19 | 1 |
| 20 | 1 |
| 23 | 1 |
| 26 | 1 |
| 29 | 2 |
| 31 | 1 |
| 36 | 1 |
| 37 | 1 |
| 42 | 1 |
| **Total** | **17** |

## Projection at the new threshold (`maxAllowedComplexity: 25`)

| Metric | Value |
|--------|-------|
| Warnings silenced (scores 16–25) | 10 |
| Warnings retained (scores ≥ 26) | 7 |

### Retained hotspots (score > 25)

| Score | Function | Location |
|-------|----------|----------|
| 42 | `dbMigrateV1Command` | `src/term-commands/db-migrate-v1.ts:105` |
| 37 | `trustAction` | `src/term-commands/hook/trust.ts:69` |
| 36 | `dbLsCommand` | `src/term-commands/db-ls.ts:48` |
| 31 | `_buildConnection` | `src/lib/db.ts:1554` |
| 29 | `checkPrerequisites` | `src/genie-commands/doctor.ts:76` |
| 29 | `reapStaleGenieProcesses` | `src/genie-commands/doctor.ts:1387` |
| 26 | `ensureSession` | `src/lib/session-capture.ts:333` |

Architectural verdicts for each retained function are captured in `hotspots.md` (Group 4).

### Warnings that disappear under the new budget (scores 16–25)

| Score | Function | Location |
|-------|----------|----------|
| 23 | `buildSpawnParams` | `src/term-commands/agents.ts:2063` |
| 20 | `loadExternalHooks` | `src/hooks/loader.ts:186` |
| 19 | `handleHandshake` | `src/term-commands/omni/handshake.ts:171` |
| 18 | `refresh` (Nav component) | `src/tui/components/Nav.tsx:47` |
| 17 | `diagnoseSessionLinks` | `src/lib/session-link-repair.ts:57` |
| 17 | `updateSource` | `src/genie-commands/update.ts:461` |
| 16 | `handleDirAdd` | `src/term-commands/dir.ts:198` |
| 16 | spawn action callback | `src/term-commands/agent/spawn.ts:45` |
| 16 | `detectV1State` | `src/lib/v1-migration-prompt.ts:78` |
| 16 | `attemptAgentResume` | `src/lib/scheduler-daemon.ts:1460` |

## Suppression inventory

19 explicit `biome-ignore lint/complexity/noExcessiveCognitiveComplexity` directives at baseline:

```
src/term-commands/agents.ts:892
src/term-commands/agents.ts:1107
src/term-commands/agents.ts:1215
src/term-commands/agents.ts:2419
src/term-commands/agents.ts:3627
src/lib/scheduler-daemon.ts:2252
src/lib/agent-registry.ts:156
src/lib/agent-registry.ts:233
src/lib/agent-registry.ts:379
src/lib/agent-registry.ts:685
src/lib/pg-seed.ts:193
src/lib/scheduler-daemon.test.ts:56
src/services/omni-bridge.ts:1126
src/services/executors/claude-sdk.ts:459
packages/genie-app/views/sessions/ui/SessionsView.tsx:104
packages/genie-app/views/sessions/ui/SessionsView.tsx:135
packages/genie-app/views/sessions/ui/SessionsView.tsx:932
packages/genie-app/views/scheduler/ui/SchedulerView.tsx:181
packages/genie-app/views/scheduler/ui/SchedulerView.tsx:262
```

Group 3 will identify which of these become unused once the threshold is raised to 25 and remove them.
