# 3-Wish Split Strategy - Forge Executor Replacement
**Date:** 2025-10-18
**Task:** Issue #120
**Strategy:** Quick Win → Low-Hanging Fruits → Advanced Features
**Roadmap Alignment:** Phase 2-3 (Guided Self-Improvement → Adoption Kits)

---

## 🎯 Strategic Split Overview

### Core Principle: **SEAMLESS DROP-IN REPLACEMENT FIRST**

**Philosophy:**
1. **Wish #120-A (Quick Win):** Replace what exists TODAY with zero feature changes
2. **Wish #120-B (Low-Hanging Fruits):** Add features that are easy + high value
3. **Wish #120-C (Advanced Features):** Add complex features that require deep integration

**Goal:** Users don't notice the switch (Wish A), then get delighted by improvements (Wish B-C)

---

## Part 1: Wish #120-A - Drop-In Replacement (QUICK WIN)

### 🎯 Mission: Replace background-launcher.ts with ZERO user-facing changes

**Scope:** Exact 1:1 replacement of current functionality

**What Users Have TODAY (must preserve):**
```bash
genie run analyze "analyze this code"     # Create session
genie resume <id> "follow up"             # Resume session
genie view <id>                           # View logs
genie stop <id>                           # Stop session
genie list                                # List sessions
```

**What We Replace (internal only):**
- ❌ background-launcher.ts (polling timeout race)
- ❌ background-manager.ts (PID tracking)
- ❌ sessions.json (file-based state)
- ✅ forge-executor.ts (Forge API)
- ✅ Forge task attempts (backend state)

**Endpoints Used (Categories 1-4 ONLY):**
1. `healthCheck()` - Pre-flight validation
2. `listProjects()` - Auto-discover Genie project
3. `createProject()` - Auto-provision if missing
4. `listTasks()` - List sessions
5. `createAndStartTask()` - Create + start session (atomic, no polling)
6. `getTaskAttempt()` - Get session status
7. `followUpTaskAttempt()` - Resume session (native)
8. `stopTaskAttemptExecution()` - Stop session
9. `getTaskAttemptBranchStatus()` - Get branch info (for view)

**Total Endpoints:** 9 (out of 94+)

**User-Facing Changes:** ❌ **ZERO**

**Internal Changes:**
- ✅ No more polling timeout race (atomic API calls)
- ✅ Worktree isolation (parallel safety)
- ✅ Backend-managed lifecycle (no PID tracking)
- ✅ sessions.json → Forge tasks (transparent migration)

---

### Discovery Required (CRITICAL blockers only)

**Blocker #1: Filesystem Restrictions Audit**
- **Task:** Audit CLI code for direct worktree access
- **Deliverable:** Ensure Genie never touches Forge worktree
- **Complexity:** LOW (code review)
- **Blocking:** Core replacement (safety requirement)

**Blocker #2: Migration Script (sessions.json → Forge)**
- **Task:** Convert existing sessions to Forge tasks
- **Deliverable:** Zero data loss, seamless transition
- **Complexity:** MEDIUM (data transformation)
- **Blocking:** User upgrade path

**No other Discovery needed for Wish A** - use what Forge already provides

---

### Success Criteria (Wish #120-A)

**Functional:**
- [ ] All existing commands work identically
- [ ] No user-visible changes (CLI output same format)
- [ ] Existing sessions migrate automatically
- [ ] No data loss during migration

**Performance:**
- [ ] Session creation < 5s (vs. current 5-20s)
- [ ] No timeout failures (vs. current false negatives)
- [ ] 10+ parallel sessions safe (vs. current unsafe)

**Code Quality:**
- [ ] Delete background-launcher.ts (~120 lines)
- [ ] Delete background-manager.ts (~150 lines)
- [ ] ~40% code reduction achieved

**Safety:**
- [ ] Filesystem audit passed (no worktree violations)
- [ ] All tests passing (`pnpm run check`)
- [ ] Migration script tested (dry-run + real)
- [ ] Rollback plan documented

---

### Roadmap Alignment (Wish #120-A)

**Phase 1 - Instrumentation & Telemetry:** ✅ Fits naturally
- Evidence checklist: Migration validation commands
- Done-report: Scope (drop-in), risks (data migration), follow-ups (Wish B-C)
- CLI diagnostics: Surface Forge connection issues

**Deliverable for Roadmap:** Seamless backend swap with validation artifacts

---

### Tasks Breakdown (Wish #120-A)

**Core Replacement:**
1. Integrate forge-executor.ts into genie.ts
2. Update handlers/run.ts (use Forge createAndStartTask)
3. Update handlers/resume.ts (use Forge followUpTaskAttempt)
4. Update handlers/stop.ts (use Forge stopTaskAttemptExecution)
5. Update handlers/list.ts (use Forge listTasks)
6. Update handlers/view.ts (use Forge getTaskAttempt + logs)
7. Delete background-launcher.ts
8. Delete background-manager.ts

**Migration:**
9. Create migration script (sessions.json → Forge tasks)
10. Test migration (dry-run mode)
11. Document rollback plan

**Safety:**
12. Audit filesystem access (ensure no worktree violations)
13. Update pre-commit hooks (enforce restrictions)

**Testing:**
14. Run 7 POC test cases (from TEST-PLAN-POC-20251018.md)
15. Stress test: 10 parallel sessions
16. Performance validation (session creation < 5s)

**Total Tasks:** 16

**Complexity:** 🟡 MEDIUM (drop-in replacement, well-understood)

---

## Part 2: Wish #120-B - Low-Hanging Fruits (HIGH VALUE, LOW EFFORT)

### 🎯 Mission: Add features that are easy + high value

**Scope:** Features users will immediately notice and love

**What Users Get (NEW capabilities):**

**1. Git Integration (automatic PR creation):**
```bash
# After genie completes task, automatically:
# - Creates PR to main
# - Links to GitHub issue
# - Includes all commits with tracing
# - Shows PR URL in terminal

# Manual control available:
genie review <id>          # Review changes + create PR
genie review approve <id>  # Approve + merge
```

**Endpoints Used:**
- `createTaskAttemptPullRequest()` - Auto PR creation
- `attachExistingPullRequest()` - Link existing PR
- `mergeTaskAttempt()` - One-click merge
- `pushTaskAttemptBranch()` - Push to remote
- `abortTaskAttemptConflicts()` - Rollback conflicts

**2. Real-Time Notifications (Omni integration):**
```bash
# User receives WhatsApp/Slack/Discord notifications:
# - 🧞 "Genie session started: analyze (session-123)"
# - ✅ "Genie session completed: analyze (session-123)"
# - 🔀 "PR created: https://github.com/.../pull/456"
```

**Endpoints Used:**
- `subscribeToEvents()` (SSE) - Global event stream
- Omni integration (already exists in Forge)

**3. Images as Context (visual planning/review):**
```bash
genie wish attach-image ./diagram.png --label "Architecture"
genie review attach-image ./result.png --label "Final UI"
```

**Endpoints Used:**
- `uploadImage()` - Upload image
- `listImages()` - List attachments
- `getImage()` - Retrieve image

**4. Executor Visibility (dynamic discovery):**
```bash
genie info executors
# Output:
# ✅ Claude Code (CLAUDE_CODE) - Available
# ✅ Codex (CODEX) - Available
# ❌ Gemini (GEMINI) - Unavailable
```

**Endpoints Used:**
- `listExecutorProfiles()` - Discover executors
- `getExecutorProfile()` - Get executor details

**Total New Endpoints:** ~15

**User-Facing Changes:** ✅ **HIGH VALUE** (PR automation, notifications, images, executor visibility)

---

### Discovery Required (MEDIUM priority)

**Discovery #1: Approvals Endpoint Validation**
- **Task:** Validate Forge approval flow for PR creation
- **Deliverable:** Confirm `createApprovalRequest()` matches our needs
- **Complexity:** LOW-MEDIUM (API validation)

**Discovery #2: SSE Event Mapping**
- **Task:** Map Forge events → Omni notifications
- **Deliverable:** Event catalog + routing logic
- **Complexity:** LOW (leverage existing Omni integration)

**Discovery #3: Executor Name Mapping**
- **Task:** Map Forge profile IDs → Genie-friendly names
- **Deliverable:** Name mapping specification
- **Complexity:** LOW (simple mapping)

---

### Success Criteria (Wish #120-B)

**Functional:**
- [ ] PR creation works (automatic + manual)
- [ ] Omni notifications delivered (< 5s latency)
- [ ] Images attach to wishes/reviews
- [ ] Executor info visible in CLI

**User Experience:**
- [ ] PR creation reduces manual steps (80% reduction)
- [ ] Notifications improve awareness (real-time updates)
- [ ] Images improve planning (visual context)
- [ ] Executor visibility improves debugging

**Code Quality:**
- [ ] Git integration tests passing
- [ ] SSE listener stable (reconnection logic)
- [ ] Image upload working (all formats)
- [ ] Executor discovery dynamic (no hardcoding)

---

### Roadmap Alignment (Wish #120-B)

**Phase 2 - Guided Self-Improvement:** ✅ Perfect fit
- **Autonomous MCP features:** SSE automations, PR creation (less manual intervention)
- **Tight Forge integration:** Leverage Forge Git + Omni capabilities

**Deliverable for Roadmap:** Enhanced autonomous features with Forge backend

**Roadmap Item (proposed):**
> **2. Enhanced Autonomous MCP Features**
> - Real-time notifications via Omni (WhatsApp/Slack/Discord)
> - Automatic PR creation and management
> - Visual context support (images in planning/review)
> - Dynamic executor discovery

---

### Tasks Breakdown (Wish #120-B)

**Git Integration:**
1. Implement PR creation workflow
2. Implement PR approval gate (pre-merge)
3. Implement merge automation
4. Implement conflict rollback
5. Add `genie review` command

**Omni Notifications:**
6. Implement SSE listener (background service)
7. Map Forge events → Omni messages
8. Add event filtering (user config)
9. Add `genie watch` command (optional terminal output)

**Images:**
10. Implement image upload
11. Implement image listing
12. Add `genie wish attach-image` command
13. Add `genie review attach-image` command

**Executor Info:**
14. Implement dynamic executor discovery
15. Add `genie info executors` command

**Testing:**
16. Git integration tests
17. SSE listener tests
18. Image upload tests
19. Executor discovery tests

**Total Tasks:** 19

**Complexity:** 🟡 MEDIUM (mostly integration, leveraging existing Forge features)

---

## Part 3: Wish #120-C - Advanced Features (COMPLEX, HIGH IMPACT)

### 🎯 Mission: Deep integration features that require careful design

**Scope:** Features that require significant architecture changes

**What Users Get (ADVANCED capabilities):**

**1. Template Unification (Forge templates):**
```bash
genie init --template code|create|rust-cli|nextjs|...
genie templates list
genie templates show rust-cli
```

**Why Complex:** Requires merging Genie's "code/create" with Forge templates

**2. Advanced Inspection/Audit:**
```bash
genie review <id> --diff          # Show detailed diffs
genie review <id> --commits       # Inspect commit history
genie review <id> --compare HEAD  # Compare to HEAD
```

**Why Complex:** Requires deep Git integration + visualization

**3. Advanced Task Management:**
```bash
genie task update <id> --title "New title"
genie task delete <id>
genie task children <id>   # Show child attempts (agent tree)
```

**Why Complex:** Requires state tree synchronization

**4. Migration & Updating Agent:**
```bash
genie update check         # Check for updates
genie update apply         # Apply version migration
genie rollback <version>   # Rollback to previous version
```

**Why Complex:** Requires version management system + migration logic

**5. SSE Automations (safe auto-actions):**
- Auto-pull logs on task completion
- Auto-open review on PR creation
- Auto-update wish status on events
- (Requires idempotency + retry logic)

**Why Complex:** Requires careful design to avoid destructive auto-actions

**Total New Endpoints:** ~30

**User-Facing Changes:** ✅ **ADVANCED** (power user features)

---

### Discovery Required (ALL remaining items)

**Discovery #4: Templates Inventory**
- **Task:** Inventory Forge templates vs. Genie "code/create"
- **Deliverable:** Unification strategy (merge, keep separate, or hybrid)
- **Complexity:** MEDIUM-HIGH (impacts Wish #110)

**Discovery #5: MCP Unification**
- **Task:** Align Genie MCP servers with Forge MCP config
- **Deliverable:** Unified MCP configuration strategy
- **Complexity:** MEDIUM (coordination between systems)

**Discovery #6: Drafts Validation**
- **Task:** Validate if checkpoints add value vs. task attempts
- **Deliverable:** Go/no-go decision on drafts
- **Complexity:** LOW (mostly user research)

**Discovery #7: SSE Automations Catalog**
- **Task:** Design safe auto-actions on events
- **Deliverable:** Automation catalog with idempotency logic
- **Complexity:** MEDIUM-HIGH (safety-critical)

---

### Success Criteria (Wish #120-C)

**Functional:**
- [ ] Templates unified (or decision documented)
- [ ] Advanced inspection working
- [ ] Task management complete (CRUD + children)
- [ ] Migration system functional
- [ ] SSE automations safe + valuable

**User Experience:**
- [ ] Templates improve project setup
- [ ] Inspection improves code review
- [ ] Task management improves organization
- [ ] Updates are seamless (zero downtime)
- [ ] Automations save time (not annoying)

**Code Quality:**
- [ ] All advanced features tested
- [ ] Migration system robust (dry-run + rollback)
- [ ] Automations idempotent (safe retries)
- [ ] Documentation complete

---

### Roadmap Alignment (Wish #120-C)

**Phase 3 - Adoption Kits for Downstream Repos:** ✅ Perfect fit
- **Migration tools:** Upgrade notes, migration diffs, rollback guidance
- **Advanced features:** Template system, updating agent, automation

**Deliverable for Roadmap:** Production-ready adoption kits

**Roadmap Item (proposed):**
> **3. Production Adoption Kits**
> - Unified template system (Forge + Genie)
> - Automated version migration with rollback
> - Advanced inspection and audit tools
> - Safe SSE automations for common tasks
> - Complete upgrade guides for downstream adopters

---

### Tasks Breakdown (Wish #120-C)

**Templates:**
1. Templates discovery investigation
2. Design unification strategy
3. Implement template system
4. Migration guide (if unified)

**Advanced Inspection:**
5. Implement detailed diff view
6. Implement commit inspection
7. Implement compare to HEAD

**Task Management:**
8. Implement task update
9. Implement task delete
10. Implement task children (state tree)

**Migration & Updating:**
11. Design /update directory structure
12. Implement version files (diff-based)
13. Implement updating agent
14. Implement migration scripts
15. Document rollback plan

**SSE Automations:**
16. SSE automations discovery
17. Design idempotency logic
18. Implement safe auto-actions (5-10 automations)
19. Add user configuration (enable/disable per automation)

**Testing:**
20. Templates tests
21. Inspection tests
22. Task management tests
23. Migration tests (critical)
24. Automation tests (safety-critical)

**Total Tasks:** 24

**Complexity:** 🔴 HIGH (architectural changes, safety-critical features)

---

## Part 4: Summary Comparison

### Complexity by Wish

| Wish | Focus | Endpoints | Tasks | Complexity | User Impact | Roadmap Phase |
|------|-------|-----------|-------|------------|-------------|---------------|
| **#120-A** | Drop-in replacement | 9 | 16 | 🟡 MEDIUM | ❌ Zero (seamless) | Phase 1 |
| **#120-B** | Low-hanging fruits | ~15 | 19 | 🟡 MEDIUM | ✅✅ HIGH (new features) | Phase 2 |
| **#120-C** | Advanced features | ~30 | 24 | 🔴 HIGH | ✅✅✅ VERY HIGH (power user) | Phase 3 |
| **TOTAL** | - | ~54 | 59 | - | - | - |

**Note:** Total is ~54 endpoints (not 94+) because:
- Category 6 (WebSocket): OUT OF SCOPE
- Many Category 6-15 endpoints: Deferred or Discovery-only

---

### Execution Sequence

```
Wish #120-A (Quick Win)
├─ Filesystem audit
├─ Migration script
└─ Core replacement (drop-in)
    ↓
    ✅ DELIVERY: Seamless backend swap
    ↓
Wish #120-B (Low-Hanging Fruits)
├─ Approvals discovery
├─ SSE event mapping
├─ Executor name mapping
└─ Git + Omni + Images + Executors
    ↓
    ✅ DELIVERY: Enhanced autonomous features
    ↓
Wish #120-C (Advanced Features)
├─ Templates discovery
├─ MCP unification
├─ SSE automations catalog
└─ Templates + Inspection + Migration + Automations
    ↓
    ✅ DELIVERY: Production adoption kits
```

---

## Part 5: Roadmap Integration

### Current Roadmap (from .genie/product/roadmap.md)

**Phase 1 - Instrumentation & Telemetry (in progress)**
- Evidence checklist, validation commands, done reports
- **Wish #120-A fits here:** Drop-in replacement with full validation

**Phase 2 - Guided Self-Improvement**
- Wishes targeting prompt quality, guardrail clarity, CLI usability
- **Wish #120-B fits here:** Enhanced autonomous MCP features

**Phase 3 - Adoption Kits for Downstream Repos**
- Package upgrade notes, migration diffs, rollback guidance
- **Wish #120-C fits here:** Production adoption kits

---

### Proposed Roadmap Updates

**Add to Phase 2:**
> **Enhanced Autonomous MCP Features (Wish #120-B)**
> - Real-time notifications via Omni (WhatsApp/Slack/Discord)
> - Automatic PR creation and Git workflow management
> - Visual context support (images in planning/review)
> - Dynamic executor discovery and availability checking
> - Tight integration with Forge backend for seamless operation

**Add to Phase 3:**
> **Production Adoption Kits (Wish #120-C)**
> - Unified template system (Forge + Genie templates)
> - Automated version migration with rollback support
> - Advanced inspection and audit tools for code review
> - Safe SSE automations for common workflow tasks
> - Complete upgrade guides and migration scripts for downstream adopters
> - MCP unification strategy (Genie ↔ Forge coordination)

---

## Part 6: Risk Assessment by Wish

### Wish #120-A Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Migration script fails | LOW | HIGH | Dry-run mode + rollback plan + extensive testing |
| Filesystem violations | LOW | HIGH | Code audit + pre-commit hooks |
| User experience regression | LOW | MEDIUM | Identical CLI output + behavior validation |

**Overall Risk:** 🟢 LOW

---

### Wish #120-B Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Approvals endpoint insufficient | MEDIUM | MEDIUM | Discovery validation + wrapper if needed |
| SSE listener complexity | MEDIUM | MEDIUM | Use proven libraries + start with MVP |
| Notification spam | LOW | LOW | User config + debouncing |

**Overall Risk:** 🟡 MEDIUM

---

### Wish #120-C Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Templates can't unify | MEDIUM | MEDIUM | Keep separate systems (not ideal but safe) |
| Migration breaks downstream | MEDIUM | HIGH | Extensive testing + rollback + adoption kits |
| SSE automations destructive | LOW | HIGH | Idempotency + dry-run + user approval gates |

**Overall Risk:** 🟡 MEDIUM-HIGH

---

## Part 7: Success Metrics by Wish

### Wish #120-A Success Metrics

**Functional:**
- [ ] 100% feature parity (no regressions)
- [ ] 0% data loss during migration
- [ ] 0 timeout failures (vs. current false negatives)

**Performance:**
- [ ] Session creation < 5s (vs. 5-20s)
- [ ] 10+ parallel sessions safe (vs. unsafe)
- [ ] 100% reliability (atomic API calls)

**Code Quality:**
- [ ] 40% code reduction achieved
- [ ] All tests passing
- [ ] Rollback plan validated

---

### Wish #120-B Success Metrics

**Functional:**
- [ ] PR creation working (100% success rate)
- [ ] Omni notifications delivered (< 5s latency)
- [ ] Images upload/display working

**User Impact:**
- [ ] 80% reduction in manual PR steps
- [ ] Real-time awareness of session status
- [ ] Visual context improves planning

**Code Quality:**
- [ ] Git tests passing
- [ ] SSE listener stable (auto-reconnect)
- [ ] All features documented

---

### Wish #120-C Success Metrics

**Functional:**
- [ ] Templates decision implemented
- [ ] Migration system working (0% data loss)
- [ ] SSE automations safe (idempotent)

**User Impact:**
- [ ] Seamless upgrades (< 5% rollback rate)
- [ ] Automations save time (measurable)
- [ ] Advanced features used by power users

**Code Quality:**
- [ ] All critical paths tested
- [ ] Documentation complete (adoption kits)
- [ ] Downstream adopters satisfied

---

## Conclusion

**3-Wish Split Strategy:**

1. **Wish #120-A: Drop-In Replacement (Quick Win)**
   - ✅ Seamless swap (zero user impact)
   - ✅ Eliminates 5 critical bugs
   - ✅ 40% code reduction
   - ✅ Aligns with Roadmap Phase 1

2. **Wish #120-B: Low-Hanging Fruits (High Value)**
   - ✅ PR automation (80% less manual work)
   - ✅ Real-time notifications (Omni)
   - ✅ Images + executor visibility
   - ✅ Aligns with Roadmap Phase 2 (NEW ITEM)

3. **Wish #120-C: Advanced Features (Power User)**
   - ✅ Templates + Migration + Automations
   - ✅ Production adoption kits
   - ✅ Aligns with Roadmap Phase 3 (NEW ITEM)

**Next Actions:**
1. Approve 3-wish split strategy
2. Update public roadmap (add Phase 2-3 items)
3. Create Wish #120-A document (drop-in replacement)
4. Begin filesystem audit + migration script

**Ready to proceed?** 🚀

---

**Document Author:** Genie (forge/120-executor-replacement)
**Version:** 1.0.0
**Last Updated:** 2025-10-18
**Status:** ✅ Strategy Complete - Awaiting Approval
