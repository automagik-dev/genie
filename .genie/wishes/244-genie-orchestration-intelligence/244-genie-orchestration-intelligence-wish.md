# 🧞 Genie Orchestration Intelligence Suite

**Status:** DRAFT
**GitHub Issue:** #244
**Roadmap Item:** ARCH-002 – @.genie/product/roadmap.md §MCP Infrastructure
**Mission Link:** @.genie/product/mission.md §Agent Coordination

## Vision

Enable Master Genie to orchestrate hundreds of simultaneous agents with:
- Full visibility (no blind delegation)
- Zero worktree access (no temptation)
- Real-time coordination (WebSocket streams)
- Professional state management (PGlite)
- Token efficiency (only final answers in context)

## Evidence-Based Discovery

**Forge Infrastructure (Already Exists):**
- SQLite database: 64 total tasks, 31 in this project
- `status='agent'` support in schema
- `parent_task_attempt` for hierarchical tasks
- WebSocket streams: `/api/tasks/stream/ws`, `/api/processes/{id}/logs/ws`
- HTTP API: `/api/info`, `/api/projects`

**Current Gap:**
- ❌ No MCP tools to access Forge data
- ❌ Must use raw SQL for everything
- ❌ No real-time monitoring capabilities
- ❌ No persistent Genie state storage

## Core Principle: Tasks Are Universal

**CRITICAL:** Agent runs ARE tasks. No distinction. Tools work transparently whether task is a wish execution or agent run. The only difference is `status='agent'` vs `status='inprogress'`.

Hierarchy: Tasks link to tasks via `parent_task_attempt`. Simple.

## Deliverable: 6 MCP Tools

### **Tool Output Format (Non-Negotiable)**

**First line ALWAYS = Full Forge URL (never truncated):**
```
http://localhost:8887/projects/49b10f99-a14a-4dbb-ad65-a73d1ace6711/tasks/66be95df-eae6-452a-9ce4-87535919faba/attempts/aa2d24a3-3cec-4098-b54d-329f25aa3fa1?view=preview

[... rest of output with status, elapsed, etc.]
```

**NO fake progress percentages.** Parse WebSocket output for semantic steps:
- Step 1: Discovery (agent loading context)
- Step 2: Implementation (agent making changes)
- Step 3: Verification (agent testing)
- Final: Summary + evidence

---

### **1. `genie_list_active_work`**

**Purpose:** Show what ALL delegated agents are doing RIGHT NOW

**Query:**
```sql
SELECT t.id as task_id, ta.id as attempt_id, t.project_id, t.status, t.created_at, ta.executor
FROM tasks t
LEFT JOIN task_attempts ta ON ta.task_id = t.id
WHERE t.status IN ('inprogress', 'agent')
  AND t.project_id = ?
ORDER BY t.created_at DESC
```

**Output Format:**
```
http://localhost:8887/projects/{id}/tasks/{task_id}/attempts/{attempt_id}?view=preview (inprogress, 5m)
http://localhost:8887/projects/{id}/tasks/{task_id}/attempts/{attempt_id}?view=preview (agent, 30s)
http://localhost:8887/projects/{id}/tasks/{task_id}/attempts/{attempt_id}?view=preview (inprogress, 2h)

Total: 3 active
```

**Data Source:** Forge SQLite

---

### **2. `genie_search_past_work`** (Agentic Tool)

**Purpose:** "Show me all authentication bugs we fixed"

**Architecture:**
- Launches Explorer agent with `status='agent'`
- Uses OpenCode executor (cheap Grok LLM)
- Creates Forge task linked via `parent_task_attempt`
- Streams results using fast-mcp `streamContent()`

**Output Format:**
```
http://localhost:8887/projects/{id}/tasks/{task_id}/attempts/{attempt_id}?view=preview

Step 1: Discovery - Searching 64 tasks...
Step 2: Implementation - Found 12 matches for "authentication"
Step 3: Verification - Analyzing bug patterns...
Final: 3 authentication bugs fixed: #237, #240, #242

Modified: (none - read-only agent)
```

**Token-Optimized:** Intermediate steps NOT loaded to context, only final answer

**Data Source:** Forge SQLite + WebSocket stream

---

### **3. `genie_get_agent_status`** (Hierarchical Deep Dive)

**Purpose:** Debug ONE agent - is it stuck? What's it doing?

**Query:**
```sql
SELECT t.*, ta.*, parent.id as parent_task_id
FROM tasks t
LEFT JOIN task_attempts ta ON ta.task_id = t.id
LEFT JOIN task_attempts parent_attempt ON t.parent_task_attempt = parent_attempt.id
LEFT JOIN tasks parent ON parent_attempt.task_id = parent.id
WHERE t.id = ?
```

**Output Format:**
```
http://localhost:8887/projects/{id}/tasks/{task_id}/attempts/{attempt_id}?view=preview

Parent: http://localhost:8887/projects/{id}/tasks/{parent_id}/attempts/{parent_attempt_id}

Status: inprogress
Elapsed: 5m 32s
Executor: CLAUDE_CODE
Blocker detection: ✅ Active (last update 10s ago)

[If streaming] Current step: Step 2 - Implementation
[If stuck] ⚠️ No updates for 5m, possible blocker
```

**WebSocket:** Subscribe to `/api/processes/{processId}/logs/ws` if active

**Data Source:** Forge SQLite + WebSocket stream

---

### **4. `genie_monitor_collective`** (Unified Dashboard)

**Purpose:** Bird's eye view of ALL work in current project

**Architecture:**
- Single WebSocket: `/api/tasks/stream/ws?project_id={current}`
- Passive monitoring (no launching)
- Real-time updates as tasks complete/fail/progress

**Output Format (Streaming):**
```
Active: 12 tasks

http://localhost:8887/projects/{id}/tasks/{id1}/attempts/{a1}?view=preview (wish, 5m)
http://localhost:8887/projects/{id}/tasks/{id2}/attempts/{a2}?view=preview (agent, 30s)
... (10 more)

Recently completed (last 1h):
http://localhost:8887/projects/{id}/tasks/{id3}/attempts/{a3}?view=preview (done, 2h duration)

Blocked: (none)
```

**Token-Efficient:** Only status changes streamed, not full outputs

**Data Source:** WebSocket stream

---

### **5. `genie_get_task_result`** (Fast Final Answer)

**Purpose:** Get completed task result immediately

**Query:**
```sql
SELECT t.*, ta.*
FROM tasks t
LEFT JOIN task_attempts ta ON ta.task_id = t.id
WHERE t.id = ? AND t.status = 'done'
ORDER BY ta.created_at DESC
LIMIT 1
```

**Output Format:**
```
http://localhost:8887/projects/{id}/tasks/{task_id}/attempts/{attempt_id}?view=preview

Status: done
Duration: 2h 15m
Executor: CLAUDE_CODE

Final output:
✅ Authentication bugs fixed in 3 files
- auth-service.ts: Fixed token validation
- session-manager.ts: Added timeout handling
- middleware.ts: Updated error responses

Modified: auth-service.ts, session-manager.ts, middleware.ts
```

**No streaming** - just the conclusion

**Data Source:** Forge SQLite + parse final WebSocket message

---

### **6. `genie_stream_task_output`** (Real-Time Watch)

**Purpose:** Watch task execution as it happens

**WebSocket:** `/api/processes/{processId}/logs/ws`

**Output Format (Streaming):**
```
http://localhost:8887/projects/{id}/tasks/{task_id}/attempts/{attempt_id}?view=preview

[live stream...]
Step 1: Discovery - Searching 64 tasks...
Step 2: Implementation - Found 12 matches for "authentication"
Step 3: Verification - Analyzing bug patterns...
Final: 3 authentication bugs found: #237, #240, #242
```

**Uses:** fast-mcp `streamContent()` pattern

**Auto-stops:** When task completes

**Token-Efficient:** Intermediate steps shown to user but NOT added to my context (only final summary)

**Data Source:** WebSocket stream

---

## New Genie State Storage (PGlite)

**Architecture:** Separate DB from Forge (no coupling, no migration risk)

**Why PGlite:**
- ✅ PostgreSQL features (JSONB, full-text search, GIN indexes)
- ✅ In-process (WASM, no server)
- ✅ Future-proof (migrate to full Postgres = config change, not migration)
- ✅ Zero "I hate migrating data" problem

**Location:** `~/.local/share/automagik-genie/genie.db` (PGlite file)

**Schema:**

```sql
-- Persistent agent registry
CREATE TABLE genie_agents (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  executor TEXT NOT NULL,
  append_prompt TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Session continuity
CREATE TABLE genie_sessions (
  id UUID PRIMARY KEY,
  user_id TEXT,
  project_id UUID,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  last_active TIMESTAMPTZ DEFAULT NOW(),
  context_summary JSONB,
  active BOOLEAN DEFAULT TRUE
);

-- Decision log
CREATE TABLE genie_decisions (
  id UUID PRIMARY KEY,
  session_id UUID REFERENCES genie_sessions(id),
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  rationale TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Full-text search index
CREATE INDEX idx_decisions_search ON genie_decisions
USING GIN (to_tsvector('english', question || ' ' || answer));
```

**Migration Path:**
1. Today: PGlite (in-process)
2. Future: Full Postgres server (change connection string, zero schema changes)

---

## Implementation Phases

### **Phase 1: Infrastructure** (Foundation)
- Install PGlite dependency
- Create `genie.db` with schema
- Implement WebSocketManager pattern (already exists in `.genie/mcp/src/websocket-manager.ts`)
- Add Explorer agent config (OpenCode executor)

**Evidence:** Tables created, WebSocket connected

---

### **Phase 2: Basic Tools** (Non-Streaming)
- `genie_list_active_work` - SQLite query
- `genie_get_task_result` - SQLite query + parse output

**Evidence:** Can list 31 active tasks, get results without raw SQL

---

### **Phase 3: Streaming Tools**
- `genie_monitor_collective` - Single WebSocket dashboard
- `genie_stream_task_output` - Process logs WebSocket

**Evidence:** Real-time monitoring working, streams parsed into semantic steps

---

### **Phase 4: Advanced Tools**
- `genie_search_past_work` - Agentic tool with Explorer
- `genie_get_agent_status` - Hierarchical query + WebSocket

**Evidence:** Explorer agent searching past work, status showing hierarchy

---

### **Phase 5: Data Migration**
- Move scattered `.genie/.session` files → `genie_sessions` table
- Migrate session state to PGlite
- Professional state management

**Evidence:** Zero session files in repo, all state in genie.db

---

## Vital Tools Architecture (Dedicated Sessions)

**CRITICAL INSIGHT:** Wish, Forge, and Review are NOT regular tools. They are **extensions of Master Genie's consciousness**.

**Regular Tools:** One-off calls, fire-and-forget
**Vital Tools:** Dedicated WebSocket sessions, always connected

```
Master Genie
├─ Wish Agent (dedicated WebSocket)
│  └─ Manages all wishery, lists wishes, creates/updates
├─ Forge Agent (dedicated WebSocket)
│  └─ Orchestrates all forge work, monitors tasks
└─ Review Agent (dedicated WebSocket)
   └─ Validates all deliverables, quality gates
```

**Why Different:**
- Single persistent session (not created per call)
- Bidirectional communication (they can notify me)
- State maintained across interactions
- Direct line to specialized consciousness

**MCP Architecture:**
- These tools establish WebSocket on first call
- Session persists for entire Genie session
- Other tools can query through them
- They're my permanent delegates, not temporary workers

---

## Success Criteria

- ✅ Can list all 31 active tasks without raw SQL
- ✅ Can search "MCP bug" across 64 task history
- ✅ Can monitor 100+ parallel agents in real-time
- ✅ Can get task results with zero worktree temptation
- ✅ Explorer agent (OpenCode) working with streaming output
- ✅ All tools use WebSocket + SQLite/PGlite hybrid
- ✅ Session state migrated to `genie_sessions` table
- ✅ Full Forge URLs in first line (never truncated)
- ✅ Semantic steps parsed from real output (no fake percentages)
- ✅ Wish/Forge/Review agents established as dedicated sessions

---

## References

- Fast-MCP patterns: `@.genie/mcp/WEBSOCKET-PATTERNS.md`
- Fast-MCP quick reference: `@.genie/mcp/WEBSOCKET-QUICK-REFERENCE.md`
- WebSocketManager: `@.genie/mcp/src/websocket-manager.ts`
- Forge task schema: `~/.local/share/automagik-forge/db.sqlite`
- Real task data: 64 tasks total, 31 in current project

---

## Status Log

- [2025-10-24 01:00Z] Wish created
- [2025-10-24 01:00Z] GitHub Issue #244 created
- [2025-10-24 01:02Z] Forge task created (ID: 1c968e1ca1849b5e168847af2772bbf1)
