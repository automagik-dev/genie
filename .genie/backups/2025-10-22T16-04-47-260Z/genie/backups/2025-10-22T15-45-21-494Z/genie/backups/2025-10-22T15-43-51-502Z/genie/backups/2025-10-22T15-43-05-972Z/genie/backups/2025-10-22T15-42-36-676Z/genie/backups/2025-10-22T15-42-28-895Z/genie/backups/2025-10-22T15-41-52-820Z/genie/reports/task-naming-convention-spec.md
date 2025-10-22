# Task Naming Convention Specification
**Version:** 1.0.0
**Created:** 2025-10-21
**Purpose:** Standardize naming across GitHub Issues, Forge Tasks, and Agent Sessions
**Status:** DRAFT for Review

---

## 🎯 Executive Summary

**Problem:** Inconsistent naming patterns make it difficult to:
- Understand task type/phase from title alone
- Track work across GitHub ↔ Forge ↔ Agent systems
- Scan kanban boards efficiently
- Maintain Amendment #1 compliance (Issue ↔ Task mapping)

**Solution:** Three-tier naming convention with clear prefixes, structured format, and GitHub issue references.

---

## 📊 Current State Analysis

### Observed Patterns in Forge Tasks (21 tasks analyzed)

**Prefix Patterns:**
- `Wish:` (7 tasks) - Planning/discovery phase
- `Learn:` (3 tasks) - Research/validation phase
- `[IMPLEMENTATION]` (1 task) - Execution phase
- `Task N:` (5 tasks) - Generic numbered tasks
- `Genie:` (2 tasks) - Agent-specific work
- `Git:` (1 task) - Agent-specific work
- `Project Manager:` (1 task) - Role-based task
- No prefix (1 task: "NEW IDEA")

**Suffix Patterns:**
- `(#NNN)` - GitHub issue reference (2 tasks)
- No issue reference (19 tasks) - **Violates Amendment #1**

**Quality Issues:**
- Duplicate tasks with same/similar names
- Unclear phase (wish vs implementation)
- Missing issue references
- Inconsistent capitalization
- No status indicators

### Observed Patterns in GitHub Issues (20 issues analyzed)

**Prefix Patterns:**
- `[Make a Wish]` - Wish triage system
- `[WISH] #NNN-X:` - Structured wish references
- `Bug:` - Bug reports
- No prefix - Mixed (enhancements, features)

**Label System:**
- `type:*` - bug, enhancement (minimal usage)
- `area:*` - 16 areas (agents, api, auth, build, cli, docs, forge, etc.)
- `priority:*` - high, medium (implied)
- `status:*` - needs-triage (minimal)
- `initiative-NN` - Parent initiative tracking
- `roadmap-linked`, `planned-feature` - Planning indicators

---

## 🏗️ Naming Convention Architecture

### Three-Tier System

**Tier 1: Work Type Prefix**
- Indicates phase/purpose
- Always uppercase in brackets for GitHub issues
- Always capitalized with colon for Forge/Agent sessions

**Tier 2: Core Title**
- Clear, concise description
- Action-oriented (verb-noun pattern preferred)
- Maximum 80 characters

**Tier 3: Reference Suffix**
- GitHub issue reference (required per Amendment #1)
- Optional: Parent wish reference

---

## 📋 Standard Prefixes

### Primary Work Types

| Prefix | Usage | GitHub Format | Forge/Agent Format | When to Use |
|--------|-------|---------------|-------------------|-------------|
| **Bug** | Bug fixes | `Bug: <title> (#NNN)` | `Bug: <title> (#NNN)` | Something broken, needs fixing |
| **Wish** | Discovery/planning | `[WISH] <title>` | `Wish: <title> (#NNN)` | New feature/capability, needs design |
| **Learn** | Research/validation | `[LEARN] <title>` | `Learn: <title> (#NNN)` | Knowledge acquisition, investigation |
| **Forge** | Implementation | `[IMPLEMENTATION] <title>` | `Forge: <title> (#NNN)` | Executing defined work |
| **Review** | Quality assurance | `[REVIEW] <title>` | `Review: <title> (#NNN)` | Validation, testing, approval |
| **Refactor** | Code improvement | `[REFACTOR] <title>` | `Refactor: <title> (#NNN)` | Restructuring without new features |
| **Docs** | Documentation | `[DOCS] <title>` | `Docs: <title> (#NNN)` | Writing/updating documentation |
| **Chore** | Maintenance | `[CHORE] <title>` | `Chore: <title> (#NNN)` | CI/CD, dependencies, housekeeping |

### Agent-Specific Work

| Prefix | Usage | Format | When to Use |
|--------|-------|--------|-------------|
| **Genie** | Base orchestrator work | `Genie: <agent>:<mode> (#NNN)` | Main conversation tasks |
| **Git** | GitHub operations | `Git: <operation> (#NNN)` | Issue/PR/label management |
| **Implementor** | Code implementation | `Implementor: <feature> (#NNN)` | Writing code |
| **Tests** | Test writing | `Tests: <target> (#NNN)` | Creating/updating tests |
| **Release** | Release management | `Release: <version> (#NNN)` | Publishing releases |
| **Prompt** | Instruction writing | `Prompt: <target> (#NNN)` | Writing agent prompts |

### Composite Patterns

**Wish Sub-Types:**
| Pattern | Example | Usage |
|---------|---------|-------|
| `Wish Discovery:` | `Wish Discovery: MCP Auth (#152)` | Investigation before formal wish |
| `Wish: <title> (#NNN-A)` | `Wish: Forge Drop-In (#120-A)` | Wish broken into parts |

**Learn Sub-Types:**
| Pattern | Example | Usage |
|---------|---------|-------|
| `Learn: <topic>` | `Learn: Forge Orchestration (#NNN)` | Standard learning |
| `Learn: <violation>` | `Learn: RC Failure - Anti-Pattern (#NNN)` | Post-incident analysis |

---

## 🎯 Naming Rules

### MUST Requirements

1. **✅ MUST include GitHub issue reference**
   - Format: `(#NNN)` at end of title
   - Exception: Meta-tasks (Release, Git operations for creating issues)
   - Enforcement: Amendment #1

2. **✅ MUST use consistent prefix**
   - Select from standard prefixes table
   - GitHub: `[BRACKETS]`
   - Forge/Agents: `Capitalized:`

3. **✅ MUST be action-oriented**
   - Start with verb when possible
   - Clear outcome expectation
   - Example: `Fix` not `Fixing`, `Standardize` not `Standardization`

4. **✅ MUST be scannable**
   - Maximum 80 characters (including prefix and reference)
   - Front-load important words
   - Avoid unnecessary words

### SHOULD Guidelines

5. **✅ SHOULD include context**
   - Area/component when helpful
   - Example: `Bug: Forge executor base_branch hardcoding (#154)`

6. **✅ SHOULD be unique**
   - Avoid duplicate task names
   - Use issue reference to differentiate

7. **✅ SHOULD match labels**
   - GitHub issue labels align with prefix
   - `Bug:` → `type:bug` label
   - `Wish:` → `area:wishes` label

### MUST NOT Restrictions

8. **❌ MUST NOT use generic numbers**
   - Avoid: `Task 1`, `Task 2`
   - Use: Descriptive names with issue reference

9. **❌ MUST NOT duplicate across systems**
   - Same logical work = same title (except format)
   - GitHub `[BUG] Fix port (#148)` = Forge `Bug: Fix port (#148)`

10. **❌ MUST NOT omit issue references**
    - Exception: Meta-tasks that CREATE issues
    - All other tasks MUST reference issue

---

## 📝 Formatting Standards

### GitHub Issues

```
[PREFIX] Title with Clear Action (#reference-if-applicable)

Examples:
✅ [WISH] Unified MCP Startup with Auth & Tunnel
✅ Bug: Forge executor hardcodes base_branch (#154)
✅ [LEARN] Token-Efficient Knowledge Architecture
❌ Task 1: Forge Project Auto-Sync (no prefix clarity)
❌ NEW IDEA (no structure at all)
```

### Forge Tasks

```
Prefix: Title matching GitHub issue (#NNN)

Examples:
✅ Wish: Unified MCP Startup with Auth & Tunnel (#152)
✅ Bug: Forge executor base_branch hardcoding (#154)
✅ Learn: Token-Efficient Knowledge Architecture (#155)
❌ Task 1: Forge Project Auto-Sync on MCP Startup (no issue)
❌ NEW IDEA (no structure)
```

### Agent Sessions

```
Agent: Operation/Mode (#NNN-optional)

Examples:
✅ Genie: plan:bounty-marketplace
✅ Git: Create wish issue for bounty system
✅ Learn: Task naming convention (#NNN)
✅ Implementor: Forge executor auto-branch
❌ Session-12345 (UUID, not descriptive)
❌ Work (too generic)
```

---

## 🔄 Migration Strategy

### Phase 1: Document Standard (Current)
- ✅ Create this specification
- Update AGENTS.md with new convention
- Get Felipe approval

### Phase 2: Validate Current Tasks
- Audit all open Forge tasks
- Audit all open GitHub issues
- Create mapping report (like forge-github-mapping-20251020.md)

### Phase 3: Remediate Violations
- Rename tasks to match standard
- Create missing GitHub issues
- Link orphaned tasks to issues
- Close duplicate tasks

### Phase 4: Enforce Going Forward
- Update task creation workflows
- Add validation to Forge MCP
- Update agent prompts with naming rules
- Document in SESSION-STATE.md

---

## 📊 Examples by Scenario

### Scenario 1: Bug Report → Fix

**GitHub Issue:**
```
Bug: Forge API 422 error on task creation (#151)
Labels: type:bug, area:forge, priority:high
```

**Forge Task:**
```
Bug: Forge API 422 error on task creation (#151)
Status: todo → in-progress → in-review → done
```

**Agent Session:**
```
Implementor: Fix Forge 422 validation error
(Linked to task, which links to issue)
```

### Scenario 2: Wish → Implementation

**GitHub Issue (Discovery):**
```
[WISH] MCP Server Authentication for Remote Access (#152)
Labels: area:mcp, area:auth, priority:high
```

**Forge Task (Discovery):**
```
Wish Discovery: MCP Server Authentication (#152)
Status: in-progress
```

**Agent Session (Discovery):**
```
Wish: MCP Authentication investigation (#152)
```

**GitHub Issue (After wish approval):**
```
[IMPLEMENTATION] MCP Server Authentication (#152)
(Same issue, status/label update)
```

**Forge Task (Implementation):**
```
Forge: MCP Server Authentication (#152)
Status: todo → in-progress
```

**Agent Session (Implementation):**
```
Implementor: MCP auth endpoints
```

### Scenario 3: Learn Task

**GitHub Issue:**
```
[LEARN] Standardize Task Naming Convention (#NNN)
Labels: area:forge, area:docs
```

**Forge Task:**
```
Learn: Standardize Task Naming Convention (#NNN)
Status: in-progress
```

**Agent Session:**
```
Learn: Task naming convention research
```

### Scenario 4: Agent-Specific Work

**GitHub Issue:**
```
[CHORE] Sync GitHub issues with Forge tasks (#NNN)
Labels: area:forge
```

**Forge Task:**
```
Git: Sync issues with Forge tasks (#NNN)
Status: todo
```

**Agent Session:**
```
Git: Mass issue creation for orphaned tasks
```

---

## 🎯 Validation Checklist

Before creating any task/issue, verify:

- [ ] Prefix matches work type (Bug, Wish, Learn, Forge, etc.)
- [ ] Title is action-oriented and clear
- [ ] GitHub issue exists (or meta-task to create one)
- [ ] Issue reference included: `(#NNN)`
- [ ] Title ≤ 80 characters
- [ ] GitHub issue has appropriate labels
- [ ] No duplicate with existing tasks
- [ ] Follows format: `Prefix: Title (#NNN)`

---

## 🔗 Cross-Reference Table

| GitHub Issue Prefix | Forge Task Prefix | Agent Session Pattern | GitHub Labels |
|---------------------|-------------------|----------------------|---------------|
| `Bug:` | `Bug:` | `Implementor:` | `type:bug, area:*` |
| `[WISH]` | `Wish:` or `Wish Discovery:` | `Wish:` | `area:wishes` |
| `[LEARN]` | `Learn:` | `Learn:` | `area:knowledge` |
| `[IMPLEMENTATION]` | `Forge:` | `Implementor:` | `area:*` |
| `[REVIEW]` | `Review:` | `Review:` | `status:in-review` |
| `[REFACTOR]` | `Refactor:` | `Implementor:` | `type:enhancement` |
| `[DOCS]` | `Docs:` | `Prompt:` or `Learn:` | `area:docs` |
| `[CHORE]` | `Chore:` | Various | `area:build` |

---

## 📈 Success Metrics

**Short-term (1 week):**
- All new tasks follow convention
- Zero tasks created without issue references
- Agent sessions use descriptive names

**Medium-term (1 month):**
- All existing tasks renamed/linked
- No orphaned tasks (all have issues)
- No orphaned issues (all have tasks if in-progress)

**Long-term (Continuous):**
- Automated validation in Forge MCP
- Zero naming convention violations
- Instant task type recognition from title

---

## 🧠 Rationale & Design Decisions

### Why Prefixes?

**Problem:** Scanning 20+ tasks with no context = cognitive load
**Solution:** Front-load type information for instant recognition

**Alternative considered:** Suffix indicators
**Rejected because:** Eyes scan left-to-right, prefix spotted faster

### Why GitHub Issue References Required?

**Problem:** Amendment #1 compliance, cross-system tracking
**Solution:** `(#NNN)` suffix makes linkage explicit

**Alternative considered:** Separate mapping file
**Rejected because:** Maintenance burden, out-of-sync risk

### Why Different Formats for GitHub vs Forge?

**Problem:** GitHub uses `[BRACKETS]`, Forge uses `Capitalized:`
**Solution:** Accept both, focus on semantic consistency

**Alternative considered:** Force one format everywhere
**Rejected because:** GitHub convention already established, not worth migration cost

### Why Agent-Specific Prefixes?

**Problem:** Same agent doing different work across tasks
**Solution:** `Agent: operation` pattern shows who + what

**Alternative considered:** Generic prefixes only
**Rejected because:** Loses agent identity in session lists

---

## 🚀 Implementation Plan

### Week 1: Foundation
- [ ] Review this spec with Felipe
- [ ] Update AGENTS.md with naming convention
- [ ] Create GitHub issue for this work (meta)
- [ ] Merge this spec to main

### Week 2: Audit
- [ ] Run Forge task audit script
- [ ] Run GitHub issue audit script
- [ ] Generate violation report
- [ ] Prioritize remediation (critical bugs first)

### Week 3: Remediation
- [ ] Create missing GitHub issues
- [ ] Rename Forge tasks to match convention
- [ ] Link orphaned tasks
- [ ] Close duplicate tasks
- [ ] Update SESSION-STATE.md

### Week 4: Enforcement
- [ ] Add validation to Forge MCP task creation
- [ ] Update agent prompts with naming rules
- [ ] Add naming convention to AGENTS.md
- [ ] Document in wish/forge/review workflows

---

## 🔍 FAQ

**Q: What if a task doesn't fit any prefix?**
A: Use `Chore:` for maintenance work, or propose new prefix with rationale.

**Q: Can I have multiple prefixes?**
A: No. Choose the PRIMARY work type. Example: Learning about bugs = `Learn:`, not `Bug: Learn:`

**Q: What about sub-tasks?**
A: Use parent issue reference: `Forge: MCP Auth - Endpoints (#152-A)`

**Q: What if GitHub issue doesn't exist yet?**
A: Create it first (Amendment #1), or mark task as meta: `Git: Create issue for X`

**Q: Are agent session names required to match exactly?**
A: No, sessions can be more casual. Convention is RECOMMENDED, not required.

**Q: What about historical tasks?**
A: Rename during remediation phase (Week 3), low priority unless actively worked on.

---

## 📝 Amendment Status

**Relates to:** Amendment #1 (No Wish Without Issue)

**Enforcement:** This convention makes Amendment #1 compliance VISIBLE in task titles.

**Validation:** `(#NNN)` suffix required → instant compliance check

---

## ✅ Approval & Adoption

**Status:** DRAFT
**Reviewer:** Felipe
**Approval Date:** TBD
**Adoption Date:** TBD

**Sign-off:**
- [ ] Felipe (Product Owner)
- [ ] Genie (Orchestrator)
- [ ] Learn Agent (Documenter)

---

**Next Steps:**
1. Review with Felipe
2. Update AGENTS.md
3. Begin audit phase
4. Implement enforcement
