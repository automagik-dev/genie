# Genie lifecycle

```text
brainstorm → design review → wish → plan review → work → implementation review → PR → authorized merge + QA
```

Use this lifecycle for explicit Genie work, related ongoing plans, or work needing durable decisions and coordination. Ordinary unrelated requests bypass it without adding artifacts or gates. Bug reports, operational commands, and Genie questions still route normally. Repository safety/review requirements apply throughout; security-sensitive work retains review unless the user explicitly chooses otherwise.

Design, plan, and implementation review evaluate different artifacts. A reviewed design does not approve a plan, and an approved plan does not prove an implementation. DESIGN.md records reviewer identity, UTC time, verdict, and the SHA-256 of reviewed content excluding its bounded evidence block. Edits invalidate that evidence; a linked wish requires current SHIP verification.

## State

The caller persists review evidence under WISH.md’s `## Review Results` and owns transitions. Reviewers are read-only.

| WISH Status | Meaning / next step |
|---|---|
| DRAFT | Plan awaiting review |
| FIX-FIRST | Correct blocking plan gaps, then re-review |
| APPROVED | Plan reviewed and ready for work |
| IN_PROGRESS | Execution begun; remains here through repairs, PR and CI |
| BLOCKED | Recorded external/environment/specification blocker; resolve before resuming |
| SHIPPED | Authorized merge and required QA/release evidence complete |

Plan SHIP sets APPROVED; plan FIX-FIRST/BLOCKED sets the matching status. Execution failures remain IN_PROGRESS unless a real external blocker is recorded. A chat verdict alone never advances state. Repairs use `fix`’s per-group budget `B` (default 2), carried counters, and diagnosis policy; a handoff does not reset them.

## Authority and storage

- Documents in git: `.genie/wishes/`, `.genie/brainstorms/`, and the intake index `.genie/INDEX.md`. Group dependencies live in WISH.md.
- Standalone, the default: per-repo task state uses `.genie/genie.db`, shared by worktrees through the Git common directory. Workers claim with `genie task checkout`; only the coordinator runs `genie task done` after review and validation.
- Explicit Orca mode: Orca owns lifecycle state. `wish` and `work` supply their conditional Orca instructions and use its version-matched guides. Do not fall back to the standalone DB on a refusal. Merely installing/opening Orca does not select this mode.
- Genie is zero-daemon: no resident process of any kind. The machine-scope `~/.genie/genie.db` path carries no genie state; the per-repo opener refuses it so repo task state can never land there.

Use native completion notifications/structured waits. Inspect standalone state with `genie board` or `genie task status`; `genie context --wish <slug> --plan` previews without mutation. Claims do not replace dependency ordering or independent review.

For task choice use the `genie` router and the installed skill descriptions. `wish` delivers one admitted task to a merge-ready PR and never merges; `dream` batches approved wishes. Neither bypasses existing authorization or required evidence.
