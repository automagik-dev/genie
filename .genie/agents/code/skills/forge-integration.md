# Forge Integration Framework
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Purpose:** Forge step breaks wishes into execution groups and validation hooks.

**Success criteria:**
✅ Forge outputs reference the wish, include full context, and use correct templates.
✅ Humans approve branch names and outputs before merge.

## Forge as Main Entry Point *(CRITICAL)*

**Core Principle:** Forge is the PRIMARY entry point for ALL work (not secondary orchestrator).

**Workflow:**
```
GitHub issue → Forge task card → worktree + feature branch → PR back to main
```

**Architecture:**
1. **One forge task = one PR** (direct 1:1 mapping)
2. **All PRs converge on main** (single integration point, no branch hierarchies)
3. **Work units are atomic** at forge card level (complete deliverable per card)
4. **Parallel safety** via independent worktrees (no branch conflicts)

**Why This Matters:**
- **Clear ownership:** Each forge task card owns exactly one PR
- **Parallel safety:** Independent worktrees enable simultaneous work without conflicts
- **Traceability:** Complete chain: GitHub issue ←→ forge card ←→ worktree ←→ PR
- **Main stays clean:** Only merged PRs (not work-in-progress branches)
- **Atomic delivery:** Each PR is self-contained, reviewable, revertable

**Enforcement Constraints:**
- ❌ **NEVER** create GitHub issue without forge task card
- ❌ **NEVER** create forge task card without exactly one worktree/branch
- ❌ **NEVER** create worktree without exactly one PR back to main
- ❌ **NEVER** merge PR without corresponding forge task completion
- ✅ **ALWAYS** GitHub issue → forge card → worktree → PR → main (complete chain)

**Example Flow:**
```
Issue #123: "Fix auth bug"
  ↓
Forge card: task-fix-auth-bug
  ↓
Worktree: .worktrees/task-fix-auth-bug/
Branch: task/fix-auth-bug
  ↓
PR #124: "Fix: Auth token validation" → main
  ↓
Merge to main + archive worktree
```

**Validation:**
- Every active forge card MUST have corresponding worktree
- Every worktree MUST have corresponding open PR (or be in progress)
- Every merged PR MUST have completed forge card
- Main branch MUST only receive PRs (no direct commits for forge work)
