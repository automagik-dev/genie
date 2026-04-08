# Wish: Claude Agent SDK Executor Provider

## Summary

Add a new `claude-sdk` executor provider to genie that uses `@anthropic-ai/claude-agent-sdk` programmatically instead of spawning Claude Code CLI in tmux. This enables native tool permission enforcement per agent via the `canUseTool` callback — the foundation for the Sebrae/PagBank POC where WhatsApp-facing agents must be restricted (read-only, no bash, no file edits).

## Motivation

Today all genie executors run `claude --dangerously-skip-permissions` via tmux. Every agent has full, unrestricted access to all tools. This is a security blocker for:

- **Sebrae POC:** Agents answering WhatsApp questions about regulation must only read KB, not execute commands or edit files
- **PagBank POC:** Customer-facing agents must be sandboxed
- **Multi-tenant:** Any scenario where agents serve external users

The Claude Agent SDK provides programmatic `query()` with `canUseTool` callbacks that enforce permissions at runtime — before every tool execution.

## Acceptance Criteria

1. New provider `claude-sdk` registered in `ProviderName` and executor registry
2. `genie spawn <agent> --provider claude-sdk` spawns using Agent SDK `query()` instead of tmux CLI
3. Permission enforcement via `canUseTool` callback that reads agent permission config
4. Permission config format: `allow`/`deny` tool lists + `bash_allow_patterns`/`bash_deny_patterns` (reuses existing `auto-approve.yaml` schema)
5. 3 built-in presets: `full` (all tools), `read-only` (Read/Glob/Grep), `chat-only` (SendMessage/Read)
6. Agent directory entries can specify `permissions.preset` or `permissions.allow`/`permissions.deny`
7. Streaming output via async iterator works (for future omni-bridge integration)
8. `maxTurns` and `maxBudgetUsd` configurable per agent
9. Tests: permission gate blocks denied tools, allows permitted tools, inspects Bash command params
10. SDK provider works as `IExecutor` for the omni-bridge (`src/services/executors/`)

## Non-Goals

- Replacing the tmux provider (it stays for interactive/dev use)
- Parameter-level restrictions for non-Bash tools (V2)
- Path-based file access restrictions (V2)
- UI/dashboard for managing permissions (V3)
- MCP tool integration with genie brain (separate wish)

## Technical Design

### Architecture

```
genie spawn --provider claude-sdk
    ↓
ClaudeSdkProvider.run(ctx, prompt)
    ↓
import { query } from '@anthropic-ai/claude-agent-sdk'
    ↓
query({
  prompt,
  options: {
    tools: permissions.allow,              // Layer 1: model visibility
    disallowedTools: permissions.deny,     // Layer 2: explicit blacklist
    canUseTool: permissionGate(config),    // Layer 3: runtime enforcement
    permissionMode: 'default',
    ...agentConfig
  }
})
    ↓
canUseTool callback checks every tool call:
  - Tool in deny list? → { behavior: 'deny', message }
  - Tool not in allow list? → { behavior: 'deny', message }
  - Bash command matches deny pattern? → { behavior: 'deny', message }
  - Otherwise → { behavior: 'allow' }
```

### Defense in Depth (3 layers)

1. **`tools: [...]`** — Controls what the model sees. Tools not listed don't exist in model context. Saves tokens.
2. **`disallowedTools: [...]`** — Belt-and-suspenders blacklist. Removed from context even if in `tools`.
3. **`canUseTool` callback** — THE REAL GATE. Called before every tool execution. Can inspect tool name + input params. Returns allow/deny. This is where genie enforces policy.

**Why not trust `options` alone?** The `canUseTool` callback is the enforcement layer we control. `tools`/`disallowedTools` are optimization (reduce what model attempts). The callback is security (blocks execution regardless).

### Permission Config

Reuse existing `auto-approve.yaml` schema from `src/lib/auto-approve.ts`:

```yaml
# In agent directory entry or .genie/permissions/<agent>.yaml
preset: read-only

# Or explicit:
allow: [Read, Glob, Grep, SendMessage]
deny: [Bash, Write, Edit, Agent, NotebookEdit]
bash_allow_patterns: ["^genie brain search"]
bash_deny_patterns: ["rm ", "DROP ", "DELETE "]
```

Presets:

| Preset | allow | deny |
|--------|-------|------|
| `full` | all | none |
| `read-only` | Read, Glob, Grep, WebFetch | Bash, Write, Edit, Agent, NotebookEdit |
| `chat-only` | SendMessage, Read | everything else |

### Key Types

```typescript
// From @anthropic-ai/claude-agent-sdk
type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: { signal: AbortSignal, toolUseID: string, agentID?: string, ... }
) => Promise<PermissionResult>;

type PermissionResult =
  | { behavior: 'allow', updatedInput?: Record<string, unknown> }
  | { behavior: 'deny', message: string, interrupt?: boolean };
```

### Session Strategy

- **Stateless (default for omni):** `persistSession: false` — each message is a fresh query
- **Per-chat sessions (for conversations):** persist session ID per chat, resume on next message
- Configurable via agent config

---

## Execution Groups

### Group 1: Core Provider + Permission Gate

**depends-on:** none

**Files:**

| File | Action |
|------|--------|
| `src/lib/providers/claude-sdk.ts` | CREATE — ClaudeSdkProvider implementing ExecutorProvider |
| `src/lib/providers/claude-sdk-permissions.ts` | CREATE — createPermissionGate() factory, preset definitions |
| `src/lib/provider-adapters.ts` | MODIFY — Add `'claude-sdk'` to ProviderName union |
| `package.json` | MODIFY — Add `@anthropic-ai/claude-agent-sdk` dependency |

**Interface adaptation:** `ExecutorProvider.buildSpawnCommand()` returns a metadata-only `LaunchCommand` (no shell command). The actual execution happens via a new `runQuery(ctx, prompt): AsyncIterable<SDKMessage>` method on `ClaudeSdkProvider` — not part of the interface, called directly by the spawn flow when provider is `claude-sdk`. Transport type: `'process'`.

**Deliverables:**
- `ClaudeSdkProvider` that implements `ExecutorProvider` interface
- `createPermissionGate(config)` returns a `CanUseTool` callback
- 3 presets: `full`, `read-only`, `chat-only`
- Permission gate checks: allow list, deny list, bash pattern matching

**Validation:**
```bash
bun test src/lib/providers/__tests__/claude-sdk-permissions.test.ts
bun run typecheck
```

### Group 2: Agent Directory Integration + Spawn Wiring

**depends-on:** Group 1

**Files:**

| File | Action |
|------|--------|
| `src/lib/agent-directory.ts` | MODIFY — Add `permissions` field to DirectoryEntry |
| `src/term-commands/agent/spawn.ts` | MODIFY — Wire `--provider claude-sdk` option |
| `src/lib/spawn-command.ts` | MODIFY — Handle SDK provider (no tmux command needed) |

**Deliverables:**
- `genie dir add <agent> --permissions-preset read-only` sets permissions
- `genie spawn <agent> --provider claude-sdk` uses SDK provider
- Agent directory entries carry permission config

**Auth:** SDK reads `ANTHROPIC_API_KEY` from `process.env` (inherits from genie's env). No separate config needed.

**Validation:**
```bash
bun test src/lib/agent-directory.test.ts
bun run typecheck
```

### Group 3: Omni Bridge Executor

**depends-on:** Group 1

**Files:**

| File | Action |
|------|--------|
| `src/services/executors/claude-sdk.ts` | CREATE — IExecutor for omni-bridge using SDK |
| `src/services/omni-bridge.ts` | MODIFY — Support SDK executor alongside tmux executor |

**Deliverables:**
- `ClaudeSdkOmniExecutor` implementing `IExecutor` interface
- `spawn()` creates a `query()` session per chat
- `deliver()` sends message to running session via streaming input
- `shutdown()` aborts the query via `AbortController`
- Bridge selects executor based on agent config

**Validation:**
```bash
bun test src/services/executors/__tests__/claude-sdk.test.ts
```

### Group 4: Tests + Integration Validation

**depends-on:** Group 1, Group 2, Group 3

**Files:**

| File | Action |
|------|--------|
| `src/lib/providers/__tests__/claude-sdk-permissions.test.ts` | CREATE |
| `src/lib/providers/__tests__/claude-sdk.test.ts` | CREATE |
| `src/services/executors/__tests__/claude-sdk.test.ts` | CREATE |

**Deliverables:**
- Permission gate: blocks denied tools, allows permitted tools
- Permission gate: inspects Bash command against patterns
- Permission gate: presets resolve correctly
- Provider: builds correct options from agent config
- Omni executor: spawn/deliver/shutdown lifecycle

**Validation (full gate):**
```bash
bun test && bun run typecheck && bun run lint
```

---

## Dependencies

- `@anthropic-ai/claude-agent-sdk` >= 0.2.91
- Existing: `src/lib/auto-approve.ts` (config schema reuse)
- Existing: `src/lib/executor-types.ts` (ExecutorProvider interface)
- Existing: `src/services/executor.ts` (IExecutor interface for omni-bridge)

## Risks

1. **SDK stability** — `@anthropic-ai/claude-agent-sdk` is at 0.2.x. API may change. Pin exact version.
2. **No tmux** — SDK runs in-process. If the parent process dies, all agent sessions die. Need graceful shutdown.
3. **Memory** — Each `query()` holds conversation context in memory. For omni-bridge with 20 concurrent chats, memory usage could spike.
4. **Auth** — SDK needs ANTHROPIC_API_KEY or Claude OAuth. Must inherit from genie's existing auth.

## Auto-Approve

- allow: Read
- allow: Edit
- allow: Write
- allow: Glob
- allow: Grep
- allow: Bash
- deny: Agent
