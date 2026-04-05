# Wish: Genie × Omni — The Perfect Marriage

| Field | Value |
|-------|-------|
| **Status** | OBSOLETE |
| **Slug** | `genie-omni-marriage` |
| **Date** | 2026-03-24 |
| **Design** | Brainstorm session 2026-03-24 (see memory: project_genie_omni_architecture.md) |

## Summary

Make genie and omni plug together automatically with zero configuration. Drop agent folders, run `genie up`, agents are live on every channel. Omni is the yellow pages + postal service. Genie is the agent platform. Together they form the new internet for agents and humans.

## Scope

### IN
- `genie up` command: scans agent folders, auto-registers in Omni, starts watching
- `genie sync` command: one-shot scan + register (called by `genie up`)
- `genie freeze <agent>` / `genie thaw <agent>`: session cold storage
- `genie watch`: PM2-managed file watcher for live agent sync
- DIRECTORY.md spec: world definition file (auto-generated with defaults if missing)
- AGENTS.md `omni:` frontmatter auto-scaffolding (all features enabled by default)
- `ecosystem.config.cjs`: PM2 config for genie-watch process
- Omni client library: thin wrapper for Omni's agent registration API
- Agent folder convention: AGENTS.md + SOUL.md + tools/ + knowledge/ = the agent

### OUT
- Omni-side changes (separate wish in Omni repo: GenieProvider enhancement, structured inbox metadata, person session preference, Claude SDK provider)
- New permission system (agents use Omni's existing access system)
- NATS subscription in genie (Omni subscribes, calls genie)
- Session-per-person mapping (lives in GenieProvider on Omni side)
- UI/dashboard work
- Claude Code or Claude SDK internals

## Decisions

| Decision | Rationale |
|----------|-----------|
| Genie = CLI, never a server | Omni is the server. No duplicate infrastructure. One thing to monitor. |
| All features enabled by default | Like --dangerously-skip-permissions. User restricts, never enables. Zero config. |
| DIRECTORY.md auto-generated | If missing, `genie up` creates it with sensible defaults. User never NEEDS to write it. |
| Dot-prefix = hidden from Omni | `.qa-bot/` excluded from discovery. Convention over configuration. |
| PM2 for genie-watch only | Not a genie daemon. Just a file watcher that keeps agent sync alive. |
| Agent folder IS the agent | Same folder works with Claude Code (genie) and Claude SDK (Omni). Single source of truth. |
| freeze/thaw not suspend/resume | Distinct from `genie resume`. Freeze = save state + kill pane. Thaw = restore + resume. |

## Success Criteria

- [ ] `genie up` in a folder with 3 agents registers all 3 in Omni with zero configuration
- [ ] DIRECTORY.md auto-generated when missing
- [ ] AGENTS.md `omni:` block auto-scaffolded with all features enabled when missing
- [ ] `genie sync` is idempotent (running twice doesn't duplicate agents)
- [ ] Dot-prefixed agent folders are excluded from Omni registration
- [ ] `genie freeze <agent>` saves session state and kills tmux pane
- [ ] `genie thaw <agent>` restores session from frozen state with resume context
- [ ] `ecosystem.config.cjs` manages genie-watch via PM2
- [ ] `genie up` without Omni running still works (standalone mode, skip registration)
- [ ] `bun test` passes, no regressions

## Execution Strategy

### Wave 1 (parallel — foundations, no dependencies)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | DIRECTORY.md spec + parser + auto-generation |
| 2 | engineer | Omni client library (agent registration API wrapper) |
| 3 | engineer | AGENTS.md omni: frontmatter auto-scaffolding |

### Wave 2 (after Wave 1 — core commands)
| Group | Agent | Description |
|-------|-------|-------------|
| 4 | engineer | `genie sync` command (scan + register) |
| 5 | engineer | `genie freeze` / `genie thaw` commands |

### Wave 3 (after Wave 2 — orchestration)
| Group | Agent | Description |
|-------|-------|-------------|
| 6 | engineer | `genie up` command + `genie watch` + PM2 ecosystem config |

## Execution Groups

### Group 1: DIRECTORY.md Spec + Parser

**Goal:** Define and parse the world definition file.

**Deliverables:**
1. TypeScript type `DirectoryConfig` with fields: `base` (agent scan path), `omni` (auto/off/url), `sync` (watch/push/off), `defaults` (default permission/channel settings)
2. Parser: `parseDirectory(cwd)` → reads DIRECTORY.md frontmatter (YAML), returns `DirectoryConfig`
3. Auto-generator: `scaffoldDirectory(cwd)` → creates DIRECTORY.md with sensible defaults if missing
4. Defaults: `base: ./agents`, `omni: auto`, `sync: watch`, all permissions enabled

**Acceptance Criteria:**
- [ ] `parseDirectory()` reads DIRECTORY.md and returns typed config
- [ ] `scaffoldDirectory()` creates DIRECTORY.md with defaults when file is missing
- [ ] `scaffoldDirectory()` is idempotent (doesn't overwrite existing file)
- [ ] Auto-detection: `omni: auto` checks localhost for running Omni instance

**Validation:**
```bash
bun test --filter directory
```

**depends-on:** none

---

### Group 2: Omni Client Library

**Goal:** Thin client for Omni's agent registration API.

**Deliverables:**
1. `src/lib/omni-client.ts` with methods:
   - `discoverOmni()` → check if Omni is running (localhost probe)
   - `registerAgent(name, config)` → POST to Omni agents API
   - `updateAgent(name, config)` → PUT to Omni agents API
   - `deregisterAgent(name)` → DELETE from Omni agents API
   - `listRegisteredAgents()` → GET from Omni agents API
2. All methods are best-effort (don't crash if Omni is unavailable)
3. Uses Omni's existing API. Check `packages/api/src/trpc/router.ts` for agent CRUD endpoints. Use REST if OpenAPI spec available at `/api/docs`, otherwise use tRPC client. Omni repo: `/home/genie/agents/namastexlabs/omni/repos/omni/`

**Acceptance Criteria:**
- [ ] `discoverOmni()` returns true when Omni is running, false otherwise
- [ ] `registerAgent()` creates agent in Omni with provider=genie
- [ ] All methods gracefully handle Omni being offline (return null/false, don't throw)
- [ ] Client reads Omni URL from DIRECTORY.md config or env `OMNI_URL`

**Validation:**
```bash
bun test --filter omni-client
```

**depends-on:** none

---

### Group 3: AGENTS.md Omni Frontmatter Auto-Scaffolding

**Goal:** Auto-add `omni:` block to AGENTS.md when missing, with all features enabled.

**Deliverables:**
1. `scaffoldOmniFrontmatter(agentsmdPath)` → reads AGENTS.md, adds `omni:` block if missing, writes back
2. Default omni block:
   ```yaml
   omni:
     discoverable: true
     channels: all
     triggers:
       - type: name-match
         pattern: "<agent-name>"
     permissions:
       outbound: true
       find-humans: true
       a2a: true
   ```
3. Preserves existing frontmatter fields (only adds `omni:` if missing)
4. Reads agent name from existing `name:` field in frontmatter

**Acceptance Criteria:**
- [ ] AGENTS.md without `omni:` block gets it auto-added with all features on
- [ ] AGENTS.md WITH existing `omni:` block is not modified
- [ ] Existing frontmatter fields preserved exactly
- [ ] Trigger pattern defaults to the agent's `name:` field

**Validation:**
```bash
bun test --filter scaffold
```

**depends-on:** none

---

### Group 4: `genie sync` Command

**Goal:** Scan agent folders, scaffold missing config, register all agents in Omni.

**Deliverables:**
1. `genie sync` CLI command that:
   - Reads DIRECTORY.md (or uses defaults)
   - Scans `base` folder for `**/AGENTS.md` files
   - Skips dot-prefixed directories
   - Auto-scaffolds `omni:` frontmatter on each agent (Group 3)
   - Registers each discoverable agent in Omni (Group 2)
   - Reports: "✨ Synced N agents to Omni (M new, K updated, J hidden)"
2. Idempotent: running twice produces same result
3. Graceful without Omni: "⚠ Omni not detected, skipping registration. Agents discovered locally."

**Acceptance Criteria:**
- [ ] Scans base folder recursively for AGENTS.md
- [ ] Skips dot-prefixed directories
- [ ] Calls `scaffoldOmniFrontmatter` for each agent
- [ ] Calls `omniClient.registerAgent` for each discoverable agent
- [ ] Idempotent (no duplicate registrations)
- [ ] Works without Omni (local-only mode)

**Validation:**
```bash
bun test --filter sync
```

**depends-on:** Group 1, Group 2, Group 3

---

### Group 5: `genie freeze` / `genie thaw` Commands

**Goal:** Session cold storage for idle agents.

**Deliverables:**
1. `genie freeze <agent-or-session>`:
   - Captures tmux pane state (last 500 lines)
   - Saves to `~/.genie/frozen/<session-id>.json`: session ID, pane content, git status, wish state, timestamp
   - Kills tmux pane
   - Updates agent registry: state → "frozen"
   - Reports: "❄ Agent frozen. Session saved."
2. `genie thaw <agent-or-session>`:
   - Reads frozen state from `~/.genie/frozen/<session-id>.json`
   - Spawns new pane with `--resume <session-id>` (returns to existing Claude Code session)
   - Injects resume context via native inbox (wish state, git status, what was happening)
   - Removes frozen state file
   - Updates registry: state → "spawning"
   - Reports: "🔥 Agent thawed. Resuming session."
3. Auto-freeze hook: integrate with idle-timeout system (existing `src/lib/idle-timeout.ts`)

**Acceptance Criteria:**
- [ ] `genie freeze` saves session state and kills pane
- [ ] `genie thaw` resumes the EXISTING Claude Code session (--resume), not a new one
- [ ] Thawed agent receives resume context (wish slug, group status, git state)
- [ ] Frozen state persisted to disk (survives process restarts)
- [ ] Registry tracks frozen state
- [ ] Auto-freeze triggers after configured idle timeout (default 2h, integrates with existing `src/lib/idle-timeout.ts`)

**Validation:**
```bash
bun test --filter freeze
```

**depends-on:** Group 1 (for directory config, freeze path), `resilient-resume` wish (thaw uses `injectResumeContext` from protocol-router-spawn.ts)

---

### Group 6: `genie up` + `genie watch` + PM2 Ecosystem

**Goal:** One command to bring the whole world online. File watcher keeps it in sync.

**Deliverables:**
1. `genie up` command:
   - Calls `scaffoldDirectory(cwd)` (create DIRECTORY.md if missing)
   - Calls `genie sync` (scan + register)
   - Starts `genie watch` (file watcher)
   - Reports: "🚀 N agents live. Watching for changes."
2. `genie watch` command:
   - Watches `base` folder for AGENTS.md changes (create/modify/delete)
   - On change: re-sync affected agent (register/update/deregister)
   - Runs as long-lived process (PM2 managed)
3. `ecosystem.config.cjs`:
   - Manages `genie-watch` process via PM2
   - Matches Omni's PM2 pattern (unlimited restarts, log rotation, memory limit)
   - Environment-based: `GENIE_WATCH_MANAGED=true` to activate

**Acceptance Criteria:**
- [ ] `genie up` creates DIRECTORY.md + syncs + starts watcher in one command
- [ ] `genie watch` detects new agent folders and auto-registers in Omni
- [ ] `genie watch` detects removed agent folders and deregisters from Omni
- [ ] `ecosystem.config.cjs` valid and matches Omni's PM2 pattern
- [ ] `genie up` without Omni works (local discovery only, no registration)

**Validation:**
```bash
bun test --filter watch
pm2 start ecosystem.config.cjs && pm2 ls | grep genie
```

**depends-on:** Group 4, Group 5

---

## QA Criteria

- [ ] `genie up` in a fresh folder with 3 test agents → all 3 registered in Omni
- [ ] Add new agent folder while `genie watch` running → auto-registered within 5s
- [ ] Remove agent folder → auto-deregistered
- [ ] `genie freeze` + `genie thaw` round-trip preserves session
- [ ] Everything works without Omni (standalone mode)
- [ ] PM2 ecosystem config manages genie-watch correctly

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Omni API may change | Medium | Omni client is a thin wrapper, easy to update |
| File watcher performance with many agents | Low | chokidar/fs.watch handles thousands of files fine |
| Claude Code --resume may fail on thaw | Medium | Fallback: spawn fresh session with full context injection |
| PM2 not installed on target machine | Low | `genie up` checks for PM2, falls back to foreground watcher |

---

## Reconciliation Notes

> **Omni-bridge is a message source, not a state owner.** The omni-bridge relay delivers inbound messages and publishes replies via NATS, but session lifecycle (spawn, resume, freeze, registry) is owned entirely by genie's executor layer. PR #1042 attempted to add a PG-backed session registry inside the bridge — this created a third source of truth alongside the executor table and the worker registry. The unified-executor-layer branch resolves this by keeping session persistence in the executors table and treating the bridge as a stateless message transport. Bridge restarts no longer require session recovery because the bridge holds no session state.

## Files to Create/Modify

```
# New files
src/lib/directory.ts              # DIRECTORY.md parser + scaffolder
src/lib/omni-client.ts            # Omni API client
src/lib/agent-scaffold.ts         # AGENTS.md omni: frontmatter scaffolder
src/lib/freeze.ts                 # freeze/thaw session storage
src/term-commands/sync.ts         # genie sync command
src/term-commands/freeze.ts       # genie freeze / genie thaw commands
src/term-commands/up.ts           # genie up command
src/term-commands/watch.ts        # genie watch command
ecosystem.config.cjs              # PM2 config

# Modified files
src/genie.ts                      # register new commands
src/lib/agent-directory.ts        # integrate with DIRECTORY.md discovery
src/lib/agent-registry.ts         # add "frozen" state
```
