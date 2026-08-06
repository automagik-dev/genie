# Wish: Roadmap truth — the board moves because the wish moved

| Field | Value |
|-------|-------|
| **Status** | REVIEWED |
| **Slug** | `roadmap-truth` |
| **Date** | 2026-08-04 |
| **Author** | Felipe (namastex888) |
| **Appetite** | medium |
| **Branch** | `wish/roadmap-truth` (remotty, off `main`) · `wish/roadmap-truth` off **`origin/main` after a fetch** (genie — see Group 0's downgrade warning) |
| **Repos touched** | `remotty` (app, linux, docs, tests), `genie` (`~/prod/genie`) |
| **Design** | [DESIGN.md](../../brainstorms/roadmap-truth/DESIGN.md) |

> **Design evidence.** SHIP, reviewed-content sha
> `7e35c1bda10db9230287ccadc1dda7c4bc7a45a19f74d0e3b1d80635d6308cf4`, four
> review rounds (FIX-FIRST ×3, each shrinking scope). Verified with
> `design-review-evidence.mjs verify` at wish time.

> **Citation note.** Line citations are pinned to **`main` = `fd32117`**
> ("release 0.2.17 (#23)"), and live genie state measured 2026-08-04. The
> design and the first draft of this wish cited `99fada0` on branch
> `wish/project-registry`; that branch has since merged, and every cited file
> was re-checked against `fd32117` — none of them changed.

> **Three prerequisites, all found by plan review — read before starting.**
>
> 1. **The installed `genie` is a compiled binary**
>    (`~/.local/bin/genie` → `~/.genie/bin/genie`, Mach-O arm64), **not a link
>    into `~/prod/genie`.** Editing genie source and running its tests changes
>    nothing that `genie board --json` or remotty's 60 s probe executes. Every
>    live-observation criterion in this wish requires **Group 0** to have run.
> 2. **`swift build` does not work from the repo root** — `Package.swift` lives
>    at `app/Package.swift`. Always `(cd app && swift build && swift test)`.
>    `scripts/smoke.sh:38` already does this correctly.
> 3. **Cut `wish/roadmap-truth` from a clean `main`.** `scripts/smoke.sh`
>    currently exits 1 at `mockup/check-registry-markers.js`
>    (`TypeError: document.addEventListener is not a function`) because of
>    **uncommitted** `mockup/index.html` WIP in this tree — against
>    `git show HEAD:mockup/index.html` it passes. Carry that WIP along and
>    Groups 4 and 6 both open red for a reason unrelated to this wish
>    (round 3 LOW-2).

## Summary

remotty's roadmap board freezes at whatever lane its cards were seeded in while
the work underneath it ships: measured 2026-08-04, all 17 cards sat in `Idea`
with 7 of them already `status: done`, and `wish` was `null` on 17 of 17. This
wish makes the lane a function of the wish — genie reconciles a sync-owned
card's lane from its `WISH.md` status on read, so the board tracks reality with
no human action — and fixes the one live misfiling on remotty's side, where
`MERGED` buckets `.other` and draws `agent-parity` under Idea in the sidebar.

The board's one-time reorganisation was executed 2026-08-04 *before* the design
was written (user call): 28 cards, 10 wish-bearing, lanes now honest. This wish
keeps them honest without anyone remembering to run `genie task move`.

> **Population as of this wish's creation.** 28 cards: 11 hand-owned in Idea,
> 7 hand-owned in Done, **10 sync-owned, 0 orphan**. The design was written
> when `roadmap-truth` was still a brainstorm and its card was the board's only
> orphan; **writing this WISH.md is what made it sync-owned**, so every orphan
> count in DESIGN.md is one revision stale. Plan review caught it (HIGH-2). The
> figures in *this* document are the live ones.

## Scope

### IN

- **genie:** reconcile the lane of every sync-owned card from its wish's
  `WISH.md` status on read, through a bucketing that is a rename of remotty's
  shipped `Wish.StatusCategory`.
- **genie:** a verb to set `--wish` on an existing card (create-only today), so
  a backlog idea can become a wish card without losing its id and timeline.
- **remotty, both clients:** `Wish.StatusCategory` recognises `MERGED` —
  identical edits to `FleetSnapshot.swift:592-609` and
  `linux/shared/decode.js:218-226`, which are deliberate twins.
- **remotty:** contract truth — `docs/state-json.md` (`board_cards[].wish` now
  populated; the `:208` status-vocabulary drift), the eight stale "wish is
  always null" prose sites, and a fixture regenerated through the shipped
  sanitiser pipeline.
- **Design cleanup carried from round 4:** two citation fixes in DESIGN.md.

### OUT

- **Any write to genie state from remotty.** No drag, no lane menu, no
  ui-bridge write channel. The `bridge-channel` DEMAND-GATED card and
  genie-board's "Board write actions" deferral both stay parked.
- **New card↔wish rendering.** It already ships in both clients
  (`BoardPane.swift:173,239-303`; `linux/renderer/js/board.js:56-83`), eyebrow,
  criteria hairline and `.orphanWish` state included.
- **The blocked badge**, and any new `WishLane` case. Both were IN at earlier
  revisions and were removed by review — see Decisions 4 and 5.
- **Any engine change.** `scanners/extras.sh:186` and `bin/remotty:540` stay at
  eight `@@CARD` fields.
- **Tag-at-spawn and the fractal** — wish↔session link, agents nested under
  wishes, per-wish right panes, card→terminal click. That is `wish-scope`.
- **Card telemetry** (`$` / tokens / elapsed heat rules) and `claimedBy`
  attribution. No trace source exists; `StatsPane`'s "no fabricated data, ever"
  stands.
- **Committing `.genie/`** or introducing `.genie/roadmap.json`.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | **genie auto-syncs the lane; remotty never writes.** | User call 2026-08-04. Making a manual move cheaper does not fix a board that fails because nobody moves it. genie-board Decision 10 survives literally — genie reports the lane, remotty reads it. |
| 2 | **Three populations: sync-owned (card names a wish with a `WISH.md`), hand-owned (`wish: null`), orphan (names a wish with no `WISH.md`).** Only the first is touched. | The orphan rule is what lets a brainstorm card sit in Brainstorm before its wish exists, and remotty already models and draws it (`wishExists(in:)`, `FleetSnapshot.swift:702`). |
| 3 | **An unparseable status leaves the card where it is.** | `wishes[].status` is free text — 31 distinct values in one snapshot including `G`, `IN`, `SHIP-`, `WAVE`. A card parked in a stale lane is honest; one filed from `G` is a lie. |
| 4 | **The blocked badge is OUT — because genie's block is ambiguous, not because rendering costs anything.** | `blocked` is already a documented card status (`docs/state-json.md:364`, `sanitize-fixture.mjs:46`), `FleetSnapshot.swift:691` reads it, both clients draw it. But genie's enforced block carries both real work-blocks (`app-auto-update`) and administrative markers (`terminal-splits` — "Not a work item… Do not claim"), 1 of each on this board. Wiring it today lights a card that is not blocked. |
| 5 | **No `WishLane` change. `.draft` maps to Idea.** | Adding `.brainstorm` moves 93 fixture rows out of Idea into an uncapped section, breaks `WishRowsTests.swift:60,67` which pin `allCases`/`isInFlight` exactly, and shifts `labels.js:284-303`'s positional indices — all to express what `.draft → Idea` expresses for free. |
| 6 | **`MERGED` joins `.done`.** | A live misfiling: `agent-parity` is merged and released and draws under Idea today. Blast radius verified as exactly one ladder line per client — `MERGED` appears nowhere in `app/ linux/ docs/ bin/ scripts/ scanners/`, no test or fixture pins it, and `statusCategory` has two consumers per client. |
| 7 | **The reconcile lives in the CLI verb's path, not the shared query layer.** | Keeps `genie mcp` read-only as advertised. Consequence accepted and recorded: genie's MCP surface serves the stored lane until a CLI read reconciles. |

## Simplicity Case

- **Simplest complete design:** one field on the card (`wish`), one
  reconciliation on read, three ownership rules, one bucketing shared by three
  renderers. remotty gains no new transport, process, write direction,
  persistence, lane, or card field; the engine is untouched.
- **Added machinery:** the reconciliation, paid for by a measured failure — 7
  shipped items rendered as ideas and 17 of 17 cards unlinked on the app's only
  "what is going on" surface. One genie verb, paid for by the fact that
  `--wish` is create-only, so the normal lifecycle (backlog idea → wish) cannot
  be represented without destroying the card and its timeline. Nothing else.
- **Deferred until measured:**
  - *Blocked badge* — trigger: genie distinguishes blocked work from
    administrative marker and sets `card.status = "blocked"` for the former
    only. Then the badge ships with **no** remotty change at all.
  - *Manual lane override from the app* — trigger: a sync-owned card needs a
    lane its status cannot express, twice. Group 3's revert log is the counter.
  - *Caching `genie board --json`* — genie-board's trigger stands unchanged
    (probe wall-clock past 3 s with ≥5 boards). Group 6 measures it.
  - *`.genie/roadmap.json` as canonical roadmap* — trigger: the roadmap must
    exist for more than this machine.
- **Complexity removed:** no ui-bridge write channel; no drag-and-drop; no
  conflict-resolution rule; no pin/lock flag; no scheduler, hook or daemon; no
  new durable state. Stated honestly: the first four are alternatives
  *declined*, and the bucketing genie-board deleted from remotty now exists one
  repo over — what is removed is a *second* bucketing, since genie's is
  specified as a rename of `Wish.StatusCategory`.

## Dependencies

**depends-on:** none
**blocks:** wish-scope

> **Cross-repo, not cross-wish.** Groups 0-3 land in `genie` (`~/prod/genie`),
> which has no wish slug here, so it cannot be a `depends-on` value. It is
> carried by the **wave structure** and by the first row of Assumptions /
> Risks — *not* by the group-level `depends-on` fields, which reference only
> in-wish groups (plan review LOW-3 corrected an earlier claim otherwise).
> Groups 4-5 are independent of genie and ship either way.

## Success Criteria

- [ ] Every sync-owned card **whose status is not `.other`** sits in the lane
      its `WISH.md` status implies — a command compares the two and prints zero
      divergences. (`.other` is excluded because Decision 3 leaves its lane
      untouched, so there is no implied value to compare.)
- [ ] A wish driven through every bucket lands in the matching lane on the next
      `genie board --json`, each step, with no human action.
- [ ] Hand-owned cards are never moved: 11 hand-owned in Idea and 7 hand-owned
      in Done are unchanged across a sync.
- [ ] An unparseable status (`G`) leaves its card where it is.
- [ ] Both previously stale cards move on first sync: `agent-svg-icons`
      Brainstorm→Idea for `DRAFT`, and `roadmap-truth` Wish→Work for its current
      `IN_PROGRESS` status. Those two moves are the visible proof the sync ran.
- [ ] Sidebar `WishLane` and board lane agree for all **10** sync-owned
      non-`.other` cards. The count is **10 with the `MERGED` fix and 9
      without**, which is what proves Group 4 landed.
- [ ] The orphan rule is proven by linking the existing `wish-scope` card to
      its deliberately absent wish directory (Group 2 AC3).
- [ ] An existing hand-owned card is linked to a wish and **keeps its id and
      timeline**.
- [ ] `genie mcp` performs no write, proven against a read-only DB seeded with
      a divergence.
- [ ] A reconcile failure degrades to serving the stored lane, never to
      dropping the board.
- [ ] All three gates green: `scripts/smoke.sh`, `swift build && swift test`,
      `cd linux && npm test`.

## Execution Strategy

Wave 1 is the genie side and must land first — Group 6 verifies against a
running sync. Wave 2 is independent of it and runs in parallel: the `MERGED`
fix and the doc cleanup need nothing from genie. Wave 3 is the joint
verification and closes the wish.

### Wave 1 (genie)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 0 | engineer | 1 — mechanical, deterministic, but CI/release-adjacent (+1) | `engineer-trivial` / low | Branch genie off `main` and make the edited genie the installed genie |
| 1 | engineer | 5 — stateful (+2), multi-package/cross-repo (+1), no deterministic test in remotty's suite (+1), lane semantics are schema-adjacent config (+1) | `engineer-complex` / high | Lane reconciliation on read, with the three-population ownership rule |
| 2 | engineer | 3 — stateful (+2), multi-package (+1) | `engineer-standard` / high | Verb to set `--wish` on an existing card |
| 3 | engineer | 3 — stateful (+2), no deterministic test (+1) | `engineer-standard` / medium | Revert logging + the read-only-`genie mcp` guarantee |

**Ordering inside Wave 1 is not optional** (carried from DESIGN.md:325-329,
dropped in the first draft and restored after plan review HIGH-4). Group 1's
validation asserts 10 wish-bearing cards and 11 hand-owned in Idea; Group 2
links `wish-scope`, taking those to 11 and 10. Run 1 before 2, and 0 before
either.

### Wave 2 (remotty — parallel with Wave 1)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 4 | engineer | 2 — multi-package, both clients (+1); shared runtime behaviour (+1) | `engineer-standard` / medium | `MERGED` → `.done` in both twins |
| 5 | engineer | 1 — docs and prose only, deterministic checks | `engineer-trivial` / low | Contract doc, 8 stale prose sites, 2 design citations |

### Wave 3 (joint verification)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 6 | engineer | 4 — uncertain impact (+2), CI/release-gate work (+1), no deterministic test for the probe measurement (+1) | `engineer-complex` / high | Fixture regeneration, probe wall-clock measurement, full gate |

Complexity scoring rubric: score each group independently and record the total plus a short rationale in **Complexity**. Add:

- **+2** each for orchestration / agent-lifecycle / routing; cost / model / escalation; stateful work; subjective acceptance.
- **+1** each for multi-package work; OTel-label dependency; no deterministic test; prior rework; prompt-skill change; CI / release work.

Route the total in **Model** by portable role and reasoning effort: **0–1** →
`engineer-trivial` / low; **2–3** → `engineer-standard` / medium or high;
**4–6** → `engineer-complex` / high; **7+** → `engineer-complex` plus an
independent `final-gate` at the highest justified effort. Codex maps these to
the `genie_*` profiles; other runtimes use their matching native roles. Keep
model and effort in runtime session/agent configuration, never skill frontmatter.

## Execution Groups

### Group 0: Make the edited genie the installed genie

**Goal:** Close the loop between genie source and the binary every live
assertion in this wish actually runs.

> **⚠️ Promoting a build off `main` DOWNGRADES the live genie, and fetching does
> not fix it.** Measured 2026-08-04: the installed binary reports
> **5.260803.7**; the local `main` was **5.260728.7**, and even **`origin/main`
> after a fetch carries `5.260803.6`** in `package.json`. genie stamps the
> release version outside `package.json` on `main` (HEAD `708c5c0e5` is
> *"advance eligible manifests (stable) → v5.260803.7"*, while the last commit
> touching `package.json` is the `5.260803.6` auto-bump), so **main's
> `package.json` is structurally behind the latest release.**
>
> Round 2 asked for a guard; round 3 then found the guard deadlocks the wish —
> Group 0 aborts, and `depends-on: 0` propagates that to Groups 1, 2, 3 and 6.
> **The version bump is therefore a deliverable, not an assumption.**

**Deliverables:**
1. `git fetch origin` in `~/prod/genie`, then a `wish/roadmap-truth` branch cut
   from **`origin/main`** — not the local `main`, and not the current checkout,
   which sits on `feat/kimi-plugin` mid-refactor.
2. **A version bump on the wish branch, then a guard.** `npm run version`
   (`bun run scripts/version.ts`) generates `5.YYMMDD.N` by counting existing
   `v5.<date>.*` tags, so a run on or after 2026-08-04 yields a version above
   the installed `5.260803.7`. Without it the guard in D3 fires and Group 0 —
   and everything depending on it — cannot proceed.
   - Record **which files the bump dirties** on the wish branch:
     `scripts/version.ts` rewrites six, `package.json` among them. Decide and
     state whether those land in the genie PR or are reverted before it.
   - The guard then refuses to promote anything **older than or equal to** the
     installed version. Equality must fail too: with equal strings the closing
     `genie --version` assertion passes *without any promote having happened*.
   - `build-binary.sh` also accepts `--version <v>` if an explicit value is
     preferred over the generator; pick one and thread it through, because
     `BUILT=$(jq -r .version package.json)` is only correct when the bump ran
     first.
3. A documented build-and-promote step, run after every genie change and before
   any live assertion in Groups 1-3 and 6:
   - `npm run build:binary -- --platform darwin-arm64` — the bare script exits
     2 with `error: --platform is required`.
   - It emits `dist/genie-<version>-darwin-arm64.tar.gz` and **installs
     nothing**. The promote step is separate and must be written: unpack and
     place at `~/.genie/bin/genie` (which `~/.local/bin/genie` already points
     at), following genie's own convention in `src/genie-commands/update.ts` —
     it refuses to swap binaries outside `~/.genie/bin` (accurate) and writes
     `.previous/` on swap (`:346`). **But genie's rollback verb is disabled** —
     `rollbackBinaryAt` (`update.ts:846-856`) throws unconditionally:
     *"Automatic rollback is disabled: legacy .previous entries do not
     authenticate an exact genie+VERSION generation."* So the restore is a
     **manual file swap**, not a genie command; do not go looking for a verb
     that no longer works (round 4 LOW).
4. A one-line record in this wish of the artifact path, its version and build
   timestamp, so a reviewer can tell source-green from installed-green apart.

**Acceptance Criteria:**
- [ ] `~/prod/genie` is on `wish/roadmap-truth`, cut from `origin/main` after a
      fetch.
- [ ] The built version is **≥ 5.260803.7**, the version installed today. A
      lower version aborts the promote.
- [ ] `~/.genie/bin/.previous/` holds the outgoing binary, and restoring it by
      **manual file swap** is demonstrated once (genie's rollback verb throws).
- [ ] **The loop is proven, not assumed:** make a deliberate, visible change to
      genie's board output, promote, and observe `genie board --json` reflect
      it — then revert the marker. `command -v genie && genie --version` alone
      passes against the *pre-existing* binary and proves nothing.
- [ ] The wish records artifact path, version and build timestamp.

**Validation:**
```bash
# Mechanical, but it gates every live observation in the wish, so it asserts
# the loop end-to-end rather than merely that a build succeeded. The version
# comparison is the guard; the marker round-trip is what discriminates the
# built binary from the one already installed.
set -e
INSTALLED=$(genie --version | tr -d ' v')
cd ~/prod/genie
git fetch origin
git branch --show-current | grep -qx 'wish/roadmap-truth'
# The name check does NOT prove the BASE. This checkout sits on
# feat/kimi-plugin, 101 commits behind origin/main, and local main is behind
# too — so `checkout -b` from where the repo already is would pass the name
# check, stamp a newer version, satisfy the guard, and install a machine-wide
# genie missing 101 commits while printing success (round 4 MED).
git merge-base --is-ancestor origin/main HEAD \
  || { echo "REFUSING: branch is not cut from origin/main" >&2; exit 1; }
npm run version                       # D2 — without this the guard below fires
npm run build:binary -- --platform darwin-arm64
BUILT=$(jq -r .version package.json)
# Refuse a downgrade AND a no-op: BUILT must be strictly greater than INSTALLED.
[ "$BUILT" != "$INSTALLED" ] && \
[ "$(printf '%s\n%s\n' "$INSTALLED" "$BUILT" | sort -V | tail -1)" = "$BUILT" ] \
  || { echo "REFUSING: built $BUILT is not newer than installed $INSTALLED" >&2; exit 1; }
# <promote step from D3 here — must back up to ~/.genie/bin/.previous/>
[ "$(genie --version | tr -d ' v')" = "$BUILT" ] \
  || { echo "promote did not take: still $(genie --version)" >&2; exit 1; }
echo "installed genie is the built genie: $BUILT"
```

> **AC4's marker round-trip is a hand-run gate, not covered by this script**,
> and is the only thing that proves the *built code* is running rather than a
> binary that merely reports a new version number. Run it once, record the
> result, and do not treat a green script as a substitute.
>
> `genie --version` emits a bare `5.260803.7`, so `tr -d ' v'` is a no-op on it
> and macOS `sort -V` orders these correctly — the transform was verified; it
> was the inputs that were wrong.

**depends-on:** none

---

### Group 1: Lane reconciliation on read (genie)

**Goal:** A sync-owned card's lane is recomputed from its wish's `WISH.md`
status on every `genie board --json`, so the board tracks reality unattended.

**Deliverables:**
1. A bucketing in genie that is a **rename of** remotty's `Wish.StatusCategory`
   (`FleetSnapshot.swift:592-609`), including `MERGED → done` from Group 4, and
   the lane map: draft→Idea, ready→Wish, active→Work, blocked→Work,
   review→Review, done→Done, **other→untouched**.
2. The ownership rule: reconcile only cards whose `wish` names a wish with a
   `WISH.md` on disk. Cards with `wish: null` (hand-owned) and cards naming an
   absent wish (orphan) are never moved.
3. Lane-existence guard: a bucket with no matching lane on the board leaves the
   card untouched; the null-lane fallback matches remotty's documented rule
   (`docs/state-json.md:205` — the card's own `lane`, falling back to the
   enclosing lane's `name`).
4. The reconcile lives in the CLI verb's path only (Decision 7).

**Acceptance Criteria:**
- [ ] Every sync-owned non-`.other` card's lane equals its status's lane; a
      comparison command prints zero divergences.
- [ ] A throwaway wish `zz-sync-probe`, with its card **on a throwaway board,
      not `roadmap`**, walks draft→ready→active→blocked→review→done and back to
      draft, landing correctly at each step with no human action.
- [ ] A card with `wish: null` is never moved: the 11 hand-owned in Idea and 7
      in Done are unchanged across a sync.
- [ ] A wish whose status is `G` leaves its card where it is.
- [ ] The two previously stale cards follow their **current** statuses:
      `agent-svg-icons` (`t_msf0ghhp52ed4e25`) moves Brainstorm→Idea for
      `DRAFT`, while `roadmap-truth` (`t_msf0n8kq2e758ad0`) moves Wish→Work for
      `IN_PROGRESS`. The deliberate `wish-scope` orphan remains in Idea.
- [ ] The six `SHIPPED`/`MERGED` wishes are in Done and the three
      `IN_PROGRESS` wishes in Work, after the sync and unprompted.

> **Why a throwaway board:** `genie task` has **no delete verb** (`block
> checkout comment create done export heartbeat import list move release report
> status sync unblock`), so a probe card on `roadmap` would be permanent, and
> removing its wish dir afterwards would turn it into a second orphan,
> falsifying the count above. Clients resolve *"the board named `roadmap` if
> there is one, otherwise the only board if there is exactly one, otherwise
> nothing"* (`docs/state-json.md:193-195`, implemented at
> `scanners/extras.sh:173-174`) — this repo has a `roadmap` board, so a second
> board is invisible. **Do not generalise the device to a repo without one.**
> Delete `.genie/wishes/zz-sync-probe/` before Group 6's fixture capture, or
> the probe ships in the committed fixture.

**Validation:**
```bash
# genie's FULL gate (`npm run check` — typecheck, lint, dead-code, the skill and
# wish linters, complexity budget, then bun test), not `npm test` alone: this is
# stateful core behaviour plus new code paths, reached by every board read in
# every client. Then the divergence comparison AC1 promises, asserting LANES —
# the earlier population-count assertion passed on the unmodified board and so
# could not fail.
cd ~/prod/genie && npm run check && \
cd /Users/feliperosa/workspace/repos/remotty && \
  for w in .genie/wishes/*/; do
    s=$(sed -n "s/^| \*\*Status\*\* | \(.*\) |$/\1/p" "$w/WISH.md" | head -1)
    printf '%s\t%s\n' "$(basename "$w")" "$s"
  done > /tmp/wish-status.tsv && \
  genie board --board roadmap --json \
    | jq -r '.lanes[] | .name as $l | (.cards//[])[] | select(.wish) | "\(.wish)\t\($l)"' \
    > /tmp/card-lane.tsv && \
  join -t$'\t' <(sort -t$'\t' -k1,1 /tmp/wish-status.tsv) \
               <(sort -t$'\t' -k1,1 /tmp/card-lane.tsv) \
    | awk -F'\t' '
        { s = toupper($2); l = $3; want = "";
          # Branch order mirrors FleetSnapshot.swift:592-609 TOP TO BOTTOM.
          # The order IS the contract: a `.done` branch placed first makes
          # ^SHIP shadow ^SHIP-, filing a SHIP-READY wish under Done.
          if      (s ~ /^(DRAFT|ROADMAP)/)                  { want = "Idea" }
          else if (s ~ /^(BLOCK|ON-HOLD)/)                  { want = "Work" }
          else if (s ~ /^(EXECUTED|REVIEWED|PLAN-REVIEWED)/){ want = "Review" }
          else if (s ~ /^(IN|EXECUT|WAVE)/)                 { want = "Work" }
          else if (s ~ /^(READY|APPROVED|PLAN-|SHIP-|STAGED)/) { want = "Wish" }
          else if (s ~ /^(DONE|SHIP|MERGED|COMPLET|DELIVER|PUBLISH|CONCLU)/) { want = "Done" }
          if (want != "" && want != l) {
            printf "DIVERGENCE: %s status=%s lane=%s want=%s\n", $1, $2, l, want; bad++ } }
        END { exit (bad ? 1 : 0) }' && \
  echo "zero divergences across every sync-owned card"
```

> **Three bugs review executed and caught in this one command.** Round 2: the
> first draft nested a ternary across newlines, and this box runs BWK `awk
> version 20200816` with no gawk, which rejects a line break before `:` — exit
> 2, so Group 1 could never have been validated. It also classified only three
> of six buckets, so a wrong Wish- or Review-lane card passed clean. A leading
> `jq … length == 10` was removed too: it passed against the unmodified board
> and carried an unreferenced `def want:`.
>
> *Live-state note:* `session-worktrees` is `SHIPPED`, not `APPROVED` as an
> earlier draft said, and it has **no card**. This wish has since entered
> `IN_PROGRESS`, so the live board now correctly has three `IN_PROGRESS` wish
> cards in Work: `app-auto-update`, `roadmap-truth`, and `terminal-splits`.
>
> Round 3 caught the subtle one: the six-bucket rewrite put `.done` **first**,
> so `^SHIP` shadowed `^SHIP-` and `SHIP-READY` resolved to `Done` where
> `FleetSnapshot.swift` gives `.ready` → Wish. The note here previously claimed
> the ladder matched Swift "exactly"; it did not. A correct genie implementation
> would have been reported as a divergence — **the oracle would have lied about
> working code.** The branches now mirror the Swift ladder top to bottom. No
> board wish carries a `SHIP-` status today, which is why only an execution-first
> reading found it, but `SHIP-` is live in the corpus Decision 3 cites and
> Group 1 AC2 drives a probe through `ready`.
>
> Verified falsifiable today — it reports the two `DRAFT` cards sitting in
> `Brainstorm` and exits 1, and will pass only once the reconcile lands.

**Genie tests this group must add** (so `npm run check` can fail on this
group's own behaviour rather than only on code the engineer chose to cover):
the lane map including `other → untouched`; the three-population rule; the
lane-existence guard; and the null-lane fallback.

**depends-on:** 0

---

### Group 2: Link an existing card to a wish (genie)

**Goal:** A hand-owned backlog card can become sync-owned without being
destroyed and recreated.

**Deliverables:**
1. A verb setting `--wish` (and optionally `--group`) on an existing card.
   `--wish` is accepted **only** by `genie task create` today.
2. The card retains its id, `createdAt`, and full timeline across the change.

**Acceptance Criteria:**
- [ ] `wish-scope` (`t_msf0mym5e7f7957f`, currently `wish: null`, `lane: null`,
      in the Idea group) is linked to the slug `wish-scope` and keeps its id,
      `createdAt` and full timeline.
- [ ] **It becomes an orphan, not sync-owned, and the reconcile leaves it in
      Idea.** There is no `.genie/wishes/wish-scope/` on disk and `wish-scope`
      is explicitly OUT of this wish — so linking it is precisely the orphan
      case, and **this is the only place the orphan rule gets exercised**, the
      board having none of its own. Do **not** create a stub `WISH.md` for an
      out-of-scope wish to force the sync-owned outcome.
- [ ] Linking to an absent wish is not an error — it produces an orphan.

> Plan review MED-3: the first draft asserted this card becomes sync-owned,
> contradicting the criterion below it and inviting an engineer to write a stub
> wish file. DESIGN.md:387 carried the qualifier — sync-owned *"once its wish is
> written"*, which is `wish-scope`'s job, not this one's.

**Validation:**
```bash
# genie's full gate — a new write verb on shared DB state needs typecheck and
# lint, not just the test runner.
# NOTE: genie is CWD-SCOPED. Run from ~/prod/genie, `genie task status` answers
# "Task not found" and `genie board --board roadmap` answers "Board not found"
# — the first draft never cd'd back and so could not pass (round 2 HIGH-3).
# CAPTURE FIRST — before running the link verb:
#   cd /Users/feliperosa/workspace/repos/remotty
#   genie task status t_msf0mym5e7f7957f | sed -n 's/^  Created: *//p' > /tmp/ws-created-before.txt
cd ~/prod/genie && npm run check && \
cd /Users/feliperosa/workspace/repos/remotty && \
  genie task status t_msf0mym5e7f7957f > /tmp/ws-card.txt && \
  grep -q '^  Wish:' /tmp/ws-card.txt && \
  [ "$(sed -n 's/^  Created: *//p' /tmp/ws-card.txt)" = "$(cat /tmp/ws-created-before.txt)" ] && \
  genie board --board roadmap --json | jq -e '
    [.lanes[] | select(.name=="Idea") | (.cards//[])[]
     | select(.id=="t_msf0mym5e7f7957f")] | length == 1' >/dev/null && \
  echo "linked; id and createdAt preserved; orphan left in Idea"
```

> **`createdAt` is compared before-and-after, not merely present.** A card that
> was destroyed and recreated also prints a `Created:` line, which is the exact
> failure mode AC1 exists to catch (round 3 MED-4). The `id` surviving is
> already proven by `genie task status <id>` resolving at all.
>
> A `Timeline:` grep was dropped: `wish-scope` has **no timeline block today**,
> so the check would have asserted a timeline was *created*, not preserved —
> and nothing in this group's deliverables requires the link verb to write one.
> If the timeline should record the link, make that a deliverable first.

**depends-on:** 0, 1

---

### Group 3: Revert logging and the read-only-`genie mcp` guarantee

**Goal:** The two behaviours the sync's honesty rests on are observable: a
silently reverted manual move is countable, and the reconcile has not leaked
into the read-only query surface.

**Deliverables:**
1. A hand `genie task move` on a sync-owned card is reverted **and logged**, so
   reverts can be counted — this is the detector the deferred manual-override
   trigger needs.
2. `genie mcp` performs no write.

**Acceptance Criteria:**
- [ ] Moving a sync-owned card by hand is reverted on next read, and the revert
      appears in a log that can be counted.
- [ ] `genie mcp`'s board tool succeeds against a **read-only database seeded
      with at least one sync-owned card in the wrong lane**, rather than failing
      with a write error.

> **Why the seeded divergence:** a reconciler that writes only when it finds a
> divergence issues no `UPDATE` against an already-reconciled database, so
> without the seed the assertion passes whether or not the reconcile leaked into
> the shared query layer. Read-only WAL access was checked and does not itself
> fail: `chmod 444` on `genie.db`, `-wal`, `-shm` plus `chmod 555` on the
> directory still serves reads.

**Genie tests this group must add**, so the gate can fail on this group's own
criteria rather than on whatever the engineer happened to cover: one asserting
a hand move on a sync-owned card is reverted **and logged countably**, and one
running `genie mcp`'s board tool against a read-only DB **seeded with a
divergence** (plan review LOW-4).

**Validation:**
```bash
# genie's full gate: touches the write path and the read-only server contract.
cd ~/prod/genie && npm run check
```

**depends-on:** 0, 1

---

### Group 4: `MERGED` buckets `.done` in both clients

**Goal:** A merged wish stops drawing under Idea in the sidebar.

**Deliverables:**
1. `MERGED` added to the `.done` prefix list in `FleetSnapshot.swift:592-609`.
2. The identical edit in `linux/shared/decode.js:218-226` — the two are
   deliberate twins and must stay identical.
3. A test per client pinning `MERGED → done`, alongside the existing `G`,
   `WAVE`, `SHIP-` pins (`FleetSnapshotTests.swift:182`,
   `linux/test/decode.test.js:221`).

**Acceptance Criteria:**
- [ ] `agent-parity` (status `MERGED — QA pending`) resolves to `.done` /
      `WishLane.done` in both clients, not `.other` / Idea.
- [ ] The two bucketing ladders remain identical in ordering and prefix set.
- [ ] **Sidebar-side only:** `agent-parity` resolves to `WishLane.done` in both
      clients, taking the count of sync-owned non-`.other` wishes from 9 to
      **10**. *Cross-surface agreement between sidebar and board is asserted in
      Group 6, not here* — the two `DRAFT` cards sit in board lane `Brainstorm`
      while `WishLane` has no such case (`WishRows.swift:117-122`, Decision 5
      maps `.draft → .idea`), so board and sidebar necessarily disagree on them
      until Group 1's reconcile runs. Asserting agreement in a group that
      declares `depends-on: none` would have made it unachievable
      (round 2 MED-1).
- [ ] `CHANGELOG.md`'s `## [Unreleased]` carries an entry: merging to `main`
      cuts a release (`scripts/bump.sh`, `bump.yml`), and this is a
      user-visible behaviour change.

**Validation:**
```bash
# Shared runtime behaviour reached by both clients' wish rendering, so both
# clients' full suites rather than a focused test.
# NOTE: `swift build` must run from `app/` — there is no root Package.swift,
# so a bare root-level `swift build` aborts before testing anything
# (plan review HIGH-1).
cd /Users/feliperosa/workspace/repos/remotty && \
  (cd app && swift build && swift test) && \
  (cd linux && npm test) && \
  awk '/^## \[Unreleased\]/{f=1;next} /^## \[/{f=0} f' CHANGELOG.md \
    | grep -q '[^[:space:]]' && \
  echo "both clients green; Unreleased section is non-empty"
```

> The CHANGELOG check is bounded to the `## [Unreleased]` section. `-A20` from
> that heading spilled 18 lines into the already-released `## [0.2.17]` block
> (`CHANGELOG.md:10` and `:12`), so a future release body could satisfy it with
> an empty Unreleased section — and a correct entry that avoided the grepped
> word would fail it (round 2 LOW-2). Non-emptiness is the honest assertion;
> the entry's content is a review matter, not a grep's.

**depends-on:** none

---

### Group 5: Contract truth and stale prose

**Goal:** The documentation stops asserting the world this wish just changed.

**Deliverables:**
1. `docs/state-json.md`: `board_cards[].wish` documented as populated in
   practice (it currently records `wish` empty on 17 of 17,
   `docs/state-json.md:213-215`); the `:208` status-vocabulary drift corrected
   (it claims `ready`/`done` only, while the fixture carries `in_progress`).
2. The **eight** stale "wish is always null" sites corrected —
   `docs/state-json.md:213-215`, `FleetSnapshot.swift:663`,
   `FleetRows.swift:540`, `BoardPane.swift:230`, `linux/shared/decode.js:277`,
   `linux/shared/rows.js:377`, `linux/renderer/js/labels.js:488`,
   `app/Tests/RemottyCoreTests/BoardRowsTests.swift:203`. All eight are
   comments and prose; behaviour branches on `wishSlug == null` and stays
   correct either way.
3. Two design-citation fixes in `.genie/brainstorms/roadmap-truth/DESIGN.md`
   (carried from round 4, explicitly non-verdict-changing): the
   board-resolution rule is at `scanners/extras.sh:173-174`, not `:143-146`
   (the quoted "otherwise the only board" clause sits at `:174`); and the
   Scope bullet's "six other places" should read
   **seven**, since Risk 5 and Criterion 10 carry the authoritative eight and
   one of those is the contract doc already counted separately.

**Acceptance Criteria:**
- [ ] No source, doc or test comment still claims `board_cards[].wish` is
      always or almost always null.
- [ ] `docs/state-json.md`'s card-status vocabulary matches the fixture.
- [ ] The two DESIGN.md citations resolve to the lines they claim.

> **DESIGN.md edit and the evidence stamp.** Editing DESIGN.md invalidates its
> `SHIP` digest by design. These two fixes are documentation-only and were
> explicitly ruled non-verdict-changing by the round-4 reviewer. Re-stamp only
> with a digest a **new** design review returns — never with a locally
> recomputed one.

**Validation:**
```bash
# Documentation-only group: content-contract checks over the files this group
# actually edits, not the runtime suites.
# The first assertion is a real sentinel: "17 of 17" occurs exactly 8 times
# today, one per cited site, and nowhere else in the repo.
# The previous `sed .. scanners/extras.sh | grep roadmap` check was replaced —
# it passed before any edit, never opened DESIGN.md, and covered only one of
# the two citation fixes (plan review MED-1).
cd /Users/feliperosa/workspace/repos/remotty && \
  test -d app -a -d linux -a -d docs -a -d bin -a -d scripts -a -d scanners && \
  ! grep -rn "17 of 17" app linux docs bin scripts scanners && \
  D=.genie/brainstorms/roadmap-truth/DESIGN.md && \
  test -f "$D" && \
  grep -q 'extras.sh:173-174' "$D" && \
  ! grep -q 'extras.sh:143-146' "$D" && \
  ! grep -qi 'six other places' "$D" && \
  ! grep -q 'were the only two on the measured board' docs/state-json.md && \
  echo "prose clean; both citations fixed; status vocabulary current"
```

> **Runs after Group 4, not beside it.** Both groups edit
> `app/Sources/RemottyCore/FleetSnapshot.swift` (`:592-609` vs `:663`) and
> `linux/shared/decode.js` (`:218-226` vs `:277`). The Execution Strategy makes
> the wave the parallelism unit, so two agents on one branch would collide
> (round 4 LOW).

> The status-vocabulary clause asserts the **drift is gone**, not that a word
> is present. `grep -q 'in_progress' docs/state-json.md` passed before any edit
> — `in_progress` already appears at `:364` — so it could not fail (round 2
> MED-3). The drift is the sentence at `docs/state-json.md:208`: *"`ready` and
> `done` were the only two on the measured board"*, while the fixture's
> `board_cards[].status` carries `in_progress`. That exact phrase is the
> sentinel. `test -f "$D"` guards the negations, since `! grep` also succeeds
> when the file is missing (round 2 LOW-3).

**depends-on:** 4

---

### Group 6: Fixture, probe cost, and the full gate

**Goal:** The committed contract fixture carries the new reality, and the cost
of reconcile-on-read is measured rather than assumed.

**Deliverables:**
1. Fixture regenerated through the shipped pipeline: capture →
   `scripts/sanitize-fixture.mjs` (drawing from `scripts/fixture-corpus.txt`,
   which throws `corpus [slugs] exhausted` at `:252` if the pool is short) →
   `scripts/leak-scan.sh --fixtures` via `scripts/smoke.sh:48`. The corpus
   may need new slugs for 10 wish-bearing cards.
2. `.genie/wishes/zz-sync-probe/` deleted **before** capture — the wish scraper
   (`scanners/extras.sh:101-115`) has no board scoping, so the probe wish
   appears in `wishes[]` and both sidebars regardless of which board its card
   sits on.
3. Probe wall-clock measured before and after on this fleet and recorded here.
4. Degradation proof, both halves: genie-side, force the reconcile to fail and
   assert `genie board --json` still returns every card; remotty-side, use
   `scripts/scanner-test.sh:114-128`, which already stubs `genie`, to make
   `board --board` exit non-zero and assert `scanners/extras.sh:154`'s
   `|| continue` does not swallow the project.

**Acceptance Criteria:**
- [ ] The fixture carries wish-bearing cards across three lanes and passes
      `leak-scan.sh --fixtures`. **Either shape is acceptable:** 10 wish-bearing
      cards if Group 2 has not landed, or 11 with one orphan row if it has.
      Group 6 deliberately does not depend on Group 2, so the capture's content
      varies with an ordering the DAG does not fix (round 2 LOW-6) — record
      which shape was captured.
- [ ] No `zz-sync-probe` row survives in the committed fixture.
- [ ] Probe wall-clock recorded. If it regresses past genie-board's stated 3 s
      threshold with ≥5 boards, the deferred caching trigger has fired and is
      filed as such rather than silently absorbed.
- [ ] Both halves of the degradation proof pass. **Hand-run and recorded** —
      no shell command covers this or the wall-clock measurement, by design.
- [ ] **Sidebar `WishLane` and board lane agree for all 10 sync-owned
      non-`.other` cards.** **Hand-run and recorded** — the sidebar lane is
      computed in-client and never reaches `state.json`, so no shell command
      can assert it; its components are covered transitively by Group 1's
      oracle and Group 4's per-client `MERGED → done` pins.
      This criterion has no other home: Group 4 cannot
      assert it (`depends-on: none`, and the two `DRAFT` cards disagree until
      the reconcile runs), and Group 6 is the only group downstream of both 1
      and 4. Round 3 MED-3 found it forwarded from Group 4 to nowhere.
- [ ] All gates green.

**Validation:**
```bash
# Aggregate gate: a contract/fixture change plus CI-gating scripts. `smoke.sh`
# IS the repository's documented full gate — sufficient justification for its
# scope on its own — and it already runs scanner-test.sh (:28), the swift gate
# from the right directory (:38) and the mockup gate (:54-55). The earlier command
# re-ran both and appended a root-level `swift build` that aborts, failing a
# green tree (plan review HIGH-1, LOW-2). Only the Linux suite is additional.
cd /Users/feliperosa/workspace/repos/remotty && \
  F=app/Tests/RemottyCoreTests/Fixtures/state-fixture.json && \
  test -f "$F" && \
  scripts/smoke.sh && (cd linux && npm test) && \
  test ! -d .genie/wishes/zz-sync-probe && \
  jq -e '[.. | objects | .board_cards? // empty | .[]]
         | map(select(.wish != null and .wish != ""))
         | (length >= 10) and ((map(.lane) | unique | length) >= 3)' "$F" >/dev/null && \
  echo "full gate green; fixture regenerated; probe wish removed before capture"
```

> **The shape assertion is what makes this group falsifiable.** Round 3 ran the
> previous chain on an untouched tree and every link passed — `smoke.sh` green,
> Linux 447/447, no probe directory — while the committed fixture still held
> **5 board cards across 2 lanes with 1 wish-bearing card**. `smoke.sh` catches
> a *broken* fixture, never an *unregenerated* one, and regeneration is this
> group's whole point. The `jq` above fails today and passes only after
> capture.

> **The probe check is on the source, not the fixture** — grepping the
> committed fixture for `zz-sync-probe` can never fail.
> `scripts/sanitize-fixture.mjs:457` rewrites every `row.slug` through the
> corpus map (and `:473` does the same for `row.wish`), so a captured probe
> ships under an `atlas-*` pseudonym and the literal string is impossible by
> construction (round 2 MED-2). The assertion that *can* fail is that the probe
> wish directory is gone before capture — which is the deliverable. `test -f`
> on the fixture path guards against a rename silently satisfying the chain
> (round 2 LOW-3).

**depends-on:** 1, 4, 5

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] **Functional** — open the remotty app on the `remotty` project: the board
      shows `agent-parity`, `first-run-wizard`, `genie-board`, `go-public`,
      `project-registry` and `settings-and-prereqs` in **Done**;
      `app-auto-update` and `terminal-splits` in **Work**; `agent-svg-icons` in
      the lane its status implies; the 11 backlog ideas still in **Idea**; and
      `wish-scope` in **Idea** with a dimmed orphan eyebrow (Group 2 linked it
      to a slug with no `WISH.md`).
      *`roadmap-truth`'s own card follows its own status* — Idea while this
      wish is DRAFT, Work once IN_PROGRESS, Done when shipped. Whatever lane it
      is in at QA time should match this WISH.md's Status field; that agreement
      is itself the feature working.
- [ ] **Functional** — the sidebar no longer lists `agent-parity` under Idea.
- [ ] **Integration** — change a wish's `WISH.md` status on disk, wait one
      refresh, and watch its card move lanes in the app with no other action.
      Change it back and watch it move back.
- [ ] **Integration** — the same board renders identically in the Linux client.
- [ ] **Regression** — the 11 hand-owned Idea cards and the 7 hand-owned Done
      cards have not moved; no card gained a blocked badge.
- [ ] **Regression** — the sidebar's wish list, its in-flight cap and its
      grouping switch behave as before; no new lane appears in the sidebar.
- [ ] **Regression** — a project with no genie board still renders its three
      empty states correctly (`genieMissing` / `noBoard` / `boardEmpty`).

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| **Cross-repo dependency.** The sync is genie-side; remotty's half cannot be validated end-to-end until genie ships it. | High | Groups 4-5 are genuinely independent and ship either way. Group 6 is the joint gate. The fixture regenerated from this repo's populated board (11 wish-bearing cards, 3 lanes, including one orphan) is the artefact that makes remotty's half testable. |
| **Three implementations of one bucketing**, two repos, three languages: `FleetSnapshot.swift:592-609`, `linux/shared/decode.js:218-226` (already exact twins), genie's new one. | Medium | Decision 6 makes genie's a rename, not an independent authoring. Group 4's third acceptance criterion asserts agreement by count (10 vs 9). |
| **A wish's `WISH.md` status can be wrong**, and the sync propagates it faithfully. `project-registry` read `SHIPPED` and had to be checked against `origin/main` (genuinely merged, PR #23 / 0.2.17). | Low | Accepted: the sync makes the board agree with the wish; it does not audit the wish. A wrong status becomes visible in one more place, which surfaces the error rather than hiding it. |
| **Reconcile-on-read turns a read verb into a writer.** `scanners/extras.sh:135-154` calls genie twice per project per host per 60 s probe, each guarded by `\|\| continue` — a failure silently drops the whole board. | Medium | Decision 7 confines the reconcile to the CLI path; Group 3 proves `genie mcp` stays read-only against a seeded divergence; Group 6 proves degradation serves the stored lane. SQLite lock contention when both clients probe one host is the case to watch. |
| **genie's MCP surface serves a stale stored lane** until a CLI read reconciles — and remotty's probe is the only routine CLI reader. | Medium | Accepted: the stored lane is never *wrong*, only as fresh as the last CLI read, and the MCP surface is a query tool rather than the board people look at. If MCP consumers start acting on lanes, the reconcile belongs in the shared layer with an explicit write, reopening the risk. |
| **The task database is machine-local** (`.gitignore:8`) and `.genie/roadmap.json` does not exist. Wish/brainstorm documents publish, but live task events still need an explicit backup. | Medium | Out of scope by decision. `genie task export` is the manual backup and was used before the 2026-08-04 cleanup (65 818 bytes). Deferred behind a stated trigger. |
| **`agent-svg-icons` moves Brainstorm → Idea** on first sync. | Low | Intended under Decision 5 and named so it is not mistaken for a regression — it is the visible proof the sync ran. |
| **Feature parity is mandatory** — a feature in one client is drift. | Medium | Both clients in Group 4; the mockup gate runs in Group 6; deliberate divergence recorded in `linux/README.md`. |

---

## Review Results

_The read-only reviewer returns evidence; the invoking orchestrator appends a timestamped block here after plan, execution, and PR reviews._

### Execution re-review — SHIP (fix round 1, 2026-08-06)

Independent re-review at `21350f7f6` (docs-only above `40ad3d050`; code verdict
from round 1 stands). All eight FIX-FIRST gaps verified closed: the ledger
amendment and Fix record resolve both CRITICALs — the process gate closed "by
the strongest available route: reversal rather than retroactive consent"; the
reviewer confirmed the blanket fix directive was not laundered into approval
of the promote, and a fresh explicit user order remains required before any
future promote. The committed WISH.md is byte-identical to the working tree;
PR #2751 (OPEN, MERGEABLE, base `dev`) carries the disclosures.

Residuals carried forward, none blocking: (1) Group 1 AC1/AC2 and Success
Criteria 1–2 are **deferred, not satisfied** — the lane-divergence oracle and
`zz-sync-probe` walk must run against the shipped binary post-release and need
an owner (tracked as a follow-up task card on this wish); (2) the merge
advances dev's `.well-known` manifests to main's values — net-nil, declared,
worth a merger's glance; (3) local gate exits 1 on bun 1.3.9 (< engines
requirement) — CI on bun 1.3.11 is the authority (3017/0/11 skips).

**Verdict:** SHIP · **Reviewer:** independent genie execution reviewer ·
**Reviewed at:** 2026-08-06T22:15Z

### Fix record — 2026-08-06 (resolving the FIX-FIRST below, per user directive "fix everything")

Decisions taken by the orchestrator on the user's blanket fix authorization,
choosing the reversible branch of each open question:

- **Promote (both CRITICALs):** the revert is **accepted**; no re-promote was
  performed. Re-promoting a wish-branch build machine-wide was explicitly held
  once (HANDOFF §5) and the release channel has since reclaimed the binary, so
  the feature reaches this machine through merge + release of PR #2751 instead.
  A re-promote remains available on explicit user order. The 2026-08-05
  execution record above now carries a dated amendment stating the revert and
  the test-evidence basis for Groups 1–3.
- **HIGH, live oracles:** Group 1's divergence comparison and probe walk are
  deferred to the first post-release run of the shipped binary; the ledger no
  longer implies they are reproducible today.
- **HIGH, untracked wish docs:** `.genie/wishes/roadmap-truth/` and
  `.genie/brainstorms/roadmap-truth/` are committed onto `wish/roadmap-truth`
  (PR #2751) so the branch carries its plan, execution record, and reviews.
  (The docs were also recovered on 2026-08-06 from the remotty repo, where the
  authoring session had written them; remotty copies removed in remotty
  `25784b6`.)
- **MEDIUM, branch base:** recorded — base is `dev` @ `6d252e65c`, not
  `origin/main` as Group 0 AC1 wrote; benign because the tree differs from
  `origin/main` only in `.well-known` manifests, which `40ad3d050` pins to
  main's exact values. Declared in the PR body.
- **MEDIUM, `.well-known` edits:** declared in the PR body as net-nil
  release-surface edits.
- **LOW, Group 0 AC5:** the build artifact and timestamp were never recorded
  and the binary is gone; unrecoverable, moot under the accepted revert.
- **LOW, Group 0 D2:** decision stated — the seven version-stamp files
  (`5.260805.1`) land in the PR; dev is behind at `5.260803.6`, the merge moves
  forward, and `[auto-version]` CI owns the final stamp.
- **LOW, `task link` group-clearing:** accepted as designed — documented in the
  doc comment and pinned by a test; revisit only if a real workflow trips it.

### Execution review — FIX-FIRST (2026-08-06, post-relocation re-review)

Context: the wish documents were recovered from the remotty repo (where the
authoring session had written them) and relocated here on 2026-08-06. An
independent reviewer then re-reviewed the genie branch `wish/roadmap-truth`
pinned at `40ad3d050` in a detached snapshot worktree. The code quality
verdict is strong; the gaps are machine state, process, and ledger truth.

- **CRITICAL — Group 0's end state no longer holds.** `~/.genie/bin/genie` is
  byte-identical (sha `85d3956b…`) to the pre-wish backup
  `.previous/genie-roadmap-truth-start-5.260803.7`; `~/.genie/bin/VERSION`
  reads `5.260803.7`. The promote recorded above ("promoted and installed
  `5.260805.1`") ran but was fully reverted by an update-driven swap on
  2026-08-06 ~17:14 (retired `.previous/genie-prior-8dd2b782…` contains the
  `wish-status-sync` and `task link` marker strings). Every live-observation
  criterion for Groups 1–3 is currently unreproducible on this machine.
- **CRITICAL — the promote overrode the recorded hold** (HANDOFF §5: "remotty
  groups only, stop before the promote"). No artifact records the user
  re-authorizing it. Requires an explicit user decision before this branch
  advances.
- **HIGH — Group 1's live oracles unrecorded**: the lane-divergence comparison
  (AC1) and the `zz-sync-probe` lifecycle walk (AC2) appear nowhere in the
  ledger, commits, or task stage logs; unit tests (177 pass) cover the mapping
  but are not the specified live proof.
- **HIGH — wish directory untracked in genie**: no committed record of plan,
  execution, or reviews on the branch. Fix: commit
  `.genie/wishes/roadmap-truth/` and `.genie/brainstorms/roadmap-truth/`.
- **MEDIUM** — branch base is `dev` @ `6d252e65c`, not `origin/main` (Group 0
  AC1 as written); materially benign — tree differs from `origin/main` only in
  `.well-known` manifests, which `40ad3d050` sets to main's exact values.
- **MEDIUM** — `.well-known` channel-manifest edits are outside the wish's
  file list; net-nil but must be flagged in the PR body.
- **LOW** — Group 0 AC5 artifact/timestamp unrecorded; Group 0 D2 decision on
  the seven version-bumped files unstated; `task link` with `--group` omitted
  clears an existing group (documented + tested, still a footgun).

Validation in snapshot: `bun run check` exit 1 — all static gates green;
`bun test` 3016/3028 with 12 failures in files untouched by this branch
(bun 1.3.9 here vs required ≥1.3.10; the pinned bun 1.3.11 ledger run above
recorded the same 3,028 total as 3,017 pass + 11 skips). The four
branch-touched test files pass 177/0 in isolation. Genie PR #2751 remains
OPEN, unmerged.

**Verdict:** FIX-FIRST · **Reviewer:** independent genie execution reviewer
(pinned snapshot, read-only) · **Reviewed at:** 2026-08-06T22:01Z ·
**Shortest path to SHIP:** user decision on the promote; commit the wish
directory; then either re-promote + capture the live oracles, or amend this
ledger to state Groups 1–3 rest on test evidence with the promote reverted.

### Execution record — 2026-08-05

- **Groups 0–3 (genie):** promoted and installed `5.260805.1`; added the
  CLI-only lane reconciler, hardened wish reads, idempotent `genie task link`,
  manual/sync provenance coverage, and an immutable MCP proof. The pinned Bun
  1.3.11 gate passed with 3,017 tests, 11 environment skips, and 0 failures.
  The implementation is published for review as genie PR #2751; all 17 hosted
  checks are green.
  *[Amended 2026-08-06: the promote described above was fully reverted by an
  update-driven swap at ~17:14 the same day — `~/.genie/bin/genie` is again the
  pre-wish `5.260803.7` binary. The live observations in this record were made
  while the promoted build was installed and were true then; they are not
  reproducible on the current machine. Groups 1–3 now rest on committed test
  evidence (177/0 in the four branch-touched files) pending merge and release
  of PR #2751. See the FIX-FIRST review and Fix record below.]*
- **Groups 4–5 (remotty):** Swift and Linux now map `MERGED` to Done with
  identical ladders and explicit `WAVE`/`SHIP-` shadow pins. All affected
  comments, docs, tests, and DESIGN citations use the measured 17 hand-owned /
  11 wish-bearing population.
- **Probe timing:** five comparable installed-genie extras samples were
  2.19, 2.20, 2.20, 2.27, and 2.26 seconds (median **2.20 s**). Five full
  shipped-state samples were 8.21, 7.95, 7.97, 7.76, and 7.81 seconds (median
  **7.95 s**). The measured fleet has one board, so the stated cache trigger
  (at least five boards and more than 3 seconds) did not fire.
- **Degradation, hand-run:** a forced SQLite task-update failure left
  `genie board --json` at exit 0, returned all three seeded card/lane pairs,
  and left task/event snapshots byte-identical; removing the trigger reconciled
  both divergent sync-owned cards. With a failing stubbed `board --board`,
  Remotty extras also exited 0, retained its project/conversation/wish rows
  (`CONVO=1`, `WISH=1`), emitted no partial lane/card rows, and cleaned its
  scratch state.
- **Cross-surface, hand-run:** all 10 sync-owned non-`.other` cards agreed
  between `WishLane` and the reconciled board (10 good, 0 divergent). Done:
  `agent-parity`, `first-run-wizard`, `genie-board`, `go-public`,
  `project-registry`, `settings-and-prereqs`; Work: `app-auto-update`,
  `roadmap-truth`, `terminal-splits`; Idea: `agent-svg-icons`. The eleventh
  wish-bearing card, `wish-scope`, remained the deliberate orphan and was
  excluded from the agreement count.
- **Final fixture/privacy:** SHA-256
  `37c10b28e1572ff0d196d3c3e1cd1cd93d7477e80f424a7be07a1adef4759d40`;
  11 wish-bearing cards across Done/Idea/Work, 15 worktrees, 13 manifest joins,
  15 agent sessions, 11 conversation-id joins, and 15 pid/cwd joins. Duplicate
  UUID equivalence is preserved; sanitizer suffix boundaries 2/9/10/19/20/100
  are idempotent; the second pass changed 0 of 4 files. The owner-only raw
  capture was removed after fixture-only and tree-wide leak scans passed.
- **Aggregate gates:** `scripts/smoke.sh` passed (Swift 587 tests in 85 suites,
  scanner/installer/worktree/mockup/leak gates green); Linux passed 464/464;
  `git diff --check`, sanitizer `--check`, fixture leak scan, and full-tree leak
  scan all passed. `zz-sync-probe` is absent.
- **Residual risk:** delivery spans two independently reviewed PRs. MCP keeps
  the stored lane until a CLI board read reconciles it by design; the measured
  one-board fleet did not exercise the deferred multi-board cache trigger.

### Execution review — SHIP (2026-08-06)

The independent re-review closed every prior FIX-FIRST finding: mandatory
Group 6 timing/degradation/cross-surface evidence is recorded; generated
suffixes including 10/19/100 are closed over sanitizer output; all Group 5
comments and DESIGN/WISH citations are current; Linux pins `WAVE` and `SHIP-`;
fixture tests pin 15 worktrees and 13 manifest joins; and the leak scanner
enforces `<safe-label>-<agent>(-N)?` manifest keys.

The reviewer also independently verified the new `agent_sessions` privacy
boundary and fixture equivalence: 15 agent sessions, 11 conversation-id joins,
15 pid/cwd joins, 13 unique agent IDs, and two duplicate-ID groups preserved.
Sanitizer `--check`, JavaScript/shell syntax, Group 5's current content oracle,
and `git diff --check` passed. No undeclared blocker remains; residual risks
are the cross-repo delivery order, intentionally stale MCP reads until the next
CLI reconciliation, and the untriggered multi-board cache threshold.

After the verdict, Group 6 task `t_msf5ihf1255d9beb` was marked Done. A CLI
board read reconciled this wish's `REVIEWED` status from Work to Review; the
umbrella roadmap card remains Ready for merge/release lifecycle ownership.

**Verdict:** SHIP · **Reviewer:** independent genie execution reviewer ·
**Reviewed at:** 2026-08-06T05:47:00Z

### Plan review — SHIP (4 rounds, 2026-08-04)

**Round 4 — SHIP.** Fresh independent reviewer, execution-first. Every group's
validation was run: all seven parse, and **all seven correctly fail today** with
the work undone. The two oracles that could report correct work as broken were
tested against that specifically — Group 1's ladder with 22 injected statuses
(`SHIP-READY`→Wish, `EXECUTED`→Review, `EXECUTING`→Work, `PLAN-REVIEWED`→Review,
`PLAN-READY`→Wish, `WAVE-3`→Work, `G`→untouched), and Group 6's `jq` against a
synthetic regenerated fixture. 24 line citations re-verified at `fd32117`.

Rounds 1-3 were FIX-FIRST (4 HIGH, 3 HIGH, 1 HIGH). What each caught:

| Round | Finding that mattered most |
|---|---|
| 1 | `swift build` aborts at the repo root (`Package.swift` is at `app/`), so Groups 4 and 6 could never pass — and in Group 6 the chain died *after* `smoke.sh` had already run the swift gate correctly, failing a green tree. Also: **writing this WISH.md is what made `roadmap-truth` sync-owned**, falsifying five orphan claims including an AC that would have read a correct sync as a bug. |
| 2 | Three groups carried commands that could not run: `build:binary` exits 2 without `--platform`; the awk was a syntax error on this box's BWK `awk 20200816`; Group 2 never `cd`'d back and genie is cwd-scoped. Plus the fixture probe grep could never fail — `sanitize-fixture.mjs:457,473` rewrites slugs through the corpus. |
| 3 | The version guard **deadlocked the wish**: `origin/main`'s `package.json` is `5.260803.6` against an installed `5.260803.7`, so fetching does not clear it — hence `npm run version` as a deliverable. And the awk ladder put `.done` first, so `^SHIP` shadowed `^SHIP-` and the oracle would have reported a *correct* implementation as a divergence. |
| 4 | One MED: the branch **name** was checked but not its **base** — `checkout -b` from the current `feat/kimi-plugin` (101 commits behind `origin/main`) would have passed, stamped a newer version, satisfied the guard, and installed a machine-wide genie missing 101 commits while printing success. |

**Applied after the SHIP verdict** (round 4's MED plus its five LOWs, none of
which change a group, criterion or dependency): the `git merge-base
--is-ancestor origin/main HEAD` base check; genie's rollback verb documented as
**disabled** (`update.ts:846-856` throws), so AC3's restore is a manual file
swap; Group 6 AC5 labelled hand-run, since the sidebar lane is computed
in-client and never reaches `state.json`; Group 5 given `depends-on: 4` (they
edit two files in common); `DESIGN.md:387` citation corrected; the missing-path
guard extended to all six greps; and `session-worktrees` recorded as `SHIPPED`.

**Verdict:** SHIP · **Reviewer:** genie:reviewer (Opus 5, round 4, fresh —
authored none of rounds 1-3) · **Reviewed at:** 2026-08-04T22:00:13Z

---

## Files to Create/Modify

```
# genie (~/prod/genie) — branch wish/roadmap-truth off main — Groups 0, 1, 2, 3
  <build + install step so the edited genie IS the installed genie>   # Group 0
  <lane reconciliation on the CLI board-read path>                    # Group 1
  <bucketing: a rename of remotty's Wish.StatusCategory>              # Group 1
  <tests: lane map, three populations, lane guard, null-lane fallback># Group 1
  <verb setting --wish on an existing card>                           # Group 2
  <revert logging + read-only-mcp test with a seeded divergence>      # Group 3

# remotty — Group 4
app/Sources/RemottyCore/FleetSnapshot.swift          # MERGED -> .done (:592-609)
linux/shared/decode.js                               # identical twin (:218-226)
app/Tests/RemottyCoreTests/FleetSnapshotTests.swift  # pin MERGED -> done
linux/test/decode.test.js                            # pin MERGED -> done
CHANGELOG.md                                         # [Unreleased] entry — merging releases

# remotty — Group 5
docs/state-json.md                                   # :208 drift, :213-215 wish-null
app/Sources/RemottyCore/FleetSnapshot.swift          # :663 comment
app/Sources/RemottyCore/FleetRows.swift              # :540 comment
app/Sources/Remotty/BoardPane.swift                  # :230 comment
app/Tests/RemottyCoreTests/BoardRowsTests.swift      # :203 comment
linux/shared/decode.js                               # :277 comment
linux/shared/rows.js                                 # :377 comment
linux/renderer/js/labels.js                          # :488 comment
.genie/brainstorms/roadmap-truth/DESIGN.md           # 2 citation fixes — tracked

# remotty — Group 6
app/Tests/RemottyCoreTests/Fixtures/state-fixture.json   # regenerated
scripts/fixture-corpus.txt                               # slugs, if exhausted
```
