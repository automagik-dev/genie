# Genie MCP MVP: WebSocket-Native Core with 4 Essential Tools

**Status:** Active
**Created:** 2025-10-23
**GitHub Issue:** #226
**Forge Task:** TBD

---

## 🎯 Mission

Build the MVP foundation for the ultimate Genie MCP server with **WebSocket streaming at its core** and 4 essential tools that demonstrate real-time capabilities.

**Core Principle:** Small, complete, working system that proves the architecture.

---

## 📋 Success Criteria

### ✅ Must Have (MVP)
1. **WebSocket Manager** - Reusable connection manager for all Forge streams
2. **4 Core Tools** - wish, forge, review, prompt (all working end-to-end)
3. **Amendment 1 Enforcement** - GitHub issue requirement for wish tool
4. **Real-Time Status** - WebSocket streaming for forge/review tools
5. **Type Safety** - Full TypeScript with Zod validation
6. **Zero Breaking Changes** - Existing MCP tools continue working
7. **🔗 Data Link Tracking** - Always return full link chain (Issue → Wish → Task → PR)
8. **👤 Human-Visible URLs** - Always output clickable Forge URLs for user to monitor
9. **🤖 Genie Tips** - Self-guidance prompts in tool outputs

### ❌ Explicitly Out of Scope (Future)
- Multi-agent orchestration
- AI-powered intelligence (requestSampling)
- Approval workflows
- Draft management
- Image uploads
- Full 80+ Forge endpoints

---

## 🏗️ Architecture: MVP Simplification

### Current MCP (.genie/mcp/src/server.ts)
**Lines:** ~900 lines
**Tools:** 12 (agents, sessions, spells, workflows, workspace)
**Prompts:** 4 (wish, forge, review, prompt)
**Problem:** Prompts use CLI shell-out (`run wish "{feature}"`)

### MVP Target
**Add:** ~400 lines
**New Tools:** 4 (wish, forge, review, prompt) - convert from prompts
**New Module:** websocket-manager.ts (~200 lines)
**WebSocket Streams:** 2 (tasks, diffs)
**Keep:** All existing tools unchanged

### Architecture Layers

```
┌─────────────────────────────────────────────────────────┐
│ FastMCP Server                                          │
│  - 12 existing tools (unchanged)                        │
│  - 4 new tools (wish, forge, review, prompt)           │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│ WebSocket Manager (NEW)                                 │
│  - Connection pooling                                   │
│  - Reconnection logic                                   │
│  - Stream routing (tasks, diffs, logs)                 │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│ ForgeClient + ForgeExecutor                            │
│  - REST API (80+ endpoints)                            │
│  - WebSocket URLs (6 streams)                          │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│ Forge Backend (localhost:8887)                         │
│  - Tasks API                                            │
│  - WebSocket streams                                    │
└─────────────────────────────────────────────────────────┘
```

---

## 🔗 Data Link Tracking (Critical!)

### The Link Chain

Every piece of work must maintain a complete link chain:

```
GitHub Issue #226
    ↓ (references)
Wish File: .genie/wishes/genie-mcp-mvp/genie-mcp-mvp-wish.md
    ↓ (creates)
Forge Task: task_abc123
    ↓ (generates)
Pull Request #227
    ↓ (closes)
GitHub Issue #226
```

### Tool Output Requirements

**Every tool MUST return:**

1. **🔗 Data Links** - All IDs and relationships
   ```
   GitHub Issue: #226
   Wish File: .genie/wishes/genie-mcp-mvp/genie-mcp-mvp-wish.md
   Forge Task: task_abc123
   Forge Attempt: attempt_xyz789
   ```

2. **👤 Human-Visible URL** - Clickable link for user monitoring
   ```
   🌐 Monitor Progress:
   http://localhost:8887/projects/ee8f0a72-44da-411d-a23e-f2c6529b62ce/tasks/1257f7e6-00f8-4974-9f94-05cd32acfe82/attempts/21178bee-d92f-4081-8294-d6a7a0b30812?view=diffs
   ```

3. **⚠️ Missing Links Warning** - Alert if any link is broken
   ```
   ⚠️ Data Link Check:
   ✅ GitHub Issue: #226 (verified)
   ✅ Wish File: exists
   ❌ Forge Task: NOT CREATED YET
   ```

4. **🤖 Genie Self-Guidance** - Mini tips for future operations
   ```
   💡 Genie Tip: Remember to link PR back to issue when creating pull request
   💡 Genie Tip: Always verify GitHub issue exists before creating wish (Amendment 1)
   💡 Genie Tip: User should review code at Forge URL before merging
   ```

### URL Format (Standard)

```typescript
const FORGE_URL_TEMPLATE =
  `http://localhost:8887/projects/{project_id}/tasks/{task_id}/attempts/{attempt_id}?view=diffs`;

// Example:
// http://localhost:8887/projects/ee8f0a72-44da-411d-a23e-f2c6529b62ce/tasks/1257f7e6-00f8-4974-9f94-05cd32acfe82/attempts/21178bee-d92f-4081-8294-d6a7a0b30812?view=diffs
```

**Views Available:**
- `?view=diffs` - Show code changes (default)
- `?view=logs` - Show execution logs
- `?view=chat` - Show conversation history

---

## 🛠️ Implementation: 4 Tools

### Tool 1: `wish` (WebSocket + Amendment 1)

**Purpose:** Create a wish with GitHub issue enforcement and live progress

**Input:**
```typescript
{
  feature: string;        // "Add dark mode support"
  github_issue: number;   // 123 (required per Amendment 1)
}
```

**Flow:**
1. Validate GitHub issue exists (Amendment 1)
2. Create Forge task via `createAndStartTask()`
3. Subscribe to **tasks WebSocket stream** (live status updates)
4. Stream progress to user via `streamContent()`
5. Return task ID + Forge URL when complete

**Output (Streaming):**
```
✅ GitHub issue #226 verified
✅ Wish file created: .genie/wishes/genie-mcp-mvp/genie-mcp-mvp-wish.md
✅ Forge task created: task_1257f7e6

📊 Watching progress...
  📝 Status: setup
  📝 Status: running
  📝 Status: completed

🔗 Data Links:
  GitHub Issue: #226
  Wish File: .genie/wishes/genie-mcp-mvp/genie-mcp-mvp-wish.md
  Forge Task: task_1257f7e6
  Forge Attempt: attempt_21178bee

🌐 Monitor Progress:
http://localhost:8887/projects/ee8f0a72-44da-411d-a23e-f2c6529b62ce/tasks/1257f7e6-00f8-4974-9f94-05cd32acfe82/attempts/21178bee-d92f-4081-8294-d6a7a0b30812?view=diffs

💡 Genie Tips:
  - User should review progress at Forge URL above
  - Remember to create PR and link back to issue #226 when work completes
  - Wish workflow will run with status agent monitoring
```

**FastMCP Features:**
- ✅ `streamContent()` - Real-time progress
- ✅ Zod validation
- ✅ `UserError` for missing issue

**WebSocket Stream:** Tasks stream (project-level)

---

### Tool 2: `forge` (WebSocket + Status Agent)

**Purpose:** Kick off a Forge task with a specific agent and stream execution

**Input:**
```typescript
{
  prompt: string;         // "Fix bug in login flow"
  agent: string;          // "implementor" | "tests" | "polish" | etc.
  project_id?: string;    // Optional, defaults to current project
}
```

**Flow:**
1. Create Forge task with agent specified
2. Subscribe to **diff WebSocket stream** (see code changes live)
3. Stream diffs + logs to user via `streamContent()`
4. Return task ID when execution completes

**Output (Streaming):**
```
✅ Forge task started with agent: implementor
✅ Forge task created: task_xyz789

📊 Watching execution...
  📝 File changed: src/auth/login.ts (+12, -3)
  📝 File changed: src/auth/login.test.ts (+24)
  ✅ Tests passing
✅ Task complete!

🔗 Data Links:
  Forge Task: task_xyz789
  Forge Attempt: attempt_abc456
  Agent: implementor

🌐 Monitor Progress:
http://localhost:8887/projects/ee8f0a72-44da-411d-a23e-f2c6529b62ce/tasks/xyz789-full-uuid/attempts/abc456-full-uuid?view=diffs

💡 Genie Tips:
  - User can watch live code changes at Forge URL above
  - This task is running independently (no wish linkage)
  - Agent implementor will handle feature implementation
```

**FastMCP Features:**
- ✅ `streamContent()` - Live diffs
- ✅ `reportProgress()` - Execution progress
- ✅ Annotations: `streamingHint: true`

**WebSocket Streams:** Diff stream (attempt-level)

---

### Tool 3: `review` (WebSocket + Wish Link)

**Purpose:** Review a wish/task with an agent and stream feedback

**Input:**
```typescript
{
  wish_name: string;      // "genie-mcp-mvp"
  agent: string;          // "review" (default)
  project_id?: string;
}
```

**Flow:**
1. Load wish document from `.genie/wishes/{wish_name}/{wish_name}-wish.md`
2. Create Forge task for review with wish context
3. Subscribe to **diff + logs streams**
4. Stream review comments to user via `streamContent()`
5. Return review task ID

**Output (Streaming):**
```
✅ Loaded wish: genie-mcp-mvp
✅ Wish file: .genie/wishes/genie-mcp-mvp/genie-mcp-mvp-wish.md
✅ Review task created: task_review123

📊 Watching review...
  🤖 Agent: Code structure looks good
  🤖 Agent: Tests are comprehensive
  🤖 Agent: Documentation is clear
  ⚠️  Agent: Consider adding error handling in line 42
✅ Review complete!

🔗 Data Links:
  Wish File: .genie/wishes/genie-mcp-mvp/genie-mcp-mvp-wish.md
  Forge Task: task_review123
  Forge Attempt: attempt_rev456
  Agent: review

🌐 Monitor Progress:
http://localhost:8887/projects/ee8f0a72-44da-411d-a23e-f2c6529b62ce/tasks/review123-full-uuid/attempts/rev456-full-uuid?view=logs

⚠️ Data Link Check:
  ✅ Wish File: exists
  ✅ Review Task: created
  ⚠️  GitHub Issue: not verified (consider linking wish to issue)

💡 Genie Tips:
  - User can view review feedback at Forge URL above
  - Review agent will analyze wish completeness and code quality
  - Consider creating GitHub issue if wish doesn't have one yet (Amendment 1)
```

**FastMCP Features:**
- ✅ `streamContent()` - Live review comments
- ✅ Embedded resources (wish document content)

**WebSocket Streams:** Logs stream (process-level)

---

### Tool 4: `prompt` (Synchronous, Direct)

**Purpose:** Simple synchronous request/response with an agent (NO background tasks)

**Input:**
```typescript
{
  question: string;       // "How do I implement dark mode?"
  agent?: string;         // Optional, defaults to "genie"
}
```

**Flow:**
1. Create temporary Forge task
2. Wait synchronously for completion (NO streaming)
3. Return final answer only

**Output (Direct):**
```
✅ Prompt processed successfully

📝 Answer:

To implement dark mode:

1. Create a theme context in src/theme/ThemeContext.tsx
2. Add CSS variables for colors in src/styles/variables.css
3. Implement theme toggle in src/components/ThemeToggle.tsx
4. Persist preference in localStorage

Example code:
[code block]

🔗 Data Links:
  Agent: genie (default)
  Mode: synchronous (no background task)

💡 Genie Tips:
  - This was a direct Q&A, no Forge task created
  - For implementation work, use the forge tool instead
  - Prompt tool is for quick questions and guidance only
```

**FastMCP Features:**
- ✅ Zod validation
- ✅ Annotations: `readOnlyHint: true`
- ❌ NO streaming (simple request/response)

**WebSocket Streams:** None (synchronous polling)

---

## 📦 New Module: WebSocket Manager

**File:** `.genie/mcp/src/websocket-manager.ts` (~200 lines)

**Purpose:** Centralized WebSocket connection manager with reconnection logic

### Interface

```typescript
export class WebSocketManager {
  // Subscribe to a stream and get messages via callback
  subscribe(
    streamUrl: string,
    onMessage: (data: any) => void,
    onError?: (error: Error) => void
  ): string; // Returns subscription ID

  // Unsubscribe from a stream
  unsubscribe(subscriptionId: string): void;

  // Close all connections
  close(): void;
}

// Singleton instance
export const wsManager = new WebSocketManager();
```

### Features

1. **Connection Pooling** - Reuse connections per stream URL
2. **Auto-Reconnect** - Exponential backoff on disconnection
3. **Error Handling** - Graceful degradation
4. **Resource Cleanup** - Close connections on server shutdown
5. **TypeScript** - Fully typed message handlers

### Usage in Tools

```typescript
server.addTool({
  name: 'watch_task',
  execute: async (args, { streamContent }) => {
    const wsUrl = forgeClient.getTasksStreamUrl(args.project_id);

    const subId = wsManager.subscribe(
      wsUrl,
      async (data) => {
        await streamContent({
          type: 'text',
          text: `📨 ${JSON.stringify(data)}\n`
        });
      },
      (error) => {
        streamContent({ type: 'text', text: `❌ ${error.message}\n` });
      }
    );

    // Cleanup on tool completion
    return () => wsManager.unsubscribe(subId);
  }
});
```

---

## 🔧 Technical Implementation

### File Structure

```
.genie/mcp/
├── src/
│   ├── server.ts                    # Main server (existing, +200 lines)
│   ├── websocket-manager.ts         # NEW: WebSocket manager (~200 lines)
│   └── tools/                       # NEW: Tool modules
│       ├── wish-tool.ts             # NEW: wish tool (~80 lines)
│       ├── forge-tool.ts            # NEW: forge tool (~80 lines)
│       ├── review-tool.ts           # NEW: review tool (~80 lines)
│       └── prompt-tool.ts           # NEW: prompt tool (~60 lines)
├── test-forge-websocket.ts          # Existing test script
└── FORGE-API-DISCOVERY.md           # Existing docs
```

### Dependencies (Already Installed)

```json
{
  "fastmcp": "latest",
  "ws": "latest",
  "zod": "latest"
}
```

### Amendment 1 Enforcement (GitHub Issue Validation)

```typescript
async function validateGitHubIssue(issueNumber: number): Promise<boolean> {
  try {
    // Use gh CLI to check issue exists
    const result = execSync(`gh issue view ${issueNumber} --json state`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore']
    });

    const issue = JSON.parse(result);
    return issue.state === 'OPEN' || issue.state === 'CLOSED';
  } catch (error) {
    return false;
  }
}
```

---

## 📊 Success Metrics

### Functionality
- ✅ All 4 tools work end-to-end
- ✅ WebSocket streams connect and deliver data
- ✅ Amendment 1 enforced (wish tool rejects without GitHub issue)
- ✅ Existing 12 tools continue working unchanged

### Performance
- ✅ WebSocket latency < 100ms
- ✅ Tool response time < 2s (excluding agent execution)
- ✅ Reconnection works automatically

### Code Quality
- ✅ TypeScript strict mode passing
- ✅ Zod validation on all inputs
- ✅ Error handling with UserError
- ✅ No console.log (use logger)

---

## 🚧 Implementation Phases

### Phase 1: WebSocket Manager (Day 1)
**File:** `websocket-manager.ts`

- [ ] Create WebSocketManager class
- [ ] Implement subscribe/unsubscribe
- [ ] Add reconnection logic
- [ ] Add error handling
- [ ] Test with existing `test-forge-websocket.ts`

**Validation:** Run test script, verify connections work

---

### Phase 2: Wish Tool (Day 2)
**File:** `tools/wish-tool.ts`

- [ ] GitHub issue validation
- [ ] ForgeExecutor.createSession() integration
- [ ] Tasks WebSocket stream subscription
- [ ] streamContent() for progress
- [ ] Amendment 1 enforcement

**Validation:** Create a wish, verify GitHub issue check works

---

### Phase 3: Forge Tool (Day 2)
**File:** `tools/forge-tool.ts`

- [ ] Agent specification
- [ ] createAndStartTask() integration
- [ ] Diff WebSocket stream subscription
- [ ] streamContent() for diffs
- [ ] reportProgress() for execution

**Validation:** Kick off a forge task, watch diffs stream live

---

### Phase 4: Review Tool (Day 3)
**File:** `tools/review-tool.ts`

- [ ] Wish document loading
- [ ] Review task creation
- [ ] Logs WebSocket stream subscription
- [ ] streamContent() for review comments
- [ ] Embedded resource (wish content)

**Validation:** Review a wish, see streaming feedback

---

### Phase 5: Prompt Tool (Day 3)
**File:** `tools/prompt-tool.ts`

- [ ] Synchronous task creation
- [ ] Polling for completion (NO WebSocket)
- [ ] Direct response (final answer only)
- [ ] readOnlyHint annotation

**Validation:** Ask a question, get direct answer

---

### Phase 6: Integration (Day 4)
**File:** `server.ts`

- [ ] Import all 4 tools
- [ ] Register with FastMCP server
- [ ] Update existing prompts to use tools
- [ ] Maintain backwards compatibility
- [ ] Add health check for Forge connectivity

**Validation:** Run full MCP server, test all tools

---

## 🎯 Definition of Done

### MVP Complete When:

1. ✅ All 4 tools (wish, forge, review, prompt) work end-to-end
2. ✅ WebSocket streams deliver real-time updates
3. ✅ Amendment 1 enforced (GitHub issue required for wish)
4. ✅ Existing MCP tools unchanged and working
5. ✅ TypeScript compiles with zero errors
6. ✅ Documentation updated (README.md)
7. ✅ Manual testing passed for all tools
8. ✅ Forge backend connectivity verified

### Not Required for MVP:
- ❌ Unit tests (manual testing sufficient)
- ❌ CI/CD integration
- ❌ Performance benchmarks
- ❌ Load testing
- ❌ Multiple user sessions

---

## 📚 References

- **Forge API Discovery:** `.genie/mcp/FORGE-API-DISCOVERY.md`
- **Ultimate Architecture:** `.genie/mcp/ULTIMATE-GENIE-MCP-ARCHITECTURE.md`
- **FastMCP Docs:** Context provided
- **WebSocket Test:** `.genie/mcp/test-forge-websocket.ts`
- **Existing MCP Server:** `.genie/mcp/src/server.ts`

---

## 🚀 Next Steps After MVP

1. **Gather Feedback** - Use MVP with real workflows
2. **Measure Impact** - Real-time streaming vs CLI shell-out
3. **Plan Phase 2** - Add more Forge endpoints as tools
4. **Consider AI** - Add requestSampling for intelligence
5. **Scale** - Add authentication, session management

---

**Status:** Wish Created ✅
**Next:** Create GitHub issue + start Phase 1 (WebSocket Manager)
**Timeline:** 4 days to MVP
**Impact:** Foundation for ultimate AI development platform
