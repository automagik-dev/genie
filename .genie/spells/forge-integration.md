---
name: Forge Integration
description: Complete Forge integration - architecture, API, entry point patterns, meta-learning
---

# Forge Integration - Complete Guide

**Purpose:** Comprehensive understanding of Forge as primary entry point, architecture, and API integration

---

## Part 1: Forge as Main Entry Point 🔴 CRITICAL

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
- [forge-int-001] helpful=0 harmful=0: **Clear ownership:** Each forge task card owns exactly one PR
- [forge-int-002] helpful=0 harmful=0: **Parallel safety:** Independent worktrees enable simultaneous work without conflicts
- [forge-int-003] helpful=0 harmful=0: **Traceability:** Complete chain: GitHub issue ←→ forge card ←→ worktree ←→ PR
- [forge-int-004] helpful=0 harmful=0: **Main stays clean:** Only merged PRs (not work-in-progress branches)
- [forge-int-005] helpful=0 harmful=0: **Atomic delivery:** Each PR is self-contained, reviewable, revertable

**Enforcement Constraints:**
- [forge-int-006] helpful=0 harmful=0: ❌ **NEVER** create GitHub issue without forge task card
- [forge-int-007] helpful=0 harmful=0: ❌ **NEVER** create forge task card without exactly one worktree/branch
- [forge-int-008] helpful=0 harmful=0: ❌ **NEVER** create worktree without exactly one PR back to main
- [forge-int-009] helpful=0 harmful=0: ❌ **NEVER** merge PR without corresponding forge task completion
- [forge-int-010] helpful=0 harmful=0: ✅ **ALWAYS** GitHub issue → forge card → worktree → PR → main (complete chain)

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
- [forge-int-011] helpful=0 harmful=0: Every active forge card MUST have corresponding worktree
- [forge-int-012] helpful=0 harmful=0: Every worktree MUST have corresponding open PR (or be in progress)
- [forge-int-013] helpful=0 harmful=0: Every merged PR MUST have completed forge card
- [forge-int-014] helpful=0 harmful=0: Main branch MUST only receive PRs (no direct commits for forge work)

---

## Part 2: Forge as Meta-Agent (Continuous Learning) 🔴 CRITICAL

**Core Principle:** Forge is not just for code implementation. Forge can host ANY persistent work unit, including continuous learning. When Forge hosts a "learn" task, results are VISIBLE to the user.

**Why This Matters:**
- [forge-int-015] helpful=0 harmful=0: **Visibility:** User sees learning results directly in Forge UI (not hidden in MCP session logs)
- [forge-int-016] helpful=0 harmful=0: **Persistence:** Learning task lives alongside all other work (integrated development + learning)
- [forge-int-017] helpful=0 harmful=0: **Coordination:** Learning integrated with code tasks, not separate workflow
- [forge-int-018] helpful=0 harmful=0: **Continuity:** Each learning session builds on previous ones documented in Forge task
- [forge-int-019] helpful=0 harmful=0: **Accountability:** Learning outcomes traceable + reviewable just like code

**How It Works:**

1. **Create Forge "learn" task** (permanent, ongoing):
   - Task type: meta-learning
   - Description: "Continuous framework learning from user corrections and patterns"
   - Status: always active (never closed)
   - Updates: Each learning session appends findings

2. **Learning Loop:**
   ```
   Teaching Signal (user correction, new pattern, framework gap)
     ↓
   Create/Update Forge "learn" task description with observation
     ↓
   Genie delegates to learn agent via MCP
     ↓
   Learn agent analyzes + documents finding
     ↓
   Learn agent updates framework files (spells, agents, docs)
     ↓
   Forge task updated with conclusion + changed files
     ↓
   User sees result immediately in Forge UI
     ↓
   Framework permanently updated with new knowledge
   ```

**Benefits Over MCP-Only Learning:**

**MCP-only approach (old):**
- [forge-int-020] helpful=0 harmful=0: ❌ Learning happens in hidden session logs
- [forge-int-021] helpful=0 harmful=0: ❌ User must use `mcp__genie__view` to see outcomes
- [forge-int-022] helpful=0 harmful=0: ❌ No integration with development workflow
- [forge-int-023] helpful=0 harmful=0: ❌ Learning sessions disconnected from code work

**Forge-hosted learning (new):**
- [forge-int-024] helpful=0 harmful=0: ✅ Learning visible in same UI as code tasks
- [forge-int-025] helpful=0 harmful=0: ✅ User sees results immediately (no tool invocation needed)
- [forge-int-026] helpful=0 harmful=0: ✅ Learning integrated with development (one workflow)
- [forge-int-027] helpful=0 harmful=0: ✅ Each learning session builds on previous (documented in Forge task)
- [forge-int-028] helpful=0 harmful=0: ✅ Traceable: What was learned + when + which files changed

---

## Part 3: Forge Architecture Understanding

**Purpose:** Know how Forge creates tasks, worktrees, branches, and encodes metadata

### Forge Task Lifecycle

**1. Task Creation**
- [forge-int-029] helpful=0 harmful=0: **API:** `mcp__automagik_forge__create_task`
- [forge-int-030] helpful=0 harmful=0: **Returns:** task_id (UUID format, e.g., `e84ff7e9-db49-4cdb-8f5b-3c1afd2df94f`)
- [forge-int-031] helpful=0 harmful=0: **Status:** starts as "todo"

**2. Task Attempt Start**
- [forge-int-032] helpful=0 harmful=0: **API:** `mcp__automagik_forge__start_task_attempt`
- [forge-int-033] helpful=0 harmful=0: **Parameters:** task_id, executor (CLAUDE_CODE, etc.)
- [forge-int-034] helpful=0 harmful=0: **Returns:** attempt_id (UUID format, e.g., `35a403e3-fe62-4545-bffe-0285dbfa472d`)

**3. Worktree Creation (Automatic)**
Forge automatically creates a worktree with the pattern:

```
<attempt-id-prefix>-<abbreviated-task-title>
```

**Example:**
- [forge-int-035] helpful=0 harmful=0: Attempt ID: `35a403e3-fe62-4545-bffe-0285dbfa472d`
- [forge-int-036] helpful=0 harmful=0: Prefix (first 4 chars): `35a4`
- [forge-int-037] helpful=0 harmful=0: Task title: "Forge Metadata Investigation - Extract task_id structure"
- [forge-int-038] helpful=0 harmful=0: Abbreviation: "test-forge-metad"
- [forge-int-039] helpful=0 harmful=0: **Worktree dir:** `35a4-test-forge-metad`
- [forge-int-040] helpful=0 harmful=0: **Location:** `/var/tmp/automagik-forge/worktrees/35a4-test-forge-metad/`

**4. Branch Creation (Automatic)**
Forge creates a forge branch with the pattern:

```
forge/<attempt-id-prefix>-<abbreviated-task-title>
```

**Example:** `forge/35a4-test-forge-metad`

### Metadata Encoding

**Data Structure:**
```
Task Layer (Forge API):
  ├─ task_id: e84ff7e9-db49-4cdb-8f5b-3c1afd2df94f (full UUID, persistent)
  └─ task metadata: title, description, status (todo/in-progress/complete)

Attempt Layer (Forge API):
  ├─ attempt_id: 35a403e3-fe62-4545-bffe-0285dbfa472d (full UUID)
  └─ Created when: start_task_attempt() called

Worktree Layer (File System):
  ├─ directory: /var/tmp/automagik-forge/worktrees/35a4-test-forge-metad/
  ├─ prefix: 35a4 (first 4 chars of attempt_id)
  └─ branch: forge/35a4-test-forge-metad

Wish Layer (Genie):
  ├─ wish slug: extracted from abbreviated task title
  ├─ wish file: .genie/wishes/<slug>/<slug>-wish.md
  └─ must be linked in SESSION-STATE.md
```

**Key Insights for Automation:**

1. **Worktree directory name is the primary signal** - it contains both:
   - Attempt ID prefix (first 4 chars) - identifies the Forge task attempt
   - Abbreviated task title - helps identify wish

2. **Git branch also encodes this** - `forge/35a4-...` is always available and reliable

3. **No additional metadata files needed** - Forge doesn't leave .forge-context.json or similar
   - All metadata is in file system paths and git branch names

4. **Pre-commit hook has enough info** to:
   - Extract attempt prefix (identify task)
   - Find wish slug (identify work)
   - Link them in SESSION-STATE.md
   - No external API calls needed (except optional Forge MCP query)

---

## Part 4: Forge API Integration

**Purpose:** Canonical rules for synchronising Genie agent metadata with Automagik Forge

### Executor Profiles (`/api/profiles`)

- [forge-int-041] helpful=0 harmful=0: **Endpoint:** `GET /api/profiles` returns an object with `executors` mapping executor keys to profile variants
- [forge-int-042] helpful=0 harmful=0: **Update constraints:**
  - Forge rejects top-level strings; the payload MUST be `{"executors": {...}}`
  - Variants are stored under upper-case keys (`DEFAULT`, `QA_CHECKLIST`, etc.)
  - Store everything upper-case to avoid mismatches
  - Valid knob names: `append_prompt`, `model`, `model_reasoning_effort`, `sandbox`, `additional_params`, `allow_all_tools`, `dangerously_skip_permissions`, `dangerously_allow_all`, `plan`, `approvals`, `force`, `yolo`
  - `append_prompt` exists even when the UI omits it; populate it explicitly when we need prompt suffixes

**Example (adds `QA_CHECKLIST` variant for `OPENCODE`):**
```json
PUT /api/profiles
{
  "executors": {
    "OPENCODE": {
      "DEFAULT": { "OPENCODE": { "append_prompt": null } },
      "QA_CHECKLIST": {
        "OPENCODE": {
          "append_prompt": "## QA Automation Checklist Mode",
          "additional_params": [
            { "key": "playbook", "value": "qa-automation-checklist" },
            { "key": "evidence_mode", "value": "strict" }
          ]
        }
      }
    }
  }
}
```

- [forge-int-043] helpful=0 harmful=0: **CLI impact:** Agents can specify a variant via front-matter (`genie.executorProfile: QA_CHECKLIST`). `genie run --executor opencode` will push `{ executor: "OPENCODE", variant: "QA_CHECKLIST" }` to Forge.

### Task Templates (`/api/templates`)

- [forge-int-044] helpful=0 harmful=0: Templates are simple `{template_name, title, description, project_id}` records
- [forge-int-045] helpful=0 harmful=0: Description is free-form markdown/plain text
- [forge-int-046] helpful=0 harmful=0: Use them to surface Genie instructions inside Forge's UI
- [forge-int-047] helpful=0 harmful=0: They do not control execution or models

**Example sync:**
```ts
const templateBody = fs.readFileSync('.genie/create/agents/wish.md', 'utf8');
await forge.createTaskTemplate({
  template_name: 'genie-wish-qa-codex',
  title: 'Genie Wish: QA Codex Automation Checklist',
  description: templateBody,
  project_id: null
});
```

Remember: this only mirrors content. Execution still depends on executor profiles / Genie front-matter.

### Sessions

- [forge-int-048] helpful=0 harmful=0: Forge session creation expects `{ executor_profile_id: { executor, variant } }`
- [forge-int-049] helpful=0 harmful=0: `variant` must match one of the profile keys (defaults to `DEFAULT`)
- [forge-int-050] helpful=0 harmful=0: Genie session metadata stores both `executor` and `executorVariant`
- [forge-int-051] helpful=0 harmful=0: Ensure we set both when forging sessions (fallbacks removed)

### Best Practices & Lessons

- [forge-int-052] helpful=0 harmful=0: 🔁 **Roundtrip test before mutating profiles:** Slam the existing `profiles.content` into `PUT /api/profiles` to verify format, then mutate
- [forge-int-053] helpful=0 harmful=0: 🪪 **Keep history:** Save every API interaction log in `.genie/qa/evidence/forge-api-report-YYYYMMDDHHMM.md`
- [forge-int-054] helpful=0 harmful=0: 📜 **Front-matter contract:** Every agent that declares `genie.executor` SHOULD also declare the matching Forge variant if it is not `DEFAULT`
- [forge-int-055] helpful=0 harmful=0: 🧩 **Future work:** Consider scripted export/import (CLI verb) to sync collectives → Forge templates & profile variants automatically

---

## References

- [forge-int-056] helpful=0 harmful=0: `@.genie/spells/forge-orchestration.md` - Workflow delegation and orchestration patterns
- [forge-int-057] helpful=0 harmful=0: `@.genie/code/workflows/forge.md` - Forge workflow documentation
- [forge-int-058] helpful=0 harmful=0: `@.genie/spells/orchestrator-not-implementor.md` - Agent role boundaries

---

**Evidence:** Merged from 3 spell files (forge-architecture, forge-api-integration, forge-integration) on 2025-10-23 during duplicate cleanup initiative.
