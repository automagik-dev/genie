# Task Naming Convention - Executive Summary
**Created:** 2025-10-21
**For:** Felipe (Review & Approval)
**Full Spec:** `.genie/reports/task-naming-convention-spec.md`

---

## 🎯 Problem Statement

**Current state:**
- 21 Forge tasks analyzed: 7 different prefix patterns (inconsistent)
- 19 of 21 tasks (90%) violate Amendment #1 (no GitHub issue reference)
- Generic names: "Task 1", "NEW IDEA", "Genie: learn (default)"
- Impossible to determine phase/type from title alone

**Impact:**
- Cognitive load when scanning Kanban boards
- Amendment #1 violations (can't track Issue↔Task linkage)
- Duplicate work (same task created multiple times)
- Poor cross-system coordination (GitHub ↔ Forge ↔ Agents)

---

## ✅ Proposed Solution

### Standard Format

**GitHub Issues:**
```
[PREFIX] Clear Action-Oriented Title
```

**Forge Tasks:**
```
Prefix: Clear Action-Oriented Title (#GitHubIssueNumber)
```

**Agent Sessions:**
```
Agent: Operation/Mode (#optional)
```

### Standard Prefixes

| Prefix | Use Case | Example |
|--------|----------|---------|
| **Bug** | Something broken | `Bug: Forge API 422 error (#151)` |
| **Wish** | New feature planning | `Wish: MCP Authentication (#152)` |
| **Learn** | Research/investigation | `Learn: Task Naming Convention (#NNN)` |
| **Forge** | Implementation | `Forge: Executor Integration (#143)` |
| **Review** | Quality assurance | `Review: Bounty System PR (#NNN)` |
| **Refactor** | Code improvement | `Refactor: Session State Schema (#NNN)` |
| **Docs** | Documentation | `Docs: MCP Integration Guide (#NNN)` |
| **Chore** | Maintenance | `Chore: Update dependencies (#NNN)` |

### Three Core Rules

1. **MUST include GitHub issue reference:** `(#NNN)` at end
   - Exception: Meta-tasks that CREATE issues

2. **MUST use standard prefix:** Select from table above

3. **MUST be action-oriented:** Start with verb, clear outcome

---

## 📊 Current Violations

**Analysis of 21 Forge tasks:**
- ❌ 19 tasks missing issue references (90% violation rate)
- ❌ 5 tasks use generic "Task N" naming
- ❌ 2 tasks have duplicate names (different UUIDs)
- ❌ 1 task has no structure at all ("NEW IDEA")

**Examples of violations:**
- `Task 1: Forge Project Auto-Sync on MCP Startup` → Should be: `Chore: Forge Auto-Sync on MCP Startup (#NNN)`
- `NEW IDEA` → Should be: `Wish: <Actual Idea Name> (#NNN)`
- `Genie: learn (default)` → Should be: `Learn: <What Being Learned> (#NNN)`

---

## 🚀 Implementation Plan

### Phase 1: Document (This Week) ✅
- [x] Create naming convention spec
- [ ] Update AGENTS.md with convention
- [ ] Get Felipe approval
- [ ] Create GitHub issue for this work

### Phase 2: Audit (Week 2)
- [ ] Run automated audit of all Forge tasks
- [ ] Run automated audit of all GitHub issues
- [ ] Generate violation report
- [ ] Prioritize remediation (critical bugs first)

### Phase 3: Remediate (Week 3)
- [ ] Create missing GitHub issues for orphaned tasks
- [ ] Rename Forge tasks to match convention
- [ ] Link all tasks to issues
- [ ] Close duplicate tasks

### Phase 4: Enforce (Week 4)
- [ ] Add validation to Forge MCP task creation
- [ ] Update agent prompts with naming rules
- [ ] Add naming section to AGENTS.md
- [ ] Update wish/forge/review workflows

---

## 💡 Key Benefits

1. **Instant Recognition:** Prefix shows phase/type at a glance
2. **Amendment #1 Compliance:** Issue reference built into title
3. **Cross-System Tracking:** Same name across GitHub ↔ Forge ↔ Agents
4. **Reduced Duplication:** Unique, descriptive names prevent re-creation
5. **Better Scanning:** 80-char limit, front-loaded important words

---

## 🎯 Success Metrics

**Immediate (1 week):**
- All NEW tasks follow convention
- Zero new tasks without issue references

**Short-term (1 month):**
- All existing tasks renamed/linked
- 100% Amendment #1 compliance

**Long-term:**
- Automated validation in Forge MCP
- Zero violations in new task creation

---

## 🤔 Decision Points for Felipe

### 1. Approve Standard Format?
- GitHub: `[BRACKETS]`
- Forge: `Capitalized:`
- Agents: `Agent: operation`

**Your input:** ✅ Approve / ❌ Modify / 💬 Discuss

### 2. Approve Standard Prefixes?
Current: Bug, Wish, Learn, Forge, Review, Refactor, Docs, Chore

**Your input:** ✅ Approve / ➕ Add more / ➖ Remove some

### 3. Approve Migration Plan?
4-week phased rollout: Document → Audit → Remediate → Enforce

**Your input:** ✅ Approve / ⏩ Accelerate / ⏸️ Delay

### 4. Immediate Action Items?
Should we start with:
- [ ] Critical bug tasks (#151, #150) - create issues NOW
- [ ] Current session (this Learn task) - follow convention
- [ ] All new tasks going forward - strict enforcement

**Your input:** Select priorities

---

## 📋 Quick Reference Card

**Creating a new task? Use this template:**

```
1. Does GitHub issue exist?
   NO → Create issue first: [PREFIX] Title
   YES → Continue to step 2

2. Create Forge task:
   Prefix: Title matching GitHub issue (#NNN)

3. Start agent session (if needed):
   Agent: Operation description
```

**Prefixes cheat sheet:**
- Broken? → **Bug:**
- New feature? → **Wish:** (planning) or **Forge:** (implementing)
- Research? → **Learn:**
- Quality check? → **Review:**
- Clean up code? → **Refactor:**
- Write docs? → **Docs:**
- Maintenance? → **Chore:**

---

## 📎 Attachments

**Full specification:** `.genie/reports/task-naming-convention-spec.md` (48KB, comprehensive)

**Includes:**
- Complete prefix table with all variations
- 30+ examples by scenario
- Detailed migration strategy
- Validation checklist
- FAQ section
- Design rationale

---

## ✅ Next Steps

1. **Review this summary + full spec**
2. **Provide feedback/approval**
3. **I will then:**
   - Update AGENTS.md with approved convention
   - Create GitHub issue for this work
   - Begin remediation of current violations
   - Implement enforcement in workflows

**Estimated time to full adoption:** 4 weeks
**Estimated effort:** Medium (mostly automated audit + batch renames)
**Risk:** Low (naming convention, no code changes)

---

**Awaiting your approval to proceed! 🚀**
