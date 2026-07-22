# Brainstorm: genie-boards-ui — the boards module of genie desktop

**Started:** 2026-07-21 · **WRS:** 70/100 (Problem ✅ Scope ✅ Decisions ◐ Risks ✅ Criteria ░)

## Felipe's round-2 input (2026-07-21, picker notes)

- Layout: "that looks good" on the Tab + split-toggle hybrid (treating as tentatively locked; confirm on crystallize).
- **G4 relation: ABSORB — decided.** One kanban language; G4's lane becomes the Roadmap board entry; the boards module owns every board surface.
- New requirement — **ARCHIVE**: "things get messy" — boards/wishes need an archived section (dash already has task-archiving upstream: same pattern, archive + restore).
- New requirement — **.genie commit configurability**: option to commit wishes (auto-switches .gitignore); "not something everybody likes" — .genie assets committable-or-not per project via simple checkboxes in project settings, riding the existing deep git integration.
- Open question back to me (opinion requested): roadmap managed by Claude — "it's just another project, right? :)" vs each project has its macro roadmap board under Boards.

## Problem

Genie now has first-class boards (PR #2611 merged: CLI-creatable boards, lanes mirroring the genie lifecycle, cards carrying claim/session-alive/blocked/stage-log truth), but genie desktop has no surface for them — Felipe wants boards as the UI's first real module: a left-menu item, a disposable per-wish board tab-adjacent to the wish's agent terminals ("live action"), and an optional project/roadmap board.

## Felipe's seeds (his words)

1. Every wish has a **disposable board**; tab-switch between terminals (claude code etc.) and the board "to see some live action".
2. **Project concept** — option of a project board for roadmap purposes "like we have in genie".
3. Doesn't know yet how to make it look great — the ask is UX ideas.

## Ground facts

- PR #2611 (genie, MERGED): board engine — `genie board` first-class, lifecycle lanes, truthful cards (claimed_by, session alive, blocked reason, what happened).
- genie-ui-dash G4 (in flight right now): baseline kanban lane — wishes-as-cards by durable status, sidebar entry, all state via `genie ui-bridge` (protocol 1.0), push-refresh on `notifications/genie/changed`.
- Bridge tools may need an additive extension (protocol 1.1) to carry the full first-class board payload (lanes, card truth fields, custom-board list) — cross-wish dependency.
- UI stack: dash's React + sidebar + stores + xterm tabs; the shell-drawer pattern (configurable position) already exists upstream; 16 themes → all visuals must ride theme tokens.

## Design tensions (mapped)

(a) relationship to G4's kanban — absorb vs coexist; (b) disposable lifecycle — the VIEW is disposable, board state lives server-side in genie.db; created at wish-open vs on-demand; (c) tab peer vs split pane vs drawer; (d) what moves in "live action" (claims, lane transitions, session-alive pulses, stage-log ticker) and how much animation before it's noise; (e) roadmap = auto per-repo lifecycle board vs CLI-created custom boards in the menu; (f) left-menu IA: Boards as top-level list (roadmap + wish boards + custom) vs board-as-view-inside-wish.

## Candidate UX concepts (to be picked via mockups)

- **A — Mission-Control tab:** board is a pinned first tab peer (`⚡ Board | fable | codex | …`) in every wish workspace; agent chips on cards jump to that agent's terminal tab; activity ticker strip at bottom.
- **B — Split cockpit:** board docked as a side pane next to the live terminal (reuses dash's drawer pattern) — cards move while you watch the agent type; toggle key.
- **C — Boards as places:** Boards is a full left-menu destination (board browser → full-screen kanban); cards deep-link into wish workspaces; terminals and boards are separate places.

Leaning: A as base (matches Felipe's tab instinct) with B's split available as a toggle since dash's drawer pattern makes it cheap — but this is Felipe's call, presented with mockups.

## Open questions (blocking Scope/Decisions/Criteria)

1. Layout concept: A / B / C (or A+B hybrid).
2. G4 relationship: boards module ABSORBS the G4 kanban surface (G4's lane becomes the Roadmap board; one kanban language) vs coexist as light-status + deep-board.
3. Disposable lifecycle: board tab auto-exists with the wish workspace and dies with it (state persists server-side) vs on-demand "+ Board".
4. Roadmap board content: auto lifecycle board per repo + CLI-created custom boards listed in the menu?

## Risks

- Two competing kanban surfaces (G4 lane + boards module) would confuse — the relationship decision is load-bearing.
- Bridge protocol addition (1.1) must stay additive; UI must degrade gracefully against a 1.0-only genie.
- Live-action animation across 16 themes: must use dash theme tokens, single subtle transition (~200ms), no noise.
- G5 (hire) will add actions to wish cards — boards module must leave that seam open, not collide with it.
