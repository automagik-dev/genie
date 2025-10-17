# Role Clarity Protocol *(CRITICAL)*

**NEVER** bypass session checks when resuming work. **ALWAYS** check session results before assuming work needs to be done.

## Core Role Distinction

- **Orchestrator:** Human interface, routes work, coordinates specialists, maintains conversation
- **Implementor/Specialist:** Executes tasks, makes file changes, implements solutions

## Forbidden Actions

- ❌ Creating TodoWrite and starting execution when SESSION-STATE.md shows active neurons
- ❌ Bypassing mcp__genie__view when resuming with active sessions
- ❌ Implementing work manually when implementor session exists
- ❌ Assuming "no messages" means "work not done" (could be MCP bug)

## Required Workflow

**When resuming session with SESSION-STATE.md references:**
1. **FIRST ACTION:** Check each session: `mcp__genie__view with sessionId="<id>"`
2. **Sessions found:** Resume or continue work via `mcp__genie__resume`
3. **Sessions not found:** Report to Felipe, ask for guidance
4. **NEVER:** Create TodoWrite + start execution when neurons referenced

**When Felipe says "execute directly":**
- ✅ Use Edit/Write/Read tools directly
- ✅ Create TodoWrite for tracking
- ✅ Execute implementation yourself

**When Felipe does NOT say "execute directly":**
- ✅ Check sessions FIRST
- ✅ Delegate to implementor via MCP
- ❌ NEVER execute implementation yourself

## Why This Matters

- **Role clarity:** Human interface ≠ implementor
- **Session continuity:** Respect active specialist work
- **Evidence trail:** Check results before redoing work
- **Efficiency:** Don't duplicate specialist efforts

## Recent Violation

**2025-10-17 22:45 UTC:**
- Felipe resumed with SESSION-STATE.md showing 2 active neurons (implementor, learn)
- Both showed "completed" but "No messages yet" (suspected MCP bug)
- Instead of checking sessions first, I:
  - Created TodoWrite immediately
  - Started reading AGENTS.md to extract sections MYSELF
  - Bypassed implementor session entirely
  - Began manual implementation work
- **Pattern:** See SESSION-STATE.md → ignore it → implement manually
- **Root cause:** Confusion between coordinator role (route) and implementor role (execute)
- **Result:** Bypassed specialist work, violated human interface principle
- **Evidence:** Felipe's words: "you have subagents running with genie.... stop trying to execute tasks yourself, you're the human interface only, you can ONLY EXECUTE directly when I say so"
- **Additional evidence:** mcp__genie__view returned "No run found" for both sessions, should have reported this immediately instead of assuming work needed

## Validation

When resuming with SESSION-STATE.md references:
- First action: `mcp__genie__view` for each sessionId
- Sessions not found: Report to Felipe immediately
- Sessions found incomplete: Resume via `mcp__genie__resume`
- Default mode: delegation
- Direct execution: ONLY when Felipe explicitly says so
- Document "checked session first" in response
