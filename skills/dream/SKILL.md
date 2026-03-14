---
name: dream
description: "Batch-execute SHIP-ready wishes overnight — pick wishes, orchestrate workers, review PRs, wake up to results."
---

# /dream — Overnight Batch Execution

Pick SHIP-ready wishes, build a dependency-ordered execution plan, spawn parallel workers, review PRs, merge to dev, run QA loop, produce a wake-up report.

## When to Use
- Human wants to queue multiple wishes for autonomous overnight execution
- Multiple SHIP-ready wishes exist in `.genie/brainstorm.md` under `Poured`

## Flow
1. **Pick wishes** from `.genie/brainstorm.md` in the shared worktree.
2. **Generate DREAM.md** with dependency-ordered execution plan.
3. **Human confirms** DREAM.md (may edit before run).
4. **Phase 1 — Execute:** dispatch workers per wish via `genie work`, collect outcomes.
5. **Phase 2 — Review + PR:** review each group, create PRs, fix valid issues, CI green.
6. **Phase 3 — Merge + QA:** merge to dev, spawn tester, QA loop until criteria proven.
7. **Phase 4 — Report:** write DREAM-REPORT.md as the wake-up artifact.

## Picker

1. Read `.genie/brainstorm.md`, locate the `Poured` section.
2. Parse each SHIP-ready entry in listed order, extracting `slug` and one-line description.
3. If no entries found, print `No SHIP-ready wishes found in .genie/brainstorm.md` and exit.
4. Display numbered list preserving original order:
   ```
   1. <slug> — <one-line description>
   ```
5. Prompt human to choose by number(s) (`1 3 5`) or `all`. Accept whitespace-separated numbers.
6. Emit selected set in order:
   ```
   - <slug>: .genie/wishes/<slug>/WISH.md
   ```

## DREAM.md Generation

1. For each selected wish, read `depends_on` from its `WISH.md`.
2. Compute topological sort across selected wishes. Assign `merge_order` as integer layers `1..N`:
   - Layer 1: wishes with no selected dependencies.
   - Increment layer when a wish depends on a lower layer.
   - Same-layer wishes are parallel.
3. Generate per-wish entry:

| Field | Value |
|-------|-------|
| `slug` | wish identifier |
| `branch` | `feat/<slug>` |
| `wish_path` | `.genie/wishes/<slug>/WISH.md` |
| `depends_on` | upstream slugs from WISH.md |
| `merge_order` | integer from topological layering |

4. Write to `.genie/DREAM.md` in the shared worktree.
5. Present for human confirmation before execution.

## Team Lifecycle

```
create dream team → hire agents → execute groups → review → PR to dev → merge → QA loop → disband
```

```bash
# Create a team for this dream session
genie team create dream-<date>

# Hire workers
genie team hire implementor    # one per wish
genie team hire reviewer       # one per PR
genie team hire fixer          # for FIX-FIRST gaps
genie team hire tester         # for QA loop on dev
```

## Phase 1: Execute

1. Create team: `genie team create dream-<date>`.
2. For each wish in DREAM.md, ordered by `merge_order` layer:
   - Same-layer wishes dispatch in parallel.
   - Dispatch workers via `genie work <agent> <slug>#<group>` — gets state tracking for free.
   - Parallel groups within a wish dispatched simultaneously.
3. Monitor via `genie status <slug>`. Mark groups done via `genie done <ref>`.
4. Workers signal completion via `genie send`.
5. If a group gets stuck, use `genie reset <ref>` to retry.

### Worker Contract

Each worker executes independently:

1. Read WISH.md from `wish_path`.
2. Self-refine task prompt via `/refine` (text mode).
3. Checkout branch: `git checkout -b <branch>`.
4. Implement execution groups from WISH.md.
5. Run local `/review` per group against acceptance criteria.
6. CI check: run CI. If fail → fix and retry (max 3 retries). Poll CI status — do not sleep.
   - After 3 failures: mark BLOCKED.
7. Only after CI green: `gh pr create --base dev`.
8. Report to lead via `genie send`:
   - Success: `DONE: PR at <url>. CI: green. Groups: N/N.`
   - Failure: `BLOCKED: <reason>. Groups: N/N.`

## Phase 2: Review + PR

**Trigger:** all execute workers have reported `DONE` or `BLOCKED`.

1. Leader creates PR to dev after all groups done for each wish.
2. Read bot comments critically — do not blindly accept automated suggestions.
3. Dispatch `/review` against wish acceptance criteria per PR.
4. On `FIX-FIRST`: dispatch `/fix` for valid issues (max 2 loops per PR).
5. On architectural issue: escalate immediately (no fix attempt), record in report.
6. CI must be green before proceeding. Poll CI status, do not sleep.
7. On `SHIP`: mark review-complete.

## Phase 3: Merge + QA

**Trigger:** all PRs reviewed and marked SHIP.

1. Merge PRs to dev in `merge_order`.
2. Spawn tester on dev branch: `genie spawn tester`.
3. QA loop: test against wish acceptance criteria → failures get `/report` → `/trace` → `/fix` → retest.
4. Each fix creates a new PR to dev, goes through review, merge, retest.
5. Continue until all wish criteria are proven or blocked.

## Phase 4: Report

Write to `.genie/DREAM-REPORT.md` in the shared worktree:

```markdown
# Dream Report — <date>

## Per-Wish Status

| merge_order | slug | PR link | CI | Review | Merged | QA |
|-------------|------|---------|----|--------|--------|----|
| 1 | slug-1 | #123 | green | SHIP | yes | verified |
| 2 | slug-2 | #124 | green | SHIP | yes | 2/3 criteria |

## Blocked Wishes
- `<slug>`: blocking reason.

## QA Findings
- `<slug>`: criteria X failed — traced to <root cause>, fix PR #125.

## Follow-ups
- Action items requiring human intervention.
```

After report is written:
```bash
genie team disband dream-<date>
```

## Rules
- Never early-stop: if a wish returns BLOCKED, record reason and continue with remaining wishes.
- Never skip Phase 2 — every DONE PR must be reviewed.
- Never skip Phase 3 — every merged PR must be QA-tested against wish criteria.
- Orchestrator never executes wish work directly — dispatch via `genie work`.
- Do not expand scope beyond what WISH.md defines.
- Always write DREAM-REPORT.md, even if all wishes BLOCKED.
- Poll CI status instead of sleeping — never use `sleep` in CI retry loops.
- Use `genie done`, `genie status`, and `genie reset` for state tracking.
