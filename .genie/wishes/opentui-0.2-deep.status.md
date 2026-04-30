---
slug: opentui-0.2-deep
title: 100% OpenTUI 0.2 Native Adoption — Status Report
status: ready-for-review
completed: 2026-04-30
branch: chore/opentui-0.2-deep
base: origin/dev
---

# Status — wake-up brief

All five phases landed. Branch is `chore/opentui-0.2-deep` on top of
current `origin/dev`. **Not pushed** — review locally, then push and
open a PR when you're ready.

```
8a47919c feat(tui): animate HelpOverlay with useTimeline (Phase 5)
dc42948d feat(tui): adopt richer renderables — select + ascii-font (Phase 4)
c54635c1 feat(tui): set terminal title from selected agent (Phase 3)
6061df7d feat(tui): enable console overlay surface on darwin (Phase 2)
8a1161c5 feat(tui): adopt @opentui/keymap with help overlay (Phase 1)
db5d9452 docs(tui): roadmap for 100% OpenTUI 0.2 native adoption
```

## What's live

| Capability                         | Phase | File(s)                                     |
| ---------------------------------- | ----- | ------------------------------------------- |
| @opentui/keymap layered bindings   | 1     | `src/tui/keymap.ts`, `src/tui/render.tsx`   |
| Discoverable help overlay (F1)     | 1     | `src/tui/components/HelpOverlay.tsx`        |
| Console overlay toggle (backtick)  | 1+2   | `app.tsx`, `render.tsx`                     |
| Console overlay enabled on darwin  | 2     | `render.tsx`                                |
| GENIE_TUI_KITTY_KEYBOARD opt-in    | 2     | `render.tsx`                                |
| Terminal title from selected agent | 3     | `app.tsx`                                   |
| <select> in pickers                | 4     | `AgentPicker.tsx`, `SpawnTargetPicker.tsx`  |
| <ascii-font> branded loader        | 4     | `Nav.tsx`                                   |
| useTimeline overlay animation      | 5     | `HelpOverlay.tsx`                           |

## What was deliberately not done

- **Wholesale keymap migration of per-modal `useKeyboard`.** Filter
  typing in pickers is character-stream input — keymap's named-command
  model adds complexity without payoff there. Migrated only app-level
  global commands (Ctrl+Q, F1, backtick).
- **Re-enable kitty keyboard / `useThread` on darwin by default.**
  Commits 325f67e5 and 204e638f gate these behind `!isDarwin` because
  of real CPU spin (101%) on macOS local ptys under 0.1.x. We added
  `GENIE_TUI_KITTY_KEYBOARD=1` for opt-in soak testing under 0.2.
  Flipping the default needs a deliberate test on macOS hardware first.
- **`<input>`-driven filter in AgentPicker.** Tried it; the test harness
  (`@opentui/react/test-utils#mockInput`) doesn't flow keys into a
  focused `InputRenderable` synchronously, so filter state never
  advanced in `AgentPicker.test.tsx`. Kept parent useKeyboard.
- **`<markdown>` / `<code>` / `<diff>`.** No surface in the current
  TUI shows long-form text or code; these would need a Tree-sitter
  client setup and a side panel concept that doesn't exist today.
- **OpenTUI plugin slots.** Genie's plugin system (hooks/handlers) is
  a different surface from OpenTUI's slots; introducing a slot now
  would be a placeholder with no consumer.
- **OSC 52 from renderer.** No `src/tui` callsite currently writes to
  the clipboard. The existing `scripts/tmux/osc52-copy.sh` is invoked
  from tmux copy-mode, outside our process — `renderer.copyToClipboardOSC52`
  doesn't apply there.
- **`<tab-select>` HelpOverlay categories.** The binding list is short
  (3 commands today). Tabs would be empty UI.

## Validation

- `bun run typecheck` — clean.
- `bun test src/tui/` — 110 pass, 0 fail.
- `bun run lint` — 0 errors, 16 pre-existing complexity warnings
  unrelated to this branch.
- `bun run check` — 4465 pass, 1 fail. The single failure is
  `doc/code coupling > docs/_internal/state-machine.mdx exists and
  references the four invariants` — pre-existing, fails on plain `dev`
  too because the `.docs-vendor` git submodule isn't initialized in
  this checkout (`git submodule status` shows `-e96348fa…`). Initialize
  with `git submodule update --init --recursive` to get a green check;
  unrelated to this branch.

## Manual smoke checklist (when you wake up)

Run the TUI from a workspace that has at least one tmux session:

```bash
bun run build && genie tui --workspace .
```

1. **F1 opens HelpOverlay** with three rows: `ctrl+q  Quit (app)`,
   `f1  Toggle help overlay (app)`, `\`  Toggle console overlay (app)`.
   The overlay should briefly expand on mount (paddingY ramp).
2. **F1 again closes it.**
3. **Backtick toggles the OpenTUI console overlay.** Try
   `console.error('hi')` somewhere in the boot path or trigger any
   diagnostic error to see it captured.
4. **Ctrl+Q shows quit dialog.** Ctrl+Q again exits.
5. **Spawn-here on a session** (`.` then "Spawn here") — agent picker
   shows a styled `<select>` list. Up/down/enter still work.
6. **Loading state** before diagnostics arrive shows the `GENIE`
   ASCII-font tag.
7. **Terminal tab title** updates to `genie tui — <session-name>` as
   you navigate between agents.
8. **macOS opt-in:** `GENIE_TUI_KITTY_KEYBOARD=1 genie tui` enables
   the kitty keyboard protocol on darwin. Watch for any input regressions
   (delayed escapes, alt+key issues, CPU spin). Report results before
   we consider flipping the default.

## Suggested PR

```
gh pr create --base dev \
  --title "feat(tui): 100% OpenTUI 0.2 native (keymap, console, title, select, animation)" \
  --body-file .genie/wishes/opentui-0.2-deep.status.md
```

## Branch hygiene done

- Dropped redundant local WIP from `nmstx/fix-pgserve-v2-auth` (was
  bit-identical to merged PR #1561).
- Deleted broken untracked `AGENTS.md` (auto-generated dump that
  referenced "Codex" instead of this codebase).
- PR #1556 (`fix/1521-tui-shadow-rows-work-state`) intentionally
  untouched — it's a focused 7-line fix and should land on its own
  rebase, not bundled with the migration.
