# Finalization ledger verification

The PM ledger updates in this wish are themselves release evidence, so they get adversarially verified before every commit. The harness is the repository workflow [`pm-ledger-verify`](../../../.claude/workflows/pm-ledger-verify.js): three independent lenses (overclaim hunter, cross-document consistency, release-gate contract) read the uncommitted ledger diff plus a raw-evidence bundle and return structured findings with `mustFix` flags. Nothing is committed while a must-fix finding stands.

## Run 1 — 2026-07-11, finalization pass at code commit `d9b0afbd`

Inputs: uncommitted edits to `WISH.md`, `REVIEW-DISPOSITION.md`, `.genie/INDEX.md`; evidence bundle containing the ledger diff, the read-only live user-asset audit output, the merge-simulation result, the `bun run check` tail at `d9b0afbd`, and verbatim quotes from the finishing PM session rollout.

Result: **12 findings, 4 must-fix — all corrected before anything was committed or pushed.**

| # | Must-fix finding | Correction |
|---|------------------|------------|
| 1 | The "Final specialist replay" gate was marked CLOSED-WITH-FOLLOW-UPS by silently redefining it from "seven-lane replay on the final tree" to "iterative replay rounds"; no replay ever audited the final tree (the last round examined the pre-fix tree, and the fixes were verified only by focused tests plus the aggregate) | Gate restored to PENDING with an honest description; summary, narrative, and validation snapshot all state that no specialist replay has audited the final tree |
| 2 | The F40 evidence cell claimed "the draft PR body names code commit `d9b0afbd`…" before any PR existed | Claim reverted to pending; re-added only in a later commit after PR #2556 actually existed |
| 3 | The WISH summary grouped the docs/runtime/lifecycle cross-reviews under "at final code commit `d9b0afbd` … all pass", presenting pre-replay-fix review verdicts as current at the final head | Summary rescoped: cross-reviews returned SHIP during the earlier execution phase; only aggregate, live baseline, and merge simulation pass at the final commit |
| 4 | The Wave-2 supersession row dropped "final panel" from its remaining-open list with no evidence a final-tree panel ran | "Final-tree specialist panel" restored to the remaining-open list |

The eight non-must-fix findings (stale "final" labels on superseded snapshots, merged evidence from two different builds in one gate cell, an unverifiable "were not touched" claim about non-baseline personal skills) were also applied where cheap; each correction is visible in commit `34fdae4d`.

## Run 2 — 2026-07-12, successor finalization at head `e3abf2b5`

Inputs: uncommitted ledger edits recording F42/F43 fixes, replay rows F44–F52, and the refreshed validation snapshot; evidence bundle with the ledger diff, aggregate/merge-sim/live-audit outputs, replay verdicts, and reviewer report quotes.

Result: **14 findings, 10 must-fix (two distinct defects reported across lenses) — all corrected before commit.**

| # | Must-fix defect | Correction |
|---|-----------------|------------|
| 1 | Pass-count off by one everywhere: ledgers said "1,435 pass, 1 skip" but bun's "Ran 1435 tests" total includes the skip — the run had 1,434 pass | All occurrences corrected to 1,434 pass (1,435 ran); the earlier quiet-run figure corrected the same way |
| 2 | "Seven-lane replay ran on the final tree" — it ran at `8e147d87`, three commits before the shipped head; loop-1 fixes were covered by a targeted re-review, not a re-replay | Summary, INDEX, and narrative rephrased to name `8e147d87` explicitly and state the re-review-not-replay coverage of the shipped head |

Non-must-fix corrections also applied: stale 2026-07-11 status sentence anchored as superseded, F22's dangling snapshot cross-reference removed, F40 updated for the merged PR, and the Darwin ARM64 gate re-labeled "PASS at `d9b0afbd` only" since no package was rebuilt at the successor head.

## Rerun instructions

From a Claude Code session in this repository:

```
Workflow({ name: 'pm-ledger-verify', args: {
  wishDir: '<absolute path to this wish directory>',
  evidenceFile: '<absolute path to the evidence bundle for the edits under review>',
} })
```

Fix every `mustFix: true` finding (or refute it with evidence in the ledger itself) before committing the ledger edits. Record each run in this file: date, head, finding counts, corrections.
