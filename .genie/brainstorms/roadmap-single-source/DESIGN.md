# Design: Roadmap single-source — CLI-only board, INDEX retired

| Field | Value |
|-------|-------|
| **Slug** | `roadmap-single-source` |
| **Date** | 2026-07-29 |
| **WRS** | 100/100 |

## Problem

The repo carries two surfaces claiming to describe the roadmap — the `roadmap` board (genie.db, with roadmap.json as its git save-state) and the hand-written `.genie/INDEX.md` whose lifecycle sections mirror the board bullet-for-bullet — and the duplication is real enough to need a drift lint and to have caused a HIGH review finding (caveats existed in three places at once). It matters because every duplicated fact is a maintenance tax and a lying-surface risk, and because the roadmap should be a per-repo Genie contract, not a genie-repo curiosity.

## Scope

### IN
- Delete `.genie/INDEX.md` from the genie repo. Nothing needs redistribution first: caveats already live in wish docs (proven when the G3 fix loop restored them *from* those docs), umbrella threads have their own brainstorm dirs, work order is the Work-lane card order, shipped history is `.genie/wishes/archive/`.
- **Retire INDEX's write path in `genie init`** (`src/term-commands/init.ts`): remove `INDEX_SKELETON`, `scaffoldIndex`, the `InitResult.index` JSON field, the human report line, and the docblock mention. Without this, `legacy-index-present` would warn about a file genie itself just authored.
- Retire the `jar: index-lane drift` doctor check — both the check (`evaluateIndexLaneDrift` + registration in `src/genie-commands/doctor.ts`) and the `indexLane` JSON payload rider — plus its fixtures in `src/genie-commands/doctor.test.ts`.
- **Update the repo gates that assert the INDEX contract:** `tests/e2e/v5-lifecycle.sh` (CI-gated; hard-asserts init creates INDEX.md at :139 and stages it at :145), `src/term-commands/init.test.ts` (10 INDEX assertions across 6 tests, incl. idempotency tests), and `scripts/release-docs.test.ts` (:941-942 — a deliberate release-docs contract edit, not incidental cleanup).
- New warning-level doctor checks: `roadmap-board-missing` (repo has no `roadmap` board), `dangling-slug` (card whose `tasks.wish` resolves to no live brainstorm/wish dir), `orphan-doc` (live, non-archived wish/brainstorm dir with no card), `legacy-index-present` (a `.genie/INDEX.md` exists — unread by tooling, delete when convenient). All warn-only; none flips doctor `ok:false`.
- `genie init` seeds the `roadmap` board (6 lifecycle lanes, zero cards) in every repo it initializes — via the existing `createBoard(db, 'roadmap', DEFAULT_LIFECYCLE_LANES)` primitive; idempotent (second run no-op when the board exists). **This is an acknowledged contract change:** init's docblock currently promises "no database"; it will now create `.genie/genie.db` (see Simplicity Case + Decision 8). No stub front page.
- `genie board --shipped`: a listing generated on demand from `.genie/wishes/archive/` (slug + archived WISH path; the date column comes from the archived WISH.md header's `**Date**` field when parseable, else is omitted). No new persistent state.
- Update the three surfaces that actually reference INDEX.md (verified census — `wish`/`work`/`review`/`wizard` carry zero refs): **brainstorm skill** (11 refs — creates the board card in Idea/Brainstorm lane instead of an INDEX entry; lifecycle transitions move the card; prose goes to DRAFT/WISH/card comments; the Index section and legacy-jar migration are rewritten for the board), **`skills/genie/reference/lifecycle.md:73`**, and **`skills/repo-hygiene/SKILL.md:24`** (currently asserts INDEX.md is git-tracked contract in every genie repo — inverted to the board contract). Sweep residual INDEX-section vocabulary ("Poured entry", "brainstorm jar") in `review`/`dream` prose. Skills never write INDEX anywhere and ignore existing ones. Plugin skill mirrors regenerate through `scripts/sync-plugin-skills.ts --check` (byte-parity gate wired into build/version/fresh-install-smoke).
- **Reconcile the contract documents** to Decision 1's framing (genie.db single source; roadmap.json save-state): `src/lib/v5/roadmap-sync.ts:2` docblock ("canonical board" → save-state), `CLAUDE.md` (:70 state-table row, :123 "CANONICAL roadmap" row, :185 the entire `tasks.wish`/index-lane gotcha bullet), `src/lib/v5/TAXONOMY.md` (:26 tree entry, :101 drift-lint join description), `.genie/repo-profile.md:30`, and the stale comment at `scripts/backfill-roadmap-wish.ts:5-6`.

### OUT
- The outward/public browsing surface — `public-roadmap-polish` owns it; this design makes it the ONLY human browsing surface beyond the CLI, which raises that brainstorm's priority but adds nothing to this wish.
- Any generated markdown roadmap view committed to git (deferred; see Simplicity Case).
- Board schema changes (no description fields, no pinned-comment machinery — a plain card comment is the vehicle for repo-level notes).
- Done-lane backfill of shipped cards (shipped history = archive dir, ratified).
- Auto-migration or deletion of legacy INDEX.md files in other repos (tooling never deletes a file it didn't just author).

## Approach

**CLI-only, no git surface** (Felipe-picked): `genie board` is THE roadmap view; genie.db is the single live store; roadmap.json remains save-state only (import/export at git boundaries via `task sync`, never read directly at runtime); narrative lives per-slug in DRAFT/WISH docs and card timeline comments. The drift lint becomes unnecessary by construction — nothing is left in git that paraphrases board data — and is replaced by referential-integrity warnings that check *linkage* (slug↔dir) rather than *copies*.

Alternatives considered and rejected:
- **Generated ROADMAP.md view** (pre-commit renders the board to markdown): always-current GitHub browsing, but adds renderer machinery and a committed generated file — the exact INDEX-generator the genie-official-roadmap Simplicity Case deferred, still without a present requirement.
- **Thin hand-written front page** (prose-only INDEX): keeps an aggregation point but keeps a second file whose boundary ("no lists ever") must be policed by convention — the failure mode this design exists to end.
- **Docs-first** (front-matter lanes, board derived from docs): inverts the state-in-SQLite taxonomy and turns every lane move into a doc edit plus sync in the reverse direction; rejected as a taxonomy break.

## Simplicity Case

- **Simplest complete design:** delete one file and its write path, delete one lint, update the three gates that assert the old contract, add four warn-only doctor checks, one read-only CLI listing, one init seed step, and skill/doc reconciliation. No new stores, no new sync directions, no schema changes (`boards.lanes`/`tasks.lane` and `createBoard` with the 6 default lanes already exist).
- **Added machinery:** one durable item — `genie init` gains `.genie/genie.db` creation (board seed), a deliberate break of init's current "no database" docblock promise. Justification: ratified Decision 4 wants the board present from init so a fresh clone's `genie board` renders immediately, with no first-use side-effect surprise. The simpler lazy-seed alternative (create the board on first `board`/`task` use) was considered and rejected for that reason (Decision 8). Everything else is non-durable: `board --shipped` recomputes from the filesystem on demand; the doctor checks are pure queries over existing db + tree.
- **Deferred until measured:** a generated in-git roadmap view — trigger: GitHub-blind browsing demonstrably hurting (a contributor or Felipe citing a concrete miss) before `public-roadmap-polish` ships.
- **Complexity removed:** the drift lint + its section↔lane mapping table + its `indexLane` JSON rider, the INDEX scaffold in init, the INDEX write-path in the brainstorm skill, the hand-maintained Shipped section, and the standing question "which of the two surfaces is right?"

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | genie.db is the single source; roadmap.json is save-state only | Felipe correction ratifying existing behavior — nothing reads the json at runtime; designs must not frame it as a second source |
| 2 | CLI-only: delete INDEX.md, no replacement git surface | Felipe pick; zero duplication by construction; browsing gap accepted until public-roadmap-polish |
| 3 | Shipped history = `wishes/archive/`, listings generated on demand | Felipe pick; the directory is already the record; any written list is a copy |
| 4 | Per-repo contract: init seeds the board, doctor warns when missing | Felipe pick; expected everywhere, enforced nowhere — matches warn-only doctor culture |
| 5 | Legacy INDEX in other repos: ignore + doctor warn; never auto-delete | Felipe pick; tooling must not delete hand-written files it didn't author |
| 6 | Drift lint replaced by referential-integrity warns (dangling-slug / orphan-doc) | Copies are gone, linkage remains; integrity of slug↔dir joins is the residual invariant worth checking |
| 7 | No stub front page at init (supersedes the earlier "init seeds + stub page" answer) | Direct consequence of Decision 2 — a seeded page would recreate the surface being removed |
| 8 | Init-seed over lazy-seed for the roadmap board, accepting init's "no database" docblock change | Ratified D4 pick: fresh clone's `genie board` renders immediately; lazy-seed would hide the contract behind first use. The docblock and init tests update to match |

## Risks & Assumptions

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| 1 | GitHub browsing shows no roadmap until public-roadmap-polish ships | Medium | Accepted explicitly; raises that brainstorm's priority; roadmap.json stays humanly skimmable in a pinch |
| 2 | Narrative loses its aggregation point | Low | Per-slug docs + card comments already hold the substance (G3 fix loop proved the copies originated there); `genie board` shows the whole |
| 3 | Skill updates ripple across shared skills and plugin mirrors | Medium | Ride `scripts/sync-plugin-skills.ts --check` — the byte-parity gate wired into build/version/fresh-install-smoke; grep-based criterion catches stragglers |
| 4 | Other repos' flows break if a skill assumed INDEX exists | Medium | Skills go ignore-only (read-tolerance, zero writes); doctor warn signals owners; no hard dependency remains |
| 5 | Deleting INDEX discards just-shipped G3 work | Low | Only the file dies; its durable outputs (caveats in wish docs, board, archive, Shipped facts) survive — INDEX was the copy |
| 6 | Assumption: no runtime path reads **or writes** INDEX.md except the doctor lint (read) and init's scaffold (write) | Low | Both verified at design review (sole reader `checkIndexLaneDrift`, sole writer `scaffoldIndex`); wish plan re-verifies by grep before deletion |
| 7 | **The repo's own gates encode the INDEX contract** — CI e2e (`tests/e2e/v5-lifecycle.sh`), `init.test.ts`, `release-docs.test.ts` all fail on deletion; this is a gate change, not a file removal | Medium | All three enumerated in IN scope; execution validation runs `bun run check` AND `bash tests/e2e/v5-lifecycle.sh` before review |

## Success Criteria

- [ ] `.genie/INDEX.md` absent from the genie repo; `bun run check` green AND `bash tests/e2e/v5-lifecycle.sh` passes with the INDEX assertions replaced by board assertions
- [ ] `genie doctor --json` carries neither the `jar: index-lane drift` check nor the `indexLane` payload key anywhere in its output; reports `roadmap-board-missing`, `dangling-slug`, `orphan-doc`, `legacy-index-present` as warning-level checks, each fixture-backed by tests, none able to flip `ok:false`
- [ ] `genie init` in a fresh tmp repo seeds the `roadmap` board with the 6 lifecycle lanes and zero cards; a second `genie init` run is a no-op (board untouched); `genie init --json` carries no `index` field
- [ ] `genie board --shipped` output lists exactly the set of directories under `.genie/wishes/archive/` (one row per dir), with a date only where the archived WISH.md header `**Date**` parses
- [ ] `grep -rn "INDEX.md" skills/` shows zero write-path references (explicitly legacy-guarded read-tolerance allowed); `grep -rn "INDEX.md" src/ scripts/ tests/` shows zero references outside the `legacy-index-present` check and its tests
- [ ] Duplication audit is a named executable check: `grep -rlE "^## (Raw|Simmering|Ready|Poured)$" .genie/ --include="*.md"` returns no files, and `grep -rln "wishes/archive/" .genie/*.md` (top-level files only) returns none — no top-level authored file enumerates cards or shipped wishes

## Next Step

After an independent design review returns SHIP, persist the evidence below and verify its content digest before running `wish`.

<!-- genie-design-review:start -->
## Design Review Evidence

- **Verdict:** SHIP
- **Reviewed content SHA-256:** `a891526b6609fcc415149ad407bbebb322ced7b34c21326686cb84f7c8644267`
- **Reviewer:** reviewer-subagent-opus
- **Reviewed at:** 2026-07-29T03:17:16.000Z
<!-- genie-design-review:end -->
