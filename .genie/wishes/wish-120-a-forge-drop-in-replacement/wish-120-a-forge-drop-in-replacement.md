# Wish #120-A: Forge Drop-In Replacement (Quick Win)

**Created:** 2025-10-18
**Parent Wish:** #120 (Forge Executor Replacement)
**GitHub Issue:** TBD (split from #120)
**Status:** 📝 Draft
**Complexity:** 🟡 MEDIUM
**Roadmap Alignment:** Phase 1 (Instrumentation & Telemetry)

---

## 🎯 Mission Statement

**Replace Genie's buggy background-launcher.ts executor with Forge's ForgeClient API in a seamless drop-in replacement with ZERO user-facing changes.**

**Philosophy:** Users should not notice the backend swap. All existing commands work identically, all existing sessions migrate automatically, and all bugs disappear silently.

---

## 🧩 Context & Problem Statement

### Current Pain Points

**Background Launcher Issues:**
1. **Polling Timeout Race:** `background-launcher.ts` uses polling with 30-second timeout, causing false negatives when sessions take >30s to start
2. **PID Tracking Fragility:** `background-manager.ts` tracks PIDs in file system, unreliable on crashes or system restarts
3. **File-Based State:** `sessions.json` is brittle, no transaction safety, prone to corruption
4. **No Parallel Safety:** Multiple concurrent session creations can collide
5. **No Worktree Isolation:** Sessions share filesystem, causing conflicts

### What Forge Provides

**Forge Backend API:**
- ✅ **Atomic task creation:** `createAndStartTask()` is atomic (no polling timeout race)
- ✅ **Backend-managed lifecycle:** No PID tracking needed (Forge manages processes)
- ✅ **Transactional state:** Postgres backend with ACID guarantees
- ✅ **Parallel safety:** Worktree isolation (10+ concurrent sessions safe)
- ✅ **Native session resume:** `followUpTaskAttempt()` built-in

### Prior Work

**Investigation Phase (Completed):**
- ✅ ForgeClient API validated (~94+ endpoints analyzed)
- ✅ POC implementation created (`forge-executor.ts` - 307 lines)
- ✅ 9 investigation reports produced (~8,500 lines documentation)
- ✅ Decision score: 9.2/10 (STRONG YES)

**Reference Documents:**
- Parent wish: `.genie/wishes/forge-executor-replacement/forge-executor-replacement-wish.md`
- 3-wish split strategy: `.genie/reports/3-WISH-SPLIT-STRATEGY-20251018.md`
- Complete endpoint mapping: `.genie/docs/forge-endpoint-mapping.md`

---

## 📦 Scope Definition

### In Scope (MUST preserve exactly)

**User-Facing Commands:**
```bash
genie run analyze "analyze this code"     # Create session
genie resume <id> "follow up"             # Resume session
genie view <id>                           # View logs
genie stop <id>                           # Stop session
genie list                                # List sessions
```

**Behavior Requirements:**
- ✅ CLI output format IDENTICAL (no visual changes)
- ✅ Session IDs remain stable (UUID format preserved)
- ✅ Error messages IDENTICAL (no new jargon like "task attempt")
- ✅ Exit codes IDENTICAL (same success/failure behavior)
- ✅ Configuration IDENTICAL (no new required env vars)

### In Scope (Internal replacement)

**Files to Replace:**
- ❌ DELETE: `background-launcher.ts` (~120 lines) - polling timeout race
- ❌ DELETE: `background-manager.ts` (~150 lines) - PID tracking
- ❌ DELETE: `sessions.json` usage - file-based state
- ✅ ADD: `forge-executor.ts` integration (already exists, needs integration)
- ✅ UPDATE: Handlers (run/resume/stop/list/view) to use Forge API

**Endpoints Used (9 total - Categories 1-4 ONLY):**

| # | Endpoint | Category | Purpose | Phase |
|---|----------|----------|---------|-------|
| 1 | `healthCheck()` | Health | Pre-flight validation | Cross |
| 2 | `listProjects()` | Projects | Auto-discover Genie project | Cross |
| 3 | `createProject()` | Projects | Auto-provision if missing | Cross |
| 4 | `listTasks()` | Tasks | List sessions | Forge |
| 5 | `createAndStartTask()` | Tasks | Create + start session (atomic) | Forge |
| 6 | `getTaskAttempt()` | Task Attempts | Get session status | Forge |
| 7 | `followUpTaskAttempt()` | Task Attempts | Resume session (native) | Forge |
| 8 | `stopTaskAttemptExecution()` | Task Attempts | Stop session | Forge |
| 9 | `getTaskAttemptBranchStatus()` | Task Attempts | Get branch info (for view) | Forge |

### Out of Scope (Deferred to #120-B or #120-C)

**NOT in this wish:**
- ❌ PR creation automation (Wish #120-B)
- ❌ Omni notifications (Wish #120-B)
- ❌ Images as context (Wish #120-B)
- ❌ Executor visibility (Wish #120-B)
- ❌ Templates unification (Wish #120-C)
- ❌ Advanced inspection (Wish #120-C)
- ❌ Migration & updating agent (Wish #120-C)
- ❌ SSE automations (Wish #120-C)

**Principle:** If users can't see it today, it's not in Wish #120-A.

---

## 🔍 Discovery Phase (CRITICAL blockers)

### Discovery #1: Filesystem Restrictions Audit

**Priority:** 🔴 CRITICAL
**Blocking:** Core replacement (safety requirement)
**Complexity:** LOW (code review, ~1-2 hours)

**Problem:**
- Genie MUST NOT touch Forge worktree filesystem (data integrity requirement)
- Current CLI codebase may have direct worktree access (e.g., `view` command reading logs)
- Risk: Race conditions, conflicts, or data corruption if violated

**Investigation Tasks:**
1. Audit all CLI handlers for filesystem access patterns
2. Identify locations where worktree paths are accessed
3. Replace with Forge API calls (e.g., `getTaskAttemptLogs()`)
4. Document restrictions in code comments + pre-commit hooks

**Files to Audit:**
```
.genie/cli/src/
├── cli-core/handlers/run.ts
├── cli-core/handlers/resume.ts
├── cli-core/handlers/view.ts        # ⚠️ Likely reads logs directly
├── cli-core/handlers/stop.ts
├── cli-core/handlers/list.ts
├── lib/background-launcher.ts       # Will be deleted
└── session-store.ts                 # ⚠️ May reference worktree paths
```

**Deliverable:**
- `.genie/discovery/filesystem-restrictions-audit.md`
  - List of all filesystem access points
  - Forge API replacements identified
  - Pre-commit hook script (prevent future violations)

**Success Criteria:**
- [ ] Zero direct worktree access in CLI code
- [ ] All filesystem operations go through Forge API
- [ ] Pre-commit hook enforces restrictions

---

### Discovery #2: Migration Script (sessions.json → Forge)

**Priority:** 🔴 CRITICAL
**Blocking:** User upgrade path
**Complexity:** MEDIUM (data transformation, ~3-4 hours)

**Problem:**
- Existing users have active sessions in `sessions.json`
- Format: `{ sessionId, agent, status, created, lastUsed, background, executor }`
- Must migrate to Forge tasks with ZERO data loss

**Investigation Tasks:**
1. Analyze `sessions.json` schema and edge cases
2. Design migration strategy:
   - Option A: Create Forge tasks for ALL sessions (even completed)
   - Option B: Create Forge tasks for ACTIVE sessions only (archive completed)
   - Option C: Keep `sessions.json` for old sessions, Forge for new (hybrid)
3. Implement migration script with:
   - Dry-run mode (no side effects, show what would happen)
   - Validation mode (check Forge connectivity before migration)
   - Rollback capability (restore `sessions.json` if Forge migration fails)
4. Test with real `sessions.json` samples

**Edge Cases to Handle:**
- Sessions with no `sessionId` (malformed data)
- Sessions with status "running" but process dead
- Sessions created with old Genie versions (different schema)
- Multiple sessions with same name (collision handling)

**Deliverable:**
- `.genie/discovery/migration-sessions-to-forge.md`
  - Migration strategy recommendation (A, B, or C)
  - Edge case handling documented
  - Rollback plan documented
- `.genie/cli/src/lib/migrate-sessions.ts` (migration script)
  - Dry-run mode: `genie migrate --dry-run`
  - Execute: `genie migrate --execute`
  - Rollback: `genie migrate --rollback`

**Success Criteria:**
- [ ] Migration script handles all edge cases
- [ ] Dry-run shows accurate preview
- [ ] Rollback restores original state (tested)
- [ ] Zero data loss in migration (validated with test data)

---

## 🏗️ Implementation Plan

### Group A: Core Integration (Foundation)

**Tasks:**

1. **Integrate forge-executor.ts into genie.ts**
   - Import `createForgeExecutor` factory
   - Initialize Forge client at CLI startup
   - Add health check before operations

2. **Update handlers/run.ts (create session)**
   - Replace `maybeHandleBackgroundLaunch()` with `forgeExecutor.createSession()`
   - Remove polling logic
   - Preserve identical CLI output format

3. **Update handlers/resume.ts (resume session)**
   - Replace re-spawning genie.js with `forgeExecutor.resumeSession()`
   - Use `followUpTaskAttempt()` API
   - Preserve identical CLI output format

4. **Update handlers/stop.ts (stop session)**
   - Replace PID termination with `forgeExecutor.stopSession()`
   - Use `stopTaskAttemptExecution()` API
   - Preserve identical CLI output format

5. **Update handlers/list.ts (list sessions)**
   - Replace `sessions.json` read with `forgeExecutor.listSessions()`
   - Use `listTasks()` API + filter for Genie project
   - Preserve identical CLI output format (table)

6. **Update handlers/view.ts (view logs)**
   - Replace file system log reading with `forgeExecutor.getSessionStatus()`
   - Use `getTaskAttempt()` + `getTaskAttemptLogs()` API
   - Preserve identical CLI output format

7. **Delete deprecated files**
   - Remove `background-launcher.ts` (~120 lines)
   - Remove `background-manager.ts` (~150 lines)
   - Update imports across codebase

8. **Update session-store.ts**
   - Deprecate `sessions.json` writes (read-only for migration)
   - Forge is now source of truth
   - Keep `saveSessions()` stub for backward compatibility during migration

---

### Group B: Migration & Safety

**Tasks:**

9. **Create migration script (sessions.json → Forge)**
   - Implement based on Discovery #2 findings
   - Add dry-run mode
   - Add validation mode (pre-flight checks)
   - Add rollback capability

10. **Test migration (dry-run mode)**
    - Test with empty `sessions.json`
    - Test with active sessions
    - Test with completed sessions
    - Test with malformed data (edge cases)

11. **Document rollback plan**
    - `.genie/docs/forge-executor-rollback.md`
    - Steps to revert to `background-launcher.ts`
    - Restore `sessions.json` from backup
    - Downgrade procedure

12. **Filesystem audit (Discovery #1)**
    - Execute audit per Discovery #1 plan
    - Replace all worktree access with Forge API
    - Add pre-commit hook to prevent future violations

13. **Update pre-commit hooks**
    - Add filesystem restriction enforcement
    - Block commits that access `/var/tmp/automagik-forge/worktrees/`
    - Exception: Forge executor itself (allowed)

---

### Group C: Testing & Validation

**Tasks:**

14. **Run 7 POC test cases**
    - From `.genie/reports/TEST-PLAN-POC-20251018.md`:
      1. Session creation (basic)
      2. Session resume (follow-up)
      3. Session stop (graceful termination)
      4. Session list (multiple sessions)
      5. Session view (logs retrieval)
      6. Concurrent sessions (parallel safety)
      7. Migration (sessions.json → Forge)

15. **Stress test: 10 parallel sessions**
    - Create 10 genie sessions simultaneously
    - Validate: No collisions, all sessions start successfully
    - Validate: Worktree isolation (no filesystem conflicts)

16. **Performance validation (session creation < 5s)**
    - Measure session creation latency (goal: < 5s)
    - Compare vs. old background-launcher (baseline: 5-20s)
    - Validate: No timeout failures (atomic API call)

---

### Group D: Documentation & Release

**Tasks:**

17. **Update CLI documentation**
    - No user-facing changes needed (commands identical)
    - Update internal developer docs:
      - `CONTRIBUTING.md`: Mention Forge dependency
      - `.genie/docs/architecture.md`: Document Forge integration

18. **Create upgrade guide**
    - `.genie/docs/forge-executor-upgrade.md`
    - Steps to upgrade from old background-launcher
    - Migration script usage
    - Rollback instructions
    - FAQ (common issues)

19. **Evidence checklist (Roadmap Phase 1 requirement)**
    - `.genie/evidence/wish-120-a-validation.md`
    - Validation commands for all success criteria
    - Test results logged
    - Performance metrics captured

20. **Done report**
    - `.genie/reports/wish-120-a-done-report.md`
    - Scope achieved (drop-in replacement)
    - Risks mitigated (filesystem audit, migration tested)
    - Follow-ups identified (Wish #120-B, #120-C)

---

## ✅ Success Criteria

### Functional Requirements

- [ ] **Feature Parity:** All existing commands work identically (run, resume, view, stop, list)
- [ ] **CLI Output:** Output format unchanged (users see no difference)
- [ ] **Migration:** Existing sessions migrate automatically with zero data loss
- [ ] **Error Handling:** Error messages identical (no new jargon)
- [ ] **Configuration:** No new required environment variables (Forge URL auto-detected or defaulted)

### Performance Requirements

- [ ] **Session Creation:** < 5s latency (vs. current 5-20s)
- [ ] **Reliability:** 0 timeout failures (vs. current false negatives)
- [ ] **Parallel Safety:** 10+ concurrent sessions safe (vs. current unsafe)

### Code Quality Requirements

- [ ] **Code Reduction:** ~40% reduction achieved (delete ~270 lines: background-launcher + background-manager)
- [ ] **Filesystem Audit:** Zero direct worktree access in CLI code
- [ ] **Tests Passing:** `pnpm run check` passes (all lints, types, tests)
- [ ] **Rollback Plan:** Documented and tested

### Safety Requirements

- [ ] **Migration Tested:** Dry-run + real migration validated
- [ ] **Rollback Tested:** Downgrade procedure validated
- [ ] **Pre-commit Hooks:** Filesystem restrictions enforced
- [ ] **Documentation Complete:** Upgrade guide + rollback plan + evidence checklist

---

## 📊 Complexity Assessment

**Overall Complexity:** 🟡 MEDIUM

**Dimensions:**

| Dimension | Score | Justification |
|-----------|-------|---------------|
| **Technical Complexity** | 🟡 MEDIUM | Drop-in replacement, well-understood (POC exists) |
| **Integration Points** | 🟢 LOW | Only 9 endpoints (Categories 1-4) |
| **Discovery Required** | 🟡 MEDIUM | 2 critical discoveries (filesystem audit, migration) |
| **Risk Level** | 🟢 LOW | Rollback plan, extensive testing, no user-facing changes |
| **Dependencies** | 🟢 LOW | Forge backend (already available) |

**Total Tasks:** 20 (8 core integration, 5 migration/safety, 3 testing, 4 documentation)

---

## 🚨 Risks & Mitigations

### Risk #1: Migration Script Fails

**Probability:** LOW
**Impact:** HIGH (users lose sessions)

**Mitigation:**
- Dry-run mode (test without side effects)
- Rollback capability (restore `sessions.json` backup)
- Extensive testing (all edge cases covered)
- Pre-migration validation (check Forge connectivity)

---

### Risk #2: Filesystem Violations

**Probability:** LOW
**Impact:** HIGH (data corruption, race conditions)

**Mitigation:**
- Code audit (identify all worktree access points)
- Pre-commit hooks (prevent future violations)
- Documentation (clear restrictions in code comments)

---

### Risk #3: User Experience Regression

**Probability:** LOW
**Impact:** MEDIUM (user confusion, support burden)

**Mitigation:**
- Identical CLI output (no visual changes)
- Behavior validation (all commands work identically)
- Upgrade guide (clear instructions)
- Rollback plan (downgrade if needed)

---

## 🗺️ Roadmap Alignment

**Phase 1 - Instrumentation & Telemetry:** ✅ Perfect Fit

**How This Wish Aligns:**
- ✅ **Evidence checklist:** Validation commands for all success criteria
- ✅ **Done report:** Scope, risks, follow-ups documented
- ✅ **CLI diagnostics:** Surface Forge connection issues (health check)

**Roadmap Quote:**
> "Add branch-specific checklists to every wish to log evidence paths and validation commands"

**Deliverables for Roadmap:**
- Evidence checklist: `.genie/evidence/wish-120-a-validation.md`
- Done report: `.genie/reports/wish-120-a-done-report.md`
- Rollback plan: `.genie/docs/forge-executor-rollback.md`

---

## 📚 Reference Documents

**Parent Wish:**
- `.genie/wishes/forge-executor-replacement/forge-executor-replacement-wish.md`

**Investigation Reports:**
- `.genie/reports/3-WISH-SPLIT-STRATEGY-20251018.md` (this wish's context)
- `.genie/reports/FORGE-GENIE-INTEGRATION-ANALYSIS-20251018.md` (endpoint analysis)
- `.genie/reports/COMPLEXITY-ANALYSIS-20251018.md` (scope evolution)

**Endpoint Documentation:**
- `.genie/docs/forge-endpoint-mapping.md` (complete endpoint guide)
- `.genie/docs/discovery-checklist.md` (Discovery investigations)
- `.genie/docs/implementation-blockers.md` (blockers identified)

**POC Implementation:**
- `.genie/cli/src/lib/forge-executor.ts` (307 lines, ready to integrate)

---

## 🎯 Definition of Done

**This wish is complete when:**

1. ✅ All existing CLI commands work identically (no user-facing changes)
2. ✅ Migration script tested and validated (dry-run + real migration)
3. ✅ Filesystem audit complete (zero worktree violations)
4. ✅ Performance targets met (< 5s session creation, 0 timeouts, 10+ parallel)
5. ✅ Code reduction achieved (~40%, ~270 lines deleted)
6. ✅ All tests passing (`pnpm run check`)
7. ✅ Rollback plan documented and tested
8. ✅ Evidence checklist complete (validation commands logged)
9. ✅ Done report published (scope, risks, follow-ups)
10. ✅ PR merged to main

**User Experience Validation:**
```bash
# Before upgrade (old background-launcher):
genie run analyze "test"  # Sometimes fails with timeout after 30s

# After upgrade (Forge executor):
genie run analyze "test"  # Always succeeds, < 5s, identical output
```

**No visible difference** = Success! 🎉

---

## 📈 Success Metrics

**Quantitative:**
- [ ] Session creation latency: **< 5s** (vs. 5-20s baseline)
- [ ] Timeout failure rate: **0%** (vs. ~10-20% with polling)
- [ ] Parallel session capacity: **10+** (vs. unsafe concurrency)
- [ ] Code reduction: **~40%** (~270 lines deleted)
- [ ] Migration success rate: **100%** (zero data loss)

**Qualitative:**
- [ ] Users report: "I didn't notice anything changed"
- [ ] No new GitHub issues related to session creation
- [ ] No rollbacks needed (stable from day 1)

---

## 🚀 Next Steps (After Completion)

**Immediate Follow-Ups:**
1. **Wish #120-B:** Low-hanging fruits (PR automation, Omni, images, executor visibility)
2. **Wish #120-C:** Advanced features (templates, migration agent, SSE automations)

**Dependencies Unlocked:**
- This wish unlocks all Forge backend features for future wishes
- Establishes patterns for Forge API integration
- Proves stability and reliability of Forge backend

---

**Document Author:** Genie (forge/120-executor-replacement)
**Version:** 1.0.0
**Last Updated:** 2025-10-18
**Status:** 📝 Draft - Ready for Review
