# Wish Complexity Analysis - Forge Executor Replacement
**Date:** 2025-10-18
**Task:** Issue #120
**Purpose:** Complete complexity assessment (original + expanded + Discovery)
**Status:** ✅ Analysis Complete

---

## 📋 Executive Summary

**Total Complexity:** 🔴 **VERY HIGH** (changed from original assessment)

**Original Estimate:** 4 weeks, 20 tasks
**Current Reality:** 11-15 weeks, 62+ tasks, 7 Discovery investigations

**Complexity Multiplier:** **3.75x** (275-375% increase from original)

**Recommendation:** 🚨 **SPLIT INTO MULTIPLE WISHES** (see Part 6)

---

## Part 1: Scope Evolution Analysis

### Original Scope (Wish Document V1)
```
Timeline: 4 weeks
Tasks: 20
Groups: 4 (A-D)
Endpoints: 24 (Categories 1-4 only)
Discovery: 0 items
```

**Breakdown:**
- Group A: Core Replacement (7 tasks, 1 week)
- Group B: Streaming Features (4 tasks, 1 week)
- Group C: Advanced Features (3 tasks, 1 week)
- Group D: Migration & Testing (6 tasks, 1 week)

**Complexity:** 🟡 MEDIUM-HIGH

---

### Expanded Scope (Integration Analysis V2)
```
Timeline: 6-8 weeks
Tasks: 41
Groups: 4 (A-D expanded)
Endpoints: 24 (same Categories 1-4)
Discovery: 0 items
```

**Breakdown:**
- Group A: Core + Git Integration (16 tasks, 2-3 weeks) [+9 tasks]
- Group B: Streaming + Inspection (8 tasks, 1-2 weeks) [+4 tasks]
- Group C: Advanced + Notifications (7 tasks, 1-2 weeks) [+4 tasks]
- Group D: Migration + Updating Agent (10 tasks, 1-2 weeks) [+4 tasks]

**Complexity:** 🔴 HIGH

**Expansion:** +21 tasks (+105%), +2-4 weeks (+50-100%)

---

### Current Scope (Endpoint Mapping V3)
```
Timeline: 11-15 weeks
Tasks: 62+
Groups: 5 (Phase 0 + A-D)
Endpoints: 94+ (Categories 1-15)
Discovery: 7 investigations
```

**Breakdown:**
- **Phase 0: Discovery Sprint** (7 investigations, 2-3 weeks) [NEW]
  - 3 HIGH priority (CRITICAL blockers)
  - 2 MEDIUM priority (should resolve)
  - 2 LOW priority (post-MVP)
- Group A: Core + Git (16 tasks, 2-3 weeks)
- Group B: Streaming + Inspection (8 tasks, 1-2 weeks)
- Group C: Advanced + Notifications (7 tasks, 1-2 weeks)
- Group D: Migration + Updating (10 tasks, 1-2 weeks)
- **Unmapped Categories 6-15:** (~14 additional tasks if implemented) [NEW]

**Complexity:** 🔴 **VERY HIGH**

**Total Expansion:** +42 tasks (+210%), +7-11 weeks (+175-275%)

---

## Part 2: Complexity Breakdown by Dimension

### 2.1 Technical Complexity

| Dimension | Original | Current | Multiplier |
|-----------|----------|---------|------------|
| **Endpoints to integrate** | 24 | 94+ | 3.9x |
| **Categories to map** | 4 | 15 | 3.75x |
| **Integration patterns** | 1 (direct) | 3 (direct, abstracted, workflow) | 3x |
| **User visibility models** | 1 (all visible) | 3 (user/internal/hybrid) | 3x |
| **Workflow phases** | 1 (Forge) | 5 (Plan/Wish/Forge/Review/Cross) | 5x |
| **Discovery investigations** | 0 | 7 | N/A (new) |
| **Blockers identified** | 0 | 7 (3 critical) | N/A (new) |

**Overall Technical Complexity:** 🔴 **3.5-4x increase**

---

### 2.2 Timeline Complexity

```
Original: 4 weeks
  Week 1: Group A (Core)
  Week 2: Group B (Streaming)
  Week 3: Group C (Advanced)
  Week 4: Group D (Migration)

Expanded (Integration): 6-8 weeks
  Week 1-2: Group A (Core + Git)
  Week 3-4: Group B (Streaming + Inspection)
  Week 5-6: Group C (Advanced + Notifications)
  Week 7-8: Group D (Migration + Updating)

Current (Endpoint Mapping): 11-15 weeks
  Week 1-3: Phase 0 (Discovery Sprint) ← NEW, BLOCKING
  Week 4-6: Group A (Core + Git)
  Week 7-8: Group B (Streaming + Inspection)
  Week 9-10: Group C (Advanced + Notifications)
  Week 11-12: Group D (Migration + Updating)
  Week 13-15: (Buffer for unknowns/issues)
```

**Timeline Multiplier:** 2.75-3.75x (275-375% increase)

**Critical Path:** Discovery Sprint is now on critical path (blocks everything)

---

### 2.3 Dependency Complexity

**Original Dependencies:**
- None (linear execution: A → B → C → D)

**Current Dependencies:**
```
Phase 0 (Discovery) BLOCKS Group A
  ├─ Blocker #1 (Approvals) → Group A task #11 (PR creation)
  ├─ Blocker #2 (Filesystem) → Group A (all tasks)
  └─ Blocker #3 (SSE) → Group A task #13 (Omni notifications)

Group A BLOCKS Group B
  └─ SSE listener foundation needed for streaming

Group B partially BLOCKS Group C
  └─ Inspection endpoints inform advanced features

Group C partially BLOCKS Group D
  └─ Notifications need testing in migration

Parallel Dependencies:
  ├─ Blocker #4 (Templates) ↔ Wish #110 (Multi-template arch)
  ├─ Blocker #5 (Executors) ↔ Wish #108 (Genie arch rebrand)
  └─ Updating Agent ↔ Version management system
```

**Dependency Complexity:** 🔴 **HIGH** (went from 0 to 10+ dependencies)

---

### 2.4 Risk Complexity

**Original Risks:**
- Migration fails (Low/High)
- Performance regression (Low/Medium)
- Breaking changes (Medium/Low)
- Forge dependency (Low/Medium)

**Total:** 4 risks, all LOW-MEDIUM probability

---

**Current Risks:**

**From Expanded Scope:**
- Scope creep (Medium/Medium)
- Git ops complexity (Low/Medium)
- Notification spam (Low/Low)
- Version migration fails (Low/Medium)

**From Discovery Phase:**
- Discovery findings block implementation (Medium/High) ← NEW, CRITICAL
- Approvals endpoint insufficient (Medium/High) ← NEW
- Templates can't unify (Low/Medium) ← NEW
- Executors/MCP conflicts (Low/Medium) ← NEW
- SSE listener complexity underestimated (Medium/Medium) ← NEW
- Filesystem violations found (Low/High) ← NEW
- Scope creep during Discovery (High/Medium) ← NEW

**Total:** 11 risks, 3 CRITICAL (Medium/High probability)

**Risk Complexity Multiplier:** 2.75x (275% increase)

---

### 2.5 Integration Complexity

**Original Integration Points:**
- Forge API (24 endpoints)
- Genie CLI (5 handlers)
- Sessions.json → Forge tasks

**Total:** 3 integration points

---

**Current Integration Points:**

**External Systems:**
- Forge API (94+ endpoints)
- Omni (10+ events)
- SSE (global event stream)
- MCP servers (unified config)
- Git (PR/merge workflows)

**Internal Systems:**
- Genie CLI (5 handlers + 7 new commands)
- Workflow phases (Plan/Wish/Forge/Review/Cross)
- Session management (sessions.json → Forge)
- Agent coordination (state tree sync)
- Templates (Forge vs. Genie unification)
- Executors (dynamic discovery)
- Filesystem (audit + restrictions)
- Authentication (transparent flow)
- Configuration (dynamic + partial exposure)

**Total:** 14 integration points

**Integration Complexity Multiplier:** 4.67x (467% increase)

---

## Part 3: Task Count Analysis

### Original: 20 tasks
```
Group A: 7 tasks
Group B: 4 tasks
Group C: 3 tasks
Group D: 6 tasks
```

### Expanded: 41 tasks (+21)
```
Group A: 16 tasks (+9)
Group B: 8 tasks (+4)
Group C: 7 tasks (+4)
Group D: 10 tasks (+4)
```

### Current: 62+ tasks (+42 from original)
```
Phase 0 (Discovery): 7 investigations (NEW)
  ├─ HIGH: 3 investigations
  ├─ MEDIUM: 2 investigations
  └─ LOW: 2 investigations

Group A: 16 tasks
  ├─ Original: 7 tasks
  └─ Git integration: 9 tasks

Group B: 8 tasks
  ├─ Original: 4 tasks
  └─ Inspection: 4 tasks

Group C: 7 tasks
  ├─ Original: 3 tasks
  └─ Notifications: 4 tasks

Group D: 10 tasks
  ├─ Original: 6 tasks
  └─ Updating agent: 4 tasks

Unmapped (Categories 6-15): ~14 tasks (if implemented)
  ├─ Drafts (if validated): 3 tasks
  ├─ SSE automations: 5 tasks
  ├─ Container UX: 2 tasks
  ├─ Image advanced: 2 tasks
  ├─ Templates (if not unified): 2 tasks
  └─ Buffer: ?
```

**Task Count Multiplier:** 3.1x (310% increase, could be 3.8x if unmapped implemented)

---

## Part 4: Effort Estimation

### Original Estimate: 4 weeks (160 hours)
```
Group A: 40 hours (1 week)
Group B: 40 hours (1 week)
Group C: 40 hours (1 week)
Group D: 40 hours (1 week)
```

**Assumptions:**
- Linear execution
- No blockers
- Familiar patterns
- 1 person full-time

---

### Current Estimate: 11-15 weeks (440-600 hours)

**Phase 0: Discovery Sprint** (2-3 weeks, 80-120 hours)
```
HIGH Priority Investigations:
├─ Blocker #1 (Approvals): 16-32 hours
├─ Blocker #2 (Filesystem): 8 hours
├─ Blocker #4 (Templates): 16-24 hours
└─ Blocker #5 (Executors): 16-24 hours
Subtotal: 56-88 hours

CRITICAL Implementation:
└─ Blocker #3 (SSE Listener): 16-24 hours

MEDIUM Priority (optional):
├─ Blocker #6 (Drafts): 8-16 hours
└─ Blocker #7 (SSE Automations): 16-24 hours
Subtotal: 24-40 hours (if pursued)

Total Phase 0: 80-120 hours
```

**Group A: Core + Git** (2-3 weeks, 80-120 hours)
```
Original tasks: 40 hours
Git integration: 40-60 hours
Testing/validation: 20-40 hours
Total: 80-120 hours
```

**Group B: Streaming + Inspection** (1-2 weeks, 40-80 hours)
```
Original tasks: 40 hours
Inspection endpoints: 20-40 hours
Testing/validation: 20-40 hours
Total: 40-80 hours
```

**Group C: Advanced + Notifications** (1-2 weeks, 40-80 hours)
```
Original tasks: 40 hours
Notifications (Omni): 20-40 hours
Testing/validation: 20-40 hours
Total: 40-80 hours
```

**Group D: Migration + Updating** (1-2 weeks, 40-80 hours)
```
Original tasks: 40 hours
Updating agent: 20-40 hours
Testing/validation: 20-40 hours
Total: 40-80 hours
```

**Buffer for unknowns** (1-2 weeks, 40-80 hours)
```
Integration issues: 20-40 hours
Discovery surprises: 20-40 hours
Total: 40-80 hours
```

**TOTAL: 360-560 hours (440-600 with buffer)**

**Effort Multiplier:** 2.75-3.75x (275-375% increase)

---

## Part 5: Complexity Scoring Matrix

### Complexity Dimensions (0-10 scale)

| Dimension | Original | Current | Change |
|-----------|----------|---------|--------|
| **Technical Depth** | 6 | 9 | +50% |
| **Scope Breadth** | 5 | 9 | +80% |
| **Timeline** | 4 | 8 | +100% |
| **Dependencies** | 2 | 8 | +300% |
| **Risk** | 4 | 7 | +75% |
| **Integration Points** | 3 | 9 | +200% |
| **Discovery Unknowns** | 0 | 8 | N/A |
| **Breaking Changes** | 3 | 6 | +100% |
| **Testing Complexity** | 5 | 8 | +60% |
| **Documentation Needs** | 4 | 9 | +125% |

**Average Complexity Score:**
- **Original:** 3.6/10 (MEDIUM)
- **Current:** 8.1/10 (VERY HIGH)
- **Change:** +4.5 points (+125% increase)

---

## Part 6: Recommendation - Split Into Multiple Wishes

### 🚨 CRITICAL INSIGHT

**Current wish is too complex for single execution.**

**Problems:**
1. **Timeline too long** (11-15 weeks): High risk of scope creep, changing requirements
2. **Too many unknowns** (Discovery phase = 25% of timeline): Can't accurately estimate
3. **Too many dependencies** (10+ dependencies): High coordination overhead
4. **Too many integration points** (14 systems): High chance of cascading failures
5. **Too many categories** (15 categories): Context switching overhead

**Recommendation:** 🎯 **SPLIT INTO 3 WISHES**

---

### Wish #120-A: Core Executor Replacement (MVP)
**Priority:** 🔴 CRITICAL
**Timeline:** 5-7 weeks
**Complexity:** 🟡 MEDIUM-HIGH

**Scope:**
- Phase 0: Discovery Sprint (HIGH priority only)
  - Blocker #1 (Approvals)
  - Blocker #2 (Filesystem)
  - Blocker #3 (SSE Listener)
- Group A: Core + Git (16 tasks)
- Essential testing + documentation

**Deliverable:**
- Core replacement functional
- Git integration (merge, push, PR, abort)
- SSE listener + Omni notifications
- Filesystem restrictions enforced
- Basic approval gate

**Success Criteria:**
- All existing `genie run/resume/stop/list/view` work
- PR creation workflow functional
- Omni notifications working
- 10+ parallel sessions safe
- Performance targets met

**Endpoints Covered:** 24 (Categories 1-4)

**Effort:** 240-320 hours (6-8 weeks)

**Risk:** LOW-MEDIUM (well-scoped, clear deliverables)

---

### Wish #120-B: Enhanced Features (Post-MVP)
**Priority:** 🟡 MEDIUM
**Timeline:** 3-5 weeks
**Complexity:** 🟡 MEDIUM

**Scope:**
- Group B: Streaming + Inspection (8 tasks)
- Group C: Advanced + Notifications (7 tasks)
- Blocker #4 (Templates) - Discovery + implementation
- Blocker #5 (Executors/MCP) - Discovery + implementation

**Deliverable:**
- Streaming features (if not using WS, what replaces?)
- Inspection/audit endpoints
- Advanced management (retarget, editor, executor switching)
- Templates unified (or decision documented)
- Executors dynamically discovered

**Success Criteria:**
- Inspection endpoints functional
- Advanced features working
- Templates decision implemented
- Executors visible in CLI

**Endpoints Covered:** ~20 additional (partial Categories 6-15)

**Effort:** 120-200 hours (3-5 weeks)

**Risk:** LOW-MEDIUM (depends on Wish #120-A)

---

### Wish #120-C: Optimization & Automation (Future)
**Priority:** 🔵 LOW
**Timeline:** 2-4 weeks
**Complexity:** 🟢 LOW-MEDIUM

**Scope:**
- Group D: Migration + Updating agent (10 tasks)
- Blocker #6 (Drafts) - Discovery + implementation (if justified)
- Blocker #7 (SSE Automations) - Discovery + implementation
- Unmapped Categories 6-15 (remaining items)

**Deliverable:**
- Migration tools (sessions.json → Forge)
- Updating agent (version management)
- SSE automations (safe auto-actions)
- Drafts (if validated)
- Post-MVP features

**Success Criteria:**
- Migration script working
- Updating agent functional
- SSE automations safe + valuable
- All documentation complete

**Endpoints Covered:** Remaining unmapped

**Effort:** 80-160 hours (2-4 weeks)

**Risk:** LOW (nice-to-have features)

---

## Part 7: Complexity Comparison

### Single Wish (Current Approach)

**Pros:**
- Complete solution delivered at once
- No context switching between wishes
- All integration points addressed

**Cons:**
- 11-15 week timeline (too long)
- High risk of scope creep
- Large Discovery phase (unknowns)
- Difficult to estimate accurately
- No incremental value delivery
- High coordination overhead

**Overall Risk:** 🔴 HIGH

---

### Three Wishes (Recommended Approach)

**Pros:**
- Incremental value delivery (MVP in 5-7 weeks)
- Smaller, manageable scopes
- Clear success criteria per wish
- Can adjust based on learnings
- Easier to estimate
- Lower coordination overhead per wish
- Can pause/pivot between wishes

**Cons:**
- More planning overhead (3 wish documents)
- Context switching between wishes
- Integration points span multiple wishes
- May discover dependencies late

**Overall Risk:** 🟡 MEDIUM (much better)

---

## Part 8: Final Complexity Assessment

### Overall Complexity: 🔴 **VERY HIGH**

**Dimensions:**
- ✅ **Technical Complexity:** VERY HIGH (94+ endpoints, 15 categories, 3 patterns)
- ✅ **Timeline Complexity:** VERY HIGH (11-15 weeks, 3.75x multiplier)
- ✅ **Dependency Complexity:** HIGH (10+ dependencies, Discovery blocks all)
- ✅ **Risk Complexity:** HIGH (11 risks, 3 CRITICAL)
- ✅ **Integration Complexity:** VERY HIGH (14 systems, 4.67x multiplier)
- ✅ **Task Complexity:** VERY HIGH (62+ tasks, 3.1x multiplier)
- ✅ **Effort Complexity:** VERY HIGH (440-600 hours, 3.75x multiplier)

**Complexity Score:** 8.1/10 (VERY HIGH)

---

### Recommended Action: 🎯 **SPLIT INTO 3 WISHES**

**Rationale:**
1. **Single wish too risky** (11-15 weeks, too many unknowns)
2. **Incremental delivery better** (MVP in 5-7 weeks)
3. **Easier to estimate** (smaller scopes, clearer deliverables)
4. **Lower coordination overhead** (per wish)
5. **Can adjust based on learnings** (pivot between wishes)

**Next Steps:**
1. Create Wish #120-A (Core MVP) - 5-7 weeks
2. Execute and validate
3. Learn from Wish #120-A
4. Create Wish #120-B (Enhanced) - 3-5 weeks (if needed)
5. Execute and validate
6. Create Wish #120-C (Optimization) - 2-4 weeks (if needed)

**Total Timeline:** Still 11-15 weeks, but **incremental value** + **lower risk**

---

## Part 9: Complexity Breakdown (Detailed)

### By Phase

| Phase | Tasks | Weeks | Hours | Complexity | Risk |
|-------|-------|-------|-------|------------|------|
| **Phase 0 (Discovery)** | 7 | 2-3 | 80-120 | 🔴 HIGH | 🔴 HIGH |
| **Group A (Core + Git)** | 16 | 2-3 | 80-120 | 🔴 HIGH | 🟡 MEDIUM |
| **Group B (Streaming)** | 8 | 1-2 | 40-80 | 🟡 MEDIUM | 🟡 MEDIUM |
| **Group C (Advanced)** | 7 | 1-2 | 40-80 | 🟡 MEDIUM | 🟡 MEDIUM |
| **Group D (Migration)** | 10 | 1-2 | 40-80 | 🟡 MEDIUM | 🟢 LOW |
| **Buffer (Unknowns)** | ? | 1-2 | 40-80 | 🔴 HIGH | 🔴 HIGH |
| **TOTAL** | 62+ | 11-15 | 440-600 | 🔴 VERY HIGH | 🔴 HIGH |

### By Category

| Category | Endpoints | Tasks | Complexity | Status |
|----------|-----------|-------|------------|--------|
| **1. Health** | 1 | 1 | 🟢 LOW | ✅ Mapped |
| **2. Projects** | 8 | 2 | 🟢 LOW | ✅ Mapped |
| **3. Tasks** | 6 | 4 | 🟡 MEDIUM | ✅ Mapped |
| **4. Task Attempts** | 19 | 17 | 🔴 HIGH | ✅ Mapped |
| **6. WebSocket** | ~10 | 0 | N/A | ❌ Out of scope |
| **7. Drafts** | 4 | 0-3 | 🟡 MEDIUM | 📋 Discovery |
| **8. Approvals** | 3 | 2 | 🔴 HIGH | 📋 Discovery |
| **9. Templates** | 5 | 2-4 | 🔴 HIGH | 📋 Discovery |
| **10. Images** | 4 | 3 | 🟡 MEDIUM | ✅ Mapped |
| **11. Configuration** | 4 | 2 | 🟡 MEDIUM | 📋 Discovery |
| **12. Containers** | 4 | 1 | 🟡 MEDIUM | ✅ Mapped |
| **13. Filesystem** | 4 | 1 | 🔴 HIGH | ✅ Mapped (audit) |
| **14. Auth** | 0 | 0 | 🟡 MEDIUM | ✅ Mapped (docs) |
| **15. SSE** | ~20 | 5 | 🔴 HIGH | 📋 Discovery |

**Total:** 94+ endpoints, 62+ tasks

---

## Part 10: Risk vs. Value Matrix

### High Value, Low Risk (Do First - Wish #120-A)
- Core replacement (eliminate 5 critical bugs)
- Git integration (PR automation)
- SSE listener + Omni (notifications)
- Filesystem restrictions (safety)
- Basic approvals (gate)

### High Value, High Risk (Do Second - Wish #120-B)
- Templates unification (clarity)
- Executors discovery (flexibility)
- Advanced features (retarget, editor, switching)
- Streaming features (UX enhancement)

### Medium Value, Low Risk (Do Third - Wish #120-C)
- Migration tools (smooth transition)
- Updating agent (version management)
- SSE automations (efficiency)
- Image advanced features (nice-to-have)

### Low Value, High Risk (Defer/Reject)
- Drafts (unclear use case)
- Container UX (internal already sufficient)

---

## Conclusion

**Wish Complexity:** 🔴 **VERY HIGH** (8.1/10)

**Original Estimate:** 4 weeks, 20 tasks, MEDIUM complexity
**Current Reality:** 11-15 weeks, 62+ tasks, VERY HIGH complexity
**Multiplier:** 3.75x increase (275-375%)

**ROOT CAUSE:** Endpoint mapping revealed 70+ additional endpoints (Categories 6-15) that need natural integration into Genie workflow.

**Recommendation:** 🎯 **SPLIT INTO 3 WISHES**
- Wish #120-A: Core MVP (5-7 weeks, CRITICAL)
- Wish #120-B: Enhanced Features (3-5 weeks, MEDIUM)
- Wish #120-C: Optimization (2-4 weeks, LOW)

**Benefits of Splitting:**
- ✅ Incremental value delivery (MVP in 5-7 weeks vs. 11-15 weeks)
- ✅ Lower risk per wish (MEDIUM vs. HIGH)
- ✅ Easier to estimate (smaller scopes)
- ✅ Can pivot based on learnings
- ✅ Clear success criteria per wish

**Next Action:** Decide: proceed with single wish (11-15 weeks, HIGH risk) or split into 3 wishes (same total time, LOWER risk, incremental value)?

---

**Analysis Author:** Genie (forge/120-executor-replacement)
**Version:** 1.0.0
**Status:** ✅ Analysis Complete - Decision Needed
