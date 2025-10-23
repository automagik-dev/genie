# Ultimate Genie MCP Architecture
## The Most Powerful AI Development Platform Ever Built

**Date:** 2025-10-23
**Vision:** Combine ALL Forge API capabilities (80+ endpoints + 6 WebSocket streams) with ALL FastMCP features (28+ capabilities) to create the definitive AI-powered development MCP server.

---

## 🎯 Core Philosophy

**"Every Forge capability as a real-time, streaming, AI-enhanced MCP tool"**

- **Real-Time Everything:** WebSocket streaming for live feedback
- **AI-First:** RequestSampling for intelligent assistance
- **Session-Aware:** Per-user state and preferences
- **Fully Typed:** Complete TypeScript safety
- **Production-Ready:** Authentication, monitoring, health checks

---

## 📊 Complete Capability Matrix

### Forge API: 80+ Endpoints Across 12 Categories

1. **Health & System** (2 endpoints)
   - Health check
   - System info

2. **Authentication** (3 endpoints)
   - GitHub OAuth device flow (start, poll, check)

3. **Configuration** (6 endpoints)
   - User config, executor profiles, MCP config, notification sounds

4. **Projects** (7 endpoints)
   - CRUD, branches, file search, editor integration

5. **Tasks** (6 endpoints)
   - CRUD, create-and-start (all-in-one)

6. **Task Attempts** (19 endpoints)
   - Execution, follow-ups, branch operations, PR creation, commits

7. **Drafts** (4 endpoints)
   - Save, load, delete, queue for execution

8. **Execution Processes** (3 endpoints)
   - List, get, stop

9. **Task Templates** (5 endpoints)
   - CRUD for reusable task definitions

10. **Images** (5 endpoints)
    - Upload, associate with tasks, retrieve

11. **Approvals** (4 endpoints)
    - Create, status, respond, list pending

12. **Filesystem** (2 endpoints)
    - Directory browsing, git repo discovery

### Forge WebSocket: 6 Real-Time Streams

1. **Tasks Stream** (`/api/tasks/stream/ws?project_id={id}`)
   - Real-time task updates (create, update, status changes)
   - JSON Patch format

2. **Execution Processes Stream** (`/api/execution-processes/stream/ws?task_attempt_id={id}`)
   - Process status updates (running, paused, completed, failed)

3. **Raw Logs Stream** (`/api/execution-processes/{id}/raw-logs/ws`)
   - Live stdout/stderr from execution processes

4. **Normalized Logs Stream** (`/api/execution-processes/{id}/normalized-logs/ws`)
   - Parsed, structured log messages

5. **Diff Stream** (`/api/task-attempts/{id}/diff/ws?stats_only={bool}`)
   - **File changes as they happen** - The killer feature
   - Real-time code diffs

6. **Drafts Stream** (`/api/drafts/stream/ws?project_id={id}`)
   - Draft save/update/queue events

### FastMCP: 28+ Capabilities

#### Core (5)
1. **Tools** - Function execution
2. **Resources** - Static data access
3. **Resource Templates** - Parameterized resources
4. **Prompts** - Reusable templates
5. **Embedded Resources** - Include in responses

#### Advanced (23)
6. **Authentication** - OAuth + custom auth
7. **Tool Authorization** - Per-tool access control
8. **Sessions** - Stateful clients
9. **Session ID tracking** - Per-session state
10. **Request ID tracking** - Request tracing
11. **Progress notifications** - reportProgress()
12. **Streaming output** - streamContent()
13. **Logging** - log.info/debug/error/warn
14. **Image content** - imageContent()
15. **Audio content** - audioContent()
16. **Typed events** - server.on()
17. **Session events** - session.on()
18. **Sampling** - session.requestSampling()
19. **Client capabilities** - Introspection
20. **Roots management** - Filesystem roots
21. **HTTP Streaming** - SSE + HTTP
22. **Stateless mode** - Serverless
23. **Health checks** - /health endpoint
24. **Ping configuration** - Keep-alive
25. **Custom logger** - Winston/Pino
26. **Tool annotations** - Hints for AI
27. **Argument auto-completion** - For prompts/resources
28. **Error handling** - UserError

---

## 🏗️ Architecture: 7 Layers

### Layer 1: Real-Time Task Intelligence
**Purpose:** Live task monitoring and management with WebSocket streaming

**Tools:**
- `watch_tasks` - Subscribe to task stream (streamContent + WebSocket)
- `create_wish` - Create wish with Amendment 1 enforcement (GitHub issue required)
- `start_task` - Start task execution
- `get_task` - Fetch task details
- `list_tasks` - List all project tasks
- `update_task` - Modify task metadata
- `delete_task` - Remove task
- `follow_up_task` - Send follow-up prompt to running task
- `stop_task` - Stop execution

**FastMCP Features Used:**
- ✅ Streaming output (streamContent for live task updates)
- ✅ Progress notifications (reportProgress for task progress)
- ✅ Tool annotations (readOnlyHint for read operations)
- ✅ Logging (log.info for operations)
- ✅ Error handling (UserError for validation failures)

**WebSocket Integration:**
```typescript
server.addTool({
  name: 'watch_tasks',
  description: 'Subscribe to live task updates for a project',
  parameters: z.object({
    project_id: z.string().uuid()
  }),
  annotations: {
    streamingHint: true,
    readOnlyHint: true,
    openWorldHint: false
  },
  execute: async (args, { streamContent, log, sessionId }) => {
    const forgeClient = new ForgeClient(FORGE_URL);
    const wsUrl = forgeClient.getTasksStreamUrl(args.project_id);

    log.info('Connecting to task stream', { project_id: args.project_id });

    const ws = new WebSocket(wsUrl);

    ws.on('open', () => {
      streamContent({ type: 'text', text: '✅ Connected to task stream\n' });
    });

    ws.on('message', async (data) => {
      const update = JSON.parse(data.toString());
      // Stream live task updates to AI
      await streamContent({
        type: 'text',
        text: `📨 Task Update: ${JSON.stringify(update, null, 2)}\n`
      });
    });

    ws.on('error', (error) => {
      streamContent({ type: 'text', text: `❌ Error: ${error.message}\n` });
    });

    // Keep streaming until client disconnects
    return; // Streaming continues in background
  }
});
```

---

### Layer 2: Live Code Monitoring
**Purpose:** Real-time code diff and log streaming - **THE KILLER FEATURE**

**Tools:**
- `watch_diff` - Stream file changes as code is written (WebSocket + streamContent)
- `watch_logs` - Stream stdout/stderr live (WebSocket + streamContent)
- `watch_normalized_logs` - Stream parsed logs (WebSocket + streamContent)
- `watch_processes` - Monitor execution processes (WebSocket + streamContent)
- `get_process` - Fetch process details
- `stop_process` - Kill running process

**Why This Is Revolutionary:**
- AI can **see code being written in real-time**
- Instant detection of errors/bugs as they appear in logs
- Live code review as diffs are generated
- Real-time debugging assistance
- Immediate feedback loops

**FastMCP Features Used:**
- ✅ Streaming output (streamContent for live diffs/logs)
- ✅ Progress notifications (reportProgress for diff generation)
- ✅ Logging (log structured events)
- ✅ Session state (track active streams per session)

**WebSocket Integration:**
```typescript
server.addTool({
  name: 'watch_diff',
  description: 'Stream file changes in real-time as code is written',
  parameters: z.object({
    attempt_id: z.string().uuid(),
    stats_only: z.boolean().default(false)
  }),
  annotations: {
    streamingHint: true,
    readOnlyHint: true
  },
  execute: async (args, { streamContent, log, session }) => {
    const forgeClient = new ForgeClient(FORGE_URL);
    const wsUrl = forgeClient.getTaskDiffStreamUrl(args.attempt_id, args.stats_only);

    const ws = new WebSocket(wsUrl);

    ws.on('message', async (data) => {
      const diff = JSON.parse(data.toString());

      // Stream formatted diff to AI
      await streamContent({
        type: 'text',
        text: `📝 File Changed: ${diff.file}\n${diff.diff}\n`
      });

      // AI can now analyze the diff in real-time!
      if (session.clientCapabilities.sampling) {
        // Use RequestSampling to ask AI to review the code
        const review = await session.requestSampling({
          messages: [{
            role: 'user',
            content: {
              type: 'text',
              text: `Review this code diff:\n\n${diff.diff}`
            }
          }],
          systemPrompt: 'You are a code reviewer. Analyze this diff for bugs, style issues, and improvements.',
          maxTokens: 500
        });

        await streamContent({
          type: 'text',
          text: `🤖 AI Review:\n${review.content.text}\n`
        });
      }
    });

    return;
  }
});
```

---

### Layer 3: Advanced Git Operations
**Purpose:** Full git workflow automation (merge, rebase, PR creation)

**Tools:**
- `get_branch_status` - Check branch state (ahead/behind, conflicts)
- `rebase_task` - Rebase on base branch
- `merge_task` - Merge to target branch
- `push_task` - Push to remote
- `abort_conflicts` - Abort merge/rebase
- `create_pr` - Generate GitHub PR with AI-generated description
- `attach_pr` - Link existing PR
- `compare_commits` - Compare commits
- `get_commit_info` - Fetch commit details

**FastMCP Features Used:**
- ✅ Sampling (requestSampling for AI PR descriptions)
- ✅ Progress notifications (reportProgress for git operations)
- ✅ Error handling (UserError for merge conflicts)

**AI-Enhanced PR Creation:**
```typescript
server.addTool({
  name: 'create_pr',
  description: 'Create GitHub PR with AI-generated title and description',
  parameters: z.object({
    attempt_id: z.string().uuid(),
    target_branch: z.string().default('main')
  }),
  execute: async (args, { log, session }) => {
    const forgeClient = new ForgeClient(FORGE_URL);

    // Get task attempt details
    const attempt = await forgeClient.getTaskAttempt(args.attempt_id);

    // Use AI to generate PR title and description
    const prContent = await session.requestSampling({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Generate a PR title and description for:\n\nTask: ${attempt.task.title}\nDescription: ${attempt.task.description}`
        }
      }],
      systemPrompt: 'You are a GitHub PR expert. Generate concise, professional PR titles and descriptions.',
      maxTokens: 300
    });

    // Create PR
    const pr = await forgeClient.createTaskAttemptPullRequest(args.attempt_id, {
      title: prContent.title,
      body: prContent.description,
      base: args.target_branch
    });

    return `✅ PR created: ${pr.html_url}`;
  }
});
```

---

### Layer 4: Draft Management & Approval Workflows
**Purpose:** Queue AI-generated code for review and approval

**Tools:**
- `watch_drafts` - Stream draft updates (WebSocket + streamContent)
- `save_draft` - Save code draft
- `get_draft` - Retrieve draft
- `delete_draft` - Remove draft
- `queue_draft` - Queue for execution
- `create_approval` - Request user approval
- `respond_approval` - Approve/reject
- `list_pending_approvals` - Get all pending
- `get_approval_status` - Check status

**FastMCP Features Used:**
- ✅ Streaming output (streamContent for draft updates)
- ✅ Authentication (per-user draft isolation)
- ✅ Tool authorization (canAccess for approval tools)

**Human-in-the-Loop AI:**
```typescript
server.addTool({
  name: 'queue_draft_with_approval',
  description: 'Queue AI-generated code draft and request user approval',
  parameters: z.object({
    attempt_id: z.string().uuid(),
    draft_type: z.enum(['IMPLEMENTATION', 'TEST', 'REFACTOR']),
    code: z.string()
  }),
  execute: async (args, { log, session }) => {
    const forgeClient = new ForgeClient(FORGE_URL);

    // Save draft
    await forgeClient.saveDraft(args.attempt_id, args.draft_type, {
      code: args.code
    });

    // Create approval request
    const approval = await forgeClient.createApprovalRequest({
      task_attempt_id: args.attempt_id,
      message: `AI generated ${args.draft_type} code. Review and approve?`,
      context: { draft_type: args.draft_type }
    });

    // Poll for approval
    let approved = false;
    while (!approved) {
      const status = await forgeClient.getApprovalStatus(approval.id);
      if (status.status === 'approved') {
        // Queue draft for execution
        await forgeClient.queueDraftExecution(args.attempt_id, args.draft_type, {});
        return '✅ Draft approved and queued for execution';
      } else if (status.status === 'rejected') {
        return '❌ Draft rejected by user';
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
});
```

---

### Layer 5: Knowledge Base & Resources
**Purpose:** Expose ALL Genie documentation as MCP resources

**Resources:**
- All wishes (`.genie/wishes/**/*.md`)
- All workflows (`.genie/code/workflows/*.md`)
- All agents (`.genie/code/agents/*.md`)
- All spells (`.genie/spells/*.md`)
- All QA docs (`.genie/qa/**/*.md`)
- AGENTS.md, CORE_AGENTS.md, CLAUDE.md

**Resource Templates:**
- `wish://{name}` - Dynamic wish access
- `workflow://{name}` - Dynamic workflow access
- `agent://{name}` - Dynamic agent access
- `spell://{name}` - Dynamic spell access
- `task://{id}` - Live task data
- `attempt://{id}` - Live attempt data

**FastMCP Features Used:**
- ✅ Resources (static file content)
- ✅ Resource Templates (parameterized access)
- ✅ Embedded Resources (include in tool responses)
- ✅ Argument auto-completion (for resource names)

**Implementation:**
```typescript
// Static resource for AGENTS.md
server.addResource({
  uri: 'genie://docs/agents',
  name: 'Genie Agents Documentation',
  mimeType: 'text/markdown',
  async load() {
    return {
      text: await fs.readFile('./../AGENTS.md', 'utf-8')
    };
  }
});

// Resource template for wishes
server.addResourceTemplate({
  uriTemplate: 'genie://wish/{name}',
  name: 'Genie Wish Documents',
  mimeType: 'text/markdown',
  arguments: [{
    name: 'name',
    description: 'Wish name',
    required: true,
    // Auto-completion: list all wishes
    complete: async (value) => {
      const wishes = await fs.readdir('.genie/wishes');
      return {
        values: wishes.filter(w => w.toLowerCase().includes(value.toLowerCase()))
      };
    }
  }],
  async load({ name }) {
    return {
      text: await fs.readFile(`.genie/wishes/${name}/${name}-wish.md`, 'utf-8')
    };
  }
});

// Use embedded resources in tools
server.addTool({
  name: 'explain_workflow',
  description: 'Explain a Genie workflow',
  parameters: z.object({
    workflow_name: z.string()
  }),
  execute: async (args) => {
    return {
      content: [
        { type: 'text', text: `Here's the ${args.workflow_name} workflow:\n\n` },
        {
          type: 'resource',
          resource: await server.embedded(`genie://workflow/${args.workflow_name}`)
        }
      ]
    };
  }
});
```

---

### Layer 6: AI-Powered Intelligence
**Purpose:** Use AI to enhance every operation

**AI-Enhanced Tools:**
- `ai_review_code` - AI code review using requestSampling
- `ai_generate_commit_message` - AI commit message
- `ai_debug_logs` - AI log analysis
- `ai_suggest_fixes` - AI fix suggestions
- `ai_explain_error` - AI error explanation
- `ai_optimize_code` - AI refactoring suggestions

**FastMCP Features Used:**
- ✅ Sampling (requestSampling for all AI operations)
- ✅ Streaming output (stream AI responses)
- ✅ Session state (remember conversation context)

**Example: AI Debugger**
```typescript
server.addTool({
  name: 'ai_debug_logs',
  description: 'AI analyzes logs to identify bugs and suggest fixes',
  parameters: z.object({
    process_id: z.string().uuid(),
    max_lines: z.number().default(100)
  }),
  annotations: {
    streamingHint: true
  },
  execute: async (args, { streamContent, session }) => {
    const forgeClient = new ForgeClient(FORGE_URL);

    // Get recent logs
    const process = await forgeClient.getExecutionProcess(args.process_id);
    const logs = process.output.split('\n').slice(-args.max_lines).join('\n');

    // Stream initial message
    await streamContent({ type: 'text', text: '🤖 Analyzing logs with AI...\n' });

    // Use AI to analyze logs
    const analysis = await session.requestSampling({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Analyze these logs for errors, warnings, and bugs:\n\n${logs}`
        }
      }],
      systemPrompt: 'You are an expert debugger. Identify issues, explain root causes, and suggest fixes.',
      maxTokens: 1000
    });

    // Stream AI analysis
    await streamContent({
      type: 'text',
      text: `\n${analysis.content.text}\n`
    });

    return;
  }
});
```

---

### Layer 7: Production Features
**Purpose:** Authentication, monitoring, analytics, health checks

**Features:**
- **GitHub OAuth:** Full OAuth integration for user identity
- **Per-User Isolation:** Session-based task tracking
- **Health Checks:** Forge connectivity monitoring
- **Request Tracing:** Request ID tracking for debugging
- **Analytics:** Session metrics, tool usage stats
- **Custom Logging:** Winston/Pino integration

**FastMCP Features Used:**
- ✅ Authentication (OAuth + custom auth)
- ✅ Tool authorization (per-user access control)
- ✅ Sessions (stateful clients)
- ✅ Session ID tracking
- ✅ Request ID tracking
- ✅ Health checks
- ✅ Custom logger
- ✅ Typed events (server.on/session.on)

**Implementation:**
```typescript
const server = new FastMCP({
  name: 'Genie MCP',
  version: '1.0.0',

  // GitHub OAuth
  oauth: {
    enabled: true,
    authorizationServer: {
      issuer: process.env.GITHUB_ISSUER,
      authorizationEndpoint: process.env.GITHUB_AUTH_ENDPOINT,
      tokenEndpoint: process.env.GITHUB_TOKEN_ENDPOINT,
      jwksUri: process.env.GITHUB_JWKS_URI,
      responseTypesSupported: ['code']
    }
  },

  // Custom authentication
  authenticate: async (request) => {
    const token = request.headers.authorization?.replace('Bearer ', '');
    // Validate JWT, extract user info
    const user = await validateToken(token);
    return { userId: user.id, email: user.email };
  },

  // Health checks
  health: {
    enabled: true,
    path: '/health',
    message: 'Genie MCP healthy'
  },

  // Custom logger
  logger: new WinstonLogger(),

  // Ping configuration
  ping: {
    enabled: true,
    intervalMs: 10000,
    logLevel: 'debug'
  }
});

// Tool authorization
server.addTool({
  name: 'admin_tool',
  description: 'Admin-only operations',
  canAccess: (auth) => auth?.role === 'admin',
  execute: async () => '✅ Admin operation'
});

// Session tracking
server.on('connect', (event) => {
  console.log('User connected:', event.session.sessionId);

  // Track session metrics
  sessionMetrics.set(event.session.sessionId, {
    connected_at: Date.now(),
    tools_called: 0
  });

  // Listen for disconnection
  event.session.on('disconnect', () => {
    console.log('User disconnected:', event.session.sessionId);
    sessionMetrics.delete(event.session.sessionId);
  });
});
```

---

## 🚀 Implementation Roadmap

### Phase 1: Foundation (Week 1)
**Goal:** Basic task operations + WebSocket validation

- [x] Forge API health checks
- [x] WebSocket stream validation
- [x] Amendment 1 enforcement (GitHub issue requirement)
- [ ] Basic task tools (create, list, get, update, delete)
- [ ] ForgeExecutor integration
- [ ] Error handling (UserError)

### Phase 2: Real-Time Streaming (Week 2)
**Goal:** Live monitoring with WebSocket + streamContent()

- [ ] `watch_tasks` - Task stream
- [ ] `watch_diff` - Diff stream (KILLER FEATURE)
- [ ] `watch_logs` - Log stream
- [ ] `watch_processes` - Process stream
- [ ] Progress reporting for all long-running operations
- [ ] Streaming error handling

### Phase 3: Knowledge Base (Week 3)
**Goal:** Expose all Genie docs as resources

- [ ] Static resources (AGENTS.md, wishes, workflows, spells)
- [ ] Resource templates (dynamic wish/workflow access)
- [ ] Embedded resources in tool responses
- [ ] Argument auto-completion for resource names
- [ ] Search tools for documentation

### Phase 4: Advanced Operations (Week 4)
**Goal:** Git workflows + draft management

- [ ] Branch status tools
- [ ] Merge/rebase/push tools
- [ ] PR creation with AI
- [ ] Draft management (save, queue, execute)
- [ ] Approval workflow integration
- [ ] Conflict resolution tools

### Phase 5: AI Intelligence (Week 5)
**Goal:** RequestSampling for smart operations

- [ ] AI code review tool
- [ ] AI commit message generator
- [ ] AI debugger (log analysis)
- [ ] AI fix suggester
- [ ] AI error explainer
- [ ] AI refactoring tool

### Phase 6: Production (Week 6)
**Goal:** Auth, monitoring, analytics

- [ ] GitHub OAuth integration
- [ ] Per-user task isolation
- [ ] Session tracking
- [ ] Request tracing
- [ ] Health monitoring
- [ ] Analytics dashboard
- [ ] Custom logger (Winston)

---

## 💡 Key Innovations

### 1. Live Code Streaming
**The Killer Feature:** AI sees code being written in real-time

```
Developer writes code → Diff stream → AI watches → Instant feedback
```

### 2. Multi-Agent Orchestration
**Coordinate multiple AI agents:**

```
Agent 1: Watches tasks → Routes to Agent 2
Agent 2: Watches diffs → Reviews code → Sends to Agent 3
Agent 3: Runs tests → Reports back
```

### 3. Human-in-the-Loop AI
**AI generates code → User approves → Forge executes:**

```
AI proposes fix → Save as draft → Request approval → Queue for execution
```

### 4. AI-Assisted Everything
**Every operation can invoke AI:**

- Creating PR? AI writes description
- Debugging? AI analyzes logs
- Code review? AI spots bugs
- Commit message? AI generates it

### 5. Full Observability
**See everything as it happens:**

- Task updates stream live
- Logs stream live
- Diffs stream live
- Process status streams live
- No polling, all push-based

---

## 📈 Performance Characteristics

### Speed
- **WebSocket:** Sub-100ms latency for updates
- **Direct API:** No CLI subprocess overhead
- **Streaming:** Immediate feedback, no blocking

### Scalability
- **Stateless mode:** Serverless-ready
- **Session isolation:** Per-user state
- **Connection pooling:** Efficient resource usage

### Reliability
- **Health checks:** Automatic Forge monitoring
- **Error handling:** Graceful degradation
- **Reconnection:** Automatic WebSocket recovery

---

## 🎨 User Experience

### For Developers
```
> "Create a wish for adding dark mode"
✅ GitHub issue #123 created
✅ Wish document created
✅ Forge task started
📊 Watching progress...
  📝 File changed: src/theme.ts (+42 lines)
  📝 File changed: src/App.tsx (+15 lines)
  ✅ Tests passing
✅ Task complete! Review at [link]
```

### For AI Agents
```
AI: "Let me create a wish..."
[Creates wish with Amendment 1 enforcement]
AI: "Watching task progress..."
[Subscribes to diff stream]
AI: "I see you're modifying theme.ts, looks good!"
[AI reviews code in real-time]
AI: "Tests passed! Creating PR..."
[AI generates PR description]
AI: "Done! PR #456 created"
```

---

## 🔐 Security

- **OAuth:** GitHub OAuth for identity
- **Authorization:** Per-tool access control
- **Isolation:** Session-based state
- **Validation:** All inputs validated with Zod
- **Secrets:** Never log sensitive data

---

## 📝 Next Steps

1. **Review this architecture** with team
2. **Prioritize phases** based on impact
3. **Start Phase 1** implementation
4. **Iterate rapidly** with user feedback
5. **Ship Phase 2** (streaming) ASAP - it's the killer feature

---

**Status:** Architecture Complete ✅
**Next:** Implementation Phase 1
**Impact:** Revolutionary AI development platform
**Timeline:** 6 weeks to full production system
