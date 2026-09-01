---
name: work
description: "Execute an approved wish plan — orchestrate subagents per task group with fix loops, validation, and review handoff."
---

# work — Execute Wish Plan

**Runtime syntax:** invoke the plugin copy through the active runtime's owner-qualified skill selector; use a bare selector only when intentionally selecting a user-tier copy (a separately installed personal copy; Genie no longer seeds this tier). Cross-skill prose below uses bare names as portable semantic routes; the orchestrator resolves the selector for the active runtime.

The orchestrator's skill: execute an approved wish from `.genie/wishes/<slug>/WISH.md` by dispatching native subagents per execution group, in waves. The orchestrator never executes group work directly. Per-group execution state lives in the state DB via `genie task`; documents (WISH.md, review notes) stay in git. Map coordination to the active client with `references/native-surfaces.md`, resolved relative to the directory containing this loaded `SKILL.md`.

## Context Injection

When you are spawned as a subagent for a group, your dispatch prompt carries the curated context: the wish path, which group(s) to work plus the task id to claim, and the group definition extracted from the wish. Use it directly — do not re-parse the wish for information already provided.

## When to Use
- An approved wish exists and `review` returned SHIP on the plan
- Orchestrator needs to dispatch implementation to subagents

## Flow
1. **Load and enter execution:** read `.genie/wishes/<slug>/WISH.md` and require persisted status `APPROVED` (or `IN_PROGRESS` when resuming). Before the first dispatch, the orchestrator sets `APPROVED` → `IN_PROGRESS`; read group state with `genie task list --wish <slug>` (or `genie board --wish <slug>`).
2. **Pick the wave:** every group whose `depends-on` groups are done, per the wish's Execution Strategy.
3. **Dispatch the wave in ONE message** — one native delegation surface call per group, each using the named engineer role selected from the WISH's Complexity and Model columns with curated context (see Dispatch, Context Curation). Each engineer's brief opens with the atomic claim:
   ```bash
   genie task checkout <task-id> --worker <engineer-name>
   ```
   If two agents race one task, exactly one wins; the loser gets a conflict error and stands down.
4. **Await completion — never poll:** background subagents notify you when they finish. Inspect `genie board --wish <slug>` on demand; completion is push, not poll.
5. **Local review:** per finished group, dispatch a reviewer subagent (reviewer ≠ engineer) to run `review` against that group's acceptance criteria. The orchestrator appends each returned evidence block under `## Review Results`; the reviewer never edits it. Diagnose before fixing: `overdesigned-plan` returns to wish/design review without consuming a fix attempt; other FIX-FIRST gaps may use at most 2 fix loops.
6. **Quality review:** dispatch a reviewer for a quality pass (security, maintainability, perf). On FIX-FIRST, one fix loop.
7. **Validate:** run the group's validation command yourself through the active runtime's shell surface; record the output and the scope rationale as
   evidence. Confirm it remains proportional to the actual diff, widening it when implementation reached beyond the
   plan: documentation-only changes, including deterministic generated documentation or plugin skill mirrors, use
   relevant format, link, example, generator, parity, or content-contract checks; runtime changes use focused behavior
   tests and add type, lint, or build checks for boundaries reached. Shared runtime/core behavior, dependency or lockfile,
   generated executable or runtime artifact, configuration or schema, CI or release, broad-refactor, or uncertain-impact
   changes require the repository full gate plus affected build or end-to-end checks. Validation may never be zero. A
   passing full-suite run is always valid evidence — record why that scope was chosen; a missing scope rationale is a
   gap in the write-up, not in the validation. A repository-documented gate is by itself sufficient justification for
   its scope. Preserve required aggregate integration and release gates.
8. **Group done** — only after clean review AND passing validation:
   ```bash
   genie task done <task-id>
   ```
9. **Next wave:** re-derive from the WISH.md Execution Strategy (the DAG lives in the document, not in task rows — see State Management); repeat 2-8 until all groups are done.
10. **Handoff:** when every group's task is done: `All work groups complete. Run review.` Keep status `IN_PROGRESS` through execution review, PR review, and CI. Only the authorized merge plus required QA may transition it to `SHIPPED`.

## Dispatch

Spawn subagents with the **native delegation surface**; never execute group work directly. Dispatch a wave together so independent groups can run concurrently. Subagents notify you on completion. Every dispatch selects one named role below; implicit or unnamed roles are forbidden.

Use the active runtime's named roles: the portable role names below map onto whatever native named-role surface the runtime provides. Parallel writers must have disjoint file ownership or dedicated worktrees; otherwise sequence them. Shared-workspace subagents never mutate repo-level git state (no `checkout`/`switch`/`reset`/`stash`/`rebase`) — **only the orchestrator moves HEAD**; work needing repo-level mutation gets an isolated worktree arranged by the orchestrator (client-provided worktrees or explicit `git worktree add` plumbing) or gets sequenced. The git-state freeze and the "agents merge to `dev`; `main` is humans-only" rule are operator policy carried in briefs and AGENTS.md, enforced by server-side branch protection on `main` and by nothing client-side. `git worktree add/remove/prune` on snapshot/lane paths is orchestrator-side plumbing and permitted. Reviewers and scouts stay read-only. Wait for completion notifications, steer a running thread with native follow-up messaging, and interrupt drift rather than spawning a duplicate worker.

| Need | Portable role |
|------|----------------------------|
| Deterministic implementation, complexity 0-1 | `implementor-low` |
| Moderately coupled implementation, complexity 2-3 | `implementor-mid` |
| High-coupling or stateful implementation, complexity 4+ | `implementor-high` |
| Review | `reviewer` (never the group's engineer) |
| Fix | `fixer` (separate from the reviewer) |
| Final plan or execution gate | `final-gate` |
| Bounded read-only discovery | `scout` |
| Quick validation | The active runtime's shell directly — no subagent |
| Follow-up to a running subagent | **native follow-up messaging** (keeps its context) |

Reviewer ≠ engineer is a hard rule — an agent never reviews its own work.

### Multi-session dispatch — retired (recorded amendment)

Native subagent dispatch is the ONLY dispatch mode. The opt-in Warp
multi-session mode is retired with the spawn-context-contract launch removal
(recorded amendment: the context verb's `--plan` doubles as the spawn plan
preview, and supervised parallel sessions are arranged from the spawn side, not
from a genie verb). Everything governing correctness is unchanged: engineers
still claim with `genie task checkout` against the shared `genie.db`, reviewer ≠
engineer holds, the orchestrator still validates and marks groups done, and
waves still come from the Execution Strategy.

Preview the wave plan without side effects:

```bash
genie context --wish <slug> --plan
```

## Context Curation

Extract the group's context from WISH.md and paste it into the dispatch prompt — never say "read WISH.md for details" (that wastes the engineer's context window on other groups' scope and invites drift). Every brief gives the subagent explicit context, expected evidence, and stop conditions:

1. **Goal** — one sentence
2. **Deliverables** — the numbered list of concrete outputs
3. **Acceptance criteria** — the checkboxes to satisfy
4. **Validation command** — the exact command proving the work, with its scope rationale (e.g. `bun run check` because the group touches shared runtime behavior)
5. **Depends-on** — what the engineer may assume already exists
6. **File scope** — the group's explicit file scope (the paths it owns), so disjoint ownership is legible to the engineer rather than inferred
7. **Stop conditions** — claim the task first; report blocked instead of expanding scope; end with an outcome word (see Session close)

When the wave shares one workspace, every brief carries the file scope from item 6 **and** the freeze rule verbatim:

> You share this workspace with concurrent engineers on disjoint files. Shared-workspace subagents never mutate repo-level git state (no `checkout`/`switch`/`reset`/`stash`/`rebase`) — **only the orchestrator moves HEAD**. Work needing repo-level mutation gets an isolated worktree arranged by the orchestrator (client-provided worktrees or explicit `git worktree add` plumbing) or gets sequenced. The git-state freeze and the "agents merge to `dev`; `main` is humans-only" rule are operator policy carried in briefs and AGENTS.md, enforced by server-side branch protection on `main` and by nothing client-side. Leave your changes in the working tree; do not commit.

## State Management

- **Engineers claim** via `genie task checkout <task-id> --worker <name>` as the first step of their brief.
- **Environment setup is feature work.** Read-only discovery may precede a claim, but before mutating shared host state—installing toolchains or runtimes, starting services or emulators, provisioning credentials, or preparing test infrastructure—claim the group that owns the setup and keep it `in_progress` until setup and validation finish. The visible claim is the concurrency lock: if another live worker owns it, coordinate or stand down; reclaim only a stale claim. When setup is a prerequisite shared by multiple groups, give it an explicit group/task in the wish instead of running untracked preflight. Never let multiple threads independently prepare the same environment.
- **Engineers signal** completion in their final message; the native team notifies the orchestrator — no manual send.
- **Orchestrator tracks** via `genie task list --wish <slug>` / `genie board --wish <slug>` (on demand) and completes each verified group with `genie task done <task-id>`. Engineers never call `genie task done`.
- **The dependency DAG is doc-only.** The v5 CLI has no dependency-edge commands — every CLI-created task is `ready` from birth, so DB status is NOT a dependency signal. Sequence waves from the WISH.md Execution Strategy alone; never dispatch a group just because its task shows `ready`.
- **No task row?** (wish predates the state DB, or `.genie/genie.db` unavailable): skip the `genie task` calls and drive the wave from the WISH.md directly — task tracking is an enhancement, never a blocker.

## Escalation Diagnosis

Use this policy before any model or effort change; keep this contract identical in `fix`, `review`, and `work`.

| Cause | Diagnostic evidence | Corrective route |
|-------|---------------------|------------------|
| `model-capacity` | The supplied context is complete, the spec is decidable, the environment works, and attempt output shows the assigned model or effort still cannot perform the reasoning. | May raise model or effort one step, but only with new evidence and available caps. |
| `missing-context` | The attempt identifies absent files, history, criteria, logs, or other inputs needed to decide. | Supply the missing context and retry at the same model and effort; MUST NOT escalate model or effort. |
| `ambiguous-spec` | Two or more materially different behaviors remain consistent with the stated criteria. | Request a human decision or wish clarification; MUST NOT escalate model or effort. |
| `env-tool-failure` | A reproducible environment, dependency, permission, timeout, or tool error prevents valid execution. | Repair or retry the environment/tool, or report blocked with the error; MUST NOT escalate model or effort. |
| `overdesigned-plan` | Gaps cluster in optional machinery that lacks a current criterion or measurement, while a simpler design satisfies the user stories with fewer durable states or recovery paths. | Stop the fix loop and return to `brainstorm`/`wish` to remove or defer the mechanism. Re-review the amended design/plan; MUST NOT spend retries or model escalation defending it. |

Escalation eligibility requires **new evidence** produced since the previous attempt: attach the new failing output or diagnostic result, the correction already tried, and why it rules out the other four causes. A repeated verdict or unchanged failure is not new evidence and cannot authorize a model or effort change.

Model and reasoning effort belong in the active runtime's session or named-agent configuration, never in skill frontmatter. Inherit the active model by default. Only an evidenced `model-capacity` diagnosis may justify one higher-effort fresh agent, with at most two escalation attempts per group. The runtime's highest supported effort is appropriate only for a final gate or similarly demanding review when the user requested it or the evidence warrants it. Further escalation requires an explicit human decision recorded with the wish/group, old and new settings, reason, approver, and timestamp.

If an ordinary reviewer and the `final-gate` disagree, log an appeal with the wish/group, both verdicts and evidence, the contested criterion, and the human resolution. Neither verdict silently overrides the other, and the group remains `in_progress` until the appeal is resolved.

When a subagent fails or a fix-loop limit is exhausted, the orchestrator records the cause, evidence, selected route, and current cap counters before another dispatch. It leaves the task `in_progress`, keeps dispatching ready groups that do not depend on the blocked one, and includes unresolved diagnoses and appeals in the final handoff.

A user-approved simplification invalidates the superseded plan/review evidence and starts a fresh plan review; it is not an extra fix attempt. Preserve useful completed work only when it still satisfies the simpler contract, and delete machinery that exists solely for the rejected design.

## Rules
- Never execute group work directly — always dispatch via the native delegation surface.
- Never expand scope during execution; never skip validation commands or substitute unexplained over-validation for a
  risk-based choice.
- Never spend fix loops preserving optional complexity; route an `overdesigned-plan` diagnosis back through wish/design review.
- Never overwrite WISH.md from subagent output — curated prompts are runtime context; the WISH.md in git is the source of truth.
- Reviewer ≠ engineer, always.
- `genie task done` only after clean review and passing validation — and only by the orchestrator.
- Grounded progress: before reporting, audit each claim against tool output from this session — state what is verified, what failed, what was skipped. Never present intentions, or subagent claims you did not verify, as completed work.

## Session close (required)

When spawned as a native subagent, your final message IS the completion signal — the orchestrator is notified when you finish; do not poll or emit a separate contract call. End with exactly one terminal outcome as the last word:

- **done** — acceptance criteria met and the validation command passes. Report evidence (commands + outcomes) and the task id.
- **blocked** — needs human input or an unblocking signal. State exactly what; leave the task `in_progress`.
- **failed** — aborted or irrecoverable. State why; leave the task `in_progress`.

`blocked` / `failed` must include a one-line reason.
