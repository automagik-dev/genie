# Agent Instructions

This project uses **bd** (beads) for issue tracking. Run `bd onboard` to get started.

## Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --status in_progress  # Claim work
bd close <id>         # Complete work
bd sync               # Sync with git
```

## Co-Orchestration Mode

When working as a **spawned worker** via `term work`, you are part of a multi-agent system:

1. **You are bound to a specific issue** - Focus ONLY on that task
2. **Your state is tracked** - The orchestrator sees your status (working/idle/permission/etc.)
3. **You work in an isolated worktree** - Your changes don't affect other workers
4. **Beads syncs automatically** - The daemon handles commits

### CLI Improvement Rule (CRITICAL)

**DO NOT implement CLI improvements directly.** When you identify an opportunity to improve genie-cli:

1. Create an issue: `bd create "CLI: <improvement>" --label cli-improvement`
2. Continue with your assigned task
3. A dedicated `genie-cli-improver` worker will handle CLI changes

This ensures:
- Your current task stays focused
- CLI changes are isolated and reviewable
- No scope creep in your work

### Worker Lifecycle

```
term work bd-X  →  You start  →  Work on task  →  Signal completion  →  term close bd-X
```

When done with your task:
1. Commit your changes
2. Inform the orchestrator you're done (just say "Done" or similar)
3. The orchestrator will run `term close bd-X` to clean up

See `docs/CO-ORCHESTRATION-GUIDE.md` for the full orchestration workflow.

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd sync
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds



## ⚠️ Worktree Policy (MANDATORY)

**NEVER work on main for feature development.**

Before ANY code work:
1. Verify branch: `git branch --show-current` (must NOT be main)
2. If on main → STOP → create worktree or cd to existing one
3. THEN start editing

Full policy: `/home/genie/workspace/docs/WORKTREE-RULES.md`
