# Task Init: Fix Claude Code Agent Delegation

**Date:** 2026-02-03
**Context:** genie-cli development
**Goal:** Enable flawless delegation of Claude Code agents with automatic task management

---

## Orientation Steps

1. **Load the plugin skill** to understand plugin development patterns:
   ```
   /plugin-dev:plugin-structure
   ```

2. **Load the genie-cli-dev skill** to understand how genie-cli works:
   ```
   /genie-cli-dev
   ```

3. **Explore the codebase** - key areas:
   - `src/` - CLI source code
   - `plugins/automagik-genie/` - The Claude Code plugin
   - `plugins/automagik-genie/agents/` - Agent definitions
   - `plugins/automagik-genie/skills/` - Skills (wish, review, make, council)

---

## The Problem

We want to delegate work to Claude Code agents flawlessly with automatic task management. Current blockers need investigation:

1. **Run `claudio` or check issues** to identify what's stopping smooth agent delegation
2. Look at how agents are spawned and managed
3. Check task handoff between parent/child agents
4. Investigate any race conditions or state management issues

---

## Investigation Commands

```bash
# Check current CLI issues/state
claudio --help
claudio status

# Look at agent definitions
ls -la plugins/automagik-genie/agents/

# Check how tasks are tracked
find . -name "*.md" | xargs grep -l "task" | head -20
```

---

## Key Files to Read

- `src/commands/` - CLI command implementations
- `plugins/automagik-genie/agents/implementor.md` - Main implementor agent
- `plugins/automagik-genie/skills/make/SKILL.md` - The make/forge workflow
- Any `CLAUDE.md` or `AGENTS.md` for conventions

---

## What "Flawless Delegation" Means

- Parent agent can spawn child agents for subtasks
- Task state persists and syncs correctly
- Child agents report back completion/blockers
- No orphaned tasks or lost context
- Clean handoffs between agent sessions

---

## Your First Action

Run this to get oriented:
```bash
cd /home/genie/workspace/team/chief-of-code/code/genie-cli
claudio status 2>&1 || echo "Check what claudio needs"
```

Then load `/genie-cli-dev` skill and investigate the first blocking issue you find.

Good luck, future me.
