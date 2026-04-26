# Genie CLI Reference

Complete command reference generated from `src/term-commands/`. Organized by category.

---

## Table of Contents

- [Core Commands](#core-commands) -- spawn, kill, stop, resume, ls, send, broadcast, status, done, reset, work, review
- [Agent Namespace](#agent-namespace) -- genie agent spawn/stop/resume/kill/list/show/log/send/inbox/answer/brief/register/directory
- [Task Management](#task-management) -- genie task create/list/show/move/assign/tag/comment/block/unblock/done/link/checkout/release/unlock/close-merged/archive/unarchive/dep
- [Team Management](#team-management) -- genie team create/hire/fire/ls/archive/unarchive/disband/done/blocked/cleanup
- [Board & Pipeline](#board--pipeline) -- genie board create/list/show/edit/delete/columns/use/export/import/reconcile/archive + templates
- [Project Management](#project-management) -- genie project list/create/show
- [Events & Observability](#events--observability) -- genie events list/errors/costs/tools/timeline/summary/scan
- [Sessions & History](#sessions--history) -- genie sessions list/replay/search/sync, genie history, genie log, genie read
- [Database](#database) -- genie db status/migrate/query/url/backup/restore
- [Scheduling](#scheduling) -- genie schedule create/list/cancel/retry/history
- [Daemon](#daemon) -- genie daemon install/start/stop/status/logs
- [Infrastructure](#infrastructure) -- genie serve start/stop/status
- [Brain (Enterprise)](#brain-enterprise) -- genie brain install/uninstall/update/version + passthrough
- [Omni Bridge](#omni-bridge) -- genie omni start/stop/status
- [Import/Export](#importexport) -- genie export/import
- [Dispatch](#dispatch) -- genie dispatch brainstorm/wish/review, genie work
- [QA System](#qa-system) -- genie qa run/status/history/check, genie qa-report
- [Tags](#tags) -- genie tag list/create
- [Types](#types) -- genie type list/show/create
- [Releases](#releases) -- genie release create/list
- [Templates](#templates) -- genie template list/show/delete
- [Metrics](#metrics) -- genie metrics now/history/agents
- [Notifications](#notifications) -- genie notify set/list/remove
- [Hooks](#hooks) -- genie hook dispatch
- [Utility Commands](#utility-commands) -- genie setup/doctor/update/uninstall/init/shortcuts/app

---

## Core Commands

Top-level shortcuts for common operations. These are aliases for commands in the `agent` namespace or other namespaces.

### `genie spawn <name>`

Spawn a new agent by name (resolves from directory or built-ins). Single verb, state-gated by the canonical row's liveness — see [**SPAWN-TEAM-RESOLUTION.md**](SPAWN-TEAM-RESOLUTION.md) for the full model.

**State-gated outcome:**

| Canonical row `<name>` | Result |
|------------------------|--------|
| missing | create canonical with a fresh UUID |
| present, pane **dead** | resume canonical (same UUID) |
| present, pane **alive** | create a **parallel** `<name>-<s4>` (s4 = first 4 hex chars of the parallel's fresh UUID) |

Parallels are off the bare-name auto-resume path — revive a specific parallel with `genie spawn <name>-<s4>`.

**Team-resolution precedence** (first non-null wins — see `resolveTeamName` at `src/term-commands/agents.ts:1675`):

| Tier | Source |
|------|--------|
| 1 | `--team` flag |
| 2 | `agent.entry?.team` (PG `agent_templates`) |
| 3 | `$GENIE_TEAM` env var |
| 4 | `discoverTeamName()` — JSONL `leadSessionId` match → tmux session name |
| 5 | `findTeamsContainingAgent(name)` — on-disk native team config member scan (heuristic, last-resort) |

If every tier yields nothing AND the agent is globally registered, `ensureNativeTeam` auto-creates a team-of-one named after the agent.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--provider <provider>` | string | `claude` | Provider: claude or codex |
| `--team <team>` | string | precedence chain above | Team name (tier 1) |
| `--model <model>` | string | | Model override (e.g., sonnet, opus) |
| `--skill <skill>` | string | | Skill to load |
| `--layout <layout>` | string | `mosaic` | Layout mode: mosaic or vertical |
| `--color <color>` | string | | Teammate pane border color |
| `--plan-mode` | boolean | | Start teammate in plan mode |
| `--permission-mode <mode>` | string | | Permission mode (e.g., acceptEdits) |
| `--extra-args <args...>` | string[] | | Extra CLI args forwarded to provider |
| `--cwd <path>` | string | | Working directory for the agent |
| `--session <session>` | string | | Tmux session name to spawn into |
| `--role <role>` | string | | Override role name for registration |
| `--new-window` | boolean | | Create a new tmux window instead of splitting |
| `--window <target>` | string | | Tmux window to split into (e.g., genie:3) |
| `--no-auto-resume` | boolean | | Disable auto-resume on pane death |
| `--stream` | boolean | | Stream SDK messages to stdout in real-time |
| `--stream-format <format>` | string | `text` | Streaming output format: text, json, ndjson |
| `--sdk-max-turns <n>` | number | | SDK: max conversation turns |
| `--sdk-max-budget <usd>` | number | | SDK: max budget in USD |
| `--sdk-stream` | boolean | | SDK: enable streaming output |
| `--sdk-effort <level>` | string | | SDK: reasoning effort level (low, medium, high, max) |

```bash
genie spawn simone                                # Canonical resume (or create if missing)
genie spawn simone                                # 2nd invocation while alive → parallel simone-<s4>
genie spawn simone-a3f7                           # Revive a specific parallel by full id
genie spawn engineer                              # Spawn built-in engineer role
genie spawn my-agent --team my-feature            # Tier 1 override (explicit)
genie spawn council--questioner --provider codex  # Use Codex provider
```

Short-id collisions (two parallels minting the same 4-hex prefix) are resolved by extending the slice one char at a time until unique — see `pickParallelShortId` at `src/term-commands/agents.ts:1725`. Killed parallels free their id back to the pool.

### `genie kill <name>`

Force kill an agent by name.

### `genie stop <name>`

Stop an agent (preserves session for resume).

### `genie resume [name]`

Resume a suspended/failed agent with its Claude session.

| Option | Type | Description |
|--------|------|-------------|
| `--all` | boolean | Resume all eligible agents |

### `genie ls`

List registered agents with runtime status.

| Option | Type | Description |
|--------|------|-------------|
| `--json` | boolean | Output as JSON |

### `genie send <body>`

Send a direct message to an agent (PG-backed).

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--to <agent>` | string | `team-lead` | Recipient agent name |
| `--from <sender>` | string | auto-detected | Sender ID |
| `--team <name>` | string | | Explicit team context |

```bash
genie send 'start task #3' --to engineer      # Message a specific agent
genie send 'status update' --to team-lead      # Report to team lead
genie send 'deploy ready' --team my-feature    # Message within team context
```

### `genie broadcast <body>`

Send a message to your team conversation (PG-backed).

| Option | Type | Description |
|--------|------|-------------|
| `--from <sender>` | string | Sender ID (auto-detected) |
| `--team <name>` | string | Team name (auto-detected) |

### `genie wish done <ref>`

Mark a wish group as done. Format: `<slug>#<group>`. (Flat form `genie done` was removed — now lives under the `genie wish` command group.)

### `genie wish status <slug>`

Show wish state overview for all groups. (Flat form `genie status` was removed.)

### `genie wish reset <ref>`

Reset an in-progress group back to ready, or wipe a whole wish with a bare slug. Format: `<slug>#<group>` or `<slug>`. (Flat form `genie reset` was removed.)

### `genie read <name>`

Read terminal output from an agent pane.

| Option | Type | Description |
|--------|------|-------------|
| `-n, --lines <number>` | string | Number of lines to read |
| `--from <line>` | string | Start line |
| `--to <line>` | string | End line |
| `--range <range>` | string | Line range (e.g., "10-20") |
| `--search <text>` | string | Search for text |
| `--grep <pattern>` | string | Grep for pattern |
| `-f, --follow` | boolean | Follow mode (like tail -f) |
| `--all` | boolean | Show all output |
| `-r, --reverse` | boolean | Reverse order |
| `--json` | boolean | Output as JSON |

### `genie answer <name> <choice>`

Answer a question for an agent (use `text:...` for text input).

### `genie history <name>`

Show compressed session history for an agent.

| Option | Type | Description |
|--------|------|-------------|
| `--full` | boolean | Show full conversation without compression |
| `--since <n>` | number | Show last N user/assistant exchanges |
| `--last <n>` | number | Show last N transcript entries |
| `--type <role>` | string | Filter by role (user, assistant, tool_call) |
| `--after <timestamp>` | string | Only entries after ISO timestamp |
| `--json` | boolean | Output as JSON |
| `--ndjson` | boolean | Output as newline-delimited JSON |
| `--raw` | boolean | Output raw JSONL entries |
| `--log-file <path>` | string | Direct path to log file |

### `genie log [agent]`

Unified observability feed -- aggregates transcript, DMs, team chat.

| Option | Type | Description |
|--------|------|-------------|
| `--team <name>` | string | Show interleaved feed for all agents in a team |
| `--type <kind>` | string | Filter by event kind (transcript, message, tool_call, state, system) |
| `--since <timestamp>` | string | Only events after ISO timestamp |
| `--last <n>` | number | Show last N events |
| `--ndjson` | boolean | Output as newline-delimited JSON |
| `--json` | boolean | Output as pretty JSON |
| `-f, --follow` | boolean | Follow mode -- real-time streaming |

---

## Agent Namespace

All commands under `genie agent`. Top-level shortcuts (spawn, kill, stop, etc.) are aliases for these.

### `genie agent spawn <name>`

Spawn a new agent by name (resolves from directory or built-ins). Same options as `genie spawn`.

Additional options only on the agent namespace version:

| Option | Type | Description |
|--------|------|-------------|
| `--prompt <prompt>` | string | Initial prompt (first user message) |

### `genie agent stop <name>`

Stop an agent (preserves session for resume).

### `genie agent resume [name]`

Resume a suspended/failed agent with its Claude session.

| Option | Type | Description |
|--------|------|-------------|
| `--all` | boolean | Resume all eligible agents |

### `genie agent kill <name>`

Force kill an agent by name.

### `genie agent list` (alias: `ls`)

List registered agents with runtime status.

| Option | Type | Description |
|--------|------|-------------|
| `--json` | boolean | Output as JSON |

### `genie agent show <name>`

Show agent identity and current executor detail.

| Option | Type | Description |
|--------|------|-------------|
| `--json` | boolean | Output as JSON |

### `genie agent log [agent]`

Unified observability feed -- aggregates transcript, DMs, team chat.

| Option | Type | Description |
|--------|------|-------------|
| `--team <name>` | string | Show interleaved feed for all agents in a team |
| `--type <kind>` | string | Filter by event kind |
| `--since <timestamp>` | string | Only events after ISO timestamp |
| `--last <n>` | number | Show last N events |
| `--ndjson` | boolean | Output as newline-delimited JSON |
| `--json` | boolean | Output as pretty JSON |
| `-f, --follow` | boolean | Follow mode -- real-time streaming |
| `--raw` | boolean | Show raw pane capture (was `genie read`) |
| `--transcript` | boolean | Show compressed transcript (was `genie history`) |
| `--full` | boolean | Show full conversation (with --transcript) |
| `--search <query>` | string | Search across sessions |
| `-n, --lines <number>` | string | Number of lines to read (with --raw) |

### `genie agent send <body>`

Send a direct message to an agent (hierarchy-enforced).

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--to <agent>` | string | `team-lead` | Recipient agent name |
| `--from <sender>` | string | auto-detected | Sender ID |
| `--team <name>` | string | | Explicit team context |
| `--broadcast` | boolean | | Send to all direct reports |

### `genie agent inbox`

Inbox management -- list messages or watch for new ones.

#### `genie agent inbox list [agent]`

List conversations with recent messages (default subcommand).

| Option | Type | Description |
|--------|------|-------------|
| `--json` | boolean | Output as JSON |

#### `genie agent inbox watch`

Run inbox watcher in foreground (Ctrl+C to stop).

### `genie agent answer <name> <choice>`

Answer a question for an agent (use `text:...` for text input).

### `genie agent brief`

Show startup brief -- aggregated context since last session.

| Option | Type | Description |
|--------|------|-------------|
| `--team <name>` | string | Team name (default: GENIE_TEAM) |
| `--agent <name>` | string | Agent name (default: GENIE_AGENT_NAME) |
| `--since <iso>` | string | Start timestamp (default: last executor end) |

### `genie agent register <name>`

Register an agent locally and auto-register in Omni when configured.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--dir <path>` | string | **required** | Agent folder (CWD + AGENTS.md) |
| `--repo <path>` | string | | Default git repo |
| `--prompt-mode <mode>` | string | `append` | Prompt mode: append or system |
| `--model <model>` | string | | Default model (sonnet, opus, codex) |
| `--roles <roles...>` | string[] | | Built-in roles this agent can orchestrate |
| `--global` | boolean | | Write to global directory |
| `--skip-omni` | boolean | | Skip Omni auto-registration |

### `genie agent directory [name]` (alias: `dir`)

List all agents or show single entry details from directory.

| Option | Type | Description |
|--------|------|-------------|
| `--json` | boolean | Output as JSON |
| `--builtins` | boolean | Include built-in roles and council members |
| `--all` | boolean | Include archived agents |

Special: passing `sync` as the name runs directory synchronization.

---

## Task Management

Commands under `genie task`.

### `genie task create <title>`

Create a new task.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--type <type>` | string | `software` | Task type |
| `--priority <priority>` | string | `normal` | Priority: urgent, high, normal, low |
| `--due <date>` | string | | Due date (YYYY-MM-DD) |
| `--start <date>` | string | | Start date (YYYY-MM-DD) |
| `--tags <tags>` | string | | Comma-separated tag IDs |
| `--parent <id>` | string | | Parent task ID or #seq |
| `--assign <name>` | string | | Assign to local actor |
| `--description <text>` | string | | Task description |
| `--effort <effort>` | string | | Estimated effort (e.g., "2h", "3 points") |
| `--comment <msg>` | string | | Initial comment on the task |
| `--project <name>` | string | | Create task in a specific project |
| `--board <name>` | string | | Board name to assign task to |
| `--gh <owner/repo#N>` | string | | Link to GitHub issue |
| `--external-id <id>` | string | | External tracker ID |
| `--external-url <url>` | string | | External tracker URL |

### `genie task list`

List tasks with filters.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--stage <stage>` | string | | Filter by stage |
| `--type <type>` | string | | Filter by type |
| `--status <status>` | string | | Filter by status |
| `--priority <priority>` | string | | Filter by priority |
| `--release <release>` | string | | Filter by release |
| `--due-before <date>` | string | | Filter by due date |
| `--mine` | boolean | | Show only tasks assigned to me |
| `--project <name>` | string | | Show tasks for a specific project |
| `--board <name>` | string | | Filter by board name |
| `--gh <owner/repo#N>` | string | | Filter by GitHub issue link |
| `--by-column` | boolean | | Group tasks by board column (kanban view) |
| `--include-done` | boolean | | Include done tasks in kanban view |
| `--all` | boolean | | Show tasks from ALL projects |
| `--limit <n>` | string | `100` | Max number of tasks |
| `--offset <n>` | string | `0` | Skip first N tasks |
| `--json` | boolean | | Output as JSON |

### `genie task show <id>`

Show task detail (accepts task-id or #seq).

| Option | Type | Description |
|--------|------|-------------|
| `--json` | boolean | Output as JSON |

### `genie task move <id>`

Move task to a new stage.

| Option | Type | Description |
|--------|------|-------------|
| `--to <stage>` | string | **required** -- Target stage |
| `--comment <msg>` | string | Comment on the move |

### `genie task assign <id>`

Assign an actor to a task.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--to <name>` | string | **required** | Actor name |
| `--role <role>` | string | `assignee` | Actor role |
| `--comment <msg>` | string | | Comment on the assignment |

### `genie task tag <id> <tags...>`

Add tags to a task.

### `genie task comment <id> <message>`

Add a comment to a task.

| Option | Type | Description |
|--------|------|-------------|
| `--reply-to <msgId>` | string | Reply to a specific message ID |

### `genie task block <id>`

Mark task as blocked.

| Option | Type | Description |
|--------|------|-------------|
| `--reason <reason>` | string | **required** -- Reason for blocking |
| `--comment <msg>` | string | Additional comment |

### `genie task unblock <id>`

Unblock a task.

| Option | Type | Description |
|--------|------|-------------|
| `--comment <msg>` | string | Comment on unblock |

### `genie task done <id>`

Mark task as done.

| Option | Type | Description |
|--------|------|-------------|
| `--comment <msg>` | string | Comment on completion |

### `genie task link <id>`

Link task to an external tracker (GitHub, Jira, etc.).

| Option | Type | Description |
|--------|------|-------------|
| `--gh <owner/repo#N>` | string | Link to GitHub issue |
| `--external-id <id>` | string | External tracker ID |
| `--external-url <url>` | string | External tracker URL |

### `genie task checkout <id>`

Atomically claim a task for execution.

### `genie task release <id>`

Release task checkout claim.

### `genie task unlock <id>`

Force-release a stale checkout (admin override).

### `genie task close-merged`

Auto-close tasks whose wish slugs match recently merged PRs.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--since <duration>` | string | `24h` | Time window for merged PRs |
| `--dry-run` | boolean | | Show what would be closed |
| `--repo <owner/repo>` | string | | Override GitHub remote detection |

### `genie task archive <id>`

Archive a task (soft-delete -- preserves all data).

### `genie task unarchive <id>`

Restore an archived task to its previous status.

### `genie task dep <id>`

Manage task dependencies.

| Option | Type | Description |
|--------|------|-------------|
| `--depends-on <id2>` | string | This task depends on id2 |
| `--blocks <id2>` | string | This task blocks id2 |
| `--relates-to <id2>` | string | This task relates to id2 |
| `--remove <id2>` | string | Remove dependency on id2 |

---

## Team Management

Commands under `genie team`.

### `genie team create <name>`

Create a new team with a git worktree.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--repo <path>` | string | **required** | Path to the git repository |
| `--branch <branch>` | string | `dev` | Base branch to create from |
| `--wish <slug>` | string | | Wish slug -- auto-spawns a task leader |
| `--tmux-session <name>` | string | derived from repo | Tmux session to place team window in |
| `--session <name>` | string | | Alias for --tmux-session (deprecated) |
| `--no-spawn` | boolean | | Create team without spawning the leader |

```bash
genie team create my-feature --repo .                          # Create team in current repo
genie team create my-feature --repo . --wish my-feature-slug   # Create team with a wish
genie team create hotfix --repo . --branch main                # Create from main branch
```

### `genie team hire <agent>`

Add an agent to a team. Passing `council` hires all 10 council members.

| Option | Type | Description |
|--------|------|-------------|
| `--team <name>` | string | Team name (auto-detects from context) |

### `genie team fire <agent>`

Remove an agent from a team.

| Option | Type | Description |
|--------|------|-------------|
| `--team <name>` | string | Team name (auto-detects from context) |

### `genie team ls [name]` (alias: `list`)

List teams (no arg) or members of a specific team.

| Option | Type | Description |
|--------|------|-------------|
| `--all` | boolean | Include archived teams |
| `--json` | boolean | Output as JSON |

### `genie team archive <name>`

Archive a team (preserves all data, kills members).

### `genie team unarchive <name>`

Restore an archived team.

### `genie team disband <name>`

Disband a team (archives -- preserves data). Alias for `genie team archive`.

### `genie team done <name>`

Mark a team as done and kill all members.

### `genie team blocked <name>`

Mark a team as blocked and kill all members.

### `genie team cleanup`

Kill tmux windows for done/archived teams.

| Option | Type | Description |
|--------|------|-------------|
| `--dry-run` | boolean | Show what would be cleaned without acting |

---

## Board & Pipeline

Commands under `genie board`.

### `genie board create <name>`

Create a new board.

| Option | Type | Description |
|--------|------|-------------|
| `--project <project>` | string | Project name |
| `--from <template>` | string | Create from template name |
| `--columns <columns>` | string | Comma-separated column names |
| `--description <text>` | string | Board description |

### `genie board list`

List all boards.

| Option | Type | Description |
|--------|------|-------------|
| `--project <project>` | string | Filter by project |
| `--all` | boolean | Include archived boards |
| `--json` | boolean | Output as JSON |

### `genie board show <name...>`

Show board detail.

| Option | Type | Description |
|--------|------|-------------|
| `--project <project>` | string | Disambiguate by project |
| `--json` | boolean | Output as JSON |

### `genie board edit <name...>`

Edit board or column properties.

| Option | Type | Description |
|--------|------|-------------|
| `--project <project>` | string | Disambiguate by project |
| `--column <col>` | string | Column name to edit |
| `--gate <gate>` | string | New gate value (human\|agent\|human+agent) |
| `--action <action>` | string | New action skill |
| `--color <color>` | string | New color hex |
| `--rename <new>` | string | Rename the column |
| `--name <new>` | string | Rename the board itself |
| `--description <text>` | string | Update description |

### `genie board delete <name...>`

Delete a board.

| Option | Type | Description |
|--------|------|-------------|
| `--project <project>` | string | Disambiguate by project |
| `--force` | boolean | Skip confirmation |

### `genie board columns <name...>`

Show board column pipeline.

| Option | Type | Description |
|--------|------|-------------|
| `--project <project>` | string | Disambiguate by project |
| `--json` | boolean | Output as JSON |

### `genie board use <name...>`

Set active board for current repo.

| Option | Type | Description |
|--------|------|-------------|
| `--project <project>` | string | Disambiguate by project |

### `genie board export <name...>`

Export board as JSON.

| Option | Type | Description |
|--------|------|-------------|
| `--project <project>` | string | Disambiguate by project |
| `--output <file>` | string | Write to file instead of stdout |

### `genie board import`

Import board from JSON file.

| Option | Type | Description |
|--------|------|-------------|
| `--json <file>` | string | **required** -- JSON file to import |
| `--project <project>` | string | **required** -- Target project |

### `genie board reconcile <name...>`

Fix orphaned column_ids by matching task stage to board columns.

| Option | Type | Description |
|--------|------|-------------|
| `--project <project>` | string | Disambiguate by project |
| `--json` | boolean | Output as JSON |

### `genie board archive <name...>`

Archive a board and its unfinished tasks.

| Option | Type | Description |
|--------|------|-------------|
| `--project <project>` | string | Disambiguate by project |

### Board Templates

Commands under `genie board template`.

#### `genie board template list`

List all board templates.

| Option | Type | Description |
|--------|------|-------------|
| `--json` | boolean | Output as JSON |

#### `genie board template show <name>`

Show template detail with pipeline view.

| Option | Type | Description |
|--------|------|-------------|
| `--json` | boolean | Output as JSON |

#### `genie board template create <name>`

Create a board template.

| Option | Type | Description |
|--------|------|-------------|
| `--from-board <board>` | string | Create from existing board |
| `--columns <columns>` | string | Comma-separated column names |
| `--description <text>` | string | Template description |

#### `genie board template edit <name>`

Edit a template column.

| Option | Type | Description |
|--------|------|-------------|
| `--column <col>` | string | Column name to edit |
| `--gate <gate>` | string | New gate value |
| `--action <action>` | string | New action skill |
| `--rename <new>` | string | Rename the column |
| `--color <color>` | string | New color hex |

#### `genie board template rename <old> <new>`

Rename a template.

#### `genie board template delete <name>`

Delete a template.

---

## Project Management

Commands under `genie project`.

### `genie project list`

List all projects.

| Option | Type | Description |
|--------|------|-------------|
| `--all` | boolean | Include archived projects |
| `--json` | boolean | Output as JSON |

### `genie project create <name>`

Create a new project.

| Option | Type | Description |
|--------|------|-------------|
| `--virtual` | boolean | Create a virtual project (not tied to a repo) |
| `--repo <path>` | string | Repo path for the project |
| `--description <text>` | string | Project description |

### `genie project show <name>`

Show project detail with task stats.

| Option | Type | Description |
|--------|------|-------------|
| `--json` | boolean | Output as JSON |

---

## Events & Observability

Commands under `genie events`. Queries audit events from PG.

### `genie events list` (default)

List recent audit events.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--type <type>` | string | | Filter by event_type |
| `--entity <entity>` | string | | Filter by entity_type or entity_id |
| `--since <duration>` | string | `1h` | Time window (e.g., 1h, 30m, 2d) |
| `--errors-only` | boolean | | Show only error events |
| `--limit <n>` | string | `50` | Max rows to return |
| `--json` | boolean | | Output as JSON |

### `genie events errors`

Show aggregated error patterns.

| Option | Type | Description |
|--------|------|-------------|
| `--since <duration>` | string | Time window (e.g., 1h, 24h, 7d) |
| `--json` | boolean | Output as JSON |

### `genie events costs`

Cost breakdown from OTel API request events.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--today` | boolean | | Show costs from the last 24h |
| `--since <duration>` | string | `24h` | Time window |
| `--by-agent` | boolean | | Group by agent |
| `--by-wish` | boolean | | Group by wish |
| `--by-model` | boolean | | Group by model |
| `--json` | boolean | | Output as JSON |

### `genie events tools`

Tool usage analytics from OTel tool events.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--since <duration>` | string | `24h` | Time window |
| `--by-tool` | boolean | | Group by tool name (default) |
| `--by-agent` | boolean | | Group by agent |
| `--json` | boolean | | Output as JSON |

### `genie events timeline <entity-id>`

Full event timeline for a task, agent, wish, or traceId.

| Option | Type | Description |
|--------|------|-------------|
| `--json` | boolean | Output as JSON |

### `genie events summary`

High-level stats: agents spawned, tasks moved, costs, errors.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--today` | boolean | | Show summary for the last 24h |
| `--since <duration>` | string | `24h` | Time window |
| `--json` | boolean | | Output as JSON |

### `genie events scan`

Full server cost scan via ccusage (all CC sessions, not just genie-spawned).

| Option | Type | Description |
|--------|------|-------------|
| `--since <date>` | string | Start date in YYYYMMDD format |
| `--json` | boolean | Output as JSON |
| `--breakdown` | boolean | Show per-model breakdown |

---

## Sessions & History

### `genie sessions list` (default)

List Claude Code sessions.

| Option | Type | Description |
|--------|------|-------------|
| `--active` | boolean | Show only active sessions |
| `--orphaned` | boolean | Show only orphaned sessions |
| `--agent <name>` | string | Filter by agent |
| `--limit <n>` | string | Max number of sessions (default: 50) |
| `--json` | boolean | Output as JSON |

### `genie sessions replay <session-id>`

Replay a session -- interleave content + events.

| Option | Type | Description |
|--------|------|-------------|
| `--json` | boolean | Output as JSON |

### `genie sessions search <query>`

Full-text search across session content.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--json` | boolean | | Output as JSON |
| `--limit <n>` | string | `20` | Max results |

### `genie sessions sync`

Check session backfill progress.

---

## Database

Commands under `genie db`. Manages pgserve.

### `genie db status`

Show pgserve health, port, data dir, and table counts.

### `genie db migrate`

Run pending database migrations.

### `genie db query <sql>`

Execute arbitrary SQL and print results.

### `genie db url`

Print postgres connection URL for direct access.

| Option | Type | Description |
|--------|------|-------------|
| `--quiet` | boolean | Print URL only, no trailing newline (for scripts) |

### `genie db backup`

Dump database to `.genie/snapshot.sql.gz`.

### `genie db restore [file]`

Restore database from snapshot (default: `.genie/snapshot.sql.gz`).

| Option | Type | Description |
|--------|------|-------------|
| `-y, --yes` | boolean | Skip confirmation prompt |

---

## Scheduling

Commands under `genie schedule`.

### `genie schedule create <name>`

Create a new schedule.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--command <cmd>` | string | **required** | Command to execute |
| `--at <time>` | string | | One-time schedule at absolute time (ISO 8601) |
| `--every <interval>` | string | | Repeating: duration (10m, 2h) or cron expression |
| `--after <duration>` | string | | One-time schedule after delay |
| `--timezone <tz>` | string | `UTC` | Timezone for schedule |
| `--lease-timeout <duration>` | string | `5m` | Lease timeout for runs |

### `genie schedule list`

List schedules with next due trigger.

| Option | Type | Description |
|--------|------|-------------|
| `--json` | boolean | Output as JSON |
| `--watch` | boolean | Refresh every 2s |

### `genie schedule cancel <name>`

Cancel a schedule and skip pending triggers.

| Option | Type | Description |
|--------|------|-------------|
| `--filter <expr>` | string | Filter expression (e.g., status=pending) |

### `genie schedule retry <name>`

Reset a failed trigger to pending.

### `genie schedule history <name>`

Show past executions for a schedule.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--limit <n>` | number | `20` | Max rows to show |

---

## Daemon

Commands under `genie daemon`. Manages the scheduler daemon lifecycle (redirects to `genie serve --headless`).

### `genie daemon install`

Generate systemd service unit and enable it.

### `genie daemon start`

Start the scheduler daemon.

| Option | Type | Description |
|--------|------|-------------|
| `--foreground` | boolean | Run in foreground (for systemd ExecStart) |

### `genie daemon stop`

Stop genie serve gracefully.

### `genie daemon status`

Show daemon state, PID, uptime, and trigger stats.

### `genie daemon logs`

Tail structured JSON scheduler log.

| Option | Type | Description |
|--------|------|-------------|
| `--follow, -f` | boolean | Follow log output |
| `--lines <n>` | number | Number of lines to show (default: 20) |

---

## Infrastructure

Commands under `genie serve`. Starts all genie infrastructure (pgserve, tmux, scheduler).

### `genie serve start` (default)

Start genie serve.

| Option | Type | Description |
|--------|------|-------------|
| `--daemon` | boolean | Run in background |
| `--foreground` | boolean | Run in foreground (default) |
| `--headless` | boolean | Run without TUI (services only: pgserve, scheduler, inbox-watcher) |

### `genie serve stop`

Stop genie serve and all services.

### `genie serve status`

Show service health.

---

## Brain (Enterprise)

`genie brain` -- Knowledge graph engine (enterprise). Delegates to `@khal-os/brain`.

Brain is never a hard dependency. Genie works the same without it.

### `genie brain install`

Install genie-brain from GitHub. Requires automagik-dev org membership.

### `genie brain uninstall`

Remove genie-brain installation.

### `genie brain update`

Update genie-brain to latest version from GitHub.

### `genie brain version`

Show installed brain version and check for updates.

### `genie brain <subcommand>`

All other arguments are passed through to the brain module's `execute()` function.

---

## Omni Bridge

Commands under `genie omni`. Manages the NATS bridge connecting Omni (WhatsApp) to Genie agent sessions.

### `genie omni start`

Start the NATS bridge (subscribe to `omni.message.>`).

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--nats-url <url>` | string | `localhost:4222` | NATS server URL |
| `--max-concurrent <n>` | string | `20` | Max concurrent agent sessions |
| `--idle-timeout <ms>` | string | `900000` | Idle timeout in ms |
| `--executor <type>` | string | `tmux` | Executor type: tmux or sdk |

### `genie omni stop`

Stop the running NATS bridge.

### `genie omni status`

Show bridge status: active sessions, queue depth, idle timers.

| Option | Type | Description |
|--------|------|-------------|
| `--json` | boolean | Output as JSON |

---

## Import/Export

### `genie export`

Export genie data as JSON.

| Option | Type | Description |
|--------|------|-------------|
| `--output <file>` | string | Write to file instead of stdout |
| `-o <file>` | string | Alias for --output |
| `--pretty` | boolean | Pretty-print JSON |

Subcommands:

- `genie export all` -- Full backup (all present tables)
- `genie export boards [name]` -- Export boards, templates, and task types
- `genie export tasks` -- Export tasks with deps, actors, and stage log (`--project <name>` to filter)
- `genie export tags` -- Export tags

### `genie import <file>`

Import genie data from JSON export.

| Option | Type | Description |
|--------|------|-------------|
| `--fail` | boolean | Abort on any conflict (default) |
| `--merge` | boolean | Skip existing rows, import new ones |
| `--overwrite` | boolean | Replace existing rows with imported data |
| `--groups <list>` | string | Comma-separated groups to import |

---

## Dispatch

Framework-skill dispatch primitives live under the `genie dispatch` command group. `genie work` is kept flat at the top level.

### `genie dispatch brainstorm <agent> <slug>`

Spawn agent with brainstorm DRAFT.md context.

### `genie dispatch wish <agent> <slug>`

Spawn agent with wish DESIGN.md context.

### `genie dispatch review <agent> <ref>`

Spawn agent with review scope for a wish group. Format: `<slug>#<group>`.

### `genie work <ref> [agent]`

Auto-orchestrate a wish, or dispatch work on a specific group.

- If `ref` is a slug (no `#`): auto-orchestrate the entire wish
- If `ref` is `slug#group` with an agent: dispatch that specific group

---

## QA System

Commands under `genie qa`. Self-testing system for genie CLI.

### `genie qa run [target]` (default)

Run QA specs (all, a domain, or a single spec).

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--timeout <seconds>` | number | `3600` | Max seconds per spec |
| `--parallel <n>` | number | `5` | Max specs to run in parallel |
| `--verbose` | boolean | | Show all collected events |
| `--ndjson` | boolean | | Machine-readable NDJSON output |

```bash
genie qa                          # Run all QA specs
genie qa messaging                # Run a domain
genie qa messaging/round-trip     # Run one spec
```

### `genie qa status`

Show QA dashboard with last results per spec.

| Option | Type | Description |
|--------|------|-------------|
| `--json` | boolean | Output as JSON |

### `genie qa history`

Show recent QA runs.

### `genie qa check <specFile>`

Evaluate a QA spec against current team logs and publish qa-report.

| Option | Type | Description |
|--------|------|-------------|
| `--team <name>` | string | Team name (defaults to GENIE_TEAM) |
| `--since <timestamp>` | string | Only consider events after this ISO timestamp |
| `--since-file <path>` | string | Read the lower-bound timestamp from a file |

### `genie qa-report <json>`

Publish QA result to the PG event log (called by QA team-lead).

---

## Tags

Commands under `genie tag`.

### `genie tag list`

List all tags.

| Option | Type | Description |
|--------|------|-------------|
| `--type <typeId>` | string | Filter by task type |
| `--json` | boolean | Output as JSON |

### `genie tag create <name>`

Create a custom tag.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--color <hex>` | string | `#9ca3af` | Tag color (hex) |
| `--type <typeId>` | string | | Associate with a task type |

---

## Types

Commands under `genie type`. Task type management.

### `genie type list`

List all task types.

| Option | Type | Description |
|--------|------|-------------|
| `--json` | boolean | Output as JSON |

### `genie type show <id>`

Show task type detail with stage pipeline.

| Option | Type | Description |
|--------|------|-------------|
| `--json` | boolean | Output as JSON |

### `genie type create <name>`

Create a custom task type.

| Option | Type | Description |
|--------|------|-------------|
| `--stages <json>` | string | **required** -- Stages JSON array |
| `--description <text>` | string | Type description |
| `--icon <icon>` | string | Type icon |

---

## Releases

Commands under `genie release`.

### `genie release create <name>`

Create a release and assign tasks to it.

| Option | Type | Description |
|--------|------|-------------|
| `--tasks <ids...>` | string[] | **required** -- Task IDs or #seqs to include |

### `genie release list`

List all releases.

| Option | Type | Description |
|--------|------|-------------|
| `--json` | boolean | Output as JSON |

---

## Templates

Commands under `genie template`. Board template management.

### `genie template list` (default)

List available templates.

| Option | Type | Description |
|--------|------|-------------|
| `--json` | boolean | Output as JSON |

### `genie template show <name>`

Show template details.

| Option | Type | Description |
|--------|------|-------------|
| `--json` | boolean | Output as JSON |

### `genie template delete <name>`

Delete a template.

---

## Metrics

Commands under `genie metrics`. Machine metrics -- snapshots, heartbeats, agents.

### `genie metrics now` (default)

Current machine state.

| Option | Type | Description |
|--------|------|-------------|
| `--json` | boolean | Output as JSON |

### `genie metrics history`

Machine snapshot history.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--since <duration>` | string | `1h` | Time window (e.g., 1h, 6h, 1d) |
| `--json` | boolean | | Output as JSON |

### `genie metrics agents` *(DEPRECATED — invincible-genie / Group 5)*

The pre-`genie status` heartbeat summary was a corpse counter (indexed by
`process_id`, never reaped on restart). The command is preserved for
one release as a deprecation stub; it now prints a redirect to
`genie status` and exits 0. Migrate scripts as follows:

```bash
# Before
genie metrics agents --json

# After
genie status --json
```

| Option | Type | Description |
|--------|------|-------------|
| `--json` | boolean | Emit a structured deprecation marker `{ deprecated, replacement, message }` |

---

## Notifications

Commands under `genie notify`. Notification preference management.

### `genie notify set`

Set notification preference for a channel.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--channel <channel>` | string | **required** | Channel: whatsapp, telegram, email, slack, discord, tmux |
| `--priority <priority>` | string | `normal` | Minimum priority threshold |
| `--default` | boolean | | Set as default channel |

### `genie notify list`

List notification preferences.

| Option | Type | Description |
|--------|------|-------------|
| `--json` | boolean | Output as JSON |

### `genie notify remove`

Remove a notification preference.

| Option | Type | Description |
|--------|------|-------------|
| `--channel <channel>` | string | **required** -- Channel to remove |

---

## Hooks

Commands under `genie hook`. Hook middleware for Claude Code integration.

### `genie hook dispatch`

Dispatch a CC hook event. Reads JSON from stdin, writes decision to stdout.

---

## Directory Management

Commands under `genie dir`. Agent directory CRUD.

### `genie dir add <name>`

Register an agent in the directory.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--dir <path>` | string | **required** | Agent folder (CWD + AGENTS.md) |
| `--repo <path>` | string | | Default git repo |
| `--prompt-mode <mode>` | string | `append` | Prompt mode: append or system |
| `--model <model>` | string | | Default model |
| `--roles <roles...>` | string[] | | Built-in roles |
| `--permission-preset <preset>` | string | | Permission preset: full, read-only, chat-only |
| `--allow <tools>` | string | | Comma-separated tool allow list |
| `--bash-allow <patterns>` | string | | Comma-separated regex patterns for allowed bash commands |
| `--global` | boolean | | Write to global directory |
| `--sdk-*` | various | | SDK configuration flags (see below) |

### `genie dir rm <name>`

Remove an agent from the directory.

| Option | Type | Description |
|--------|------|-------------|
| `--global` | boolean | Remove from global directory |

### `genie dir ls [name]`

List all agents or show single entry details.

| Option | Type | Description |
|--------|------|-------------|
| `--json` | boolean | Output as JSON |
| `--builtins` | boolean | Include built-in roles and council members |
| `--all` | boolean | Include archived agents |

### `genie dir edit <name>`

Update an agent directory entry.

| Option | Type | Description |
|--------|------|-------------|
| `--dir <path>` | string | Agent folder |
| `--repo <path>` | string | Default git repo |
| `--prompt-mode <mode>` | string | Prompt mode: append or system |
| `--model <model>` | string | Default model |
| `--provider <provider>` | string | AI provider: claude or codex |
| `--color <color>` | string | Display color for TUI |
| `--description <desc>` | string | Agent description |
| `--roles <roles...>` | string[] | Built-in roles |
| `--permission-preset <preset>` | string | Permission preset |
| `--allow <tools>` | string | Comma-separated tool allow list |
| `--bash-allow <patterns>` | string | Regex patterns for allowed bash commands |
| `--global` | boolean | Edit in global directory |
| `--sdk-*` | various | SDK configuration flags (see below) |

### `genie dir sync`

Sync agents from workspace `agents/` directory.

### `genie dir export <name>`

Print full AGENTS.md frontmatter for an agent from PG state.

### SDK Configuration Flags

Available on `genie dir add` and `genie dir edit`:

| Flag | Description |
|------|-------------|
| `--sdk-permission-mode <mode>` | SDK permission mode: default\|acceptEdits\|bypassPermissions\|plan\|dontAsk\|auto |
| `--sdk-tools <list>` | Comma-separated tool names |
| `--sdk-allowed-tools <list>` | Auto-approved tools |
| `--sdk-disallowed-tools <list>` | Blacklisted tools |
| `--sdk-max-turns <n>` | Max conversation turns |
| `--sdk-max-budget <usd>` | Max budget in USD |
| `--sdk-effort <level>` | Effort: low\|medium\|high\|max |
| `--sdk-thinking <config>` | Thinking: adaptive\|disabled\|enabled[:budgetTokens] |
| `--sdk-persist-session` | Enable session persistence |
| `--sdk-file-checkpointing` | Enable file checkpointing |
| `--sdk-output-format <path>` | Path to JSON schema file for output format |
| `--sdk-stream-partial` | Include partial messages in stream |
| `--sdk-hook-events` | Include hook events in stream |
| `--sdk-prompt-suggestions` | Enable prompt suggestions |
| `--sdk-progress-summaries` | Enable agent progress summaries |
| `--sdk-sandbox` | Enable sandbox |
| `--sdk-betas <list>` | Beta flags (comma-separated) |
| `--sdk-system-prompt <string>` | System prompt text |
| `--sdk-mcp-server <spec>` | MCP server: name:command:args (repeatable) |
| `--sdk-plugin <path>` | Plugin path (repeatable) |
| `--sdk-agent <name>` | Main agent name |
| `--sdk-subagent <spec>` | Subagent: name:json (repeatable) |

---

## Utility Commands

### `genie setup`

Configure genie settings.

| Option | Type | Description |
|--------|------|-------------|
| `--quick` | boolean | Accept all defaults |
| `--shortcuts` | boolean | Only configure keyboard shortcuts |
| `--codex` | boolean | Only configure Codex integration |
| `--terminal` | boolean | Only configure terminal defaults |
| `--session` | boolean | Only configure session settings |
| `--reset` | boolean | Reset configuration to defaults |
| `--show` | boolean | Show current configuration |

### `genie doctor`

Run diagnostic checks on genie installation.

| Option | Type | Description |
|--------|------|-------------|
| `--fix` | boolean | Auto-fix: kill zombie postgres, clean shared memory, restart daemon |

### `genie update`

Update Genie CLI to the latest version.

| Option | Type | Description |
|--------|------|-------------|
| `--next` | boolean | Switch to dev builds (npm @next tag) |
| `--stable` | boolean | Switch to stable releases (npm @latest tag) |

### `genie uninstall`

Remove Genie CLI and clean up hooks.

### `genie init`

Initialize a genie workspace.

#### `genie init agent <name>`

Scaffold a new agent in the workspace.

### `genie shortcuts`

Show available shortcuts and installation status (default action).

#### `genie shortcuts show`

Show available shortcuts and installation status.

#### `genie shortcuts install`

Install shortcuts to config files (`~/.tmux.conf`, shell rc).

#### `genie shortcuts uninstall`

Remove shortcuts from config files.

### `genie app`

Launch Genie desktop app (backend sidecar + views).

| Option | Type | Description |
|--------|------|-------------|
| `--backend-only` | boolean | Start only the backend sidecar (IPC on stdin/stdout) |
| `--tui` | boolean | Fall back to terminal UI mode |
| `--dev` | boolean | Development mode |

### `genie brief`

Show startup brief -- aggregated context since last session.

| Option | Type | Description |
|--------|------|-------------|
| `--team <name>` | string | Team name (default: GENIE_TEAM) |
| `--agent <name>` | string | Agent name (default: GENIE_AGENT_NAME) |
| `--since <iso>` | string | Start timestamp (default: last executor end) |

---

## Executor Debug

Commands under `genie exec`.

### `genie exec list` (alias: `ls`)

List all executors.

| Option | Type | Description |
|--------|------|-------------|
| `--agent <name>` | string | Filter by agent name/ID |
| `--state <state>` | string | Filter by state (running, idle, terminated, etc.) |
| `--json` | boolean | Output as JSON |

### `genie exec show <id>`

Show executor detail (pid, tmux, provider).

| Option | Type | Description |
|--------|------|-------------|
| `--json` | boolean | Output as JSON |

### `genie exec terminate <id>`

Terminate an executor.
