# Design: Roadmap truth — the board moves because the wish moved

| Field | Value |
|-------|-------|
| **Slug** | `roadmap-truth` |
| **Date** | 2026-08-04 |
| **WRS** | 100/100 |
| **Revision** | 4 — rounds 1-3 FIX-FIRST (7 HIGH, 3 HIGH, 1 HIGH), round 4 **SHIP** with 8 LOW; revision 4 applies all 8 |

## Problem

remotty's roadmap board freezes at whatever lane its cards were seeded in while
the work underneath it ships, because the lane only changes when a human
remembers to run `genie task move` — and nobody ever does. Measured on this repo
2026-08-04: **all 17 cards sat in `Idea`, 7 of them with `status: done`**, and
**`wish` was `null` on 17 of 17**, so nothing could have moved them
automatically either. The board is the app's only "what is going on" surface for
a project, and it has been lying since the day it was seeded.

One smaller lie was found while measuring, and it is part of the same problem: a
wish reading `MERGED` is bucketed `.other` and drawn under **Idea in the sidebar
today**, so `agent-parity` — merged and released — is misfiled right now.

## What review round 1 changed

Round 1 returned **FIX-FIRST**. The central bet — genie syncs, remotty reads —
survived; almost everything around it did not. Recorded here because the
corrections are the substance of this revision.

> ⚠️ **Two answers in this table were themselves overturned by later rounds**
> and are marked **SUPERSEDED** inline (round 3's L6). Read to the end of the
> round-3 section before treating any row here as current.

| Finding | Correction |
|---|---|
| The card↔wish join rendering **already ships** in both clients (`BoardPane.swift:173,239-303`; `linux/renderer/js/board.js:56-83`), including the eyebrow, the criteria hairline and an `.orphanWish` state. The fixture already carries a wish-bearing card. | Removed from IN. Four success criteria were passing vacuously. The real remotty delta is two bugs and the contract, not new rendering. |
| `draft → Brainstorm` is unsatisfiable: `WishLane` has **five** lanes and no Brainstorm (`WishRows.swift:109-112,165`). | The lane table is now *derived from* `Wish.StatusCategory`, and `WishLane` gains `.brainstorm` so both surfaces can express six lanes. — **SUPERSEDED by round 2 (F6/F7/F9): `.brainstorm` is dropped; `.draft` maps to Idea and `WishLane` is untouched.** |
| `MERGED` matches no prefix in `Wish.StatusCategory` (`FleetSnapshot.swift:592-609`) → `.other` → Idea. | Promoted from a mapping detail to a **named live bug this wish fixes**. |
| `WAVE` was cited as junk; it is parsed as `.active` (`:603`). So are `IN` and `SHIP-`. Only `G` is genuinely `.other`. | Criterion 4 now uses `G`. |
| Decision 4 (blocked badge from `wishes[].statusCategory`) cannot fire — no wish in this repo has a `BLOCK`/`ON-HOLD` prefix, and `card.isBlocked` tests `status == "blocked"` which genie never emits (`FleetSnapshot.swift:691`). | Decision 4 **withdrawn** and replaced: genie must expose the block it already holds. — **SUPERSEDED by rounds 2 and 3: the badge is OUT entirely. genie already has a blocked card status the clients render; the blocker is that its enforced block conflates work-blocks with administrative markers.** |
| A card naming a wish with no `WISH.md` is a **third** population the invariant ignored — and this design's own card is one. remotty already models it (`wishExists(in:)` at `FleetSnapshot.swift:702`). | Third population made explicit, and it is what keeps the Brainstorm lane working. |
| `--wish` exists **only on `genie task create`**; a hand-owned card can never become sync-owned without being destroyed and recreated. | New genie verb added to scope. |

## What review round 2 changed

Round 2 returned **FIX-FIRST** with three surviving HIGH. Revision 3 answers all
three by **removing scope**, not by adding specification — in each case the
mechanism could not be made correct from anything that exists today:

| Finding | Correction |
|---|---|
| **F2 (HIGH)** — wiring `isBlocked` to genie's block would badge `terminal-splits`, which is not blocked. | **The blocked badge is dropped from this wish** and moved to OUT. ⚠️ **Revision 3's stated rationale was itself wrong; round 3's HIGH-1 corrected it — see below.** |
| **F4 (HIGH)** — the new blocked field could never reach either client: `scanners/extras.sh:186` emits `@@CARD` with exactly eight fields and `bin/remotty:540` decodes eight, and CLAUDE.md makes `bin/remotty` the whole engine. Scope named neither. | **Dissolved.** No new card field, so no engine change — and round 3 showed no ninth field was ever needed for a badge either. |
| **F1 (HIGH)** — `agent-svg-icons` was called an orphan in the evidence table and sync-owned in Criterion 6. It has a `WISH.md` (`DRAFT`), so it is **sync-owned**; only `roadmap-truth` is an orphan. The count was 2; it is 1. | Corrected throughout. |
| **F6/F7/F9 (MED/LOW)** — adding `.brainstorm` to `WishLane` is far larger than represented: **93** fixture rows are `DRAFT`/`ROADMAP` and would leave Idea for a new uncapped section; `WishRowsTests.swift:67` asserts `WishLane.allCases == [.work, .review, .wish, .idea, .done]` exactly; `labels.js:284-303` indexes `WISH_LANES` **positionally**; and the board column dot changes in both clients. | **`.brainstorm` is dropped.** The sync maps `.draft → Idea`, matching the shipped five-lane `WishLane` exactly. Board and sidebar agree with **no** `WishLane` change, and the Brainstorm lane becomes hand-owned/orphan-only — which is the better semantic anyway: *a design exists, no wish yet*. |
| **F3 (MED)** — "genie holds the truth twice over" was half-unverifiable; the second source does not exist. | Withdrawn with the badge. |
| **F5 (MED)** — Criteria 4 and 6 contradict: a sync-owned `.other` card is untouched on the board but forced to `.idea` in the sidebar. | Criteria 1 and 6 now exclude `.other` explicitly and say why. |
| **F10/F11 (LOW)** — Criteria 3 and 7 both act on `wish-scope`; Criterion 2 would write six false statuses into a real `WISH.md`. | Criteria 3, 6 and 7 are explicitly sequenced; Criterion 2 uses a throwaway wish on a throwaway board. |

## What review round 3 changed

Round 3 returned **FIX-FIRST** with one HIGH, and it found revision 3 committing
the very error revision 3 was correcting: **merging two populations to reach a
conclusion**, which was round 2's F1 failure mode.

**HIGH-1 — the blocked-badge rationale was false in every particular.** Verified
against live state:

- Of the four `blocked_by` markers, only **two are on the board**. The two
  reading *"Superseded: plan review renumbered groups"* sit on **boardless**
  tasks that merely share the `terminal-splits` slug — `genie task status` shows
  them with no `Board:` line, and `scanners/extras.sh:182-184` drops any card
  whose `boardId` is null, a rule `scripts/scanner-test.sh:194-195` pins. They
  reach no client at all. The honest on-board tally is **1 true positive**
  (`app-auto-update`, *"blocked per WISH.md"*) and **1 false positive**
  (`terminal-splits`, *"Not a work item… Do not claim"*), not "2 of 2" and not
  "four different things on this board alone".
- *"`card.status` is never `blocked` … genie never emits it"* contradicts
  remotty's own contract. `blocked` is in the card-status vocabulary at
  `docs/state-json.md:363-365`, `scripts/sanitize-fixture.mjs:46`
  (`CARD_STATUSES`) and `scripts/leak-scan.sh:422`.
- **The recorded trigger was wrong and expensive.** It said a future badge means
  "the engine gains a ninth `@@CARD` column". It does not. `card.status`
  already rides in the existing eight fields and both clients already draw the
  badge from it (`FleetSnapshot.swift:691`, `BoardPane.swift:303-305`,
  `board.js:83`). If genie set `card.status = "blocked"`, the badge would ship
  with **zero** engine and **zero** client change — cheaper than the `MERGED`
  fix that is already IN. The old trigger would have sent a future wish to
  modify `bin/remotty` and `scanners/extras.sh` for no reason.

**Re-decided on the corrected facts**, as round 3 required. The badge stays OUT,
but for the one reason that survives: genie's enforced block **conflates blocked
work with administrative markers**, and that conflation is real — it is what
puts a marker on `terminal-splits`. What changes is the trigger, which is now
nearly free and correctly located. See Decision 4 and the OUT bullet.

## What review round 4 changed

Round 4 returned **SHIP** — no HIGH or MED survived — with eight LOW carried as
cleanup. All eight are applied in revision 4: the round-2 table restored (it had
been split in half by the round-3 heading), the revision header and risk
numbering corrected, "four lanes" corrected to three, Criterion 5's misattributed
parenthetical fixed and its untestable half removed, Criterion 2's board-
resolution rule quoted in full, the probe wish's deletion made explicit before
fixture capture, Criterion 13 given a seeded divergence so it cannot pass
vacuously, and Criterion 1 given the same `.other` exclusion Criterion 6 carries.

## Scope

### IN

**genie** (`~/prod/genie`)
- Reconcile the lane of every **sync-owned** card from its wish's `WISH.md`
  status on read, through the bucketing specified below.
- A verb to set `--wish` on an existing card, so a backlog idea can become a
  wish card without losing its id and timeline. `--wish` is create-only today.

**remotty, both clients**
- `Wish.StatusCategory`: recognise `MERGED`. It is `.other` today, so
  `agent-parity` — merged and released — draws under **Idea** in the sidebar.
  Fixed identically in `FleetSnapshot.swift:592-609` and
  `linux/shared/decode.js:218-226`, which are deliberate twins. Round 2
  confirmed the blast radius is exactly one row: `MERGED` appears nowhere in
  `app/`, `linux/`, `docs/`, `bin/` or `scripts/`, no test or fixture pins the
  current bucketing, and `statusCategory` has exactly two consumers
  (`WishRows.swift:220-221`, `labels.js:324-325`).
- Contract: `docs/state-json.md` and the regenerated fixture, in the same
  commit — plus the **seven other places** that currently assert `wish` is
  effectively always null (see Risk 5).

**No engine change.** `scanners/extras.sh:186` and `bin/remotty:540` stay at
their eight `@@CARD` fields. Revision 2 needed a ninth for the blocked badge;
revision 3 drops the badge, so the engine is untouched.

### OUT

- **Any write to genie state from remotty.** No drag, no lane menu, no
  ui-bridge write channel. Decision 1 removes the need; the `bridge-channel`
  DEMAND-GATED card and genie-board's "Board write actions" deferral stay
  parked.
- **New card↔wish rendering.** It ships already. This wish changes what feeds
  it, not what draws it.
- **The blocked badge, and any new `WishLane` case.** Both were IN at revision 2
  and are removed by round 2's findings, not deferred for taste:
  - *Blocked badge* — **not because it is expensive; because genie's block does
    not mean one thing.** The rendering path is already complete and free:
    `blocked` is a contract-blessed card status (`docs/state-json.md:363-365`,
    `sanitize-fixture.mjs:46`), `FleetSnapshot.swift:691` reads it, and
    `BoardPane.swift:303-305` / `board.js:83` draw the badge. The blocker is
    semantic: genie's enforced block carries both real work-blocks
    (`app-auto-update` — *"blocked per WISH.md"*) and administrative markers
    (`terminal-splits` — *"Not a work item… Do not claim"*), 1 of each on this
    board. Wiring the badge today would light a card that is not blocked.
    **Trigger:** genie distinguishes *blocked work* from *administrative
    marker* and sets `card.status = "blocked"` for the former only — at which
    point the badge ships with **no** remotty change at all, in either client
    or the engine.
  - *`WishLane.brainstorm`* — 93 of the fixture's wish rows are
    `DRAFT`/`ROADMAP` and would move out of Idea into a new uncapped section;
    two shipped tests pin `allCases` and `isInFlight` exactly; `labels.js`
    indexes the lane array positionally. The sync maps `.draft → Idea` instead,
    which needs no client change at all. **Trigger:** the Brainstorm lane
    earns automatic occupants — i.e. something in the scraped status
    distinguishes a brainstorm from any other draft, which is the exact reason
    `WishRows.swift:107-113` gave for omitting the lane in the first place.
- **Tag at spawn and everything it unlocks** — the wish↔session link, agents
  nested under wishes, per-wish right panes, card→terminal click. That is wish
  2, `wish-scope`. The click needs an orchestrator attribution that does not
  exist; inventing one is worse than omitting it, which is the rule
  `WishRows.swift:9-11` already applies to the sidebar agent icon.
- **Card telemetry** (`$` / tokens / elapsed heat rules). No trace source;
  `StatsPane`'s "no fabricated data, ever" stands.
- **Agent attribution from `claimedBy`.** `null` on every card. Faking a
  `genie task checkout` to populate it was declined during the cleanup.
- **Committing `.genie/` or introducing `.genie/roadmap.json`.** Risk 2.
- **A lane derived by remotty at render time.** Forbidden by genie-board
  Decision 10, not reopened.

## Approach

**The lane becomes a function of the wish, computed by genie, read by remotty.**

Three populations, one rule each — the third is what round 1 found missing:

| Population | Test | Owner |
|---|---|---|
| **Sync-owned** | `card.wish` names a wish with a `WISH.md` on disk | the sync; lane reconciled on every read |
| **Hand-owned** | `card.wish` is null | a human; never touched |
| **Orphan** | `card.wish` names a wish with **no** `WISH.md` | a human; never touched |

The orphan row is not a loose end — it is load-bearing. A brainstorm has a card
but no `WISH.md` yet, so it is an orphan, so it stays wherever a human filed it,
and it becomes sync-owned the moment its wish is written. This design's own
card, `t_msf0n8kq2e758ad0`, is exactly that case — **the only orphan on the
board** — and remotty already draws it correctly with a dimmed eyebrow
(`FleetSnapshot.swift:702`, `BoardPane.swift:286-288`, `board.js:79-81`).

Round 2's F1 corrected a misclassification here: `agent-svg-icons` has a
`WISH.md` (`DRAFT`), so it is **sync-owned**, not an orphan, and the sync will
move it from Brainstorm to Idea on first run. That move is correct, and it is
the visible proof the sync is running.

### Status → lane

**Derived from `Wish.StatusCategory`, not invented alongside it.** Rounds 1 and
2 both killed lane tables that disagreed with the shipped bucketing. The
bucketing is the specification; the lane is a rename of the bucket, and the
table below requires **no change to `WishLane` at all**:

| `Wish.StatusCategory` | Board lane | Sidebar `WishLane` (unchanged) | Agree? |
|---|---|---|---|
| `.draft` | Idea | `.idea` | ✓ |
| `.ready` | Wish | `.wish` | ✓ |
| `.active` | Work | `.work` | ✓ |
| `.blocked` | Work | `.work` | ✓ |
| `.review` | Review | `.review` | ✓ |
| `.done` | Done | `.done` | ✓ |
| `.other` | **untouched** — never invent a lane from a status nobody parsed | `.idea` | **exempt** — see below |

`MERGED` joining `.done` is part of this wish; without it `agent-parity` sits in
`.other` and Success Criterion 6 fails on a card that exists today.

**The `.other` exemption** (round 2's F5). An unparseable status leaves the
board lane untouched while the sidebar still resolves it to `.idea`, so the two
*can* disagree — that is the price of Decision 3, and it is the right price: the
alternative is inventing a board lane from a status like `G`. Criterion 6
therefore excludes `.other` and says so, rather than asserting an agreement that
is false by construction.

The **Brainstorm lane** takes no automatic occupants. It holds hand-owned and
orphan cards — *a design exists, no wish yet* — which is a cleaner meaning than
"draft wish" and costs nothing: no new lane, no new case, no test churn.

**Reconcile on read**, not on a hook or a daemon — no scheduler, no new process,
no discipline, and remotty's probe already calls `genie board --json` on every
refresh, so truth arrives without a new transport.

### Alternatives considered and why they lost

| Alternative | Why it lost |
|---|---|
| **remotty writes on a drag**, via the ui-bridge channel | Makes moving a card cheaper; does not make it happen. Manual movement is precisely what failed for the board's entire life. Opens a write path genie-board deliberately closed, for a problem the sync solves without one. |
| **Both — auto-sync plus manual override** | Two write paths and a conflict rule. The hand-owned and orphan populations already sit outside the sync's reach, which is what an override would have been for. Deferred with a trigger. |
| **remotty derives the lane at render** | Forbidden by genie-board Decision 10, which deleted exactly this. Would also put a second bucketing in a second language. |
| **Roadmap = `wishes[]`, cards demoted to backlog** | Rejected by the user: the board is deliberately one card per wish, with genie's filtering keeping task cards off it. `wish: null` was a defect in seeded data, and the cleanup proved it by fixing the data. |
| **Keep the previous lane table and add Brainstorm to genie only** | Round 1's H1: board and sidebar would disagree forever on every draft wish. Deriving both from one bucketing is what makes Criterion 6 satisfiable at all. |
| **Add `.brainstorm` to `WishLane` so both surfaces have six lanes** (revision 2's answer) | Round 2's F6/F7/F9. It moves 93 fixture rows out of Idea into an uncapped section, breaks two shipped tests that pin `allCases` and `isInFlight` exactly, and shifts `labels.js`'s positional indices. Mapping `.draft → Idea` achieves the same agreement with zero client change. |
| **Render the blocked badge from genie's `blocked_by`** (revision 2's answer) | Round 2's F2. `blocked_by` conflates a real work-block with a "do not claim" marker; on this board it is 1 of each, so the badge would light `terminal-splits`, which is not blocked. Round 3 HIGH-1 established the cost was never the objection — the badge is free to render — so the trigger is now the semantic fix in genie, not an engine column. |

## Simplicity Case

- **Simplest complete design:** one field on the card (`wish`), one
  reconciliation on read, three ownership rules, and one bucketing shared by
  three renderers. remotty gains no new transport, process, write direction,
  persistence, lane, or card field — and the engine is untouched.
- **Added machinery:** the reconciliation, paid for by a measured failure —
  7 shipped items rendered as ideas and 17 of 17 cards unlinked, on the only
  "what is going on" surface the app has. One new genie verb, paid for by round
  1's H5: without it the normal lifecycle (backlog idea → wish) cannot be
  represented without destroying the card and its timeline. Nothing else.
- **Machinery removed at revision 3**, because review proved it could not be
  built correctly from what exists: the blocked card field (no honest source),
  the ninth `@@CARD` engine column that field required, and
  `WishLane.brainstorm` (93 rows of churn and two broken tests to express what
  `.draft → Idea` expresses for free). Each is OUT with a stated trigger rather
  than half-built.
- **Deferred until measured:**
  - *Manual lane override from the app.* Trigger: a sync-owned card needs a lane
    its status cannot express, twice — and Criterion 9's revert log is what
    counts it, since round 1 correctly noted the old trigger had no detector.
  - *Caching `genie board --json`.* genie-board's trigger stands unchanged
    (probe wall-clock past 3 s with ≥5 boards). Criterion 8 measures it rather
    than assuming, because this wish adds `WISH.md` reads and a write to a call
    that runs per project per 60 s refresh.
  - *`.genie/roadmap.json` as the canonical roadmap.* Trigger: the roadmap must
    exist for more than this machine — a second contributor, a second machine,
    or a backup requirement.
  - *Card telemetry and `claimedBy` attribution.* Trigger unchanged from
    genie-board: a non-null `claimedBy` or a session-trace source. Wish 2's
    tag-at-spawn is the candidate source.
- **Complexity removed:** no ui-bridge write channel; no drag-and-drop; no
  conflict-resolution rule; no pin/lock flag; no scheduler, hook or daemon; no
  new durable state — the lane stays genie's single stored copy.
  **Honestly stated, per round 1's L4:** the first four are alternatives
  *declined*, not complexity removed, and the bucketing genie-board deleted from
  remotty now exists one repo over. What this design removes is a *second*
  bucketing: genie's is specified as a rename of `Wish.StatusCategory`, so there
  is one source of meaning across three implementations rather than two.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | **genie auto-syncs the lane from wish status; remotty never writes.** | User call 2026-08-04. Making a manual move cheaper does not fix a board that fails because nobody moves it. genie-board Decision 10 survives literally — genie reports the lane, remotty reads it. Round 1 confirmed this is not the rejected derivation in a new hat. |
| 2 | **Three populations: sync-owned, hand-owned, orphan.** | Round 1 H4. The orphan row is what lets a brainstorm card sit in Brainstorm before its wish exists, and remotty already models and draws it. |
| 3 | **An unparseable status leaves the card where it is.** | `wishes[].status` is free text — 31 distinct values in one snapshot. A card parked in a stale lane is honest; one filed from `G` is a lie. Same principle `Wish.StatusCategory` and `StatsPane` already enforce. |
| 4 | **The blocked badge is out of scope — because genie's block is ambiguous, not because rendering it is costly.** | Round 1 H7 killed the `wishes[].statusCategory` source: no wish here carries a `BLOCK` prefix. Round 2 F2 killed the `blocked_by` source: it would badge `terminal-splits`, which is not blocked. Round 3 HIGH-1 then corrected revision 3's own rationale — the rendering path is already complete and free (`blocked` is a documented card status; `FleetSnapshot.swift:691` reads it; both clients draw it), and the on-board tally is 1 true / 1 false, not 2 of 2. The single surviving reason is semantic: genie's enforced block means both "work is blocked" and "do not claim this card". Until genie separates them, the badge lies. |
| 5 | **The lane table is derived from `Wish.StatusCategory`.** | Round 1 H1/H2/H3. Any independently-authored mapping contradicts the shipped bucketing and makes board and sidebar disagree permanently. |
| 6 | **`MERGED` joins `.done`. `WishLane` is otherwise untouched, and `.draft` maps to Idea.** | `MERGED` is a live misfiling with a blast radius round 2 confirmed is exactly one row. Adding `.brainstorm` was revision 2's answer and round 2 F6/F7/F9 priced it: 93 fixture rows relocated, two shipped tests broken, positional JS indices shifted, board column dots changed — all to express what `.draft → Idea` expresses for nothing. The Brainstorm lane keeps hand-owned and orphan cards, which is the better meaning. |
| 7 | **Two sequenced wishes; card→terminal click ships in wish 2.** | User call 2026-08-04. Round 1 correctly noted the coupling is thinner than first claimed — the join rendering already ships, so wish 1's gift to wish 2 is automatic `--wish` population and the linking verb. The direction of dependency still holds. |
| 8 | **Cleanup executed before designing.** | User call 2026-08-04. Designing against a board showing 7 shipped items as ideas would have meant validating over wrong data — and it is what surfaced Decisions 4 and 6. |

## Risks & Assumptions

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| 1 | **Cross-repo dependency.** The sync is genie-side; remotty's half cannot be validated end-to-end until genie ships it. | High | `depends-on: genie`. Round 1 correctly deflated the old "independently testable" claim: the fixture's one wish-bearing card is `cobalt-nebula`, an *orphan*, so it proves neither the hairline nor lane agreement. Mitigation is concrete — regenerate the fixture from this repo's now-populated board, which carries 10 wish-bearing cards across **three** lanes (Brainstorm 2, Work 2, Done 6 — round 4's LOW-4 corrected "four"). remotty's remaining half (`MERGED` + contract) is genuinely independent of genie and ships either way. |
| 2 | **`.genie/` is gitignored** (`.gitignore:8`) and `.genie/roadmap.json` — the file `genie task sync` reconciles against — does not exist here. The roadmap lives on this machine only. | Medium | Out of scope by decision, named so it is a known gap. `genie task export` is the manual backup and was used before the cleanup. Deferred behind a stated trigger. |
| 3 | **Three implementations of one bucketing**, across two repos and three languages: `FleetSnapshot.swift:592-609`, `linux/shared/decode.js:218-226` (already exact twins), and genie's new one. | Medium | Decision 5 makes genie's a rename of the existing table rather than an independent authoring. Criterion 6 asserts agreement for every sync-owned card. Round 1 raised this from two to three. |
| 4 | **A wish's `WISH.md` status can be wrong**, and the sync propagates it faithfully. `project-registry` read `SHIPPED` and had to be checked against `origin/main` (genuinely merged, PR #23 / 0.2.17). | Low | Accepted: the sync makes the board agree with the wish, it does not audit the wish. A wrong status becomes visible in one more place, which surfaces the error rather than hiding it. |
| 5 | **The "wish is always null" claim appears in eight places** and becomes false in all of them: `docs/state-json.md:213-215`, `FleetSnapshot.swift:663`, `FleetRows.swift:540`, `BoardPane.swift:230`, `linux/shared/decode.js:277`, `linux/shared/rows.js:377`, `linux/renderer/js/labels.js:488`, and `app/Tests/RemottyCoreTests/BoardRowsTests.swift:203`. | Low | Round 3's L7 corrected both the count (seven → eight) and the severity: all eight are **comments and prose**, not behaviour. The code branches on `wishSlug == null` (`rows.js:380`, `FleetRows.swift`), which stays correct either way. This is documentation drift, in scope for Criterion 10, not a correctness risk. `docs/state-json.md:208`'s status-vocabulary drift is corrected in the same pass. |
| 6 | **Lane names are per-board free text**, not a fixed six, and `card.lane` can be `null` inside a lane group (`wish-scope` serialises that way today). | Low | Reconcile only into lanes the board defines; a bucket with no matching lane leaves the card untouched, same rule as Decision 3. The reconciler applies remotty's documented null-lane fallback (`docs/state-json.md:205` — "the card's own `lane`, falling back to the enclosing lane's `name`"; round 3's L5 corrected this citation from `:204`, which is the `dir` row). |
| 7 | **The sync silently reverts a hand `genie task move`** on a sync-owned card, while the move event persists in the timeline. | Medium | Round 1 M2. The revert is logged (Criterion 9) so it is visible and countable — which is also the detector the deferred manual-override trigger needs. |
| 8 | **Half the lane table is unexercised here** — no wish in this repo is `.ready` or `.review`. | Low | Round 1 L2. Criterion 1 alone would prove nothing about those rows, so Criterion 2 exercises them against a throwaway wish. |
| 9 | Feature parity is mandatory — a feature in one client is drift. | Medium | Both clients in scope from the start; the mockup gate runs; deliberate divergence recorded in `linux/README.md`. |
| 10 | **Reconcile-on-read turns a read verb into a writer.** `scanners/extras.sh:135-154` calls `genie board list --json` then `genie board --board <ref> --json` per project, per host, per 60 s probe, each guarded by `\|\| continue` — a failure silently drops the whole board from the snapshot. genie also advertises `genie mcp` as a **read-only** server over the same state. | Medium | Round 2 F8. The reconcile lives in the CLI verb's path, not the shared query layer, so `genie mcp` stays read-only — now *checked* by Criterion 13, not merely stated (round 3's MED-4). Criterion 8 measures probe wall-clock; Criterion 12 asserts degradation, with a named injection mechanism on each side. SQLite lock contention when both clients probe one host is the case to watch. |
| 11 | **The read-only-`genie mcp` constraint has a consequence: genie's own MCP surface serves the *stored* lane and stays stale until some CLI read reconciles it** — and remotty's 60 s probe is the only routine CLI reader. genie's correctness becomes dependent on remotty probing. | Medium | Round 3's MED-4, second half. Accepted for now because the MCP surface is a query tool, not the board people look at, and the stored lane is never *wrong* — only as fresh as the last CLI read. If genie's MCP consumers start acting on lanes, the reconcile belongs in the shared layer with an explicit write, which reopens Risk 10. |
| 12 | **`agent-svg-icons` moves Brainstorm → Idea** on first sync, because it is sync-owned with a `DRAFT` status. | Low | Intended and correct under Decision 6 — and it is the visible proof the sync ran. Named here so it is not mistaken for a regression. |

## Success Criteria

**Ordering.** Criteria 3, 6 and 7 share a mutating subject and must run in that
order (round 2's F10, round 3's MED-2): Criterion 3 counts `wish-scope` among
the 11 hand-owned Idea cards and Criterion 6 asserts over 9 sync-owned
comparables; Criterion 7 then links `wish-scope`, after which the counts are 10
and 10. Criteria 2 and 4 run on a throwaway board and are order-independent.

- [ ] **1.** Every sync-owned card **whose status is not `.other`** sits in the
      lane its `WISH.md` status implies, verified by a command that compares the
      two and prints **zero** divergences. The exclusion is the same one
      Criterion 6 carries and for the same reason: Decision 3 leaves an
      unparseable card's lane untouched, so "the lane its status implies" has no
      value to compare against (round 4's LOW-8). The set is empty on this repo
      once `MERGED` lands, but Criterion 1 is the one that gets re-run.
- [ ] **2.** A **throwaway wish** (`.genie/wishes/zz-sync-probe/`) with its card
      on a **throwaway board**, not `roadmap`, is driven through every bucket:
      draft → ready → active → blocked → review → done, and back down to draft.
      Its card lands in the matching lane on the next `genie board --json` each
      step, with no human action. Covers Risk 8, since `.ready` and `.review`
      are otherwise unexercised here.
      *A separate board is required, not tidiness:* round 3's MED-3 established
      that `genie task` has **no delete verb** (`block checkout comment create
      done export heartbeat import list move release report status sync
      unblock`), so a probe card on `roadmap` would be permanent, and removing
      its wish dir afterwards would turn it into a second orphan — falsifying
      Criterion 3. The board-resolution rule, quoted in full
      (`docs/state-json.md:193-195`, implemented at `scanners/extras.sh:173-174`):
      *the board named `roadmap` if there is one, **otherwise the only board if
      there is exactly one**, otherwise nothing.* This repo has a `roadmap`
      board, so a second board is invisible to clients — but the executor must
      not generalise the device to a repo without one, where a throwaway board
      would become the visible board (round 4's LOW-6). Criterion 4's `G` case
      uses the same throwaway board for the same reason.
      **The probe wish is a separate exposure:** `scanners/extras.sh:101-115`
      scrapes every `.genie/wishes/*/WISH.md` with no board scoping, so
      `zz-sync-probe` *will* appear in `wishes[]` and in both sidebars while the
      criterion runs. Harmless to Criteria 3 and 6, which iterate board cards —
      but `.genie/wishes/zz-sync-probe/` must be deleted **before** Criterion
      10's fixture capture, or the probe ships in the committed fixture
      (round 4's LOW-7).
- [ ] **3.** Neither hand-owned nor orphan cards are ever moved by the sync:
      across a sync, the **11** hand-owned cards in Idea, the **7** hand-owned
      cards in Done, and the **1** orphan in Brainstorm (`roadmap-truth`,
      `t_msf0n8kq2e758ad0`) are unchanged in lane. Run **before** Criterion 7.
- [ ] **4.** A wish whose status cannot be bucketed leaves its card where it is —
      asserted against `G`, which `Wish.StatusCategory` genuinely returns
      `.other` for, and which `FleetSnapshotTests.swift:182` and
      `linux/test/decode.test.js:221` already pin. (`WAVE`, `IN` and `SHIP-` are
      all parsed; round 1 H3.)
- [ ] **5.** `agent-svg-icons` moves Brainstorm → Idea on first sync,
      demonstrating that sync-owned drafts land in Idea (Decision 6, Risk 12).
      *`agent-parity` is deliberately not cited here:* it stays in Done with or
      without the `MERGED` fix, since unfixed it buckets `.other` and Decision 3
      leaves it untouched. The `MERGED` fix is caught instead by Criterion 6's
      count — 9 comparable cards with it, 8 without (round 4's LOW-5).
- [ ] **6.** For every sync-owned card **whose status is not `.other`**, the
      sidebar's `WishLane` and the board's lane name agree — asserted over the
      **9** such cards, i.e. the 10 wish-bearing minus the 1 orphan. An orphan
      has no `WISH.md`, so `scanners/extras.sh:103` emits no `wishes[]` row and
      there is no sidebar lane to compare; `wishExists(in:)`
      (`FleetSnapshot.swift:702-705`) is the shipped test for exactly this
      (round 3's MED-2). The `.other` exemption is explicit and its reason
      recorded, because Decision 3 makes agreement false by construction there
      (round 2's F5). Run **before** Criterion 7, which takes the set to 10.
- [ ] **7.** An existing hand-owned card is linked to a wish with the new verb
      and **keeps its id and timeline** — proven on `wish-scope`
      (`t_msf0mym5e7f7957f`), which becomes sync-owned once its wish is written.
      Run **after** Criterion 3.
- [ ] **8.** Probe wall-clock is measured before and after on this fleet and
      recorded in the wish. If it regresses past genie-board's stated 3 s
      threshold, the deferred caching trigger has fired and is filed as such.
- [ ] **9.** A hand `genie task move` on a sync-owned card is reverted **and
      logged**, so the revert is countable (Risk 7).
- [ ] **10.** All **eight** stale "wish is always null" sites are corrected
      (round 3's L7 found the eighth, `BoardRowsTests.swift:203`),
      `docs/state-json.md:208`'s status-vocabulary drift is fixed, and the
      fixture is regenerated through the shipped procedure — capture →
      `scripts/sanitize-fixture.mjs` (drawing from `scripts/fixture-corpus.txt`,
      which throws `corpus [slugs] exhausted` if the pool is short) →
      `scripts/leak-scan.sh --fixtures` via `scripts/smoke.sh:47-50`. Same
      commit. The corpus may need new slugs for 10 wish-bearing cards.
- [ ] **11.** All three gates green and named, not assumed: `scripts/smoke.sh`,
      `swift build && swift test`, and `cd linux && npm test`. The mockup gate
      runs and passes; no unrecorded divergence between the clients.
- [ ] **12.** A reconcile failure degrades to serving the **stored** lane, not to
      dropping the board. Two halves, each with a named mechanism: genie-side,
      force the reconcile to fail and assert `genie board --json` still returns
      every card; remotty-side, use `scripts/scanner-test.sh:114-128`, which
      already stubs `genie`, to make `board --board` exit non-zero and assert
      `scanners/extras.sh`'s `|| continue` does not swallow the project
      (Risk 10, round 3's L8).
- [ ] **13.** `genie mcp` performs **no write** — asserted by running its board
      tool against a read-only database **that contains at least one sync-owned
      card in the wrong lane**, and observing success rather than a write error.
      The seeded divergence is what gives the criterion teeth: a reconciler that
      writes only when it finds one issues no `UPDATE` against an
      already-reconciled database, so without it the assertion passes whether or
      not the reconcile leaked into the shared query layer (round 4's LOW-3).
      Read-only WAL access was checked empirically and does not itself fail:
      `chmod 444` on `genie.db`, `-wal` and `-shm` plus `chmod 555` on the
      directory still serves reads. Closes round 3's MED-4.

## Evidence — cleanup executed 2026-08-04

Backup taken first: `genie task export` → 65 818 bytes.

| Lane | Before | After (measured at revision 2) |
|---|---|---|
| Idea | **17** (7 already `done`) | 11 — backlog, **0 wish-bearing** |
| Brainstorm | 0 | 2 — `roadmap-truth` (**orphan**) + `agent-svg-icons` (**sync-owned**) |
| Wish | 0 | 0 |
| Work | 0 | 2 — `app-auto-update` (blocked), `terminal-splits` |
| Review | 0 | 0 |
| Done | 0 | 13 — 6 wish-bearing + 7 hand-owned retired M1 cards |
| **Total** | 17 | **28**, 10 wish-bearing |

Counts are as measured at revision 2; round 1's L1 caught the revision-1 table
already being stale, since two cards were filed after it was written.

`project-registry` was verified genuinely merged against `origin/main` before
being filed Done; its `WISH.md` status was not taken on trust.

`agent-svg-icons` has a `WISH.md` (status `DRAFT`) yet sits in Brainstorm, so it
is **sync-owned, not an orphan** — round 2's F1 corrected the revision-2 table,
which called both Brainstorm cards orphans. The board holds exactly **one**
orphan, `roadmap-truth`. On first sync `agent-svg-icons` moves to Idea
(Criterion 5), which is the intended behaviour and the visible proof the sync
ran.

## Next Step

After an independent design review returns SHIP, persist the evidence below and
verify its content digest before running `wish`.

The sequel is recorded in `.genie/INDEX.md` as **`wish-scope`** (Raw):
tag-at-spawn, agents nested under their wish in the sidebar, per-wish right
panes (`HANDOFF.md:61`), card→terminal click, and open terminals + loose procs
in the project view. `depends-on: roadmap-truth`.

<!-- genie-design-review:start -->
## Design Review Evidence

- **Verdict:** SHIP
- **Reviewed content SHA-256:** `40106843a8d88b70d85ea8d0394c4968dc97987d523d044b946944f377919fc8`
- **Reviewer:** independent genie execution reviewer (docs-only re-review above 40ad3d050)
- **Reviewed at:** 2026-08-06T22:15:00.000Z
<!-- genie-design-review:end -->
