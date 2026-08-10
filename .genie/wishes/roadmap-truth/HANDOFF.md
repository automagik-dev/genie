# Handoff — `roadmap-truth`

**Written 2026-08-05.** Read this, then `.genie/wishes/roadmap-truth/WISH.md`.
Everything below was verified by running it, not recalled.

---

## 1. Read this first — the state you are inheriting

| | |
|---|---|
| **Branch** | `wish/roadmap-truth`, cut from `main` at `fd32117` |
| **Commits** | **none.** The entire deliverable is **uncommitted** in the working tree |
| **Deliverable** | 11 files, `+51 −28` |
| **Wish status** | `IN_PROGRESS` |
| **Groups done** | 4, 5 (of 0-6) |
| **Gates** | Swift 512/512 · Linux 415/415 · `scripts/smoke.sh` all green |

**Nothing is committed.** Merging to `main` cuts a release (`scripts/bump.sh`,
`bump.yml`), so the previous session held. Committing and opening a PR is a
user decision, not a default.

The uncommitted 11 files:

```
CHANGELOG.md
app/Sources/Remotty/BoardPane.swift
app/Sources/RemottyCore/FleetRows.swift
app/Sources/RemottyCore/FleetSnapshot.swift
app/Tests/RemottyCoreTests/BoardRowsTests.swift
app/Tests/RemottyCoreTests/FleetSnapshotTests.swift
docs/state-json.md
linux/renderer/js/labels.js
linux/shared/decode.js
linux/shared/rows.js
linux/test/decode.test.js
```

---

## 2. Two traps specific to this branch

**(a) `.genie/` is ignored here, tracked on `wish/terminal-splits`.**
`.gitignore:8` on `main` (and so on this branch) is `/.genie`. PR #25 flips it to
`/.genie/genie.db*` and rewrites CLAUDE.md's guard rail — **that policy change
exists only on #25.** Consequences:

- The three `roadmap-truth` planning files (WISH.md, DESIGN.md, DRAFT.md) are on
  disk but deliberately **untracked** here. Do not `git add` them: it force-adds
  past `.gitignore` and turns `scripts/leak-scan.sh` red with 7 hits (the author
  name plus six `/Users/feliperosa/...` paths inside the wish's own validation
  commands). This already happened once and was reverted.
- **18 other `.genie` files are missing from the working tree** — the other
  wishes and brainstorms. They are tracked only on `wish/terminal-splits`, so
  checking out a branch off `main` removes them. **Nothing is lost**; they are
  committed on #25. Restore with:
  `git checkout wish/terminal-splits -- .genie/wishes .genie/brainstorms`
  (the user was offered this and has not answered).

**(b) `swift build` does not work from the repo root.** `Package.swift` lives at
`app/Package.swift`. Always `(cd app && swift build && swift test)`.
`scripts/smoke.sh:38` already does this correctly.

---

## 3. What was delivered (Groups 4 and 5, both SHIP)

**Group 4 — `MERGED` buckets `.done`.** `MERGED` matched no prefix in
`Wish.StatusCategory`, so it fell to `.other` → `WishLane.idea`, and
`agent-parity` — merged and released — drew under **Idea** in the sidebar. One
line appended to the `.done` branch in `FleetSnapshot.swift:608` and its twin
`linux/shared/decode.js:227`, plus a pin per client on the real status string
`MERGED — QA pending` (em dash U+2014).

Proof it landed: sync-owned non-`.other` wishes go **9 → 10**, `agent-parity`
the sole card requiring it. Reviewer measured zero re-bucketing across all 31
fixture statuses plus 11 adversarial cases.

**Group 5 — contract truth.** `docs/state-json.md`'s `board_cards[].wish`
paragraph and its `:208` status-vocabulary drift, the eight stale "wish is null
on 17 of 17" comments, and two citation fixes in DESIGN.md
(`scanners/extras.sh:143-146` → `:146-150`; "six other places" → seven).
Comment-and-prose only; no logic.

---

## 4. What remains — and it is the whole point of the wish

**The board still does not move by itself.** Groups 4-5 fixed the *sidebar* and
the *documentation*. Lanes still change only when a human runs `genie task move`.

Measured 2026-08-05, ~2 h after the board was hand-corrected — **already
drifting**:

```
agent-svg-icons   DRAFT        board=Brainstorm   should be Idea
roadmap-truth     IN_PROGRESS  board=Wish         should be Work
```

The second is self-inflicted: the previous session set the wish `IN_PROGRESS`
and its card stayed put. That is the bug, live.

| Group | Task id | Repo | What |
|---|---|---|---|
| **0** | `t_msf5yy2afc156564` | genie | **Prerequisite, and the risky one.** Make the edited genie the *installed* genie. |
| **1** | `t_msf5ih6d2be03a35` | genie | **The actual feature.** Reconcile every sync-owned card's lane from its wish's `WISH.md` status on read. |
| **2** | `t_msf5ih83668de5d8` | genie | A verb to set `--wish` on an existing card (`--wish` is create-only today, so a backlog idea cannot become a wish card without losing its id and timeline). |
| **3** | `t_msf5ih9tc70c905a` | genie | Revert logging (so a sync-overwritten hand move is countable) + prove `genie mcp` stays read-only against a **seeded divergence**. |
| **6** | `t_msf5ihf1255d9beb` | remotty | Regenerate the fixture (still **5 cards / 2 lanes / 1 wish-bearing**), measure probe wall-clock, degradation proof, cross-surface agreement, full gate. |

Group 6 is remotty-side but cannot be pulled forward — it needs Group 1's
reconcile running to have something true to capture.

**Unmet:** Success Criteria 1-4 and 7-9, and every QA criterion depending on the
sync.

---

## 5. Why execution stopped — do not restart it silently

Group 0 **promotes a freshly built genie binary to `~/.genie/bin/genie`**, the
binary every shell on this machine runs. The user explicitly chose *"remotty
groups only, stop before the promote"*. **That decision has not been revisited.
Do not run Groups 0-3 without asking again.**

Three facts that made it worth asking:

1. **Rollback is manual.** `rollbackBinaryAt` (`~/prod/genie/src/genie-commands/update.ts:846-856`)
   throws unconditionally — *"Automatic rollback is disabled."* `.previous/` is
   written on swap, but restoring is a hand file swap.
2. **`~/prod/genie` sits on `feat/kimi-plugin`, 101 commits behind `origin/main`.**
   Group 0's guard checks the branch *name* and its *base* (`git merge-base
   --is-ancestor origin/main HEAD`) precisely because of this.
3. **A naive build downgrades the machine.** Installed genie is `5.260803.7`;
   `origin/main`'s `package.json` is `5.260803.6` — genie stamps release
   versions outside `package.json` on main. So `npm run version` is a
   *deliverable*, not an assumption, or the version guard deadlocks the wish.
   `npm run build:binary` also needs `-- --platform darwin-arm64` (exits 2
   without it).

---

## 6. Corrections carried forward — do not re-derive the wrong version

- **`leak-scan.sh` *does* exempt `.genie`** — PR #25 ships the exclusion at
  `scripts/leak-scan.sh:321` (`':(exclude).genie'`) alongside the tracking
  policy. An earlier claim that it did not was wrong; the exemption is a
  pathspec on the grep, not an allowlist entry. The 23 name/path hits in #25's
  tracked `.genie` files do **not** fire.
- **PR #25's red smoke is a `RefreshScheduler` failure**, not leak-scan (Swift
  runs at `smoke.sh:38`, leak-scan at `:45`, so the scan is never reached).
  It does not reproduce locally: 512/512 pass here.
- **The one real residual:** the `.genie` exclusion is **tree-mode only**;
  `--history` still scans every blob. `.genie` must be scrubbed or stripped from
  history before the repo goes public. #25 records this in its own comment at
  `leak-scan.sh:313-318`. Repo is private today, so this is deferred.

---

## 7. Process notes worth inheriting

**Both engineer subagents returned no completion report.** `g4-merged` and
`g5-prose` each went idle with no final message. Both had done correct work, but
nothing was taken on trust: the orchestrator read both diffs, ran every gate
itself, and dispatched an independent reviewer per group. **Two idle returns in
a row is the point at which dispatching more stops being the cheaper path** —
consider doing Group 6 in-session if you get there.

**Review earned its keep on every single round.** Design took 4 rounds
(FIX-FIRST ×3), plan took 4 (FIX-FIRST ×3), and each execution group took 2. The
findings that mattered were never stylistic:

- Design r1: the first approach was already tried and deleted by genie-board's
  Decision 10; and the card↔wish rendering *already ships*, so four criteria
  were passing vacuously.
- Design r3: a rationale built by merging two populations (2 of 4 blocked
  markers were on boardless tasks no client sees).
- Plan r2/r3: three groups had validation commands that **could not run** (awk
  syntax error on BWK awk, wrong cwd, missing `--platform`), and one oracle
  would have reported *correct* work as broken (`^SHIP` shadowing `^SHIP-`).
- Exec: Group 5's engineer replaced "null on 17 of 17" with "every hand-owned
  **backlog** card" — false for 7 of 18 (shipped M1 milestones in `Done`).

**The lesson that keeps recurring:** a confident statement that stopped being
true. That is also what the wish itself is about.

---

## 8. Suggested first moves

1. `git status --short` — confirm the 11 files are still there and uncommitted.
2. `(cd app && swift build && swift test) && (cd linux && npm test) && scripts/smoke.sh`
   — confirm still green before touching anything.
3. Ask the user the three open questions:
   - Commit and open a PR for the remotty half?
   - Restore the 18 missing `.genie` files?
   - Proceed with the genie promote (Groups 0-3, then 6)?

Do not mark any group done without an independent review and a passing
validation run — `genie task done` is orchestrator-only.
