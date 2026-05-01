# Dream Run — 2026-04-30

**Author:** genie-3
**Status:** EXECUTING
**Selected via:** explicit user directive (skipped brainstorm-md picker)

## Selected Wishes

| merge_order | slug | branch | wish_path | depends_on |
|-------------|------|--------|-----------|------------|
| 1 | `triage-w3-cleanup` | `wish/triage-w3-cleanup` | `.genie/wishes/triage-w3-cleanup/WISH.md` | (none) |

Single wish, single layer. No cross-wish dependencies.

## Execution Plan (11 groups across 5 waves)

The wish itself defines wave/group ordering — re-stating here for /dream orchestration:

### Layer 1 — start immediately (no deps)

| Group | Issues | Type | Estimated time |
|-------|--------|------|----------------|
| G1 | #1491 #1493 #1582 | code (release-blockers, RAM leak) | ~3-6 h |
| G10 | #1300 #1368 #1396 #1451 | comments only (enhancement-track pointers) | ~10 min |
| G11 | #1469 #1478 | comments only (needs-discussion parks) | ~5 min |

### Layer 2 — after G1 (depends-on: Group 1)

Wave 2 (parallel): G2, G3, G4
Wave 3 (parallel): G5, G6, G7, G8
Wave 4 (parallel): G9

| Group | Issues | Estimated time |
|-------|--------|----------------|
| G2 | #1330 #1410 #1502 #1591 | ~3-5 h |
| G3 | #1400 #1581 #1583 | ~2-3 h |
| G4 | #1390 #1597 #1598 | ~3-5 h |
| G5 | #1592 #1593 #1595 #1596 | ~2-4 h |
| G6 | #1412 #1460 #1533 #1579 #1584 #1587 | ~3-5 h |
| G7 | #1391 #1394 #1488 | ~3-6 h (dep bumps are wide blast radius) |
| G8 | #1315 | ~1-2 h |
| G9 | #1392 #1470 | ~1-2 h |

## Concurrency Model

- Layer 1: 3 engineers in parallel (G1 doing code, G10/G11 doing comments)
- Layer 2: up to 8 engineers in parallel after G1 lands
- One reviewer per PR (spawned on PR creation)
- One QA on dev after final merge

## Monitoring

- `genie wish status triage-w3-cleanup` — wave/group state
- `genie events errors --since 30m` — silent failures
- `genie ls --json | grep -E "^(eng-|reviewer|qa-)"` — worker registry
- Per-issue progress: GH issue close-state

## Loop Cadence

genie-3 wraps the dream in `/loop` with self-paced wakeups:
- Layer 1 monitor: ~20-30 min cadence (G10/G11 wrap fast, G1 takes longer)
- Layer 2 dispatch + monitor: ~30-60 min cadence
- Final QA loop: ~15-20 min cadence

Loop exits when all 29 fix-and-merge issues are CLOSED on GitHub OR a BLOCKED state requires human intervention.
