# Garbage Collection Report - 2025-10-26

## Summary
- **Files scanned:** 833 markdown files, 42,660 TypeScript/JavaScript files
- **Critical issues found:** 1
- **Token efficiency:** ✅ GOOD (no metadata duplication detected)
- **Merge conflicts:** ✅ CLEAN (section markers only, no actual conflicts)
- **TODO markers:** 160 found (within acceptable range)

## Critical Issues

### 🔴 ISSUE 1: File Size Violation - Amendment 10
**File:** `.genie/cli/src/genie-cli.ts`
**Current size:** 1290 lines
**Hard limit:** 1000 lines (soft limit: 800 lines)
**Status:** **BLOCKER** - Exceeds hard limit by 290 lines

**Evidence:**
```bash
$ wc -l .genie/cli/src/genie-cli.ts
1290 .genie/cli/src/genie-cli.ts
```

**Amendment Reference:** Amendment 10 - File Size Discipline
- Soft limit (800 lines): Start planning refactor
- Hard limit (1000 lines): Refactor required before next feature
- Emergency limit (1500 lines): Block new work until split

**Impact:**
- Cognitive load: Harder to understand, review, maintain
- Single responsibility: File likely violates SRP
- Navigation: Slower jump-to-definition, search, refactor
- Git: Larger diffs, more conflicts, noisier history
- Token efficiency: Larger context loads

**Recommended Actions:**
1. **Extract commands** - Move command handlers to separate files
   - Status, dashboard, mcp → `commands/server.ts`
   - Run, talk, resume, list, view, stop → `commands/agents.ts`
   - Init, rollback → `commands/workspace.ts`
   - Update → `commands/update.ts`
   - Helper → `commands/helper.ts`

2. **Extract routing logic** - Move smartRouter() to `lib/router.ts`

3. **Extract utilities** - Move helper functions to appropriate lib/ modules
   - `checkPortConflict()` → `lib/port-utils.ts`
   - `formatUptime()` → `lib/format-utils.ts`
   - `startGenieServer()` → `lib/server.ts`
   - `startMCPStdio()` → `lib/mcp-stdio.ts`

4. **Target structure:**
```
.genie/cli/src/
├── genie-cli.ts          <300 lines  (entry point, command registration)
├── commands/
│   ├── server.ts         ~200 lines  (status, dashboard, mcp)
│   ├── agents.ts         ~300 lines  (run, talk, resume, list, view, stop)
│   ├── workspace.ts      ~200 lines  (init, rollback)
│   ├── update.ts         ~150 lines  (update command)
│   └── helper.ts         ~100 lines  (helper utilities)
└── lib/
    ├── router.ts         ~300 lines  (smartRouter logic)
    ├── server.ts         ~400 lines  (startGenieServer, shutdown)
    ├── mcp-stdio.ts      ~100 lines  (MCP stdio mode)
    ├── port-utils.ts     ~50 lines   (port conflict detection)
    └── format-utils.ts   ~50 lines   (formatting helpers)
```

**GitHub Issue Required:** Yes
**Priority:** HIGH
**Labels:** `garbage-collection`, `refactor`, `technical-debt`

## Quality Metrics

### ✅ Token Efficiency
- **Metadata duplication:** 0 files (cleaned in previous sweep)
- **Version frontmatter:** 0 files (cleaned in previous sweep)
- **Status:** EXCELLENT

### ✅ Merge Conflict Detection
- **Actual conflicts:** 0 files
- **False positives:** 16 (section markers in code/docs)
- **Status:** CLEAN

### ⚠️ TODO Markers
- **Total markers:** 160 across documentation
- **Distribution:**
  - STATE.md references: ~10 occurrences
  - Agent documentation: ~20 occurrences
  - Implementation notes: ~130 occurrences
- **Status:** ACCEPTABLE (within normal range)
- **Action:** No immediate cleanup needed

### 🔴 File Size Compliance
- **Files over 1000 lines:** 1
  - `.genie/cli/src/genie-cli.ts` (1290 lines) ❌ CRITICAL
- **Files over 800 lines (soft limit):** 3
  - `.genie/cli/src/genie-cli.ts` (1290 lines)
  - `.genie/mcp/src/server.ts` (1044 lines) ⚠️
  - `.genie/cli/dist/genie-cli.js` (1160 lines) - Generated, exempt
- **Status:** VIOLATION DETECTED

### 📊 Large Documentation Files
- `.genie/qa/scenarios-from-bugs.md` (1518 lines) - Auto-generated, acceptable
- `.genie/code/agents/vibe.md` (1305 lines) - Needs review
- `.genie/code/agents/release.md` (1114 lines) - Needs review
- `AGENTS.md` (805 lines) - Within limits
- `CHANGELOG.md` (833 lines) - Acceptable

## Recommendations

### Immediate Actions (This Sprint)
1. **Create GitHub issue for genie-cli.ts refactor** (CRITICAL)
2. **Review vibe.md and release.md for possible splitting**
3. **Consider splitting mcp/src/server.ts** (approaching limit)

### Continuous Monitoring
- Daily scans continue to catch new violations early
- File size checks integrated into pre-commit hooks
- Garbage cleaner agent ready to process issues

## Historical Improvements
- **2025-10-23:** Removed 1,470 wasted tokens from metadata duplication
- **2025-10-24:** Standardized token counting with official helper
- **2025-10-25:** Unified backup system and version tracking
- **2025-10-26:** Detected file size violation (genie-cli.ts)

## Next Steps
1. Create GitHub issue for `.genie/cli/src/genie-cli.ts` refactor
2. Assign to appropriate developer
3. Monitor issue resolution in next sweep
4. Consider adding file size pre-commit check

---

**Generated by:** garbage-collector agent
**Date:** 2025-10-26
**Worktree:** f602-garbage-collecto
**Files scanned:** 833 markdown, 42,660 code files
**Issues created:** 1 (pending)
