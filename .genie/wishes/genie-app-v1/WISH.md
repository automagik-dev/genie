# Wish: Genie App V1 — The Agentic Orchestration Suite

| Field | Value |
|-------|-------|
| **Status** | APPROVED |
| **Slug** | `genie-app-v1` |
| **Date** | 2026-04-05 |
| **Supersedes** | `genie-app` (FIX-FIRST, rescoped here) |
| **VNext** | `genie-app-v2-ui` (3-panel resizable layout, git panel, keyboard shortcuts, Linux/Windows) |

## Summary

Build the world's best agentic orchestration suite as a khal-native app. 9 screens powered by 48 PG tables, 9 real-time NOTIFY channels, NATS transport, and the SDK executor for full chat reconstruction. Every agent action, every dollar spent, every session turn — visible, searchable, and replayable as a WhatsApp-style conversation. Self-contained with pgserve, fully configurable through a Settings screen.

## What It Does (User Perspective)

Open khal-os desktop. Click Genie. You see a **Command Center** — system health first (pgserve running, CPU 11%, 130 workers), then a live event feed streaming tool calls and state changes, then KPI cards (186 agents, 53 running, $55.30 total cost).

Click **Fleet** — your entire agent org tree, grouped by team. Status dots with duration ("● Running 2h 14m"). Click an agent → detail panel: executor, session, recent tool calls. Hit "Connect Terminal" → xterm.js opens with their live PTY. Hit "Open Chat" → WhatsApp-style view of their conversation.

Click **Sessions** — this is the killer feature. WhatsApp Web for agent conversations. Left panel: session list with agent avatar, turn count, cost. Right panel: conversation thread. Assistant messages in green bubbles. Tool calls nested under them — "[Bash] git push" with collapsed output. Click to expand. Live sessions stream with a typing indicator. Search across 190,638 turns — find every time any agent hit a specific error.

Click **Mission Control** — kanban boards. Cards show task title, priority badge, assigned agent. Task detail panel: acceptance criteria checklist, stage history with timestamps, dependency graph, linked PR. Switch to Flow view → see the board as a directed graph with transition edges.

Click **Cost Intelligence** — every dollar traced. By model ($40.50 opus, $12.27 opus-4-6). By team. Burn rate with projections. Actionable insights: "Use Haiku for code review → save $540/month." Cache hit rate, cost per task, cost per commit.

Click **Files** — Finder-style file browser for agent brain folders. Each agent has a brain/ directory with knowledge, memories, templates. Navigate like macOS Finder — breadcrumbs, list/grid toggle, file preview. Add, remove, rename files. Powered by the same Files app components from khal-os.

Click **Scheduler** — cron jobs, triggers, execution history with exit codes and trace IDs.

Click **System** — pgserve health, database table sizes, PG NOTIFY channel stats, machine resource history.

Click **Settings** — full control over your genie instance. Global config toggles (session name, shell preference, prompt mode, auto-merge, update channel). Workspace config (pgUrl, data directory). Agent templates (provider, model, skills, auto-resume). Skills browser (15 bundled skills with descriptions). Rules editor. Provider/model selection.

All of this runs on `genie serve` with embedded pgserve. The SDK executor (`ClaudeSdkOmniExecutor`) captures every conversation turn in-process, enabling full chat reconstruction without JSONL parsing.

## Scope

### IN
- **Khal-native app structure** — manifest.ts, components.ts, khal-app.json, package.json
- **NATS transport** — all frontend↔backend via NATS subjects (`khal.{orgId}.genie.*`)
- **Backend service** — `genie serve` wrapped in `createService()` with PG NOTIFY → NATS bridge
- **SDK executor integration** — chat reconstruction from `sessions` + `session_content` tables (role, content, tool_name per turn)
- **9 screens**: Command Center, Fleet, Sessions, Mission Control, Cost Intelligence, Files, Scheduler, System, Settings
- **WhatsApp-style Session Replay** — conversation bubbles, nested tool calls, collapsed outputs, live streaming, cross-session search
- **xterm.js terminal** — real PTY relay via NATS for terminal access
- **Filesystem browser** — reuse khal Files app pattern (FilesListView, useFiles hook, breadcrumbs, list/grid)
- **Settings management** — global config, workspace config, agent templates, skills, rules
- **Tauri export** — `genie app` CLI launches standalone binary on macOS
- **Mac-first** — build and test on macOS

### OUT
- Chat view with Claude Agents SDK renderer (VNext — this wish uses session_content for chat reconstruction)
- 3-panel resizable layout (VNext)
- Git staging/commit/push panel (VNext)
- Keyboard shortcuts system (VNext)
- Tasks kanban drag-and-drop with workflow actions (VNext — needs workflow-action-engine)
- react-flow graph editor for board transitions (VNext)
- Budget alert notifications (VNext)
- Session diff view for Write/Edit tool calls (VNext)
- Brain vector search / semantic search (VNext — V1 is filesystem-only)
- Mobile/responsive optimization (VNext — desktop-first)
- Linux/Windows builds (VNext)

## Decisions

| Decision | Rationale |
|----------|-----------|
| SDK executor as primary | `ClaudeSdkOmniExecutor` captures turns in-process to sessions + session_content. Full chat reconstruction without JSONL parsing. 24 SDK message types mapped to audit_events. |
| WhatsApp Web model for sessions | Session replay renders as conversation thread, not data table. Tool calls are subordinate to assistant messages (nested + collapsed). This is the differentiator — no other agent tool has this. |
| Filesystem browser, not brain vector search | V1 browses brain/ folders using khal's existing Files app components (FilesListView, useFiles, fs.list/fs.write/fs.watch NATS). Actual brain features (embeddings, semantic search) come in V2. |
| Full Settings screen | Single-tenant genie instances need config management. 20+ toggles in config.json, 15 skills, rules, workspace config. Expose everything genie supports. |
| System health first in dashboard | UX council: users ask "is everything OK?" before "show me numbers." Health → Live feed → KPIs → Cost → Teams. |
| Desktop-first, sidebar icons | Persistent sidebar (1/6 viewport, max 200px). Icons prominent, labels visible. Collapses to icons-only at <1024px. |
| Read-only V1, actions in V2 | V1 shows everything beautifully. V2 adds drag-to-move, workflow triggers, inline editing. Keeps V1 shippable fast. |
| Empty states are conversational | "No agents yet. Launch an agent to get started." not blank screens. Specific error messages referencing pgserve/NATS status. |

## Success Criteria

- [ ] App appears in khal-os desktop as installable app
- [ ] `manifest.ts`, `components.ts`, `khal-app.json` follow khal-os patterns exactly
- [ ] Backend service starts via `createService()` wrapping `genie serve`
- [ ] Frontend communicates via NATS (`useNats()` hook), not custom IPC
- [ ] PG NOTIFY → NATS bridge relays all 9 channels to frontend
- [ ] Command Center shows system health, live feed, KPIs, and cost summary
- [ ] Fleet shows agent org tree with teams, status duration, reports_to hierarchy
- [ ] Click agent → detail panel with executor, session, recent activity, actions
- [ ] Click "Connect Terminal" → xterm.js terminal tab with real PTY
- [ ] Sessions renders as WhatsApp-style conversation with nested tool calls
- [ ] Tool call outputs collapsed by default, expandable on click
- [ ] Live sessions stream with typing indicator
- [ ] Full-text search across session_content returns matches with context
- [ ] Mission Control shows boards as kanban columns with task cards
- [ ] Task detail shows stage history, dependencies, acceptance criteria
- [ ] Cost Intelligence shows breakdown by model/team with burn rate and efficiency metrics
- [ ] Files screen browses agent brain folders with breadcrumbs, list/grid toggle
- [ ] File operations work: create folder, rename, delete (via khal fs.write NATS)
- [ ] Scheduler shows schedules and run history
- [ ] System shows pgserve status, table sizes, NOTIFY channel stats
- [ ] Settings shows and edits global config (config.json toggles)
- [ ] Settings lists agent templates, skills, and rules
- [ ] Multiple terminal tabs work independently with clean shutdown
- [ ] `genie app` launches standalone Tauri binary on macOS
- [ ] Empty states show helpful messages, errors reference specific services
- [ ] `bun run check` passes

## Execution Strategy

### Wave 1 (parallel — foundation)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Khal-native app scaffold: manifest.ts, components.ts, khal-app.json, package.json |
| 2 | engineer | Backend service: createService(), NATS subjects, PG NOTIFY → NATS bridge, SDK session subjects |

### Wave 2 (parallel — core screens, after Wave 1)
| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer | Command Center screen + sidebar/routing shell (UX: health → feed → KPIs → cost) |
| 4 | engineer | Fleet screen: agent org tree + agent detail panel + status duration |
| 5 | engineer | Terminal integration: xterm.js + PTY relay via NATS |

### Wave 3 (parallel — data screens, after Wave 2)
| Group | Agent | Description |
|-------|-------|-------------|
| 6 | engineer | Sessions: WhatsApp-style conversation replay + search (the killer feature) |
| 7 | engineer | Mission Control: boards kanban + task detail with stage history |
| 8 | engineer | Cost Intelligence: model/team breakdowns, burn rate, efficiency metrics |

### Wave 4 (parallel — remaining + polish, after Wave 2)
| Group | Agent | Description |
|-------|-------|-------------|
| 9 | engineer | Files: brain folder browser using khal Files app pattern |
| 10 | engineer | Settings: global config, workspace, agent templates, skills, rules |
| 11 | engineer | Scheduler + System screens + Tauri export + smoke test |
| review | reviewer | Full review of Groups 1-11 |

## Execution Groups

### Group 1: Khal-Native App Scaffold
**Goal:** Restructure genie-app to follow khal-os app patterns exactly. Use the exact SDK patterns from the "Khal SDK Reference Patterns" section above.

**Deliverables:**
1. `packages/genie-app/manifest.ts` — rewrite using `defineManifest()` from `@khal-os/sdk/app`:
   - `import { defineManifest } from '@khal-os/sdk/app'`
   - id: 'genie', natsPrefix: 'genie', permission: 'genie', minRole: 'platform-dev'
   - Desktop: icon, categories, comment
   - Service: entry `./views/genie/service/index.ts`, runtime: 'node', port 3100
   - Tauri: exportable: true, appName: 'KhalOS Genie', window 1200x800
   - **See "Manifest Pattern" in SDK Reference for exact structure**
2. `packages/genie-app/components.ts` — lazy-loaded component registry:
   - `genie: lazy(() => import('./views/genie/ui/GenieApp'))`
   - Components receive `{ windowId: string, meta: Record<string, unknown> }` props (KhalViewProps interface)
3. `packages/genie-app/khal-app.json` — schemaVersion 2:
   - **See "khal-app.json Pattern" in SDK Reference for exact JSON structure**
   - Must mirror manifest.ts fields exactly
4. `packages/genie-app/package.json` — update:
   - **See "Package Dependencies" in SDK Reference for exact deps**
   - Add `@khal-os/sdk`, `@khal-os/ui`, `@khal-os/types` as workspace deps
   - Add `@xterm/xterm`, `@xterm/addon-webgl`, `@xterm/addon-fit`, `zustand`
   - Add `@nats-io/transport-node`, `@nats-io/nats-core`, `pg`, `node-pty` as devDeps
   - Exports: `.` → manifest, `./components` → components, `./views/*`

**Acceptance Criteria:**
- [ ] manifest.ts matches khal-os app pattern
- [ ] components.ts uses lazy-loading with correct props interface
- [ ] khal-app.json is valid schemaVersion 2
- [ ] Package can be discovered by khal-os app-registry

**Validation:**
```bash
cd packages/genie-app && bun run typecheck
```

**depends-on:** none

---

### Group 2: Backend Service + NATS Subjects
**Goal:** Wrap genie serve in createService(), expose all data via NATS, bridge PG NOTIFY, serve SDK session data for chat reconstruction. Use `@nats-io/transport-node` for NATS connection (NOT browser hooks). See "Backend Service Pattern" in SDK Reference.

**Deliverables:**
1. `packages/genie-app/views/genie/service/index.ts`:
   - `import { connect } from '@nats-io/transport-node'` for NATS connection
   - `import pg from 'pg'` for PG LISTEN/NOTIFY bridge
   - `createService()` that starts genie's PG connection and agent registry
   - **Request/Reply NATS subjects:**
     - `khal.{orgId}.genie.dashboard.stats` → KPI aggregates (agent counts by state, executor counts, task counts by stage, session count, total cost, machine snapshot)
     - `khal.{orgId}.genie.agents.list` → agents with state, team, role, executor info, reports_to
     - `khal.{orgId}.genie.agents.show` → single agent with executor, sessions, recent runtime_events
     - `khal.{orgId}.genie.sessions.list` → sessions with turn count, agent, team, wish, cost (join audit_events)
     - `khal.{orgId}.genie.sessions.content` → session_content by session_id with pagination (offset/limit). Returns role, content, tool_name, timestamp per turn.
     - `khal.{orgId}.genie.sessions.search` → full-text search across session_content.content
     - `khal.{orgId}.genie.tasks.list` → tasks by board with column grouping
     - `khal.{orgId}.genie.tasks.show` → task with stage_log, dependencies, actors
     - `khal.{orgId}.genie.boards.list` → boards with column configs
     - `khal.{orgId}.genie.boards.show` → single board with full column/transition JSONB
     - `khal.{orgId}.genie.costs.summary` → cost by model, by team, by time period, burn rate
     - `khal.{orgId}.genie.costs.sessions` → top sessions by cost
     - `khal.{orgId}.genie.costs.tokens` → token usage per model (input/output/cache_read/cache_write)
     - `khal.{orgId}.genie.costs.efficiency` → cost per task, per commit, per turn, per LOC
     - `khal.{orgId}.genie.schedules.list` → schedules + recent runs
     - `khal.{orgId}.genie.system.health` → pgserve status, table sizes, connection count, extensions
     - `khal.{orgId}.genie.system.snapshots` → machine snapshot history (CPU, memory, workers)
     - `khal.{orgId}.genie.settings.get` → read config.json + workspace.json
     - `khal.{orgId}.genie.settings.set` → write config.json fields
     - `khal.{orgId}.genie.settings.templates` → list agent templates
     - `khal.{orgId}.genie.settings.skills` → list available skills (scan skills/ directory)
     - `khal.{orgId}.genie.settings.rules` → list rules from ~/.claude/rules/
     - `khal.{orgId}.genie.pty.create` → spawn PTY session for agent
     - `khal.{orgId}.genie.pty.{sessionId}.input` → write to PTY
     - `khal.{orgId}.genie.pty.{sessionId}.resize` → resize PTY
     - `khal.{orgId}.genie.pty.{sessionId}.kill` → kill PTY session
   - **PG NOTIFY → NATS bridge (all 9 channels):**
     - `khal.{orgId}.genie.events.agent-state` ← `genie_agent_state`
     - `khal.{orgId}.genie.events.executor-state` ← `genie_executor_state`
     - `khal.{orgId}.genie.events.task-stage` ← `genie_task_stage`
     - `khal.{orgId}.genie.events.runtime` ← `genie_runtime_event`
     - `khal.{orgId}.genie.events.audit` ← `genie_audit_event`
     - `khal.{orgId}.genie.events.message` ← `genie_message`
     - `khal.{orgId}.genie.events.mailbox` ← `genie_mailbox_delivery`
     - `khal.{orgId}.genie.events.task-dep` ← `genie_task_dep`
     - `khal.{orgId}.genie.events.trigger` ← `genie_trigger_due`
     - `khal.{orgId}.genie.pty.{sessionId}.data` → PTY output stream
   - **Filesystem subjects (delegates to khal fs service or implements directly):**
     - `khal.{orgId}.genie.fs.list` → list directory entries for brain folders
     - `khal.{orgId}.genie.fs.write` → mkdir, rename, move, delete operations
     - `khal.{orgId}.genie.fs.read` → read file content
2. `packages/genie-app/views/genie/subjects.ts` — NATS subject constants

**Acceptance Criteria:**
- [ ] Service starts via createService() pattern
- [ ] All request/reply NATS subjects respond with correct data
- [ ] Session content returns turn data suitable for chat reconstruction (role + content + tool_name)
- [ ] PG NOTIFY → NATS bridge relays all 9 channels
- [ ] PTY I/O works over NATS
- [ ] Filesystem subjects serve brain folder contents
- [ ] Settings subjects read/write config.json

**Validation:**
```bash
cd packages/genie-app && bun run typecheck
```

**depends-on:** none

---

### Group 3: Command Center + App Shell
**Goal:** Main app shell with sidebar navigation and Command Center as home screen. UX: system health first, then live feed, then KPIs, then cost. Use `useNats()` from `@khal-os/sdk/app` for all data fetching. Use `CollapsibleSidebar`, `StatusBar`, `EmptyState`, `Badge`, `Button` from `@khal-os/ui`. See "UI Component Usage" and "Hook Signatures" in SDK Reference.

**Deliverables:**
1. `packages/genie-app/views/genie/ui/GenieApp.tsx` — main app component:
   - `import { useNats, useNatsSubscription } from '@khal-os/sdk/app'`
   - `import { CollapsibleSidebar, StatusBar } from '@khal-os/ui'`
   - Receives `{ windowId, meta }` props (KhalViewProps)
   - Persistent sidebar (1/6 viewport, max 200px) with 9 navigation items:
     - 🎛 Command Center
     - 👥 Fleet
     - 🔍 Sessions
     - ✓ Mission Control
     - 💰 Cost Intelligence
     - 📁 Files
     - ⏱ Scheduler
     - ⚙ System
     - ⚙ Settings (bottom)
   - Icons prominent, labels visible. Collapses to icons-only at <1024px.
   - Active panel rendering based on selected nav
   - Receives `{ windowId, meta }` props per khal-os pattern
   - Persists active panel via `updateWindowMeta()`
2. `packages/genie-app/views/genie/ui/CommandCenter.tsx` — dashboard:
   - **Section 1: System Health** (top) — pgserve status, CPU/memory bars, worker/team/session counts from machine_snapshots
   - **Section 2: Live Activity Feed** — last 20 runtime events, streaming via NATS subscription. Each event shows: timestamp, kind icon, agent name, description text. Color-coded by kind (tool=amber, state=blue, message=green, error=red)
   - **Section 3: KPI Cards** — agents (by state with breakdown), executors running, tasks active, sessions total. Each card clickable → drills to relevant screen.
   - **Section 4: Cost Summary** — total, today, burn rate, pace projection. Model breakdown mini-bar.
   - **Section 5: Team Activity** — horizontal bars showing agents per team with cost per team.
3. `packages/genie-app/views/genie/ui/components/KpiCard.tsx` — clickable card with title, value, breakdown, trend
4. `packages/genie-app/views/genie/ui/components/LiveFeed.tsx` — streaming event list with kind icons
5. `packages/genie-app/views/genie/ui/components/EmptyState.tsx` — reusable empty state with message + action button
6. `packages/genie-app/views/genie/ui/components/ErrorState.tsx` — specific error with service reference + retry

**Acceptance Criteria:**
- [ ] App shell renders with sidebar navigation (9 items)
- [ ] Sidebar collapses to icons at <1024px
- [ ] Command Center loads in correct order: health → feed → KPIs → cost → teams
- [ ] Live feed streams events in real-time via NATS subscription
- [ ] KPI cards are clickable (navigate to relevant screen)
- [ ] Empty states render helpful messages with action buttons
- [ ] Error states reference specific services (pgserve, NATS)

**Validation:**
```bash
cd packages/genie-app && bun run typecheck
```

**depends-on:** Groups 1, 2

---

### Group 4: Fleet Screen
**Goal:** Agent org tree with team grouping, status duration, reports_to hierarchy, and rich detail panel.

**Deliverables:**
1. `packages/genie-app/views/genie/ui/Fleet.tsx`:
   - Agent list grouped by team (collapsible sections)
   - Team header: name, agent count (active/total), team status
   - Each agent row shows:
     - Status dot with duration: "● Running 2h 14m" / "◐ Spawning 30s" / "✗ Error 2m ago" / "◯ Null"
     - Name, role
     - Reports-to hierarchy (indented within team)
     - Current session turn count (if active)
   - Filter bar: State [All ▾] | Team [All ▾] | Role [All ▾] | Search [____]
   - Live status updates via NATS subscription to agent-state + executor-state events
2. `packages/genie-app/views/genie/ui/AgentDetail.tsx`:
   - **Status section**: state with duration, auto-resume (on/off, attempts/max)
   - **Executor section**: PID, tmux pane, transport, worktree
   - **Session section**: current session ID, turn count, cost
   - **Recent activity**: last 10 runtime events (tool_call name, state changes, messages) with relative timestamps
   - **Actions**: [Connect Terminal] [Open Chat] [Session Log] [Suspend] [Resume] [Kill]
   - "Connect Terminal" → opens terminal tab (Group 5)
   - "Open Chat" → navigates to Sessions filtered to this agent's active session
   - "Session Log" → navigates to Sessions filtered to all sessions for this agent
3. Status dot component with always-visible legend at top of fleet view

**Acceptance Criteria:**
- [ ] Agent org tree renders grouped by team with collapsible sections
- [ ] Status shows dot + duration (not just dot)
- [ ] Reports-to hierarchy visible via indentation
- [ ] Filter bar works for state, team, role, and free-text search
- [ ] Agent detail shows executor, session, and recent activity
- [ ] Action buttons navigate to correct screens
- [ ] Status updates animate in real-time via NATS

**Validation:**
```bash
cd packages/genie-app && bun run typecheck
```

**depends-on:** Groups 1, 2

---

### Group 5: Terminal Integration (xterm.js + PTY)
**Goal:** Real terminal rendering with PTY relay via NATS. Tab management.

**Deliverables:**
1. `packages/genie-app/views/genie/ui/Terminal.tsx`:
   - Initialize xterm.js with WebGL addon + Fit addon
   - Subscribe to NATS `genie.pty.{sessionId}.data` → write to terminal
   - On keypress → publish to NATS `genie.pty.{sessionId}.input`
   - On resize → publish to NATS `genie.pty.{sessionId}.resize`
   - Loading state while PTY initializes
   - Error state if PTY connection fails (reference agent PID, suggest check)
2. `packages/genie-app/views/genie/ui/TerminalTabs.tsx`:
   - Tab bar: agent name + session ID per tab
   - New tab → NATS request `genie.pty.create`
   - Close tab → NATS publish `genie.pty.{sessionId}.kill`
   - Max 8 open tabs (show warning after)
   - "Close all inactive" action
3. Integration: Fleet "Connect Terminal" button spawns terminal tab

**Acceptance Criteria:**
- [ ] xterm.js renders ANSI output correctly
- [ ] Keyboard input flows to PTY via NATS
- [ ] Terminal resizes on window resize
- [ ] Multiple tabs work independently
- [ ] Tab close kills the PTY session
- [ ] Loading spinner shows while PTY initializes
- [ ] Error state shown if connection fails

**Validation:**
```bash
cd packages/genie-app && bun run typecheck
```

**depends-on:** Groups 1, 2

---

### Group 6: Sessions (WhatsApp-Style Conversation Replay)
**Goal:** The killer feature. Session replay as a WhatsApp Web-style chat interface. Full-text search across 190k+ turns. Use `useNats()` for data, `useNatsSubscription()` for live streaming, `SplitPane` from `@khal-os/ui` for the two-pane layout. See SDK Reference.

**Key insight:** The SDK executor (`ClaudeSdkOmniExecutor`) captures turns to `sessions` + `session_content` tables with role, content, tool_name. We reconstruct full conversations from this data — no JSONL parsing needed.

**Deliverables:**
1. `packages/genie-app/views/genie/ui/Sessions.tsx` — two-pane layout:
   - `import { useNats, useNatsSubscription } from '@khal-os/sdk/app'`
   - `import { SplitPane, ListView, Badge, EmptyState } from '@khal-os/ui'`
   - Use `<SplitPane left={<SessionList />} right={<ConversationThread />} />`
   - **Left panel: Session list** (WhatsApp contact list style)
     - Each session row: agent avatar (role icon + status dot), agent name, last message preview (truncated), turn count badge, cost badge, relative time
     - Active sessions: pulsing green dot
     - Sortable: recent, turns, cost
     - Filterable: team, wish, role, agent, date range
     - Paginated: first 50, load-on-scroll
   - **Right panel: Conversation thread** (WhatsApp chat style)
     - Messages flow top-to-bottom as a continuous conversation
     - **User messages**: right-aligned, blue bubbles
     - **Assistant messages**: left-aligned, green bubbles
       - Tool calls rendered as nested cards UNDER the assistant message that triggered them
       - Tool card format: `[🔧 Bash] git push origin main` with chevron to expand
       - Tool outputs collapsed by default, click to expand
       - Failed tools: red border + error message visible without expanding
     - **System messages**: centered, gray, smaller text
     - **Message grouping**: consecutive assistant messages grouped; consecutive tool calls nested
     - Turn index shown subtly (hover or gutter)
     - Timestamps: relative ("2m ago") grouped by time blocks ("11:45 AM")
   - **Live session streaming**: for active sessions, subscribe to `genie.events.runtime` filtered by agent. New turns appear with animation. Typing indicator (three dots) while agent is processing.
   - **Timeline density bar** (above conversation): horizontal bar where each pixel/block = turn range. Color-coded: green=tool result, red=error, amber=tool call, blue=assistant. Click to jump. Shows where the "interesting" activity is.
2. `packages/genie-app/views/genie/ui/components/ChatBubble.tsx`:
   - Props: role, content, tool_name, timestamp, isExpanded
   - Assistant bubbles: left-aligned, green, with avatar
   - User bubbles: right-aligned, blue
   - Tool bubbles: nested card with tool icon + name + collapsible output
   - System: centered divider style
3. `packages/genie-app/views/genie/ui/components/ToolCallCard.tsx`:
   - Tool name with icon (Bash=terminal, Read=file, Write=pencil, Edit=diff, Glob=search)
   - Input preview: first line of command/file path
   - Output: collapsed, click to expand. Long outputs truncated "(+42 more lines)"
   - Status: success (green check) or error (red X)
4. `packages/genie-app/views/genie/ui/components/SearchBar.tsx`:
   - Full-text search input (debounced, fires on enter)
   - Results: session name, turn index, matching snippet with highlight
   - Click result → navigates to session, scrolls to turn, flashes briefly
5. `packages/genie-app/views/genie/ui/components/TimelineDensity.tsx`:
   - Horizontal bar visualization of turn types
   - Hover shows turn index, click jumps to turn

**Acceptance Criteria:**
- [ ] Session list renders with agent avatar, turn count, cost, relative time
- [ ] Conversation renders as WhatsApp-style bubbles (user=right/blue, assistant=left/green)
- [ ] Tool calls render as nested cards under assistant messages
- [ ] Tool outputs are collapsed by default, expandable on click
- [ ] Failed tool calls show red border with error visible
- [ ] Pagination works (first 50 turns, infinite scroll)
- [ ] Active sessions stream live turns with typing indicator
- [ ] Timeline density bar shows turn type distribution, click to jump
- [ ] Full-text search returns results with context, click navigates to turn
- [ ] Subagent sessions show parent link (from is_subagent + parent_session_id)

**Validation:**
```bash
cd packages/genie-app && bun run typecheck
```

**depends-on:** Groups 1, 2, 3 (needs app shell)

---

### Group 7: Mission Control (Boards + Tasks)
**Goal:** Kanban view of boards with task cards. Task detail with stage history and dependencies.

**Deliverables:**
1. `packages/genie-app/views/genie/ui/MissionControl.tsx`:
   - Board selector dropdown (from NATS `genie.boards.list`)
   - Kanban view:
     - Columns from `boards.columns` JSONB
     - Task cards: seq number, title (truncated), priority badge (P0=red, P1=orange, P2=blue), stage, assigned agent (avatar)
     - Column header: name + task count
   - Task list as alternative flat view (sortable table)
   - Real-time card updates via `genie.events.task-stage` subscription
2. `packages/genie-app/views/genie/ui/TaskDetail.tsx`:
   - Title, stage badge, board, column, priority, type
   - Acceptance criteria as checklist
   - Stage history timeline (from task_stage_log): timestamp → from_stage → to_stage, actor, gate_type
   - Dependencies: depends-on (with status) and blocks (with status)
   - Assignment: executor, team, session (clickable → opens session)
   - External links: external_url (GitHub PR/issue)
   - Empty state: "No tasks on this board yet"

**Acceptance Criteria:**
- [ ] Board selector lists available boards
- [ ] Kanban columns render from board JSONB config
- [ ] Task cards display with priority badges and agent avatars
- [ ] Task detail shows stage history timeline
- [ ] Dependencies render as linked cards
- [ ] Real-time updates animate cards when stage changes

**Validation:**
```bash
cd packages/genie-app && bun run typecheck
```

**depends-on:** Groups 1, 2, 3

---

### Group 8: Cost Intelligence
**Goal:** Actionable cost visualization — not just charts, but insights and efficiency metrics.

**Deliverables:**
1. `packages/genie-app/views/genie/ui/CostIntelligence.tsx`:
   - **Burn Rate** (prominent, top): total, today, daily average, monthly pace projection. Trend arrow (up/down vs yesterday).
   - **Model Breakdown**: horizontal bar chart. For each model: name, total $, percentage, bar. Highlights most expensive.
   - **Team Breakdown**: horizontal bars with agent count and total time alongside cost.
   - **Daily Cost Chart**: line/bar chart showing cost per day over selected period.
   - **Efficiency Metrics**: cost per task ($0.058), cost per commit, cost per turn, cost per LOC. Each with trend.
   - **Token Analysis table**: per-model input/output/cache_read/cache_write tokens, cache hit rate percentage.
   - **Top Sessions by Cost**: table with agent, model, turns, duration, cost. Clickable → opens session.
   - All data via NATS `genie.costs.*` subjects.

**Acceptance Criteria:**
- [ ] Burn rate displays with trend indicator
- [ ] Model and team breakdowns are accurate
- [ ] Daily chart renders time series
- [ ] Efficiency metrics show cost/task, cost/commit, cost/LOC
- [ ] Token analysis shows cache hit rates
- [ ] Top sessions clickable to navigate to Sessions screen

**Validation:**
```bash
cd packages/genie-app && bun run typecheck
```

**depends-on:** Groups 1, 2, 3

---

### Group 9: Files (Brain Folder Browser)
**Goal:** Finder-style filesystem browser for agent brain folders. Reuse khal Files app pattern with `useNats()` from `@khal-os/sdk/app` and `ListView`, `Toolbar` from `@khal-os/ui`. Adapt the `useFiles()` hook pattern from the reference implementation.

**Reference implementation:** `/home/genie/workspace/repos/khal-os/src/components/apps/files/` — FilesApp.tsx, FilesListView.tsx, GridView.tsx, FileItem.tsx, FilesToolbar.tsx, use-files.ts
**SDK pattern:** `useNats().request()` for `genie.fs.list`, `genie.fs.write`, `genie.fs.read`; `useNatsSubscription()` for live filesystem watch

**Agent brain folder structure (PARA method):**
- `brain/_Templates/`, `brain/_assets/`, `brain/_index.md`, `brain/_mounts/`
- `brain/Daily/`, `brain/memory/`, `brain/Intelligence/`, `brain/Playbooks/`
- Root files: `CONTEXT.md`, `CRITERIA.md`, `MODEL.md`, `SYSTEM.md`, `TOOLS.md`

**Deliverables:**
1. `packages/genie-app/views/genie/ui/Files.tsx`:
   - **Agent selector**: dropdown or sidebar listing agents with brain folders
   - **File browser** (adapted from khal Files app pattern):
     - Breadcrumb navigation (FilesToolbar pattern)
     - List view: file name, size, modified date, type icon (45+ extension mapping from FileItem)
     - Grid view: icon + name cards
     - Toggle between list/grid
   - **File operations**: create folder, rename (inline edit), delete (confirm dialog)
   - **File preview**: click file → preview panel (markdown rendered, code highlighted, images displayed)
   - **Keyboard shortcuts**: Enter=open, F2=rename, Delete=delete, Escape=cancel, Ctrl+A=select all
   - Data via NATS `genie.fs.list`, `genie.fs.write`, `genie.fs.read`
   - Live updates via filesystem watch (debounced)
2. `packages/genie-app/views/genie/ui/components/FileTree.tsx`:
   - Collapsible directory tree sidebar (optional, for power users)
   - Shows brain/ folder structure at a glance
3. Reuse/adapt from khal: `useFiles()` hook pattern, FsEntry type, icon mapping

**Acceptance Criteria:**
- [ ] Agent selector lists agents with brain folders
- [ ] Breadcrumb navigation works (click path segment to jump)
- [ ] List view shows files with name, size, modified date
- [ ] Grid view shows icon cards
- [ ] Create folder, rename, delete operations work via NATS
- [ ] File preview renders markdown and code
- [ ] Keyboard shortcuts work (Enter, F2, Delete, Escape)

**Validation:**
```bash
cd packages/genie-app && bun run typecheck
```

**depends-on:** Groups 1, 2, 3

---

### Group 10: Settings
**Goal:** Full management of genie configuration — every switch genie supports, exposed in the UI.

**Reference:** `src/types/genie-config.ts` (GenieConfig schema), `src/lib/genie-config.ts` (load/save), `src/lib/workspace.ts`

**Deliverables:**
1. `packages/genie-app/views/genie/ui/Settings.tsx` — tabbed settings panel:
   - **General tab**:
     - Session: name, defaultWindow, autoCreate (toggle)
     - Terminal: execTimeout (number input), readLines, worktreeBase
     - Shell: preference dropdown (auto/zsh/bash/fish)
     - Logging: tmuxDebug (toggle), verbose (toggle)
     - Updates: updateChannel dropdown (latest/next), installMethod (source/npm/bun)
     - Prompts: promptMode dropdown (append/system)
     - Auto-merge: autoMergeDev (toggle)
     - Default project (text input)
   - **Workspace tab**:
     - Workspace name, path
     - pgUrl (with test connection button)
     - Daemon PID, tmux socket
     - pgserve port, data directory
     - OTel: enabled (toggle), port, logPrompts (toggle)
   - **Agents tab** (from agent_templates):
     - List of agent templates: name, provider, role, skill, auto-resume
     - Click template → edit form: provider dropdown (claude/codex/claude-sdk), team, role, skill dropdown, cwd, extraArgs, nativeTeamEnabled (toggle), autoResume (toggle), maxResumeAttempts, paneColor
     - Create new template button
   - **Skills tab**:
     - List of 15+ bundled skills scanned from skills/ directory
     - Each shows: name, description (from SKILL.md first line), file path
     - Read-only in V1 (skills are code, not config)
   - **Rules tab**:
     - List of rules from ~/.claude/rules/*.md
     - Each shows: filename, first heading or first line
     - Click → read-only preview of rule content
     - Note: "Edit rules in ~/.claude/rules/ directory" (V2: inline editing)
   - **Worker Profiles tab**:
     - List from config.json workerProfiles map
     - Each: name, launcher, claudeArgs
     - Default profile selector
   - **Council Presets tab**:
     - List from config.json councilPresets map
     - Each: name, left, right, skill
     - Default preset selector
   - **Omni tab** (if configured):
     - apiUrl, apiKey (masked), defaultInstanceId
     - Executor preference: tmux/sdk dropdown
   - All reads/writes via NATS `genie.settings.*` subjects
   - Save button applies changes, shows success/error toast

**Acceptance Criteria:**
- [ ] General tab shows all config.json toggles with correct current values
- [ ] Changing a toggle and saving persists to config.json
- [ ] Workspace tab shows workspace.json values
- [ ] Agent templates list loads from DB, click opens edit form
- [ ] Skills tab lists all bundled skills with descriptions
- [ ] Rules tab lists all rules with preview
- [ ] Worker profiles and council presets editable
- [ ] Save shows success toast, errors show specific message

**Validation:**
```bash
cd packages/genie-app && bun run typecheck
```

**depends-on:** Groups 1, 2, 3

---

### Group 11: Scheduler + System + Tauri Export
**Goal:** Remaining screens, Tauri standalone build, and final smoke test.

**Deliverables:**
1. `packages/genie-app/views/genie/ui/Scheduler.tsx`:
   - Schedule list: name, cron expression, command, status
   - Run history table: trigger, worker, status (icon), exit code, duration, relative time
   - Run detail: expand to see output, error, trace_id
   - Empty state: "No schedules configured. Use `genie schedule create` to add one."
2. `packages/genie-app/views/genie/ui/System.tsx`:
   - pgserve status: running/stopped, port, data directory, uptime
   - Database table sizes: table name, row count, data size, index size (sortable)
   - PG NOTIFY channels: channel name, source table, trigger name
   - Machine snapshot history: CPU/memory sparkline from recent snapshots
   - Extensions: pgvector, pg_trgm versions
3. Tauri export config:
   - `khal-app.json` → `tauri.exportable: true` with window config
   - Verify `genie app` CLI works with new structure
   - `cargo tauri build` produces .app bundle on macOS
4. Smoke test:
   - App launches → Command Center loads with health/KPIs/feed
   - Fleet shows agents grouped by team
   - Sessions shows session list, click opens WhatsApp-style chat
   - Mission Control shows kanban board
   - Cost Intelligence shows model/team breakdown
   - Files browses brain folder
   - Settings shows config toggles
   - Terminal connects to agent
   - All 9 screens accessible via sidebar

**Acceptance Criteria:**
- [ ] Scheduler lists schedules and run history
- [ ] System shows pgserve status and table sizes
- [ ] Machine snapshot sparkline renders
- [ ] `genie app` launches standalone Tauri binary on macOS
- [ ] macOS .app bundle builds cleanly
- [ ] Smoke test passes — all 9 screens accessible with real data
- [ ] No screen shows blank/broken state with live data

**Validation:**
```bash
cd packages/genie-app && bun run typecheck && cargo tauri build 2>&1 | tail -10
```

**depends-on:** Groups 3-10

---

## Architecture

### Data Flow: PG → SDK → NATS → UI

```
┌──────────────────────────────────────────────────────┐
│  PostgreSQL (pgserve :19642)                          │
│  48 tables │ 17 triggers │ 9 NOTIFY channels         │
│  sessions + session_content = full chat data          │
│  audit_events = cost/tokens/sdk messages              │
└──────────┬───────────────────────────────────────────┘
           │ PG LISTEN/NOTIFY + direct queries
           ▼
┌──────────────────────────────────────────────────────┐
│  genie serve (Backend Service)                        │
│  createService() + NATS subject handlers             │
│  PG NOTIFY → NATS bridge (9 channels)                │
│  PTY manager (per-agent terminal relay)              │
│  SDK executor captures turns → session_content       │
│  Filesystem service for brain folder browsing        │
│  Config service for settings read/write              │
└──────────┬───────────────────────────────────────────┘
           │ NATS subjects (khal.{orgId}.genie.*)
           ▼
┌──────────────────────────────────────────────────────┐
│  Genie App (React UI)                                 │
│  useNats() hooks for request/reply + subscriptions   │
│  9 screens consuming live data                       │
│  WhatsApp-style chat from session_content            │
│  xterm.js for terminal │ Files browser for brain     │
│  Settings editor for config.json + workspace.json    │
└──────────────────────────────────────────────────────┘
```

### SDK Executor Session Capture

The `ClaudeSdkOmniExecutor` (at `src/services/executors/claude-sdk.ts`) captures conversation turns in-process:

```
SDK Query → sdk-session-capture.ts → sessions table (1 row per session)
                                    → session_content table (1 row per turn)
                                      - session_id, turn_index, role, content, tool_name, timestamp

24 SDK message types → claude-sdk-events.ts → audit_events table
  - sdk.assistant.message (2,134 events)
  - sdk.result.success/max_turns/max_budget (334 each)
  - sdk.system (init, api_retry, hooks, task_progress) (334)
  - sdk.tool.progress/summary (334)
```

The Sessions screen reconstructs conversations directly from `session_content ORDER BY turn_index`:
- `role = 'user'` → right-aligned blue bubble
- `role = 'assistant'` → left-aligned green bubble
- `role = 'tool'` or `tool_name IS NOT NULL` → nested tool card under previous assistant message

### Dual-Mode Architecture

| Context | Transport | Backend | Launch |
|---------|-----------|---------|--------|
| Inside khal-os desktop | NATS | `genie serve` via `createService()` | Click app icon |
| Standalone binary | NATS (embedded) | `genie serve` as sidecar | `genie app` CLI |

## UX Design Principles (from council review)

1. **Information hierarchy**: System health → Activity → Numbers. Not the other way around.
2. **WhatsApp model**: Conversations, not data tables. Tool calls subordinate to messages.
3. **Status with duration**: "● Running 2h 14m" not just "● Running"
4. **Collapsed by default**: Tool outputs, long content, secondary details. Click to expand.
5. **Empty states are helpful**: "No agents yet. [Launch an agent] to get started."
6. **Errors are specific**: "pgserve not responding on :19642" not "Error loading data"
7. **Clickable KPIs**: Every metric card navigates to its detail screen.
8. **Desktop-first**: Sidebar collapses to icons at <1024px. No mobile optimization in V1.
9. **4-color status system**: Green (#10b981) healthy, Amber (#f59e0b) pending, Red (#ef4444) error, Gray (#6b7280) null/unknown
10. **Always-visible legend**: Status dots have a legend, not just hover tooltips.

## Khal SDK Reference Patterns

Engineers MUST use these exact imports and patterns. Do NOT invent custom hooks or transports.

### Frontend Imports

```typescript
// Hooks — all from @khal-os/sdk/app
import { useNats, useService, useNatsSubscription } from '@khal-os/sdk/app';
import { defineManifest } from '@khal-os/sdk/app';
import { SUBJECTS } from '@khal-os/sdk/app';

// UI components — all from @khal-os/ui
import {
  CollapsibleSidebar, SplitPane, StatusBar, Toolbar, PropertyPanel,
  ListView, EmptyState, Button, Input, Badge, Spinner, Separator
} from '@khal-os/ui';

// Theme store (Zustand)
import { useThemeStore } from '@khal-os/ui';
```

### Hook Signatures

```typescript
// useNats() — primary transport for all frontend ↔ backend communication
const { connected, subscribe, publish, request, orgId, userId } = useNats();

// useService(appId) — dual NATS + Tauri IPC (auto-selects transport)
const { request, publish, subscribe, getUrl } = useService('genie');

// useNatsSubscription(subject, callback) — reactive subscription
useNatsSubscription(`khal.${orgId}.genie.events.agent-state`, (msg) => {
  const payload = JSON.parse(msg.data);
  // update state...
});
```

### Manifest Pattern (defineManifest)

```typescript
// packages/genie-app/manifest.ts
import { defineManifest } from '@khal-os/sdk/app';

export default defineManifest({
  id: 'genie',
  name: 'Genie',
  version: '1.0.0',
  description: 'Agentic orchestration suite — fleet, sessions, costs, mission control.',
  author: 'Namastex',
  license: 'Elastic-2.0',
  repository: 'https://github.com/khal-os/app-kit',
  views: [{
    id: 'genie',
    label: 'Genie',
    permission: 'genie',
    minRole: 'platform-dev',
    natsPrefix: 'genie',
    defaultSize: { width: 1200, height: 800 },
    component: './views/genie/ui/GenieApp'
  }],
  desktop: {
    icon: '/icons/dusk/genie.svg',
    categories: ['Developer Tools'],
    comment: 'Agentic orchestration suite'
  },
  services: [{
    name: 'genie',
    entry: './views/genie/service/index.ts',
    runtime: 'node',
    health: { type: 'tcp', target: 3100, interval: 30000, timeout: 5000 },
    ports: [3100]
  }],
  deploy: {
    port: 3100,
    resources: { requests: { cpu: '200m', memory: '256Mi' }, limits: { cpu: '1000m', memory: '1Gi' } },
    healthPath: '/api/health',
    ingress: { subdomain: 'genie' }
  },
  tauri: {
    exportable: true,
    appName: 'KhalOS Genie',
    window: { width: 1200, height: 800, title: 'Genie' }
  }
});
```

### Components Pattern

```typescript
// packages/genie-app/components.ts
import { lazy } from 'react';

export const components = {
  genie: lazy(() => import('./views/genie/ui/GenieApp')),
};

// Each component receives { windowId, meta } from khal-os shell
interface KhalViewProps {
  windowId: string;
  meta: Record<string, unknown>;
}
```

### khal-app.json Pattern

```json
{
  "schemaVersion": 2,
  "id": "genie",
  "name": "Genie",
  "version": "1.0.0",
  "description": "Agentic orchestration suite — fleet, sessions, costs, mission control.",
  "author": "Namastex",
  "license": "Elastic-2.0",
  "views": [{
    "id": "genie",
    "label": "Genie",
    "permission": "genie",
    "minRole": "platform-dev",
    "natsPrefix": "genie",
    "defaultSize": { "width": 1200, "height": 800 },
    "component": "./views/genie/ui/GenieApp"
  }],
  "desktop": {
    "icon": "/icons/dusk/genie.svg",
    "categories": ["Developer Tools"],
    "comment": "Agentic orchestration suite"
  },
  "services": [{
    "name": "genie",
    "entry": "./views/genie/service/index.ts",
    "runtime": "node",
    "health": { "type": "tcp", "target": 3100 },
    "ports": [3100]
  }],
  "tauri": {
    "exportable": true,
    "appName": "KhalOS Genie",
    "window": { "width": 1200, "height": 800, "title": "Genie" }
  }
}
```

### Backend Service Pattern

```typescript
// packages/genie-app/views/genie/service/index.ts
// Service backend connects via @nats-io/transport-node (NOT @khal-os/sdk browser hooks)
import { connect } from '@nats-io/transport-node';
import { createApp } from '@nats-io/nats-core';

const nc = await connect({ servers: process.env.NATS_URL || 'nats://localhost:4222' });

// Request/reply handler pattern:
const sub = nc.subscribe('khal.*.genie.agents.list');
for await (const msg of sub) {
  const orgId = msg.subject.split('.')[1];
  const data = await queryAgents(orgId);
  msg.respond(JSON.stringify(data));
}

// PG NOTIFY → NATS bridge pattern:
import pg from 'pg';
const client = new pg.Client({ connectionString: process.env.PG_URL || 'postgresql://localhost:19642/genie' });
await client.connect();
await client.query('LISTEN genie_agent_state');
client.on('notification', (msg) => {
  nc.publish(`khal.${orgId}.genie.events.agent-state`, JSON.stringify(JSON.parse(msg.payload)));
});
```

### NATS Subject Builder

```typescript
// Use SUBJECTS builder for consistent naming:
import { SUBJECTS } from '@khal-os/sdk/app';

// If genie subjects aren't in the builder yet, use string templates:
const genieSubject = (orgId: string, action: string) => `khal.${orgId}.genie.${action}`;
// e.g., genieSubject(orgId, 'agents.list') → 'khal.org123.genie.agents.list'
```

### UI Component Usage

```tsx
// Sidebar — use CollapsibleSidebar from @khal-os/ui
import { CollapsibleSidebar, SplitPane, ListView, EmptyState, Badge, Button } from '@khal-os/ui';

// SplitPane for two-pane layouts (Sessions, Files)
<SplitPane left={<SessionList />} right={<ConversationThread />} />

// ListView for data lists (Fleet, Scheduler, etc.)
<ListView items={agents} renderItem={(agent) => <AgentRow agent={agent} />} />

// EmptyState for no-data screens
<EmptyState title="No agents yet" description="Launch an agent to get started." action={<Button>Launch Agent</Button>} />

// Badge for status indicators
<Badge variant="success">Running</Badge>
<Badge variant="warning">Pending</Badge>
<Badge variant="error">Error</Badge>

// StatusBar at bottom of app shell
<StatusBar items={[{ label: 'pgserve', status: 'connected' }, { label: 'Agents', value: '53' }]} />
```

### App State Pattern

```typescript
// Use React hooks + Zustand stores + NATS subscriptions
// Local component state: useState/useReducer
// Shared screen state: Zustand store per screen (e.g., useFleetStore, useSessionStore)
// Real-time data: useNatsSubscription for live event streams
// Request data: useService('genie').request(subject, payload) for on-demand queries
```

### Package Dependencies (package.json)

```json
{
  "dependencies": {
    "@khal-os/sdk": "workspace:*",
    "@khal-os/ui": "workspace:*",
    "@khal-os/types": "workspace:*",
    "@xterm/xterm": "^5.5.0",
    "@xterm/addon-webgl": "^0.18.0",
    "@xterm/addon-fit": "^0.10.0",
    "zustand": "^4.5.0",
    "react": "^18.3.0",
    "react-dom": "^18.3.0"
  },
  "devDependencies": {
    "@nats-io/transport-node": "^3.0.0",
    "@nats-io/nats-core": "^3.0.0",
    "pg": "^8.13.0",
    "node-pty": "^1.0.0",
    "tsup": "^8.0.0",
    "typescript": "^5.7.0"
  }
}
```

---

## VNext: genie-app-v2-ui (separate wish)

- 3-panel resizable layout (react-resizable-panels)
- Chat view with Claude Agents SDK renderer (full SDK integration, not session_content replay)
- Git staging/commit/push panel
- Keyboard shortcuts (⌘T, ⌘W, ⌘1-9, ⌘K command palette)
- Tasks kanban drag-and-drop (needs workflow-action-engine)
- react-flow graph editor for board transitions
- Budget alerts with notifications
- Session diff view for Write/Edit tool calls
- Brain vector search / semantic search (actual brain features)
- Inline settings editing (rules, skills)
- Cross-session analytics (error patterns, efficiency trends)
- Linux + Windows builds
- Mobile/responsive optimization

## Repo & Existing Code

**Repo:** `/home/genie/workspace/repos/genie/` (github.com/namastexlabs/genie)
**Package:** `packages/genie-app/` — the app already exists with partial implementation

**What already exists (reuse/adapt, don't start from scratch):**
- `manifest.ts` — plain object with 6 views (agents, tasks, terminal, dashboard, wizard, activity). Needs `defineManifest()` wrapper + new views for Sessions, Cost, Files, Settings, Scheduler, System.
- `components.ts` — lazy-loaded registry with `{ windowId, meta }` props. Already correct pattern, just add new view imports.
- `package.json` — `@automagik/genie-app`, Vite + React 19 + Tauri. Needs `@khal-os/sdk`, `@khal-os/ui`, `zustand`, `@xterm/*` added.
- `src-backend/` — backend with `index.ts`, `ipc.ts`, `pg-bridge.ts`, `pty.ts`, `workspace.ts`. Adapt into service pattern.
- `views/agents/ui/AgentsView.tsx` — existing agents view. Replace with Fleet (Group 4).
- `views/tasks/ui/TasksView.tsx` — existing tasks view. Replace with Mission Control (Group 7).
- `views/terminal/ui/TerminalView.tsx` + `TerminalPane.tsx` — existing terminal. Adapt for Group 5.
- `views/dashboard/ui/DashboardView.tsx` — existing dashboard. Replace with Command Center (Group 3).
- `views/activity/ui/ActivityView.tsx` — existing activity feed. Merge into Command Center live feed.
- `views/wizard/ui/WizardView.tsx` — keep as-is (setup wizard).
- `views/shared/` — EmptyState, ErrorBoundary, LoadingState, StatusBar. Replace with `@khal-os/ui` equivalents.
- `lib/` — StatusBar, ipc.ts, keyboard.ts, theme.ts, types.ts, useKeyboardNav.ts. Replace ipc.ts with `useNats()` from SDK.
- `src-tauri/` — full Tauri config with icons, capabilities, Cargo. Keep and adapt.
- Custom NATS hooks in `views/genie/ui/hooks/` (useNatsRequest, useNatsLive, useNatsAction) — **REMOVE**, replace with `useNats()` + `useNatsSubscription()` from `@khal-os/sdk/app`.

**⚠️ IMPORTANT:** There is also a duplicate genie-app in `/tmp/app-kit/packages/genie-app/` — IGNORE IT. That was an experiment. All work happens in the genie repo.

**⚠️ NOTE:** The app-kit repo at `/tmp/app-kit/` contains the SDK packages (`@khal-os/sdk`, `@khal-os/ui`, `@khal-os/types`) that this app depends on. During development, link them via workspace or use published versions from npm.

## Files to Create/Modify

```
# RESTRUCTURE (in packages/genie-app/)
manifest.ts (rewrite — wrap in defineManifest(), add 4 new views)
components.ts (update — add new view lazy imports)
khal-app.json (create — schemaVersion 2)
package.json (update — add khal-os deps, xterm.js, zustand)

# REWRITE — Backend (from existing src-backend/)
src-backend/index.ts (rewrite — add NATS subject handlers for all 9 screens)
src-backend/pg-bridge.ts (update — add all 9 PG NOTIFY → NATS channels)
src-backend/pty.ts (keep — PTY relay already exists)
src-backend/workspace.ts (keep — workspace config)
lib/subjects.ts (create — NATS subject constants)

# REWRITE — App Shell (from existing src/App.tsx)
src/App.tsx (rewrite — sidebar + routing for 9 screens, use @khal-os/ui CollapsibleSidebar)

# CREATE/REWRITE — 9 Screens (under views/)
views/dashboard/ui/DashboardView.tsx (REWRITE → Command Center: health → feed → KPIs → cost)
views/agents/ui/AgentsView.tsx (REWRITE → Fleet: org tree + agent detail)
views/agents/ui/AgentDetail.tsx (CREATE — agent detail panel)
views/sessions/ui/SessionsView.tsx (CREATE — WhatsApp-style conversation replay)
views/tasks/ui/TasksView.tsx (REWRITE → Mission Control: kanban + task detail)
views/tasks/ui/TaskDetail.tsx (CREATE — task detail panel)
views/costs/ui/CostIntelligence.tsx (CREATE — cost breakdowns + efficiency)
views/files/ui/FilesView.tsx (CREATE — brain folder browser)
views/settings/ui/SettingsView.tsx (CREATE — config management)
views/scheduler/ui/SchedulerView.tsx (CREATE — cron + runs)
views/system/ui/SystemView.tsx (CREATE — pgserve + health)

# REWRITE — Terminal (from existing views/terminal/)
views/terminal/ui/TerminalView.tsx (UPDATE — use useNats() instead of custom hooks)
views/terminal/ui/TerminalPane.tsx (UPDATE — use useNats() for PTY relay)

# CREATE — Shared Components (under views/shared/)
views/shared/KpiCard.tsx (clickable KPI card)
views/shared/LiveFeed.tsx (streaming event list)
views/shared/ChatBubble.tsx (WhatsApp-style message bubble)
views/shared/ToolCallCard.tsx (collapsible tool call)
views/shared/SearchBar.tsx (full-text search with results)
views/shared/TimelineDensity.tsx (turn type heatmap)
views/shared/FileTree.tsx (directory tree sidebar)
# NOTE: EmptyState, ErrorBoundary, LoadingState already exist in views/shared/ — update to use @khal-os/ui

# DELETE — Custom hooks (replaced by @khal-os/sdk)
views/genie/ui/hooks/useNatsRequest.ts (DELETE — replaced by useNats().request)
views/genie/ui/hooks/useNatsLive.ts (DELETE — replaced by useNatsSubscription)
views/genie/ui/hooks/useNatsAction.ts (DELETE — replaced by useNats().publish)
lib/ipc.ts (DELETE — replaced by useNats/useService from @khal-os/sdk)

# KEEP — Existing
src-tauri/ (keep — Tauri config, icons, Cargo)
views/wizard/ui/WizardView.tsx (keep — setup wizard)
vite.config.ts (keep — may need minor updates)
```
