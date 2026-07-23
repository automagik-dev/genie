# DRAFT — khal-native-desktop (umbrella research record)

**Date:** 2026-07-23
**Status:** Decomposed — see the three focused brainstorms below. This file is the shared research record they all cite.
**Target repo:** khal-os/genie-desktop (working copy `~/prod/genie-ui-ab/dash-fork`).

## Felipe's decisions (2026-07-23, picker)

1. **Order: Theme → Identity → SSH.**
2. **SSH scope: full remote parity** (terminals, repos+worktrees, agents+genie state), UX framing his words: "it's simple — decide if you'll code locally or point to remote ssh on the first screen"; inspiration = old `khal/desktop` app.
3. **Host model: Standalone + khal login** — genie desktop stays its own Electron app, embeds `@khal-os/sdk` directly; no KhalOS host.
4. **Collab v1: define after research** — research done (below); v1 shape still to be proposed.
5. He "absolutely LOVEs" the old desktop's loading **K made of dots** — include it.

## Sub-project brainstorms

- [khal-native-theme](../khal-native-theme/DRAFT.md) — re-skin dash onto KHAL NATIVE tokens/type/motion, zero layout change.
- [khal-app-kit-identity](../khal-app-kit-identity/DRAFT.md) — standalone khal login, users/roles, multiuser + agent-collab foundation.
- [genie-remote-ssh](../genie-remote-ssh/DRAFT.md) — first-screen local-vs-remote, full parity against a remote host.

## Shared research

### Sources studied
- `app-kit` clone (scratchpad): README, packages layout.
- `omni` clone: `APP-KIT-INTEGRATION-HANDOFF.md` (auth-gap lessons), `KHALOS-DESIGN-REFERENCE.md` (distilled design contract), `khal-app.json`.
- `desktop` clone (old KhalOS desktop, PWA/Tauri): connecting-screen K dot-matrix (`src/desktop/main.tsx:136-202` — 13×14 `K_MATRIX`, `connecting-dot pulse/off` classes, row-stagger `i/14*0.07s`), theme CSS under `src/theme/` (khal-components/khal-motion/animations), kernel-WS remote-first shell.
- khal CLI 2.0.199 installed (`~/.local/bin/khal`).
- Explorer A: full app-kit SDK surface map. Explorer B: full dash-fork inventory. (Key excerpts distributed into the three sub-drafts.)

### app-kit essentials (both sub-projects B/C consume)
- `@khal-os/sdk` exports: `useKhalAuth()` (returns null until an app-authored provider supplies `KhalAuth {userId, orgId, role, permissions[], email?, name?, picture?, token?}`), `KhalAuthContext` (SDK ships NO provider), roles `member < platform-dev < platform-admin < platform-owner` (+ `hasMinRole`, `normalizeRole`), `useNats()/useNatsSubscription/useService(appId)`, subject builders (org-scoped `khal.{orgId}.*`, global `os.*`), `TauriSupervisor` (standalone service runtime, `KHAL_STANDALONE=1`), `@khal-os/sdk/server` `validateKhalSession` (HS256 `khal-session` JWT verifier).
- Auth endpoints (platform, default `https://platform.khal.ai`): device-code `POST /v1/auth/device` + `/v1/auth/device/token`; WorkOS loopback `/v1/auth/login` + `/v1/auth/exchange` (port 8888); `POST /v1/auth/session-exchange` (kernel-session → platform-rest); creds at `~/.khal-os/credentials.json` (0600). Realtime: kernel WS `/ws/nats`, subprotocol `khal.v1, bearer.<jwt>` (`BrowserNatsClient`; Electron injects its own `readBrowserConfig`).
- Collaboration primitives: **none first-class** (no presence/CRDT/agent-messaging). Building blocks: `notify.user(orgId,userId)` / `notify.broadcast`, `khal.{orgId}.desktop.{userId}.cmd/event.*`, `os.auth.role-changed` / `membership-revoked`, generic `khal.{orgId}.{appId}.events.*`, `pty.*` and `fs.*` subject families (remote PTY/FS over NATS exist in the KhalOS model).
- Distribution: `@khal-os/{sdk,ui,types}` from Gitea npm registry (`.npmrc` scope → git.namastex.io); `window.__KHAL_SHARED__` is pack-only module sharing, irrelevant to a standalone Electron app (bundle the deps directly; react is optional peer).

### dash-fork essentials
- Renderer: React 19 + Tailwind v4 CSS-native (`@theme`), Radix primitives, cva only in `ui/Button.tsx`, no `cn()`. **One global stylesheet** `src/renderer/index.css` (1453 lines) holds all tokens (HSL triplets: `--background --foreground --primary --card --muted --accent --surface-0..3 --git-* --status-* --cat-1..8`), palettes `:root/.dark/.light.legacy/.dark.legacy` ("Obsidian Console"), and all bespoke classes (glass, modal, sidebar, scrollbars). ~1595 className sites, ~1413 token-utility-driven, only ~27 hardcoded hex (mostly terminal/diff/git). xterm has separate hardcoded JS palettes (`terminal/terminalThemes.ts`, `terminalFonts.ts`). Theme toggle: classes on `documentElement` (`App.tsx:624-637`).
- 20 `ui/` primitives (Button, IconButton, Modal, Popover, DropdownMenu, Command, Select, Toggle/Switch, Segmented, CountBadge/TokenBadge/PrBadge, Tooltip, Toast, Expandable, UsageBar…); 107 feature tsx.
- Main process (all local-host assumptions — the SSH seam list): node-pty spawn ×3 (`ptyManager.ts:502,617,886`), agent adapters resolve binaries via local `which` (`agents/support.ts:86`), `GitService`/`WorktreeService` = `execFile git {cwd}` (~89 calls), ~59 fs-importing files, native `fs.watch` watchers, better-sqlite3 at `userData/app.db`, `HookServer` on `127.0.0.1:<ephemeral>` curl'd from inside agent shells via `DASH_HOOK_PORT`, `GenieStateService` spawns `genie ui-bridge` as stdio child with `cwd=project` + reads `.genie/wishes/*.md` directly, Electron `openDirectory` dialog, local port allocator/service runner. No websocket server, no auth, no user tables (drizzle: projects/tasks/conversations/diffEditorComments/drawerTabs/taskPorts/featureDismissals — no owner columns). Settings per-install in localStorage (~30 keys).

### Standing constraints
- khal-rebrand wish (APPROVED, gated) owns identity/env/dirs/icons rebrand — theme work must not collide; icons (G6) await Felipe art.
- UI touches genie.db only via bridge roster tools; `genie mcp` read-only.
- No gates on the fork without Felipe's word; fork remote trap until khal-rebrand G5.
