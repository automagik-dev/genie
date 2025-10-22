# GitHub Issues ↔ Forge Tasks Mapping
**Generated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Purpose:** Complete mapping for validation and sync design
**Project:** Genie (ee8f0a72-44da-411d-a23e-f2c6529b62ce)

---

## 📊 Summary Statistics

**Total GitHub Issues (Open):** 18
**Total Forge Tasks:** 17
**Mapped (Issue → Task):** 3 issues with tasks
**Unmapped Issues (No Forge task):** 15 issues
**Unmapped Tasks (No GitHub issue):** 14 tasks

---

## ✅ MAPPED: Issues WITH Forge Tasks

| Issue | Title | Forge Task(s) | Status |
|-------|-------|---------------|--------|
| #152 | MCP Server Authentication | c5e207a8, 22593561 | Both todo (duplicate?) |
| #146 | Session name architecture | (merged?) | Need verification |
| #143 | #120-A: Forge Drop-In | dafbff84, 6644fd56, c0e6699d | All in-review |

---

## ❌ UNMAPPED: Issues WITHOUT Forge Tasks (Violates Amendment)

**Critical/Bugs:**
- #151 - Forge API 422 error (executor validation)
- #150 - MCP path resolution breaks operations
- #148 - Wrong Forge port (3000 vs 8887)

**Wishes:**
- #145 - #120-C: Production Adoption Kits
- #144 - #120-B: Enhanced Autonomous Features
- #53 - Bring Genie to ChatGPT
- #49 - Telemetry and Metrics System

**Roadmap Items:**
- #39 - Deploy GitHub Workflows
- #38 - Enhanced backup system
- #37 - Multi-template architecture
- #31 - Normalize old wishes
- #29 - Wish management pipeline
- #28 - Genie core updates
- #27 - Repository infrastructure
- #17 - Plugin Marketplace

---

## 🔧 UNMAPPED: Forge Tasks WITHOUT GitHub Issues

**Recent Work (Felipe's overnight session):**
- 1257f7e6 - Unified MCP Startup (in-review)
- 62c00eed - Unified MCP Startup (todo, duplicate?)
- ad076578 - Genie: install test (in-review)
- a1144038 - Genie: wish default (in-review)

**Wish Tasks (created by other Genie):**
- 535a26c1 - Voice Agent Transformation (todo)
- c1d21957 - Unified Naming Taxonomy (todo)
- ab6c2576 - Forge Resource Sync Investigation (todo)

**Wish-Forge-Learn Integration (7 tasks):**
- 0d568ea8 - Task 1: Auto-Sync on Startup (todo)
- 5df76ebd - Task 3: Wish Creation via MCP (todo)
- 89b104c1 - Task 4: Sub-Task Creation (todo)
- 28921ec5 - Task 5: Hierarchical Learn (todo)

**Current Learn Task:**
- c873572f - Learn: Wish-Issue Amendment + Sync (just created)

---

## 🎯 Amendment Compliance Analysis

**"No Wish Without Issue" Amendment:**

**Compliant:**
- Wishes from issues: #152, #143 (have Forge tasks)

**Non-Compliant:**
- Wishes created directly without issues: 535a26c1, c1d21957, ab6c2576
- Tasks created from other workflows: All wish-forge-learn integration tasks

**Critical Bugs Without Tasks:**
- #151, #150, #148 need Forge tasks immediately

---

## 🔄 Real-Time Sync Requirements

**Current Gap:**
- SESSION-STATE.md shows old statuses (in-progress vs in-review)
- Git hooks insufficient (only on commit, not task completion)
- No automatic Forge→SESSION-STATE sync

**Needed:**
1. Forge project auto-sync on MCP startup
2. Real-time status updates (when task status changes)
3. Automatic GitHub issue linking
4. Task→Issue→PR relationship tracking

**Next:** Design sync mechanism architecture

---

## 📝 Recommendations

1. **Immediate:** Create Forge tasks for #151, #150, #148 (critical bugs)
2. **Process:** Enforce issue creation before wish tasks
3. **Automation:** Design real-time Forge→SESSION-STATE sync
4. **Cleanup:** Resolve duplicate tasks (MCP auth, MCP startup)
5. **Documentation:** Update amendment in AGENTS.md
