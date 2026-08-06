# roadmap-fractal — DRAFT

## Request (verbatim intent)

Organize the remotty roadmap and make it perfectly visible from the remotty app.
The project view lists 3 wishes on the left menu and a long roadmap board where
every item sits in **Idea** and never moves, no matter how much work happens.
Expectation: the project surface shows **everything going on** — all sessions
and terminals. The left menu detects wishes; clicking a wish opens a **fractal**
view — the same right-hand options, filtered to that wish — so people navigate
at any granularity.

## Evidence gathered (2026-08-04, this repo)

### The board never moves — measured cause

`genie board --board roadmap --json` on this repo, all 17 cards:

| lane | status | wish | count |
|---|---|---|---|
| Idea | done | null | 7 |
| Idea | ready | null | 10 |

Three independent findings, each fatal on its own:

1. **Lane and status are separate fields, and only `status` is maintained.**
   `genie task done <id>` sets `status`; `genie task move <id>` sets the lane.
   Seven cards were marked `done` (their `updatedAt` moved) and every one of
   them is still sitting in the **Idea** lane. The board renders by lane
   (`BoardPane.swift` — "Nothing here decides where a card goes"), so the board
   shows Idea for work that shipped months ago.
2. **No card is joined to a wish.** `wish: null` on 17 of 17 — already recorded
   in `docs/state-json.md` as measured 2026-08-01. So nothing *could* move a
   card automatically from wish progress; the link does not exist.
3. **The card slugs and the wish slugs have zero overlap.** Cards name the
   original M1 plan (`terminal-attach-spike`, `session-tabs`, `board-readonly`,
   `unread-badges`, …); the wishes that actually shipped are named differently
   (`agent-parity`, `settings-and-prereqs`, `project-registry`, …). A
   title-prefix join would match **nothing today**.

### Why the sidebar shows 3 and the board shows 17

They are two disconnected universes:

- **Sidebar wishes** = `wishes[]`, scraped fresh from `.genie/wishes/*/WISH.md`
  status text on every probe. These *do* move (DRAFT → IN_PROGRESS → APPROVED →
  MERGED). `FleetRows.sidebarWishes` defaults to `.inFlight` grouping capped at
  `sidebarWishLimit = 6` — this repo has 9 wishes, 3 of them in flight. Hence 3.
- **Board cards** = `board_cards[]`, hand-placed rows in `.genie/genie.db`.
  Static since the seed batch.

The live roadmap already exists — it is the wish list. The board is a frozen
snapshot of an old plan rendered next to it.

### What links a session or terminal to a wish today

**Nothing.** `sessions[].name` is `basename(dir)-agent-N`; `procs[]` carries
`{agent, pid, dir, sess}`; `agent_sessions[]` carries the agent's own title.
No field anywhere names a wish. A wish-scoped Sessions or Terminal pane has no
filter to apply unless that link is created.

`WishRows.swift` already says this out loud: "nothing joins a wish to a running
process", which is why no agent icon is drawn on a sidebar wish row even though
the mockup designs one.

### Current surfaces

- `ShellTab` = `board | sessions | stats | terminal`. Selection scope is one
  field: `selectedProjectID`. There is no wish scope.
- Sidebar wish rows are **not** clickable to a scope today. The mockup
  (`index.html:778`) makes `.swish` open a terminal when the wish has an
  orchestrator agent, else it just selects the project + board tab.
- `mockup/index.html:177` names the downstream surfaces that any scope must
  cover: **board, sessions, terminal, stats, wish bar**.

## Prior decisions found (these bind — 2026-08-04 research pass)

The board's design was already settled. Three records govern:

**`docs/PLAN.md:137-143` — Board cards: V5 "Whisper" (user-picked):**
- whole card clickable → orchestrator terminal (plus hover `❯_` affordance)
- live tldr line from transcript tail, pulsing dot when running
- metrics bar: state dot · agent · elapsed · cost · ↓tokens-in · ↑tokens-out
- heat rule per metric: ≤ avg quiet; above avg amber → red at all-time record
- criteria as a 2.5px hairline across the card top

**`.genie/wishes/genie-board/WISH.md` — Decision 10 and the OUT list:**
- *"No derived lane mapping. An earlier draft carried a six-rule mapping plus a
  `@@BRAIN` scanner section to synthesise lanes. Both are deleted: **genie
  reports the lane, so remotty reads it**."*
- *"Writing genie state from remotty. No creating, claiming, or completing
  tasks... The Board is **read-only in this wish**, exactly as `board-readonly`
  on the roadmap describes it."*

**Two deferrals whose triggers have now fired:**

| Deferred item | Recorded trigger | Status |
|---|---|---|
| **Board write actions** | *"read-only board is in daily use and the user asks to move a card"* | **FIRED** — this request |
| **Card telemetry and agent attribution** | *"the snapshot carries a non-null `claimedBy` **or a session-trace source lands**"* | **FIRES** on tag-at-spawn (Q3 answer) — the attribution half |

`HANDOFF.md:61` also already names the fractal as a planned stage:
*"User-defined later stage: **per-WISH right panes**."*

So this is not new design. It is releasing two deliberately-parked deferrals at
the moment their own triggers fired, against a card contract that is already
drawn.

## Corrected model (user, 2026-08-04)

**One card per wish.** The roadmap board is dedicated to wishes; genie task
cards are deliberately *not* on it (there would be too many), and genie already
provides that filtering. So "cards vs wishes" is a false dichotomy — the card
*is* the wish's roadmap presence. `wish: null` on all 17 is a **defect in the
existing cards**, not evidence for a different model.

## Problem statement

remotty's roadmap board is read-only by design and nothing ever runs the one
verb that moves a card (`genie task move`), so the board freezes at whatever
lane the cards were seeded in while the work underneath it ships — and because
no card names its wish and no session names one either, neither the board nor
the sidebar can show which agents are working on what.

## Scope — wish 1, `roadmap-truth`

**IN**
- **genie**: cards created for a wish carry `--wish`; the lane of every
  wish-bearing card is reconciled from that wish's `WISH.md` status, so the
  board moves with no human action.
- **remotty, both clients**: render the card↔wish join — wish-slug eyebrow,
  criteria hairline, blocked badge — on every wish-bearing card.
- Contract: `docs/state-json.md` + regenerated fixture, same commit.
- The one-time reorganisation of the existing 17 cards — **done 2026-08-04**,
  recorded below as executed evidence rather than as remaining work.

**OUT**
- **Any write to genie state from remotty.** No drag, no lane menu, no
  ui-bridge write channel. Decision 4 removes the need; `bridge-channel` and
  the "Board write actions" deferral both stay parked.
- **Tag at spawn and everything it unlocks** — the wish↔session link, agents
  nested under wishes, per-wish right panes, card→terminal click. All of it is
  wish 2, `wish-scope`; the click in particular needs an orchestrator
  attribution that does not exist yet.
- **Card telemetry** (`$` / tokens / elapsed heat rules). No trace source
  exists; `StatsPane`'s "no fabricated data, ever" stands, and the genie-board
  wish already parked this behind its own trigger.
- **Agent attribution from `claimedBy`.** Still `null` on every card; faking a
  `checkout` to populate it was explicitly declined during the cleanup.
- **Committing `.genie/`** or introducing `.genie/roadmap.json`. Recorded as a
  risk, not fixed here.

## Decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | **Tag at spawn** creates the wish↔session link | User call 2026-08-04. remotty already writes a per-session manifest; the wish slug goes in it. Exact, never guessed. Sessions with no tag get an explicit "not filed under a wish" group. |
| 2 | Card render follows **V5 "Whisper"** verbatim | Already user-picked in `docs/PLAN.md`; not reopened. |
| 3 | Lane is still **read, never derived** | genie-board Decision 10 stands. Unsticking is about *writing* the lane, which is a different verb than synthesising it at render time. |

| 4 | **genie auto-syncs the lane from wish status.** No remotty writes, no drag. | User call 2026-08-04. Manual movement is precisely what failed for the board's whole life; making it cheaper does not fix it. The roadmap becomes a projection of the wish state that already exists. Decision 10 survives: genie still reports the lane, remotty still reads it. |
| 5 | **No ui-bridge write channel, no drag-and-drop.** | Falls straight out of Decision 4. The `bridge-channel` DEMAND-GATED card and the "Board write actions" deferral both stay parked — their demand is answered by the sync instead. Complexity removed, not deferred. |
| 6 | Split into **two sequenced wishes** | User call 2026-08-04. Wish 2 depends on wish 1's card↔wish join existing; wish 1 alone fixes the opening complaint. |
| 7 | Card→terminal click ships in **wish 2**, not wish 1 | It needs an orchestrator attribution, which only tag-at-spawn creates. Shipping it in wish 1 would mean inventing one. |

## Cleanup — executed 2026-08-04, before designing (user call)

Backup: `genie task export` → 65 818 bytes, taken before any write.

| Lane | Before | After |
|---|---|---|
| Idea | **17** (7 of them already `done`) | 10 — genuine backlog, none yet a wish |
| Brainstorm | 0 | 1 — `agent-svg-icons` (DRAFT) |
| Wish | 0 | 0 |
| Work | 0 | 2 — `app-auto-update` (blocked), `terminal-splits` |
| Review | 0 | 0 |
| Done | 0 | **13** — 7 retired M1 cards + 6 shipped wishes |
| Cards naming a wish | **0 of 17** | **9 of 26** |

What was done: the 7 `status:done` cards moved out of Idea into Done; one card
per live wish created with `--wish <slug>` and filed by its `WISH.md` status;
`app-auto-update` blocked with a reason; the 10 un-wished backlog ideas left in
Idea, which is where they honestly belong.

`project-registry` was verified genuinely merged (PR #23, release 0.2.17) before
being filed Done — its `WISH.md` status was not taken on trust.

### Two contract findings from executing it

1. **The board JSON exposes no block.** `genie task block` records `Blocked by:
   claude-code — <reason>` in the task detail, but the card still serialises as
   `status:"ready"` with no blocked field anywhere in `genie board --json`.
   remotty cannot badge a blocked card from the board alone. It *can* get it
   from the join: `wishes[].statusCategory == .blocked` already drives
   `WishRow.isBlocked` in the sidebar. **The card↔wish join is therefore the
   keystone, not a nicety** — it is what makes the mockup's blocked badge
   renderable without any genie change.
2. **Lane and status still disagree on the two Work cards** (`lane:Work`,
   `status:ready`). Left honest rather than faking a `genie task checkout`,
   which would have invented a `claimedBy` — the exact field the deferred
   agent-attribution work is waiting on. This divergence is what the sync owns.

## The sequel — wish 2, `wish-scope` (recorded, not designed here)

- Tag at spawn: the wish slug enters remotty's per-session manifest.
- Sidebar: agents/sessions/terminals nested under the wish they belong to.
- Per-wish right panes — the fractal (`HANDOFF.md:61` already names this).
- Card click → orchestrator terminal (V5 Whisper), unblocked by the tag.
- Project view lists open terminal tabs and loose/unmanaged procs.

`depends-on: roadmap-truth` — specifically on `board_cards[].wish` being
populated and on the card↔wish join shipping in both clients.

## Risks / constraints

- **Cross-repo dependency.** The sync is genie-side work (`~/prod/genie`), not
  remotty. remotty's half cannot be validated end-to-end until genie ships it.
  `depends-on: genie`.
- **`.genie/` is gitignored** (`.gitignore:8` — `/.genie`). The roadmap exists
  only on this machine; `.genie/roadmap.json`, the canonical file `genie task
  sync` reconciles against, **does not exist here at all**. The board has no
  reviewable, shared, or backed-up form today.
- **Free-text status, both sides.** `wishes[].status` had 31 distinct values in
  one snapshot including truncations (`G`, `IN`, `SHIP-`, `WAVE`).
  `board_cards[].status` is free lower-case text. The sync must go through one
  bucketing and must **leave a card where it is** when the status cannot be
  parsed — never fabricate a lane from junk.
- **Two bucketings could diverge.** remotty already has `Wish.StatusCategory`
  (30+ values → 7 buckets). genie will need its own. If they disagree, the
  sidebar lane and the board lane disagree for the same wish — visibly.
- Feature parity is mandatory: everything ships to `app/` **and** `linux/`.
- The mockup is the design of record; the mockup gate must run.
- Contract change ⇒ regenerate `state-fixture.json` and update
  `docs/state-json.md` **in the same commit** (`scripts/smoke.sh` is the gate).

## Acceptance criteria (draft)

1. Every roadmap card that names a wish sits in the lane its `WISH.md` status
   implies — verified by a command that compares the two and prints zero
   divergences.
2. Changing a wish's `WISH.md` status puts its card in the new lane on the next
   `genie board --json`, with no human action. Demonstrated by editing one
   status and re-reading.
3. A card with `wish: null` is never moved by the sync — the 10 backlog ideas
   stay hand-owned in Idea across a sync.
4. A wish status the bucketing cannot parse leaves its card where it is; no
   lane is invented from an unparseable status.
5. Both clients render, on every wish-bearing card: the wish slug eyebrow, the
   criteria hairline, and the blocked badge — all from the card↔wish join, with
   the blocked badge proven against a card whose `status` is `ready`.
6. `docs/state-json.md` records `board_cards[].wish` as populated-in-practice,
   and the committed fixture carries wish-bearing cards, in the same commit.

## WRS

WRS: ██████████ 100/100
 Problem ✅ | Scope ✅ | Decisions ✅ | Risks ✅ | Criteria ✅
