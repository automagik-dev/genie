# Wish: Genie App — AI Orchestration Cockpit

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `genie-app` |
| **Date** | 2026-03-29 |
| **Design** | [DRAFT.md](../../brainstorms/genie-cockpit-app/DRAFT.md) |
| **depends-on** | `genie-executor-model` (DONE), `genie-comms-protocol` (DONE) |
| **Repo** | `automagik-dev/genie` (lives in the genie CLI repo, khal-os app pattern) |
| **Replaces** | `genie-tui-v1` (OpenTUI+tmux — deprecated), all TUI v2 screen wishes |

## Summary

Build "Genie" — a standalone Tauri desktop app for AI agent orchestration. Part of the Automagik Bundle (Genie, Omni, others). The app owns its terminal processes directly via `bun-pty` (no tmux, no NATS middleman), renders with xterm.js in the Tauri webview, and connects to genie PG directly for data + LISTEN/NOTIFY for real-time updates. Optionally registers in khal-os marketplace when the OS is available, but works 100% standalone. Replaces the terminal TUI.

## Scope

### IN

**Package structure:**
- New package `packages/genie-app/` in the genie CLI repo (not khal-os repo — each product owns its app)
- khal-os manifest with multiple views (agents, tasks, terminal, dashboard)
- Tauri backend (Bun sidecar): direct PG queries + bun-pty process management + Tauri IPC
- Frontend views: React components using khal-os UI SDK primitives
- Standalone Tauri binary: `genie-app` native desktop (macOS, Linux, Windows)
- `genie app` CLI command: launches the Tauri app (or opens dev server in browser)

**Views (manifest entries, each a composable window):**
- `agents` — org hierarchy tree + agent detail/transcript/terminal (Screens 1-3 from TUI v2 design)
- `tasks` — kanban board with real-time team activity (Screen design from brainstorm)
- `terminal` — embedded xterm.js terminal connected to agent PTY sessions (replaces tmux right pane)
- `dashboard` — KPI overview: agents, tasks, spend, success rates (Screen 7)
- `activity` — real-time event feed with thread filtering (Screen 8)
- `inbox` — approvals, alerts, requests (Screen 6) — deferred to v2 (needs approval system)

**Tauri backend (Rust + Bun sidecar):**
- Bun sidecar process: runs genie PG queries, manages PTY child processes via bun-pty
- Tauri IPC: frontend invokes backend commands (list agents, spawn terminal, move task)
- PG LISTEN/NOTIFY: backend listens, pushes events to frontend via Tauri event system
- PTY I/O: bun-pty data streams to frontend via Tauri IPC (same process, no network hop)

**Terminal embedding (zero tmux, app owns the process tree):**
- `bun-pty` spawns Claude Code / Codex / bash as child processes directly
- `@xterm/xterm` renders in Tauri webview (full xterm.js with WebGL)
- Tauri IPC bridges PTY I/O between Bun backend and webview frontend
- Native mouse: select, copy (Cmd+C), scroll, click — all handled by xterm.js natively
- Multiple terminal tabs per view (like VS Code integrated terminal)
- App controls spawn, resize, kill — full process lifecycle ownership

**AppPtyProvider — new ExecutorProvider that replaces tmux:**
- Registered as provider `'app-pty'` alongside `'claude-code'` (tmux) and `'codex'` (API)
- When `genie spawn` runs INSIDE an app PTY session (detected via `GENIE_APP_PTY=true` env var):
  - Instead of creating a tmux pane → sends IPC to app backend
  - App backend spawns new bun-pty child process
  - New terminal tab appears in the app automatically
  - Executor row in PG with `transport: 'app-pty'`, `provider: 'app-pty'`
- When `genie spawn` runs OUTSIDE the app (normal terminal): tmux as usual (ClaudeCodeProvider)
- The ExecutorProvider interface already supports this — just a new provider implementation
- Agents calling `genie spawn` from within the app get child processes managed by the app, not tmux
- `genie team create` inside app → team tab group, each agent = terminal tab
- `genie kill` inside app → app kills PTY, updates executor state
- `genie resume` inside app → app creates new PTY, reconnects to agent's session

**Entity mapping (replaces tmux session/window/pane):**
- tmux session → workspace (organization/project scope)
- tmux window → team tab group (one group per team)
- tmux pane → terminal tab (one tab per executor)
- pane_id → pty session ID (executors.id)
- tmux capture-pane → xterm.js buffer read (state detection)
- tmux send-keys → pty.write() (input forwarding)
- tmux split-window → app.spawnForAgent() (INSERT INTO executors)
- tmux kill-pane → pty.kill() (UPDATE executors SET state='terminated')

**Data layer (direct PG, no NATS):**
- Connects to genie PG directly (same connection as CLI)
- PG LISTEN/NOTIFY for real-time updates (executor state, task stage, events)
- Tauri backend runs PG queries, pushes results to webview via IPC events
- Same queries as CLI — no separate service layer

**UI: khal-os UI SDK only (no freeform React):**
- ALL components from `@khal-os/os-ui` design system: `<Toolbar>`, `<SplitPane>`, `<StatusBar>`, `<EmptyState>`, buttons, inputs, cards, lists
- If a needed component is missing from os-ui → add it to os-ui first, then use it (design system feedback loop)
- No raw `<div>` layouts, no inline styles for structural elements — SDK primitives only
- Theme via CSS vars from os-ui (dark mode default, Automagik purple accent)
- Goal: os-ui becomes as complete as SwiftUI/UIKit — every app built on it makes it better

**UI patterns (gh-dash inspired):**
- Toolbar at top (view name, controls)
- SplitPane layout (list left, detail right)
- StatusBar at bottom (PG connection, agent count, active tasks)
- Keyboard navigation (j/k up/down, Enter select, Esc back)
- Real-time updates via PG LISTEN/NOTIFY (no polling)

**Installation & Workspace Flow:**
- First launch: choose "New installation" or "Open existing workspace"
- New installation: pick a base folder → genie installs in isolated workspace within it
- Workspace root stores a config file recording the path for this setup
- Multiple installations allowed: each workspace is fully isolated (can't see others)
- Single-server mode: one genie server, one workspace (for users who want centralized)
- Filesystem sandbox: NO operations outside the selected base folder — workspace = sandbox
- Agent auto-discovery: scans workspace folder for agent directories

### OUT
- Web deployment / hosting — Tauri native only (web for dev server during development)
- Old `genie-app` package in khal-os repo — stays as legacy, not modified
- `genie tui` command — deprecated with redirect message
- tmux in any UI rendering path — zero tmux dependency in frontend
- Approval system / budget tracking views — deferred (needs backend wishes first)
- Omni app / other Automagik Bundle apps — separate wishes per product
- Mobile app — desktop only (macOS, Linux, Windows via Tauri)

## Decisions

| Decision | Rationale |
|----------|-----------|
| App lives in genie CLI repo, not khal-os | Each product owns its khal-os app. Genie CLI + Genie App in same repo = shared types, shared service code, atomic deploys. |
| Tauri for native, web for dev only | Native gives best UX (system tray, keyboard shortcuts, window management). Web is dev convenience, not a delivery target. |
| App-owned PTY via bun-pty | App spawns processes directly. PTY manager creates executor rows in PG, tracks state, links to agent/task. Replaces tmux as the executor runtime for the app. |
| Multiple views in one manifest (not multiple apps) | khal-os composes views into windows. One app bundle = one install, multiple composable views. |
| gh-dash UX patterns | Proven terminal-native UX. Tabs, list+detail, keyboard nav. Translates directly to React+xterm. |
| Direct PG, no NATS | App connects to genie PG directly. LISTEN/NOTIFY for real-time. Tauri IPC bridges backend→frontend. No middleware. |
| Kill `genie tui`, add `genie app` | TUI is deprecated. `genie app` launches Tauri binary. CLI stays terminal-only. |

## Success Criteria

- [ ] `packages/genie-app/` exists in genie CLI repo with valid khal-os manifest
- [ ] Backend sidecar starts, connects to PG, and responds to Tauri IPC commands
- [ ] `agents` view shows org hierarchy tree from PG data with real-time state updates
- [ ] Selecting an agent opens `<TerminalPane>` connected to its PTY session (no tmux)
- [ ] Native text selection + Cmd+C copy works in terminal pane (no tmux mouse issues)
- [ ] `tasks` view shows kanban board with drag-to-move and team activity indicators
- [ ] `dashboard` view shows agent count, task count, active teams
- [ ] `genie app` CLI command launches the Tauri desktop app
- [ ] App runs standalone without khal-os (Tauri binary, connects directly to genie PG)
- [ ] Workspace isolation: first-launch wizard, base folder selection, sandbox enforcement
- [ ] PTY sessions linked to agent/executor entities in PG (not anonymous processes)
- [ ] Spawning agent via app creates executor row in PG (same as `genie spawn` in CLI)
- [ ] App registers in khal-os marketplace when khal-os is available
- [ ] `genie tui` shows deprecation message pointing to `genie app`
- [ ] `bun run check` passes in genie CLI repo

## Execution Strategy

### Wave 1: Scaffold + Backend + Workspace
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Package scaffold: manifest, package.json, tsconfig, khal-os app structure |
| 2 | engineer | Tauri backend: PG queries + PTY manager (bun-pty, creates executors in PG) + IPC bridge |
| 3 | engineer | Workspace isolation: first-launch wizard, base folder, sandbox, multi-workspace registry |

### Wave 2: Core Views (parallel)
| Group | Agent | Description |
|-------|-------|-------------|
| 4 | engineer | Agents view: org tree + agent detail card + state indicators |
| 5 | engineer | Terminal view: xterm.js + Tauri IPC PTY bridge, spawn agents linked to executors, multi-tab |
| 6 | engineer | Tasks view: kanban board with columns from PG boards, real-time team activity |

### Wave 3: Dashboard + CLI
| Group | Agent | Description |
|-------|-------|-------------|
| 7 | engineer | Dashboard view: KPI cards (agents, tasks, teams, spend placeholder) |
| 8 | engineer | Activity view: event feed with thread_id filtering, real-time via PG LISTEN |
| 9 | engineer | CLI integration: `genie app` command, Tauri build config, `genie tui` deprecation |

### Wave 4: Polish + Review
| Group | Agent | Description |
|-------|-------|-------------|
| 10 | engineer | Keyboard shortcuts, gh-dash style navigation, StatusBar, theme (Automagik purple palette) |
| review | reviewer | Full review against all success criteria |

## Execution Groups

### Group 1: Package Scaffold

**Goal:** Create the khal-os app package structure in the genie CLI repo.

**Deliverables:**
1. `packages/genie-app/manifest.ts` — views: agents, tasks, terminal, dashboard, activity
2. `packages/genie-app/package.json` — `@automagik/genie-app`, peerDeps: react, genieOs.services config
3. `packages/genie-app/components.ts` — re-exports for khal-os component resolution
4. `packages/genie-app/lib/types.ts` — shared types (Agent, Executor, Task, Team, RuntimeEvent)
6. `packages/genie-app/tsconfig.json` — React JSX, path aliases matching khal-os convention

**Acceptance Criteria:**
- [ ] `packages/genie-app/manifest.ts` exports valid manifest with 5 views
- [ ] Package structure matches terminal-app / hello-sac pattern
- [ ] TypeScript compiles cleanly

**Validation:**
```bash
cd packages/genie-app && bun run typecheck
```

**depends-on:** none

---

### Group 2: Tauri Backend (PG + PTY + IPC)

**Goal:** Bun sidecar that manages PG queries, PTY processes, and Tauri IPC bridge.

**Deliverables:**
1. `packages/genie-app/src-backend/index.ts` — Bun entry point, starts PG connection + PTY manager
2. PG query functions (reuse from genie CLI libs):
   - `listAgents()` → agents + executors + reports_to chain
   - `showAgent(id)` → detail + current executor + assignments
   - `listTasks(boardId)` → tasks with stage, team_name, priority
   - `kanbanBoard(boardId)` → columns with task cards + team activity
   - `listTeams()` → active teams + member roster
   - `streamEvents(filter)` → runtime events with thread_id
   - `getBrief(team)` → reuse brief.ts from comms-protocol
3. PG LISTEN/NOTIFY listener → pushes to Tauri frontend via IPC events:
   - `genie_executor_state` → `app://executor-state-changed`
   - `genie_task_stage` → `app://task-stage-changed`
   - `genie_runtime_event` → `app://runtime-event`
4. PTY manager via `bun-pty` — replaces tmux as executor runtime for the app:
   - `spawnForAgent(agentName, taskId?, opts?)` → builds same command as `genie spawn` (env vars, flags, CLAUDE.md), creates executor row in PG (`executors` table with provider, pid, state='spawning'), returns PTY session linked to agent + executor
   - `spawnBash(cwd?)` → plain terminal, no agent/executor link
   - `writeTerminal(sessionId, data)` → forward input to PTY
   - `resizeTerminal(sessionId, cols, rows)` → SIGWINCH
   - `killTerminal(sessionId)` → kill PTY, update executor state in PG ('terminated'), update assignment outcome
   - Data output → Tauri IPC event `app://pty-data-{sessionId}`
   - On PTY exit: update executor state, emit runtime event, app UI updates via PG LISTEN
   - Session registry: `Map<sessionId, { pty, agentId, executorId, taskId, command, state }>`
5. Tauri command registration: expose all functions as invoke-able commands from frontend
6. `AppPtyProvider` — new ExecutorProvider in `src/lib/providers/app-pty.ts`:
   - Implements `buildSpawnCommand()`: returns the command string (same as ClaudeCodeProvider) but sets `GENIE_APP_PTY=true` env var
   - Implements `detectState()`: reads xterm.js buffer via IPC instead of tmux capture-pane
   - Implements `terminate()`: kills PTY child process
   - Implements `deliverMessage()`: writes to Claude Code native inbox (same as ClaudeCodeProvider)
   - Implements `canResume()`: true (app can respawn PTY for same agent)
   - Implements `getTransport()`: returns `'app-pty'`
   - Registered in provider registry alongside claude-code and codex
7. IPC listener in backend: when a child process (agent) calls `genie spawn`:
   - CLI detects `GENIE_APP_PTY=true` → sends spawn request to app backend via IPC socket
   - App backend spawns new bun-pty → new terminal tab → new executor row
   - The spawn completes from the agent's perspective (same contract as tmux spawn)
   - IPC socket path: `{workspace}/.genie/app-pty.sock` (Unix domain socket)

**Acceptance Criteria:**
- [ ] Backend starts and connects to genie PG
- [ ] `listAgents()` returns data matching `genie ls` CLI output
- [ ] PG LISTEN fires IPC event when executor state changes
- [ ] `spawnForAgent("eng")` creates PTY + executor row in PG
- [ ] Agent inside app PTY calls `genie spawn sub-eng` → new tab appears in app (not tmux)
- [ ] `GENIE_APP_PTY=true` env var propagates to child processes
- [ ] AppPtyProvider registered and selectable via provider registry
- [ ] No tmux dependency when running inside app

**Validation:**
```bash
bun run packages/genie-app/src-backend/index.ts
```

**depends-on:** Group 1

---

### Group 3: Workspace Isolation

**Goal:** First-launch wizard, multi-workspace registry, filesystem sandboxing.

**Deliverables:**
1. `packages/genie-app/src-backend/workspace.ts` — workspace manager:
   - `~/.genie-app/workspaces.json` — registry of known workspaces:
     ```json
     [
       { "path": "/Users/felipe/agents", "name": "Main", "pgUrl": "postgres://...", "created": "..." },
       { "path": "/Users/felipe/work/client-x", "name": "Client X", "pgUrl": "postgres://...", "created": "..." }
     ]
     ```
   - `initWorkspace(basePath)` → creates `.genie/workspace.json` at root with PG URL, daemon config
   - `listWorkspaces()` → reads registry
   - `openWorkspace(path)` → sets active workspace, connects PG, restricts filesystem scope
2. First-launch wizard (frontend):
   - Screen 1: "Welcome to Genie" → "New installation" / "Open existing workspace"
   - Screen 2 (new): folder picker → validate folder → `initWorkspace()`
   - Screen 2 (existing): folder picker → find `.genie/workspace.json` → `openWorkspace()`
   - After wizard: redirect to agents view
3. Workspace switcher (Toolbar dropdown): switch between workspaces without restarting app
4. Tauri fs scope: restrict ALL file operations to `workspace.path` — no reads/writes outside sandbox
5. PTY spawn: `cwd` always within workspace. Environment inherits workspace PG URL.
6. Agent auto-discovery: scan `{workspace}/agents/` for agent directories (each with SOUL.md or AGENTS.md)
7. Per-workspace PG: each workspace can point to a different pgserve instance (isolation)

**Acceptance Criteria:**
- [ ] First launch shows wizard when no workspaces registered
- [ ] Selecting a folder creates workspace config and opens the app
- [ ] Multiple workspaces appear in Toolbar dropdown
- [ ] Switching workspace reconnects PG and refreshes all views
- [ ] File operations outside workspace path are rejected by Tauri fs scope
- [ ] PTY processes spawn with cwd inside workspace
- [ ] Agent directories within workspace are auto-discovered

**Validation:**
```bash
# Delete ~/.genie-app/workspaces.json, launch app, verify wizard appears
```

**depends-on:** 1, 2

---

### Group 4: Agents View

**Goal:** Org hierarchy tree with agent detail, following SAC app pattern (Toolbar + SplitPane + StatusBar).

**Deliverables:**
1. `packages/genie-app/views/agents/ui/AgentsView.tsx` — main view component
2. Left panel: org tree (reports_to hierarchy), expandable, state indicators (●working ○idle ⊘error)
3. Right panel: agent detail card (identity, executor, assignments, stats) — matches Screen 3 design
4. Real-time: Tauri IPC events from PG LISTEN/NOTIFY for live state updates
5. Uses khal-os primitives: `<Toolbar>`, `<SplitPane>`, `<StatusBar>`, `<EmptyState>`

**Acceptance Criteria:**
- [ ] Agents tree renders org hierarchy from PG reports_to data
- [ ] Selecting agent shows detail card with executor state
- [ ] State updates appear in real-time via PG LISTEN/NOTIFY → Tauri IPC (no polling)

**Validation:**
```bash
# Visual — open agents view, verify tree renders
```

**depends-on:** Group 2

---

### Group 4: Terminal View

**Goal:** Embedded xterm.js terminals with app-owned PTY via bun-pty. Zero tmux, zero NATS.

**Deliverables:**
1. `packages/genie-app/views/terminal/ui/TerminalView.tsx` — multi-tab terminal view
2. `packages/genie-app/views/terminal/ui/TerminalPane.tsx` — single xterm.js instance + Tauri IPC bridge
3. PTY lifecycle via Tauri invoke:
   - `invoke('spawn_terminal', { command: 'claude ...', cols, rows })` → returns sessionId
   - `listen('app://pty-data-{sessionId}', (data) => terminal.write(data))`
   - `terminal.onData((data) => invoke('write_terminal', { sessionId, data }))`
   - `terminal.onResize(({ cols, rows }) => invoke('resize_terminal', { sessionId, cols, rows }))`
4. Tab bar: one tab per terminal session, click to switch, close tabs
5. Native mouse: select text → Cmd+C copies, scroll works, click works — xterm.js handles everything

**Acceptance Criteria:**
- [ ] Terminal pane renders with xterm.js in Tauri webview
- [ ] Can spawn a bash session via bun-pty and type commands
- [ ] Text selection + Cmd+C copy works natively (xterm.js, no tmux)
- [ ] Multiple terminal tabs work
- [ ] Resize propagates to PTY (SIGWINCH)

**Validation:**
```bash
# Visual — open terminal view, spawn bash, select text, copy
```

**depends-on:** Group 2

---

### Group 6: Tasks View (Kanban)

**Goal:** Kanban board with real-time team activity indicators.

**Deliverables:**
1. `packages/genie-app/views/tasks/ui/TasksView.tsx` — kanban board view
2. Columns from PG board stages (triage, draft, brainstorm, wish, work, review, qa, ship)
3. Task cards: title, priority, assignee, team activity indicator (●agent working, staleness)
4. Board selector: switch between project boards
5. Real-time: Tauri IPC events from PG LISTEN/NOTIFY for live card movement
6. Drag-to-move: drag task card between columns → Tauri invoke → PG update

**Acceptance Criteria:**
- [ ] Kanban board renders with correct columns from PG
- [ ] Task cards show title, priority, team activity
- [ ] Cards move in real-time when stage changes via PG LISTEN/NOTIFY
- [ ] Board selector switches between project boards

**Validation:**
```bash
# Visual — open tasks view, verify board renders with live data
```

**depends-on:** Group 2

---

### Group 7: Dashboard View

**Goal:** KPI overview — agents, tasks, teams, spend.

**Deliverables:**
1. `packages/genie-app/views/dashboard/ui/DashboardView.tsx`
2. KPI cards: agents online/total, tasks active/backlog/done, teams active, spend (placeholder)
3. Agent breakdown: state distribution chart
4. Active teams list with runtime + member count
5. Real-time updates via PG LISTEN/NOTIFY → Tauri IPC

**Acceptance Criteria:**
- [ ] Dashboard renders with agent/task/team counts from PG
- [ ] Counts update in real-time via PG LISTEN/NOTIFY

**Validation:**
```bash
# Visual — open dashboard, verify KPI cards render
```

**depends-on:** Group 2

---

### Group 8: Activity View

**Goal:** Real-time event feed with thread_id filtering.

**Deliverables:**
1. `packages/genie-app/views/activity/ui/ActivityView.tsx`
2. Chronological event feed from `genie_runtime_events` (newest first)
3. Filter by thread_id: agent, task, team scope
4. Event detail card on selection (who, what, when, linked entities)
5. Color-coded by domain (agent=purple, task=green, executor=cyan)
6. Real-time: Tauri IPC events from PG LISTEN/NOTIFY `genie_runtime_event`

**Acceptance Criteria:**
- [ ] Activity feed renders events from PG
- [ ] Filter by agent/task/team works
- [ ] New events appear in real-time via PG LISTEN/NOTIFY

**Validation:**
```bash
# Visual — open activity, verify events render with filters
```

**depends-on:** Group 2

---

### Group 9: CLI Integration + Tauri

**Goal:** `genie app` command, Tauri build config, `genie tui` deprecation.

**Deliverables:**
1. `genie app` command in `src/term-commands/app.ts`:
   - Launches Tauri binary if installed
   - Falls back to `open http://localhost:<port>` for dev mode
2. `genie tui` → prints deprecation: "genie tui is deprecated. Use `genie app` instead."
3. Tauri config: `src-tauri/tauri.conf.json` with window defaults, app name "Genie"
4. Build script: `bun run build:app` produces Tauri binary

**Acceptance Criteria:**
- [ ] `genie app` launches the desktop app (or dev server)
- [ ] `genie tui` shows deprecation message
- [ ] Tauri config exists with correct app identity

**Validation:**
```bash
genie app --help && genie tui 2>&1 | grep deprecated
```

**depends-on:** 4, 5, 6, 7, 8

---

### Group 10: Polish + Keyboard Shortcuts

**Goal:** gh-dash style keyboard navigation, theme, final polish.

**Deliverables:**
1. Keyboard shortcuts: j/k navigation, Enter select, Esc back, `/` search, `?` help overlay
2. Theme: Automagik purple palette via CSS vars (khal-os theme system)
3. StatusBar wired: PG connection, active agent count, task count, current view
4. Loading states, error boundaries, empty states for all views

**Acceptance Criteria:**
- [ ] j/k navigates lists in all views
- [ ] StatusBar shows live agent/task counts
- [ ] Theme matches Automagik brand (purple accent)
- [ ] Empty states render gracefully

**Validation:**
```bash
bun run check
```

**depends-on:** 4, 5, 6, 7, 8, 9

---

## QA Criteria

- [ ] App launches standalone (Tauri) without khal-os running
- [ ] App registers in khal-os marketplace when OS is running
- [ ] Agents view shows real org hierarchy from PG
- [ ] Terminal view: spawn Claude Code, type commands, select+copy text natively
- [ ] Kanban view: cards move in real-time when tasks change stage
- [ ] Dashboard: counts match `genie ls` and `genie task list` CLI output
- [ ] `genie app` launches the desktop app
- [ ] `genie tui` shows deprecation
- [ ] No tmux references in any frontend code
- [ ] `bun run check` passes

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Tauri build complexity for 3 platforms | Medium | Start with macOS only, add Linux/Windows after validation |
| bun-pty platform compatibility | Medium | bun-pty supports macOS + Linux. Windows needs WSL or node-pty fallback. |
| Tauri IPC throughput for PTY data | Low | Tauri IPC is in-process, not network. Claude Code output fits easily. |
| PG schema changes from CLI consolidation | Low | App queries use existing schema. CLI consolidation doesn't change tables. |
| xterm.js performance with Claude Code output | Low | WebGL addon handles high throughput. Terminal-app already proven. |
| genie-app package in khal-os repo conflicts | Low | Different package name (@automagik/genie-app vs @khal-os/genie-app). Old one stays untouched. |

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
# New package
packages/genie-app/manifest.ts              — khal-os app manifest (5 views, optional registration)
packages/genie-app/package.json             — @automagik/genie-app
packages/genie-app/components.ts            — component re-exports
packages/genie-app/tsconfig.json            — React JSX config
packages/genie-app/lib/types.ts             — shared types (Agent, Executor, Task, Team)
packages/genie-app/src-backend/index.ts     — Bun sidecar: PG queries + bun-pty + Tauri IPC
packages/genie-app/src-backend/pty.ts       — PTY manager: spawn (linked to agents/executors), write, resize, kill
packages/genie-app/src-backend/pg-bridge.ts — PG queries + LISTEN/NOTIFY → IPC events
packages/genie-app/src-backend/workspace.ts — workspace manager: init, list, open, sandbox
packages/genie-app/views/agents/ui/         — agents tree + detail
packages/genie-app/views/terminal/ui/       — xterm.js terminal embed via Tauri IPC
packages/genie-app/views/tasks/ui/          — kanban board
packages/genie-app/views/dashboard/ui/      — KPI dashboard
packages/genie-app/views/activity/ui/       — event feed
packages/genie-app/src-tauri/tauri.conf.json — Tauri desktop config
packages/genie-app/src-tauri/src/main.rs    — Tauri entry (launches Bun sidecar)

# Modified files
src/term-commands/app.ts                    — NEW: genie app command
src/genie.ts                                — register app command, deprecate tui
```

---

## Marketplace Installation Flow (end-to-end success condition)

This is the test that proves everything works:

### Step 1: Open empty Khal OS
- Fresh Khal OS instance, no apps installed
- Verify: marketplace is accessible

### Step 2: Find Genie in Marketplace
- Official Namastex app, discoverable by searching "genie"
- Verify: app listing shows name, description, icon

### Step 3: Install
- One-click install from marketplace
- Backend services + frontend views registered
- Verify: app appears in desktop/launcher

### Step 4: Configure (first launch)
- Collect: workspace folder path
- Collect: deployment method — Local | SSH | MicroVM
  - **Local**: isolated folder on this machine, genie serve runs as child process
  - **SSH**: remote server, detect saved SSH credentials, install genie workspace remotely
  - **MicroVM**: spin up isolated VM (Firecracker), install workspace inside it
- If SSH: detect existing credentials on machine, offer selection or manual entry
- Verify: all config captured, workspace initialized

### Step 5: Start and resume work
- App starts, connects to workspace (local/SSH/VM)
- If returning user: resume exactly where they left off (PG state persists)
- Verify: agents visible, tasks on board, can spawn new agents

### Deployment Modes (executor environments)

| Mode | Where services run | How Khal connects | Isolation |
|------|-------------------|-------------------|-----------|
| **Local** | Same machine, isolated folder | Direct process + localhost | Filesystem (workspace sandbox) |
| **SSH** | Remote server via SSH | SSH tunnel, NATS leaf node | Server-level (separate machine) |
| **MicroVM** | Firecracker VM on same machine | virtio-vsock or local network, NATS leaf | VM-level (strongest local isolation) |

Each mode uses the same manifest, same app code. The runtime implementation handles the differences.
