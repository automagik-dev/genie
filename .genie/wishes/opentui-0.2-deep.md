---
slug: opentui-0.2-deep
title: 100% OpenTUI 0.2 Native Adoption
status: in_progress
created: 2026-04-30
owner: claude-code (overnight autonomous run)
---

# Wish: 100% OpenTUI 0.2-native TUI

## Goal

Make every part of the genie TUI and tmux integration use OpenTUI 0.2 features
that are available to us, dropping bespoke shell-outs and ad-hoc handlers in
favor of the framework's native primitives. End state: a contributor reading
`src/tui/*` should see only @opentui/* APIs (plus pure React state), no shell
copy scripts, no manual key dispatch, no static palettes.

## Authority

User explicitly authorized an overnight autonomous run with the directive:
"make a roadmap where all of this happens sequentially while i sleep, and we
wake up to an app 100% 0.2 native".

Constraints assumed:
- Do NOT push to remote.
- Do NOT open or modify PR #1556.
- Commit per phase locally so each phase is reviewable.
- Stop at the first hard blocker, commit progress, write a status report.

## Reference material (already vetted)

- Source clone: `/tmp/opentui-clone/opentui` (main @ acccc9d, 0.2.0 published).
- Authoritative docs: `packages/web/src/content/docs/**` — these are richer
  than opentui.com (the public site is missing pages).
- Key docs to consult per phase:
  - Phase 1 — `keymap/overview.mdx`, `keymap/react.mdx`, `keymap/hosts.mdx`,
    `keymap/addons.mdx`.
  - Phase 2 — `core-concepts/console.mdx`, `bindings/react.mdx`
    (useTerminalDimensions, useOnResize, useTimeline).
  - Phase 3 — `core-concepts/renderer.mdx` (OSC 52, theme mode,
    setTerminalTitle, useKittyKeyboard, screen modes).
  - Phase 4 — `components/markdown.mdx`, `components/code.mdx`,
    `components/scrollbox.mdx`, `components/diff.mdx`, `components/select.mdx`,
    `components/input.mdx`, `components/textarea.mdx`.
  - Phase 5 — `plugins/slots.mdx`, `plugins/react.mdx`,
    `bindings/react.mdx#useTimeline`.

## Phase 0 — Branch hygiene

1. Stash + drop the WIP on `nmstx/fix-pgserve-v2-auth` (it's bit-identical to
   PR #1561 already on `dev`).
2. Delete the broken untracked `AGENTS.md`.
3. Cut `chore/opentui-0.2-deep` off latest `origin/dev`.
4. Commit this roadmap as the first marker on the new branch.

Validation: clean working tree, branch on top of `dev`.

## Phase 1 — Adopt @opentui/keymap

Replace ad-hoc `useKeyboard` callbacks (7 sites) with structured keymap
layers and named commands.

Touched files:
- `package.json` — add `@opentui/keymap` 0.2.0.
- `src/tui/render.tsx` — create the keymap with
  `createDefaultOpenTuiKeymap(renderer)`, wrap `<App>` in `<KeymapProvider>`.
- `src/tui/keymap.ts` (new) — central registry of named commands.
- `src/tui/app.tsx` — quit / double-quit via `useBindings`.
- `src/tui/components/Nav.tsx` — navigation, expand/collapse, focus moves.
- `src/tui/components/AgentPicker.tsx`, `ContextMenu.tsx`, `TeamCreate.tsx`,
  `SpawnTargetPicker.tsx`, `QuitDialog.tsx` — local layered bindings via
  `targetRef` so they only fire when the modal/picker has focus.
- Tests updated to use the new layer/command surface.

Validation:
- `bun run typecheck` clean.
- `bun test src/tui/` green (existing harness; testRender is keymap-aware
  through KeymapProvider wrapper helper if needed).
- One discoverability win: `useActiveKeys()` exposed somewhere (status bar or
  a `?` overlay) — even a minimal exposure proves the migration.

## Phase 2 — Reactive primitives + console overlay

- Replace any width/height assumptions with `useTerminalDimensions`.
- Wire `useOnResize` where Nav recomputes layout.
- Re-enable the built-in console overlay everywhere (drop the darwin
  `consoleMode: 'disabled'` workaround) and add a keymap binding for toggle.
- Move `console.error('TUI: diagnostics failed')` and friends to behavior the
  overlay can capture; remove no-op `try/catch` swallows.

Validation: same gates as Phase 1, plus a manual smoke note in the status
report ("toggled console with backtick, captured a forced error").

## Phase 3 — Tmux/terminal upgrades

- Migrate `osc52-copy.sh` shell-out to `renderer.copyToClipboardOSC52()`.
  Keep the script for non-TUI callers (agent panes still need it).
- Wire `renderer.themeMode` + `theme_mode` event into `src/tui/theme.ts`.
  Palette becomes reactive: dark/light auto-switches.
- `renderer.setTerminalTitle(...)` on Nav focus changes ("genie tui — <agent>").
- Re-enable on darwin under 0.2: `useKittyKeyboard: {}` (defaults), `useMouse:
  true`, `useThread: true`. If a regression reproduces (SIGTRAP, render hangs),
  isolate to a single env flag rather than disabling the whole feature class.
- Update `scripts/tmux/tui-tmux.conf` if any clipboard binding becomes
  redundant once the renderer drives OSC 52 directly.

Validation: typecheck + tests green; status report records darwin retry
results explicitly.

## Phase 4 — Richer renderables

Audit each surface and swap to native components:
- Agent log / transcript views: `<markdown>` + `<code>` (with syntax style).
- Diagnostics panel + agent log scroll: `<scrollbox>` + `<scrollbar>`.
- Any diff display: `<diff>`.
- AgentPicker / SpawnTargetPicker: switch list rendering to `<select>`.
- TeamCreate text fields: `<input>` (single-line), `<textarea>`
  (multi-line where applicable).
- Any tabbed surface: `<tab-select>`.
- ASCII branding (logo at startup, if any): `<ascii-font>`.

Validation: typecheck + tests green; visual regression noted in status report
with renderer dimensions snapshots from the test harness.

## Phase 5 — Plugin slots + animation

- Convert at least one extension surface (context menu OR agent picker
  overlay) to a plugin slot so external plugins can register entries.
- Adopt `useTimeline` for one transition: nav panel collapse, picker
  open/close, or selection highlight pulse.

Validation: typecheck + tests green; one new test exercising slot
registration.

## Final gate

- `bun run check` (full gate: typecheck + lint + dead-code + test) green.
- Working tree clean, branch ready to push.
- A status report file at `.genie/wishes/opentui-0.2-deep.status.md` listing:
  - Phases completed.
  - Skipped/deferred items with reason.
  - Suggested squash/PR title and body.
  - Manual smoke checklist for the user to run after waking up.

## Stop conditions

- Two consecutive failed attempts to make a phase's typecheck/tests green
  → commit progress, document the failure, stop.
- Any architectural surprise that needs a human decision (e.g., keymap
  package missing a feature we depend on) → commit progress, document, stop.
- Disk/network/auth failure on `bun add` → stop, document.

Stop != revert. Always commit progress so the morning review is concrete.
