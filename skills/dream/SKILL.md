---
name: dream
description: "Batch-execute SHIP-ready wishes overnight — pick wishes, orchestrate workers, review PRs, wake up to results."
category: delivery
mutates: external
---

# Dream

Pick approved wishes, order them by dependency, dispatch one worker per wish, review and merge the PRs to `dev`, run QA against each wish's criteria, and write a wake-up report. The orchestrator dispatches; it never executes wish work itself.

Existing authorization that names the wishes or grants the run satisfies the selection and plan gates; otherwise present the numbered list and `DREAM.md` once and do not ask again. PR creation and merging to `dev` happen only under existing authority. Never merge to `main` or `master`, deploy, send external messages, or expand a wish's scope.

Task, board, and claim operations go through the selected lifecycle authority: the raw `genie task` and `genie board` calls below apply in standalone mode only; in explicitly selected Orca mode, workers and the orchestrator follow the Orca coordinator protocol shipped with the `work` skill, and an authority refusal is a blocker, not permission to use the local DB.

## Pick

Read `.genie/wishes/*/WISH.md` and select only wishes whose Status field is exactly `APPROVED`; `.genie/INDEX.md` is discovery context, never readiness authority. A Poured entry without an approved WISH.md is reported as drift. No matches: print `No APPROVED wishes found under .genie/wishes/` and stop. List matches numbered by slug with a one-line description; the user picks by number or `all`.

## Plan: `.genie/DREAM.md`

1. Read each selected wish's wish-level `**depends-on:**` under `## Dependencies` (`none` means no edge).
2. Topologically sort into `merge_order` layers `1..N`; same-layer wishes run in parallel.
3. Per wish: `slug`, `branch` (the repository's feature-branch convention; `feat/<slug>` only when it defines none), `wish-path: .genie/wishes/<slug>/WISH.md`, `depends-on`, `merge-order`. Keep the hyphenated keys so the plan checks directly against each wish.
4. Write the file in the shared worktree; present it once for confirmation unless the run is already authorized.

## Execute, layer by layer

Dispatch one worker subagent per wish in the layer through the runtime's native delegation surface, in parallel where the runtime supports it and capacity permits. Each brief carries the curated wish context (goal, groups, criteria, validation) and this contract:

- Work on the branch named in `DREAM.md`, in a dedicated worktree; the shared-workspace and git-state rules in `AGENTS.md` and `work` apply.
- Execute the wish per `work`. Standalone: engineers claim with `genie task checkout`, task state stays `in_progress`, evidence is reported, and only the dream orchestrator runs `genie task done` after clean review and passing validation. Orca mode: the `work` Orca protocol owns dispatch and completion state.
- Run `review` per group against acceptance criteria.
- Run CI; on failure fix and retry (max 3 attempts; poll CI status, never sleep-loop), then report blocked.
- Only after CI is green and PR creation is authorized: open a PR targeting `dev`, preferring the GitHub connector.
- Send a PR body or a card comment through a file or standard input, never interpolated into a double-quoted shell argument where backticks and `$(…)` still expand, and read the stored body back from the forge or the card before calling it delivered.
- Final message, every claim audited against tool output: `done — PR <url>, CI green, groups N/N` or `blocked — <reason>, groups N/N`.

A worker's final message is a claim, never evidence. Before any wish in the layer counts as complete, fill every row of this gate from tool output taken now:

| Claim | Requires | Not sufficient |
|---|---|---|
| The agent completed the work | A VCS diff for the named branch: commit range and changed files | The agent's success report |
| Validation passed | The wish's own validation command, run fresh, with its exit code | A green earlier run, or "it should pass" |
| A PR exists against `dev` | The PR state read back from the forge: base, head, required checks | The URL the worker pasted |
| The group was reviewed | An independent `review` verdict against that group's criteria | The worker's own assessment |

A row that cannot be filled makes the wish blocked, not done.

Failure path per wish: a failing check is fixed and retried up to three attempts (poll CI status, never sleep-loop); a fourth failure, an authority refusal, or a gate row that stays unfillable blocks the wish. Record the reason, leave branch, commits and PR intact, and never widen scope to rescue it. A blocked wish blocks every wish that names it under `depends-on`, transitively: those are never dispatched, are recorded as blocked on the upstream slug, and the rest of their layer still runs.

Completion is push: wait for each worker's final message; in standalone mode inspect `genie board --wish <slug>` on demand, and drive a wish without task rows from WISH.md directly. The layer is done when every dispatched wish has either passed the gate or been recorded blocked.

## Review and merge

1. Per PR, dispatch a reviewer subagent (never the wish's worker) to run `review` against the wish's criteria. Read bot comments critically.
2. FIX-FIRST: diagnose first; an overdesigned plan returns to `wish`/design review, otherwise route through `fix` with its per-group budget `B` (default 2) and the attempts already used. Architectural issues are escalated in the report, not patched.
3. CI green before proceeding. SHIP marks the PR review-complete.
4. After all PRs in the layer are SHIP, merge to `dev` in `merge_order` under existing authority.
5. Dispatch a QA subagent on `dev` against each wish's QA criteria. Each failure runs `report` → `fix` → retest, with every fix as a new PR through review and merge. Continue until every criterion is proven or blocked.

## Report: `.genie/DREAM-REPORT.md`

Always written, even if every wish blocked:

```markdown
# Dream Report — <date>

## Per-Wish Status
| merge_order | slug | PR | CI | Review | Merged | QA |
|-------------|------|----|----|--------|--------|----|

## Blocked Wishes
- `<slug>`: <blocking reason>

## QA Findings
- `<slug>`: <criterion failed — root cause, fix PR>

## Follow-ups
- <items requiring human intervention>
```

Every cell traces to tool output from the run: PR URLs, CI results, review verdicts, task state, worker final messages. A wish is shipped only when its merge and QA evidence are in hand; dispatched is not done. A blocked wish is recorded and the rest continue.
