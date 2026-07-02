---
name: work
description: "Execute an approved wish plan — orchestrate subagents per task group with fix loops, validation, and review handoff."
---

# /work — Execute Wish Plan

The orchestrator's skill: execute an approved wish from `.genie/wishes/<slug>/WISH.md` by dispatching subagents (Claude Code native team) per execution group in waves. The orchestrator never executes group work directly — always dispatch via the **Agent tool** (see Dispatch). Per-group execution state is tracked in the zero-daemon state DB via `genie v5 task`; documents (WISH.md, review notes) stay in git.

## Context Injection

When you are spawned as a subagent for a group, the dispatching agent curates your execution context into the prompt:
- **Wish path** — `.genie/wishes/<slug>/WISH.md` in the shared worktree
- **Group context** — which execution group(s) to work on, and the task id to claim
- **Injected section** — the specific group definition extracted from the wish

If context is injected, use it directly. Do not re-parse the wish for information already provided.

## Flow
1. **Load wish:** read `.genie/wishes/<slug>/WISH.md` from the shared worktree, confirm scope. Read current group state with `genie v5 task list --wish <slug>` (or `genie v5 board --wish <slug>`).
2. **Pick the wave:** select the set of ready (unblocked) execution groups per the wish's Execution Strategy — a wave is every group whose `depends-on` groups are already done.
3. **Dispatch the wave (parallel):** for each group in the wave, in ONE message issue an **Agent tool** call spawning an engineer subagent with curated context (see Dispatch and Context Curation). As part of each engineer's brief, have it claim its task first:
   ```bash
   genie v5 task checkout <task-id> --worker <engineer-name>
   ```
   The claim is atomic — if two agents race the same task, exactly one wins and the loser gets a conflict error and stands down.
4. **Await completion (do not poll):** background subagents notify you when they finish — wait for the notification, never `sleep`-loop against the board. On demand you may read `genie v5 board --wish <slug>` to inspect state, but completion is push, not poll.
5. **Local review:** for each finished group, dispatch a reviewer subagent (see Dispatch — reviewer ≠ engineer) to run `/review` against that group's acceptance criteria. On FIX-FIRST, dispatch a fix subagent (max 2 loops).
6. **Quality review:** dispatch a reviewer subagent for a quality pass (security, maintainability, perf). On FIX-FIRST, dispatch a fix subagent (max 1 loop).
7. **Validate:** run the group's validation command yourself (Bash), record evidence.
8. **Group done:** once review is clean and validation passes, complete the task:
   ```bash
   genie v5 task done <task-id>
   ```
9. **Next wave:** derive the next wave from the WISH.md Execution Strategy (the dependency DAG lives in the document, not in task rows — see State Management), then repeat steps 2-8 until all groups are done.
10. **Handoff:** when every group's task is `done`, `All work groups complete. Run /review.`

## When to Use
- An approved wish exists and is ready for execution
- Orchestrator needs to dispatch implementation tasks to subagents
- After `/review` returns SHIP on the plan

## Dispatch

Dispatch is a Claude Code native team: the orchestrator spawns subagents with the **Agent tool** — one for each role — and never executes group work directly. To run a wave in parallel, issue all the wave's Agent tool calls in a **single message** so they execute concurrently. Subagents run in the background and notify you on completion; do not poll for their status.

| Need | Method |
|------|--------|
| Implementation task | Agent tool → spawn an **engineer** subagent with curated group context |
| Review task | Agent tool → spawn a **reviewer** subagent (never the same agent that engineered the group) |
| Fix task | Agent tool → spawn a **fixer** subagent (separate from the reviewer) |
| Quick validation | `Bash` tool directly — no subagent needed |
| Follow-up to a running subagent | **SendMessage** tool to that agent (keeps its context) |

Reviewer ≠ engineer is a hard rule: always spawn a fresh subagent for review; an agent must never review its own work. Coordinate mid-flight via SendMessage to a specific agent; use a team broadcast for wave-wide updates.

## Context Curation

When dispatching an engineer for a group, the team-lead MUST extract the relevant context from WISH.md and paste it directly into the dispatch prompt. Do NOT tell the engineer to "read WISH.md" — curate the context for them.

**Why:** Reading WISH.md wastes engineer context window on metadata, other groups, and scope sections irrelevant to their task. Curated context = better focus, fewer hallucinations about scope, and faster execution.

**What to extract and paste into the dispatch prompt:**

1. **Group goal** — one sentence describing what this group achieves
2. **Group deliverables** — the numbered list of concrete outputs
3. **Acceptance criteria** — the checkbox list the engineer must satisfy
4. **Validation command** — the exact command to run to verify the work (e.g., `bun run check`)
5. **Depends-on** — any groups that must complete first (for context on what the engineer can assume exists)

**Example dispatch prompt structure:**

```
Execute Group N of wish "<slug>".

Goal: <one sentence>

Deliverables:
1. <deliverable 1>
2. <deliverable 2>

Acceptance Criteria:
- [ ] <criterion 1>
- [ ] <criterion 2>

Validation: <command>

Depends-on: <group refs or "none">
```

**Anti-pattern:** `"Implement Group 2. Read WISH.md for details."` — this forces the engineer to parse an entire wish document, navigate to the right section, and risk being distracted by other groups' scope. The team-lead has already read the wish; don't make the engineer re-read it.

## State Management

- **Engineers claim** their group by running `genie v5 task checkout <task-id> --worker <name>` as the first step of their brief — the atomic claim is what prevents two agents working the same group.
- **Engineers signal** completion in their final message; the native team notifies the orchestrator (no manual send required).
- **Orchestrator tracks** wave state via `genie v5 task list --wish <slug>` / `genie v5 board --wish <slug>` (read on demand) and completes each verified group with `genie v5 task done <task-id>`.
- Engineers do NOT call `genie v5 task done` — completing a group is the orchestrator's responsibility, only after review is clean and the validation command passes.
- **The dependency DAG is doc-only.** The v5 CLI has no dependency-edge commands, so every CLI-created task is `ready` from birth — DB status is NOT a dependency signal. The orchestrator sequences waves from the WISH.md Execution Strategy alone; never dispatch a group just because its task shows `ready`.

## Escalation

When a subagent fails or the fix-loop limit (2) is exceeded:
- Leave the group's task in `in_progress` (do not mark it `done`) and record the blocker in the wish's notes.
- Capture concrete gaps as a follow-up item in the WISH.md / handoff.
- Continue dispatching any other ready groups that do not depend on the blocked one.
- Include blocked items in the final handoff.

## Task Lifecycle Integration

Per-group execution state lives in the zero-daemon state DB. The state machine is `blocked → ready → in_progress → done`:

| Event | Command | Who |
|-------|---------|-----|
| Claim a ready group | `genie v5 task checkout <task-id> --worker <name>` | engineer (first step of brief) |
| Inspect progress | `genie v5 task list --wish <slug>` / `genie v5 board --wish <slug>` | orchestrator, on demand |
| Group verified complete | `genie v5 task done <task-id>` | orchestrator, after review + validation |

**Graceful degradation:** If no task exists for a group (e.g. the wish predates the state DB, or `.genie/genie.db` is unavailable), skip the `genie v5 task` calls and drive the wave off the WISH.md document directly. Task tracking is an enhancement — the core dispatch/review/validate flow must never break due to a missing task row.

## Example: Full Dispatch Cycle

Wish `fix-dispatch-initial-prompt` has 1 execution group (task id `7`). The orchestrator runs `/work`:

1. **Dispatch the wave.** In one message, issue an Agent tool call spawning an engineer subagent with curated context. The brief opens with the claim:
   ```bash
   genie v5 task checkout 7 --worker engineer-1
   ```
   The engineer implements the group, then reports completion in its final message.

2. **Await notification (no polling).** The native team notifies the orchestrator when the engineer finishes. Inspect on demand if needed:
   ```bash
   genie v5 board --wish fix-dispatch-initial-prompt
   ```

3. **Review (reviewer ≠ engineer).** Spawn a reviewer subagent via the Agent tool, briefed to run `/review` against the group's acceptance criteria (run `bun test`, check all 5 call sites). Reviewer returns SHIP.

4. **Validate + complete.** Run the group's validation command yourself, then:
   ```bash
   genie v5 task done 7
   ```

5. **PR.**
   ```bash
   git add -A && git commit -m "fix: pass initialPrompt to handleWorkerSpawn in all dispatch commands"
   git push origin HEAD
   gh pr create --base dev --title "fix: pass initialPrompt to dispatch" --body "Fixes #745. Wish: fix-dispatch-initial-prompt"
   ```

For multi-wave wishes, mark the wave's tasks `genie v5 task done`, then read the WISH.md Execution Strategy to pick the next wave's groups and dispatch them the same way.

## Rules
- Never execute group work directly — always dispatch subagents via the Agent tool.
- Never expand scope during execution.
- Never skip validation commands.
- Never overwrite WISH.md from a subagent's output — curated/refined prompts are runtime context only; the WISH.md in git is the source of truth.
- Reviewer ≠ engineer, always — never let an agent review its own work.
- Complete a group's task (`genie v5 task done`) only after review is clean and validation passes.
- Keep work auditable: capture commands + outcomes.

## Session close (required)

When spawned as a native-team subagent, your final message IS the completion signal — the orchestrator is notified when you finish; do not poll or emit a separate contract call. End every session with one explicit terminal outcome in that final message:

- **done** — the group's acceptance criteria are met and its validation command passes. Report evidence (commands + outcomes) and the task id you completed.
- **blocked** — stuck, needs human input or an unblocking signal. State exactly what you need; leave the task `in_progress`.
- **failed** — aborted, irrecoverable error, or cannot proceed. State why; leave the task `in_progress`.

Rules:
- State exactly one outcome as the last thing you say.
- `blocked` / `failed` must include a one-line reason.
