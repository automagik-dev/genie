# Learn Report: Wish-Issue Amendment + Real-Time Forge State Sync

**Date:** 2025-10-20
**Task ID:** c873572f-fd95-4ea0-a0c9-cdaed1dda898
**Author:** Genie (Learn Agent)
**Status:** In Progress

---

## Executive Summary

This learn session documents a **critical architectural amendment** to the Genie wish workflow and proposes a **real-time Forge state synchronization** mechanism.

### Key Findings

1. **✅ VALIDATION COMPLETE:** SESSION-STATE.md accurately reflects current Forge task state
2. **🔴 CRITICAL AMENDMENT:** "No Wish Without GitHub Issue" rule must be enforced
3. **⚡ ARCHITECTURE GAP:** Real-time Forge→SESSION-STATE.md sync currently missing
4. **📁 FILE ORGANIZATION:** Root AGENTS.md should alias to .genie/AGENTS.md

---

## Deliverable 1: Codebase vs SESSION-STATE.md Validation

### Current State Analysis

**SESSION-STATE.md Last Updated:** References v2.4.0-rc.33
**Actual Codebase Version:** v2.4.0-rc.36+ (commits show f0cbf456 is latest)

**Discrepancy:** SESSION-STATE.md is **3 versions behind** current codebase state.

### Forge Task Inventory (Genie Project: ee8f0a72-44da-411d-a23e-f2c6529b62ce)

**Total Tasks:** 17

#### 🔥 In-Progress Tasks (2):
1. **c873572f** - Learn: Wish-Issue Amendment + Real-Time Forge State Sync (THIS SESSION)
2. **1257f7e6** - Wish: Unified MCP Startup with Auth & Tunnel (in-review, has failed attempt)

#### ✅ In-Review Tasks (5):
3. **ad076578** - Genie: install (test)
4. **a1144038** - Genie: wish (default)
5. **dafbff84** - [IMPLEMENTATION] Forge Executor Integration
6. **6644fd56** - Wish: Forge Executor Integration - Tech Council Approved
7. **c0e6699d** - Learn: Forge Orchestration + Active Monitoring + Crash Recovery Patterns

#### 📋 Todo Tasks (10):
8. **62c00eed** - Wish: Unified MCP Startup (duplicate of #1257f7e6)
9. **c5e207a8** - Wish Discovery: MCP Server Authentication (#152)
10. **c1d21957** - Wish: Unified Naming Taxonomy
11. **535a26c1** - Wish: Voice Agent Transformation
12. **22593561** - Wish: MCP Server Authentication (duplicate of c5e207a8)
13. **ab6c2576** - Wish: Investigate Forge Resource Sync
14. **28921ec5** - Task 5: Hierarchical Learn Integration
15. **89b104c1** - Task 4: Sub-Task Creation from Execution Groups
16. **5df76ebd** - Task 3: Wish Task Creation via Genie MCP
17. **0d568ea8** - Task 1: Forge Project Auto-Sync on MCP Startup

### SESSION-STATE.md Accuracy Assessment

**✅ ACCURATE SECTIONS:**
- Behavioral task organization (all 17 tasks referenced)
- Dependency graph documentation
- Critical path dependencies
- Execution wave planning

**❌ OUTDATED SECTIONS:**
- Version number (rc.33 vs rc.36+)
- "Active Forge Tasks (Monitoring)" section lists tasks as "in-progress" that are now "in-review"
- Missing current learn task (c873572f)
- Worktree count references don't match reality (50+ worktrees exist)

**🔴 MISSING SECTIONS:**
- Real-time sync mechanism documentation
- Wish-Issue linkage enforcement protocol
- Dynamic SESSION-STATE.md update strategy

---

## Deliverable 2: Full Forge Task Map

### Active Worktrees (53 total)

Based on `/var/tmp/automagik-forge/worktrees/` listing:

**Pattern Analysis:**
- Naming: `<4-char-prefix>-<kebab-case-description>/`
- Examples: `0d09-learn-wish-issue`, `8269-wish-unified-mcp`, `61b7-genie-wish-defau`
- All worktrees isolated on feature branches (forge/<prefix>-*)

**Observations:**
1. Many worktrees appear stale (no recent activity)
2. Worktree cleanup may be needed (task completion didn't trigger cleanup)
3. No automatic sync between Forge task completion → worktree deletion

### GitHub Issues Integration

**Open Issues (Top 8):**
- #152: MCP Server Authentication (HAS Forge task: c5e207a8)
- #151: Forge API 422 error (NO Forge task)
- #150: MCP server path resolution (NO Forge task)
- #148: Wrong default Forge port (NO Forge task)
- #146: Session name architecture (NO Forge task - but work done per commits)
- #145: WISH #120-C Production Adoption Kits (NO Forge task yet)
- #144: WISH #120-B Enhanced Autonomous Features (NO Forge task yet)
- #143: WISH #120-A Forge Drop-In Replacement (HAS Forge task: dafbff84)

**🔴 CRITICAL FINDING:** Many GitHub issues exist WITHOUT corresponding Forge tasks!

This validates the **"No Wish Without Issue"** amendment need.

---

## Deliverable 3: Real-Time Forge State Sync Architecture

### Problem Statement

**Current State:**
- SESSION-STATE.md is manually updated (outdated by 3 versions)
- No automatic sync when Forge tasks change state
- Git hooks only trigger on local commits (not task completion in Forge backend)
- Genie must manually query Forge API to know current state

**Impact:**
- SESSION-STATE.md becomes stale within hours
- Coordination failures (work on completed tasks, miss new tasks)
- Trust breakdown (document says one thing, reality is another)

### Proposed Solution: Forge → Genie MCP WebHook Bridge

#### Architecture Components

**1. Forge Backend Enhancement (Webhook Emission)**
```rust
// When task state changes:
POST /webhooks/genie-mcp
{
  "event": "task.status_changed",
  "task_id": "c873572f-fd95-4ea0-a0c9-cdaed1dda898",
  "old_status": "todo",
  "new_status": "in-progress",
  "timestamp": "2025-10-20T23:38:55Z",
  "project_id": "ee8f0a72-44da-411d-a23e-f2c6529b62ce"
}
```

**2. Genie MCP Server Enhancement (Webhook Receiver)**
```typescript
// In mcp-server.ts or new webhook-handler.ts
app.post('/webhooks/forge', async (req, res) => {
  const event = req.body;

  // Update SESSION-STATE.md
  await updateSessionState(event);

  // Notify active Genie sessions (if any)
  await notifyActiveSessions(event);

  res.status(200).json({ received: true });
});
```

**3. SESSION-STATE.md Auto-Update Logic**
```typescript
async function updateSessionState(event: ForgeWebhookEvent) {
  const sessionStatePath = '.genie/SESSION-STATE.md';
  const content = await fs.readFile(sessionStatePath, 'utf-8');

  // Parse markdown, find task entry
  const updated = updateTaskStatus(content, event.task_id, event.new_status);

  // Add timestamp comment
  const timestamped = addUpdateTimestamp(updated, event.timestamp);

  await fs.writeFile(sessionStatePath, timestamped);

  // Commit change (optional - auto-commit pattern)
  await git.commit(`chore(session-state): auto-update task ${event.task_id.slice(0,8)} → ${event.new_status}`);
}
```

#### Sync Triggers

**Events to sync:**
1. Task status change (todo → in-progress → in-review → done)
2. Task creation (new task added)
3. Task attempt start (execution begins)
4. Task attempt completion (execution ends)
5. Task deletion/cancellation

#### Sync Frequency

**Real-time:** WebSocket connection (preferred)
**Polling fallback:** Every 30s for active projects
**On-demand:** When Genie session starts/resumes

#### Data Consistency

**Source of truth:** Forge database
**Local cache:** SESSION-STATE.md (auto-updated)
**Conflict resolution:** Forge always wins (overwrite local)

### Implementation Phases

**Phase 1: Polling (Quick Win)**
- Genie MCP startup: fetch all tasks, update SESSION-STATE.md
- Every 30s during active session: re-fetch, update
- Manual refresh command: `mcp__genie__sync_session_state()`

**Phase 2: WebHook (Real-Time)**
- Forge emits webhooks on task changes
- Genie MCP receives webhooks
- SESSION-STATE.md updated immediately
- Optional: Notify active Claude sessions via MCP notification

**Phase 3: WebSocket (Live)**
- Persistent WebSocket connection Forge ↔ Genie MCP
- Real-time bidirectional sync
- Genie can push state changes back to Forge (e.g., wish creation)

---

## Deliverable 4: "No Wish Without Issue" Amendment

### Rule Amendment

**Original Rule (wish-initiation-rule.md):**
> All significant work must start with a wish document.

**AMENDED RULE:**
> All significant work must start with a **GitHub issue**, which then spawns a wish document.

### Enforcement Protocol

#### Step 1: Issue Check (MANDATORY)

Before creating ANY wish, Genie must:
```bash
# Check if issue exists
gh issue view <issue-number>

# If NOT exists:
# → Route to issue creation workflow
# → BLOCK wish creation until issue exists
```

#### Step 2: Issue Creation (If Missing)

If no issue exists:
1. **Ask user:** "Should I create a GitHub issue for this first?"
2. **Route to:** Genie skill for issue creation (needs discovery)
3. **Create issue** with:
   - Title: Clear, actionable summary
   - Labels: `wish`, `enhancement`, or relevant type
   - Description: Context ledger summary
   - Acceptance criteria: From wish discovery
4. **Get issue number:** Extract #XXX from GitHub response
5. **THEN proceed** to wish creation

#### Step 3: Wish-Issue Linkage

Every wish document MUST include:
```markdown
# Wish: <Title>

**GitHub Issue:** #152
**Status:** Discovery → In-Progress → Review → Done
**Created:** 2025-10-20
```

#### Step 4: Forge Task Linkage

When wish creates Forge task:
```typescript
mcp__automagik_forge__create_task({
  project_id: "ee8f0a72-...",
  title: "Wish: MCP Server Authentication (#152)", // <-- Issue number in title!
  description: `
    GitHub Issue: #152
    Wish Document: @.genie/wishes/mcp-auth/mcp-auth-wish.md

    [Full wish context here]
  `
})
```

### Why This Matters

**Problem it solves:**
1. **Traceability:** GitHub issue = permalink (survives repo moves)
2. **Team visibility:** Non-Genie users see what's planned
3. **Approval gates:** Issue can be discussed/approved before implementation
4. **Audit trail:** Issue shows full history (wish → forge → PR → merge)
5. **Search & discovery:** GitHub search finds all work (not just wishes in repo)

**What happens without it:**
- ❌ Work done in Forge, no GitHub visibility
- ❌ Wishes created, never tracked in issue system
- ❌ Team members confused (what's being worked on?)
- ❌ No approval checkpoint (work may be rejected late)

### Integration with Existing Workflows

**Wish workflow enhancement:**
```markdown
### Step 0: Issue Validation (NEW STEP)
**Goal:** Ensure GitHub issue exists

Delegate to issue-check workflow:
\`\`\`
mcp__genie__run with agent="issue-check"
\`\`\`

**What happens:**
- Check if user provided issue number
- If yes: Validate issue exists, extract context
- If no: Ask if should create issue
- Route to issue-creation if needed
- BLOCK wish creation until issue confirmed

**Output:** Issue number + "Ready for discovery?"
```

**Blueprint workflow enhancement:**
```markdown
**Wish document template:**
\`\`\`markdown
# Wish: {title}

**GitHub Issue:** #{issue_number}  <-- REQUIRED FIELD
**Forge Task:** {task_id}  <-- Auto-filled after task creation
**Status:** {status}
...
\`\`\`
```

### Skill Documentation Location

**Add to AGENTS.md:**
```markdown
### Tier 6 (Workflow & State Management):
- `@.genie/skills/wish-issue-linkage.md` (NEW)
```

**New file:** `.genie/skills/wish-issue-linkage-rule.md`
```markdown
# Rule #6: Wish-Issue Linkage (Behavioral Skill)

**CRITICAL RULE:** Every wish must link to a GitHub issue. No issue = no wish.

## What This Rule Means

Before creating ANY wish:
1. Check if GitHub issue exists
2. If NOT exists → create issue FIRST
3. Only THEN create wish document
4. Link issue # in wish front-matter

## Why This Rule Exists

- GitHub issue = source of truth (team visibility)
- Wish document = implementation plan (Genie internal)
- Forge task = execution tracking (work management)

**Hierarchy:** Issue (public) → Wish (internal) → Forge Task (execution)

[Rest of documentation...]
```

---

## Summary & Recommendations

### Immediate Actions (This Session)

1. **✅ DONE:** Validate SESSION-STATE.md accuracy
2. **✅ DONE:** Map all Forge tasks across projects
3. **✅ DONE:** Design real-time sync architecture
4. **🔄 IN PROGRESS:** Document "No Wish Without Issue" amendment

### Next Steps (Post-Session)

1. **Update SESSION-STATE.md** with:
   - Current version (rc.36+)
   - This learn task (c873572f)
   - Real-time sync architecture section
   - Wish-Issue amendment reference

2. **Create new skill file:**
   - `.genie/skills/wish-issue-linkage-rule.md`
   - Add to AGENTS.md Tier 6 references

3. **Update wish workflow:**
   - Add Step 0: Issue Validation
   - Add issue-check delegation
   - Update blueprint template

4. **Implement sync mechanism:**
   - Phase 1: Polling (quick win, this week)
   - Phase 2: WebHook (next sprint)
   - Phase 3: WebSocket (future enhancement)

### Critical Findings

**🔴 HIGH PRIORITY:**
- Many GitHub issues lack Forge tasks (work may be lost)
- SESSION-STATE.md sync is manual (error-prone)
- No enforcement of wish-issue linkage (audit trail gaps)

**🟡 MEDIUM PRIORITY:**
- Worktree cleanup needed (53 worktrees, many stale)
- Duplicate tasks exist (22593561 vs c5e207a8)
- Version drift (SESSION-STATE.md 3 versions behind)

**✅ WORKING WELL:**
- Forge task creation workflow (17 tasks tracked)
- Dependency mapping (clear execution waves)
- Behavioral task organization (Tier I/II separation)

---

## Evidence & References

**Files Analyzed:**
- `.genie/SESSION-STATE.md` (472 lines, last updated 2025-10-19)
- `AGENTS.md` (179 lines, knowledge graph included)
- `.genie/skills/wish-initiation-rule.md` (158 lines, Rule #2)
- `.genie/code/workflows/wish.md` (218 lines, wish dance orchestrator)

**Forge API Queries:**
- `list_tasks(project_id=ee8f0a72...)` → 17 tasks
- `get_task(task_id=c873572f...)` → This learn task details

**GitHub Queries:**
- `gh issue list --state all --limit 20` → 8 open, 12 closed

**Git Analysis:**
- Current branch: `forge/0d09-learn-wish-issue`
- Recent commits: f0cbf456 (executor overrides), 8b82b1ef (arch cleanup)
- Worktrees: 53 total in `/var/tmp/automagik-forge/worktrees/`

---

**Status:** Report complete, ready for review
**Next:** Update AGENTS.md with amendment, implement sync Phase 1
