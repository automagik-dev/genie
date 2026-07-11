---
name: work
description: "Execute an approved wish plan — orchestrate subagents per task group with fix loops, validation, and review handoff."
---

# work — Execute Wish Plan

**Runtime syntax:** in Codex, invoke the plugin copy with the owner-qualified `$genie:<skill>` selector; use bare `$<skill>` only when intentionally selecting a user-tier copy (CLI-managed fallback or separately installed personal skill). Claude Code and Hermes use `/<skill>`. Cross-skill prose below uses bare names as portable semantic routes; the orchestrator resolves the selector for the active tier.

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
5. **Local review:** per finished group, dispatch a reviewer subagent (reviewer ≠ engineer) to run `review` against that group's acceptance criteria. The orchestrator appends each returned evidence block under `## Review Results`; the reviewer never edits it. On FIX-FIRST, dispatch a fix subagent (max 2 loops); if unresolved, apply Escalation Diagnosis instead of automatically changing model or effort.
6. **Quality review:** dispatch a reviewer for a quality pass (security, maintainability, perf). On FIX-FIRST, one fix loop.
7. **Validate:** run the group's validation command yourself (Bash); record the output as evidence.
8. **Group done** — only after clean review AND passing validation:
   ```bash
   genie task done <task-id>
   ```
9. **Next wave:** re-derive from the WISH.md Execution Strategy (the DAG lives in the document, not in task rows — see State Management); repeat 2-8 until all groups are done.
10. **Handoff:** when every group's task is done: `All work groups complete. Run review.` Keep status `IN_PROGRESS` through execution review, PR review, and CI. Only the authorized merge plus required QA may transition it to `SHIPPED`.

## Dispatch

Spawn subagents with the **native delegation surface**; never execute group work directly. Dispatch a wave together so independent groups can run concurrently. Subagents notify you on completion. Every dispatch selects one named role below; implicit or unnamed roles are forbidden.

Use the active runtime's named roles. In Codex, use the matching `genie_*` custom-agent profile when installed; Claude and Hermes use their native named-role surfaces. Parallel writers must have disjoint file ownership or dedicated worktrees; otherwise sequence them. Reviewers and scouts stay read-only. Wait for completion notifications, steer a running thread with native follow-up messaging, and interrupt drift rather than spawning a duplicate worker.

| Need | Portable role (Codex profile) |
|------|----------------------------|
| Deterministic implementation, complexity 0-1 | `engineer-trivial` (`genie_engineer_trivial`) |
| Moderately coupled implementation, complexity 2-3 | `engineer-standard` (`genie_engineer_standard`) |
| High-coupling or stateful implementation, complexity 4+ | `engineer-complex` (`genie_engineer_complex`) |
| Review | `reviewer` (`genie_reviewer`; never the group's engineer) |
| Fix | `fixer` (`genie_fixer`; separate from the reviewer) |
| Final plan or execution gate | `final-gate` (`genie_final_gate`) |
| Bounded read-only discovery | `scout` (`genie_scout`) |
| Quick validation | Bash directly — no subagent |
| Follow-up to a running subagent | **native follow-up messaging** (keeps its context) |

Reviewer ≠ engineer is a hard rule — an agent never reviews its own work.

### Multi-session dispatch (Warp)

Native subagent dispatch is the default. When the user wants parallel Warp sessions they can supervise interactively — typically a large wave — hand the wave to Warp after its tasks exist:

```bash
genie launch <slug> [--groups <csv>]
```

One pane per ready group, each in its own git worktree, running that group's agent on a kickoff prompt. Everything governing correctness is identical: engineers still claim with `genie task checkout` against the shared `genie.db`, reviewer ≠ engineer holds, the orchestrator still validates and marks groups done, and waves still come from the Execution Strategy. The one limit: pane sessions cannot be awaited — Warp mode is human-in-the-loop. For hands-off, awaitable dispatch, use native subagents.

## Context Curation

Extract the group's context from WISH.md and paste it into the dispatch prompt — never say "read WISH.md for details" (that wastes the engineer's context window on other groups' scope and invites drift). Every brief gives the subagent explicit context, expected evidence, and stop conditions:

1. **Goal** — one sentence
2. **Deliverables** — the numbered list of concrete outputs
3. **Acceptance criteria** — the checkboxes to satisfy
4. **Validation command** — the exact command proving the work (e.g. `bun run check`)
5. **Depends-on** — what the engineer may assume already exists
6. **Stop conditions** — claim the task first; report blocked instead of expanding scope; end with an outcome word (see Session close)

## State Management

- **Engineers claim** via `genie task checkout <task-id> --worker <name>` as the first step of their brief.
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

Escalation eligibility requires **new evidence** produced since the previous attempt: attach the new failing output or diagnostic result, the correction already tried, and why it rules out the other three causes. A repeated verdict or unchanged failure is not new evidence and cannot authorize a model or effort change.

Model and reasoning effort belong in the active runtime's session or named-agent configuration, never in skill frontmatter. Inherit the active model by default. Only an evidenced `model-capacity` diagnosis may justify one higher-effort fresh agent, with at most two escalation attempts per group. The runtime's highest supported effort is appropriate only for a final gate or similarly demanding review when the user requested it or the evidence warrants it. Further escalation requires an explicit human decision recorded with the wish/group, old and new settings, reason, approver, and timestamp.

If an ordinary reviewer and the `final-gate` disagree, log an appeal with the wish/group, both verdicts and evidence, the contested criterion, and the human resolution. Neither verdict silently overrides the other, and the group remains `in_progress` until the appeal is resolved.

When a subagent fails or a fix-loop limit is exhausted, the orchestrator records the cause, evidence, selected route, and current cap counters before another dispatch. It leaves the task `in_progress`, keeps dispatching ready groups that do not depend on the blocked one, and includes unresolved diagnoses and appeals in the final handoff.

## Rules
- Never execute group work directly — always dispatch via the native delegation surface.
- Never expand scope during execution; never skip validation commands.
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
