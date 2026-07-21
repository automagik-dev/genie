# Live dogfood — boards-first-class on the shipped binary (2026-07-21)

**Build under test:** installed `genie 5.260721.7` (dev channel; contains #2611 merge `fa163bd2`).
**Method:** real CLI invocations only — fresh tmp repo for e2e, Felipe's live roadmap for the
data-loss check. Script: session scratchpad `dogfood-qa.sh`; raw output reproduced below in part.

## Update path (obstacles found + resolved)

1. Release race: first `genie update` resolved `.5` while `.6` published mid-flight.
2. Channel manifest lag: releases `.6`/`.7` existed before the `Version` manifest-advance ran.
3. **Real find: `~/.genie/bin` was mode 777** — the updater's promote-gate refused
   (`GENIE_HOME/bin has unsafe permissions`). Correct behavior; fixed to 755.
4. Lifecycle lease contention from a concurrent update loop — lease held exactly as designed.

## QA #1 — fresh-repo e2e: PASS

`genie idea "test the shipped kanban"` → card in roadmap/Idea (board auto-created with 6
lifecycle lanes). Moved through **all 6 lanes** (`Idea→Brainstorm→Wish→Work→Review→Done→Idea`),
each move emitting a `move` event. Undefined lane refused: exit 1,
`Unknown lane "Nonsense". Valid lanes: Idea, Brainstorm, Wish, Work, Review, Done.`

## QA #2 — runtime layer live: PASS

Checkout as `dogfood-claude` printed the reassignment briefing (prior timeline) and the claim
shows the `▶` liveness badge. `comment` / `heartbeat` / `report` / `block --reason` /
`unblock` all worked; author_kind **inferred `claude-code` from the environment** on every event.
Blocked checkout refused: exit 1, `blocked by claude-code: hold for cross-runtime check — cannot
check out`. Timeline render shows all 11 authored events in order.

## QA #4 — regression sweep: PASS

- Laneless board renders **three** columns (`Ready / In Progress / Done`) — Blocked column gone
  per design.
- `board --json` keeps the frozen contract: all four status keys
  (`blocked,done,in_progress,ready`) and the exact 10-key TaskRow
  (`boardId,claimedAt,claimedBy,createdAt,group,id,status,title,updatedAt,wish`) — zero
  lane/runtime leak.
- `task export` carries the union additively: `boards, hire_roster, meta, schemaVersion,
  stage_log, task_dependencies, task_events, tasks, wish_groups`.

## QA #5 — live roadmap, no data loss: PASS

`genie board --board roadmap` (installed binary) renders all 14 cards in their lanes with action
hints: Idea 6 / Brainstorm 3 / Wish 0 / Work 2 / Review 3 / Done 0.

## QA #3 — cross-runtime: OPEN (Felipe-gated)

Requires a comment from a real Codex session on a Claude-claimed card; verify both authors with
correct `author_kind` in `task status`. Command prepared for Felipe.

## Verdict

4 of 5 post-merge QA criteria PASS on the shipped binary; #3 awaits the one-line Codex run.
