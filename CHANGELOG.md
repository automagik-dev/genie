# Changelog

## v0.260209.1458 (2026-02-09)

### 🚀 Features

#### Brainstorm Skill Upgrade — design.md Handoff (#23)
- Brainstorm sessions now produce a structured `design.md` artifact
- New design template in `skills/brainstorm/references/design-template.md`
- Phase 6 restructured: decision options (A/B/C) evaluated before write steps
- Trivial ideas can skip the handoff step
- Smooth pipeline: `/brainstorm` → `design.md` → `/wish`

#### Active Window/Pane Resolution (#24)
- `term` commands now target the **active** tmux window and pane by default (not just the first)
- `target-resolver.ts` uses `windows.find(w => w.active)` and `panes.find(p => p.active)` patterns
- `orchestrate.ts` updated with shared `findActivePane()` helper
- Crash fix: missing null checks that could blow up when no active pane exists
- 74+ lines of new tests for active pane resolution

#### Hooks v2 — Pure Node.js Session Awareness (#25)
- All hook scripts migrated from Bun to **pure Node.js** (`.cjs` format)
- Eliminates Bun dependency for Claude Code plugin hooks
- New `session-context.cjs` hook for session awareness
- `validate-completion.ts` and `validate-wish.ts` rewritten with better error handling
- Build script updated to handle Node.js CJS compilation
- Node 18+ compatible

#### Pane Orchestration v2 — Window-per-Worker Model (#26)
- Workers now track their `windowId` (e.g., `@4`) in the registry
- `term work` records `windowId` + `windowName` on worker creation
- `resolveTarget("@4")` resolves window IDs to worker panes
- `term close` and `term kill` use `windowId` for reliable cleanup — no more orphan windows
- JSDoc improvements and fallback error handling in kill paths
- 88+ lines of new worker-registry tests, 85+ lines of target-resolver tests

### 📊 Stats
- **31 files changed**, **+1,728 lines**, **-368 lines**
- 4 new wish documents in `.genie/wishes/`
- 3 new test suites (247+ test lines)
- 1 new design template
