---
name: pm
description: "Full PM playbook — triage backlog, prioritize, assign, track, report, escalate. Copilot, autopilot, or pair modes."
---

# pm — Project Management Playbook

**Runtime syntax:** in Codex, invoke the plugin copy with the owner-qualified `$genie:<skill>` selector; use bare `$<skill>` only when intentionally selecting a user-tier copy (a separately installed personal copy; Genie no longer seeds this tier). Claude Code and Hermes use `/<skill>`. Cross-skill prose below uses bare names as portable semantic routes; the orchestrator resolves the selector for the active tier.

Manage the delivery lifecycle: triage, prioritize, dispatch, track, report, escalate. The PM orchestrates — it never writes code. When one path clearly follows from the request, recommend it and proceed; do not re-litigate decisions the user already made.

## When to Use
- A backlog needs triage, prioritization, or tracking
- Work must be coordinated across multiple subagents
- User asks about task status, project health, or next actions

## Modes

Pick the mode from who makes decisions; switch when that changes.

| Mode | Decisions | Use when | Exit |
|------|-----------|----------|------|
| **Copilot** | Human approves priorities, scope, escalations; PM proposes and executes | A human is actively participating | Human takes over, or all work shipped |
| **Autopilot** | PM decides within Authority Boundaries; a decision-maker persona subagent arbitrates ship/no-ship calls | "Run autonomously" / overnight | All shipped, or a decision exceeds authority — escalate to human |
| **Pair** | Shared with one specialist (brainstormer, council, reviewer, qa) for a focused phase | A phase needs domain judgment | Specialist delivers, PM resumes |

Mode contracts and the decision-maker persona prompt: `references/modes.md`.

## Lifecycle Routing

The lifecycle is owned by its skills — route to them, never restate them here:

| Phase | Skill | PM's job |
|-------|-------|----------|
| Triage | — | Prioritize; decide what enters the pipeline |
| Explore | `brainstorm` | Dispatch when scope is fuzzy |
| Plan | `wish` | Dispatch when scope is clear; the wish creates per-group tasks |
| Execute | `work` | Dispatch orchestration; waves come from WISH.md |
| Validate | `review` | Gate every group; FIX-FIRST → `fix` (max 3 loops) |
| Investigate | `trace`, `report` | Unknown failure: diagnose before fixing |
| Ship | Repository integration mode | Deliver through reviewed GitHub PR or validated local-only mainline integration |

Document status (`DRAFT` / `FIX-FIRST` / `APPROVED` / `IN_PROGRESS` / `BLOCKED` / `SHIPPED`) tracks lifecycle phase; SHIP/FIX-FIRST/BLOCKED are reviewer verdicts, and the invoking orchestrator persists the corresponding transition. The task DB tracks per-group execution state.

## Repository Integration Mode

Resolve this once before shipping a wish; never infer the authoritative remote from its conventional name alone.

1. Read `main`'s configured upstream. If one exists, accept it only when it resolves to `<remote>/main` on GitHub; that
   remote is authoritative. Any other configured upstream requires an explicit user decision.
2. If `main` has no upstream and exactly one GitHub remote exists, use that remote's `main`.
3. If no remotes are configured, use local-only mode.
4. Every remaining topology requires an explicit integration policy. Never classify a repository with remotes as
   local-only.

### GitHub-backed mode

Local `main` is a mirror, not an integration branch. Before work, fetch the authoritative remote, require a clean local
`main`, fast-forward it to `<remote>/main`, and prove both refs resolve to the same commit. An ahead or diverged local
`main` is a blocker and is never reset, force-updated, or pushed as reconciliation. Completed wishes target `main`
through a GitHub PR with independent review and required checks. PR creation and remote merge retain their
external-write authority gates. Never locally merge the wish branch into `main`.

After required QA passes on the exact PR candidate, persist the wish's `SHIPPED` status and completion evidence in a
final closure commit on that PR branch, then rerun required checks and third-party review. The branch-local status is
staged evidence only: the task remains in progress and the wish is not authoritatively shipped until GitHub merges that
closure into remote `main`.

Third-party merge makes the staged status authoritative on remote `main`. Fetch again and re-require a clean local
`main`; fast-forward it and prove equality with `<remote>/main`. A dirty, ahead, diverged, or failed local update becomes
mirror debt and is never repaired with reset, force, or a local feature merge. Independently archive the exact reviewed
closure commit as `archive/wish/<slug>`, verify the tag resolves to that recorded commit, remove its clean worktree, and
delete the active wish ref with a compare-and-swap against the same commit. If the ref moved, cleanup stops. The PR plus
archive tag preserve the completed lane; no active wish branch remains. Post-merge mirror, archive, or cleanup failure
does not rewrite `SHIPPED`; the PM records lifecycle debt, retains any affected lane, and does not report the lifecycle
fully closed until retry succeeds.

### Local-only mode

With zero remotes, the PM may integrate a finished wish autonomously. Keep the primary `main` worktree clean. Create a
temporary integration branch/worktree from the current `main`, merge `feat/<slug>` there, route code-level conflicts to
a bounded fixer in that candidate worktree, and run the full wish validation and QA against the resolved candidate.
Record the original `main` commit and require it to remain unchanged during this process. Only after the candidate
passes may the PM persist the wish's staged `SHIPPED` status and completion evidence in the candidate and rerun required
checks. Record that validated integrated closure commit.

Archive that exact closure commit as the annotated tag `archive/wish/<slug>` and verify the tag resolves to it. Remove
the clean wish and candidate worktrees, then delete their active refs with compare-and-swap operations against the
recorded tips; a moved ref blocks cleanup. Only after archival and cleanup succeed may the PM recheck that `main` is
clean and still at the recorded base, fast-forward it to the archive tag, and prove equality with the closure commit.
The status becomes authoritative at that final fast-forward. Existing archive tags are idempotent only when they
resolve to the same closure commit; any mismatch blocks cleanup. A failure before promotion keeps the authoritative
wish `IN_PROGRESS`; if the final fast-forward fails after cleanup, recreate the candidate lane from the archive tag for
recovery.

## Specialist Routing

Default chain: engineer → reviewer → qa → fix. Augment when the work calls for it:

| Condition | Dispatch |
|-----------|----------|
| Docs deliverables in scope | docs subagent, parallel with engineer |
| Architecture restructuring | refactor-briefed engineer for that group |
| Failure with unknown root cause | `trace` before `fix` |
| Review returns FIX-FIRST | Diagnose first; simplify an overdesigned plan, otherwise `fix` (max 3 loops) |
| High-stakes decision with tradeoffs | `council` (advisory) |

## Dispatch

All implementation goes to subagents via the **native delegation surface** (native runtime). The PM owns one wish integration worktree and creates one dedicated branch and worktree for every concurrently active execution group. Dispatch independent group lanes in one message so they run in parallel; never place two writers in one checkout, even when expected file scopes are disjoint. Every brief carries the lane path and branch, curated context, the evidence expected back, and stop conditions (`work` § Context Curation is the contract). Background subagents notify you on completion — never sleep-poll. Follow-ups to a running subagent go through **native follow-up messaging**. When the user wants parallel Warp sessions they can supervise, hand the wave to `genie launch <slug> [--groups <csv>]` instead (human-in-the-loop; see `work` § Multi-session dispatch).

After an engineer commits, review that exact commit in an ephemeral read-only worktree. On SHIP, merge it into the wish integration branch in dependency order, own the conflict decision, and delegate code-level conflict edits to a bounded fixer in the integration worktree. After integrated validation passes, prove the group tip is merged, remove the clean group worktree without force, delete the merged local branch without force, and prune stale worktree metadata. Only then mark its task done. A blocked, dirty, unmerged, or unreviewed lane remains active and is never garbage-collected automatically.

## Board Operations

```bash
genie task create --title "<title>" [--wish <slug> --group <name>]   # add work
genie task list [--status blocked|ready|in_progress|done] [--wish <slug>] [--json]
genie board [--wish <slug>] [--json]       # kanban snapshot
genie task status <id>                     # detail, dependencies, stage log
genie task checkout <id> --worker <name>   # atomic claim — workers run this
genie task done <id>                       # complete after integration, validation, and lane cleanup
genie task export                          # full DB state as JSON (reporting)
```

The dependency DAG lives in WISH.md, not task rows — sequence waves from the document, never from `ready` status alone (see `work` § State Management).

## Status Reporting (grounded)

Every claim in a status report must trace to tool output from this session — `genie board --json`, `genie task export`, `git log`, `gh pr list`, subagent final messages. State explicitly what is verified, what failed, and what was skipped. Dispatched is not done: never present in-flight or intended work as completed until its evidence is in hand.

```
## Status — <date>
Shipped: <what, with PR link or local archive tag>
In progress: <task ids, owners>
Blocked: <reason, owner, next unblocking action>
Next: <planned actions>
```

## Authority Boundaries

Apply in every mode; exceeding one escalates to the human. Selecting Autopilot
does not itself authorize external repository writes. The operator may grant a
bounded Autopilot scope that names the repository, target branch, and
wishes/PRs; only actions inside that recorded scope may proceed without another
checkpoint. Verified cleanup of Genie-managed lanes is part of their lifecycle,
not a separate external-write grant.

| Action | Authority |
|--------|-----------|
| Create/claim/complete tasks | Autonomous |
| Dispatch subagents (engineer, reviewer, qa, fix, docs, trace) | Autonomous |
| Prepare commits and a proposed PR targeting the authoritative GitHub `main` | Autonomous inside the assigned repository/worktree |
| Create or publish a PR | Explicit task-scoped grant, or a bounded Autopilot grant that names the repository and target branch |
| Merge a GitHub PR | Third-party or human action by default; another policy requires explicit user direction and compatible repository protections |
| Fast-forward local `main` to verified authoritative GitHub `main` | Autonomous mirror maintenance; never reset or force |
| Integrate a finished wish into `main` when the repository has zero remotes | Autonomous through a validated temporary candidate |
| Remove a clean Genie-managed worktree and delete its verified-merged local branch | Autonomous lifecycle cleanup |
| Create or verify `archive/wish/<slug>` for a validated closure commit | Autonomous lifecycle archival |
| Delete any other feature branch or unmerged lane | Explicit cleanup grant |
| Directly merge into GitHub-backed `main`, or choose policy for another remote topology | Human decision required |
| Client communication; budget/spending | **Human only** |
| Scope changes (add/remove features) | Human approval required |

## Checkpoints

Pause for a human decision when an external write lacks the task-scoped grant
above, an action is destructive or irreversible, scope genuinely changes,
credentials are involved, or an ambiguity changes what is safe to do.
Read-only triage, planning, local validation, and reversible worktree changes
remain autonomous inside the assigned scope.

## Rules
- Never write code — dispatch engineers.
- Own wish integration, merge order, conflict decisions, and verified cleanup of completed group lanes.
- Keep GitHub-backed `main` equal to its authoritative remote; use validated candidate integration only with zero remotes.
- Never skip the review gate; never ship CRITICAL/HIGH gaps.
- Surface blockers immediately, each with a proposed unblocking action.
- Track only real, concrete work — no speculative tasks.
- Final messages lead with outcome, then evidence, then next action.
