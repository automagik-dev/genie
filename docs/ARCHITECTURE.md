# Genie Architecture

This document describes the internal architecture of the Genie CLI, including the unified serve model, service topology, agent lifecycle, data flow, and hook system.

## Serve/Daemon Unification

The `genie serve` command is the **single infrastructure owner**. It starts and manages all background services in one process. The older `genie daemon` command is now a thin redirect to `genie serve --headless`.

```
genie serve             → foreground with TUI (default)
genie serve --headless  → services only, no TUI
genie serve --daemon    → background (detached)
genie daemon start      → alias for genie serve --headless (deprecated)
```

**Key design decision:** The daemon was unified into `serve` so that a single PID file (`~/.genie/serve.pid`) governs all services. The legacy `scheduler.pid` is still checked for backward compatibility but `serve.pid` is canonical.

**Source:** `src/term-commands/serve.ts`, `src/term-commands/daemon.ts`

## Service Topology

`genie serve` starts these services in order:

```
genie serve (PID file: ~/.genie/serve.pid)
│
├── 1. pgserve              Embedded PostgreSQL (data + state)
│     └── port file: ~/.genie/pgserve.port
│
├── 2. tmux -L genie        Agent session server (eternal, survives serve restarts)
│     └── sessions created on-demand by `genie spawn`
│
├── 3. tmux -L genie-tui    TUI session (only in non-headless mode)
│     └── session: genie-tui (left=nav, right=agent display)
│
├── 4. Agent sync           Watches agents/ directory for AGENTS.md changes
│     └── src/lib/agent-sync.ts
│
├── 5. Scheduler daemon     Claims and fires triggers from PG
│     ├── Event router      Routes PG NOTIFY events to team members
│     └── Inbox watcher     Polls native inboxes, auto-spawns offline leads
│
└── 6. Service registry     In-memory PID tracker for graceful shutdown
```

### Service Details

| Service | Source | Description |
|---------|--------|-------------|
| **pgserve** | `src/lib/db.ts` | Embedded PostgreSQL. `genie serve` owns the process; CLI commands read `~/.genie/pgserve.port` and connect. Data lives at `~/.genie/data/pgserve/`. |
| **Scheduler** | `src/lib/scheduler-daemon.ts` | Core loop: LISTEN on `genie_trigger_due` for real-time NOTIFY, 30s poll fallback. Uses `SELECT FOR UPDATE SKIP LOCKED` for lease-based claiming. Concurrency capped by `GENIE_MAX_CONCURRENT` (default 5). Collects heartbeats every 60s, reconciles orphans every 5m. |
| **Event Router** | `src/lib/event-router.ts` | Subscribes to PG NOTIFY channels (`genie_task_stage`, `genie_executor_state`, `genie_message`). Routes actionable events (blocked, error, permission, request) to team-lead mailboxes and runtime event log. |
| **Inbox Watcher** | `src/lib/inbox-watcher.ts` | Polls `~/.claude/teams/` for unread messages every 30s. Auto-spawns offline team-leads when unread messages are found. |
| **Session Capture** | `src/lib/session-filewatch.ts`, `src/lib/session-capture.ts`, `src/lib/session-backfill.ts` | Event-driven JSONL capture via `fs.watch` on `~/.claude/projects/`. Reads incrementally from stored offsets, debounced 500ms. Backfill worker processes historical files (newest-first, 64KB chunks, yields to live work). |
| **Omni Bridge** | `src/services/omni-bridge.ts` | NATS subscriber that routes inbound WhatsApp/Telegram messages to agent sessions via the `IExecutor` interface. Manages per-chat session lifecycle with idle timeout (15min), max concurrency (20), and message buffering. |
| **Service Registry** | `src/lib/service-registry.ts` | In-memory PID registry for child processes. Used during shutdown: SIGTERM first, 3s grace, then SIGKILL survivors. |

### Shutdown Sequence

1. Stop agent directory watcher
2. Stop scheduler (drains in-flight triggers)
3. Kill registered services via service registry
4. Kill TUI session (agent tmux server is **not** killed — sessions are eternal)
5. Remove pgserve lockfile
6. Remove PID file
7. Force-kill timeout: 10s, then SIGKILL remaining

## Agent Lifecycle

Agents follow this lifecycle: **spawn → register → work → report → shutdown**.

```
                  ┌──────────┐
                  │  spawn   │  genie spawn <name>
                  └────┬─────┘
                       │
              ┌────────▼────────┐
              │    register     │  Agent written to PG (agents table)
              │  state: spawning│  Pane ID, session, team recorded
              └────────┬────────┘
                       │
              ┌────────▼────────┐
              │     working     │  Claude Code / Codex / SDK running
              │  state: working │  Hooks emit runtime events
              └────────┬────────┘
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
    ┌──────────┐ ┌──────────┐ ┌──────────┐
    │   idle   │ │permission│ │ question │
    │ (prompt) │ │ (awaiting│ │ (awaiting│
    └────┬─────┘ │ approval)│ │  answer) │
         │       └────┬─────┘ └────┬─────┘
         │            │            │
         └────────────┼────────────┘
                      │
              ┌───────▼────────┐
              │  done / error  │  Task complete or failure
              └───────┬────────┘
                      │
              ┌───────▼────────┐
              │   suspended    │  Optional: idle timeout or manual stop
              └───────┬────────┘
                      │
              ┌───────▼────────┐
              │   shutdown     │  Pane killed, registry updated
              └────────────────┘
```

### Agent States

| State | Description |
|-------|-------------|
| `spawning` | Agent being initialized, pane created |
| `working` | Actively producing output |
| `idle` | At prompt, waiting for input |
| `permission` | Waiting for permission approval |
| `question` | Waiting for human answer |
| `done` | Task completed successfully |
| `error` | Encountered error |
| `suspended` | Manually stopped or idle-timeout suspended |

### Spawn Flow

1. **Resolve agent** — Look up name in agent directory (`agents/` AGENTS.md files) or built-in roles
2. **Create tmux pane** — Split in target session/window on `tmux -L genie` socket
3. **Register in PG** — Insert into `agents` table with pane ID, session, team, role
4. **Launch provider** — Start Claude Code, Codex, or Claude SDK in the pane
5. **Inject identity** — Hooks inject `GENIE_AGENT_NAME` and team context via `identity-inject` handler

### Auto-Resume

When a pane dies unexpectedly, the scheduler's heartbeat collector detects the dead pane. If `autoResume` is enabled (default), the agent is respawned with its original configuration. Resume attempts are tracked (`resumeAttempts`, `maxResumeAttempts`) to prevent infinite loops.

**Source:** `src/term-commands/agent/spawn.ts`, `src/lib/agent-registry.ts`, `src/lib/scheduler-daemon.ts`

## Data Flow

```
┌──────────────────────────────────────────────────────────────────┐
│                        CLI Commands                               │
│  genie spawn / work / send / task / team / ...                   │
└───────────┬──────────────────────────────────────┬───────────────┘
            │ write                                │ read
            ▼                                      ▼
┌──────────────────────────────────────────────────────────────────┐
│                      PostgreSQL (pgserve)                         │
│                                                                   │
│  agents        — agent identity + state                          │
│  agent_templates — spawn templates for re-spawn                  │
│  executors     — executor instances (v4 model)                   │
│  triggers      — scheduled trigger rows                          │
│  runs          — trigger execution history                       │
│  schedules     — cron/one-shot schedule definitions              │
│  runtime_events — structured event log                           │
│  sessions      — Claude session JSONL capture                    │
│  tasks         — task/wish tracking                              │
│  messages      — task conversation messages                      │
│                                                                   │
│  NOTIFY channels:                                                │
│    genie_trigger_due    → scheduler claims                       │
│    genie_task_stage     → event router                           │
│    genie_executor_state → event router                           │
│    genie_message        → event router                           │
└───────────┬──────────────────────────────────────┬───────────────┘
            │ NOTIFY                               │ query
            ▼                                      ▼
┌─────────────────────┐              ┌─────────────────────────────┐
│   Scheduler Daemon  │              │        Event Router          │
│                     │              │                              │
│ • Claims triggers   │              │ Listens on NOTIFY channels:  │
│ • Fires agents      │              │ • task stage changes         │
│ • Heartbeat (60s)   │              │ • executor state changes     │
│ • Orphan recon (5m) │              │ • new messages               │
│ • Lease recovery    │              │                              │
└─────────────────────┘              │ Routes to:                   │
                                     │ 1. Task conversation         │
                                     │ 2. Team-lead mailbox         │
                                     │ 3. Runtime event log         │
                                     └─────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│                         Hook System                               │
│                                                                   │
│  Claude Code invokes: genie hook dispatch                        │
│  Reads JSON from stdin, runs handler chain, writes JSON to stdout │
│                                                                   │
│  Blocking hooks (PreToolUse):                                    │
│    branch-guard        — Blocks pushes to main/master            │
│    orchestration-guard — Blocks tmux scraping                    │
│    identity-inject     — Injects agent name into SendMessage     │
│    auto-spawn          — Auto-spawns teammates on SendMessage    │
│    runtime-emit-tool   — Emits tool_call events to PG            │
│                                                                   │
│  Non-blocking hooks:                                             │
│    runtime-emit-msg    — Emits message events (PostToolUse)      │
│    runtime-emit-user   — Emits user prompt events                │
│    runtime-emit-asst   — Emits assistant response events (Stop)  │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│                      Agent Sessions (tmux)                        │
│                                                                   │
│  tmux -L genie         Agent socket (eternal, survives restarts) │
│    └── session per team/agent                                    │
│         └── window per agent                                     │
│              └── pane running Claude Code / Codex / SDK          │
│                                                                   │
│  tmux -L genie-tui     TUI socket (owned by serve)              │
│    └── session: genie-tui                                        │
│         └── window 0: left=nav (OpenTUI), right=agent display   │
└──────────────────────────────────────────────────────────────────┘
```

### Event Flow Example: Agent Completes a Task

1. Agent finishes work, Claude Code emits `Stop` event
2. `runtime-emit-asst` hook fires, writes `assistant` event to `runtime_events` table
3. Agent state updated to `done` in `agents` table
4. PG fires `NOTIFY genie_executor_state` with `agent_id:old_state:done`
5. Event router picks up the notification
6. Event router delivers to team-lead mailbox (PG + native inbox)
7. Event router writes event to runtime event log
8. Inbox watcher detects unread message, ensures team-lead is spawned

## Directory Structure

```
src/
├── genie.ts                    CLI entry point (commander)
├── genie-commands/             Setup/utility commands (setup, doctor, update)
├── term-commands/              CLI command handlers
│   ├── agent/                  genie agent namespace (spawn, stop, resume, ...)
│   ├── serve.ts                genie serve — infrastructure owner
│   ├── daemon.ts               genie daemon — deprecated alias for serve
│   ├── team.ts                 genie team — create, hire, fire, list, disband
│   ├── task.ts                 genie task — CRUD + board + project + releases
│   ├── agents.ts               Legacy top-level agent commands
│   └── ...                     Other command files
├── lib/                        Core modules
│   ├── db.ts                   PostgreSQL connection + pgserve management
│   ├── agent-registry.ts       Agent identity CRUD (PG-backed)
│   ├── scheduler-daemon.ts     Trigger claiming + heartbeats + orphan recon
│   ├── event-router.ts         PG NOTIFY → mailbox/event-log routing
│   ├── inbox-watcher.ts        Native inbox polling + auto-spawn
│   ├── service-registry.ts     In-memory PID registry for shutdown
│   ├── runtime-events.ts       Structured event log (PG)
│   ├── session-capture.ts      JSONL ingestion core (filewatch + backfill)
│   ├── session-filewatch.ts    fs.watch on ~/.claude/projects/
│   ├── session-backfill.ts     Lazy historical JSONL ingestion
│   ├── team-manager.ts         Team configuration management
│   ├── mailbox.ts              Message delivery (disk + tmux injection)
│   ├── tmux.ts                 tmux pane/session helpers
│   ├── orchestrator/           Session monitoring + state detection
│   ├── providers/              Provider implementations (claude, codex, sdk, pty)
│   │   └── registry.ts         Auto-registering provider lookup
│   └── ...                     Other modules
├── services/                   External service integrations
│   ├── omni-bridge.ts          NATS → agent session routing (WhatsApp, etc.)
│   ├── executor.ts             IExecutor interface for Omni bridge
│   └── executors/              Executor implementations (claude-code, claude-sdk)
├── hooks/                      Git hook system
│   ├── index.ts                Handler registry + dispatch logic
│   ├── types.ts                Hook payload/result types
│   ├── inject.ts               Hook installation into Claude Code settings
│   ├── dispatch-command.ts     `genie hook dispatch` CLI command
│   └── resolve-agent-name.ts   Agent name resolution from env
├── tui/                        Terminal UI (OpenTUI-based) — a skin over the CLI, not an alternate control plane. Every action shows its `genie …` command before executing. See [`SPAWN-TEAM-RESOLUTION.md`](SPAWN-TEAM-RESOLUTION.md).
│   ├── app.tsx                 TUI application root
│   └── ...                     TUI components
├── types/                      Shared types (genie-config Zod schema)
└── skills/                     Skill prompt files

~/.genie/                       Global state directory (GENIE_HOME)
├── serve.pid                   Canonical PID file for genie serve
├── scheduler.pid               Legacy PID file (backward compat)
├── pgserve.port                Port lockfile for pgserve
├── data/pgserve/               PostgreSQL data directory
├── logs/scheduler.log          Structured JSON scheduler log
├── workers.json                Global worker registry (legacy)
├── teams/                      Team configuration files
├── sessions.json               Global session store
└── prompts/                    Generated system prompts for teams

<repo>/.genie/                  Per-repo state (shared across worktrees)
├── state/<slug>.json           Wish state files
├── mailbox/<worker>.json       Worker mailboxes
├── chat/<team>.jsonl           Team chat logs
└── wishes/                     Wish definitions
```

## Provider System

The provider system abstracts how agents are launched. Each provider implements the `ExecutorProvider` interface and is auto-registered at import time.

```
Provider Registry (src/lib/providers/registry.ts)
│
├── claude      ClaudeCodeProvider   — Claude Code CLI in a tmux pane
├── claude-sdk  ClaudeSdkProvider    — Claude SDK (streaming API, no CLI)
├── codex       CodexProvider        — OpenAI Codex CLI
└── app-pty     AppPtyProvider       — Generic PTY process (any CLI tool)
```

| Provider | Source | Description |
|----------|--------|-------------|
| **claude** | `src/lib/providers/claude-code.ts` | Default. Builds a Claude Code command with flags (`--model`, `--allowedTools`, `--continue`, etc.), launches in tmux pane, injects system prompt. |
| **claude-sdk** | `src/lib/providers/claude-sdk.ts` | Programmatic Claude API. Uses streaming with tool-use support. SDK events, permissions, and stream handling are split into dedicated modules (`claude-sdk-events.ts`, `claude-sdk-permissions.ts`, `claude-sdk-stream.ts`). |
| **codex** | `src/lib/providers/codex.ts` | OpenAI Codex CLI. Builds command with Codex-specific flags. |
| **app-pty** | `src/lib/providers/app-pty.ts` | Generic PTY wrapper for arbitrary CLI tools. Used for non-AI processes that need tmux pane management. |

### Provider Selection

Provider is determined by the `model` field in agent templates. The `executor-types.ts` module defines the `ExecutorProvider` interface that all providers implement: `name`, `buildCommand()`, `detectState()`, and lifecycle hooks.

## Orchestrator

The orchestrator module (`src/lib/orchestrator/`) monitors and controls Claude Code sessions running in tmux panes.

| Module | Description |
|--------|-------------|
| `state-detector.ts` | Analyzes terminal output to determine agent state (`idle`, `working`, `permission`, `question`, `error`, `complete`, `tool_use`). Uses regex pattern matching with confidence scoring (0–1). |
| `patterns.ts` | Pattern library for detecting permission prompts, errors, idle states, working indicators, and completion markers from Claude Code terminal output. |

The state detector reads the last N lines of a pane's output (default 50) and matches against the pattern library. This is used by the auto-approve engine, idle timeout detection, and the `genie agent answer` command.

## Key Design Decisions

1. **pgserve as single source of truth** — All agent state, events, tasks, and sessions are in PostgreSQL. File-based state (`workers.json`, `mailbox/`) exists for backward compatibility and edge cases (mailbox delivery when PG is unavailable).

2. **Eternal agent tmux server** — `tmux -L genie` is never killed by `genie serve stop`. Agent sessions survive serve restarts. Only the TUI session (`tmux -L genie-tui`) is owned by serve.

3. **Hook system as event bus** — Claude Code's hook protocol is leveraged to emit runtime events, enforce branch protection, inject identity, and auto-spawn teammates. All hooks have a 15s hard timeout.

4. **Lease-based scheduling** — Triggers use `SELECT FOR UPDATE SKIP LOCKED` for distributed claiming. Idempotency keys prevent double-fire. Jitter is applied when >3 triggers fire simultaneously to prevent thundering herd.

5. **Session capture is lazy** — Live filewatch has priority. Backfill processes historical files in background, yielding to live work. Offsets are committed in the same PG transaction as content.
