# 📊 Forge Tasks Audit - 2025-10-18

**Purpose:** Complete inventory of Forge tasks with naming audit + wish/issue mapping
**Status:** 19 tasks total (13 with issues linked, 6 pending)

---

## 🎯 CURRENT FORGE TASK INVENTORY

### ✅ PROPERLY NAMED & LINKED (Good Examples)

| # | Task Title | Type | Issue | Status | Notes |
|---|-----------|------|-------|--------|-------|
| 1 | `forge/120-executor-replacement` | forge | #120 | ✅ GOOD | Clear TYPE + issue# + slug |
| 2 | `[BUG] #104 - MCP Background Launch Timeout` | bug | #104 | ✅ GOOD | TYPE + issue# + description |
| 3 | `[BUG] #102 - MCP session ID collision` | bug | #102 | ✅ GOOD | TYPE + issue# + description |
| 4 | `[BUG] #66 - MCP session disappears after resume` | bug | #66 | ✅ GOOD | TYPE + issue# + CRITICAL marker |

### 🟡 INCONSISTENTLY NAMED (Needs Standardization)

| # | Task Title | Type | Issue | Status | Problem |
|---|-----------|------|-------|--------|---------|
| 5 | `[WISH] spells-prioritization` | wish | #107 | 🟡 INCONSISTENT | Missing issue# prefix |
| 6 | `[WISH] genie-arch-rebrand` | wish | #108 | 🟡 INCONSISTENT | Missing issue# prefix |
| 7 | `[WISH] backup-update-system` | wish | #114 | 🟡 INCONSISTENT | Missing issue# prefix |
| 8 | `[WISH] rc21-session-lifecycle-fix` | wish | #109 | 🟡 INCONSISTENT | Missing issue# prefix |
| 9 | `[FRESH] Spells Prioritization - Start from Scratch` | wish | #107 | 🟡 INCONSISTENT | Wrong naming (should be [WISH-RETRY]) |
| 10 | `Multi-Template Architecture: Dynamic Template Generation` | wish | #110 | 🟡 NO PREFIX | Missing TYPE marker + issue# |
| 11 | `Genie Architecture Rebranding` | wish | #108 | 🟡 NO PREFIX | Missing TYPE marker + issue# |

### 🔴 MISSING ISSUE LINKS (Needs GitHub Issues)

| # | Task Title | Type | Issue | Status | Problem |
|---|-----------|------|-------|--------|---------|
| 12 | `[agent] Git` | agent | ❌ NONE | 🔴 NO ISSUE | Should have GitHub issue |
| 13 | `[LEARN] Continuous Framework Learning - Permanent Meta-Agent` | learn | ❌ NONE | 🔴 NO ISSUE | Permanent task, may not need issue |
| 14 | `Follow-up: UUID Reuse and Build Artifact Consistency...` | investigation | ❌ NONE | 🔴 NO ISSUE | Needs issue for tracking |
| 15 | `[ORCHESTRATION] Parallel PR Creation - Tasks #2-9` | orchestration | ❌ NONE | 🔴 NO ISSUE | Meta task, unclear if needs issue |
| 16 | `[MASTER] Organize All Work - Create Branches...` | orchestration | ❌ NONE | 🔴 NO ISSUE | Historical master task |
| 17 | `[TRIAGE] Incomplete Wishes (8 directories, no wish.md)` | doc | ❌ NONE | 🔴 NO ISSUE | Should have issue |

### ✅ MERGED/COMPLETE

| # | Task Title | Type | Issue | PR | Status |
|---|-----------|------|-------|----|----|
| 18 | `[WISH] agents-optimization - AGENTS.md Context Extraction` | wish | #111 | #118 | ✅ DONE |
| 19 | `[WISH] rc21-session-lifecycle-fix` | wish | #109 | #119 | ✅ DONE |

---

## 📋 STANDARDIZATION REQUIRED

### Naming Convention Standard
```
Pattern: [TYPE] #issue-number - slug-friendly-name

TYPE values:
- [WISH] - Feature/epic level work
- [BUG] - Bug fixes
- [NEURON] - Permanent infrastructure
- [LEARN] - Learning/meta tasks
- [DOC] - Documentation
- [FORK] - Fork/investigation tasks
- forge/NNN - Alternative pattern for code tasks
```

### Tasks Needing Rename

**From:** `[WISH] spells-prioritization`
**To:** `[WISH] #107-spells-prioritization`

**From:** `[WISH] genie-arch-rebrand`
**To:** `[WISH] #108-genie-arch-rebrand`

**From:** `[WISH] backup-update-system`
**To:** `[WISH] #114-backup-update-system`

**From:** `[WISH] rc21-session-lifecycle-fix`
**To:** `[WISH] #109-rc21-session-lifecycle-fix`

**From:** `Multi-Template Architecture: Dynamic Template Generation`
**To:** `[WISH] #110-multi-template-architecture`

**From:** `Genie Architecture Rebranding`
**To:** `[WISH] #108-genie-arch-rebrand`

**From:** `[FRESH] Spells Prioritization - Start from Scratch`
**To:** Merge with #107 task (it's a retry, not separate)

---

## 🔴 MISSING GITHUB ISSUES

Tasks without GitHub issues (need to create):

1. **[NEURON] Git** → Create Issue: "Permanent Agent: Git Operations"
2. **Follow-up: UUID Reuse...** → Create Issue: "UUID Reuse & Stale Artifacts Investigation"
3. **[TRIAGE] Incomplete Wishes** → Create Issue: "Triage & Archive Incomplete Wishes"

---

## ✅ WISH ↔ ISSUE ↔ FORGE TASK MAPPING

**Current State (13 wishes with issues):**

```
Wish                              GitHub Issue    Forge Task Status
──────────────────────────────────────────────────────────────────
spells-prioritization             #107 ✅         [WISH] (✅ DONE)
genie-arch-rebrand                #108 ✅         [WISH] (🔄 IN-PROGRESS)
rc21-session-lifecycle-fix         #109 ✅         [WISH] (✅ DONE)
multi-template-architecture        #110 ✅         [WISH] (🔄 BLOCKED)
agents-optimization                #111 ✅         [WISH] (✅ DONE)
backup-update-system               #114 ✅         [WISH] (🔄 IN-PROGRESS)
bug-104                            #104 ✅         [BUG] (🔄 EXECUTING)
bug-66                             #66 ✅          [BUG] (✅ RESOLVED)
bug-102                            #102 ✅         [BUG] (✅ RESOLVED)
executor-replacement               #120 ✅         forge/120 (🔄 IN-PROGRESS)
```

**Wishes WITHOUT GitHub issues (6):**
- agents-claude-merge (archived)
- bug4-final-fix (archived)
- git-split (archived)
- mcp-bugs (archived)
- natural-context-audit (archived)
- rc16-bug-fixes (archived)
- template-extraction (archived)

---

## 🎯 NEXT ACTIONS

**Priority 1: Fix naming for 7 tasks (5 min)**
- Rename tasks to include `#issue-number` prefix
- Make them slug-friendly for LLM recognition

**Priority 2: Create missing GitHub issues (15 min)**
- [NEURON] Git → Issue
- UUID Reuse investigation → Issue
- TRIAGE Incomplete Wishes → Issue

**Priority 3: Merge duplicate tasks (5 min)**
- Remove `[FRESH] Spells Prioritization` (it's a retry of #107)
- Keep single source of truth per issue

**Result:** 19 tasks → properly standardized, all with issues, all mappable

---

**Status:** 🔴 AUDIT COMPLETE - Ready for standardization pass

