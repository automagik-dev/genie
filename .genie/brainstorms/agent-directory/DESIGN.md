# DESIGN: Agent Directory & Multi-Agent Spawn Redesign

> Redesign genie's agent spawn and communication system so that pre-existing agents
> (each with their own home directory, identity files, and project assignments) can be
> registered once, spawned in one command, and message each other by name.

## Problem

`genie agent spawn` creates clones of the spawning agent — they inherit the parent's session context and CLAUDE.md rather than loading their own AGENTS.md identity. Cross-agent messaging requires manual `--team` flags. CWD and identity source are conflated via the `-d` flag. This blocks multi-agent workflows where a PM, Engineer, and QA need independent identities while collaborating on the same project.

## Architecture

### Two Registries, Two Lifecycles

```
┌─────────────────────────────┐    ┌─────────────────────────────┐
│   Agent Directory           │    │   Worker Registry            │
│   ~/.genie/agent-directory  │    │   ~/.genie/workers.json      │
│   .json                     │    │                              │
│                             │    │                              │
│   WHO the agent IS          │    │   HOW to restart it          │
│   - name                    │    │   - paneId, session          │
│   - home (AGENTS.md src)    │    │   - claudeSessionId          │
│   - project (CWD)           │    │   - state, team              │
│   - default team            │    │   + templates[] for recovery │
│                             │    │                              │
│   Human-configured          │    │   Auto-generated at spawn    │
│   Persistent across reboots │    │   Ephemeral (pane lifecycle) │
│   Source of truth for ID    │    │   Source of truth for state  │
└──────────────┬──────────────┘    └──────────────┬──────────────┘
               │                                  │
               │  1. spawn resolves identity      │  3. template saved
               │  2. CWD + prompt injected        │     for auto-respawn
               ▼                                  ▼
        ┌─────────────────────────────────────────────┐
        │              genie agent spawn              │
        │  Reads directory → injects identity →       │
        │  launches in tmux → registers worker →      │
        │  saves template for recovery                │
        └─────────────────────────────────────────────┘
```

### Key Separations

| Concern | Source | Used At |
|---------|--------|---------|
| **Identity** (AGENTS.md) | `--home` directory in agent-directory.json | Spawn time → `--append-system-prompt` |
| **Workspace** (CWD) | `--project` path in agent-directory.json | Spawn time → tmux pane CWD |
| **Address** | Agent name in directory | Message routing → flat, no `--team` prefix |
| **Team** | Optional grouping | Tmux window organization, not required for identity or messaging |
| **Recovery** | WorkerTemplate in workers.json | Auto-respawn on message to dead agent |

## Scope

### IN
- Persistent agent directory (`~/.genie/agent-directory.json`)
- `genie agent register <name> --home <path> --project <path>` subcommand
- `genie agent unregister <name>` subcommand
- `genie agent directory` subcommand (list all registered agents with status)
- `genie agent spawn <name>` resolving from directory (positional arg)
- Identity injection: read AGENTS.md from `--home`, inject via `--append-system-prompt`
- CWD/identity separation: pane opens at `--project`, identity from `--home`
- Flat messaging: `genie send --to <name>` resolves via directory without `--team`
- Auto-spawn on message to offline registered agent
- Backward compat: `genie agent spawn --role implementor` still works unchanged

### OUT
- Changes to Claude Code's native teammate protocol itself
- New messaging transport (still mailbox + native inbox)
- Multi-project per agent (one project at a time per directory entry)
- Modifying AGENTS.md content (directory is a pointer, not an editor)

## Detailed Design

### 1. New Module: `src/lib/agent-directory.ts`

Persistent JSON registry at `~/.genie/agent-directory.json`.

```typescript
// Schema
interface DirectoryEntry {
  name: string;            // unique key, e.g., "totvs-pm"
  home: string;            // absolute path to agent home (contains AGENTS.md)
  project: string;         // absolute path to project repo (CWD at spawn)
  team?: string;           // optional default team grouping
  registeredAt: string;    // ISO timestamp
}

interface AgentDirectory {
  entries: Record<string, DirectoryEntry>;
  lastUpdated: string;
}

// Public API
register(name, home, project, team?): void     // persist entry
unregister(name): void                          // remove entry
resolve(name): DirectoryEntry | null            // lookup by name
list(): DirectoryEntry[]                        // all entries
loadIdentity(name): string | null               // read AGENTS.md from home
```

**Storage:** Same `~/.genie/` directory as `workers.json` and `config.json`. Uses the same file-lock pattern from `agent-registry.ts` for concurrent access safety.

**Path validation:** `resolve()` returns the entry as-is (fast). `loadIdentity()` checks if `home/AGENTS.md` exists and returns null if missing. Spawn command fails fast with clear error on missing paths.

### 2. Modified: `src/lib/provider-adapters.ts`

Add `systemPrompt?: string` to `SpawnParams`:

```typescript
export interface SpawnParams {
  // ... existing fields ...
  /** System prompt content to inject via --append-system-prompt. */
  systemPrompt?: string;
}
```

In `buildClaudeCommand()`: if `systemPrompt` is provided, persist to file via the existing `persistSystemPrompt()` pattern from `team-lead-command.ts`, then add `--append-system-prompt "$(cat <path>)"`.

**Implementation detail:** Extract `persistSystemPrompt()` from `team-lead-command.ts` into a shared utility (or just import it). The file goes to `~/.genie/prompts/<agent-name>.md`. The existing `promptMode` config (`'append'` vs `'system'`) is respected.

### 3. Modified: `src/term-commands/agents.ts` — spawn command

Change the spawn command signature from:

```
genie agent spawn --role <role> [--team <team>] [--cwd <path>] ...
```

To:

```
genie agent spawn [name] --role <role> [--team <team>] [--cwd <path>] ...
```

Resolution logic in `handleWorkerSpawn()`:

```
1. If positional `name` provided:
   a. Resolve from agent directory
   b. If not found → error: "Agent '<name>' not registered. Run: genie agent register ..."
   c. Set CWD = entry.project (override --cwd if not explicitly provided)
   d. Load AGENTS.md from entry.home → set systemPrompt on SpawnParams
   e. Set GENIE_AGENT_NAME = name (via env in launch command)
   f. Use entry.team as default team (if --team not explicit)
   g. Use name as the role for native team registration

2. If no positional name (--role provided):
   a. Existing behavior, unchanged
   b. No directory lookup
```

**Backward compat:** `--role` becomes optional (was `.requiredOption`). Validation: either positional `name` or `--role` must be provided, error otherwise.

### 4. New Subcommands in `agents.ts`

```
genie agent register <name> --home <path> --project <path> [--team <team>]
genie agent unregister <name>
genie agent directory [--json]
```

**register:** Validates both paths exist on disk. Writes to `agent-directory.json`.

**unregister:** Removes entry. Does not affect running workers or templates.

**directory:** Lists all registered agents with runtime state enrichment:

```
NAME              HOME                           PROJECT                        STATUS   TEAM
totvs-pm          ~/.../totvs-pm                 ~/.../projects/totvs-poc       idle     recon
totvs-engineer    ~/.../totvs-recon-engineer      ~/.../projects/totvs-poc       working  recon
totvs-qa          ~/.../totvs-qa                  ~/.../projects/totvs-poc       stopped  —
```

STATUS is derived by cross-referencing the worker registry: if a worker with matching name/role exists and its pane is alive → show its state. Otherwise → "stopped".

### 5. Modified: `src/lib/protocol-router.ts` — sendMessage()

Add directory-aware resolution as the **first** lookup tier in `sendMessage()`:

```
Current: resolveRecipient(to) → workers by ID > role > team:role
New:     directoryResolve(to) → agent directory by name
         ↓ (if found + alive)
         deliver directly
         ↓ (if found + not alive)
         auto-spawn from directory entry → deliver
         ↓ (if not found in directory)
         resolveRecipient(to) → existing worker registry resolution
```

**Auto-spawn from directory:** When a directory agent isn't running, the router:
1. Calls `agentDirectory.resolve(to)` → gets home + project
2. Calls `agentDirectory.loadIdentity(to)` → gets AGENTS.md content
3. Spawns using the same `spawnWorkerFromTemplate` pattern but with directory-derived params
4. Waits for ready, delivers message

**Collision handling:** If an agent name in the directory matches a worker ID from a different context, directory wins. A debug-level warning is logged.

### 6. Modified: `src/hooks/handlers/auto-spawn.ts`

The hook also needs directory awareness for the case where Claude Code's SendMessage fires before the protocol router handles it:

```
Current: check worker registry → check templates → spawn from template
New:     check worker registry → check agent directory → check templates
```

If the directory has the recipient, spawn using directory identity (same as protocol-router path). This keeps the hook and router consistent.

### 7. Identity Injection Flow (end-to-end)

```
1. Human runs: genie agent register totvs-pm \
     --home /home/genie/agents/namastexlabs/totvs-pm \
     --project /home/genie/agents/namastexlabs/projects/totvs-poc

2. Human (or another agent) runs: genie agent spawn totvs-pm

3. handleWorkerSpawn():
   a. directory.resolve("totvs-pm") → { home: "/...totvs-pm", project: "/...totvs-poc" }
   b. directory.loadIdentity("totvs-pm") → reads /...totvs-pm/AGENTS.md → string content
   c. persistSystemPrompt("totvs-pm", content) → writes ~/.genie/prompts/totvs-pm.md
   d. SpawnParams.systemPrompt = content
   e. buildClaudeCommand() adds: --append-system-prompt "$(cat ~/.genie/prompts/totvs-pm.md)"
   f. Launch env includes: GENIE_AGENT_NAME=totvs-pm
   g. tmux pane CWD = /...totvs-poc

4. Agent starts with:
   - Its own AGENTS.md as system prompt (independent identity)
   - CWD in the project repo (not its home directory)
   - GENIE_AGENT_NAME set (identity-inject hook tags outgoing messages)

5. PM sends to engineer: genie send 'assess filter extension' --to totvs-engineer
   a. protocol-router.sendMessage() → directoryResolve("totvs-engineer")
   b. If alive → deliver
   c. If not alive → auto-spawn from directory → deliver
   d. No --team flag needed
```

## Risks

| ID | Risk | Severity | Mitigation |
|----|------|----------|------------|
| R1 | **Dual resolution ambiguity** — directory name collides with worker ID/role from different team | Medium | Directory wins on exact name match. Log warning on collision. |
| R2 | **Stale directory entries** — agent home moved/deleted, spawn fails | Low | `loadIdentity()` returns null on missing AGENTS.md. Spawn fails fast with clear error. `genie agent directory` validates paths and shows warnings. |
| R3 | **`--append-system-prompt` size limits** — large AGENTS.md files | Low | Reuse `persistSystemPrompt()` file-persist + `$(cat)` pattern from `team-lead-command.ts`. Already battle-tested. |
| R4 | **Auto-spawn race** — hook and router both try to spawn | Medium | Both paths check `isPaneAlive()` before spawning. `cleanupDeadWorkers()` runs before spawn. Same guards that prevent double-spawn today. |
| R5 | **`--role` required → optional** — could break scripts | Low | Validation: require either positional `name` OR `--role`. Error message guides users. Existing `--role` invocations are unaffected. |

## Acceptance Criteria

1. **Register + resolve:** `genie agent register totvs-pm --home /path --project /path` persists to `~/.genie/agent-directory.json`. `genie agent directory` lists it.
2. **Spawn by name:** `genie agent spawn totvs-pm` sets CWD to project, injects AGENTS.md from home via `--append-system-prompt`, sets `GENIE_AGENT_NAME=totvs-pm`.
3. **Independent identity:** Two directory agents spawned into the same project have different AGENTS.md injected. Verified by differing `~/.genie/prompts/<name>.md`.
4. **Flat messaging:** `genie send 'hello' --to totvs-engineer` delivers without `--team`, resolving via directory.
5. **Auto-spawn + deliver:** Sending to an offline directory agent triggers spawn then delivery.
6. **Template auto-creation:** Spawning a directory agent saves a `WorkerTemplate` for crash recovery.
7. **Backward compat:** `genie agent spawn --role implementor --team myteam` works unchanged.
8. **Path validation:** Spawn fails fast with clear error if home or project path doesn't exist.
9. **Unregister:** `genie agent unregister totvs-pm` removes from directory without affecting running workers.

## Implementation Groups

### Group 1: Foundation (no behavioral changes)
- [ ] Create `src/lib/agent-directory.ts` with register/unregister/resolve/list/loadIdentity
- [ ] Extract `persistSystemPrompt()` from `team-lead-command.ts` into shared util
- [ ] Add `systemPrompt?: string` to `SpawnParams` in `provider-adapters.ts`
- [ ] Wire `systemPrompt` into `buildClaudeCommand()` using persist+cat pattern

### Group 2: Spawn Integration
- [ ] Add `register`, `unregister`, `directory` subcommands to `agents.ts`
- [ ] Add optional `[name]` positional to `spawn` command
- [ ] Make `--role` conditionally required (required if no positional name)
- [ ] Wire directory resolution into `handleWorkerSpawn()`
- [ ] Set `GENIE_AGENT_NAME` and CWD from directory entry at spawn

### Group 3: Messaging Integration
- [ ] Add directory-aware first-pass resolution in `protocol-router.ts:sendMessage()`
- [ ] Add directory lookup in `auto-spawn.ts` hook (before template fallback)
- [ ] Implement auto-spawn-from-directory in protocol router for offline agents
- [ ] Verify `identity-inject.ts` works with directory-spawned agents (uses GENIE_AGENT_NAME — should work as-is)

### Group 4: Polish + Validation
- [ ] `genie agent directory` shows runtime state by cross-referencing worker registry
- [ ] Path validation warnings in directory listing
- [ ] Tests for agent-directory.ts (register, resolve, loadIdentity)
- [ ] Tests for directory-aware spawn (mock directory, verify systemPrompt injection)
- [ ] Integration test: register → spawn → send message → verify delivery

## Files Changed

| File | Change Type | Description |
|------|------------|-------------|
| `src/lib/agent-directory.ts` | **New** | Persistent agent directory module |
| `src/lib/provider-adapters.ts` | Modified | Add `systemPrompt` to SpawnParams, wire into buildClaudeCommand |
| `src/lib/team-lead-command.ts` | Modified | Extract `persistSystemPrompt` to shared location |
| `src/term-commands/agents.ts` | Modified | Add register/unregister/directory subcommands, optional positional spawn |
| `src/lib/protocol-router.ts` | Modified | Directory-first resolution in sendMessage |
| `src/hooks/handlers/auto-spawn.ts` | Modified | Directory lookup before template fallback |
| `src/types/genie-config.ts` | Unchanged | No config schema changes needed |

## Non-Goals (Explicit)

- No changes to Claude Code's native teammate protocol
- No new messaging transport
- No multi-project support per agent
- No auto-discovery of agent directories (explicit registration only)
- No modifications to AGENTS.md content from genie
