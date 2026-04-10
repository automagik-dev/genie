# Wish: Full Claude Agent SDK Executor — Complete API Coverage

| Field | Value |
|-------|-------|
| **Status** | APPROVED |
| **Slug** | `sdk-executor-full` |
| **Date** | 2026-04-04 |
| **Base PR** | [#1030](https://github.com/automagik-dev/genie/pull/1030) (`feat/sdk-executor-provider`) |
| **SDK Version** | `@anthropic-ai/claude-agent-sdk@0.2.91+` |

## Summary

Evolve PR #1030's initial Claude Agent SDK executor from a basic `query()` wrapper (using ~15% of the SDK) into a fully-configurable, stateful agent system that exposes the entire SDK API surface through genie's CLI, agent directory, and event system. Users configure agents entirely through `genie dir` and `genie spawn` — no code changes required to adjust permissions, tools, MCP servers, subagents, hooks, budgets, thinking config, or session behavior.

**Critical invariant:** Agent configuration is fully declarative. AGENTS.md frontmatter is the source of truth, PG metadata JSONB is the runtime cache, and `genie dir sync` reconstructs the full workspace from a git clone. A `git clone` + `genie dir sync` must produce an identical agent directory — same SDK config, same permissions, same MCP servers, same subagents.

## Scope

### IN
- Fix P0 concurrency bug in Omni bridge SDK executor
- Extend `DirectoryEntry` schema to hold full SDK `Options` config
- Extend `genie dir add/edit` CLI to set every SDK option
- Extend `genie spawn --provider claude-sdk` to pass full options to SDK
- Route all 24 `SDKMessage` types to genie event system
- Build streaming output pipeline (`--stream` flag for live TUI output)
- Implement V2 stateful sessions (`createSession`/`send`/`stream`)
- Add session management CLI (`genie sdk sessions list/info/fork/resume`)
- Expose `Query` control methods (interrupt, setModel, setPermissionMode, applyFlagSettings)
- Support subagent definitions via directory config
- Support MCP server definitions via directory config
- Support custom tool definitions via directory config (`tool()` function)
- Support plugin loading via directory config
- Cost tracking + budget enforcement via SDK options
- File checkpointing + rewind support
- Structured output (JSON schema) support
- Sandbox isolation support
- Unified permission resolution (deduplicate resolvers)
- Comprehensive test coverage (unit + integration)
- **Frontmatter as source of truth:** Extend AGENTS.md YAML frontmatter with full `sdk:` block so agent config lives in git
- **PG persistence:** SDK config stored in PG `agents.metadata` JSONB, synced from frontmatter
- **Workspace reconstruction:** `git clone` + `genie dir sync` rebuilds exact agent directory from AGENTS.md frontmatter
- **PG migration:** New migration for any SDK-specific columns or indexes needed
- **Bidirectional sync:** `genie dir edit` updates both PG and writes back to AGENTS.md frontmatter

### OUT
- Bridge API for remote hosting via claude.ai (alpha, unstable — separate wish)
- Browser SDK integration (`@anthropic-ai/claude-agent-sdk/browser`)
- Embed API (`@anthropic-ai/claude-agent-sdk/embed`)
- Changes to existing `claude` (tmux) or `codex` (API) providers
- TUI/desktop UI for agent configuration (khal-os concern)
- Bedrock/Vertex/Foundry provider routing (cloud-specific auth)

## Decisions

| Decision | Rationale |
|----------|-----------|
| Build on V2 `createSession` for stateful agents, keep V1 `query()` for one-shots | V2 provides `send()`/`stream()` for true multi-turn; V1 is simpler for fire-and-forget tasks |
| All SDK options configurable via `DirectoryEntry.sdk` namespace | Keeps existing fields clean, groups SDK-specific config under one key |
| Event routing goes through existing `genie events` PG pipeline | Reuse infrastructure; events are already consumed by `genie status`, TUI, and monitoring |
| Permission presets stay (full/read-only/chat-only) but become sugar over full config | Presets are convenient defaults; power users get the full `tools`/`allowedTools`/`disallowedTools` surface |
| Custom tools defined as JSON in directory (name + description + inputSchema + handler path) | Avoids requiring code changes; handler is a script/module path resolved at runtime |
| Per-session worker queue for Omni bridge (not shared event loop) | Fixes P0; each chat session runs its SDK query independently without blocking others |
| AGENTS.md frontmatter is the source of truth, PG is the runtime cache | Git-versioned config enables workspace reconstruction; PG enables fast runtime lookups and cross-agent queries |
| Frontmatter uses nested YAML `sdk:` block (not flat keys) | Keeps SDK config namespaced; avoids collision with existing frontmatter fields; maps cleanly to `SdkDirectoryConfig` type |
| `genie dir edit` writes back to AGENTS.md frontmatter | Bidirectional sync ensures PG and frontmatter never drift; edit in either place and they converge |
| `genie dir sync` is the reconstruction command | Explicit action, not magic — user clones repo, runs sync, gets exact same agents |

## Success Criteria

- [ ] `genie spawn <agent> --provider claude-sdk` with any SDK option set via directory passes config correctly to SDK `query()`/`createSession()`
- [ ] All 24 `SDKMessage` types appear in `genie events list` with correct event types
- [ ] `genie sdk sessions list` shows active and past SDK sessions with metadata
- [ ] `genie sdk send <agent> "message"` delivers a new turn to a stateful session and streams the response
- [ ] `genie sdk interrupt <agent>` interrupts an active query
- [ ] Omni bridge with `--executor sdk` handles 10 concurrent chats without blocking
- [ ] Directory entry with `sdk.mcpServers` config spawns agent with MCP servers connected
- [ ] Directory entry with `sdk.agents` config makes subagents available to the spawned agent
- [ ] Directory entry with `sdk.maxBudgetUsd: 5.00` stops the agent at $5 spend
- [ ] Directory entry with `sdk.tools: ['Read', 'Glob', 'Grep']` limits visible tools to those 3
- [ ] AGENTS.md with `sdk:` frontmatter block round-trips through `genie dir sync` → PG → `genie dir show` with no data loss
- [ ] `genie dir edit <agent> --sdk-max-budget 5` updates both PG metadata and writes back to AGENTS.md frontmatter
- [ ] Fresh `git clone` + `genie dir sync` reconstructs identical agent directory (same SDK config, permissions, MCP servers)
- [ ] PG `agents.metadata` JSONB contains full `sdk` config after sync
- [ ] `bun test` — all new tests pass (target: 80+ new tests)
- [ ] `bun run typecheck` — clean
- [ ] `bun run lint` — 0 errors
- [ ] `bun run dead-code` — clean

## Execution Strategy

### Wave 1 — Foundation (parallel)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Fix P0 Omni bridge concurrency + deduplicate permission resolvers |
| 2 | engineer | Extend DirectoryEntry schema with full `sdk` namespace |
| 3 | engineer | Build SDKMessage → genie events routing pipeline |
| 13 | engineer | Frontmatter + PG persistence layer for SDK config |

### Wave 2 — CLI Surface (parallel, after Wave 1)
| Group | Agent | Description |
|-------|-------|-------------|
| 4 | engineer | Extend `genie dir add/edit` with all SDK CLI flags |
| 5 | engineer | Extend `genie spawn` + `ClaudeSdkProvider.runQuery()` to pass full Options |
| 6 | engineer | Add `--stream` flag with live SDKMessage output |
| 14 | engineer | Bidirectional frontmatter sync + workspace reconstruction |
| review-1 | reviewer | Review Wave 1 groups |

### Wave 3 — Stateful Sessions (parallel, after Wave 2)
| Group | Agent | Description |
|-------|-------|-------------|
| 7 | engineer | V2 session manager: createSession/send/stream/resume/fork |
| 8 | engineer | `genie sdk` CLI namespace: sessions, send, interrupt, status |
| review-2 | reviewer | Review Wave 2 groups |

### Wave 4 — Advanced Capabilities (parallel, after Wave 3)
| Group | Agent | Description |
|-------|-------|-------------|
| 9 | engineer | Subagent + MCP + plugin definitions via directory |
| 10 | engineer | Custom tools, structured output, file checkpointing, sandbox |
| 11 | engineer | Cost tracking, budget enforcement, thinking/effort config |
| review-3 | reviewer | Review Wave 3 groups |

### Wave 5 — Integration + QA
| Group | Agent | Description |
|-------|-------|-------------|
| 12 | engineer | Integration tests: full spawn→query→events→session lifecycle |
| review-final | reviewer | Full PR review against all success criteria |
| qa | qa | Run QA spec on dev after merge |

## Execution Groups

### Group 1: Fix P0 Omni Bridge Concurrency + Deduplicate Permission Resolvers

**Goal:** Fix the blocking `deliver()` call that serializes all Omni chats, and unify the two duplicate permission resolver functions.

**Deliverables:**
1. `src/services/executors/claude-sdk.ts` — Rewrite `deliver()` to fire SDK query in a per-session async worker queue. The NATS subscription loop must not `await` individual queries. Use a `Map<sessionId, Promise<void>>` or similar to track active deliveries.
2. `src/services/executors/claude-sdk.ts` — Extract `resolvePermissionConfig()` into a shared helper importable by both the executor and `agents.ts`. Remove the duplicate `resolveSdkPermissions()` from `agents.ts`.
3. Tests: concurrent delivery test — spawn 3 sessions, deliver messages simultaneously, verify none blocks the others.

**Acceptance Criteria:**
- [ ] `deliver()` returns immediately after enqueuing the SDK query
- [ ] 3 concurrent chat sessions process messages independently
- [ ] Only one `resolvePermissionConfig` function exists, imported from `claude-sdk-permissions.ts`

**Validation:**
```bash
bun test src/services/executors/__tests__/claude-sdk.test.ts && bun run typecheck
```

**depends-on:** none

---

### Group 2: Extend DirectoryEntry Schema with Full SDK Namespace

**Goal:** Add an `sdk` field to `DirectoryEntry` that holds every SDK `Options` configuration parameter.

**Deliverables:**
1. `src/lib/agent-directory.ts` — Add `sdk?: SdkDirectoryConfig` to `DirectoryEntry` interface. The type covers: `permissionMode`, `tools`, `allowedTools`, `disallowedTools`, `maxTurns`, `maxBudgetUsd`, `effort`, `thinking`, `agents` (subagent definitions), `mcpServers`, `plugins`, `persistSession`, `enableFileCheckpointing`, `outputFormat`, `includePartialMessages`, `includeHookEvents`, `promptSuggestions`, `agentProgressSummaries`, `sandbox`, `betas`, `settingSources`, `settings`, `hooks`, `systemPrompt` (string or preset+append object), `agent` (named main agent), `customTools` (array of tool definitions).
2. `src/lib/agent-directory.ts` — Update `edit()` Pick type, `roleToEntry()`, and `buildMetadata()` to handle the new `sdk` field.
3. `src/lib/sdk-directory-types.ts` — New file: TypeScript types for `SdkDirectoryConfig` mapped from SDK `Options`. Include JSDoc comments explaining each field.
4. Tests: directory add/edit/resolve with `sdk` config roundtrips correctly.

**Acceptance Criteria:**
- [ ] `SdkDirectoryConfig` type covers all SDK `Options` fields listed above
- [ ] `genie dir add --provider claude-sdk` with sdk config persists to directory JSON
- [ ] `directory.resolve()` returns the full `sdk` config

**Validation:**
```bash
bun test src/lib/agent-directory.test.ts && bun run typecheck
```

**depends-on:** none

---

### Group 3: SDKMessage → Genie Events Routing Pipeline

**Goal:** Create a message router that maps all 24 `SDKMessage` types to structured genie events.

**Deliverables:**
1. `src/lib/providers/claude-sdk-events.ts` — New file: `routeSdkMessage(msg: SDKMessage, executorId: string, agentId: string): GenieEvent[]` function. Maps each of the 24 message types to a genie event type:
   - `assistant` → `sdk.assistant.message`
   - `result` (success) → `sdk.result.success`
   - `result` (error) → `sdk.result.error`
   - `system` → `sdk.system.*` (subtype-specific)
   - `stream_event` → `sdk.stream.partial` (if streaming enabled)
   - `tool_progress` → `sdk.tool.progress`
   - `tool_use_summary` → `sdk.tool.summary`
   - `task_notification` → `sdk.task.notification`
   - `task_started` → `sdk.task.started`
   - `task_progress` → `sdk.task.progress`
   - `hook_started` → `sdk.hook.started`
   - `hook_progress` → `sdk.hook.progress`
   - `hook_response` → `sdk.hook.response`
   - `rate_limit` → `sdk.rate_limit`
   - `compact_boundary` → `sdk.context.compacted`
   - `session_state_changed` → `sdk.session.state`
   - `files_persisted` → `sdk.files.persisted`
   - `status` → `sdk.status`
   - `api_retry` → `sdk.api.retry`
   - `auth_status` → `sdk.auth.status`
   - `local_command_output` → `sdk.command.output`
   - `user` / `user_replay` → `sdk.user.message`
   - `elicitation_complete` → `sdk.elicitation.complete`
   - `prompt_suggestion` → `sdk.prompt.suggestion`
2. Wire the router into `ClaudeSdkProvider.runQuery()` — call `routeSdkMessage()` for each yielded message, emit via `genie events emit`.
3. Tests: feed each of the 24 message types through the router, verify correct event type and payload.

**Acceptance Criteria:**
- [ ] All 24 SDKMessage types produce at least one genie event
- [ ] Events are visible in `genie events list --since 1m` after a SDK agent runs
- [ ] Event payloads contain enough context to reconstruct what happened

**Validation:**
```bash
bun test src/lib/providers/__tests__/claude-sdk-events.test.ts && bun run typecheck
```

**depends-on:** none

---

### Group 4: Extend `genie dir add/edit` CLI with SDK Flags

**Goal:** Add CLI flags to `genie dir add` and `genie dir edit` for every SDK option.

**Deliverables:**
1. `src/term-commands/dir.ts` — Add flags:
   - `--sdk-permission-mode <mode>` (default|acceptEdits|bypassPermissions|plan|dontAsk|auto)
   - `--sdk-tools <list>` (comma-separated tool names)
   - `--sdk-allowed-tools <list>` (comma-separated auto-approved tools)
   - `--sdk-disallowed-tools <list>` (comma-separated blacklisted tools)
   - `--sdk-max-turns <n>`
   - `--sdk-max-budget <usd>`
   - `--sdk-effort <level>` (low|medium|high|max)
   - `--sdk-thinking <config>` (adaptive|disabled|enabled:N)
   - `--sdk-persist-session` / `--no-sdk-persist-session`
   - `--sdk-file-checkpointing`
   - `--sdk-output-format <json-schema-path>`
   - `--sdk-stream-partial`
   - `--sdk-hook-events`
   - `--sdk-prompt-suggestions`
   - `--sdk-progress-summaries`
   - `--sdk-sandbox`
   - `--sdk-betas <list>`
   - `--sdk-setting-sources <list>`
   - `--sdk-mcp-server <name:command>` (repeatable)
   - `--sdk-plugin <path>` (repeatable)
   - `--sdk-agent <name>` (main agent)
   - `--sdk-subagent <name:json>` (repeatable)
   - `--sdk-system-prompt <string-or-preset>`
2. `src/term-commands/dir.ts` — `buildSdkConfig()` helper that parses all `--sdk-*` flags into `SdkDirectoryConfig`.
3. `src/term-commands/dir.ts` — Update `printEntry()` to display SDK config summary.
4. Tests: CLI flag parsing produces correct `SdkDirectoryConfig`.

**Acceptance Criteria:**
- [ ] `genie dir add my-agent --provider claude-sdk --sdk-tools "Read,Glob" --sdk-max-budget 5` persists correctly
- [ ] `genie dir show my-agent` displays SDK config
- [ ] `genie dir edit my-agent --sdk-effort high` updates only that field

**Validation:**
```bash
bun test src/term-commands/dir.test.ts && bun run typecheck
```

**depends-on:** Group 2

---

### Group 5: Wire Full SDK Options into Provider + Spawn

**Goal:** Make `ClaudeSdkProvider.runQuery()` and `launchSdkSpawn()` read the full `sdk` config from directory and translate it into SDK `Options`.

**Deliverables:**
1. `src/lib/providers/claude-sdk.ts` — Extend `runQuery()` to accept `SdkDirectoryConfig` and translate every field to `Options`:
   - `sdk.tools` → `Options.tools`
   - `sdk.allowedTools` → `Options.allowedTools`
   - `sdk.disallowedTools` → `Options.disallowedTools`
   - `sdk.maxTurns` → `Options.maxTurns`
   - `sdk.maxBudgetUsd` → `Options.maxBudgetUsd`
   - `sdk.effort` → `Options.effort`
   - `sdk.thinking` → `Options.thinking`
   - `sdk.agents` → `Options.agents`
   - `sdk.mcpServers` → `Options.mcpServers`
   - `sdk.plugins` → `Options.plugins`
   - `sdk.persistSession` → `Options.persistSession`
   - `sdk.enableFileCheckpointing` → `Options.enableFileCheckpointing`
   - `sdk.outputFormat` → `Options.outputFormat`
   - `sdk.includePartialMessages` → `Options.includePartialMessages`
   - `sdk.includeHookEvents` → `Options.includeHookEvents`
   - `sdk.promptSuggestions` → `Options.promptSuggestions`
   - `sdk.agentProgressSummaries` → `Options.agentProgressSummaries`
   - `sdk.sandbox` → `Options.sandbox`
   - `sdk.betas` → `Options.betas`
   - `sdk.settingSources` → `Options.settingSources`
   - `sdk.settings` → `Options.settings`
   - `sdk.hooks` → merged with permission gate hooks
   - `sdk.systemPrompt` → `Options.systemPrompt`
   - `sdk.agent` → `Options.agent`
2. `src/term-commands/agents.ts` — Update `launchSdkSpawn()` to read `agent.entry.sdk` and pass to provider, plus support runtime overrides from spawn flags (`--model`, `--sdk-*` flags on spawn).
3. `src/term-commands/agent/spawn.ts` — Add SDK-specific spawn flags: `--sdk-max-turns`, `--sdk-max-budget`, `--sdk-stream`, `--sdk-effort`.
4. Tests: spawn with various `sdk` configs, verify `Options` object passed to SDK contains correct values.

**Acceptance Criteria:**
- [ ] Every `SdkDirectoryConfig` field translates to the correct `Options` field
- [ ] Spawn-time flags override directory defaults
- [ ] Permission gate hooks merge correctly with user-defined hooks

**Validation:**
```bash
bun test src/lib/providers/__tests__/claude-sdk.test.ts && bun test src/term-commands/agents.test.ts && bun run typecheck
```

**depends-on:** Group 2

---

### Group 6: Streaming Output Pipeline

**Goal:** Add `--stream` flag to `genie spawn --provider claude-sdk` that outputs SDKMessages in real-time.

**Deliverables:**
1. `src/lib/providers/claude-sdk-stream.ts` — New file: `formatSdkMessage(msg: SDKMessage, format: 'text' | 'json' | 'ndjson'): string` function. Text format shows assistant text + tool use summaries + errors. JSON/NDJSON format outputs raw message objects.
2. `src/term-commands/agents.ts` — Update `launchSdkSpawn()` to use `formatSdkMessage()` when `--stream` is set, showing partial messages (typing effect), tool progress, hook events, etc. Default: only final assistant text.
3. `src/term-commands/agents.ts` — Add `--stream-format <text|json|ndjson>` flag.
4. `src/lib/providers/claude-sdk.ts` — Set `includePartialMessages: true` when streaming is enabled.
5. Tests: format function produces correct output for each message type.

**Acceptance Criteria:**
- [ ] `genie spawn my-agent --provider claude-sdk --stream` shows live typing output
- [ ] `genie spawn my-agent --provider claude-sdk --stream --stream-format ndjson` outputs one JSON object per line per message
- [ ] Non-stream mode (default) still works: only final text output

**Validation:**
```bash
bun test src/lib/providers/__tests__/claude-sdk-stream.test.ts && bun run typecheck
```

**depends-on:** Group 3

---

### Group 7: V2 Stateful Session Manager

**Goal:** Implement a session manager using the V2 `unstable_v2_createSession`/`unstable_v2_resumeSession` APIs for persistent multi-turn agents.

**Deliverables:**
1. `src/services/sdk-session-manager.ts` — New file: `SdkSessionManager` class:
   - `create(agentName: string, sdkConfig: SdkDirectoryConfig): SdkManagedSession` — creates V2 session, stores handle
   - `resume(sessionId: string, sdkConfig: SdkDirectoryConfig): SdkManagedSession` — resumes existing session
   - `send(sessionId: string, message: string): AsyncGenerator<SDKMessage>` — sends user message, returns response stream
   - `interrupt(sessionId: string): void` — interrupts active query
   - `close(sessionId: string): void` — closes session
   - `getInfo(sessionId: string): SessionInfo` — session metadata
   - `list(): SessionInfo[]` — all managed sessions
   - Internally tracks: session handles, abort controllers, current state (idle/running/requires_action)
   - Emits genie events for session lifecycle (created, resumed, closed, state changes)
2. `src/services/sdk-session-manager.ts` — `SdkManagedSession` type: wraps `SDKSession` with genie metadata (agentName, directory config, creation time, event emitter).
3. `src/services/sdk-session-manager.ts` — Session persistence: write session IDs + agent mapping to `~/.genie/sdk-sessions.json` for cross-process discovery.
4. Tests: create session, send messages, verify state transitions, resume, interrupt, close.

**Acceptance Criteria:**
- [ ] Multi-turn conversation within one session preserves full context
- [ ] Session resume restores conversation from session ID
- [ ] Interrupt stops an active query gracefully
- [ ] Session state changes emit genie events
- [ ] Sessions persist across genie process restarts

**Validation:**
```bash
bun test src/services/__tests__/sdk-session-manager.test.ts && bun run typecheck
```

**depends-on:** Groups 2, 3

---

### Group 8: `genie sdk` CLI Namespace

**Goal:** Add `genie sdk` commands for session management and interactive agent control.

**Deliverables:**
1. `src/term-commands/sdk.ts` — New file: register `genie sdk` namespace:
   - `genie sdk sessions list [--json]` — list all SDK sessions (active + historical)
   - `genie sdk sessions info <session-id>` — show session details (agent, model, turns, cost, state)
   - `genie sdk sessions fork <session-id> [--at <message-id>]` — fork a session at a point
   - `genie sdk sessions resume <session-id>` — resume an existing session interactively
   - `genie sdk send <agent-or-session-id> "<message>"` — send a message to a stateful session
   - `genie sdk interrupt <agent-or-session-id>` — interrupt active query
   - `genie sdk status <agent-or-session-id>` — show context usage, MCP health, model, state
   - `genie sdk models` — list available models via SDK
   - `genie sdk agents <session-id>` — list available subagents in a session
   - `genie sdk skills <session-id>` — list available skills/commands
   - `genie sdk mcp-status <session-id>` — MCP server health
2. `src/term-commands/sdk.ts` — All output supports `--json` for programmatic consumption.
3. Wire into main command registry.
4. Tests: CLI commands parse correctly and call session manager methods.

**Acceptance Criteria:**
- [ ] `genie sdk sessions list` shows active sessions with agent name, state, last activity
- [ ] `genie sdk send my-agent "Do X"` sends a turn and prints the response
- [ ] `genie sdk interrupt my-agent` interrupts an active query
- [ ] `genie sdk status my-agent` shows token usage, model, MCP status
- [ ] All commands support `--json` output

**Validation:**
```bash
bun test src/term-commands/__tests__/sdk.test.ts && bun run typecheck
```

**depends-on:** Group 7

---

### Group 9: Subagent + MCP + Plugin Definitions via Directory

**Goal:** Enable users to define subagents, MCP servers, and plugins in the agent directory without writing code.

**Deliverables:**
1. `src/lib/providers/claude-sdk.ts` — Translate `sdk.agents` (Record<string, AgentDefinition>) to `Options.agents`. AgentDefinition includes: `description`, `prompt`, `tools`, `disallowedTools`, `model`, `mcpServers`, `skills`, `maxTurns`, `background`, `memory`, `effort`, `permissionMode`.
2. `src/lib/providers/claude-sdk.ts` — Translate `sdk.mcpServers` to `Options.mcpServers`. Support stdio, SSE, HTTP, and SDK (in-process) server configs.
3. `src/lib/providers/claude-sdk.ts` — Translate `sdk.plugins` to `Options.plugins`. Support local plugin paths.
4. `src/term-commands/dir.ts` — Add `genie dir add-subagent <parent> <subagent-name> --prompt "..." --tools "Read,Bash" --model sonnet` convenience command.
5. `src/term-commands/dir.ts` — Add `genie dir add-mcp <agent> <server-name> --command "npx" --args "-y,@mcp/server"` convenience command.
6. Tests: directory entry with subagents/MCP/plugins spawns agent with correct Options.

**Acceptance Criteria:**
- [ ] Agent with `sdk.agents` config makes subagents available (visible in `genie sdk agents`)
- [ ] Agent with `sdk.mcpServers` config connects to MCP servers (visible in `genie sdk mcp-status`)
- [ ] Agent with `sdk.plugins` config loads plugins (visible in `genie sdk skills`)
- [ ] Convenience commands simplify common patterns

**Validation:**
```bash
bun test src/lib/providers/__tests__/claude-sdk.test.ts && bun test src/term-commands/dir.test.ts && bun run typecheck
```

**depends-on:** Groups 2, 5

---

### Group 10: Custom Tools, Structured Output, File Checkpointing, Sandbox

**Goal:** Expose the remaining SDK capabilities that don't fit neatly into other groups.

**Deliverables:**
1. `src/lib/providers/claude-sdk-tools.ts` — New file: `loadCustomTools(toolDefs: CustomToolDef[]): Options['mcpServers']` function. Each custom tool definition specifies `name`, `description`, `inputSchema` (JSON Schema), and `handler` (path to a JS/TS module exporting a handler function). Tools are exposed via an in-process MCP server using `createSdkMcpServer()`.
2. `src/lib/providers/claude-sdk.ts` — When `sdk.outputFormat` is set, pass to `Options.outputFormat`. Result messages contain structured JSON.
3. `src/lib/providers/claude-sdk.ts` — When `sdk.enableFileCheckpointing` is true, pass to Options. Expose `Query.rewindFiles()` via `genie sdk rewind <session-id> <message-id>`.
4. `src/lib/providers/claude-sdk.ts` — When `sdk.sandbox` is set, pass sandbox config to Options.
5. `src/term-commands/sdk.ts` — Add `genie sdk rewind <session-id> <message-id> [--dry-run]`.
6. Tests: custom tool definition loads and executes, structured output returns valid JSON, file checkpointing creates/rewinds snapshots.

**Acceptance Criteria:**
- [ ] Custom tool defined in directory is callable by the agent
- [ ] Structured output with JSON schema returns valid, schema-conforming JSON
- [ ] File checkpointing tracks changes and `genie sdk rewind` restores files
- [ ] Sandbox config isolates command execution

**Validation:**
```bash
bun test src/lib/providers/__tests__/claude-sdk-tools.test.ts && bun run typecheck
```

**depends-on:** Groups 5, 7, 8

---

### Group 11: Cost Tracking, Budget Enforcement, Thinking/Effort Config

**Goal:** Expose cost control, thinking configuration, and budget enforcement through the SDK executor.

**Deliverables:**
1. `src/lib/providers/claude-sdk.ts` — Pass `sdk.maxBudgetUsd` to `Options.maxBudgetUsd`. Handle `error_max_budget_usd` result type gracefully (emit event, log, don't crash).
2. `src/lib/providers/claude-sdk-events.ts` — Extract cost data from `SDKResultSuccess.usage` (input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens). Emit `sdk.cost.update` event with token counts and estimated USD.
3. `src/lib/providers/claude-sdk.ts` — Pass `sdk.thinking` config to Options. Support: `{ type: 'adaptive' }`, `{ type: 'enabled', budgetTokens: N }`, `{ type: 'disabled' }`.
4. `src/lib/providers/claude-sdk.ts` — Pass `sdk.effort` to Options (low/medium/high/max).
5. `src/term-commands/sdk.ts` — `genie sdk cost <session-id>` — show cumulative cost for a session.
6. `src/services/sdk-session-manager.ts` — Track cumulative cost per session in manager state.
7. Tests: budget exceeded stops gracefully, cost events emit correctly, thinking config passes through.

**Acceptance Criteria:**
- [ ] `sdk.maxBudgetUsd: 5.00` stops agent at $5 with a clean error event
- [ ] `genie sdk cost <session>` shows token counts and estimated cost
- [ ] `sdk.thinking: { type: 'disabled' }` produces responses without extended thinking
- [ ] `sdk.effort: 'low'` produces faster, less thorough responses

**Validation:**
```bash
bun test src/lib/providers/__tests__/claude-sdk.test.ts && bun run typecheck
```

**depends-on:** Groups 3, 5, 7

---

### Group 12: Integration Tests — Full Lifecycle

**Goal:** End-to-end tests covering spawn → query → events → session → resume → interrupt → shutdown.

**Deliverables:**
1. `src/__tests__/sdk-integration.test.ts` — New file: integration test suite:
   - Test: spawn SDK agent from directory, verify events emitted
   - Test: multi-turn stateful session (create, send 3 messages, verify context preservation)
   - Test: session resume after close (resume, send follow-up, verify context)
   - Test: session fork (fork at message 2, diverge, verify independent histories)
   - Test: interrupt mid-query (start long task, interrupt, verify graceful stop)
   - Test: concurrent Omni bridge sessions (3 chats, parallel delivery, no blocking)
   - Test: budget enforcement (set $0.01 budget, run until exceeded, verify clean stop)
   - Test: full directory config roundtrip (add agent with all SDK options, spawn, verify)
   - Test: custom tool execution (define tool, agent calls it, verify result)
   - Test: MCP server connection (configure stdio MCP, verify tools available)
2. Mock strategy: use a minimal SDK mock that simulates message streams for predictable testing (avoid hitting real API in CI).

**Acceptance Criteria:**
- [ ] All integration tests pass in CI
- [ ] Tests cover the 10 scenarios listed above
- [ ] Tests use mocks for SDK API (no real API calls in CI)

**Validation:**
```bash
bun test src/__tests__/sdk-integration.test.ts && bun run typecheck && bun run lint && bun run dead-code
```

**depends-on:** Groups 1–11

---

### Group 13: Frontmatter + PG Persistence Layer for SDK Config

**Goal:** Make AGENTS.md frontmatter the source of truth for SDK configuration, with PG as the runtime cache. A `git clone` + `genie dir sync` reconstructs the exact agent directory.

**Deliverables:**
1. `src/lib/frontmatter.ts` — Extend `AgentFrontmatterSchema` with `sdk` field. The `sdk:` block is a nested YAML object that maps 1:1 to `SdkDirectoryConfig`. Add `'claude-sdk'` to `providerValues`. Example frontmatter after this change:
   ```yaml
   ---
   name: senior-engineer
   description: "Senior engineer with full tool access"
   model: opus
   provider: claude-sdk
   promptMode: system
   color: green
   sdk:
     permissionMode: acceptEdits
     tools: [Read, Glob, Grep, Bash, Edit, Write]
     allowedTools: [Read, Glob, Grep]
     effort: high
     maxBudgetUsd: 10.00
     maxTurns: 100
     enableFileCheckpointing: true
     persistSession: true
     mcpServers:
       github:
         command: npx
         args: ["-y", "@modelcontextprotocol/server-github"]
     agents:
       researcher:
         description: "Quick codebase research"
         tools: [Read, Glob, Grep]
         model: haiku
         effort: low
     systemPrompt: "You are a senior engineer at Namastex."
   ---
   ```
2. `src/lib/frontmatter.ts` — The `sdk` field uses a permissive Zod schema (`.passthrough()` on the sdk object) so that new SDK options don't require frontmatter parser updates. Known fields are validated, unknown fields are preserved with a warning.
3. `src/lib/agent-sync.ts` — Update `syncSingleAgent()` to pass `fm.sdk` to `directory.add()` and `directory.edit()`. The sync reads AGENTS.md frontmatter and writes the full `sdk` block into PG `agents.metadata` JSONB under the `sdk` key.
4. `src/lib/agent-directory.ts` — Ensure `buildMetadata()` includes `entry.sdk` in the PG metadata JSONB. Ensure `roleToEntry()` reads `metadata.sdk` back into `DirectoryEntry.sdk`.
5. `src/db/migrations/025_sdk_metadata_index.sql` — New migration: add GIN index on `metadata->'sdk'` for efficient SDK-specific queries (e.g., "find all agents with maxBudgetUsd > 5").
6. Tests: frontmatter with `sdk:` block parses correctly, round-trips through PG, handles unknown fields gracefully.

**Acceptance Criteria:**
- [ ] AGENTS.md with `sdk:` block parses into `SdkDirectoryConfig` via `parseFrontmatter()`
- [ ] `genie dir sync` reads frontmatter and populates PG metadata with full SDK config
- [ ] `directory.resolve()` returns `DirectoryEntry` with `.sdk` populated from PG
- [ ] Unknown fields in `sdk:` block are preserved (not dropped) with a warning
- [ ] PG migration adds index without data loss

**Validation:**
```bash
bun test src/lib/frontmatter.test.ts && bun test src/lib/agent-sync.test.ts && bun test src/lib/agent-directory.test.ts && bun run typecheck
```

**depends-on:** Group 2 (SdkDirectoryConfig types)

---

### Group 14: Bidirectional Frontmatter Sync + Workspace Reconstruction

**Goal:** When `genie dir edit` updates PG, write the changes back to AGENTS.md frontmatter. When `genie dir sync` runs on a fresh clone, reconstruct the full agent directory from frontmatter.

**Deliverables:**
1. `src/lib/frontmatter-writer.ts` — New file: `writeFrontmatter(filePath: string, updates: Partial<AgentFrontmatter>): void` function. Reads existing AGENTS.md, merges updated frontmatter fields into the YAML block (preserving unknown fields and markdown body), writes back. If no frontmatter exists, creates the `---` block at the top.
2. `src/lib/frontmatter-writer.ts` — `serializeSdkConfig(sdk: SdkDirectoryConfig): Record<string, unknown>` — serializes the SDK config to a YAML-friendly object. Handles nested structures (mcpServers, agents, hooks) correctly. Omits fields that are `undefined` or default values.
3. `src/lib/agent-directory.ts` — Update `edit()` function: after writing to PG, if the agent has a `dir` with an AGENTS.md file, call `writeFrontmatter()` to sync changes back. This makes `genie dir edit my-agent --sdk-max-budget 5` update both PG AND the AGENTS.md file.
4. `src/term-commands/dir.ts` — Add `genie dir export <name> [--stdout]` command: prints the full AGENTS.md frontmatter for an agent (reading from PG). Useful for debugging and for reconstructing frontmatter from PG state.
5. `src/lib/agent-sync.ts` — Update `syncAllAgents()` to handle the full SDK config on both fresh registration and update paths. The change detection (`needsUpdate`) must compare `sdk` configs deeply (JSON equality), not just top-level fields.
6. `src/term-commands/dir.ts` — Update `genie dir sync` help text to document: "Reconstructs agent directory from AGENTS.md frontmatter. Use after `git clone` to restore exact agent configuration."
7. Tests:
   - Edit PG via `genie dir edit` → verify AGENTS.md frontmatter updated
   - Clone repo with AGENTS.md → `genie dir sync` → verify PG has exact same SDK config
   - Round-trip: edit frontmatter manually → sync → edit via CLI → verify frontmatter matches
   - Preserve unknown fields: add custom YAML key to frontmatter, sync, verify it's preserved

**Acceptance Criteria:**
- [ ] `genie dir edit my-agent --sdk-max-budget 5` updates AGENTS.md frontmatter file
- [ ] Fresh `git clone` + `genie dir sync` produces identical PG state to the original workspace
- [ ] Manual frontmatter edits are picked up by `genie dir sync` and written to PG
- [ ] Unknown YAML fields in frontmatter are preserved through edit cycles
- [ ] `genie dir export my-agent` outputs valid AGENTS.md frontmatter from PG state

**Validation:**
```bash
bun test src/lib/frontmatter-writer.test.ts && bun test src/lib/agent-sync.test.ts && bun test src/term-commands/dir.test.ts && bun run typecheck
```

**depends-on:** Groups 2, 4, 13

---

## QA Criteria

_What must be verified on dev after merge._

- [ ] `genie spawn <agent> --provider claude-sdk` executes a basic task and completes
- [ ] `genie sdk sessions list` shows the session from above
- [ ] `genie sdk send <agent> "follow-up"` sends a second turn with context
- [ ] `genie events list --since 5m` shows SDK events from the session
- [ ] `genie spawn <agent> --provider claude-sdk --stream` shows live output
- [ ] Omni bridge with `--executor sdk` handles concurrent WhatsApp messages
- [ ] Existing `--provider claude` (tmux) and `--provider codex` are unaffected
- [ ] AGENTS.md with `sdk:` frontmatter → `genie dir sync` → `genie dir show` shows full config
- [ ] `genie dir edit <agent> --sdk-max-budget 5` updates both PG and AGENTS.md
- [ ] Fresh clone + `genie dir sync` reconstructs identical agent directory
- [ ] `bun test` — all tests pass
- [ ] `bun run typecheck && bun run lint && bun run dead-code` — all clean

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| V2 API (`unstable_v2_*`) has breaking changes before stabilization | High | Pin SDK version, wrap V2 calls in abstraction layer, fall back to V1 if needed |
| `bypassPermissions` + PreToolUse hooks — SDK bug could skip hooks | Medium | Document as known assumption; add integration test that verifies hooks fire under bypassPermissions |
| In-process agents share Node.js event loop — one bad agent can starve others | Medium | Per-session worker queue (Group 1); document that heavyweight agents should use tmux provider |
| 42k token SDK type surface — some Options may not work as documented | Low | Integration tests verify critical paths; non-critical options degrade gracefully |
| Custom tool handler paths may have security implications (arbitrary code execution) | Medium | Validate handler paths are within allowed directories; document security model |
| Frontmatter write-back could corrupt AGENTS.md if concurrent edits happen | Medium | Use atomic write (write to .tmp then rename); preserve markdown body and unknown YAML fields |
| Deep SDK config comparison for sync change detection is expensive for large configs | Low | JSON.stringify comparison is fast enough; complex configs are rare in practice |
| PG JSONB index on `metadata->'sdk'` adds write overhead | Low | GIN index is sparse; only agents with SDK config are indexed |

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
# New files
src/lib/sdk-directory-types.ts              — SdkDirectoryConfig type definitions
src/lib/providers/claude-sdk-events.ts      — SDKMessage → genie events router
src/lib/providers/claude-sdk-stream.ts      — Streaming output formatter
src/lib/providers/claude-sdk-tools.ts       — Custom tool loader via MCP
src/lib/frontmatter-writer.ts               — Bidirectional frontmatter write-back
src/services/sdk-session-manager.ts         — V2 stateful session manager
src/term-commands/sdk.ts                    — genie sdk CLI namespace
src/db/migrations/025_sdk_metadata_index.sql — GIN index on metadata->'sdk'

# New test files
src/lib/providers/__tests__/claude-sdk-events.test.ts
src/lib/providers/__tests__/claude-sdk-stream.test.ts
src/lib/providers/__tests__/claude-sdk-tools.test.ts
src/lib/__tests__/frontmatter-writer.test.ts
src/services/__tests__/sdk-session-manager.test.ts
src/term-commands/__tests__/sdk.test.ts
src/__tests__/sdk-integration.test.ts

# Modified files (from PR #1030 base)
src/lib/agent-directory.ts                  — Add sdk field to DirectoryEntry + write-back on edit
src/lib/frontmatter.ts                      — Extend schema with sdk: block + claude-sdk provider
src/lib/agent-sync.ts                       — Pass sdk config through sync pipeline + deep comparison
src/lib/providers/claude-sdk.ts             — Full Options translation
src/lib/providers/claude-sdk-permissions.ts — Unified resolver export
src/services/executors/claude-sdk.ts        — Concurrent delivery + V2 sessions
src/services/omni-bridge.ts                 — Wire event routing
src/term-commands/agents.ts                 — Full sdk config passthrough
src/term-commands/agent/spawn.ts            — SDK spawn flags
src/term-commands/dir.ts                    — SDK CLI flags + convenience commands + dir export
src/term-commands/omni.ts                   — (minor: wire config)
```
