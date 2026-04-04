# Claude Agent SDK Executor — Practical Guide

> **PR #1033** · `feat/sdk-executor-full` · 5,655 insertions across 34 files

This guide covers everything you need to configure, run, and debug agents using the Claude Agent SDK executor in Genie.

---

## Table of Contents

1. [Quick Start](#1-quick-start)
2. [AGENTS.md Configuration Reference](#2-agentsmd-configuration-reference)
3. [CLI Commands](#3-cli-commands)
4. [Config Priority & Layering](#4-config-priority--layering)
5. [Permission Model](#5-permission-model)
6. [Streaming Output](#6-streaming-output)
7. [Event Routing & Audit](#7-event-routing--audit)
8. [Architecture Overview](#8-architecture-overview)
9. [SDK Coverage Report](#9-sdk-coverage-report)
10. [Troubleshooting](#10-troubleshooting)

---

## 1. Quick Start

### Register an SDK agent

```bash
# Method 1: Via AGENTS.md frontmatter (recommended — version-controlled)
cat > agents/my-agent/AGENTS.md << 'EOF'
---
name: my-agent
description: A code review agent
model: sonnet
provider: claude-sdk
sdk:
  maxTurns: 20
  effort: high
  permissionMode: acceptEdits
  thinking:
    type: adaptive
  systemPrompt: "You are an expert code reviewer."
---

# My Agent

This agent reviews code for quality, security, and maintainability.
EOF

# Sync to PG
genie dir sync

# Method 2: Via CLI (good for prototyping)
genie dir add my-agent \
  --dir ./agents/my-agent \
  --provider claude-sdk \
  --sdk-max-turns 20 \
  --sdk-effort high \
  --sdk-permission-mode acceptEdits \
  --sdk-thinking adaptive \
  --sdk-system-prompt "You are an expert code reviewer."
```

### Spawn the agent

```bash
# Basic spawn
genie spawn my-agent

# Spawn with runtime overrides (these override the directory config)
genie spawn my-agent \
  --sdk-max-turns 10 \
  --sdk-max-budget 2.0 \
  --sdk-effort medium

# Spawn with streaming output
genie spawn my-agent --sdk-stream
```

### Inspect the config

```bash
# Show what's stored in PG
genie dir show my-agent

# Export back to AGENTS.md (PG → disk sync)
genie dir export my-agent
```

---

## 2. AGENTS.md Configuration Reference

The `sdk:` block in AGENTS.md frontmatter maps 1:1 to the Claude Agent SDK's `Options` type. Only serializable fields are supported (no callbacks, AbortControllers, or spawn functions).

### Full Example

```yaml
---
name: research-agent
description: Deep research agent with MCP tools
model: opus
provider: claude-sdk
color: blue
sdk:
  # === Limits ===
  maxTurns: 50                    # Max agentic turns (tool-use round trips)
  maxBudgetUsd: 10.0              # Hard USD budget cap
  effort: high                    # low | medium | high | max

  # === Permissions ===
  permissionMode: acceptEdits     # default | acceptEdits | bypassPermissions | plan | dontAsk | auto

  # === Tools ===
  tools:                          # Available tool set
    - Read
    - Write
    - Edit
    - Bash
    - Glob
    - Grep
    - WebFetch
    - WebSearch
  allowedTools:                   # Auto-approved (no prompting)
    - Read
    - Glob
    - Grep
  disallowedTools:                # Always denied (overrides everything)
    - NotebookEdit

  # === Thinking ===
  thinking:
    type: adaptive                # adaptive | enabled | disabled
    # For 'enabled' type:
    # type: enabled
    # budgetTokens: 10000

  # === System Prompt ===
  systemPrompt: "You are a research specialist."
  # Or use Claude Code's default prompt + append:
  # systemPrompt:
  #   type: preset
  #   preset: claude_code
  #   append: "Also consider security implications."

  # === MCP Servers ===
  mcpServers:
    github:
      command: npx
      args: ["-y", "@modelcontextprotocol/server-github"]
      env:
        GITHUB_TOKEN: "${GITHUB_TOKEN}"
    postgres:
      type: stdio
      command: npx
      args: ["-y", "@modelcontextprotocol/server-postgres", "${DATABASE_URL}"]
    remote-api:
      type: sse
      url: "https://mcp.example.com/sse"
      headers:
        Authorization: "Bearer ${API_KEY}"
    http-service:
      type: http
      url: "https://mcp.example.com/api"

  # === Subagents ===
  agents:
    reviewer:
      description: "Code reviewer with read-only access"
      prompt: "You review code for quality and security."
      tools: [Read, Glob, Grep]
      model: sonnet
      maxTurns: 10
    researcher:
      description: "Web research agent"
      prompt: "You find information online."
      tools: [WebFetch, WebSearch, Read]
      model: haiku

  # === Plugins ===
  plugins:
    - type: local
      path: ./plugins/my-custom-plugin

  # === Output ===
  outputFormat:
    type: json_schema
    schema:
      type: object
      properties:
        analysis:
          type: string
        severity:
          type: string
          enum: [low, medium, high, critical]
      required: [analysis, severity]

  # === Streaming & Events ===
  includePartialMessages: true    # Include partial/streaming message events
  includeHookEvents: false        # Include hook lifecycle events
  promptSuggestions: true         # Emit prompt suggestions after turns
  agentProgressSummaries: true    # Periodic progress summaries for subagents

  # === Session ===
  persistSession: true            # Persist to disk (default: true)
  enableFileCheckpointing: true   # Track file changes for rewinding

  # === Sandbox ===
  sandbox:
    enabled: true
    autoAllowBashIfSandboxed: true
    network:
      allowLocalBinding: true
      allowUnixSockets:
        - /var/run/docker.sock

  # === Advanced ===
  betas:
    - context-1m-2025-08-07
  settingSources:
    - user
    - project
  settings: /path/to/custom-settings.json
---
```

### Field Reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `maxTurns` | `number` | unlimited | Max tool-use round trips |
| `maxBudgetUsd` | `number` | unlimited | Hard USD budget limit |
| `effort` | `low\|medium\|high\|max` | `high` | Reasoning depth |
| `permissionMode` | `string` | `default` | Permission enforcement level |
| `tools` | `string[]` | all | Available tool names |
| `allowedTools` | `string[]` | `[]` | Auto-approved tools |
| `disallowedTools` | `string[]` | `[]` | Always-denied tools |
| `thinking` | `object` | `{type: adaptive}` | Reasoning behavior |
| `systemPrompt` | `string\|object` | minimal | System prompt |
| `mcpServers` | `Record<name, config>` | `{}` | MCP server definitions |
| `agents` | `Record<name, config>` | `{}` | Subagent definitions |
| `plugins` | `SdkPluginConfig[]` | `[]` | Local plugins |
| `outputFormat` | `{type, schema}` | none | Structured output schema |
| `sandbox` | `object` | disabled | Sandbox isolation settings |
| `persistSession` | `boolean` | `true` | Disk persistence |
| `enableFileCheckpointing` | `boolean` | `false` | File change tracking |
| `includePartialMessages` | `boolean` | `false` | Stream events |
| `includeHookEvents` | `boolean` | `false` | Hook events in output |
| `promptSuggestions` | `boolean` | `false` | Prompt suggestions |
| `agentProgressSummaries` | `boolean` | `false` | Subagent progress |
| `betas` | `string[]` | `[]` | Beta feature flags |
| `settingSources` | `string[]` | `[]` | Settings file sources |
| `settings` | `string\|object` | none | Additional settings |

---

## 3. CLI Commands

### `genie dir add` — Register a new agent

```bash
genie dir add <name> --dir <path> --provider claude-sdk [--sdk-* options]
```

All `--sdk-*` flags mirror the AGENTS.md frontmatter fields:

| Flag | Maps to | Example |
|------|---------|---------|
| `--sdk-max-turns <n>` | `sdk.maxTurns` | `--sdk-max-turns 20` |
| `--sdk-max-budget <usd>` | `sdk.maxBudgetUsd` | `--sdk-max-budget 5.0` |
| `--sdk-effort <level>` | `sdk.effort` | `--sdk-effort high` |
| `--sdk-permission-mode <mode>` | `sdk.permissionMode` | `--sdk-permission-mode acceptEdits` |
| `--sdk-tools <list>` | `sdk.tools` | `--sdk-tools "Read,Write,Bash"` |
| `--sdk-allowed-tools <list>` | `sdk.allowedTools` | `--sdk-allowed-tools "Read,Glob"` |
| `--sdk-disallowed-tools <list>` | `sdk.disallowedTools` | `--sdk-disallowed-tools "NotebookEdit"` |
| `--sdk-thinking <config>` | `sdk.thinking` | `--sdk-thinking adaptive` |
| `--sdk-system-prompt <text>` | `sdk.systemPrompt` | `--sdk-system-prompt "You are..."` |
| `--sdk-mcp-server <spec>` | `sdk.mcpServers` | `--sdk-mcp-server "gh:npx:@mcp/gh"` (repeatable) |
| `--sdk-subagent <spec>` | `sdk.agents` | `--sdk-subagent 'name:{"description":"...","prompt":"..."}'` (repeatable) |
| `--sdk-plugin <path>` | `sdk.plugins` | `--sdk-plugin ./my-plugin` (repeatable) |
| `--sdk-sandbox` | `sdk.sandbox.enabled` | `--sdk-sandbox` |
| `--sdk-persist-session` | `sdk.persistSession` | `--sdk-persist-session` |
| `--no-sdk-persist-session` | `sdk.persistSession=false` | `--no-sdk-persist-session` |
| `--sdk-file-checkpointing` | `sdk.enableFileCheckpointing` | `--sdk-file-checkpointing` |
| `--sdk-stream-partial` | `sdk.includePartialMessages` | `--sdk-stream-partial` |
| `--sdk-hook-events` | `sdk.includeHookEvents` | `--sdk-hook-events` |
| `--sdk-prompt-suggestions` | `sdk.promptSuggestions` | `--sdk-prompt-suggestions` |
| `--sdk-progress-summaries` | `sdk.agentProgressSummaries` | `--sdk-progress-summaries` |
| `--sdk-betas <list>` | `sdk.betas` | `--sdk-betas "context-1m-2025-08-07"` |
| `--sdk-output-format <path>` | `sdk.outputFormat` | `--sdk-output-format ./schema.json` |
| `--sdk-agent <name>` | `sdk.agent` | `--sdk-agent reviewer` |

### `genie dir edit` — Update an existing agent

```bash
# Change just the effort level
genie dir edit my-agent --sdk-effort max

# Add a budget limit
genie dir edit my-agent --sdk-max-budget 5.0

# Changes sync back to AGENTS.md automatically
```

### `genie dir show` — Inspect agent config

```bash
genie dir show my-agent
# Shows all fields including full SDK config
```

### `genie dir export` — Write PG state back to frontmatter

```bash
genie dir export my-agent
# Updates agents/<name>/AGENTS.md with current PG state
```

### `genie spawn` — Run an agent

```bash
# Basic spawn
genie spawn my-agent

# Runtime overrides (highest priority — beats directory config)
# Override directory maxTurns
# Override directory maxBudgetUsd
# Override directory effort
# Enable streaming output
genie spawn my-agent \
  --sdk-max-turns 10 \
  --sdk-max-budget 2.0 \
  --sdk-effort medium \
  --sdk-stream
```

---

## 4. Config Priority & Layering

When an agent spawns, the SDK `Options` are built from **three layers** (lowest to highest priority):

```
┌─────────────────────────────────────────────────┐
│ Layer 3: Permission Hooks (always merged)        │  ← never overwritten
├─────────────────────────────────────────────────┤
│ Layer 2: Runtime overrides (--sdk-* spawn flags) │  ← highest data priority
├─────────────────────────────────────────────────┤
│ Layer 1: Directory config (AGENTS.md → PG)       │  ← base config
├─────────────────────────────────────────────────┤
│ Layer 0: SpawnContext (cwd, model)                │  ← lowest priority
└─────────────────────────────────────────────────┘
```

### Example

```yaml
# AGENTS.md (Layer 1 — directory config)
sdk:
  maxTurns: 100
  effort: high
  maxBudgetUsd: 20.0
```

```bash
# Spawn with override (Layer 2 — runtime)
genie spawn my-agent --sdk-max-turns 50
```

**Result:** SDK sees `maxTurns=50` (Layer 2 wins), `effort=high` (Layer 1 survives), `maxBudgetUsd=20.0` (Layer 1 survives).

### How it works internally

```typescript
// In ClaudeSdkProvider.runQuery():
const options: Options = {
  cwd: ctx.cwd,                        // Layer 0: context
  ...(ctx.model && { model: ctx.model }),
  ...translateSdkConfig(sdkConfig),      // Layer 1: directory
  ...extraOptions,                       // Layer 2: runtime (overwrites Layer 1)
  ...(hasHooks && { hooks: mergedHooks }),// Layer 3: hooks (merged, never overwritten)
};
```

---

## 5. Permission Model

Genie uses an **allowlist-only** permission model, enforced via SDK `PreToolUse` hooks. This is more restrictive than the SDK's default — if a tool isn't in the allow list, it's denied.

### Presets

| Preset | Allowed Tools |
|--------|--------------|
| `full` | `['*']` — everything |
| `read-only` | `['Read', 'Glob', 'Grep', 'WebFetch']` |
| `chat-only` | `['SendMessage', 'Read']` |

### Configure in AGENTS.md

```yaml
---
name: safe-agent
provider: claude-sdk
permissions:
  preset: read-only
  # Or explicit allow list:
  # allow: [Read, Glob, Grep, Bash]
  # bashAllowPatterns:
  #   - "^git (status|log|diff)"
  #   - "^bun test"
---
```

### Bash Pattern Matching

When `Bash` is in the allow list, commands are further restricted by `bashAllowPatterns`:

```yaml
permissions:
  allow: [Read, Glob, Grep, Bash]
  bashAllowPatterns:
    - "^git (status|log|diff|branch)"    # Git read-only commands
    - "^bun (test|run typecheck)"        # Build/test commands
    - "^ls"                               # Directory listing
    - "^cat"                              # File reading
```

**Rules:**
- Compound commands (`&&`, `||`, `|`, `;`) must match the **full** regex
- Simple commands match via substring or regex
- No patterns defined = all Bash commands allowed

---

## 6. Streaming Output

Stream SDK messages in real-time as the agent works:

```bash
# Text format (default) — human-readable
genie spawn my-agent --sdk-stream
# Output: "Hello, I'll review the code..."
#         "✓ Result — Turns: 5 · Cost: $0.0500 · Tokens: 100in/50out"

# JSON format — pretty-printed per message
genie spawn my-agent --sdk-stream --stream-format json
# Output: { "type": "assistant", "message": { ... } }

# NDJSON format — one JSON line per message (for piping)
genie spawn my-agent --sdk-stream --stream-format ndjson
# Output: {"type":"assistant","message":{...}}
#         {"type":"result","subtype":"success",...}
```

### What gets streamed

| Message Type | Text Format | JSON/NDJSON |
|-------------|-------------|-------------|
| `assistant` | Text content | Full message |
| `result/success` | Summary with cost/tokens | Full result |
| `result/error` | Red error with details | Full result |
| `system/init` | Model + version info | Full message |
| `system/status` | Status text | Full message |
| `tool_progress` | Tool name + elapsed time | Full message |
| `tool_use_summary` | Summary text | Full message |
| `stream_event` | Delta text | Full event |
| Others | Skipped | Full message |

---

## 7. Event Routing & Audit

Every SDK message is automatically routed to genie's audit system as a structured event. This happens **fire-and-forget** — it never blocks the agent's execution.

### Event Type Mapping

All 24 SDKMessage types map to `sdk.*` audit events:

| SDK Message | Audit Event | Details Captured |
|------------|-------------|-----------------|
| `assistant` | `sdk.assistant.message` | Text preview (200 chars) |
| `result/success` | `sdk.result.success` | Cost, turns, duration, tokens |
| `result/error_*` | `sdk.result.error` | Error messages |
| `result/error_max_turns` | `sdk.result.max_turns` | Turn count |
| `result/error_max_budget` | `sdk.result.max_budget` | Budget spent |
| `system/init` | `sdk.system` | Model, version, tools, cwd |
| `system/api_retry` | `sdk.api.retry` | Attempt, delay, error |
| `system/compact_boundary` | `sdk.context.compacted` | Trigger, token counts |
| `system/hook_*` | `sdk.hook.*` | Hook name, outcome |
| `system/task_*` | `sdk.task.*` | Task ID, description |
| `tool_progress` | `sdk.tool.progress` | Tool name, elapsed time |
| `tool_use_summary` | `sdk.tool.summary` | Summary text |
| `rate_limit_event` | `sdk.rate_limit` | Status, utilization |
| `auth_status` | `sdk.auth.status` | Auth state |
| `prompt_suggestion` | `sdk.prompt.suggestion` | Suggestion text |
| `user` | `sdk.user.message` | isReplay flag |

### Querying audit events

```bash
# View recent SDK events for an agent
genie events timeline <agent-id> --type sdk_message

# Error patterns
genie events errors --type sdk_message
```

---

## 8. Architecture Overview

### Data Flow

```
AGENTS.md frontmatter (source of truth)
    │
    ▼ parseFrontmatter()
AgentFrontmatter { sdk: Record<string, unknown> }
    │
    ▼ agent-sync.ts → directory.add()/edit()
PG agents.metadata JSONB { sdk: SdkDirectoryConfig }
    │
    ▼ directory.resolve() → roleToEntry()
DirectoryEntry { sdk: SdkDirectoryConfig }
    │
    ▼ translateSdkConfig()
Partial<Options>
    │
    ▼ ClaudeSdkProvider.runQuery() — config layering
Final SDK Options
    │
    ▼ query({ prompt, options })
AsyncGenerator<SDKMessage>
    │
    ├──▶ routeSdkMessage() → audit DB (fire-and-forget)
    ├──▶ formatSdkMessage() → streaming output (if --stream)
    └──▶ result collection → final answer
```

### Bidirectional Sync

```
AGENTS.md ──parseFrontmatter()──▶ PG (via genie dir sync)
AGENTS.md ◀──writeFrontmatter()── PG (via genie dir edit / genie dir export)
```

**Invariant:** `git clone` + `genie dir sync` reconstructs identical agent workspaces.

### File Map

```
src/lib/
├── sdk-directory-types.ts          # Type definitions (SdkDirectoryConfig, etc.)
├── agent-directory.ts              # DirectoryEntry.sdk field + PG CRUD
├── frontmatter.ts                  # YAML parsing (sdk: block)
├── frontmatter-writer.ts           # YAML writing (PG → AGENTS.md)
├── agent-sync.ts                   # Frontmatter → PG sync
├── providers/
│   ├── claude-sdk.ts               # ExecutorProvider + translateSdkConfig()
│   ├── claude-sdk-events.ts        # SDKMessage → audit event routing
│   ├── claude-sdk-stream.ts        # Stream formatting (text/json/ndjson)
│   └── claude-sdk-permissions.ts   # Permission gate + presets
src/services/executors/
│   └── claude-sdk.ts               # Omni executor bridge
src/term-commands/
│   ├── dir.ts                      # genie dir --sdk-* CLI flags
│   ├── agents.ts                   # Spawn pipeline (runSdkQuery)
│   └── agent/spawn.ts              # genie spawn --sdk-* flags
src/db/migrations/
│   └── 025_sdk_metadata_index.sql  # GIN index on metadata->'sdk'
```

---

## 9. SDK Coverage Report

### Comparison: Our Implementation vs Claude Agent SDK v0.2.92

#### ✅ Options Fields We Cover (23/40+ serializable fields)

| Field | Status | Notes |
|-------|--------|-------|
| `permissionMode` | ✅ | All 6 modes |
| `effort` | ✅ | low/medium/high/max + numeric |
| `tools` | ✅ | String array or preset |
| `allowedTools` | ✅ | |
| `disallowedTools` | ✅ | |
| `maxTurns` | ✅ | |
| `maxBudgetUsd` | ✅ | |
| `thinking` | ✅ | adaptive/enabled/disabled |
| `agents` | ✅ | Full subagent config |
| `mcpServers` | ✅ | stdio/sse/http |
| `plugins` | ✅ | Local plugins |
| `persistSession` | ✅ | |
| `enableFileCheckpointing` | ✅ | |
| `outputFormat` | ✅ | json_schema |
| `includePartialMessages` | ✅ | |
| `includeHookEvents` | ✅ | |
| `promptSuggestions` | ✅ | |
| `agentProgressSummaries` | ✅ | |
| `systemPrompt` | ✅ | String or preset+append |
| `sandbox` | ✅ | Partial (see gaps) |
| `betas` | ✅ | |
| `settingSources` | ✅ | user/project/local |
| `settings` | ✅ | Path or inline object |

#### ⚠️ Serializable Fields We DON'T Cover Yet (follow-up)

| Field | Why Missing | Priority |
|-------|------------|----------|
| `fallbackModel` | Not in scope for v1 | LOW — nice-to-have |
| `additionalDirectories` | Not in scope for v1 | LOW |
| `strictMcpConfig` | Not in scope for v1 | LOW |
| `toolConfig` | askUserQuestion previewFormat | LOW |
| `debug` / `debugFile` | Runtime-only | LOW |

#### 🚫 Non-Serializable Fields (Correctly Excluded)

These cannot be stored in JSONB and are correctly omitted from `SdkDirectoryConfig`:

| Field | Reason |
|-------|--------|
| `abortController` | Runtime object |
| `canUseTool` | Callback function |
| `spawnClaudeCodeProcess` | Callback function |
| `stderr` | Callback function |
| `env` | Runtime environment |
| `executable` / `executableArgs` | Runtime config |

#### 🔧 Sandbox Config Gaps

Our `SdkSandboxConfig` covers the essentials but is missing some SDK fields:

| Field | Our Status | SDK Has |
|-------|-----------|---------|
| `enabled` | ✅ | ✅ |
| `autoAllowBashIfSandboxed` | ✅ | ✅ |
| `failIfUnavailable` | ✅ | ❌ (ours extra) |
| `network.allowLocalBinding` | ✅ | ✅ |
| `network.allowUnixSockets` | ✅ | ✅ |
| `network.allowedDomains` | ❌ | ✅ |
| `network.allowManagedDomainsOnly` | ❌ | ✅ |
| `network.allowAllUnixSockets` | ❌ | ✅ |
| `network.httpProxyPort` | ❌ | ✅ |
| `network.socksProxyPort` | ❌ | ✅ |
| `filesystem` | ❌ | ✅ (allowWrite, denyWrite, denyRead) |
| `excludedCommands` | ❌ | ✅ |
| `allowUnsandboxedCommands` | ❌ | ✅ |
| `ignoreViolations` | ❌ | ✅ |
| `enableWeakerNestedSandbox` | ❌ | ✅ |
| `ripgrep` | ❌ | ✅ |

**Impact:** LOW — the missing sandbox fields are advanced features. The essentials (`enabled`, `autoAllowBashIfSandboxed`, basic network) are covered. A follow-up PR can add the remaining fields to `SdkSandboxConfig` without breaking changes.

#### 🔧 Query Interface Methods

We wrap 5 of 17 Query control methods:

| Method | Status | Notes |
|--------|--------|-------|
| `interrupt()` | ✅ | |
| `setPermissionMode()` | ✅ | |
| `setModel()` | ✅ | |
| `return()` | ✅ | |
| `throw()` | ✅ | |
| `rewindFiles()` | ❌ | Wave 3 — V2 sessions |
| `initializationResult()` | ❌ | Wave 3 |
| `supportedCommands()` | ❌ | Wave 4 |
| `supportedModels()` | ❌ | Wave 4 |
| `supportedAgents()` | ❌ | Wave 4 |
| `mcpServerStatus()` | ❌ | Wave 4 |
| `accountInfo()` | ❌ | Wave 4 |
| `reconnectMcpServer()` | ❌ | Wave 4 |
| `toggleMcpServer()` | ❌ | Wave 4 |
| `setMcpServers()` | ❌ | Wave 4 |
| `streamInput()` | ❌ | Wave 4 |
| `stopTask()` | ❌ | Wave 4 |

**Impact:** MEDIUM — the 5 wrapped methods cover the essential control surface. The remaining methods enable advanced runtime control (MCP management, file rewinding, introspection) and are planned for Waves 3-4.

#### SDKMessage Coverage: 24/24 ✅

All message types are handled in event routing and stream formatting.

---

## 10. Troubleshooting

### Agent won't spawn with SDK provider

```bash
# Check if provider is set
genie dir show my-agent | grep provider
# Should show: provider: claude-sdk

# Check if SDK package is installed
bun pm ls | grep claude-agent-sdk
```

### Config not taking effect

```bash
# Verify what PG has
genie dir show my-agent

# Compare with AGENTS.md
cat agents/my-agent/AGENTS.md

# Force re-sync from frontmatter
genie dir sync

# Check priority — spawn flags always win
genie spawn my-agent --sdk-max-turns 5  # This overrides directory config
```

### Permission denied for a tool

```bash
# Check the permission config
genie dir show my-agent | grep -A5 permissions

# The agent uses allowlist-only permissions
# Add the tool to the allow list:
genie dir edit my-agent --sdk-allowed-tools "Read,Glob,Grep,Bash"
```

### Budget or turn limit hit

The SDK returns specific error subtypes:
- `sdk.result.max_turns` — increase `maxTurns`
- `sdk.result.max_budget` — increase `maxBudgetUsd`

```bash
# Check audit for the error
genie events errors --type sdk_message

# Increase limits
genie dir edit my-agent --sdk-max-turns 50 --sdk-max-budget 10.0
```

### Streaming shows nothing

```bash
# Ensure streaming is enabled at spawn time
genie spawn my-agent --sdk-stream

# Or enable partial messages in directory config
genie dir edit my-agent --sdk-stream-partial
```

---

## Recipes

### Read-only code analysis agent

```yaml
---
name: analyzer
provider: claude-sdk
model: sonnet
permissions:
  preset: read-only
sdk:
  maxTurns: 30
  effort: high
  thinking:
    type: adaptive
  systemPrompt: "Analyze code for bugs, security issues, and performance problems. Never modify files."
---
```

### Research agent with web access + MCP tools

```yaml
---
name: researcher
provider: claude-sdk
model: opus
sdk:
  maxTurns: 50
  maxBudgetUsd: 5.0
  effort: max
  tools: [Read, Glob, Grep, WebFetch, WebSearch]
  mcpServers:
    github:
      command: npx
      args: ["-y", "@modelcontextprotocol/server-github"]
  agents:
    fact-checker:
      description: Quick fact verification
      prompt: Verify claims using web search
      tools: [WebSearch, WebFetch]
      model: haiku
      maxTurns: 5
  systemPrompt: "You are a thorough researcher. Always cite sources."
---
```

### Budget-constrained haiku agent for quick tasks

```yaml
---
name: quick-helper
provider: claude-sdk
model: haiku
sdk:
  maxTurns: 10
  maxBudgetUsd: 0.50
  effort: low
  permissionMode: plan
  thinking:
    type: disabled
---
```

### Structured output agent (JSON schema enforcement)

```yaml
---
name: json-extractor
provider: claude-sdk
model: sonnet
sdk:
  maxTurns: 5
  effort: medium
  outputFormat:
    type: json_schema
    schema:
      type: object
      properties:
        entities:
          type: array
          items:
            type: object
            properties:
              name: { type: string }
              type: { type: string }
            required: [name, type]
      required: [entities]
---
```
