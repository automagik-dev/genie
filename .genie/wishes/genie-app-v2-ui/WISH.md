# Wish: Genie App v2 UI — Dash-Inspired Khal-Native Cockpit

| Field | Value |
|-------|-------|
| **Status** | REVISED (2026-04-05) |
| **Slug** | `genie-app-v2-ui` |
| **Date** | 2026-03-30 (revised 2026-04-05) |
| **depends-on** | `genie-app` (sidecar + subjects registry DONE) |
| **Replaces** | Raw-Tauri-`invoke()` prototype views and inline-styled layout |
| **Revision note** | Rescoped on 2026-04-05 to enforce **khal-native stateful app contract**: every view talks to the backend through `@khal-os/sdk/app` hooks (`useNats` / `useService` / `useNatsSubscription`) over NATS subjects `khal.{orgId}.genie.{domain}.{action}`. No direct `@tauri-apps/api` imports in view code. SDK auto-detects Tauri-IPC vs WS-NATS transport — the same component runs standalone (Tauri) and inside Khal OS unchanged. |

## Summary

Rewrite the genie-app frontend as a 3-panel resizable layout inspired by dash (Anthropic's Claude desktop), built on the **Khal OS app contract**. Left = org tree sidebar (same as TUI Nav.tsx). Center = live xterm.js terminal. Right = agent detail + git staging panel (from dash). All data flows through `@khal-os/sdk/app` hooks over NATS subjects, backed by a `manifest.services` sidecar that publishes state over NATS and bridges PG NOTIFY → NATS. The app runs identically inside Khal OS (NATS WS bridge) and as a standalone Tauri binary (same SDK, Tauri-IPC transport). Uses `@khal-os/ui` primitives (not vendored), Tailwind tokens from os-ui, and xterm.js. Chrome-style programmable keyboard shortcuts.

## Khal-Native Stateful App Contract (non-negotiable)

This wish is the canonical reference for "stateful Khal app" going forward. Every delivery must honor it.

### Principles

1. **One manifest, one SDK.** The single source of truth is `packages/genie-app/manifest.ts` built with `defineManifest()` from `@khal-os/sdk/app`. The manifest declares **views** (React components) + **services** (backend sidecars). No hand-rolled Tauri commands or window shim.
2. **NATS subjects are the only public contract.** Frontend and backend agree on subjects — not on TypeScript function names, not on Tauri command IDs. All subjects live in `packages/genie-app/lib/subjects.ts` as typed builders (`GENIE_SUBJECTS.domain.action(orgId)`), mirroring the khal SDK's `SUBJECTS` pattern for core services.
3. **Transport-agnostic hooks.** Views MUST import from `@khal-os/sdk/app` — `useNats()`, `useNatsSubscription()`, `useService('genie')`. They MUST NOT import `@tauri-apps/api/core` or `@tauri-apps/api/event` directly. The SDK's `useService()` hook detects `window.__TAURI__` and routes request/subscribe calls through Tauri-IPC automatically; in Khal OS it routes through the WebSocket NATS bridge. Same code, two transports.
4. **Stateful = subscriptions + PG NOTIFY → NATS bridge.** "Stateful" means views subscribe once and receive a continuous stream of state updates. The sidecar subscribes to PG channels (`genie_executor_state`, `genie_task_stage`, `genie_runtime_event`, `genie_agent_state`, `genie_audit`, `genie_message`, `genie_mailbox`, `genie_task_dep`, `genie_trigger` — 9 channels) and republishes each NOTIFY payload on its matching NATS subject (`GENIE_SUBJECTS.events.*`). Views consume those streams via `useNatsSubscription`. No polling, no `setInterval`, no request-reply loops for live state.
5. **Request-reply for snapshots, subscribe for streams.** Snapshots (initial list, detail fetch, settings get) use `svc.request(action, payload)`. Streams (state changes, event feeds, PTY data, live cost counters) use `svc.subscribe(event, handler)` or `useNatsSubscription(subject, handler)`.
6. **The sidecar is a NATS service, not a Tauri subprocess.** `src-backend/index.ts` declared in `manifest.services[0]` opens a NATS connection (real NC inside Khal OS, loopback shim under Tauri), subscribes to every subject in `GENIE_SUBJECTS`, and answers with drizzle/pg queries. The Tauri Rust shell merely hosts the webview and spawns the sidecar as a managed child process — it owns **zero** business commands.
7. **Permissions are declared in the manifest.** Each view has `permission: '<id>'` and `minRole`. The SDK enforces role gates via `useKhalAuth()`. `manifest.store.permissions` lists NATS subject prefixes this app is allowed to publish/subscribe on (`nats:khal.*.genie.*`).
8. **Zero coupling to Khal OS internals.** The app must not import anything from `@khal-os/os-*` or `khal-os/packages/*` runtime. Only `@khal-os/sdk/app` (public surface) + `@khal-os/ui` (component library). This is what makes it portable.

### Required SDK imports (the only ones views may use for data)

```ts
// From @khal-os/sdk/app — the public app-side SDK surface
import {
  defineManifest,     // manifest.ts only
  useNats,            // low-level NATS client hook (connection status, pub/sub/request)
  useNatsSubscription,// subscribe helper with auto-cleanup
  useService,         // transport-agnostic service client (NATS in OS, Tauri-IPC standalone)
  useKhalAuth,        // { orgId, userId, role } — required for subject building + role gates
  SUBJECTS,           // core Khal subject builders (pty, fs, notify, desktop, system)
  SubjectBuilder,     // helper for view-specific subject trees
} from '@khal-os/sdk/app';

// App-local subjects (live next to the views)
import { GENIE_SUBJECTS } from '../../lib/subjects';
```

### Forbidden in view code

- `import { invoke } from '@tauri-apps/api/core'` — go through `useService().request()` instead.
- `import { listen } from '@tauri-apps/api/event'` — go through `useNatsSubscription()` or `useService().subscribe()`.
- `new WebSocket(...)` or custom fetch to the sidecar — use the SDK.
- `setInterval` for polling state — use `useNatsSubscription` on the corresponding `events.*` subject.
- Hard-coded subject strings — always build them through `GENIE_SUBJECTS.*(orgId)`.

### Stateful call patterns (copy these verbatim)

**Snapshot + live updates** (the canonical "stateful list" pattern every view uses):

```tsx
function AgentsView() {
  const svc = useService('genie');
  const { orgId } = useKhalAuth() ?? { orgId: '' };
  const [agents, setAgents] = useState<Agent[]>([]);

  // 1. Snapshot on mount
  useEffect(() => {
    if (!svc.connected || !orgId) return;
    svc.request('agents.list', {}).then((data) => setAgents((data as { agents: Agent[] }).agents));
  }, [svc.connected, orgId, svc.request]);

  // 2. Live updates via PG NOTIFY → NATS bridge
  useNatsSubscription(GENIE_SUBJECTS.events.executorState(orgId), (payload) => {
    const ev = payload as { agentId: string; state: string };
    setAgents((prev) => prev.map((a) => (a.id === ev.agentId ? { ...a, state: ev.state } : a)));
  });

  return <OrgTree agents={agents} />;
}
```

**PTY streaming** (input → publish, data → subscribe):

```tsx
function TerminalPane({ sessionId }: { sessionId: string }) {
  const { publish, orgId } = useNats();
  useNatsSubscription(GENIE_SUBJECTS.pty.data(orgId, sessionId), (chunk) => {
    terminal.write((chunk as { data: string }).data);
  });
  terminal.onData((data) => publish(GENIE_SUBJECTS.pty.input(orgId, sessionId), { data }));
}
```

**Role-gated action**:

```tsx
function SpawnButton() {
  const auth = useKhalAuth();
  const svc = useService('genie');
  if (!auth || !hasMinRole(auth.role, 'platform-dev')) return null;
  return <Button onClick={() => svc.request('agents.spawn', { name: 'reviewer' })}>Spawn</Button>;
}
```

## Design System Reference

The app uses **genie-os os-ui** tokens and components — NOT the khal-landing marketing styles.

**Source:** `/home/genie/workspace/repos/genie-os/packages/os-ui/`

**Tokens** (from `tokens.css` — OKLCH color space):
- Background: `#0A0A0A` (dark, matches landing)
- Genie product accent: `--ds-product-genie: oklch(0.73 0.13 295)` — purple
- Gray scale: `--ds-gray-100` through `--ds-gray-1000` (10 steps, OKLCH)
- Semantic: `--ds-blue-*`, `--ds-green-*`, `--ds-red-*`, `--ds-amber-*`
- Glass: `--khal-glass-tint`, `--khal-glass-border`, `--khal-glass-filter`
- Shadows: 11 levels from `--ds-shadow-2xs` to `--ds-shadow-2xl`
- Motion: `--ds-motion-timing-swift: cubic-bezier(0.175, 0.885, 0.32, 1.1)`

**Components** (from `src/components/` + `src/primitives/`):
- Layout: `Toolbar`, `SplitPane`, `StatusBar`, `CollapsibleSidebar`, `SidebarNav`
- Data: `ListView`, `PropertyPanel`, `GlassCard`
- UI: `Button` (CVA: default/secondary/tertiary/ghost), `Badge`, `StatusDot`, `Spinner`, `ProgressBar`, `NumberFlow`, `Avatar`
- Inputs: `Input`, `Switch`, `DropdownMenu`, `ContextMenu`
- Overlays: `Dialog`, `Tooltip`, `CommandDialog` (cmdk)
- Effects: `MeshGradient` (Paper Design shaders — wizard/splash only)

**Deps chain**: Radix UI primitives, class-variance-authority, lucide-react, Motion v12, @paper-design/shaders-react

**NOT using khal-landing styles**: The landing page's warm orange (#D49355) is the Khal brand. Genie's product identity is purple. The app uses os-ui, not landing CSS.

## Architecture

**Layout** (react-resizable-panels, same as dash):
```
┌──────────────────┬──────────────────────────────┬──────────────────┐
│ SIDEBAR 18%      │  TERMINAL (xterm.js)          │ DETAIL 22%       │
│ collapsible ←→   │  resizable center             │ collapsible ←→   │
│ min 12% max 28%  │  min 35%                      │ min 12% max 40%  │
└──────────────────┴──────────────────────────────┴──────────────────┘
```

All 3 panels resizable via drag handles. Sidebar and detail collapsible to 3% icon bar. Panel sizes persisted to localStorage. macOS titlebar padding (38px on Darwin).

**Data flow** — every call goes through `@khal-os/sdk/app` hooks. `svc = useService('genie')` routes request/publish/subscribe to either NATS (Khal OS) or Tauri-IPC (standalone) based on `detectTransport()`. No view ever imports `@tauri-apps/api` directly.

Requests (snapshots, command actions) — `svc.request(action, payload)`:
- `svc.request('agents.list')` → org tree for sidebar (subject: `khal.{orgId}.genie.agents.list`)
- `svc.request('agents.show', { id })` → detail panel data
- `svc.request('teams.list')` → teams section
- `svc.request('events.recent', { limit: 10, scope })` → activity feed slice
- `svc.request('dashboard.stats')` → status bar counters
- `svc.request('pty.create', { agentId, cols, rows })` → returns `{ sessionId }`
- `svc.request('pty.resize', { sessionId, cols, rows })` → SIGWINCH
- `svc.request('pty.kill', { sessionId })` → teardown
- `svc.request('git.status' | 'git.diff' | 'git.stage' | 'git.unstage' | 'git.commit' | 'git.push', { repoPath, ... })`

Streams (live state) — `useNatsSubscription(GENIE_SUBJECTS.X(orgId), handler)`:
- `GENIE_SUBJECTS.events.executorState(orgId)` → sidebar status dots (PG `genie_executor_state` channel)
- `GENIE_SUBJECTS.events.agentState(orgId)` → agent badge updates
- `GENIE_SUBJECTS.events.taskStage(orgId)` → detail panel task movement
- `GENIE_SUBJECTS.events.runtime(orgId)` → activity feed appends
- `GENIE_SUBJECTS.events.audit(orgId)`, `message`, `mailbox`, `taskDep`, `trigger` → domain-specific live updates
- `GENIE_SUBJECTS.pty.data(orgId, sessionId)` → terminal chunks (xterm.write)
- Publishes: `GENIE_SUBJECTS.pty.input(orgId, sessionId)` → keystrokes flow to sidecar
- `GENIE_SUBJECTS.pty.exit(orgId, sessionId)` → tab close signal

**Backend sidecar contract** (`src-backend/index.ts`, declared in `manifest.services`):
1. On startup, connect to NATS (NC from `@nats-io/nats-core` in OS; in-process loopback when the SDK reports `transport === 'tauri-ipc'` and forward IPC to internal handlers).
2. Subscribe to every leaf of `GENIE_SUBJECTS` — one subscription per action — and answer with drizzle queries against genie PG.
3. Open a single `pg.Client` LISTEN connection, subscribe to all 9 `genie_*` channels, and re-publish each NOTIFY payload on its corresponding `GENIE_SUBJECTS.events.*(orgId)` subject. This is the **PG NOTIFY → NATS bridge**.
4. Maintain a PTY session registry keyed by `sessionId`; stream chunks on `GENIE_SUBJECTS.pty.data(orgId, sessionId)`; consume `pty.input` subscriptions and `pty.write()` to the correct child.
5. On shutdown, drain subscriptions, close NATS, end the PG listener.

## Scope

### IN

**Khal SDK wiring (foundation — touches every view):**
- `packages/genie-app/manifest.ts` — rebuilt with `defineManifest()` from `@khal-os/sdk/app`. Declares 12 views (agents, terminal, tasks, dashboard, sessions, costs, files, settings, scheduler, system, activity, wizard), one `services[0]` entry for the sidecar, `store.permissions: ['nats:khal.*.genie.*']`, and `tauri.exportable: true` so the same package produces both the OS-registered app and the standalone Tauri binary.
- `packages/genie-app/lib/subjects.ts` — typed `GENIE_SUBJECTS` registry with 12 domains (dashboard, agents, sessions, tasks, boards, costs, schedules, system, settings, pty, fs, events). Already scaffolded; this wish finalizes the schema + adds any missing leaves identified per group.
- `packages/genie-app/lib/ipc.ts` — **deleted**. No more raw Tauri `invoke()` / `listen()` wrapper. Replaced by direct `useService('genie')` / `useNatsSubscription()` calls inside views.
- `packages/genie-app/views/**/ui/*.tsx` — systematic migration: every view that currently imports from `lib/ipc` must switch to `@khal-os/sdk/app` hooks. Grep guard: `rg "from '.*lib/ipc'"` and `rg "from '@tauri-apps/api'"` must return zero hits in `views/`.
- `packages/genie-app/src-backend/index.ts` — sidecar rewritten as a NATS service using `@khal-os/sdk/service` runtime (or a thin loopback shim when launched by Tauri). Subscribes to every `GENIE_SUBJECTS` leaf, opens the PG NOTIFY bridge for 9 channels, owns the PTY registry.
- `packages/genie-app/src-backend/pg-bridge.ts` — dedicated module: opens one persistent `pg.Client` LISTEN, listens on `genie_executor_state`, `genie_task_stage`, `genie_runtime_event`, `genie_agent_state`, `genie_audit`, `genie_message`, `genie_mailbox`, `genie_task_dep`, `genie_trigger`, and republishes each payload on `GENIE_SUBJECTS.events.*(orgId)`. Reconnect logic + dedupe by notify payload hash.

**UI components — `@khal-os/ui` only, no vendoring:**
- Import directly from `@khal-os/ui` as a peer dep: `Button`, `Badge`, `StatusDot`, `Spinner`, `Toolbar`, `SplitPane`, `StatusBar`, `CollapsibleSidebar`, `SidebarNav`, `ListView`, `PropertyPanel`, `GlassCard`, `Dialog`, `Tooltip`, `CommandDialog`, `Input`, `Switch`, `DropdownMenu`, `ContextMenu`, `Avatar`, `ProgressBar`, `NumberFlow`.
- If a primitive is missing from `@khal-os/ui`, open an upstream PR first, then use it. The previous "vendor into `packages/genie-app/ui/`" approach is **rejected** — it creates drift and breaks the marketplace upgrade story.
- Tokens come from `@khal-os/ui/tokens.css` (OKLCH, already includes `--ds-product-genie`, the full `--ds-gray-*` scale, semantic colors, glass, shadows, motion). Import once in `src/index.css`.
- Tailwind is additive on top of the token layer (utility classes only — never redefine tokens).
- `lucide-react` for icons, `@paper-design/shaders-react` for the wizard splash (matching khal-landing/os-ui).

**3-panel resizable shell (App.tsx):**
- `react-resizable-panels` — PanelGroup + Panel + PanelResizeHandle
- Sidebar (left): 18% default, 3% collapsed, 12-28% range
- Terminal (center): flexible, min 35%
- Detail (right): 22% default, 3% collapsed, 12-40% range
- Drag handles: 1px, subtle border color, visible on hover
- Panel sizes persisted to localStorage
- StatusBar at bottom (os-ui primitive): PG connection dot, agent count, task count, team count, active view

**Sidebar — org tree (same tree logic as TUI Nav.tsx):**
- Tree data from `invoke('list_agents')` grouped by `reports_to` hierarchy:
  - Namastex Labs (org)
  - ▾ SOFIA (PM) → sofia, helena
  - ▾ VEGAPUNK (PM) → genie, genie-os, omni, totvs, docs
  - ▾ RESEARCHERS → researchers, rlmx, tauri-researcher
  - ▸ UNASSIGNED → ceo
- Status indicators (from dash):
  - ● amber pulsing = working (executor state = 'working')
  - ● green = idle (executor state = 'idle')
  - ○ gray = stopped (no active executor)
  - ◐ spinner = has active team work
  - ▶ = currently selected (attached in center terminal)
- TEAMS section below agents: active teams with status dot + wish slug
- ▸ Archived section: collapsed, shows archived agents
- Keyboard nav: ↑↓ (or j/k) navigate, ←→ (or h/l) collapse/expand, Enter = attach/spawn
- Mouse: click to select + attach, hover shows action icons
- Collapsed mode (3%): first-letter avatars with count badges + settings icon
- Tree sections collapsible (▾/▸), state preserved in localStorage
- Real-time: `onEvent('executor-state-changed')` updates status dots without polling

**Center — xterm.js live terminal:**
- `@xterm/xterm` + `@xterm/addon-webgl` + `@xterm/addon-fit` + `@xterm/addon-web-links`
- Tab bar at top: agent's tmux windows (home, team-work-1, etc.)
  - Tabs show window name + optional status dot
  - ⌘1-9 switches tabs
  - Click tab to switch, middle-click to close
  - `+ Terminal` and `+ Agent` buttons at end of tab bar
- Click agent in sidebar → respawn terminal pane attached to that agent's tmux session
  - Same logic as TUI: `attachProjectWindow(rightPane, sessionName, windowIndex)`
  - But instead of tmux respawn-pane, uses `invoke('spawn_terminal')` + xterm.js
- PTY data streaming: `onEvent('pty-data')` → `terminal.write(data)`
- Keyboard input: `terminal.onData()` → `invoke('write_terminal')`
- Resize: ResizeObserver + `fitAddon.fit()` → `invoke('resize_terminal')`
- Native select + Cmd+C copy (xterm.js handles natively)
- Drag-drop file paths into terminal (from dash)
- Scroll-to-bottom indicator on initial attach
- When sidebar collapsed: horizontal task/agent tabs appear in header (from dash)

**Right detail panel — PropertyPanel + git (from dash FileChangesPanel):**
- All sections collapsible, using os-ui `PropertyPanel`:
  - **IDENTITY**: name, role, reports_to, model, session, started_at
  - **EXECUTOR**: provider, transport, state dot, PID, uptime, worktree, repo_path
  - **GIT** (adapted from dash `FileChangesPanel`):
    - Branch name + icon
    - File list: staged/unstaged sections
    - Per-file: status badge (M/A/D/R/U with colors), filename, +/- line stats
    - Click file → diff overlay (modal, syntax highlighted)
    - [Stage All] [Unstage All] buttons
    - Commit message textarea
    - [Commit] [Push] buttons
    - Git data from: `invoke('git_status')`, `invoke('git_diff')`, `invoke('git_commit')`, `invoke('git_push')` (NEW backend commands needed)
  - **ACTIVITY**: last 10 runtime_events for this agent (from `invoke('stream_events')`)
  - **ASSIGNMENTS**: recent task assignments with status
- Collapsed mode (3%): section icons vertically stacked
- Panel persists collapsed state to localStorage

**Keyboard shortcuts (Chrome-style, programmable):**
- Default bindings:
  - `⌘T` — new terminal tab
  - `⌘W` — close current tab
  - `⌘1-9` — switch to tab N
  - `⌘Shift+J` / `⌘Shift+K` — next/prev agent in sidebar
  - `⌘\`` — focus terminal
  - `⌘,` — settings
  - `⌘K` — command palette (os-ui CommandDialog / cmdk)
  - `⌘B` — toggle sidebar
  - `⌘Shift+B` — toggle detail panel
  - `⌘Shift+A` — stage all files
  - `⌘Shift+G` — commit graph (future)
  - `Esc` — close overlay / deselect
- Bindings stored in localStorage as `keybindings` (JSON map)
- Settings modal to remap any shortcut
- Skip shortcuts when focused in INPUT/TEXTAREA
- Custom `matchesBinding(event, binding)` utility (from dash pattern)

**Theme + styling:**
- Tailwind CSS with Geist design tokens (from os-ui)
- Dark theme default, Automagik purple accent (`#7c3aed`)
- HSL CSS vars: `--background`, `--foreground`, `--primary`, `--surface-0/1/2/3`, `--border`
- Git status colors: `--git-added` (green), `--git-modified` (orange), `--git-deleted` (red), `--git-renamed` (blue)
- `lucide-react` for all icons (replace Unicode symbols)
- Zero inline `style={}` props — Tailwind classes only

**New backend IPC commands needed** (small additions to existing ipc.ts):
- `git_status({repoPath: string})` → `{staged: GitFile[], unstaged: GitFile[]}` where `GitFile = {path, status, additions, deletions}`
- `git_diff({repoPath: string, file?: string})` → `{diff: string}`
- `git_commit({repoPath: string, message: string})` → `{hash: string, ok: boolean}`
- `git_push({repoPath: string})` → `{ok: boolean, error?: string}`
- `git_stage({repoPath: string, files: string[]})` → `{ok: boolean}`
- `git_unstage({repoPath: string, files: string[]})` → `{ok: boolean}`

**Security for git commands**: All paths resolved via `path.resolve()` and validated against workspace root (must be inside workspace). File paths validated against `git status` output (never accept arbitrary paths). Commit messages passed as args array to `execFile`, not interpolated into shell strings. Never use `execSync` with string concatenation.

### OUT

- Backend rewrite — pg-bridge.ts, pty.ts, ipc.ts are fine. Only add git commands.
- Tauri Rust changes — main.rs sidecar bridge is fine as-is.
- Mobile/responsive — desktop only
- Workspace wizard — separate concern
- AppPtyProvider — separate wish
- Dashboard view — defer, agents view is the app
- Tasks kanban view — defer, agents view is the app
- Activity standalone view — absorbed into detail panel

## Decisions

| Decision | Rationale |
|----------|-----------|
| **`@khal-os/sdk/app` is the only data access layer in views** | One codebase, two transports (NATS in OS, Tauri-IPC standalone), auto-detected via `detectTransport()`. Direct `invoke()` fragments the app and breaks OS marketplace install. |
| **Typed `GENIE_SUBJECTS` registry, no string literals in views** | Subjects are the contract between frontend and sidecar. Typed builders make refactors safe and permissions enforceable. Mirrors the core SDK's `SUBJECTS` pattern (`pty`, `fs`, `notify`, `desktop`). |
| **Stateful = `useNatsSubscription` + PG NOTIFY → NATS bridge** | No polling. Sidecar listens on 9 PG channels, republishes to matching NATS subjects, views subscribe once. Same pattern the core SDK uses for `pty` streaming. |
| **`@khal-os/ui` as a peer dep, not vendored** | The vendoring approach from the original draft was rejected — it creates drift and blocks marketplace updates. Missing primitives are added upstream first, then consumed normally. |
| **Sidecar declared in `manifest.services[0]`, not a hand-rolled Tauri child** | Khal OS owns service lifecycle (spawn, health check, restart, proxy ports). Tauri standalone reuses the same declaration via the `tauri.exportable` bridge generated by `khal-os/os-cli`. |
| **`tauri.exportable: true` on the manifest** | Same package produces the OS-registered app and the standalone binary. `khal-os/packages/os-cli` + `npx-cli` already implement this path — we consume it, we don't reinvent it. |
| **Role-gated views via `useKhalAuth` + `hasMinRole`** | Permissions live in the manifest and in `@khal-os/sdk/app/roles`. No ad-hoc user checks. |
| `react-resizable-panels` for layout | Same lib as dash. Battle-tested, supports collapse, persist, drag resize. |
| Agents view IS the app | Like dash: sidebar=navigation, center=terminal, right=detail. No separate "views" with a view switcher. |
| Kill the view switcher / icon nav | The 5-view icon strip was wrong. One view: agents. Dashboard stats go in StatusBar. Activity goes in detail panel. Tasks are a modal/overlay if ever needed. |
| Chrome-style shortcuts | Users know ⌘T/⌘W/⌘1-9. Don't invent new paradigms. |
| Programmable keybindings | From dash — stored in localStorage, editable in settings. |
| Git panel in detail | From dash FileChangesPanel — stage/commit/push without leaving the app. |
| Same tree as TUI | TUI's `buildWorkspaceTree()` + `session-tree.ts` logic is correct. Port to React. |

## Success Criteria

**Khal-native contract (must pass before any UI polish is reviewed):**
- [ ] `rg "from '@tauri-apps/api" packages/genie-app/views packages/genie-app/lib packages/genie-app/src` returns **zero** hits
- [ ] `rg "from '.*lib/ipc'" packages/genie-app/views` returns **zero** hits (file is deleted)
- [ ] Every view imports data access from `@khal-os/sdk/app` (`useNats` / `useNatsSubscription` / `useService` / `useKhalAuth`)
- [ ] Every subject used in code is built via `GENIE_SUBJECTS.*(orgId)` — no string literals with `khal.` in views
- [ ] `manifest.ts` passes `defineManifest()` type check with `services[0]` entry, `tauri.exportable: true`, `store.permissions: ['nats:khal.*.genie.*']`
- [ ] Sidecar subscribes to all 12 `GENIE_SUBJECTS` domains on startup; `genie agent dev:sidecar` logs "subscribed: N subjects" where N matches the leaf count
- [ ] PG NOTIFY → NATS bridge: trigger `NOTIFY genie_executor_state, '{"agentId":"test","state":"working"}'` → the frontend `useNatsSubscription(events.executorState)` handler fires within 500 ms
- [ ] `useService('genie').connected` becomes `true` within 2 s of view mount in both Tauri and OS transports
- [ ] Standalone Tauri build (`khal-os export genie-app`) produces a binary that runs with identical behavior to OS mode (same views, same data, same PTY)
- [ ] Role gate works: viewer role cannot access `system` or `terminal` views (`platform-dev` required)

**UX contract:**
- [ ] 3-panel layout: sidebar (18%), terminal (flex), detail (22%), all resizable + collapsible
- [ ] Sidebar shows org hierarchy tree from `svc.request('agents.list')` grouped by `reports_to`
- [ ] Click agent → xterm.js terminal attaches to agent's session via `GENIE_SUBJECTS.pty.data(orgId, sessionId)`
- [ ] xterm.js renders ANSI colors, select+Cmd+C copy works, resize propagates through `svc.request('pty.resize')`
- [ ] Tab bar shows agent's terminal windows, ⌘1-9 switches
- [ ] Detail panel: IDENTITY + EXECUTOR + GIT + ACTIVITY sections
- [ ] Git panel: file list with status badges, stage/unstage, commit, push via `svc.request('git.*')`
- [ ] Status dots update in real-time via `useNatsSubscription(events.executorState)` — no polling
- [ ] Activity feed appends in real-time via `useNatsSubscription(events.runtime)`
- [ ] Task stage changes move cards in real-time via `useNatsSubscription(events.taskStage)`
- [ ] Keyboard shortcuts: ⌘T, ⌘W, ⌘1-9, ⌘Shift+J/K, ⌘K, ⌘B, ⌘Shift+B
- [ ] Shortcuts programmable via settings modal
- [ ] Panel sizes + collapsed state persist to localStorage
- [ ] `@khal-os/ui` primitives used — zero components vendored into `packages/genie-app/ui/`
- [ ] Tailwind on top of os-ui tokens, zero inline styles, lucide-react icons
- [ ] `bun run check` passes
- [ ] `make tauri-dev` builds and renders correctly

## Execution Strategy

Five waves. Wave 0 is new and blocks everything else — it establishes the khal-native foundation. No UI polish ships until Wave 0 + Wave 1 have green Success Criteria.

### Wave 0: Khal SDK Foundation (blocks all others)
| Group | Agent | Description |
|-------|-------|-------------|
| 0a | engineer | Sidecar rewrite: NATS service subscribing to all `GENIE_SUBJECTS` leaves, owns PTY registry, answers drizzle queries. Replaces any hand-rolled IPC command router. |
| 0b | engineer | PG NOTIFY → NATS bridge (`src-backend/pg-bridge.ts`): single LISTEN client, 9 channels, auto-reconnect, republishes on `GENIE_SUBJECTS.events.*`. |
| 0c | engineer | Frontend SDK migration: delete `lib/ipc.ts`, grep-replace every `invoke(...)`/`onEvent(...)` with `useService('genie').request(...)` / `useNatsSubscription(...)`. Every view compiles against `@khal-os/sdk/app`. |
| 0d | engineer | Manifest cleanup: `defineManifest()` with `services[0]`, `tauri.exportable: true`, `store.permissions`, per-view `permission` + `minRole`. Delete any leftover Tauri command declarations. |

### Wave 1: Shell Foundation
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | 3-panel shell: `react-resizable-panels` + `@khal-os/ui` primitives (no vendoring) + Tailwind on top of os-ui tokens + global CSS |
| 2 | engineer | xterm.js terminal component wired to `GENIE_SUBJECTS.pty.*` via `useNats()` — no Tauri imports anywhere in the component |

### Wave 2: Core (parallel after Wave 1)
| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer | Sidebar: org tree via `svc.request('agents.list')` + live dots via `useNatsSubscription(events.executorState)` + keyboard nav |
| 4 | engineer | Detail panel: PropertyPanel sections (identity, executor, activity) — all data via `useService('genie')` |
| 5 | engineer | Git panel: sidecar exposes `git.*` subjects, frontend calls via `svc.request('git.status'|'git.diff'|'git.stage'|'git.unstage'|'git.commit'|'git.push')` |

### Wave 3: Polish
| Group | Agent | Description |
|-------|-------|-------------|
| 6 | engineer | Keyboard shortcuts (Chrome-style, programmable, settings modal) |
| 7 | engineer | StatusBar wired to `useNatsSubscription(events.*)` aggregate, localStorage persistence, collapsed modes, icons |
| review | reviewer | Full review against khal-native + UX success criteria |

## Execution Groups

### Group 0a: Sidecar as NATS Service

**Goal:** Rewrite `packages/genie-app/src-backend/index.ts` as a NATS service that honors `GENIE_SUBJECTS` — the single source of truth for every command the frontend can send.

**Deliverables:**
1. `src-backend/index.ts` — boots a NATS connection (real NC from `@nats-io/nats-core` in Khal OS; in-process loopback shim when `process.env.KHAL_TRANSPORT === 'tauri-ipc'`). Exposes a `start()` function called by the service runtime and a stdin/stdout IPC fallback for the Tauri host.
2. `src-backend/handlers/` — one file per domain: `agents.ts`, `sessions.ts`, `tasks.ts`, `boards.ts`, `costs.ts`, `schedules.ts`, `system.ts`, `settings.ts`, `fs.ts`, `git.ts`, `pty.ts`, `events.ts`. Each file exports a `register(nc, orgId)` function that subscribes to every leaf under its domain and returns a disposer.
3. `src-backend/service.ts` — orchestrates handler registration: for each registered handler, `nc.subscribe(GENIE_SUBJECTS.domain.action(orgId))` → drizzle query → `msg.respond(JSON.stringify(result))`. Logs "subscribed: N subjects" on boot.
4. `src-backend/pty-registry.ts` — `Map<sessionId, { child, agentId, executorId, subs[] }>`. Publishes chunks on `GENIE_SUBJECTS.pty.data(orgId, sessionId)`, consumes `pty.input`, forwards to `child.stdin.write()`.
5. Health endpoint: TCP listener on port 3100 (matches `manifest.services[0].health.target`).

**Acceptance Criteria:**
- [ ] `bun run packages/genie-app/src-backend/index.ts` boots, prints "subscribed: N subjects" (N ≥ 30)
- [ ] `nats req khal.test-org.genie.agents.list '{}'` returns JSON matching `genie ls --json`
- [ ] Stopping the process cleanly unsubscribes (no leaked subjects in `nats sub ">"` output)

**Validation:**
```bash
cd packages/genie-app && bun run typecheck && bun run src-backend/index.ts --self-test
```

**depends-on:** none

---

### Group 0b: PG NOTIFY → NATS Bridge

**Goal:** Turn PG LISTEN/NOTIFY streams into NATS subjects so views can subscribe once and receive live state forever.

**Deliverables:**
1. `src-backend/pg-bridge.ts`:
   - Opens a persistent `pg.Client` LISTEN (separate from the drizzle query pool).
   - Subscribes to all 9 channels: `genie_executor_state`, `genie_task_stage`, `genie_runtime_event`, `genie_agent_state`, `genie_audit`, `genie_message`, `genie_mailbox`, `genie_task_dep`, `genie_trigger`.
   - For each NOTIFY payload, parses JSON and publishes on the matching `GENIE_SUBJECTS.events.*(orgId)` subject.
   - Reconnect with exponential backoff on connection drop (max 30s).
   - Dedupe identical payloads within a 100ms window (avoids PG double-notify storms).
2. Wire into `src-backend/service.ts` — started alongside handler registration.
3. Metrics: log count per channel per minute (hooked into the SDK's `createService()` metrics if available).

**Acceptance Criteria:**
- [ ] `psql -c "NOTIFY genie_executor_state, '{\"agentId\":\"x\",\"state\":\"working\"}'"` causes a message to appear on `khal.test-org.genie.events.executor_state`
- [ ] Killing and restarting PG reconnects the bridge within 30s
- [ ] Each of the 9 channels has an integration test that publishes a fake NOTIFY and asserts a NATS delivery

**Validation:**
```bash
cd packages/genie-app && bun test src-backend/pg-bridge.test.ts
```

**depends-on:** Group 0a

---

### Group 0c: Frontend SDK Migration (delete `lib/ipc.ts`)

**Goal:** Every view uses `@khal-os/sdk/app` hooks. Zero direct `@tauri-apps/api` imports. Zero raw subject literals.

**Deliverables:**
1. Delete `packages/genie-app/lib/ipc.ts`.
2. For every file under `packages/genie-app/views/`:
   - Replace `import { invoke } from '../../lib/ipc'` → `import { useService } from '@khal-os/sdk/app'`
   - Replace `await invoke('list_agents')` → `await svc.request('agents.list', {})` where `const svc = useService('genie')`
   - Replace `onEvent('executor-state-changed', handler)` → `useNatsSubscription(GENIE_SUBJECTS.events.executorState(orgId), handler)`
   - Replace raw subject strings → `GENIE_SUBJECTS.domain.action(orgId)` via imported registry
   - Add `const auth = useKhalAuth()` where `orgId` is needed
3. For `packages/genie-app/lib/subjects.ts`: audit against handler list from Group 0a — add any missing leaves, remove unused ones.
4. Add a `scripts/check-khal-native.sh`:
   ```bash
   #!/usr/bin/env bash
   set -e
   if rg "from '@tauri-apps/api" packages/genie-app/views packages/genie-app/lib packages/genie-app/src --glob '!node_modules'; then
     echo "FAIL: direct @tauri-apps/api import detected in view/lib code"
     exit 1
   fi
   if rg "from '.*lib/ipc'" packages/genie-app/views; then
     echo "FAIL: lib/ipc import detected (it must be deleted)"
     exit 1
   fi
   if rg "\"khal\\.[^\"]+genie" packages/genie-app/views; then
     echo "FAIL: raw subject literal in view code (use GENIE_SUBJECTS)"
     exit 1
   fi
   echo "OK: khal-native check passed"
   ```
5. Hook the script into `packages/genie-app/package.json` `scripts.check-khal-native` and into the root `bun run check` pipeline.

**Acceptance Criteria:**
- [ ] `bun run check-khal-native` exits 0
- [ ] `bun run typecheck` in `packages/genie-app` passes
- [ ] All 12 views render in `bun run dev` without runtime import errors
- [ ] Connection status dot in StatusBar becomes green (via `useNats().connected`) within 2s of mount

**Validation:**
```bash
cd packages/genie-app && bun run check-khal-native && bun run typecheck
```

**depends-on:** Group 0a

---

### Group 0d: Manifest + Tauri Exportable

**Goal:** `manifest.ts` is the single source of truth for the app's identity, views, services, permissions, and standalone build.

**Deliverables:**
1. `packages/genie-app/manifest.ts` rebuilt with `defineManifest()`:
   - `id: 'genie-app'`
   - `views: [...]` — 12 entries, each with `permission`, `minRole`, `natsPrefix`, `defaultSize`, `component`
   - `services: [{ name: 'sidecar', entry: './src-backend/index.ts', runtime: 'node', health: { type: 'tcp', target: 3100 }, ports: [3100] }]`
   - `desktop: { icon, categories, comment }`
   - `tauri: { exportable: true, appName: 'Genie', window: { width, height, title } }`
   - `store: { name, shortDescription, description, category, author, tags, permissions: ['nats:khal.*.genie.*'] }`
2. Drop any legacy Tauri command declarations from `src-tauri/src/main.rs` — the Rust shell spawns the sidecar and hosts the webview only.
3. `packages/genie-app/package.json` peer deps: `@khal-os/sdk`, `@khal-os/ui`. Runtime deps stay minimal.
4. Run `khal-os export genie-app` (from `@khal-os/os-cli`) and verify it produces a runnable standalone binary.

**Acceptance Criteria:**
- [ ] `defineManifest()` typechecks with no errors
- [ ] Installing the app via `khal-os install ./packages/genie-app` registers it in a local Khal OS instance
- [ ] `khal-os export genie-app --target tauri` produces a binary that opens the same views as the OS-hosted app
- [ ] Role gates enforced: logging in as `viewer` hides `terminal` and `system` from the desktop launcher

**Validation:**
```bash
bun run packages/genie-app/scripts/verify-manifest.ts
```

**depends-on:** Groups 0a, 0c

---

### Group 1: 3-Panel Shell + Tailwind

**Goal:** Replace App.tsx with react-resizable-panels 3-column layout + Tailwind setup.

**Deliverables:**
1. Add deps to `packages/genie-app/package.json`: `react-resizable-panels` (NOT `@khal-os/ui` SplitPane — that's 2-panel only, we need 3), `lucide-react`.
2. Tailwind deps: `tailwindcss`, `postcss`, `autoprefixer`, `tailwind-merge`, `clsx`, `class-variance-authority`.
3. Peer deps (already present): `@khal-os/sdk`, `@khal-os/ui`. Do **not** add `@radix-ui/*` directly — `@khal-os/ui` already re-exports the primitives it needs.
4. Update `vite.config.ts` — add PostCSS plugin for Tailwind processing.
5. `tailwind.config.ts` — consume os-ui OKLCH tokens from `@khal-os/ui/tokens.css`, dark mode class-based, extend with genie-specific utility classes only (never redefine tokens).
6. `postcss.config.js` — standard Tailwind + autoprefixer PostCSS pipeline.
7. `src/index.css` — `@import '@khal-os/ui/tokens.css';` + base styles + terminal CSS + macOS titlebar (38px padding on darwin). No copy-pasted token definitions.
8. **Do not vendor os-ui primitives.** Import them from `@khal-os/ui` as a peer dep: `import { Toolbar, StatusBar, CollapsibleSidebar, PropertyPanel, Button, Badge, StatusDot, Spinner, Dialog, Tooltip, CommandDialog, ListView, GlassCard } from '@khal-os/ui'`. If a primitive is missing, open an upstream PR in `khal-os/packages/os-ui` first.
9. `src/App.tsx` — PanelGroup (horizontal) with 3 Panels + PanelResizeHandles:
   - Left: Sidebar panel (defaultSize=18, collapsible, minSize=12, maxSize=28)
   - Center: Terminal panel (minSize=35)
   - Right: Detail panel (defaultSize=22, collapsible, minSize=12, maxSize=40)
   - PanelResizeHandle: 1px, `bg-border/40`, cursor-col-resize
   - StatusBar fixed at bottom
9. Delete: `lib/theme.ts`, all view `const t = {...}` theme objects, `views/` directory entirely, old `src/App.tsx`

**Event bridging note:** The frontend subscribes to sidecar streams **only** through `@khal-os/sdk/app`. In Khal OS mode, the WS NATS bridge delivers every `GENIE_SUBJECTS.events.*` subject straight to the webview. In standalone Tauri mode, `useService()` detects `window.__TAURI__`, routes `request`/`publish` through `tauri.core.invoke('service_request' | 'service_publish')`, and routes `subscribe` through `tauri.event.listen(${appId}:${event}, ...)`. The Rust shell's only job is to wire stdin/stdout from the sidecar to those Tauri commands — it has **zero** business logic. Frontend code never imports `@tauri-apps/api`.

**Acceptance Criteria:**
- [ ] 3-panel layout renders with drag-resizable handles (react-resizable-panels)
- [ ] Panels collapse to 3% on double-click or programmatic toggle
- [ ] Tailwind classes render correctly (PostCSS pipeline working in Vite)
- [ ] os-ui tokens loaded (OKLCH colors, `--ds-product-genie` purple)
- [ ] Vendored os-ui primitives import without errors
- [ ] StatusBar visible at bottom

**Validation:**
```bash
cd packages/genie-app && bun run dev
```

**depends-on:** none

---

### Group 2: xterm.js Terminal (via khal SDK NATS subjects)

**Goal:** Replace `<pre>` buffer with a real xterm.js terminal that streams via `@khal-os/sdk/app` hooks against `GENIE_SUBJECTS.pty.*`. The component must compile and run identically in Khal OS mode and Tauri standalone mode — same code, two transports.

**Deliverables:**
1. Add deps: `@xterm/xterm`, `@xterm/addon-webgl`, `@xterm/addon-fit`, `@xterm/addon-web-links`.
2. `components/TerminalPane.tsx` — full rewrite:
   - `const { publish, subscribe, request, orgId } = useNats();`
   - On mount: `const { sessionId } = await request(GENIE_SUBJECTS.pty.create(orgId), { agentId, cols, rows })` (snapshot request)
   - `useNatsSubscription(GENIE_SUBJECTS.pty.data(orgId, sessionId), (chunk) => terminal.write((chunk as PtyDataPayload).data))`
   - `terminal.onData((data) => publish(GENIE_SUBJECTS.pty.input(orgId, sessionId), { data }))`
   - `ResizeObserver` + `fitAddon.fit()` → `request(GENIE_SUBJECTS.pty.resize(orgId, sessionId), { cols, rows })` (debounced 150ms, settle window 500ms — same as khal terminal-app)
   - Cleanup: `terminal.dispose()` + `request(GENIE_SUBJECTS.pty.kill(orgId, sessionId))` on unmount
   - **No `@tauri-apps/api` imports.** The SDK handles the transport split.
3. `components/TerminalTabs.tsx` — tab bar:
   - List of open terminal sessions from a Zustand store keyed by `sessionId`
   - Active tab highlighted, click to switch
   - ⌘1-9 to switch (wired in Group 6)
   - `+ Terminal` and `+ Agent` buttons → `request(GENIE_SUBJECTS.pty.create(orgId), { ... })`
   - Middle-click to close tab → `request(GENIE_SUBJECTS.pty.kill(orgId, sessionId))`
4. Import `@xterm/xterm/css/xterm.css` in index.css.
5. Delete old `views/terminal/ui/TerminalPane.tsx` and `views/terminal/ui/TerminalView.tsx` once the component parity is proven.
6. Reference implementation: `/home/genie/workspace/repos/khal-os/dist/standalone/packages/terminal-app/views/terminal/ui/TerminalPane.tsx` — this wish's component mirrors its `useNats()` + `SUBJECTS.pty.*` pattern, but against `GENIE_SUBJECTS` (scoped by `natsPrefix: 'genie'`) so it lives under `khal.{orgId}.genie.pty.*`.

**Acceptance Criteria:**
- [ ] Terminal renders with ANSI colors
- [ ] Type commands, see streaming output
- [ ] Select text + Cmd+C copy works
- [ ] Terminal resizes when panel resizes
- [ ] Multiple tabs, switch between them

**Validation:**
```bash
bun run check
```

**depends-on:** none

---

### Group 3: Sidebar — Org Tree (SDK-driven)

**Goal:** Port TUI Nav.tsx tree logic to React + Tailwind. All data flows through `@khal-os/sdk/app` — snapshot via `svc.request`, live updates via `useNatsSubscription`.

**Deliverables:**
1. `components/Sidebar.tsx` — main sidebar:
   - Expanded mode: org tree + teams section + archived section + settings
   - Collapsed mode (3%): first-letter avatars with count badges
   - Collapsible sections (▾/▸)
2. `components/AgentTree.tsx` — tree renderer:
   - Snapshot: `const svc = useService('genie'); const { agents } = await svc.request('agents.list', {})`
   - Group by `reports_to` to build hierarchy; port `buildWorkspaceTree()` logic from `session-tree.ts`
   - Tree nodes: agent name + status dot + team badge
   - Live dots: `useNatsSubscription(GENIE_SUBJECTS.events.executorState(orgId), (ev) => updateNode(ev))` — **no polling, no Tauri listen**
   - Spawn state transitions: also subscribe `GENIE_SUBJECTS.events.agentState(orgId)`
3. `components/TreeNode.tsx` — single tree row:
   - Indent by depth, expand/collapse icon, status dot, label, count badge
   - Selected state (▶ indicator), hover state
   - Click: select + attach terminal (publishes to a local event bus consumed by the center panel)
   - Keyboard: ↑↓ navigate, ←→ expand/collapse, Enter attach/spawn
4. Teams section: `svc.request('teams.list', {})` + live via `GENIE_SUBJECTS.events.runtime(orgId)` filtered by `kind === 'team-state'`.
5. Archived section: collapsed by default, shows archived agents (fetched via `svc.request('agents.list', { archived: true })`).

**Acceptance Criteria:**
- [ ] Org tree renders hierarchy from PG reports_to data
- [ ] Status dots update in real-time
- [ ] Click agent → center terminal attaches to its session
- [ ] Keyboard navigation works (arrow keys, Enter)
- [ ] Collapsed mode shows avatars + badges

**Validation:**
```bash
bun run check
```

**depends-on:** Group 1

---

### Group 4: Detail Panel — Identity + Executor + Activity (SDK-driven)

**Goal:** Right panel with PropertyPanel sections for selected agent. All data through `@khal-os/sdk/app`.

**Deliverables:**
1. `components/DetailPanel.tsx` — container:
   - `const svc = useService('genie'); const { agent } = await svc.request('agents.show', { id: selectedId })` — re-run on selection change
   - Collapsible to 3% (icon bar with section icons)
   - Sections: IDENTITY, EXECUTOR, ACTIVITY (GIT in Group 5)
2. `components/IdentitySection.tsx`:
   - PropertyPanel rows: name, role, reports_to, model, session, started_at
   - Status dot + badge for state (live via `useNatsSubscription(GENIE_SUBJECTS.events.agentState(orgId), ...)`)
3. `components/ExecutorSection.tsx`:
   - PropertyPanel rows: provider, transport, state, PID, uptime, worktree, repo_path
   - Live state via `useNatsSubscription(GENIE_SUBJECTS.events.executorState(orgId), ...)`
4. `components/ActivitySection.tsx`:
   - Snapshot: `svc.request('events.recent', { limit: 10, agentId: selectedId })`
   - Live append: `useNatsSubscription(GENIE_SUBJECTS.events.runtime(orgId), (ev) => { if (ev.agentId === selectedId) prepend(ev) })` — **no `setInterval`, no polling**
5. `components/AssignmentsSection.tsx`:
   - `svc.request('tasks.list', { assignee: selectedId, limit: 20 })`
   - Live updates via `useNatsSubscription(GENIE_SUBJECTS.events.taskStage(orgId), ...)` filtered by assignee.

**Acceptance Criteria:**
- [ ] Detail panel shows identity + executor for selected agent
- [ ] Activity feed shows recent events
- [ ] Data refreshes when switching agents
- [ ] Panel collapses to icon bar

**Validation:**
```bash
bun run check
```

**depends-on:** Group 1

---

### Group 5: Git Panel (from dash FileChangesPanel, via NATS subjects)

**Goal:** Git staging, commit, push panel exposed through `GENIE_SUBJECTS.git.*` subjects. Frontend calls via `svc.request('git.*', ...)` — zero direct Tauri IPC.

**Deliverables:**
1. **Backend additions** (src-backend):
   - `src-backend/handlers/git.ts` — new handler registered by Group 0a's service loop:
     - `git.status` → `execFile('git', ['status', '--porcelain=v1', '-z'], { cwd: repoPath })` → parse into staged/unstaged arrays
     - `git.diff` → `execFile('git', ['diff', ...(file ? [file] : [])], ...)` → return diff string
     - `git.stage` → `execFile('git', ['add', ...files], ...)`
     - `git.unstage` → `execFile('git', ['restore', '--staged', ...files], ...)`
     - `git.commit` → `execFile('git', ['commit', '-m', message], ...)` — message passed as argv, never interpolated
     - `git.push` → `execFile('git', ['push'], ...)`
   - Add `GENIE_SUBJECTS.git.*(orgId)` builders to `lib/subjects.ts`.
   - Register subscriptions: `nc.subscribe(GENIE_SUBJECTS.git.status(orgId)); ...` — same pattern as every other handler.
   - **Security:** `repoPath` is resolved via `path.resolve()` and must live inside the active workspace root (enforced by `validateRepoPath()` before any `execFile`). File paths are re-validated against the current `git status` output — never trust arbitrary input from the frontend.
2. **Frontend**:
   - `components/GitPanel.tsx`:
     - Staged section: file list with checkboxes (click to unstage)
     - Unstaged section: file list with checkboxes (click to stage)
     - Per-file: status badge (M=orange, A=green, D=red, R=blue, U=gray), filename (bold), dir (muted), +N -N stats
     - Click file → DiffOverlay modal with syntax-highlighted diff
     - [Stage All] [Unstage All] buttons
     - Commit message textarea
     - [Commit] [Push] buttons
     - Error display (toast or inline)
   - `components/DiffOverlay.tsx`:
     - Modal overlay showing unified diff
     - Syntax highlighted: green=added, red=removed
     - File path in header, close on Esc
3. Git data refreshes when selecting agent + on focus return to app
4. Status colors via CSS vars: `--git-added`, `--git-modified`, `--git-deleted`, `--git-renamed`

**Acceptance Criteria:**
- [ ] Git status shows staged/unstaged files for selected agent's repo
- [ ] Can stage/unstage individual files and bulk
- [ ] Can commit with message and push
- [ ] Click file shows diff overlay
- [ ] Status badges colored correctly

**Validation:**
```bash
bun run check
```

**depends-on:** Groups 1, 4

---

### Group 6: Keyboard Shortcuts (Chrome-style, programmable)

**Goal:** Full keyboard experience matching Chrome/dash patterns.

**Deliverables:**
1. `lib/keybindings.ts`:
   - Default bindings map: `{id: string, key: string, mod: boolean, shift: boolean, alt: boolean}`
   - Defaults: ⌘T (new tab), ⌘W (close tab), ⌘1-9 (switch tab), ⌘Shift+J/K (cycle agent), ⌘` (focus terminal), ⌘, (settings), ⌘K (command palette), ⌘B (toggle sidebar), ⌘Shift+B (toggle detail), ⌘Shift+A (stage all), Esc (close overlay)
   - `matchesBinding(event, binding)` utility
   - Load/save from localStorage key `keybindings`
2. `components/KeyboardHandler.tsx`:
   - Global window keydown listener
   - Skip when focused in INPUT/TEXTAREA
   - Dispatch actions based on binding match
3. `components/SettingsModal.tsx`:
   - Keybinding editor: list all shortcuts, click to remap
   - Theme toggle (dark/light)
   - Preferences: default model, preferred IDE path
4. `components/CommandPalette.tsx`:
   - ⌘K overlay using cmdk library (or os-ui CommandDialog)
   - Sections: Navigation (agents), Actions (spawn, team, backup), Settings
   - Fuzzy search over all actions

**Acceptance Criteria:**
- [ ] ⌘T opens new terminal tab
- [ ] ⌘W closes current tab
- [ ] ⌘1-9 switches tabs
- [ ] ⌘Shift+J/K cycles agents
- [ ] ⌘K opens command palette with search
- [ ] ⌘B toggles sidebar, ⌘Shift+B toggles detail
- [ ] Settings modal allows remapping shortcuts
- [ ] Shortcuts skip when typing in text inputs

**Validation:**
```bash
bun run check
```

**depends-on:** Groups 2, 3

---

### Group 7: StatusBar + Persistence + Polish

**Goal:** Wire StatusBar, localStorage persistence, collapsed panel modes, icons.

**Deliverables:**
1. `components/StatusBar.tsx`:
   - os-ui StatusBar primitive
   - Items: PG connection dot (green/red), agent count, task count, team count
   - Data from `invoke('dashboard_stats')` polled every 10s
   - Right side: current agent name, keyboard hint
2. localStorage persistence:
   - Panel sizes: `panelSizes` key
   - Collapsed state: `sidebarCollapsed`, `detailCollapsed`
   - Active agent: `activeAgentId`
   - Theme: `theme`
   - Keybindings: `keybindings`
   - Tree expanded state: `treeState`
3. Collapsed sidebar: first-letter avatar per org group + count badge + settings icon
4. Collapsed detail: vertical icon bar (identity/git/activity icons)
5. Replace all remaining Unicode symbols with lucide-react icons
6. Loading states: Spinner component while data fetches
7. Error boundaries: catch view crashes, show retry

**Acceptance Criteria:**
- [ ] StatusBar shows live PG connection + counts
- [ ] Panel sizes persist across page reloads
- [ ] Collapsed modes render correctly
- [ ] All icons are lucide-react SVGs

**Validation:**
```bash
bun run check && make tauri-dev
```

**depends-on:** Groups 3-6

---

## QA Criteria

**Khal-native contract:**
- [ ] `rg "from '@tauri-apps/api" packages/genie-app/views packages/genie-app/lib` → zero hits
- [ ] `rg "from '.*lib/ipc'" packages/genie-app/views` → zero hits (file deleted)
- [ ] `rg "\"khal\\.[^\"]+genie" packages/genie-app/views` → zero hits (no subject literals)
- [ ] `bun run check-khal-native` exits 0 in CI
- [ ] Sidecar boot log shows `subscribed: N subjects` where N matches `GENIE_SUBJECTS` leaf count
- [ ] PG NOTIFY → NATS bridge fires: `NOTIFY genie_executor_state` causes `useNatsSubscription(events.executorState)` handler to fire in under 500 ms
- [ ] `useService('genie').connected` is `true` within 2 s of mount in **both** OS and standalone Tauri runs
- [ ] `khal-os export genie-app --target tauri` produces a binary with byte-identical view behavior to the OS-hosted app

**UX + polish:**
- [ ] Zero `style={}` props across all files
- [ ] 3-panel layout resizes smoothly
- [ ] Terminal: ANSI colors, streaming output, select+copy, resize
- [ ] Sidebar: org hierarchy, real-time status dots (zero polling), keyboard nav
- [ ] Git panel: stage/commit/push workflow via `svc.request('git.*')`
- [ ] All keyboard shortcuts work (⌘T, ⌘W, ⌘1-9, ⌘K, ⌘B)
- [ ] Panel state persists across reloads
- [ ] `make tauri-dev` renders full app correctly

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| `@khal-os/ui` not on public npm yet | Medium | Consume via pnpm workspace link during dev; the Khal OS publish pipeline (already running on internal release) pushes to private registry. Do **not** vendor — file upstream PRs for missing primitives. |
| `@khal-os/sdk/app` API drift | Medium | Pin to `^1.0.1` in `package.json`. Add a `scripts/smoke-sdk.ts` that imports every hook used and asserts the exported shape; run in CI. |
| Tauri-IPC transport in `useService` is still stubbed upstream | High | Wave 0d includes a parity test that runs the app in both transports. If the stub is incomplete, file PR against `@khal-os/sdk` first — do not add a workaround layer in genie-app. |
| Subject fan-out (9 PG channels × N views) | Medium | PG NOTIFY bridge dedupes within 100 ms; each view subscribes by orgId, so server-side fan-out is bounded. Load-test with 100 simulated agents before ship. |
| Role gates not enforced server-side | High | Every handler in `src-backend/handlers/*` must re-check `minRole` before responding. Frontend role gate is UX, backend is security. |
| `react-resizable-panels` + Tauri webview | Low | Well-tested lib, works in any browser context. |
| `xterm.js` WebGL in Tauri | Low | Tauri webview supports WebGL. Canvas fallback exists. |
| Git shell-outs from backend | Medium | `execFile()` never `execSync()`. Validate `repoPath` against workspace root. File paths validated against current `git status` output. Commit messages passed as argv, never interpolated. |

## Files to Create/Modify

```
# New — Wave 0 (khal-native foundation)
packages/genie-app/src-backend/service.ts          — NATS service orchestrator
packages/genie-app/src-backend/pg-bridge.ts        — PG LISTEN → NATS publish bridge
packages/genie-app/src-backend/pty-registry.ts     — PTY session map + publish/input routing
packages/genie-app/src-backend/handlers/agents.ts
packages/genie-app/src-backend/handlers/sessions.ts
packages/genie-app/src-backend/handlers/tasks.ts
packages/genie-app/src-backend/handlers/boards.ts
packages/genie-app/src-backend/handlers/costs.ts
packages/genie-app/src-backend/handlers/schedules.ts
packages/genie-app/src-backend/handlers/system.ts
packages/genie-app/src-backend/handlers/settings.ts
packages/genie-app/src-backend/handlers/fs.ts
packages/genie-app/src-backend/handlers/git.ts
packages/genie-app/src-backend/handlers/pty.ts
packages/genie-app/src-backend/handlers/events.ts
packages/genie-app/scripts/check-khal-native.sh    — grep guard against forbidden imports
packages/genie-app/scripts/smoke-sdk.ts            — SDK API shape assertions
packages/genie-app/scripts/verify-manifest.ts      — defineManifest() + exportable check

# New — Wave 1+ (UI shell and components)
packages/genie-app/components/
  App.tsx                                 — 3-panel shell (replaces src/App.tsx)
  Sidebar.tsx                             — collapsible org tree sidebar
  AgentTree.tsx                           — tree data + rendering (svc.request + useNatsSubscription)
  TreeNode.tsx                            — single tree row
  TerminalPane.tsx                        — xterm.js terminal via GENIE_SUBJECTS.pty.*
  TerminalTabs.tsx                        — tab bar for terminals
  DetailPanel.tsx                         — right panel container
  IdentitySection.tsx                     — agent identity PropertyPanel
  ExecutorSection.tsx                     — executor info (live via events.executorState)
  GitPanel.tsx                            — git staging/commit/push via svc.request('git.*')
  DiffOverlay.tsx                         — diff viewer modal
  ActivitySection.tsx                     — recent events (live via events.runtime)
  AssignmentsSection.tsx                  — recent tasks (live via events.taskStage)
  StatusBar.tsx                           — bottom status bar (useNats().connected + counts)
  KeyboardHandler.tsx                     — global shortcut handler
  CommandPalette.tsx                      — ⌘K overlay
  SettingsModal.tsx                       — settings + keybinding editor

packages/genie-app/lib/keybindings.ts     — shortcut definitions + matcher
packages/genie-app/tailwind.config.ts     — consumes @khal-os/ui tokens
packages/genie-app/postcss.config.js      — PostCSS
packages/genie-app/src/index.css          — @import '@khal-os/ui/tokens.css' + globals

# Modified
packages/genie-app/manifest.ts           — defineManifest() with services[0], tauri.exportable, store.permissions
packages/genie-app/lib/subjects.ts       — finalize GENIE_SUBJECTS (12 domains, audited against handlers)
packages/genie-app/src-backend/index.ts  — boots NATS service + pg-bridge + pty-registry
packages/genie-app/vite.config.ts        — PostCSS/Tailwind plugin
packages/genie-app/package.json          — peer deps @khal-os/sdk, @khal-os/ui; runtime xterm + tailwind

# Deleted
packages/genie-app/lib/ipc.ts            — replaced by @khal-os/sdk/app hooks
packages/genie-app/lib/theme.ts          — replaced by Tailwind + tokens.css
packages/genie-app/ui/                   — any vendored primitives (import from @khal-os/ui instead)
packages/genie-app/views/                — entire directory (all old views; rebuilt in Waves 1-3)
packages/genie-app/src/App.tsx           — replaced by components/App.tsx
```

---

## Revision Log

### 2026-04-05 — Khal-Native Rescope

**Why:** The previous draft and an in-flight PR were drifting toward raw `@tauri-apps/api` usage: each view called `invoke()` directly, events came through `listen()`, the sidecar was a hand-rolled Tauri command router, and UI primitives were being vendored into `packages/genie-app/ui/`. That path fragments the app, makes Khal OS marketplace install impossible (no NATS contract), blocks the standalone Tauri export (no `tauri.exportable`), and duplicates code the Khal OS SDK already provides.

**What changed:**

1. **New Wave 0** (four groups: 0a sidecar, 0b PG NOTIFY bridge, 0c frontend migration, 0d manifest/export) — blocks all other waves.
2. **New "Khal-Native Stateful App Contract" section** at the top — 8 principles, required imports, forbidden patterns, copy-paste call patterns.
3. **Data flow rewritten** to go through `useService('genie')` + `useNatsSubscription(GENIE_SUBJECTS.events.*)` — never `@tauri-apps/api` in view code.
4. **UI components** imported from `@khal-os/ui` as a peer dep. Vendoring is explicitly rejected.
5. **Decisions table** adds 7 new rows codifying the SDK-first posture.
6. **Success Criteria** split into "Khal-native contract" (grep guards, role gates, transport parity) and "UX contract".
7. **QA Criteria** adds `bun run check-khal-native` grep guard and transport-parity smoke test.
8. **Risks table** updated for SDK version pinning, Tauri-IPC stub status, server-side role enforcement.
9. **Files list** adds `src-backend/handlers/*`, `pg-bridge.ts`, `pty-registry.ts`, `scripts/check-khal-native.sh`, explicitly deletes `lib/ipc.ts` and any vendored `ui/` directory.

**Action for any in-flight PR on this slug:** rebase onto the revised wish. Every view that imports from `@tauri-apps/api` or `lib/ipc` must be migrated as part of Group 0c before the PR is reviewable. Vendored primitives under `packages/genie-app/ui/` must be removed in favor of `@khal-os/ui` imports.

**Reference implementations consumed verbatim:**
- `khal-os/packages/os-sdk/src/app/hooks.ts` — `useNats`, `useNatsSubscription`, `useService` (the `detectTransport()` logic)
- `khal-os/packages/os-sdk/src/app/subjects.ts` — `SUBJECTS.pty.*` pattern mirrored by `GENIE_SUBJECTS.pty.*`
- `khal-os/packages/os-sdk/src/app/manifest.ts` — `defineManifest()`, `AppManifestView`, `AppServiceConfig`
- `khal-os/dist/standalone/packages/terminal-app/views/terminal/ui/TerminalPane.tsx` — the canonical "xterm.js over NATS subjects" component we are copying the structure of
