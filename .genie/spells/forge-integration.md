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

---

## Part 2: Forge as Meta-Agent (Continuous Learning) 🔴 CRITICAL

**Core Principle:** Forge is not just for code implementation. Forge can host ANY persistent work unit, including continuous learning. When Forge hosts a "learn" task, results are VISIBLE to the user.

**Why This Matters:**
- **Visibility:** User sees learning results directly in Forge UI (not hidden in MCP session logs)
- **Persistence:** Learning task lives alongside all other work (integrated development + learning)
- **Coordination:** Learning integrated with code tasks, not separate workflow
- **Continuity:** Each learning session builds on previous ones documented in Forge task
- **Accountability:** Learning outcomes traceable + reviewable just like code

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
- ❌ Learning happens in hidden session logs
- ❌ User must use `mcp__genie__view` to see outcomes
- ❌ No integration with development workflow
- ❌ Learning sessions disconnected from code work

**Forge-hosted learning (new):**
- ✅ Learning visible in same UI as code tasks
- ✅ User sees results immediately (no tool invocation needed)
- ✅ Learning integrated with development (one workflow)
- ✅ Each learning session builds on previous (documented in Forge task)
- ✅ Traceable: What was learned + when + which files changed

---

## Part 3: Forge Architecture Understanding

**Purpose:** Know how Forge creates tasks, worktrees, branches, and encodes metadata

### Forge Task Lifecycle

**1. Task Creation**
- **API:** `mcp__automagik_forge__create_task`
- **Returns:** task_id (UUID format, e.g., `e84ff7e9-db49-4cdb-8f5b-3c1afd2df94f`)
- **Status:** starts as "todo"

**2. Task Attempt Start**
- **API:** `mcp__automagik_forge__start_task_attempt`
- **Parameters:** task_id, executor (CLAUDE_CODE, etc.)
- **Returns:** attempt_id (UUID format, e.g., `35a403e3-fe62-4545-bffe-0285dbfa472d`)

**3. Worktree Creation (Automatic)**
Forge automatically creates a worktree with the pattern:

```
<attempt-id-prefix>-<abbreviated-task-title>
```

**Example:**
- Attempt ID: `35a403e3-fe62-4545-bffe-0285dbfa472d`
- Prefix (first 4 chars): `35a4`
- Task title: "Forge Metadata Investigation - Extract task_id structure"
- Abbreviation: "test-forge-metad"
- **Worktree dir:** `35a4-test-forge-metad`
- **Location:** `/var/tmp/automagik-forge/worktrees/35a4-test-forge-metad/`

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

- **Endpoint:** `GET /api/profiles` returns an object with `executors` mapping executor keys to profile variants
- **Update constraints:**
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

- **CLI impact:** Agents can specify a variant via front-matter (`genie.executorProfile: QA_CHECKLIST`). `genie run --executor opencode` will push `{ executor: "OPENCODE", variant: "QA_CHECKLIST" }` to Forge.

### Task Templates (`/api/templates`)

- Templates are simple `{template_name, title, description, project_id}` records
- Description is free-form markdown/plain text
- Use them to surface Genie instructions inside Forge's UI
- They do not control execution or models

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

- Forge session creation expects `{ executor_profile_id: { executor, variant } }`
- `variant` must match one of the profile keys (defaults to `DEFAULT`)
- Genie session metadata stores both `executor` and `executorVariant`
- Ensure we set both when forging sessions (fallbacks removed)

### Best Practices & Lessons

- 🔁 **Roundtrip test before mutating profiles:** Slam the existing `profiles.content` into `PUT /api/profiles` to verify format, then mutate
- 🪪 **Keep history:** Save every API interaction log in `.genie/qa/evidence/forge-api-report-YYYYMMDDHHMM.md`
- 📜 **Front-matter contract:** Every agent that declares `genie.executor` SHOULD also declare the matching Forge variant if it is not `DEFAULT`
- 🧩 **Future work:** Consider scripted export/import (CLI verb) to sync collectives → Forge templates & profile variants automatically

---

## References

- `@.genie/spells/forge-orchestration.md` - Workflow delegation and orchestration patterns
- `@.genie/code/workflows/forge.md` - Forge workflow documentation
- `@.genie/spells/orchestrator-not-implementor.md` - Agent role boundaries

---

**Evidence:** Merged from 3 spell files (forge-architecture, forge-api-integration, forge-integration) on 2025-10-23 during duplicate cleanup initiative.
