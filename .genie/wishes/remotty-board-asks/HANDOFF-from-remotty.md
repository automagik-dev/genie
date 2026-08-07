# Handoff — genie asks, from remotty

**2026-08-07.** Five things remotty needs from genie. All were found by building
against genie, not by reading it. Nothing here is urgent or broken.

Context: remotty renders the genie roadmap board in two GUI clients. It reads
`genie board --board <ref> --json` and never writes. Where genie's data can't
express something, remotty draws nothing rather than guessing — so each gap below
shows up as a feature remotty can't ship.

---

## Already resolved — no action

remotty originally asked genie to **derive card lanes from `WISH.md` status on
read**. You shipped something better instead: lanes stay hand-set, and
`genie doctor`'s `jar: index-lane drift` lint-checks them against `.genie/INDEX.md`.

That is more deterministic than what was asked for. `wishes[].status` is free
text — one snapshot carried 31 distinct values including `G`, `IN`, `SHIP-` and
`WAVE` — so deriving lanes from it would have made the board's correctness
depend on prose nobody validates. The lint compares two things a human wrote and
fails loudly. Right call; the request is withdrawn.

The `tasks.wish` broadening (a slug valid from `.genie/brainstorms/<slug>/`
onward, not from `WISH.md` onward) is also strictly better and is what remotty
now models against.

---

## 1. No way to attach a wish slug to an existing card

`--wish` is accepted **only** by `genie task create`. Verified on the installed
build — the verb list is `block checkout comment create done export heartbeat
help import list move release report status sync unblock`.

So the ordinary lifecycle — a backlog idea becomes a real line of work — cannot
be represented. The only path is delete-and-recreate, which loses the card id and
its timeline. And there is no delete verb either (see 4), so in practice the old
card just stays.

**Ask:** a verb setting `wish` (and optionally `group`) on an existing card,
preserving `id`, `createdAt` and timeline.

**Why remotty cares:** remotty joins cards to wishes on this slug. A card that
can never gain one is permanently unjoinable.

## 2. `genie board --json` exposes no blocked state

`genie task block <id> --reason …` records the block — `genie task status` shows
`Blocked by: …`. But the card serialises without it. Measured keys:

```
boardId claimedAt claimedBy createdAt group id lane status title updatedAt wish
```

`status` stays `ready` on a blocked card, so the block is invisible to any client
reading the board.

**Ask:** surface it on the card — either a `blocked`/`blocked_reason` pair, or by
letting `status` carry `blocked`.

**Why remotty cares:** both clients already render a blocked badge and have since
before this was noticed. `FleetSnapshot.swift` tests `status == "blocked"`, which
genie never emits, so the badge is unreachable code. Nothing needs building on
remotty's side — it needs a source.

## 3. `genie task block` means two different things

On remotty's own board, the two blocked cards are:

| card | reason |
|---|---|
| `app-auto-update` | "blocked per WISH.md" — genuine work-block |
| `terminal-splits` | "Not a work item: wish-level placeholder … Do not claim." — administrative marker |

Both use the same mechanism. So even after (2), remotty would paint a red
"blocked" badge on a card that is merely not-claimable — 1 of 2 wrong on the only
sample that exists.

**Ask:** separate *work is blocked* from *do not claim this card*, whether as two
verbs, a kind on the block, or a distinct status.

**Why remotty cares:** this is the single reason the blocked badge stayed out of
scope. (2) and (3) together are what make it shippable, and it costs remotty
nothing once both land.

## 4. No delete verb

A card created by mistake is permanent. There is no `delete`/`remove`/`archive` on
`genie task` or `genie board`; the only removal path is `export`, hand-edit,
`import`, which rewrites whole-DB state.

**Ask:** a scoped delete, or an explicit statement that cards are immutable by
design so callers stop looking.

**Why remotty cares:** minor, but it shaped a test plan — a throwaway probe card
had to be created on a throwaway *board* purely because it could never be
removed from the real one.

## 5. `jar: index-lane drift` skips silently in two directions

The lint matches an INDEX entry to its card by the first markdown link to
`brainstorms/<slug>/…` or `wishes/<slug>/…` (`doctor.ts:1786`), then compares
section to lane. Two blind spots, both quiet:

- **An entry with no such link is `unlinked` and never checked**
  (`doctor.test.ts:1855`). Removing a link silently drops that line from
  verification instead of failing.
- **A link whose target file does not exist still counts `ok`.** The lint reads
  the path, not the file.

Together these invert: a *broken* link passes, a *missing* link is skipped. Hit
directly — an entry pointed at a `WISH.md` that had been deleted and reported
`ok`; removing the dead link changed it to `unlinked`, i.e. from wrong-but-checked
to not-checked.

Current on remotty: `8 entries — 5 ok, 0 drift, 3 unlinked`.

**Ask:** resolve the link target and fail when it is missing; report `unlinked`
as a warning rather than silence.

---

## How to check any of this quickly

```bash
cd /Users/feliperosa/workspace/repos/remotty
genie board --board roadmap --json | jq -c '[.lanes[]|(.cards//[])[]][0]|keys'   # 2
genie task --help                                                                # 1, 4
genie doctor 2>&1 | grep 'jar: index-lane'                                       # 5
```

remotty's side of this work is a separate document: `HANDOFF-remotty.md`, beside
this one. It needs nothing from genie to proceed.
