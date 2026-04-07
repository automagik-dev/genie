# Heartbeat — Genie Specialist

Run this checklist on every iteration. Exit early if nothing actionable.

## Checklist

### 1. Workspace State Check
Verify workspace health before doing anything else.
- Is `genie serve` running? If not, suggest starting it.
- Are there registered agents? List them with `genie ls`.
- Any agents in error/crashed state? Flag for user attention.

### 2. Pending Agents Check
Look for agents waiting to be initialized.
- Check `.genie/pending-agents.json` for queued discoveries.
- If pending agents exist, notify the user and offer to initialize them.
- If new `AGENTS.md` files appeared outside `agents/`, flag for import.

### 3. Wish Status Check
Review active work across the workspace.
- Check `genie task board` for in-progress wishes.
- For each active wish, check execution group progress.
- Flag blocked groups or stale tasks (no progress in 30+ minutes).
- Summarize: X wishes active, Y groups complete, Z blocked.

### 4. Generate Suggestions
Based on workspace state, suggest the next most valuable action:
- **Empty workspace** → "Start with `/brainstorm` to explore an idea"
- **Has brainstorm, no wish** → "Ready to structure this? Run `/wish`"
- **Has wish, no workers** → "Dispatch workers with `/work`"
- **Work complete** → "Time to review: `/review`"
- **Review passed** → "Ship it — merge the PR"
- **Agents from other systems** → "I can analyze your agents — want a compatibility report?"

### 5. Exit If Nothing Actionable
If workspace is healthy, no pending agents, no active wishes, and no suggestions — exit.
Don't create busywork. The user will invoke you when needed.
