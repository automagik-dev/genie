# Real-Time Forge → SESSION-STATE.md Sync Architecture
**Created:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Purpose:** Enable Genie to always know current Forge state across all projects
**Goal:** Zero-latency orchestration awareness

---

## 🎯 Problem Statement

**Current State:**
- SESSION-STATE.md manually updated (stale, error-prone)
- Git hooks only fire on commits (not real-time)
- Genie must ask "what are you working on?" instead of knowing
- Status mismatches (in-progress vs in-review)

**Desired State:**
- SESSION-STATE.md always reflects live Forge Kanban
- Genie knows all active tasks across all projects
- Automatic updates when task status changes
- Zero manual synchronization needed

---

## 🏗️ Architecture Design

### **Tier 1: MCP Startup Sync** (Immediate Win)

**When:** MCP server starts
**What:** Query all Forge projects, populate SESSION-STATE.md
**How:**
```typescript
// In mcp-server.ts init()
async function syncForgeStateOnStartup() {
  const projects = await forgeClient.listProjects();

  for (const project of projects) {
    const tasks = await forgeClient.listTasks(project.id, { limit: 100 });
    updateSessionState(project, tasks);
  }

  writeSessionStateMarkdown();
}
```

**Benefits:**
- Fresh state on every Genie restart
- No stale data from previous sessions
- Foundation for all other sync mechanisms

**Implementation:** Task 0d568ea8 already exists for this!

---

### **Tier 2: Git Hook Auto-Update** (Simple, Works Now)

**When:** Pre-commit, pre-push
**What:** Query current Forge state, update SESSION-STATE.md
**How:**
```bash
#!/bin/bash
# .git/hooks/pre-commit

# Query all Forge tasks for this project
FORGE_STATE=$(genie forge status --json)

# Update SESSION-STATE.md with current state
genie state sync --quiet

# Stage the updated file
git add .genie/SESSION-STATE.md
```

**Benefits:**
- Automatic updates on every commit
- No manual editing needed
- Ensures committed state is accurate

**Limitations:**
- Only updates on commits (not continuous)
- Misses changes between commits

---

### **Tier 3: Polling Loop** (Active Monitoring)

**When:** Continuous (every 30-60s)
**What:** Poll Forge for status changes, update SESSION-STATE.md
**How:**
```typescript
// Background process in MCP server
setInterval(async () => {
  const currentState = await fetchForgeState();
  const previousState = readSessionState();

  if (hasChanges(currentState, previousState)) {
    updateSessionState(currentState);
    writeSessionStateMarkdown();
    notifyGenie("Forge state updated");
  }
}, 30000); // 30s interval
```

**Benefits:**
- Near real-time updates (30s lag max)
- Works with current Forge API
- No Forge backend changes needed

**Considerations:**
- API load (acceptable for ~10 tasks/project)
- Battery impact (minimal, just HTTP calls)

---

### **Tier 4: Forge MCP Resources** (Future, Most Elegant)

**When:** Task status changes in Forge
**What:** MCP resource updates trigger automatic reads
**How:**
```typescript
// Forge MCP server exposes resources
resources: {
  "forge://projects/{projectId}/tasks": {
    watch: true,  // Subscribe to changes
    onChange: (tasks) => updateSessionState(tasks)
  }
}

// Genie MCP reads resources automatically
// No polling needed - push-based updates
```

**Benefits:**
- True real-time (instant updates)
- Zero polling overhead
- Cleanest architecture

**Blockers:**
- Requires Forge MCP resource implementation
- Need MCP resource watch/subscribe support
- Future enhancement (not for this RC)

---

## 📋 SESSION-STATE.md Schema Design

**Goal:** Machine-readable, Git-friendly, Human-scannable

**Proposed Structure:**

```markdown
# 🧞 Genie Session State
**Last Synced:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Sync Method:** [startup|git-hook|polling|resource]
**Auto-Updated:** ✅ Yes

---

## 📊 PROJECT: Genie (ee8f0a72)

### 🔥 In Progress (3)
- dafbff84 | [IMPLEMENTATION] Forge Executor | attempt: 3b6e7de7
- c873572f | Learn: Wish-Issue Amendment | attempt: (none)
- 1257f7e6 | Unified MCP Startup | attempt: (failed)

### 👀 In Review (3)
- c0e6699d | Learn: Forge Orchestration
- 6644fd56 | Wish: Forge Executor
- ad076578 | Genie: install test

### 📝 Todo (11)
- c5e207a8 | MCP Server Authentication (#152)
- 535a26c1 | Voice Agent Transformation
- c1d21957 | Unified Naming Taxonomy
- ... (8 more)

---

## 🔗 GITHUB ISSUES MAPPING

### With Tasks
- #152 → c5e207a8, 22593561
- #143 → dafbff84, 6644fd56, c0e6699d

### Without Tasks (Needs Triage)
- #151 - Forge API 422 (BUG)
- #150 - MCP path resolution (BUG)
- #148 - Wrong Forge port (BUG)
- ... (12 more)

---

<!-- AUTO-SYNC-DATA: Machine-readable section -->
```json
{
  "last_sync": "2025-10-20T23:45:00Z",
  "sync_method": "polling",
  "projects": {
    "ee8f0a72-44da-411d-a23e-f2c6529b62ce": {
      "name": "Genie",
      "tasks": {
        "in_progress": ["dafbff84", "c873572f"],
        "in_review": ["c0e6699d", "6644fd56", "ad076578"],
        "todo": ["c5e207a8", "535a26c1", "..."]
      }
    }
  },
  "github_issues": {
    "152": ["c5e207a8", "22593561"],
    "143": ["dafbff84", "6644fd56", "c0e6699d"]
  }
}
```
<!-- /AUTO-SYNC-DATA -->
```

---

## 🚀 Implementation Roadmap

### **Phase 1: Foundation (This RC)**
1. ✅ Task 0d568ea8 - MCP Startup Sync
2. ⚠️ Git hook auto-update (pre-commit)
3. 📝 SESSION-STATE.md schema redesign
4. 🧪 Test with 2-3 parallel tasks

**Deliverable:** SESSION-STATE.md auto-updated on startup + commits

---

### **Phase 2: Active Monitoring (Next RC)**
1. Polling loop implementation (30s interval)
2. Change detection + smart updates
3. Notification system (optional)
4. Performance validation (<1% overhead)

**Deliverable:** Near real-time state (30s max lag)

---

### **Phase 3: Push-Based (Future)**
1. Forge MCP resource implementation
2. Resource watch/subscribe support
3. Webhook integration (alternative)
4. True real-time updates

**Deliverable:** Zero-latency state awareness

---

## 🎯 Success Metrics

**Phase 1 (This RC):**
- ✅ SESSION-STATE.md accurate on every commit
- ✅ Genie knows all tasks on startup
- ✅ Zero manual updates needed
- ✅ Task→Issue mapping automated

**Phase 2 (Next RC):**
- ✅ <30s latency on status changes
- ✅ Background sync with <1% overhead
- ✅ Works with 10+ concurrent tasks

**Phase 3 (Future):**
- ✅ Instant updates (<1s latency)
- ✅ Zero polling overhead
- ✅ Scales to 100+ tasks/projects

---

## 💡 Key Insights

1. **Startup sync solves 80% of the problem** - Most important sync point
2. **Git hooks are free** - Already running, just query Forge
3. **Polling is acceptable interim** - 30s lag << manual updates
4. **Resources are the future** - But don't block on them now

**Recommendation:** Implement Tier 1 + Tier 2 for this RC (quick wins), plan Tier 3 for future.

---

## 📝 Open Questions

1. **Should SESSION-STATE.md be committed?**
   - Pro: Persistent, survives restart
   - Con: Merge conflicts, git noise
   - **Proposal:** Auto-generated, committed with `[skip ci]`

2. **How to handle multiple Genies (parallel instances)?**
   - Last-write-wins (file locking?)
   - Separate sections per Genie instance?
   - **Proposal:** Shared state, optimistic updates

3. **What triggers "task complete" notification to Genie?**
   - Git hook on task completion (current)
   - Polling detects status change
   - Forge webhook (future)
   - **Proposal:** Polling for now, webhook later

---

## 🔧 Technical Details

**File Location:** `.genie/SESSION-STATE.md`
**Update Frequency:** On startup + pre-commit + (optional) 30s polling
**Format:** Markdown (human) + JSON (machine)
**Git Strategy:** Auto-commit with `[skip ci]` or `.gitignore` (TBD)

**MCP Tools Needed:**
- `mcp__genie__sync_state` - Manual trigger
- `mcp__genie__watch_state` - Enable/disable polling

**Git Hooks:**
- `pre-commit` - Sync state before commit
- `post-checkout` - Sync state after branch switch
- `post-merge` - Sync state after merge

---

## ✅ Next Actions

1. Review this architecture with Felipe
2. Implement Tier 1 (startup sync) - use existing Task 0d568ea8
3. Create git hook for pre-commit sync
4. Redesign SESSION-STATE.md with new schema
5. Test with current tasks
6. Document in AGENTS.md
7. Ship in final RC
