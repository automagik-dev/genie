# Genie CLI v2 — Complete Framework Redesign

**Status:** Ready
**WRS:** 100/100

## Problem
The genie CLI has accumulated 40+ commands with overlapping functionality, inconsistent naming, and poor DX. Agent spawning creates clones instead of independent agents. Cross-agent messaging requires manual `--team` flags. Task state tracking (beads) is heavyweight and unreliable. Skill prompts don't align with the orchestration model. The entire framework needs a clean-break redesign.

---

## Architecture Decisions (all confirmed)

### 1. Native `--system-prompt-file` / `--append-system-prompt-file`
Claude Code hidden flags, confirmed working. Eliminates `persistSystemPrompt()`, `$(cat)` pattern, all temp files. Genie passes the file path directly to Claude Code at spawn time.

### 2. One Folder Per Agent
Each agent has ONE folder. That folder is where Claude Code starts (CWD) and contains `AGENTS.md` (identity). May or may not have git — irrelevant to agent identity.

### 3. Repo is Team-Level
- Agent directory entries CAN have an optional `repo` for solo use
- When agent is in a team, the team's `repo` overrides the agent's individual repo
- All team members work in the same repo/worktree
- Hierarchy: team repo > agent repo > agent dir (fallback CWD)

### 4. Per-Agent Prompt Mode
Directory entry stores `system` or `append`:
- **PMs, non-coders:** `system` — replace Claude's default coding prompt entirely
- **Engineers:** `append` — keep Claude's coding capabilities + add agent identity
- Determines whether `--system-prompt-file` or `--append-system-prompt-file` is used at spawn

### 5. Per-Agent Model Default
Directory entry stores optional `model` (e.g., `sonnet`, `opus`, `codex`). Can be overridden at spawn time with `--model`.

### 6. Optional Roles Declaration
Directory entry stores optional `roles[]` — built-in roles the agent can orchestrate (e.g., `implementor`, `tester`, `debugger`). Helps the agent self-organize without PM spelling it out. Dynamic orchestration still takes priority — having roles declared doesn't force anything.

### 7. No Backward Compatibility
Clean break. All old patterns replaced.

### 8. Agent Names Globally Unique
Flat routing by name. No `--team` needed for messaging.

### 9. Agents Can Be in Multiple Teams
Same agent hired into different teams, working on different tasks simultaneously.

### 10. Send Scoped to Own Team
Team leader can only message members of their own team (prevents cross-talk).

---

## Agents vs Roles

**Agents** and **Roles** are separate concepts:

- **Agents** = registered entities with identity (totvs-engineer, totvs-pm). Persistent. Have AGENTS.md, memory, personality. Registered in user directory.
- **Roles** = built-in capabilities (implementor, tester, reviewer, debugger...). Ephemeral. Spawned on demand. No identity, no memory. Ship with genie package.
- **Orchestration** = who bosses whom. Decided dynamically at runtime by whoever is leading. Not statically configured.

### Hierarchy Examples

**Complex project (dedicated agents):**
```
totvs-pm (agent)
  └─ totvs-engineer (agent, roles: [implementor, tester, debugger])
       └─ spawns implementor/tester/debugger roles as needed
  └─ totvs-qa (agent, roles: [reviewer, verifier, security])
       └─ spawns reviewer/verifier roles as needed
```

**Simple project (no dedicated agents):**
```
PM (agent)
  └─ implementor (built-in role, spawned directly)
  └─ reviewer (built-in role, spawned directly)
```

### Built-in Roles (ship with genie)

| Role | Description |
|---|---|
| `implementor` | Implements features and fixes bugs |
| `tester` | Writes and runs tests |
| `reviewer` | Reviews code and provides feedback |
| `debugger` | Diagnoses and fixes bugs |
| `verifier` | Verifies fixes and writes regression tests |
| `investigator` | Investigates root causes |
| `reproducer` | Creates minimal reproductions |
| `dreamer` | Generates ideas and explores possibilities |
| `critic` | Evaluates and refines ideas |
| `security` | Security-focused review |

### Built-in Council Members (ship with genie)

| Member | Lens | Default Model |
|---|---|---|
| `council-questioner` | Challenge assumptions | sonnet |
| `council-benchmarker` | Performance evidence | sonnet |
| `council-simplifier` | Complexity reduction | sonnet |
| `council-sentinel` | Security oversight | opus |
| `council-ergonomist` | Developer experience | sonnet |
| `council-architect` | Systems thinking | opus |
| `council-operator` | Operations reality | sonnet |
| `council-deployer` | Zero-config deployment | sonnet |
| `council-measurer` | Observability | sonnet |
| `council-tracer` | Production debugging | sonnet |

Council is hired as a group: `genie team hire council` (all or none).

### Resolution Order
```
User directory (genie dir add)  >  Built-in agents (ships with package)
```
User can override a built-in by registering the same name.

---

## Session & Team Flow

### Default Session (no args)
```bash
genie
# Opens persistent session in current dir
# For quick questions, ongoing conversation
# No team, no worktree
```

### Named Session
```bash
genie --session <name>
# Start or resume a named leader session
# Claude Code session naming used by default (not UUIDs)
```

### Team-Based Work
```bash
genie team create fix/auth-bug --repo ~/repos/genie --branch dev
# 1. Reads worktreeBase from ~/.genie/config.json (default: '.worktrees')
# 2. git -C ~/repos/genie pull origin dev
# 3. git -C ~/repos/genie worktree add <worktreeBase>/fix/auth-bug -b fix/auth-bug dev
# 4. Team leader session starts in <worktreeBase>/fix/auth-bug/
# 5. All hired agents work in <worktreeBase>/fix/auth-bug/
```

### Team Name = Branch Name
Following conventional git prefixes. No separate `--prefix` flag:
```bash
genie team create feat/agent-directory --repo ~/repos/genie --branch dev
genie team create fix/auth-bug --repo ~/repos/genie --branch dev
genie team create chore/cleanup --repo ~/repos/genie --branch dev
```

---

## Shared Worktree as Context Layer

All context files live in the team's worktree `.genie/` folder. No commits needed for sharing — all agents read/write from the same filesystem.

```
<worktreeBase>/fix/auth-bug/
├── .genie/
│   ├── brainstorms/auth-bug/DRAFT.md     # shared brainstorm draft
│   ├── brainstorms/auth-bug/DESIGN.md    # crystallized design
│   ├── wishes/auth-bug.md                # shared wish
│   └── state/auth-bug.json              # task state (genie-managed)
├── src/
└── ...
```

---

## State Machine (replaces beads)

**Core principle: agents never touch the state file. Genie is the state machine.**

### State File: `.genie/state/<slug>.json`

```json
{
  "wish": "auth-bug",
  "groups": {
    "1": {
      "status": "done",
      "assignee": "totvs-engineer",
      "startedAt": "2026-03-13T14:00:00Z",
      "completedAt": "2026-03-13T14:30:00Z"
    },
    "2": {
      "status": "in_progress",
      "assignee": "totvs-engineer",
      "startedAt": "2026-03-13T14:35:00Z"
    },
    "3": {
      "status": "blocked",
      "dependsOn": [2]
    }
  }
}
```

### State Transition Rules
1. Only `genie work` sets `in_progress` (at dispatch time, BEFORE spawn)
2. Only `genie done` sets `done` (explicit signal, run by leader or agent)
3. Only genie reads the state file to enforce ordering
4. Hooks validate: can't dispatch group N+1 until group N is `done`
5. Agents never import, read, or write the state file directly
6. Orchestrator (team leader) keeps track of guarantees at prompt level

### Failure Modes
| Failure | What Happens |
|---|---|
| Agent crashes mid-work | Group stays `in_progress`. Leader sees it, re-dispatches |
| Agent finishes but nobody runs `done` | Group stays `in_progress`. Leader follows up |
| Someone tries to start group 3 early | Genie refuses: "group 2 is not done" |
| Leader forgets where they left off | `genie status <slug>` shows all group states |

---

## Dispatch Commands (lifecycle)

Four dispatch commands mirror the skill lifecycle. Each one: resolves context → manages state → spawns agent with rich context injection.

### Context Injection Pattern
All dispatch commands inject:
1. **File path** to the full document (wish, brainstorm, etc.) — agent can read the whole thing
2. **Extracted section** content — the specific group/section being worked on
3. **Wish-level context** — problem statement, scope, decisions (the WHY)

### `genie brainstorm <agent> <slug>`
- Reads `.genie/brainstorms/<slug>/DRAFT.md` from shared worktree
- Spawns agent with draft content + file path as context
- Agent enters `/brainstorm` with full seed
- **Multi-agent:** multiple agents can brainstorm the same topic. PM kicks off, delegates, reviews
- Human can participate at any time via messaging

### `genie wish <agent> <slug>`
- Reads `.genie/brainstorms/<slug>/DESIGN.md` from shared worktree
- Spawns agent with design as context + file path
- Agent enters `/wish` with crystallized design
- **Collaborative:** PM and agent go back-and-forth on wish quality
- Creates state file with group definitions and dependency graph

### `genie work <agent> <slug>#<group>`
- Reads `.genie/wishes/<slug>.md` — passes file path for full context
- Extracts specific group content (tasks, acceptance criteria)
- Checks state: are dependencies met? → refuses if not
- Sets group to `in_progress` in state file BEFORE spawn
- Spawns agent with group context + wish file path
- Agent enters `/work` ready to execute

### `genie review <agent> <slug>#<group>`
- Reads wish group + PR/diff context
- Spawns agent with review scope + file path
- Agent enters `/review` with criteria to validate against
- Council can participate (via team chat)

### `genie done <slug>#<group>`
- Sets group to `done` in state file
- Unblocks dependent groups

### `genie status <slug>`
- Shows all groups with current state, assignees, timestamps

---

## Command Tree v2 (complete)

### Entry Point
```
genie                                     # Persistent session in current dir
genie --session <name>                    # Named/resumed leader session
```

### Dispatch (lifecycle — team leader orchestration)
```
genie brainstorm <agent> <slug>           # Spawn + inject brainstorm context
genie wish <agent> <slug>                 # Spawn + inject design for wish creation
genie work <agent> <slug>#<group>         # Check deps → in_progress → spawn with context
genie review <agent> <slug>#<group>       # Spawn + inject review scope
genie done <slug>#<group>                 # Mark group done, unblock dependents
genie status <slug>                       # Show wish group states
```

### Agent Lifecycle (top-level verbs)
```
genie spawn <name>                        # Spawn registered agent or built-in role
genie kill <name>                         # Force kill agent
genie stop <name>                         # Stop current run, keep pane alive
genie ls                                  # List agents, teams, state
genie history <name>                      # Compressed session timeline
genie read <name>                         # Tail agent pane output
genie answer <name> <choice>              # Answer agent prompt (menu nav / text)
```

### Messaging (flat routing by name)
```
genie send '<msg>' --to <name>            # Direct message (scoped to own team)
genie broadcast '<msg>'                   # Leader → all team members (one-way)
genie chat '<msg>' [--team <name>]        # Team group channel (interactive)
genie chat read [--team <name>]           # Read team channel history
genie inbox [<name>] [--unread]           # View inbox
```

### Directory (agent registry)
```
genie dir add <name>                      # Add agent to directory
      --dir <path>                        #   Agent folder (CWD + AGENTS.md)
      [--repo <path>]                     #   Default git repo (overridden by team)
      [--prompt-mode append|system]       #   Default: append
      [--model <model>]                   #   Default model
      [--roles <roles...>]               #   Built-in roles this agent can orchestrate
genie dir rm <name>                       # Remove from directory
genie dir ls [<name>]                     # List all or show single entry
genie dir edit <name>                     # Update entry fields
      [--dir <path>]
      [--repo <path>]
      [--prompt-mode append|system]
      [--model <model>]
      [--roles <roles...>]
```

### Team (dynamic collaboration)
```
genie team create <name>                  # Form team + worktree (idempotent)
      --repo <path>                       #   Git repo (required)
      [--branch <branch>]                #   Base branch (default: dev)
genie team hire <agent>                   # Add agent (auto-detects team from leader)
      [--team <name>]
genie team hire council                   # Hire all 10 council members
genie team fire <agent>                   # Remove agent
      [--team <name>]
genie team ls [<name>]                    # List teams or team members
genie team disband <name>                 # Kill members, cleanup worktree
```

### Infrastructure
```
genie setup                               # Install (review with install.sh base)
genie doctor                              # Diagnostics (review dep coverage)
genie shortcuts show|install|uninstall    # tmux keyboard shortcuts
```

---

## Complete Command Fate Map

### PROMOTED TO TOP-LEVEL
| Old | New |
|---|---|
| `genie agent spawn --role` | `genie spawn <name>` |
| `genie agent list` | `genie ls` |
| `genie agent kill <id>` | `genie kill <name>` |
| `genie agent suspend <id>` | `genie stop <name>` |
| `genie agent history <worker>` | `genie history <name>` |
| `genie agent answer <worker>` | `genie answer <name>` |
| `genie agent read <target>` | `genie read <name>` |
| `genie agent close + ship` | `genie done <slug>#<group>` |
| `genie send` | `genie send` (flat routing) |
| `genie inbox` | `genie inbox` |

### NEW COMMANDS
| Command | Purpose |
|---|---|
| `genie --session <name>` | Named leader sessions |
| `genie brainstorm <agent> <slug>` | Multi-agent brainstorm dispatch |
| `genie wish <agent> <slug>` | Collaborative wish creation dispatch |
| `genie work <agent> <slug>#<group>` | State-managed work dispatch |
| `genie review <agent> <slug>#<group>` | Review dispatch |
| `genie done <slug>#<group>` | Explicit completion signal |
| `genie status <slug>` | Wish state overview |
| `genie broadcast '<msg>'` | Leader → all members |
| `genie chat` / `genie chat read` | Team group channel |
| `genie team hire/fire` | Dynamic membership |
| `genie team hire council` | Group hire all council members |
| `genie dir add/rm/ls/edit` | Agent directory CRUD |

### DROPPED
| Command | Reason |
|---|---|
| `genie agent dashboard` | Never used |
| `genie agent watchdog` | Never used |
| `genie agent approve` | Future sprint |
| `genie agent exec` | Use tmux directly |
| `genie agent ship` | Merged into `genie done` |
| `genie agent events` | Internal only, not a user command |
| `genie _open [team]` | Incorporated into session flow |
| `genie team ensure` | Absorbed by `team create` |
| `genie team blueprints` | Dropped |
| `genie profiles *` (5 commands) | Replaced by directory |
| `genie daemon *` (4 commands) | Beads removed |
| `genie ledger *` (2 commands) | Beads removed |
| `genie brainstorm crystallize` | Beads integration, broken |
| `genie work <target>` (old) | Replaced by dispatch commands |
| `genie task *` (10 commands) | Replaced by state machine. Issue opened to monitor if sub-group granularity (option C) needed later |
| `genie council` (old command) | Replaced by `genie team hire council` + skill |

---

## Skill Prompt Review

### Skills Needing `/refine` Pass

All skills that dispatch subagents or interact with the orchestration model need updating:

| Skill | Key Changes |
|---|---|
| **brainstorm** | Multi-agent aware. Reads/writes in shared worktree. Acknowledges injected context from dispatch. Multiple agents can edit same DRAFT.md |
| **wish** | Collaborative. Creates state file with group definitions + dependency graph. Reads design from shared worktree. Back-and-forth via messaging |
| **work** | Does NOT manage state (no checkboxes, no `bd close`). Receives group context from dispatch. Signals completion to leader via message. Uses `genie spawn` for subagent dispatch |
| **review** | Receives scope from dispatch. Council can participate via team chat. Uses `genie spawn` for dispatch. Posts findings to team chat |
| **fix** | Uses `genie spawn` for fixer/reviewer dispatch. Max 2 loops unchanged |
| **dream** | Uses new team/worktree model. Creates teams per wish. Uses `genie work` for dispatch. State machine for tracking |
| **council** | Two modes: (1) Lightweight = same as today, simulated in one session. (2) Full spawn = `genie team hire council`, real agents discuss in team chat, leader makes final call |
| **trace** | Uses `genie spawn` for dispatch. Hands off to `/fix` unchanged |
| **onboarding** | Update for new directory model (`genie dir add`), new team model, new session naming |
| **docs** | Uses `genie spawn` for dispatch |

### Skills Unchanged
| Skill | Reason |
|---|---|
| **report** | Independent of orchestration. Uses `/trace` internally |
| **brain** | Independent. Knowledge vault via notesmd-cli |
| **refine** | Independent. Prompt optimizer, no dispatch |
| **learn** | Independent. Behavioral config only |

### Cross-Cutting Changes (all refined skills)
1. **Dispatch method:** `genie spawn <role>` replaces `Task tool` / `genie agent spawn --role`
2. **File paths:** `.genie/` in shared worktree, not repo root
3. **State management:** `/work` no longer manages state — transitions happen via `genie work`/`genie done`
4. **Context injection:** Skills acknowledge injected context (file path + extracted section) from dispatch commands
5. **Role separation preserved:** Never combine implementor+reviewer, fixer+reviewer, tracer+fixer in same session

---

## Schemas

### Agent Directory Entry
```typescript
interface DirectoryEntry {
  name: string;              // globally unique
  dir: string;               // agent folder (CWD + AGENTS.md)
  repo?: string;             // default git repo (overridden by team)
  promptMode: 'system' | 'append';
  model?: string;            // default model (sonnet, opus, codex)
  roles?: string[];          // built-in roles this agent can orchestrate
  registeredAt: string;
}
```

### Team
```typescript
interface Team {
  name: string;              // = branch name (e.g., "fix/auth-bug")
  repo: string;              // git repo path (required)
  baseBranch: string;        // branch to create worktree from (default: "dev")
  worktreePath: string;      // <worktreeBase>/<name>
  leader: string;            // leader's session reference
  members: string[];         // agent names (directory or built-in)
  createdAt: string;
}
```

### Wish State
```typescript
interface WishState {
  wish: string;              // slug
  groups: Record<string, GroupState>;
}

interface GroupState {
  status: 'blocked' | 'ready' | 'in_progress' | 'done';
  assignee?: string;         // agent name
  dependsOn?: number[];      // group numbers
  startedAt?: string;
  completedAt?: string;
}
```

### Genie Config (relevant additions)
```typescript
// In ~/.genie/config.json
{
  terminal: {
    worktreeBase: string;    // default: '.worktrees'
  }
}
```

---

## Naming Conventions
| Pattern | Convention |
|---|---|
| List anything | `ls` |
| Remove anything | `rm` |
| Add anything | `add` |
| Create group entity | `create` |
| Destroy group entity | `disband` |
| Add member | `hire` |
| Remove member | `fire` |

---

## Risks

| ID | Risk | Severity | Mitigation |
|----|------|----------|------------|
| R1 | **State file abandonment** — agents don't run `genie done`, groups stay `in_progress` forever | High | State transitions are genie commands, not agent behavior. Orchestrator tracks at prompt level. Leader follows up on stale `in_progress` |
| R2 | **Concurrent worktree edits** — multiple agents editing same files in shared worktree | Medium | Git handles file-level conflicts. Wish groups should be scoped to non-overlapping files. Review catches integration issues |
| R3 | **Built-in vs directory collision** — user registers agent with same name as built-in | Low | User directory wins (explicit override). Clear resolution order documented |
| R4 | **Multi-team agent confusion** — agent in 3 teams, receives message, which context? | Medium | Send is scoped to own team. Agent receives team context with each dispatch. Genie tracks which team each session belongs to |
| R5 | **`--system-prompt-file` undocumented** — hidden Claude Code flag could change/break | Medium | Test in CI. Flag confirmed working today. If removed, fall back to `--system-prompt "$(cat)"` pattern |
| R6 | **Skill prompt drift** — 10 skills need `/refine` pass, high effort | Medium | Prioritize core chain (brainstorm→wish→work→review). Others can be refined incrementally |
| R7 | **Council as real agents** — 10 agents spawned = 10 Claude sessions = cost | Low | Leader chooses subset (smart routing). Full council is rare. Lightweight mode (skill) exists for cheap reviews |

---

## Acceptance Criteria

### AC1: Agent Directory
- `genie dir add totvs-pm --dir ~/agents/pm --prompt-mode system` persists entry
- `genie dir ls` shows all registered agents
- `genie dir ls totvs-pm` shows single entry details
- `genie dir rm totvs-pm` removes entry
- `genie dir edit totvs-pm --model opus` updates entry
- Directory entry supports: name, dir, repo, promptMode, model, roles

### AC2: Spawn from Directory
- `genie spawn totvs-pm` resolves from directory, sets CWD to `dir`, injects AGENTS.md via `--[append-]system-prompt-file`
- Prompt mode from directory entry determines which flag is used
- Model from directory entry (or `--model` override) is passed to Claude Code
- Spawning a built-in role works without directory registration: `genie spawn implementor`
- Agent spawned outside team context → CWD = agent dir
- Agent spawned in team context → CWD = team worktree

### AC3: Team Lifecycle
- `genie team create feat/my-feature --repo ~/repos/genie --branch dev` creates worktree at `<worktreeBase>/feat/my-feature`, branch `feat/my-feature` from `dev`
- `genie team create` is idempotent (re-running doesn't fail)
- `genie team hire totvs-engineer` adds to team (auto-detects team from leader context)
- `genie team hire council` hires all 10 council members
- `genie team fire totvs-engineer` removes from team
- `genie team ls` lists all teams. `genie team ls feat/my-feature` lists members
- `genie team disband feat/my-feature` kills all members, cleans up worktree

### AC4: State Machine
- `genie work totvs-engineer auth-bug#2` checks dependencies → sets group 2 to `in_progress` → spawns agent with context
- `genie work` refuses if dependencies not met ("group 1 is not done")
- `genie done auth-bug#2` sets group to `done`, unblocks dependents
- `genie status auth-bug` shows all groups with status, assignee, timestamps
- State file lives at `.genie/state/<slug>.json` in shared worktree
- Agents never read or write the state file directly

### AC5: Dispatch Commands
- `genie brainstorm <agent> <slug>` spawns with DRAFT.md path + content injected
- `genie wish <agent> <slug>` spawns with DESIGN.md path + content injected
- `genie work <agent> <slug>#<group>` extracts group content, injects with wish file path
- `genie review <agent> <slug>#<group>` injects group + PR/diff context
- All dispatch commands pass the file path so agent can read the full document

### AC6: Messaging
- `genie send 'msg' --to totvs-engineer` delivers without `--team` flag
- Send is scoped: leader can only message own team members
- `genie broadcast 'msg'` delivers to all team members (leader only)
- `genie chat 'msg'` posts to team group channel
- `genie chat read` shows channel history
- Message to offline agent triggers auto-spawn + delivery

### AC7: Flat Naming
- All listing commands use `ls`
- All remove commands use `rm`
- All add commands use `add`
- `genie stop` (not suspend), `genie done` (not close/ship)

### AC8: Skill Prompt Alignment
- 10 skills updated via `/refine` to use `genie spawn` for dispatch
- `/work` does NOT manage state — receives context, signals completion via message
- `/brainstorm` and `/wish` read/write in shared worktree `.genie/`
- `/council` supports two modes: lightweight (skill) and full spawn (team)
- All skills acknowledge injected context from dispatch commands

### AC9: Cleanup
- All 10 `genie task *` commands removed
- All `genie profiles *` commands removed (replaced by directory)
- All `genie daemon *` commands removed (beads removed)
- All `genie ledger *` commands removed (beads removed)
- `genie agent *` namespace removed (promoted to top-level)
- `genie team ensure`, `genie team blueprints` removed
- `genie _open`, `genie agent dashboard/watchdog/approve/exec/ship` removed
- Issue opened to monitor if sub-group task granularity needed later

---

## Decisions Made (complete — 36 decisions)
1. Native `--system-prompt-file` / `--append-system-prompt-file` ✅
2. One folder per agent ✅
3. Repo at team level, optional at agent level, team overrides ✅
4. Per-agent prompt mode in directory entry ✅
5. Per-agent default model in directory entry ✅
6. Optional roles declaration in directory entry ✅
7. No backward compat ✅
8. Agent names globally unique ✅
9. Flat messaging by name, scoped to own team ✅
10. Agents can be in multiple teams ✅
11. `suspend` → `stop` ✅
12. Team = dynamic hire/fire ✅
13. Team name = branch name (conventional git prefixes) ✅
14. Worktree base configurable, default `.worktrees` ✅
15. Broadcast (leader-only) + Chat (group channel) ✅
16. Auto-spawn on message to offline agent ✅
17. `close` + `ship` → `done` (state transition) ✅
18. Profiles replaced by directory ✅
19. Blueprints dropped ✅
20. Dashboard, watchdog, approve, exec dropped ✅
21. `_open` removed, session flow replaces it ✅
22. `ensure` absorbed into `team create` (idempotent) ✅
23. Naming: ls/rm/add consistently ✅
24. Commands promoted to top-level (no `agent` namespace) ✅
25. `genie` no args = persistent session ✅
26. Context files live in shared worktree `.genie/` ✅
27. Beads replaced by wish-native state file ✅
28. State machine: only genie commands mutate state, agents never touch it ✅
29. Dispatch commands (brainstorm/wish/work/review) inject context + manage state ✅
30. Brainstorm/wish are now multi-agent with optional human participation ✅
31. Skill prompts must be refined to align with new orchestration model ✅
32. Council: lightweight (skill) + full spawn (team hire) modes ✅
33. Tasks die completely — wish groups are the only unit of work ✅
34. Agents ≠ Roles — separate concepts, dynamic orchestration ✅
35. Built-in roles + council ship with genie package ✅
36. Council hired as group: `genie team hire council` (all or none) ✅
