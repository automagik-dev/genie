---
name: work
description: "Execute an approved wish plan — orchestrate subagents per task group with fix loops, validation, and review handoff."
---

# /work — Execute Wish Plan

The orchestrator's skill: execute an approved wish from `.genie/wishes/<slug>/WISH.md` by dispatching native-team subagents per execution group, in waves. The orchestrator never executes group work directly. Per-group execution state lives in the state DB via `genie task`; documents (WISH.md, review notes) stay in git.

## Context Injection

When you are spawned as a subagent for a group, your dispatch prompt carries the curated context: the wish path, which group(s) to work plus the task id to claim, and the group definition extracted from the wish. Use it directly — do not re-parse the wish for information already provided.

## When to Use
- An approved wish exists and `/review` returned SHIP on the plan
- Orchestrator needs to dispatch implementation to subagents

## Flow
1. **Load wish:** read `.genie/wishes/<slug>/WISH.md`; read group state with `genie task list --wish <slug>` (or `genie board --wish <slug>`).
2. **Pick the wave:** every group whose `depends-on` groups are done, per the wish's Execution Strategy.
3. **Dispatch the wave in ONE message** — one Agent tool call per group, each spawning an engineer with curated context (see Dispatch, Context Curation). Each engineer's brief opens with the atomic claim:
   ```bash
   genie task checkout <task-id> --worker <engineer-name>
   ```
   If two agents race one task, exactly one wins; the loser gets a conflict error and stands down.
4. **Await completion — never poll:** background subagents notify you when they finish. Inspect `genie board --wish <slug>` on demand; completion is push, not poll.
5. **Local review:** per finished group, dispatch a reviewer subagent (reviewer ≠ engineer) to run `/review` against that group's acceptance criteria. On FIX-FIRST, dispatch a fix subagent (max 2 loops).
6. **Quality review:** dispatch a reviewer for a quality pass (security, maintainability, perf). On FIX-FIRST, one fix loop.
7. **Validate:** run the group's validation command yourself (Bash); record the output as evidence.
8. **Group done** — only after clean review AND passing validation:
   ```bash
   genie task done <task-id>
   ```
9. **Next wave:** re-derive from the WISH.md Execution Strategy (the DAG lives in the document, not in task rows — see State Management); repeat 2-8 until all groups are done.
10. **Handoff:** when every group's task is done: `All work groups complete. Run /review.`

## Dispatch

Native team: spawn subagents with the **Agent tool**; never execute group work directly. Issue all of a wave's Agent calls in a single message so they run concurrently. Subagents run in the background and notify you on completion.

| Need | Method |
|------|--------|
| Implementation | Agent tool → **engineer** subagent with curated group context |
| Review | Agent tool → **reviewer** subagent (never the group's engineer) |
| Fix | Agent tool → **fixer** subagent (separate from the reviewer) |
| Quick validation | Bash directly — no subagent |
| Follow-up to a running subagent | **SendMessage** (keeps its context) |

Reviewer ≠ engineer is a hard rule — an agent never reviews its own work.

### Multi-session dispatch (Warp)

Native Agent-tool dispatch is the default. When the user wants parallel Warp sessions they can supervise interactively — typically a large wave — hand the wave to Warp after its tasks exist:

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

## Escalation

When a subagent fails or the fix-loop limit (2) is exceeded:
- Leave the task `in_progress` (never mark it done); record the blocker and concrete gaps in the wish notes/handoff.
- Keep dispatching ready groups that do not depend on the blocked one.
- Include blocked items in the final handoff.

## Rules
- Never execute group work directly — always dispatch via the Agent tool.
- Never expand scope during execution; never skip validation commands.
- Never overwrite WISH.md from subagent output — curated prompts are runtime context; the WISH.md in git is the source of truth.
- Reviewer ≠ engineer, always.
- `genie task done` only after clean review and passing validation — and only by the orchestrator.
- Grounded progress: before reporting, audit each claim against tool output from this session — state what is verified, what failed, what was skipped. Never present intentions, or subagent claims you did not verify, as completed work.

## Session close (required)

When spawned as a native-team subagent, your final message IS the completion signal — the orchestrator is notified when you finish; do not poll or emit a separate contract call. End with exactly one terminal outcome as the last word:

- **done** — acceptance criteria met and the validation command passes. Report evidence (commands + outcomes) and the task id.
- **blocked** — needs human input or an unblocking signal. State exactly what; leave the task `in_progress`.
- **failed** — aborted or irrecoverable. State why; leave the task `in_progress`.

`blocked` / `failed` must include a one-line reason.
