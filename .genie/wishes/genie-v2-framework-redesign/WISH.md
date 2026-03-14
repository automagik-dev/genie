# Wish: Genie CLI v2 — Complete Framework Redesign

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `genie-v2-framework-redesign` |
| **Date** | 2026-03-13 |
| **Design** | [DESIGN.md](../../brainstorms/agent-directory/DESIGN.md) |
| **Draft** | [DRAFT.md](../../brainstorms/agent-directory/DRAFT.md) |

## Summary

Redesign the entire genie CLI framework: replace 40+ commands with a streamlined command tree, introduce an agent directory for identity management, replace beads with a wish-native state machine, add team-based worktree collaboration with dynamic hire/fire, implement dispatch commands (brainstorm/wish/work/review) with context injection, and refine 10 skill prompts to align with the new orchestration model. Clean break — no backward compatibility.

## Scope

### IN

- Agent directory module (`genie dir add/rm/ls/edit`) replacing profiles
- Directory-based spawn (`genie spawn <name>`) with `--system-prompt-file` / `--append-system-prompt-file`
- Built-in roles and council members shipping with genie package
- Team lifecycle (`genie team create/hire/fire/disband`) with git worktree management
- Team name = branch name (conventional git prefixes)
- Wish-native state machine (`genie work/done/status`) replacing beads
- Dispatch commands with context injection (brainstorm/wish/work/review)
- Flat messaging by name (`genie send/broadcast/chat`) scoped to own team
- Auto-spawn on message to offline agent
- Promote agent commands to top-level (`spawn`, `kill`, `stop`, `ls`, etc.)
- `/refine` pass on 10 skills to align with new orchestration model
- Council dual-mode: lightweight (skill) + full spawn (team hire)
- Remove 25+ deprecated commands (beads, profiles, blueprints, task, old agent namespace)
- `genie --session <name>` for named leader sessions

### OUT

- Changes to Claude Code's native teammate protocol
- New messaging transport (still mailbox + native inbox)
- Permission system / approve workflow (future sprint)
- Watchdog replacement (future external service)
- Sub-group task granularity (issue opened to monitor need)
- Multi-project per agent
- Changes to non-orchestration skills (brain, refine, learn, report)
- Changes to build pipeline or bundler
- `install.sh` review (separate effort)

## Decisions

| Decision | Rationale |
|----------|-----------|
| `--system-prompt-file` / `--append-system-prompt-file` | Hidden but confirmed working. Eliminates persistSystemPrompt + $(cat) pattern entirely |
| One folder per agent | CWD = identity source. Simplest model. No home/project split |
| Repo at team level, optional at agent level | Team repo overrides agent repo. All team members in same worktree |
| Per-agent promptMode, model, roles in directory | Agent knows its own capabilities without relying on prompting |
| No backward compat | Clean break. Old patterns replaced, not preserved alongside new |
| Team name = branch name | `feat/agent-directory` is both the team name and the git branch. No translation |
| Beads replaced by wish-native state file | Simpler, shared via worktree, no daemon/ledger/sync overhead |
| State transitions via genie commands only | Agents never touch state file. Prevents abandonment. Leader tracks guarantees |
| Agents ≠ Roles | Agents have identity. Roles are ephemeral built-ins. Dynamic orchestration decides who bosses whom |
| Council: all or none | `genie team hire council` hires all 10. No per-member hiring |
| Tasks die completely | Wish groups are the only unit of work. Monitor for sub-group need |
| Naming: ls/rm/add consistently | Git-familiar conventions throughout |
| `suspend` → `stop` | Clearer intent: stop current run, keep pane alive |
| `close` + `ship` → `done` | Single state transition command |
| Dispatch commands inject file path + extracted content | Agent gets full context without searching. Reduces token waste |

## Success Criteria

- [ ] `genie dir add/rm/ls/edit` fully operational, persists to `~/.genie/agent-directory.json`
- [ ] `genie spawn <name>` resolves from directory, injects AGENTS.md via correct `--*-system-prompt-file` flag
- [ ] `genie spawn implementor` works for built-in roles without directory registration
- [ ] `genie team create feat/x --repo <path> --branch dev` creates worktree, starts leader session
- [ ] `genie team hire/fire` manages dynamic membership, `hire council` hires all 10
- [ ] `genie team disband` kills members + cleans up worktree
- [ ] `genie work <agent> <slug>#<group>` checks deps → sets in_progress → spawns with context
- [ ] `genie done <slug>#<group>` transitions state, unblocks dependents
- [ ] `genie status <slug>` shows all groups with state/assignee/timestamps
- [ ] `genie send` routes by name without `--team`, scoped to own team
- [ ] `genie broadcast` delivers to all team members
- [ ] `genie chat` / `genie chat read` posts to/reads team group channel
- [ ] Message to offline registered agent triggers auto-spawn + delivery
- [ ] 10 skill prompts updated to use `genie spawn` dispatch + acknowledge injected context
- [ ] `/work` skill does NOT manage state — receives context, signals completion via message
- [ ] `/council` supports lightweight (skill) and full spawn (team hire) modes
- [ ] All `genie task *`, `genie profiles *`, `genie daemon *`, `genie ledger *` commands removed
- [ ] `genie agent *` namespace removed — all promoted to top-level
- [ ] `bun run check` passes
- [ ] `bun run build` succeeds

## Execution Groups

### Group 1: Agent Directory Module

**Goal:** Persistent agent registry with CRUD operations, replacing profiles.

**Deliverables:**
1. Create `src/lib/agent-directory.ts` — JSON registry at `~/.genie/agent-directory.json`
   - Schema: `{ name, dir, repo?, promptMode, model?, roles?, registeredAt }`
   - Public API: `add()`, `rm()`, `resolve()`, `ls()`, `edit()`, `loadIdentity()`
   - File-lock pattern (same as agent-registry.ts) for concurrent access
   - Path validation on `add` (dir must exist, AGENTS.md must exist in dir)
2. Create built-in agents registry — `src/lib/builtin-agents.ts`
   - 10 built-in roles (implementor, tester, reviewer, debugger, verifier, investigator, reproducer, dreamer, critic, security)
   - Role prompts: derive from existing blueprint descriptions + Claude agent definitions in the codebase. Each role gets a short system prompt (1-2 paragraphs) defining its purpose, constraints, and output expectations.
   - 10 council members with default models and lens prompts (sourced from `skills/council/SKILL.md` member table)
   - Resolution: user directory > built-in registry
3. Add CLI subcommands in new `src/term-commands/dir.ts`
   - `genie dir add <name> --dir --repo --prompt-mode --model --roles`
   - `genie dir rm <name>`
   - `genie dir ls [<name>]`
   - `genie dir edit <name> --dir --repo --prompt-mode --model --roles`
4. Remove `src/lib/team-manager.ts` blueprint system (BLUEPRINTS constant, getBlueprint, listBlueprints)
5. Remove `genie profiles *` commands and related code (list, add, rm, show, default)
6. Remove `genie team blueprints` command

**Acceptance criteria:**
- `genie dir add test-agent --dir /tmp/test --prompt-mode append` persists entry
- `genie dir ls` lists all registered agents
- `genie dir ls test-agent` shows entry details
- `genie dir edit test-agent --model opus` updates entry
- `genie dir rm test-agent` removes entry
- `resolve("implementor")` returns built-in when no user override exists
- `resolve("test-agent")` returns user entry (overrides built-in if same name)
- Profiles commands no longer exist
- `genie team blueprints` no longer exists

**Validation:**
```bash
bun run typecheck
bun test src/lib/agent-directory.test.ts
bun test src/term-commands/dir.test.ts
```

**depends-on:** none

---

### Group 2: Directory-Based Spawn

**Goal:** `genie spawn <name>` resolves from directory, injects identity via native file flags.

**Deliverables:**
1. Modify `src/lib/provider-adapters.ts`
   - Add `systemPromptFile?: string` and `promptMode?: 'system' | 'append'` to `SpawnParams`
   - In `buildClaudeCommand()`: if `systemPromptFile` provided, add `--system-prompt-file` or `--append-system-prompt-file` based on `promptMode`
   - Add optional `model?: string` to SpawnParams, pass as `--model` flag
   - Remove `persistSystemPrompt()` from `team-lead-command.ts` and all callers
2. Rewrite `genie spawn` in `src/term-commands/agents.ts`
   - Change signature: `genie spawn <name> [--model] [--team]`
   - Resolution: directory.resolve(name) → if found, use entry. If not found, check built-in. If neither, error.
   - CWD: if agent in team → team worktree. If solo → entry.dir (or built-in default)
   - Identity: `loadIdentity(name)` → `--[append-]system-prompt-file <dir>/AGENTS.md`
   - Set `GENIE_AGENT_NAME=<name>` in launch env
3. Remove `--role` as required option (name is the primary arg)
4. Update `src/lib/team-lead-command.ts` to use `--append-system-prompt-file` instead of `$(cat)` pattern

**Acceptance criteria:**
- `genie spawn test-agent` resolves from directory, CWD = dir, AGENTS.md injected via `--append-system-prompt-file`
- `genie spawn test-agent --model opus` overrides directory default model
- `genie spawn implementor` works for built-in roles (no registration needed)
- Agent with `promptMode: 'system'` uses `--system-prompt-file`
- Agent with `promptMode: 'append'` uses `--append-system-prompt-file`
- `persistSystemPrompt()` and `$(cat)` pattern no longer exist in codebase

**Validation:**
```bash
bun run typecheck
grep -rn 'persistSystemPrompt\|\\$\\(cat' src/ && echo "FAIL: old pattern exists" || echo "PASS"
bun test src/lib/provider-adapters.test.ts
```

**depends-on:** Group 1

---

### Group 3: Team Lifecycle & Worktree Management

**Goal:** Dynamic team creation with git worktree, hire/fire membership, disband with cleanup.

**Deliverables:**
1. Rewrite `src/lib/team-manager.ts`
   - New Team schema: `{ name, repo, baseBranch, worktreePath, leader, members[], createdAt }`
   - `createTeam(name, repo, baseBranch)`: git pull → git worktree add → persist team config
   - Worktree path: `<worktreeBase>/<name>` (worktreeBase from config, default `.worktrees`)
   - Team name = branch name (e.g., `feat/agent-directory`)
   - `createTeam` is idempotent (re-running doesn't fail if team exists)
   - `hireAgent(teamName, agentName)`: add to members array. Special case: `council` hires all 10.
   - `fireAgent(teamName, agentName)`: remove from members, kill agent if running
   - `disbandTeam(teamName)`: kill all members, remove git worktree, delete team config
   - `getTeam()`, `listTeams()`, `listMembers()`
2. Rewrite `src/term-commands/team.ts`
   - `genie team create <name> --repo <path> [--branch dev]`
   - `genie team hire <agent> [--team <name>]` — auto-detect team from leader context if no `--team`
   - `genie team hire council` — hire all 10 council members
   - `genie team fire <agent> [--team <name>]`
   - `genie team ls [<name>]` — no arg = teams, with arg = members
   - `genie team disband <name>`
3. Remove: `genie team ensure`, blueprint-related code
4. Remove `genie _open [team]` hidden command (functionality absorbed by team create + session flow)
5. Update genie config schema: ensure `terminal.worktreeBase` is supported (default: `.worktrees`)

**Acceptance criteria:**
- `genie team create feat/test --repo /path --branch dev` creates worktree at `<worktreeBase>/feat/test`, branch `feat/test` from `dev`
- Re-running `team create` for existing team doesn't fail
- `genie team hire agent-name` adds to team (auto-detects team from leader context)
- `genie team hire council` adds all 10 council members
- `genie team fire agent-name` removes from team
- `genie team ls` lists all teams. `genie team ls feat/test` lists members
- `genie team disband feat/test` kills members + removes worktree
- `ensure` and `blueprints` commands no longer exist

**Validation:**
```bash
bun run typecheck
bun test src/lib/team-manager.test.ts
bun test src/term-commands/team.test.ts
```

**depends-on:** Group 1

---

### Group 4: Wish State Machine

**Goal:** Replace beads with wish-native state file. Deterministic state transitions via genie commands only.

**Deliverables:**
1. Create `src/lib/wish-state.ts`
   - Schema: `WishState { wish, groups: Record<string, GroupState> }`
   - `GroupState { status: 'blocked'|'ready'|'in_progress'|'done', assignee?, dependsOn?, startedAt?, completedAt? }`
   - State file: `.genie/state/<slug>.json` in CWD (shared worktree)
   - `createState(slug, groups)`: initialize from wish group definitions
   - `startGroup(slug, group, assignee)`: check deps → set `in_progress` → write. Refuses if deps not met.
   - `completeGroup(slug, group)`: set `done` → recalculate dependent groups (blocked→ready)
   - `getState(slug)`: read current state
   - `getGroupState(slug, group)`: read single group
   - File-lock for concurrent access
2. Add CLI commands (new `src/term-commands/state.ts` or inline in existing)
   - `genie done <slug>#<group>` — calls `completeGroup()`
   - `genie status <slug>` — pretty-prints all groups with status, assignee, timestamps
3. Remove beads integration
   - Remove `genie daemon *` commands (start/stop/status/restart)
   - Remove `genie ledger *` commands (validate, work)
   - Remove `genie brainstorm crystallize` (beads JSONL integration)
   - Remove beads-related imports and references throughout codebase
   - Remove `bd` CLI calls from all commands (close, ship, work, etc.)

**Acceptance criteria:**
- State file created at `.genie/state/<slug>.json` with correct group structure
- `startGroup` refuses when dependencies not met (returns error)
- `startGroup` sets `in_progress` with timestamp and assignee
- `completeGroup` sets `done`, recalculates dependent group statuses
- `genie done slug#2` works from CLI
- `genie status slug` shows readable state overview
- No `bd` or beads references remain in codebase
- `genie daemon *` and `genie ledger *` commands no longer exist

**Validation:**
```bash
bun run typecheck
bun test src/lib/wish-state.test.ts
grep -rn '\bbd\b\|beads\|daemon\|ledger' src/ --include='*.ts' | grep -v test | grep -v '.genie/' && echo "FAIL: beads refs remain" || echo "PASS"
```

**depends-on:** none

---

### Group 5: Dispatch Commands

**Goal:** Context-injecting dispatch commands that bridge the state machine and agent spawn.

**Deliverables:**
1. Create `src/term-commands/dispatch.ts`
   - `genie brainstorm <agent> <slug>` — reads `.genie/brainstorms/<slug>/DRAFT.md`, spawns agent with content + file path injected, agent enters `/brainstorm`
   - `genie wish <agent> <slug>` — reads `.genie/brainstorms/<slug>/DESIGN.md`, spawns agent with design + file path, agent enters `/wish`
   - `genie work <agent> <slug>#<group>` — reads `.genie/wishes/<slug>/WISH.md`, extracts specific group, calls `wishState.startGroup()`, spawns agent with group context + wish file path
   - `genie review <agent> <slug>#<group>` — reads wish group + git diff context, spawns agent with review scope
2. Context injection pattern (shared utility):
   - Build prompt: file path to full document + extracted section content + wish-level context (summary, scope, decisions)
   - Pass via `--append-system-prompt` or temp file approach for long content
3. Slug#group parsing utility: `parseRef("auth-bug#2")` → `{ slug: "auth-bug", group: "2" }`
4. Integration with spawn: dispatch calls `spawn` internally after state check

**Acceptance criteria:**
- `genie brainstorm agent-name slug` spawns with DRAFT.md content + path injected
- `genie wish agent-name slug` spawns with DESIGN.md content + path injected
- `genie work agent-name slug#2` checks state → sets in_progress → spawns with group 2 content
- `genie work agent-name slug#3` refuses if group 2 not done (dependency enforcement)
- `genie review agent-name slug#2` spawns with group + diff context
- All dispatch commands pass the file path so agent can read the full document

**Validation:**
```bash
bun run typecheck
bun test src/term-commands/dispatch.test.ts
```

**depends-on:** Group 2, Group 4

---

### Group 6: Messaging Redesign

**Goal:** Flat routing by name, team-scoped send, broadcast, group chat, auto-spawn.

**Deliverables:**
1. Rewrite `src/term-commands/msg.ts`
   - `genie send '<msg>' --to <name>` — resolve by name from directory (no `--team` needed)
   - Scope check: if sender is in a team, recipient must be in same team
   - Remove `--team` from send command
   - `genie broadcast '<msg>'` — leader sends to all team members (one-way)
   - `genie inbox [<name>] [--unread]` — same functionality, improved resolution
2. Create `src/lib/team-chat.ts`
   - Group channel per team: `<worktree>/.genie/chat/<team-name>.jsonl` (lives in shared worktree so all members can read)
   - `postMessage(team, sender, body)`: append to channel
   - `readMessages(team, since?)`: read channel history
3. Add chat commands in `src/term-commands/msg.ts`
   - `genie chat '<msg>' [--team <name>]` — post to team channel (auto-detect team from context)
   - `genie chat read [--team <name>] [--since <timestamp>]`
4. Rewrite `src/lib/protocol-router.ts` for directory-first resolution
   - Resolution order: directory by name → built-in by name → worker registry fallback
   - Auto-spawn: if agent offline + in directory → spawn → deliver
5. Update `src/hooks/handlers/auto-spawn.ts` for directory awareness
   - Check directory before templates for offline agent resolution

**Acceptance criteria:**
- `genie send 'hello' --to agent-name` delivers without `--team`
- Send from team member to non-team-member is rejected (scope enforcement)
- `genie broadcast 'update'` delivers to all members of sender's team
- `genie chat 'discussion point'` posts to team channel
- `genie chat read` shows channel history
- Message to offline registered agent triggers auto-spawn + delivery
- `--team` flag no longer exists on `send` command

**Validation:**
```bash
bun run typecheck
bun test src/term-commands/msg.test.ts
bun test src/lib/protocol-router.test.ts
bun test src/lib/team-chat.test.ts
```

**depends-on:** Group 1, Group 2, Group 3

---

### Group 7: Command Promotion, Namespace Removal & Session

**Goal:** Promote agent commands to top-level, remove `genie agent` namespace, add `--session`, implement `genie ls` smart view. Deprecated command removal is distributed across earlier groups (profiles in G1, blueprints/ensure/_open in G3, beads in G4). This group handles the remaining removals and the namespace restructure.

**Deliverables:**
1. Promote commands in `src/term-commands/agents.ts` and `src/genie.ts`
   - `genie spawn <name>` (was `genie agent spawn`) — already rewritten in G2
   - `genie kill <name>` (was `genie agent kill <id>`)
   - `genie stop <name>` (was `genie agent suspend <id>`) — rename suspend→stop
   - `genie history <name>` (was `genie agent history <worker>`)
   - `genie read <name>` (was `genie agent read <target>`)
   - `genie answer <name> <choice>` (was `genie agent answer <worker> <choice>`)
   - All resolve by agent name, not pane ID or worker ID
2. Remove remaining deprecated commands not handled by earlier groups
   - `genie agent dashboard`
   - `genie agent watchdog`
   - `genie agent approve`
   - `genie agent exec`
   - `genie agent ship`
   - `genie agent close`
   - `genie agent events` (keep internal module, remove CLI command)
   - `genie task *` (all 10: create, update, ship, close, ls, link, unlink, create-local, list-local, update-local)
   - `genie council` (old command — replaced by `genie team hire council` + skill)
3. Remove `genie agent` namespace entirely — top-level commands only
4. Add `genie --session <name>` to entry point for named leader sessions
   - Maintains name→UUID mapping internally
   - `genie --session mywork` starts a new named session
   - `genie --session mywork` again resumes it
5. Implement `genie ls` smart view
   - Default: shows registered agents with runtime status (running/idle/offline) and current team
   - Output: `NAME | DIR | STATUS | TEAM | MODEL`
   - Built-in roles only shown when running (not in idle listing)

**Acceptance criteria:**
- All promoted commands work at top level: `genie kill`, `genie stop`, `genie history`, `genie read`, `genie answer`
- `genie agent *` namespace no longer exists
- `genie task *` namespace no longer exists
- `genie --session mywork` starts a new named session
- `genie --session mywork` again resumes the same session (identified by name, not UUID)
- `genie ls` shows registered agents with runtime status and team membership
- `genie stop <name>` stops current run but keeps pane alive
- Old commands (dashboard, watchdog, approve, exec, ship, close, events, council) no longer exist

**Validation:**
```bash
bun run typecheck
grep -rn "command('agent')" src/ && echo "FAIL: agent namespace exists" || echo "PASS"
grep -rn "command('task')" src/ && echo "FAIL: task namespace exists" || echo "PASS"
grep -rn "command('profiles')" src/ && echo "FAIL: profiles namespace exists" || echo "PASS"
```

**depends-on:** Group 2, Group 3

---

### Group 8: Council Refactor

**Goal:** Council supports two modes — lightweight (skill in single session) and full spawn (real agents in team).

**Deliverables:**
1. Update built-in agents registry (`src/lib/builtin-agents.ts`) with council members
   - 10 members with: name, lens prompt (from current SKILL.md), default model
   - Smart routing table preserved (architecture, performance, security, etc.)
2. Implement `genie team hire council` in team manager
   - Hires all 10 council members into the team
   - Each spawned with their lens prompt via `--append-system-prompt-file` (or inline for built-ins)
   - Default model per member (configurable at spawn)
3. Update `/council` skill (SKILL.md) for dual-mode awareness
   - **Lightweight mode:** When run directly in a session, behaves as today (simulated perspectives)
   - **Full spawn mode:** When council members are hired in team, skill detects them and posts topic to team chat instead of simulating. Reads responses from chat. Leader makes final call.
4. Remove old `genie council` command from `src/genie.ts` (replaced by team hire + skill)

**Acceptance criteria:**
- `genie team hire council` adds all 10 council members to team
- Each council member spawns with correct lens prompt and default model
- `/council` in lightweight mode works as before (simulated, single session)
- `/council` in full spawn mode posts to team chat, council members respond independently
- Old `genie council` command no longer exists

**Validation:**
```bash
bun run typecheck
bun test src/lib/builtin-agents.test.ts
```

**depends-on:** Group 1, Group 3, Group 6

---

### Group 9: Skill Prompt Refinement

**Goal:** Update 10 skill prompts to align with new orchestration model using `/refine`.

**Deliverables:**
Each skill gets a `/refine` pass to update:

1. **brainstorm** — Multi-agent aware. Reads/writes shared worktree `.genie/`. Acknowledges injected context from dispatch. Handles concurrent editors.
2. **wish** — Collaborative. Creates wish file + state group definitions in shared worktree. Back-and-forth via messaging.
3. **work** — Does NOT manage state. Receives group context from dispatch. Signals completion to leader via `genie send`. Uses `genie spawn` for subagent dispatch. No `bd close`, no checkbox updates.
4. **review** — Receives scope from dispatch. Council can participate via team chat. Uses `genie spawn` for dispatch.
5. **fix** — Uses `genie spawn` for fixer/reviewer dispatch.
6. **dream** — Uses new team/worktree model. Creates teams per wish. Uses `genie work` for dispatch. State machine for tracking.
7. **council** — Dual-mode awareness (lightweight skill vs full spawn team).
8. **trace** — Uses `genie spawn` for dispatch.
9. **onboarding** — Update for new directory model, team model, session naming.
10. **docs** — Uses `genie spawn` for dispatch.

**Cross-cutting changes in all refined skills:**
- Dispatch method: `genie spawn <role>` replaces `Task tool` / `genie agent spawn --role`
- File paths: `.genie/` in shared worktree, not repo root
- State management: skills do not manage state — transitions via `genie work`/`genie done`
- Context injection: skills acknowledge injected context (file path + extracted section)
- Role separation preserved: never combine implementor+reviewer, fixer+reviewer, tracer+fixer

**Acceptance criteria:**
- All 10 skill SKILL.md files updated
- No skill references `genie agent spawn`, `Task tool`, `bd`, or beads
- `/work` skill has zero state management logic (no checkboxes, no status writes)
- `/brainstorm` and `/wish` reference shared worktree paths
- `/council` skill documents both modes

**Validation:**
```bash
grep -rn 'genie agent spawn\|Task tool\|\bbd\b\|beads' skills/ && echo "FAIL: old patterns" || echo "PASS"
grep -rn 'checkbox\|Status.*SHIPPED\|bd close' skills/work/ && echo "FAIL: state mgmt in /work" || echo "PASS"
```

**depends-on:** Group 5, Group 7, Group 8

---

### Group 10: Final Validation & Integration

**Goal:** Full quality gates pass with all changes integrated.

**Deliverables:**
1. Run full check suite (`bun run check`)
2. Run build (`bun run build`)
3. Verify no stale references remain (beads, tui, old commands, old patterns)
4. End-to-end smoke test: register agent → create team → hire → dispatch work → done → status
5. Open GitHub issue: "Monitor need for sub-group task granularity"

**Acceptance criteria:**
- `bun run check` exits 0
- `bun run build` succeeds
- No beads/bd references in src/
- No `genie agent` namespace in src/
- No `persistSystemPrompt` or `$(cat)` pattern in src/
- No profiles/blueprints code in src/
- E2E flow works: dir add → team create → team hire → genie work → genie done → genie status

**Validation:**
```bash
bun run check
bun run build
grep -rn 'persistSystemPrompt\|\\$\\(cat\|beads\|\bbd\b' src/ --include='*.ts' && echo "FAIL" || echo "PASS"
grep -rn "command('agent')\|command('task')\|command('profiles')" src/ --include='*.ts' && echo "FAIL" || echo "PASS"
```

**depends-on:** Group 7, Group 8, Group 9

---

## Dependency Graph

```
Group 1 (Directory)        Group 4 (State Machine)
    │                           │
    ├──→ Group 2 (Spawn) ──────┤
    │         │                 │
    │         ├──→ Group 5 (Dispatch) ──→ Group 9 (Skills)
    │         │                                │
    ├──→ Group 3 (Teams) ──→ Group 6 (Messaging)    │
    │         │                 │               │
    │         ├──→ Group 8 (Council)            │
    │         │         │                       │
    ├─────────┴──→ Group 7 (Promotion) ─────────┤
    │                                           │
    └───────────────────────────────→ Group 10 (Validation)
```

Parallelizable: Group 1 + Group 4 can start simultaneously.
Group 2 + Group 3 can start once Group 1 is done.
Group 5 can start once Group 2 + Group 4 are done.
Group 6 can start once Group 1 + Group 2 + Group 3 are done.
Group 7 can start once Group 2 + Group 3 are done (cleanup distributed to earlier groups).
Group 8 can start once Group 1 + Group 3 + Group 6 are done.

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| `--system-prompt-file` undocumented, could break in Claude Code update | Medium | Test in CI. Confirmed working today. Fallback: `--system-prompt "$(cat)"` |
| State file abandonment (agents don't run `genie done`) | High | State transitions are genie commands only. Orchestrator tracks at prompt level |
| Concurrent worktree edits from multiple agents | Medium | Git handles conflicts. Wish groups scoped to non-overlapping files |
| 10 skill prompts need /refine — high effort | Medium | Prioritize core chain (brainstorm→wish→work→review). Others incremental |
| Council full spawn = 10 Claude sessions = cost | Low | Leader chooses subset via smart routing. Lightweight mode for cheap reviews |
| Multi-team agent receives message — which context? | Medium | Send scoped to own team. Agent receives team context with dispatch |
| Removing 25+ commands breaks existing agent workflows | Medium | Clean break is decided. No backward compat. Update all agent AGENTS.md |
| beads removal leaves no task tracking for external integrations | Low | State file is the replacement. Issue opened for sub-group granularity if needed |
