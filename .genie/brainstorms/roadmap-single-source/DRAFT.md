# Brainstorm: roadmap-single-source — one source of truth, roadmap as per-repo contract

**Status:** RAW · **Date:** 2026-07-28 · **Seeded from:** genie-official-roadmap execution + Felipe's dissatisfaction with the INDEX↔board duplication

```
WRS: ██████████ 100/100
 Problem ✅ | Scope ✅ | Decisions ✅ | Risks ✅ | Criteria ✅
```

**Crystallized 2026-07-29 → [DESIGN.md](DESIGN.md).**

## Direction (Felipe-picked): CLI-only, no git surface

`genie board` is THE roadmap view. `.genie/INDEX.md` is **deleted** and nothing replaces it in git; `roadmap.json` stays as save-state only. Narrative lives where it already has a home: each slug's DRAFT/WISH docs and card timeline comments. Repo-level prose (focus, rationale) gets a pinned card comment or nowhere — accepted cost until `public-roadmap-polish` ships the browsing surface.

## Scope

### IN
- Delete `.genie/INDEX.md` from the genie repo; redistribute nothing that already exists elsewhere (caveats live in wish docs — proven by the G3 fix loop; umbrella threads live in their own brainstorm dirs; work order IS the Work-lane card order).
- Retire the `jar: index-lane drift` doctor check; replace with referential-integrity checks: **dangling slug** (card whose `tasks.wish` resolves to no live brainstorm/wish dir) and **orphan doc** (live wish/brainstorm dir with no card) — both warning-level.
- New doctor warning: repo has no `roadmap` board (expected everywhere, enforced nowhere).
- `genie init` seeds the `roadmap` board (6 lanes, empty). NO stub front page (superseded by the CLI-only pick).
- `genie board --shipped`: generated listing from `wishes/archive/` (name + archived WISH link/date). No stored state.
- Update genie skills (brainstorm, wish, work, review, genie router) to stop reading/writing INDEX.md: brainstorm creates the card (Idea/Brainstorm lane) instead of an INDEX entry; lifecycle transitions move the card; prose goes to DRAFT/WISH/card comments.

### OUT
- The public/outward surface (public-roadmap-polish owns it; this wish makes it the ONLY browsing surface, raising its priority).
- Any generated markdown view in git (deferred behind a measurable trigger: if GitHub-blind browsing demonstrably hurts before the public page ships, revisit).
- Board schema changes (no description fields, no pinned-comment machinery — a plain card comment suffices).
- Done-lane backfill (shipped history = archive dir, per the settled pick).

## Risks

| Risk | Mitigation |
|---|---|
| GitHub browsing shows no roadmap until public-roadmap-polish ships | Accepted explicitly by Felipe; raises that brainstorm's priority; roadmap.json remains humanly skimmable in a pinch |
| Narrative loses its aggregation point (INDEX told one story) | Story per slug in its docs; `genie board` shows the whole; anything truly repo-level goes in a card comment |
| Skills are shared across repos — other repos still carry INDEX.md | Skills stop WRITING INDEX everywhere; legacy INDEX files are tolerated read-only, never required (open decision below) |
| Plugin skill mirrors must regenerate (parity gates) | Ride the existing hook-bundle/skill parity machinery; it's a gate, not new work |
| Deleting INDEX throws away just-shipped G3 work | Only the file dies; the durable outputs (caveats in wish docs, board, archive) survive — INDEX was always the copy |

## Criteria (testable)

- [ ] `.genie/INDEX.md` absent from the genie repo; `bun run check` green with the drift lint removed
- [ ] `genie doctor --json` has no `indexLane` check; has `roadmap-board-missing` (warn), `dangling-slug` (warn), `orphan-doc` (warn) — each with a fixture-backed test
- [ ] `genie init` in a fresh tmp repo seeds the `roadmap` board with the 6 lifecycle lanes, zero cards
- [ ] `genie board --shipped` lists exactly the contents of `wishes/archive/` with zero stored state
- [ ] `grep -r "INDEX.md" skills/` → zero write-path references (read-tolerance allowed where explicitly legacy-guarded)
- [ ] Duplication audit: no roadmap fact (card set, lanes, order, shipped set) exists in more than one authored place

## Legacy INDEX decision (Felipe-settled 2026-07-29)

**Ignore + doctor warn.** Skills never write INDEX anywhere and ignore existing ones; `genie doctor` warns "legacy .genie/INDEX.md present — roadmap lives on the board; delete when convenient". No file is ever deleted by tooling; the genie repo deletes its own INDEX.md as part of this wish.

## Settled (Felipe, 2026-07-28/29)

- **Data model clarified (Felipe correction):** SQLite (`genie.db`) is the single live store; `roadmap.json` is *save-state only* — import/export at git boundaries via `task sync`, never read directly at runtime. Any design that frames the json as "the roadmap" is wrong; the json is the serialization of the board, not a second source.
- **Shipped history: the archive dir IS the record.** No hand-curated Shipped section anywhere; listings are generated on demand (`genie board --shipped` reading `wishes/archive/`, and later the public page). Per-wish story stays in its archived WISH.md.
- **Per-repo contract: init seeds, doctor warns.** `genie init` always seeds the roadmap board (6 lanes, empty) + minimal front page; `genie doctor` warns (never `ok:false`) when a repo lacks the board. Expected everywhere, enforced nowhere.

## Problem

After genie-official-roadmap shipped, the repo has TWO surfaces claiming to describe the roadmap: the `roadmap` board (genie.db ↔ roadmap.json, canonical state) and `.genie/INDEX.md` (hand-written prose whose lifecycle sections mirror the board bullet-for-bullet). The overlap is real duplication — policed by a drift lint that exists only because the duplication exists. Worse, the G3 fix loop proved caveats were ALSO duplicated (restored *from archived WISH docs* — they already lived there). Felipe wants: **no data duplication**, and **every repository is expected to have a roadmap** (board as contract, not genie-repo special case).

## Duplication census (what says the same thing twice today)

| Fact | Copy 1 | Copy 2 |
|---|---|---|
| Card set + lanes | board (roadmap.json) | INDEX lifecycle bullets (drift-linted) |
| Open-action caveats | wish/brainstorm docs | INDEX bullet clauses |
| Card-scoped notes (ritual six) | card timeline comment | INDEX "Open rituals" paragraph |
| Shipped set | `wishes/archive/` dir | INDEX Shipped section (29 hand-copied lines) |
| Work order | board Work-lane order | INDEX prose (D4 sentence) |

## Candidate directions (none ratified — Felipe unhappy with the initial pitch details)

- **A — Board-only, INDEX dies.** All narrative moves to card comments + wish/brainstorm docs. A *generated* view (ROADMAP.md or rendered page) serves GitHub browsing. Cost: generated-file machinery in git; card comments become a writing surface.
- **B — Thin hand-written front page.** Board is the sole enumeration; INDEX shrinks to prose only (focus, rationale, pointers). No per-card bullets ever. Cost: still two files; the "what remains hand-written" boundary needs policing.
- **C — Docs-first.** Cards carry only slug+lane; everything narrative lives in the slug's dir; maybe front-matter feeds the board. Cost: inverts the state-in-SQLite taxonomy; lane changes become doc edits.

## Open questions (blocking Decisions)

1. What exactly made the initial pitch unsatisfying — the surviving hand-written file? the generated-view cost? shipped-history handling? something else?
2. Single source: board-only (A), thin page (B), docs-first (C), or a hybrid not yet named?
3. Shipped history: archive dir as sole record (generated listing)? Done lane holds shipped cards? hand-curated prose?
4. Per-repo contract: does `genie init` seed the board in EVERY repo? Does `genie doctor` fail or warn when a repo has no roadmap board? What's the minimum a non-genie-developed repo carries?
5. Where do human-only caveats live so they are written once (card comment vs wish doc vs front page)?
6. Migration: what happens to the just-rewritten INDEX.md (and the drift lint) under the chosen direction?

## Constraints / prior art

- Taxonomy contract (`src/lib/v5/TAXONOMY.md`): docs in git, state in SQLite. roadmap.json is the canonical committed snapshot; three-way `task sync` via git hooks.
- Doctor `jar: index-lane drift` lint is warning-level, joins INDEX first-links to `tasks.wish` slugs.
- `public-roadmap-polish` (Raw) owns the OUTWARD surface; this brainstorm is the inward single-source contract — likely `blocks`/feeds it.
- Simplicity Gate note: an INDEX generator was deliberately deferred by genie-official-roadmap's Simplicity Case; direction A would have to pay for it with a present requirement.
