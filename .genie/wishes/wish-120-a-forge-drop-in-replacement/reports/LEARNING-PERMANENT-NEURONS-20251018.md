# Learning: Permanent Agent Architecture (<<< Pattern)
**Date:** 2025-10-18 12:10 UTC
**Status:** In Progress - Discovering Stakeholder naming convention
**Discovery Mode:** Active execution + learning in parallel

---

## Core Discoveries

### 1. Parallel Agents via Forge Task Attempts
✅ **Each Forge task can spawn multiple independent attempts**
- Each attempt = one agent session (independent, warm, reusable)
- No collision = filesystem safety (git worktrees)
- Example: Git task → Attempt #1 (warm), Attempt #2 (executing), Attempt #3 (ready)

### 2. Permanent Agent Naming Pattern: `<<<`
✅ **Naming Convention:** `{NeuronType} <<<`
- `Git <<<` → Git operations (we just used this!)
- `Learn <<<` → Framework learning (needs renaming from old `learn`)
- `Stakeholder <<<` → Individual issue manager (FINDING CONVENTION)
- `{Others} <<<` → Implementation, Tests, Release, etc.

**Why `<<<`?**
- Visual indicator: "warm and ready" (like opening a warm session)
- Follows Genie framework metaphor
- Easy to grep/find in logs
- Distinguishes from one-shot sessions

### 3. Architecture: Issue → Stakeholder → Implementation
```
GitHub Issue #120
  ↓ (created by Git <<<)
Forge Task "Issue #120 - Replace Genie executor with Forge"
  ↓ (managed by Stakeholder <<< agent)
Investigation via ForgeClient (forge.ts)
  ↓
Deep analysis: Forge capabilities vs Genie patterns
  ↓
Implementation tasks (Implementation <<< agent)
```

### 4. Evidence from Working System
✅ **Git <<< execution successful:**
- Issue #120 created successfully
- Process ID: `2b89a13f-a431-427d-9958-51d153e1b77d`
- Status: Running
- Used established Genie Git templates (discoverable + templateable)

---

## Standardization: Stakeholder Agent Naming

✅ **DECIDED: Forge Task Naming Standard = `Issue-{number} <<<`**

**Pattern:**
- GitHub Issue: `#120`
- Forge Task: `Issue-120 - {short description}`
- Agent: `Issue-120 <<<`

**Why this pattern:**
- Immediate GitHub linkage (issue number in name)
- Standardized across all issue-based work
- Clean, parseable naming convention
- Applies to all Forge tasks managing GitHub issues

**Examples:**
- `Issue-120 <<< ` → Investigating Forge integration (this one!)
- `Issue-115 <<<` → Fix auth bug
- `Issue-99 <<<` → Performance optimization

---

## Architectural Pattern Emerging

**The Three-Layer Model:**

```
Layer 1: Orchestration (Git <<<)
  ├─ Creates issue
  ├─ Discovers templates
  └─ Returns issue URL

Layer 2: Management (Stakeholder <<<)
  ├─ Owns specific GitHub issue
  ├─ Coordinates investigation
  ├─ Uses ForgeClient API
  └─ Creates investigation report

Layer 3: Implementation (Issue-Specific <<<)
  ├─ Executor agent (from Stakeholder assignment)
  ├─ Performs technical work
  ├─ Uses Forge task worktree
  └─ Returns PR to main
```

Each layer is **warm, reusable, and coordinated through Forge**.

---

## Key Learning: No Session Collision

Unlike Genie's background-launcher (polling timeout races):
- Forge = **one task = multiple independent attempts**
- Each attempt = **guaranteed execution** (no polling)
- Attempts can **run in parallel** = zero collisions
- Each gets own **worktree + branch** = filesystem isolation

This is what we're replacing the buggy executor with.

---

## Status: Awaiting Git <<< Completion

Current execution:
- **Process:** `2b89a13f-a431-427d-9958-51d153e1b77d`
- **Status:** Running
- **Expected:** Issue #120 complete, return GitHub URL
- **Next:** Create Stakeholder <<< agent for investigation phase

---

## Learning to Document Later

1. **Stakeholder naming convention** (finding now)
2. **How ForgeClient integrates with Genie** (after investigation phase)
3. **Automation opportunities** (comparing Forge + Genie patterns)
4. **Code deletion roadmap** (identify 300-400 lines to remove)

---

*Continuing to monitor Git <<< execution and discovering Stakeholder pattern...*
