# Implementation Blockers - Forge Executor Replacement
**Date:** 2025-10-18
**Task:** Issue #120
**Status:** ✅ Identified - Ready for Resolution
**Purpose:** Document all blockers preventing Group A-D implementation

---

## 📋 Executive Summary

**Implementation Status:** ⚠️ **BLOCKED**

**Reason:** Complete endpoint mapping requires Discovery phase validation for 60+ endpoints (Categories 6-15) before implementation can proceed.

**Key Decision:** "This will not start until all endpoints are mapped to naturally work within Genie" (user requirement)

**Blockers Identified:** 3 critical, 2 medium, 2 low priority

---

## Part 1: Critical Blockers (MUST RESOLVE BEFORE GROUP A)

### Blocker #1: Approvals Endpoint Validation
**Priority:** 🔴 CRITICAL
**Category:** 8 (Approvals)
**Discovery Time:** 1-2 days
**Blocking:** Group A (Git integration, PR creation workflow)

**Problem:**
- Group A includes `createTaskAttemptPullRequest()` which should respect approval gate
- Forge's `createApprovalRequest/get/respond` endpoints not yet validated
- Unknown if Forge endpoint matches our "final gate (pre-merge)" use case

**What We Need:**
1. Confirm `createApprovalRequest()` payload structure
2. Validate blocking behavior (wait for response)
3. Test context attachment (diffs, test results, branch status)
4. Confirm SSE event emitted on approval request/response
5. Identify gaps between Forge endpoint and our needs

**Resolution Path:**
- **Discovery Investigation:** `.genie/discovery/approvals-validation.md`
- **Deliverable:** Endpoint documentation + recommendation (use as-is, wrapper, or custom service)
- **Timeline:** 1-2 days
- **Owner:** TBD (assign to Discovery sprint)

**Acceptance Criteria:**
- [ ] Endpoint payloads documented
- [ ] Blocking behavior confirmed or workaround designed
- [ ] SSE integration validated
- [ ] Go/no-go decision made

**Risk if Not Resolved:**
- Cannot implement PR creation workflow (Group A task #11)
- Cannot implement review gate (immediate implementation plan item #1)
- Approval strategy undefined (user experience unclear)

---

### Blocker #2: Filesystem Restrictions Audit
**Priority:** 🔴 CRITICAL
**Category:** 13 (Filesystem)
**Audit Time:** 1 day
**Blocking:** Group A (core replacement)

**Problem:**
- Genie MUST NOT touch Forge worktree filesystem (data integrity requirement)
- Current CLI codebase may have direct worktree access
- Risk of race conditions, conflicts, or data corruption if violated

**What We Need:**
1. Audit all CLI code for filesystem operations
2. Identify any direct worktree path references
3. Ensure all file operations go through Forge API
4. Document restrictions in architecture guide

**Resolution Path:**
- **Code Audit:** Review `.genie/cli/src/` for `fs.readFile`, `fs.writeFile`, path manipulation
- **Documentation:** `.genie/docs/forge-architecture.md` (Filesystem restrictions section)
- **Timeline:** 1 day
- **Owner:** TBD (can be parallelized with Discovery)

**Files to Audit:**
```
.genie/cli/src/
├── cli-core/handlers/run.ts
├── cli-core/handlers/resume.ts
├── cli-core/handlers/view.ts
├── cli-core/handlers/stop.ts
├── cli-core/handlers/list.ts
├── lib/background-launcher.ts
├── lib/background-manager.ts
└── session-store.ts
```

**Acceptance Criteria:**
- [ ] All CLI code audited
- [ ] No direct worktree access found (or violations fixed)
- [ ] Architecture guide updated with restrictions
- [ ] Pre-commit hook validates no worktree paths

**Risk if Not Resolved:**
- Data corruption in Forge worktrees
- Race conditions between Genie and Forge
- Parallel execution safety compromised
- Worktree isolation broken

---

### Blocker #3: SSE Listener Foundation
**Priority:** 🔴 CRITICAL
**Category:** 15 (SSE)
**Implementation Time:** 2-3 days
**Blocking:** Group A (Omni notifications)

**Problem:**
- Omni notifications depend on SSE subscription (always-on background listener)
- SSE listener architecture not yet designed
- Event routing to Omni not implemented
- CLI `watch` command foundation missing

**What We Need:**
1. Design background service architecture (daemon? thread? subprocess?)
2. Implement SSE subscription to Forge global events
3. Design event routing (which events → Omni? which → CLI?)
4. Implement basic event handling (log, notify, update state)
5. Implement `genie watch` command (on-demand terminal output)

**Resolution Path:**
- **Architecture Design:** `.genie/docs/sse-listener-architecture.md`
- **Implementation:** `.genie/cli/src/services/sse-listener.ts`
- **Timeline:** 2-3 days
- **Owner:** TBD (part of Group A implementation)

**Design Considerations:**
- **Background Process:** Always-on daemon or spawned on demand?
- **Reconnection Logic:** Auto-reconnect on disconnect
- **Event Buffering:** Handle events during offline periods?
- **State Persistence:** Track last processed event?

**Acceptance Criteria:**
- [ ] SSE listener design documented
- [ ] Background service implemented
- [ ] Event routing to Omni functional
- [ ] `genie watch` command working
- [ ] Reconnection logic tested

**Risk if Not Resolved:**
- No Omni notifications (broken promise from integration analysis)
- No SSE automations (future capability blocked)
- No `watch` command (monitoring gap)

---

## Part 2: Medium Priority Blockers (SHOULD RESOLVE BEFORE GROUP B-C)

### Blocker #4: Templates Discovery
**Priority:** 🟡 MEDIUM
**Category:** 9 (Templates)
**Discovery Time:** 2-3 days
**Blocking:** Group C (template selection workflow)

**Problem:**
- Genie has "code/create" templates
- Forge has template system (not yet inventoried)
- Unknown if we should unify or keep separate
- Dependency on Wish #110 (Multi-template architecture)

**What We Need:**
1. Inventory all Forge templates (names, metadata, purpose)
2. Compare with Genie's "code/create"
3. Decide unification strategy (use Forge only? keep both? hybrid?)
4. Map agent types to templates

**Resolution Path:**
- **Discovery Investigation:** `.genie/discovery/templates-inventory.md`
- **Timeline:** 2-3 days
- **Owner:** TBD (Discovery sprint)

**Acceptance Criteria:**
- [ ] Forge templates documented
- [ ] Compatibility analysis complete
- [ ] Unification decision made
- [ ] Migration guide written (if unified)

**Risk if Not Resolved:**
- Template confusion (which to use?)
- Wish #110 implementation unclear
- CLI `genie init --template` ambiguous

---

### Blocker #5: Executors/MCP Discovery
**Priority:** 🟡 MEDIUM
**Category:** 11 (Configuration)
**Discovery Time:** 2-3 days
**Blocking:** Group B (executor info command)

**Problem:**
- Dynamic executor discovery not yet designed
- Forge profile IDs → Genie-friendly names mapping undefined
- MCP unification strategy unclear (Genie MCPs vs. Forge MCPs)

**What We Need:**
1. Document `listExecutorProfiles()` response structure
2. Design name mapping (profile ID → friendly name)
3. Design fallback when executor unavailable
4. Decide MCP unification (shared vs. separate)

**Resolution Path:**
- **Discovery Investigation:** `.genie/discovery/executors-discovery.md`
- **Discovery Investigation:** `.genie/discovery/mcp-unification.md`
- **Timeline:** 2-3 days
- **Owner:** TBD (Discovery sprint)

**Acceptance Criteria:**
- [ ] Executor profiles documented
- [ ] Name mapping implemented
- [ ] Fallback logic designed
- [ ] MCP unification decision made
- [ ] `genie info executors` ready

**Risk if Not Resolved:**
- No executor visibility in CLI
- User confusion about available executors
- MCP configuration conflicts

---

## Part 3: Low Priority Blockers (POST-MVP)

### Blocker #6: Drafts Validation
**Priority:** 🔵 LOW
**Category:** 7 (Drafts)
**Discovery Time:** 1-2 days
**Blocking:** None (deprioritized)

**Problem:**
- Drafts (checkpoints) use case unclear
- May be redundant with task attempts
- No user demand validated

**What We Need:**
1. Identify real use cases (if any)
2. Compare with task attempts (is there overlap?)
3. Validate user demand
4. Decide: implement, defer, or reject

**Resolution Path:**
- **Discovery Investigation:** `.genie/discovery/drafts-validation.md`
- **Timeline:** 1-2 days
- **Owner:** TBD (low priority, can skip for MVP)

**Acceptance Criteria:**
- [ ] Use cases identified
- [ ] Comparison with attempts complete
- [ ] User demand validated
- [ ] Decision made (yes/no/later)

**Risk if Not Resolved:**
- None (deprioritized for MVP)

---

### Blocker #7: SSE Automations Catalog
**Priority:** 🔵 LOW
**Category:** 15 (SSE)
**Discovery Time:** 2-3 days
**Blocking:** None (SSE listener foundation sufficient for MVP)

**Problem:**
- SSE automations not yet cataloged (what actions on which events?)
- Idempotency logic undefined
- Retry strategy unclear

**What We Need:**
1. Document all SSE event types
2. Brainstorm safe automations
3. Design idempotency checks
4. Design retry logic
5. Categorize: automatic vs. confirm vs. manual

**Resolution Path:**
- **Discovery Investigation:** `.genie/discovery/sse-automations-catalog.md`
- **Timeline:** 2-3 days
- **Owner:** TBD (can be done after MVP)

**Acceptance Criteria:**
- [ ] Event catalog complete
- [ ] 5-10 safe automations identified
- [ ] Idempotency logic designed
- [ ] Retry strategy documented

**Risk if Not Resolved:**
- SSE listener only notifies, doesn't automate (less value)
- Manual actions required for common tasks

---

## Part 4: Implementation Sequencing

### Phase 0: Discovery Sprint (BEFORE Group A)
**Duration:** 2-3 weeks
**Parallelizable:** YES

**HIGH Priority (Week 1-2):**
- [ ] Blocker #1: Approvals validation (1-2 days)
- [ ] Blocker #2: Filesystem audit (1 day)
- [ ] Blocker #4: Templates discovery (2-3 days)
- [ ] Blocker #5: Executors/MCP discovery (2-3 days)

**MEDIUM Priority (Week 2-3):**
- [ ] Blocker #3: SSE listener foundation (2-3 days) - can start in parallel with discoveries

**LOW Priority (Post-MVP):**
- [ ] Blocker #6: Drafts validation (defer)
- [ ] Blocker #7: SSE automations catalog (defer)

**Output:**
- 5 discovery reports
- Go/no-go decisions for each feature
- Updated endpoint mapping
- SSE listener implemented
- Filesystem audit complete

**Gate:** ALL HIGH priority blockers resolved before Group A starts

---

### Phase 1: Group A (AFTER Discovery Sprint)
**Duration:** 2-3 weeks
**Dependencies:** Blockers #1, #2, #3 resolved

**Tasks:**
- Core replacement (7 tasks)
- Git integration (9 tasks)
- Total: 16 tasks

**Blockers Resolved:**
- ✅ Approvals endpoint validated
- ✅ Filesystem restrictions enforced
- ✅ SSE listener functional

---

### Phase 2: Group B (AFTER Group A)
**Duration:** 1-2 weeks
**Dependencies:** Blocker #5 resolved (optional)

**Tasks:**
- Streaming features (4 tasks)
- Inspection/audit (4 tasks)
- Total: 8 tasks

**Blockers Resolved:**
- ✅ Executors/MCP discovery (optional, can proceed with fallback)

---

### Phase 3: Group C (AFTER Group B)
**Duration:** 1-2 weeks
**Dependencies:** Blocker #4 resolved (optional)

**Tasks:**
- Advanced features (3 tasks)
- Notifications (4 tasks)
- Total: 7 tasks

**Blockers Resolved:**
- ✅ Templates discovery (optional, can use existing "code/create")

---

### Phase 4: Group D (AFTER Group C)
**Duration:** 1-2 weeks
**Dependencies:** None

**Tasks:**
- Migration & testing (6 tasks)
- Updating agent (4 tasks)
- Total: 10 tasks

**Blockers Resolved:**
- N/A (no blockers)

---

## Part 5: Resolution Strategy

### Parallel Execution Plan

**Week 1-2: Discovery Sprint (HIGH Priority)**
```
┌─────────────────────────────────────────┐
│ Blocker #1 (Approvals)      │ 1-2 days │
│ Blocker #2 (Filesystem)     │ 1 day    │
│ Blocker #4 (Templates)      │ 2-3 days │
│ Blocker #5 (Executors/MCP)  │ 2-3 days │
└─────────────────────────────────────────┘
          ↓
    ALL PARALLEL
          ↓
   Discovery Reports
```

**Week 2-3: SSE Listener Implementation (CRITICAL)**
```
┌─────────────────────────────────────────┐
│ Blocker #3 (SSE Listener)   │ 2-3 days │
└─────────────────────────────────────────┘
          ↓
   SSE Listener Ready
```

**Week 3-4: Group A Implementation**
```
┌─────────────────────────────────────────┐
│ Group A (16 tasks)          │ 2-3 wks  │
└─────────────────────────────────────────┘
          ↓
   Core Replacement Done
```

**Total Timeline:** 5-7 weeks (Discovery + Group A)

---

## Part 6: Risk Mitigation

### Risk #1: Discovery Findings Block Implementation
**Probability:** MEDIUM
**Impact:** HIGH
**Mitigation:**
- Design fallback for each discovery item
- Example: If approvals endpoint insufficient, design custom service
- Example: If templates can't unify, keep "code/create" as-is

### Risk #2: SSE Listener Complexity Underestimated
**Probability:** MEDIUM
**Impact:** MEDIUM
**Mitigation:**
- Start with MVP (basic event logging + Omni notification)
- Defer automations to post-MVP
- Use proven libraries (EventSource, reconnection logic)

### Risk #3: Filesystem Audit Finds Violations
**Probability:** LOW
**Impact:** HIGH
**Mitigation:**
- If violations found, refactor to use Forge API
- May add 1-2 days to audit timeline
- Pre-commit hook prevents future violations

### Risk #4: Scope Creep During Discovery
**Probability:** HIGH
**Impact:** MEDIUM
**Mitigation:**
- Strict timebox: 2-3 weeks for Discovery sprint
- Focus on go/no-go decisions, not perfect solutions
- Defer nice-to-have findings to post-MVP

---

## Part 7: Success Criteria

### Discovery Sprint Complete When:
- [ ] All HIGH priority blockers resolved (3 items)
- [ ] All MEDIUM priority blockers resolved or deferred with plan (2 items)
- [ ] 5 discovery reports written (following template)
- [ ] Endpoint mapping updated with findings
- [ ] Go/no-go decisions documented
- [ ] SSE listener implemented and tested
- [ ] Filesystem audit complete with no violations

### Group A Ready to Start When:
- [ ] Blocker #1 (Approvals) resolved
- [ ] Blocker #2 (Filesystem) resolved
- [ ] Blocker #3 (SSE) resolved
- [ ] Implementation roadmap updated
- [ ] Team assigned and ready

---

## Part 8: Communication Plan

### Stakeholder Updates

**Week 1 (Discovery Start):**
- Email: Discovery sprint launched, 3 weeks estimated
- Slack: Daily standup updates on progress
- Report: Discovery findings as they emerge

**Week 2 (Discovery Mid-point):**
- Email: Discovery progress report (2 reports done, 3 in progress)
- Slack: Any blockers or surprises surface immediately
- Meeting: Review findings so far, adjust timeline if needed

**Week 3 (Discovery Complete):**
- Email: Discovery complete, all blockers resolved or deferred
- Document: Updated endpoint mapping + implementation plan
- Meeting: Go/no-go decision for Group A implementation

**Week 4+ (Implementation):**
- Email: Group A started, ETA 2-3 weeks
- Slack: Daily progress updates
- Demo: Mid-implementation demo of core features

---

## Appendix: Quick Reference

### Blocker Summary Table

| ID | Blocker | Priority | Time | Blocking | Status |
|----|---------|----------|------|----------|--------|
| #1 | Approvals | 🔴 HIGH | 1-2d | Group A | 📋 TODO |
| #2 | Filesystem | 🔴 HIGH | 1d | Group A | 📋 TODO |
| #3 | SSE Listener | 🔴 HIGH | 2-3d | Group A | 📋 TODO |
| #4 | Templates | 🟡 MED | 2-3d | Group C | 📋 TODO |
| #5 | Executors/MCP | 🟡 MED | 2-3d | Group B | 📋 TODO |
| #6 | Drafts | 🔵 LOW | 1-2d | None | 📋 TODO |
| #7 | SSE Automations | 🔵 LOW | 2-3d | None | 📋 TODO |

### Resolution Timeline

```
Week 1-2: Discovery Sprint (HIGH Priority)
  ├─ Blocker #1 (Approvals)
  ├─ Blocker #2 (Filesystem)
  ├─ Blocker #4 (Templates)
  └─ Blocker #5 (Executors/MCP)

Week 2-3: SSE Implementation (CRITICAL)
  └─ Blocker #3 (SSE Listener)

Week 3-4: Group A (AFTER All Blockers Resolved)
  └─ 16 tasks (Core + Git)

Total: 5-7 weeks (Discovery + Group A)
```

---

## Conclusion

**Implementation Status:** ⚠️ **BLOCKED** (Discovery Sprint Required)

**Resolution Path:** 2-3 week Discovery sprint → Group A implementation

**Next Actions:**
1. Create GitHub issues for Discovery items
2. Assign owners to each blocker
3. Schedule Discovery sprint kickoff
4. Begin investigations in parallel
5. Daily standups to track progress

**Recommendation:** ✅ **PROCEED WITH DISCOVERY SPRINT**

---

**Document Author:** Genie (forge/120-executor-replacement)
**Version:** 1.0.0
**Status:** ✅ Blockers Identified - Ready for Resolution
