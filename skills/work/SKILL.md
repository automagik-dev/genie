---
name: work
description: "Execute an approved wish plan — orchestrate subagents per task group with fix loops, validation, and review handoff."
---

# /work — Execute Wish Plan

The engineer's skill, invoked via `genie work <agent> <ref>` dispatch. Orchestrate execution of an approved wish from `.genie/wishes/<slug>/WISH.md`. The orchestrator never executes directly — always dispatch via subagent.

## Context Injection

This skill receives its execution context from the dispatch layer:
- **Wish path** — `.genie/wishes/<slug>/WISH.md` in the shared worktree
- **Group context** — which execution group(s) to work on
- **Injected section** — the specific group definition extracted from the wish

If context is injected, use it directly. Do not re-parse the wish for information already provided.

## Flow
1. **Load wish:** read `.genie/wishes/<slug>/WISH.md` from the shared worktree, confirm scope.
2. **Pick next task:** select next unblocked pending execution group (or use injected group context).
3. **Task checkout (v4):** if a PG task exists for this group, claim it before starting:
   ```bash
   genie task checkout #<seq>
   ```
4. **Self-refine:** dispatch `/refine` on the task prompt (text mode) with WISH.md as context anchor. Read output from `/tmp/prompts/<slug>.md`. Fallback: proceed with original prompt if refiner fails (non-blocking).
5. **Dispatch worker:** send the task to a fresh subagent session (see Dispatch).
6. **Progress update (v4):** log progress as task comments during execution:
   ```bash
   genie task comment #<seq> "Building group N..."
   ```
7. **Local review:** run `/review` against the wish spec for this group's acceptance criteria before signaling done. On FIX-FIRST, dispatch fix subagent (max 2 loops).
8. **Quality review:** dispatch review subagent for quality pass (security, maintainability, perf). On FIX-FIRST, dispatch fix subagent (max 1 loop).
9. **Validate:** run the group validation command, record evidence.
10. **Group done (v4):** move the task to review stage:
    ```bash
    genie task move #<seq> --to review --comment "Group N complete"
    ```
11. **Signal completion:** notify the leader via `genie agent send 'Group N complete — all criteria met' --to <leader>`.
12. **Repeat** steps 2-11 until all groups done.
13. **Wish done (v4):** mark the parent task done:
    ```bash
    genie task done #<parent-seq> --comment "All groups shipped"
    ```
14. **Handoff:** `All work tasks complete. Run /review.`

## When to Use
- An approved wish exists and is ready for execution
- Orchestrator needs to dispatch implementation tasks to subagents
- After `/review` returns SHIP on the plan

## Dispatch

All dispatch uses the `genie agent spawn` command. The orchestrator spawns subagents for each role — never executes work directly.

```bash
# Spawn an engineer for the task
genie agent spawn engineer

# Spawn a reviewer (always separate from engineer)
genie agent spawn reviewer

# Spawn a fixer for FIX-FIRST gaps
genie agent spawn fixer
```

| Need | Method |
|------|--------|
| Implementation task | `genie agent spawn engineer` |
| Review task | `genie agent spawn reviewer` (never same agent as engineer) |
| Fix task | `genie agent spawn fixer` (separate from reviewer) |
| Quick validation | `Bash` tool directly — no subagent needed |

Coordinate via `genie agent send '<message>' --to <agent>`. Use `genie agent send '<message>' --broadcast` for team-wide updates.

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

- **Workers signal** completion via `genie agent send` to the leader when a group is done.
- **Leader tracks** wish-group state via `genie wish status <slug>` and marks groups complete via `genie wish done <slug>#<group>` (and, when PG tasks exist, `genie task done #<seq>`).
- Workers do NOT call `genie task done` — that is the leader's responsibility after verifying the work.
- If a group gets stuck, the leader can use `genie wish reset <ref>` to retry.

## Escalation

When a subagent fails or fix loop limit (2) is exceeded:
- Mark task **BLOCKED** in wish.
- Create follow-up task with concrete gaps.
- Continue with next unblocked task.
- Include blocked items in final handoff.

## Task Lifecycle Integration (v4)

When PG tasks exist for the wish, use `genie task` commands to track execution:

| Event | Command |
|-------|---------|
| Start working on group | `genie task checkout #<seq>` |
| Progress update | `genie task comment #<seq> "<status>"` |
| Group complete | `genie task move #<seq> --to review --comment "Group N complete"` |
| All groups done | `genie task done #<parent-seq> --comment "All groups shipped"` |
| Group blocked | `genie task block #<seq> --reason "<reason>"` |

**Graceful degradation:** If no PG task exists for the wish (e.g., PG unavailable or wish was created before v4), skip all `genie task` commands and fall back to current behavior. Task integration is optional — the core flow must never break due to missing tasks.

## Example: Full Dispatch Cycle

Wish `fix-dispatch-initial-prompt` has 1 execution group. The orchestrator runs `/work`:

```bash
# 1. Dispatch wave (spawns engineers automatically)
genie work fix-dispatch-initial-prompt
# Output: 🚀 Dispatching Wave 1 — 1 group(s)
#         ✅ Group "1" set to in_progress
#         🔧 Dispatching work to engineer for "fix-dispatch-initial-prompt#1"

# 2. Monitor (ALWAYS sleep 60 between checks)
sleep 60 && genie wish status fix-dispatch-initial-prompt
# Output: Group 1: 🔄 in_progress

# 3. Check again
sleep 60 && genie wish status fix-dispatch-initial-prompt
# Output: Group 1: ✅ done — Progress: 1/1 done

# 4. All groups done → local review
genie agent spawn reviewer
genie agent send 'Review wish fix-dispatch-initial-prompt. Run bun test and check all 5 call sites.' --to reviewer
# Reviewer returns: SHIP

# 5. Create PR
git add -A && git commit -m "fix: pass initialPrompt to handleWorkerSpawn in all dispatch commands"
git push origin HEAD
gh pr create --base dev --title "fix: pass initialPrompt to dispatch" --body "Fixes #745. Wish: fix-dispatch-initial-prompt"
```

For multi-wave wishes, call `genie work <slug>` again after each wave completes — it dispatches the next wave automatically.

## Rules
- Never execute directly — always dispatch subagents.
- Never expand scope during execution.
- Never skip validation commands.
- Never overwrite WISH.md from workers — refined prompts are runtime context only.
- Keep work auditable: capture commands + outcomes.
- Run local `/review` per group before signaling done — never skip the review gate.

## Turn close (required)

Every session MUST end by writing a terminal outcome to the turn-session contract. This is how the orchestrator reconciles executor state — skipping it leaves the row open and blocks auto-resume.

- `genie done` — work completed, acceptance criteria met
- `genie blocked --reason "<why>"` — stuck, needs human input or an unblocking signal
- `genie failed --reason "<why>"` — aborted, irrecoverable error, or cannot proceed

Rules:
- Call exactly one close verb as the last action of the session.
- `blocked` / `failed` require `--reason`.
- `genie done` inside an agent session (GENIE_AGENT_NAME set) closes the current executor; it does not require a wish ref.
