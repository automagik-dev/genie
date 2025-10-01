# 🧞 CLI Modularization Wish

**Status:** COMPLETED
**Roadmap Item:** NEW – CLI Modularization (Code Organization)
**Mission Link:** @.genie/product/mission.md §Core Principles
**Standards:** @.genie/standards/best-practices.md §Code Organization
**Completion Score:** 100/100 (validated via QA/validation artefacts)

## Evaluation Matrix (100 Points Total)

### Discovery Phase (30 pts)
- **Context Completeness (10 pts)**
  - [x] All relevant files/docs referenced with @ notation (4 pts) – Context ledger complete with 8 sources
  - [x] Background persona outputs captured in context ledger (3 pts) – Twin enhancement review documented
  - [x] Assumptions (ASM-#), decisions (DEC-#), risks documented (3 pts) – ASM-1 through ASM-5, DEC-1 through DEC-5, RISK-1 through RISK-3
- **Scope Clarity (10 pts)**
  - [x] Clear current state and target state defined (3 pts) – genie.ts 2,105→<850 lines, 4 execution groups
  - [x] Spec contract complete with success metrics (4 pts) – 8 metrics including snapshot validation
  - [x] Out-of-scope explicitly stated (3 pts) – 9 out-of-scope items documented
- **Evidence Planning (10 pts)**
  - [x] Validation commands specified with exact syntax (4 pts) – Snapshot scripts + build + QA tests
  - [x] Artifact storage paths defined (3 pts) – `.genie/cli/snapshots/` structure documented
  - [x] Approval checkpoints documented (3 pts) – 4 checkpoints before each group + merge

### Implementation Phase (40 pts)
- **Code Quality (15 pts)**
  - [x] Follows standards (@.genie/standards/*) (5 pts) – Evidence: @.genie/reports/done-implementor-cli-modularization-202509301707.md #L1 documents lint/build compliance
  - [x] Minimal surface area changes, focused scope (5 pts) – Evidence: @.genie/reports/done-audit-cli-modularization-20250930.md #L1 shows scoped extractions only
  - [x] Clean abstractions and patterns (5 pts) – Evidence: @.genie/reports/done-audit-cli-modularization-20250930.md #L40 confirms modular boundaries
- **Test Coverage (10 pts)**
  - [x] Unit tests for new behavior (4 pts) – Evidence: @.genie/reports/done-tests-cli-modularization-202509302051.md #L1 details new suites
  - [x] Integration tests for workflows (4 pts) – Evidence: @.genie/cli/snapshots/qa-validation-summary.md #L1 captures executor workflow validation
  - [x] Evidence of test execution captured (2 pts) – Evidence: @.genie/cli/snapshots/evidence/test-results-full.txt validates run logs
- **Documentation (5 pts)**
  - [x] Inline comments where complexity exists (2 pts) – Evidence: @.genie/cli/src/lib/executor-config.ts:35 documents config merge stages
  - [x] Updated relevant external docs (2 pts) – Evidence: @.genie/reports/done-polish-cli-modularization-202509302008.md #L1 documents README overhaul
  - [x] Context preserved for maintainers (1 pt) – Evidence: @.genie/cli/MODULARIZATION_SUMMARY.md #L1 captures architectural summary
- **Execution Alignment (10 pts)**
  - [x] Stayed within spec contract scope (4 pts) – Groups 0→A+B→C match spec exactly
  - [x] No unapproved scope creep (3 pts) – Out-of-scope items explicitly excluded
  - [x] Dependencies and sequencing honored (3 pts) – Group 0 first, A+B parallel, C last

### Verification Phase (30 pts)
- **Validation Completeness (15 pts)**
  - [x] All validation commands executed successfully (6 pts) – Evidence: @.genie/cli/snapshots/evidence/validation-final-report.md #L1 reports 100/100 score
  - [x] Artifacts captured at specified paths (5 pts) – Evidence: @.genie/cli/snapshots/qa-validation-summary.md #L25 lists artefacts
  - [x] Edge cases and error paths tested (4 pts) – Evidence: @.genie/cli/snapshots/qa-edge-cases.log confirms edge validations
- **Evidence Quality (10 pts)**
  - [x] Command outputs (failures → fixes) logged (4 pts) – Evidence: @.genie/cli/snapshots/evidence/build-final.txt documents build output
  - [x] Screenshots/metrics captured where applicable (3 pts) – Evidence: @.genie/cli/snapshots/evidence/performance-metrics.txt captures startup metrics
  - [x] Before/after comparisons provided (3 pts) – Evidence: @.genie/cli/MODULARIZATION_SUMMARY.md #L1 compares pre/post state
- **Review Thoroughness (5 pts)**
  - [x] Human approval obtained at checkpoints (2 pts) – 4 approval gates documented
  - [x] Blockers resolved or documented (2 pts) – Evidence: @.genie/cli/snapshots/evidence/validation-final-report.md #L35 details resolved issues
  - [x] Status log updated with completion timestamp (1 pt) – Evidence: Status log entry below marks 2025-09-30 completion


## Context Ledger

| Source | Type | Summary | Routed To |
| --- | --- | --- | --- |
| @.genie/cli/src/genie.ts | repo | 2,105-line monolith; 40% of CLI codebase; types (50 lines), command handlers (712 lines), utilities (372 lines), transcript parsing (150 lines) | Groups 0-D |
| @.genie/reports/planning-brief-cli-refactor-corrected-20250930.md | analysis | Evidence-based analysis confirming extractable targets; Twin validation | entire wish |
| @.genie/cli/src/executors/transcript-utils.ts | repo | Existing shared utilities (237 lines); can host additional transcript parsing | Group B |
| Empty scaffolding: commands/, lib/ directories | repo | Ready for extraction | Groups A-C |
| Twin enhancement review | analysis | Identified types extraction, parallel A+B execution | Groups 0, A-B |
| @.genie/agents/qa/codex-parameter-test.md | repo | QA test agent validating all 22 Codex executor parameters | Final validation |
| @.genie/agents/qa/claude-parameter-test.md | repo | QA test agent validating all 9 Claude executor parameters | Final validation |

## Discovery Summary

- **Primary analyst:** Human + GENIE + Twin (challenge + enhancement modes)
- **Key observations:**
  - genie.ts = 2,105 lines (40% of 5,300-line CLI codebase)
  - Types/interfaces: ~50 lines (CLIOptions, ParsedCommand, ConfigPaths, GenieConfig, AgentSpec)
  - Command handlers: 712 lines across 7 functions (runChat, runContinue, runView, runRuns, runList, runStop, runHelp)
  - Utilities: 372 lines (formatters, path helpers, sanitizers, config)
  - Transcript parsing: 150 lines (buildTranscriptFromEvents, sliceTranscriptForLatest)
  - Empty commands/ and lib/ directories ready for extraction
  - Twin validation confirms extraction targets are accurate
  - **Enhancement: Extract types FIRST to prevent circular dependencies**
  - **Enhancement: Parallelize Groups A+B (no interdependencies)**
- **Assumptions (ASM-#):**
  - ASM-1: No external consumers depend on genie.ts internal exports (only `./genie` CLI entry is public)
  - ASM-2: Command handlers can be extracted without circular dependencies if types extracted first
  - ASM-3: Existing tests (if any) exercise CLI commands end-to-end, not genie.ts internals
  - ASM-4: Build will catch orphaned imports via TypeScript compiler
  - ASM-5: Codebase is experimental; breaking during refactoring is acceptable as long as final result matches pre-refactoring snapshots
- **Decisions (DEC-#):**
  - DEC-1: Extract types first (Group 0) to establish clean dependency boundaries
  - DEC-2: Execute Groups A+B in parallel (no interdependencies)
  - DEC-3: Comprehensive QA snapshot before refactoring; validation = diff against snapshots
  - DEC-4: No barrel exports (explicit imports only, prevent hidden circular deps)
  - DEC-5: Breaking intermediate states OK; final state must match snapshots exactly
- **Risks:**
  - RISK-1: Type extraction may reveal hidden coupling (Mitigation: Group 0 is smallest, safest first step)
  - RISK-2: Parallel A+B may have hidden dependencies (Mitigation: Both import only from Group 0 types)
  - RISK-3: Snapshot drift if CLI changes during refactoring (Mitigation: Lock codebase, no feature work during refactoring)

## Executive Summary

Break up genie.ts (2,105 lines, 40% of CLI codebase) into focused modules in 4 phases: types first (Group 0), then parallel utilities + transcript consolidation (Groups A+B), then command handlers (Group C). Target: reduce genie.ts to <850 lines (60% reduction) while preserving **exact** CLI behavior validated via comprehensive pre-refactoring snapshots.

**Refactoring Philosophy:** Break whatever you need during modularization. Final result must match pre-refactoring snapshots byte-for-byte (visual output, functional behavior, exit codes). No backwards compatibility, no legacy support—experimental codebase, aggressive refactoring.

## Current State

- **What exists today:**
  - @.genie/cli/src/genie.ts: 2,105-line monolith handling types, arg parsing, command dispatch, command implementation, utilities, transcript parsing
  - Empty scaffolding: commands/ and lib/ directories ready for extraction
  - @.genie/cli/src/executors/transcript-utils.ts: 237 lines of shared transcript utilities (sliceForLatest, sliceForRecent, metrics summarization)
  - 51 functions in genie.ts = ~41 lines/function average
- **Gaps/Pain points:**
  - Hard to navigate 2,105-line file
  - New features added inline instead of using modules
  - Types scattered causing tight coupling
  - Command handlers tightly coupled with utilities and config
  - Transcript parsing duplicated between genie.ts and log viewers
  - No clear separation of concerns

## Target State & Guardrails

- **Desired behaviour:**
  - genie.ts streamlined to <850 lines as thin orchestrator (types imported, arg parser → command dispatcher)
  - Types extracted to lib/types.ts (~50 lines) - **foundation layer, no dependencies**
  - Command handlers extracted to commands/*.ts modules (run, resume, list, view, stop, help)
  - Utilities extracted to lib/*.ts modules (utils, config, cli-parser, agent-resolver, session-helpers)
  - Transcript parsing consolidated in existing transcript-utils.ts
  - Total CLI reduced by ~200 lines (3.8%) through deduplication + cleanup
  - **Zero behavioral changes: CLI commands, flags, help text, output format, exit codes must match pre-refactoring snapshots exactly**
- **Non-negotiables:**
  - Preserve exact CLI behavior (validated via snapshot diff)
  - No circular dependencies (types → utils/transcript → commands → genie.ts, single direction only)
  - Build succeeds with no new warnings after each phase
  - CLI startup time must not regress (<800ms for `./genie --help`)
  - Explicit imports only (no barrel exports)
  - Breaking intermediate states OK; final state matches snapshots

## Pre-Refactoring QA Snapshot (CRITICAL)

**Before any code changes, capture complete CLI behavior for validation:**

### Snapshot Capture Script

```bash
#!/bin/bash
# Location: .genie/cli/snapshots/capture-baseline.sh

SNAPSHOT_DIR=".genie/cli/snapshots/baseline-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$SNAPSHOT_DIR"

echo "📸 Capturing CLI baseline snapshots..."

# 1. Help text (all commands)
./genie --help > "$SNAPSHOT_DIR/help.txt" 2>&1
./genie help > "$SNAPSHOT_DIR/help-command.txt" 2>&1
./genie run --help > "$SNAPSHOT_DIR/help-run.txt" 2>&1
./genie resume --help > "$SNAPSHOT_DIR/help-resume.txt" 2>&1
./genie list --help > "$SNAPSHOT_DIR/help-list.txt" 2>&1
./genie view --help > "$SNAPSHOT_DIR/help-view.txt" 2>&1
./genie stop --help > "$SNAPSHOT_DIR/help-stop.txt" 2>&1

# 2. List commands
./genie list agents > "$SNAPSHOT_DIR/list-agents.txt" 2>&1
./genie list sessions > "$SNAPSHOT_DIR/list-sessions.txt" 2>&1

# 3. Error states (expected failures)
./genie run > "$SNAPSHOT_DIR/error-run-no-args.txt" 2>&1
echo "Exit code: $?" >> "$SNAPSHOT_DIR/error-run-no-args.txt"

./genie resume > "$SNAPSHOT_DIR/error-resume-no-args.txt" 2>&1
echo "Exit code: $?" >> "$SNAPSHOT_DIR/error-resume-no-args.txt"

./genie view > "$SNAPSHOT_DIR/error-view-no-args.txt" 2>&1
echo "Exit code: $?" >> "$SNAPSHOT_DIR/error-view-no-args.txt"

./genie stop > "$SNAPSHOT_DIR/error-stop-no-args.txt" 2>&1
echo "Exit code: $?" >> "$SNAPSHOT_DIR/error-stop-no-args.txt"

./genie invalid-command > "$SNAPSHOT_DIR/error-unknown-command.txt" 2>&1
echo "Exit code: $?" >> "$SNAPSHOT_DIR/error-unknown-command.txt"

./genie list invalid > "$SNAPSHOT_DIR/error-list-invalid.txt" 2>&1
echo "Exit code: $?" >> "$SNAPSHOT_DIR/error-list-invalid.txt"

# 4. View command (if test sessions exist)
if [ -f ".genie/cli/test-session-id.txt" ]; then
  TEST_SESSION=$(cat .genie/cli/test-session-id.txt)
  ./genie view "$TEST_SESSION" > "$SNAPSHOT_DIR/view-session.txt" 2>&1
  ./genie view "$TEST_SESSION" --full > "$SNAPSHOT_DIR/view-session-full.txt" 2>&1
  ./genie view "$TEST_SESSION" --live > "$SNAPSHOT_DIR/view-session-live.txt" 2>&1
fi

# 5. Performance baseline
echo "⏱️  Measuring CLI startup time..."
for i in {1..10}; do
  /usr/bin/time -f "%e" ./genie --help 2>&1 | tail -1
done | awk '{sum+=$1; count++} END {print "Average: " sum/count "s"}' > "$SNAPSHOT_DIR/perf-startup.txt"

# 6. File structure snapshot
wc -l src/**/*.ts > "$SNAPSHOT_DIR/line-counts.txt"
find src -name "*.ts" -type f | sort > "$SNAPSHOT_DIR/file-list.txt"

# 7. Build output
npm run build > "$SNAPSHOT_DIR/build-output.txt" 2>&1
echo "Exit code: $?" >> "$SNAPSHOT_DIR/build-output.txt"

echo "✅ Baseline snapshots captured at: $SNAPSHOT_DIR"
echo ""
echo "📋 Snapshot manifest:"
ls -lh "$SNAPSHOT_DIR"
```

### Snapshot Validation Script

```bash
#!/bin/bash
# Location: .genie/cli/snapshots/validate-against-baseline.sh

BASELINE_DIR="$1"
CURRENT_DIR=".genie/cli/snapshots/current-$(date +%Y%m%d-%H%M%S)"

if [ -z "$BASELINE_DIR" ]; then
  echo "Usage: $0 <baseline-snapshot-dir>"
  exit 1
fi

mkdir -p "$CURRENT_DIR"

echo "📸 Capturing current CLI snapshots..."

# Re-run all snapshot commands (same as capture script)
./genie --help > "$CURRENT_DIR/help.txt" 2>&1
./genie help > "$CURRENT_DIR/help-command.txt" 2>&1
./genie run --help > "$CURRENT_DIR/help-run.txt" 2>&1
./genie resume --help > "$CURRENT_DIR/help-resume.txt" 2>&1
./genie list --help > "$CURRENT_DIR/help-list.txt" 2>&1
./genie view --help > "$CURRENT_DIR/help-view.txt" 2>&1
./genie stop --help > "$CURRENT_DIR/help-stop.txt" 2>&1

./genie list agents > "$CURRENT_DIR/list-agents.txt" 2>&1
./genie list sessions > "$CURRENT_DIR/list-sessions.txt" 2>&1

./genie run > "$CURRENT_DIR/error-run-no-args.txt" 2>&1
echo "Exit code: $?" >> "$CURRENT_DIR/error-run-no-args.txt"

./genie resume > "$CURRENT_DIR/error-resume-no-args.txt" 2>&1
echo "Exit code: $?" >> "$CURRENT_DIR/error-resume-no-args.txt"

./genie view > "$CURRENT_DIR/error-view-no-args.txt" 2>&1
echo "Exit code: $?" >> "$CURRENT_DIR/error-view-no-args.txt"

./genie stop > "$CURRENT_DIR/error-stop-no-args.txt" 2>&1
echo "Exit code: $?" >> "$CURRENT_DIR/error-stop-no-args.txt"

./genie invalid-command > "$CURRENT_DIR/error-unknown-command.txt" 2>&1
echo "Exit code: $?" >> "$CURRENT_DIR/error-unknown-command.txt"

./genie list invalid > "$CURRENT_DIR/error-list-invalid.txt" 2>&1
echo "Exit code: $?" >> "$CURRENT_DIR/error-list-invalid.txt"

if [ -f ".genie/cli/test-session-id.txt" ]; then
  TEST_SESSION=$(cat .genie/cli/test-session-id.txt)
  ./genie view "$TEST_SESSION" > "$CURRENT_DIR/view-session.txt" 2>&1
  ./genie view "$TEST_SESSION" --full > "$CURRENT_DIR/view-session-full.txt" 2>&1
  ./genie view "$TEST_SESSION" --live > "$CURRENT_DIR/view-session-live.txt" 2>&1
fi

wc -l src/**/*.ts > "$CURRENT_DIR/line-counts.txt"
find src -name "*.ts" -type f | sort > "$CURRENT_DIR/file-list.txt"
npm run build > "$CURRENT_DIR/build-output.txt" 2>&1

echo ""
echo "🔍 Diffing against baseline..."
echo ""

DIFF_COUNT=0
for file in "$BASELINE_DIR"/*.txt; do
  basename_file=$(basename "$file")
  if [ -f "$CURRENT_DIR/$basename_file" ]; then
    if ! diff -u "$file" "$CURRENT_DIR/$basename_file" > "$CURRENT_DIR/diff-$basename_file" 2>&1; then
      echo "❌ DIFF: $basename_file"
      cat "$CURRENT_DIR/diff-$basename_file"
      DIFF_COUNT=$((DIFF_COUNT + 1))
    else
      echo "✅ MATCH: $basename_file"
      rm "$CURRENT_DIR/diff-$basename_file"
    fi
  else
    echo "⚠️  MISSING: $basename_file (in baseline but not current)"
    DIFF_COUNT=$((DIFF_COUNT + 1))
  fi
done

echo ""
if [ $DIFF_COUNT -eq 0 ]; then
  echo "🎉 All snapshots match! CLI behavior preserved."
  exit 0
else
  echo "❌ $DIFF_COUNT snapshot(s) differ. Review diffs above."
  exit 1
fi
```

### Snapshot Checklist

**Setup (Before Group 0):**
- [ ] Create snapshot scripts at `@.genie/cli/snapshots/` (capture-baseline.sh, validate-against-baseline.sh)
- [ ] Make scripts executable: `chmod +x .genie/cli/snapshots/*.sh`

**Before Group 0:**
- [ ] Run `@.genie/cli/snapshots/capture-baseline.sh` from `.genie/cli/` directory
- [ ] Verify all snapshots captured successfully
- [ ] Record baseline directory path in wish status log
- [ ] Commit snapshots to git: `git add .genie/cli/snapshots/baseline-* && git commit -m "snapshot: pre-refactoring baseline"`

**After Each Group (0, A+B, C):**
- [ ] Run `npm run build` (must exit 0)
- [ ] Run `@.genie/cli/snapshots/validate-against-baseline.sh <baseline-dir>` from `.genie/cli/` directory
- [ ] If diffs found: **acceptable intermediate state**, document in status log
- [ ] Continue to next group

**After Group C (Final Validation):**
- [ ] Run `@.genie/cli/snapshots/validate-against-baseline.sh <baseline-dir>` from `.genie/cli/` directory
- [ ] **MUST return 0 diffs** - all snapshots match exactly
- [ ] **Run parameter QA tests** to verify executor configuration still works:
  - [ ] `./genie run qa/codex-parameter-test "Post-refactoring validation"`
  - [ ] `./genie run qa/claude-parameter-test "Post-refactoring validation"`
  - [ ] Review QA reports: all parameters must still function
- [ ] If diffs found or QA fails: **BLOCKER** - fix before merge
- [ ] Record final line count: `wc -l .genie/cli/src/genie.ts`

## Execution Groups

### Group 0 – Types Extraction (Foundation Layer)

**Goal:** Extract types/interfaces from genie.ts to lib/types.ts to prevent circular dependencies in later groups

**Why First:** Types are imported by everything; extracting them establishes clean dependency flow: types → utils/transcript → commands → genie.ts

**Surfaces:**
- `@.genie/cli/src/genie.ts:50-92` (all interfaces)

**Deliverables:**
- `lib/types.ts`: CLIOptions, ParsedCommand, ConfigPaths, GenieConfig, AgentSpec, ExecuteRunArgs (~50 lines)
- Update imports in genie.ts (change interface references to `import type { ... } from './lib/types'`)

**Evidence:**
- Build passes: `cd .genie/cli && npm run build`
- genie.ts reduced by ~50 lines (2,105 → ~2,055)
- No circular dependencies: `npm run build 2>&1 | grep -i circular` returns empty
- CLI still works: `./genie --help`

**Evaluation Matrix Impact:**
- Targets Implementation Phase checkpoints:
  - Code Quality: Clean abstractions (foundation for 5 pts)
  - Execution Alignment: No scope creep (3 pts contribution)
- Expected score contribution: +8/100 points (foundation for later groups)

**Suggested personas:** `implementor`
**External tracker:** TBD

---

### Groups A+B – Parallel Utilities + Transcript Consolidation

**Goal:** Extract utilities and consolidate transcript parsing simultaneously (no interdependencies)

**Why Parallel:** Groups A and B both depend only on Group 0 types, not on each other. Parallelizing saves time.

#### Group A – Utilities Extraction

**Surfaces:**
- `@.genie/cli/src/genie.ts:256-292` (parseArguments → lib/cli-parser.ts)
- `@.genie/cli/src/genie.ts:333-413` (config management → lib/config.ts)
- `@.genie/cli/src/genie.ts:897-975` (formatters, sanitizers → lib/utils.ts)
- `@.genie/cli/src/genie.ts:1827-1934` (agent resolution → lib/agent-resolver.ts)
- `@.genie/cli/src/genie.ts:1724-1782` (session helpers → lib/session-helpers.ts)

**Deliverables:**
- `lib/cli-parser.ts`: parseArguments function (36 lines)
- `lib/config.ts`: loadConfig, buildDefaultConfig, mergeDeep, resolvePaths, prepareDirectories, applyDefaults (~81 lines)
- `lib/utils.ts`: formatRelativeTime, formatPathRelative, truncateText, sanitizeLogFilename, safeIsoString, deriveStartTime, deriveLogFile (~79 lines)
- `lib/agent-resolver.ts`: listAgents, resolveAgentIdentifier, agentExists, loadAgentSpec, extractFrontMatter (~108 lines)
- `lib/session-helpers.ts`: findSessionEntry, resolveDisplayStatus (~59 lines)
- Update imports in genie.ts

#### Group B – Transcript Parsing Consolidation

**Surfaces:**
- `@.genie/cli/src/genie.ts:1936-2105` (buildTranscriptFromEvents, sliceTranscriptForLatest → move to transcript-utils.ts)
- `@.genie/cli/src/executors/codex-log-viewer.ts:383-404` (duplicate sliceForLatest → delete, import from transcript-utils)
- `@.genie/cli/src/executors/claude-log-viewer.ts:221-240` (duplicate sliceForLatest → delete, import from transcript-utils)
- `@.genie/cli/src/executors/transcript-utils.ts` (existing file, add new functions)

**Deliverables:**
- Move `buildTranscriptFromEvents` from genie.ts → transcript-utils.ts (128 lines)
- Delete duplicate `sliceTranscriptForLatest` from genie.ts, codex-log-viewer.ts, claude-log-viewer.ts (66 lines saved)
- Export sliceForRecent from transcript-utils (already exists, verify usage)
- Update imports in genie.ts, codex-log-viewer.ts, claude-log-viewer.ts

**Combined Evidence (A+B):**
- Build passes: `cd .genie/cli && npm run build`
- genie.ts reduced by ~533 lines (2,055 → ~1,522 after Group 0+A+B)
- No duplicate functions: `grep -rh "function sliceForLatest" .genie/cli/src --include="*.ts" | wc -l` returns 1
- CLI works: `./genie view <sessionId>` displays transcript for both codex and claude sessions

**Evaluation Matrix Impact:**
- Targets Implementation Phase checkpoints:
  - Code Quality: Clean abstractions + minimal surface area (10 pts)
  - Test Coverage: Snapshot validation ensures no behavior changes (partial 4 pts)
  - Execution Alignment: Stayed in scope (4 pts contribution)
- Expected score contribution: +18/100 points

**Suggested personas:** `implementor` (run 2 parallel tasks: one for A, one for B)
**External tracker:** TBD

---

### Group C – Command Handlers Extraction

**Goal:** Move all command logic from genie.ts to commands/*.ts modules

**Surfaces:**
- `@.genie/cli/src/genie.ts:484-576` (runChat → commands/run.ts)
- `@.genie/cli/src/genie.ts:578-895` (executeRun → shared helper, keep in commands/run.ts or lib/executor-runner.ts)
- `@.genie/cli/src/genie.ts:996-1129` (runContinue → commands/resume.ts)
- `@.genie/cli/src/genie.ts:1132-1174` (runRuns → commands/list.ts)
- `@.genie/cli/src/genie.ts:1176-1203` (runList → commands/list.ts)
- `@.genie/cli/src/genie.ts:1205-1573` (runView → commands/view.ts)
- `@.genie/cli/src/genie.ts:1575-1638` (runStop → commands/stop.ts)
- `@.genie/cli/src/genie.ts:1784-1889` (runHelp, emitAgentCatalog → commands/help.ts)

**Deliverables:**
- `commands/run.ts`: runChat logic + shared executeRun if extracted (~430 lines)
- `commands/resume.ts`: runContinue logic, reuses executeRun (~135 lines)
- `commands/list.ts`: runList, runRuns, emitAgentCatalog (~117 lines)
- `commands/view.ts`: runView logic (~369 lines)
- `commands/stop.ts`: runStop logic (~65 lines)
- `commands/help.ts`: runHelp logic (~106 lines)
- Update genie.ts to dispatch to command modules

**Evidence:**
- Build passes: `cd .genie/cli && npm run build`
- genie.ts reduced by ~712 lines (1,522 → ~810 lines)
- **Snapshot validation MUST pass:** `@.genie/cli/snapshots/validate-against-baseline.sh <baseline-dir>` returns 0 diffs
- **Parameter QA tests pass:** Both `@.genie/agents/qa/codex-parameter-test.md` and `@.genie/agents/qa/claude-parameter-test.md` validate all executor parameters still work
- All commands work identically:
  - `./genie run <agent> "<prompt>"` launches session
  - `./genie resume <sessionId> "<prompt>"` continues session
  - `./genie list agents` shows agent catalog
  - `./genie list sessions` shows runs overview
  - `./genie view <sessionId>` displays transcript
  - `./genie stop <sessionId>` terminates session
  - `./genie help` displays usage
- Background execution works: `./genie run plan "test" &` then `./genie list sessions | grep plan`
- No circular dependencies: `npm run build 2>&1 | grep -i circular` returns empty

**Evaluation Matrix Impact:**
- Targets all remaining Implementation + Verification checkpoints:
  - Code Quality: Final abstractions review (5 pts)
  - Test Coverage: Parameter QA tests (4 pts integration tests)
  - Documentation: Module-level JSDoc + README (3 pts)
  - Validation Completeness: Snapshot validation + QA tests (15 pts)
  - Evidence Quality: Snapshot diffs + performance metrics (10 pts)
- Expected score contribution: +42/100 points (completes 70/100 minimum for merge approval)

**Suggested personas:** `implementor`, `qa`
**External tracker:** TBD

---

## Verification Plan

**Pre-Refactoring (BEFORE GROUP 0):**
```bash
# Capture baseline
cd .genie/cli
./snapshots/capture-baseline.sh

# Record baseline directory
echo "Baseline: .genie/cli/snapshots/baseline-YYYYMMDD-HHMMSS" >> ../../wishes/cli-modularization-wish.md

# Commit snapshots
git add snapshots/baseline-*
git commit -m "snapshot: pre-refactoring baseline for cli-modularization"
```

**After Each Group:**
```bash
# Build
cd .genie/cli
npm run build

# Quick validation (intermediate state, diffs OK)
./genie --help
./genie list agents
wc -l src/genie.ts
```

**Final Validation (AFTER GROUP C):**
```bash
# Full snapshot comparison
cd .genie/cli
./snapshots/validate-against-baseline.sh snapshots/baseline-YYYYMMDD-HHMMSS

# MUST return 0 diffs
# If any diffs: BLOCKER - fix before merge

# Parameter QA validation
cd ../..
./genie run qa/codex-parameter-test "Post-refactoring validation: test all Codex parameters"
./genie run qa/claude-parameter-test "Post-refactoring validation: test all Claude parameters"

# Review QA session transcripts
./genie view <codex-qa-sessionId> --full > .genie/cli/snapshots/qa-codex-post-refactor.log
./genie view <claude-qa-sessionId> --full > .genie/cli/snapshots/qa-claude-post-refactor.log

# All parameters must pass
# If any QA failures: BLOCKER - fix before merge
```

**Evidence Storage:**
- Pre-refactoring snapshots: `.genie/cli/snapshots/baseline-YYYYMMDD-HHMMSS/`
- Post-refactoring snapshots: `.genie/cli/snapshots/current-YYYYMMDD-HHMMSS/`
- Diffs (if any): `.genie/cli/snapshots/current-YYYYMMDD-HHMMSS/diff-*.txt`
- Commit messages: document line reduction per group
- Final report: `.genie/reports/done-cli-modularization-<timestamp>.md`

**Branch Strategy:** Dedicated branch `refactor/cli-modularization`

### Evidence Checklist

- **Validation commands (exact):**
  - Pre-refactoring: `@.genie/cli/snapshots/capture-baseline.sh` (captures all CLI output)
  - Post-refactoring: `@.genie/cli/snapshots/validate-against-baseline.sh <baseline-dir>` (must return 0 diffs)
  - Parameter QA: `./genie run qa/codex-parameter-test "Post-refactoring validation"` (all 22 Codex parameters must work)
  - Parameter QA: `./genie run qa/claude-parameter-test "Post-refactoring validation"` (all 9 Claude parameters must work)
  - Build: `npm run build` (exits 0, no circular dependency warnings)
  - Line count: `wc -l src/genie.ts` (<850 lines)
- **Artefact paths (where evidence lives):**
  - Baseline snapshots: `.genie/cli/snapshots/baseline-YYYYMMDD-HHMMSS/`
  - Validation diffs: `.genie/cli/snapshots/current-YYYYMMDD-HHMMSS/diff-*.txt`
  - QA test logs: `.genie/cli/snapshots/qa-codex-post-refactor.log`, `.genie/cli/snapshots/qa-claude-post-refactor.log`
  - Final report: `.genie/reports/done-cli-modularization-<timestamp>.md`
- **Approval checkpoints (human sign-off required before work starts):**
  - ✅ Before Group 0: Approve types extraction scope, review baseline snapshots
  - ✅ Before Groups A+B: Review Group 0 results; approve parallel execution
  - ✅ Before Group C: Review Groups 0+A+B results; approve command extraction (highest risk)
  - ✅ Before merge: Review snapshot validation report (MUST be 0 diffs); approve final PR

## <spec_contract>

- **Scope:**
  - Extract types from genie.ts to lib/types.ts (Group 0: ~50 lines)
  - Extract utilities from genie.ts to lib/ modules (Group A: ~363 lines)
  - Consolidate transcript parsing in transcript-utils.ts (Group B: ~170 lines)
  - Move command handlers to commands/*.ts modules (Group C: ~712 lines)
  - Target: genie.ts reduced from 2,105 → <850 lines (60% reduction, 1,255+ lines saved)
  - Preserve exact CLI behavior (validated via snapshot diff: MUST be 0 diffs after Group C)
  - No circular dependencies (types → lib/transcript → commands → genie.ts, single direction)
  - Breaking intermediate states OK; final state matches snapshots
- **Out of scope:**
  - Refactoring executor files (codex.ts, claude.ts are polymorphic by design)
  - Refactoring log viewers (codex-log-viewer.ts, claude-log-viewer.ts are format-specific by design)
  - Adding new CLI features or changing existing functionality
  - Performance optimizations beyond structural improvements
  - Adding external dependencies
  - Changing view rendering logic (views/*.ts)
  - Modifying session-store.ts or background-manager.ts (unless minimal imports needed)
  - Barrel exports (explicit imports only)
  - Backwards compatibility (experimental codebase, no legacy support)
- **Success metrics:**
  - genie.ts: 2,105 → <850 lines (target: ~810, ≥60% reduction)
  - Total CLI: ~5,300 → ~5,100 lines (~200 lines saved through deduplication)
  - Zero duplicate function definitions across modules
  - Build succeeds with no new warnings
  - CLI startup time ≤800ms for `./genie --help` (no regression)
  - **Snapshot validation: 0 diffs** (all CLI output matches baseline exactly)
  - **Parameter QA: 100% pass rate** (all 31 executor parameters validated via `@.genie/agents/qa/` test agents)
  - No circular dependencies detected by TypeScript compiler
- **External tasks:**
  - TBD (forge will generate task IDs)
- **Dependencies:**
  - Existing TypeScript build configuration
  - Existing executors, views, session-store, background-manager modules
  - No new npm dependencies required
  - Bash for snapshot scripts

</spec_contract>

## Blocker Protocol

1. Pause work and create `.genie/reports/blocker-cli-modularization-<timestamp>.md` describing findings.
2. Notify owner and wait for updated instructions.
3. Resume only after wish status/log is updated.

**Potential blockers to watch for:**
- Circular dependency detected after Group 0 (requires restructuring types)
- Snapshot validation fails after Group C (requires debugging diffs)
- Build fails with orphaned imports (requires import cleanup)
- Command handler coupling stronger than expected (may need shared context object)

## Status Log

- [2025-09-30 15:00Z] Wish created with evidence-based analysis + Twin enhancement review
- [2025-09-30 17:30Z] Enhanced with 100-point evaluation matrix
- [2025-09-30 18:30Z] Implementation completed - genie.ts reduced to 143 lines (93% reduction)
- [2025-09-30 23:10Z] Wish marked COMPLETED with 100/100 QA score; artefacts archived under `.genie/cli/snapshots/`

---

## Effort Estimate: M (Medium, 8-10 hours)

**Breakdown:**
- Group 0 (types): 1 hour
- Groups A+B (parallel): 3 hours (if sequential: 2 + 2 = 4 hours)
- Group C (commands): 4 hours
- Snapshot setup + validation: 1 hour

**Roadmap Fit:** Phase 1+ (Code organization, improves maintainability for evidence-based workflows)
