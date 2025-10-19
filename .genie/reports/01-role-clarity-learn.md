# 🧞📚 Learning Report: role-clarity
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Sequence:** 01
**Context ID:** role-clarity
**Type:** violation
**Severity:** CRITICAL
**Teacher:** Felipe
**Date:** 2025-10-17 22:45 UTC

---

## Teaching Input

```
Violation: Role Confusion - Human Interface vs Executor

Evidence: Session 2025-10-17 ~22:45 UTC
- Felipe resumed session with SESSION-STATE.md showing 2 active agents:
  - implementor (e96e1ffb-b5f0-4aa0-9557-10de4fcd54dd)
  - learn (84e3290d-f07a-4c76-bfaa-faef71d38fd4)
- Both sessions showed "completed" but "No messages yet" (MCP bug suspected)
- Instead of checking session results or resuming agents, I:
  - Created TodoWrite list immediately
  - Started reading AGENTS.md to extract sections MYSELF
  - Bypassed the implementor session entirely
  - Began manual implementation work

Impact: CLAUDE.md, AGENTS.md, .genie/USERCONTEXT.md (role clarity)

Correction: My role = Human interface + orchestrator, NOT implementor

Required behavior:
1. Session resume → Check subagent results FIRST (mcp__genie__view with sessionId)
2. Sessions not found → Ask Felipe what to do, don't assume
3. Subagent failed/incomplete → Resume or restart subagent, don't implement myself
4. Execute directly ONLY when Felipe says "execute directly" or equivalent
5. Default mode = delegation, not execution

Context: Felipe's exact words: "you have subagents running with genie.... stop trying
to execute tasks yourself, you're the human interface only, you can ONLY EXECUTE
directly when I say so"

Root cause: Confusion between:
- Orchestrator role (delegate, route, coordinate)
- Implementor role (execute, edit files, make changes)

I am the orchestrator. I am NOT the implementor.
```

---

## Analysis

### Type Identified
**Violation** - Critical behavioral override needed

### Key Information Extracted

**What:** Role confusion between human interface (orchestrator) and executor (implementor)

**Why:** When Felipe resumed session with active agent references in SESSION-STATE.md, I:
1. Bypassed checking session results first
2. Created TodoWrite and started manual implementation
3. Ignored the implementor session completely
4. Acted as implementor instead of orchestrator

**Where:** Affects all orchestration contexts - CLAUDE.md, AGENTS.md, USERCONTEXT.md

**How:** Add explicit "Role Clarity Protocol" with mandatory session-check steps and delegation rules

### Affected Files

1. **AGENTS.md** (`<critical_behavioral_overrides>`)
   - Add new "Role Clarity Protocol" section after Delegation Discipline
   - Define orchestrator vs implementor roles explicitly
   - Specify mandatory session-check workflow
   - Document escalation rules when sessions not found

2. **CLAUDE.md** (Delegation Discipline section)
   - Strengthen existing guidance with session resume protocol
   - Add explicit role clarity statements
   - Clarify when direct execution is allowed

3. **.genie/USERCONTEXT.md** (Core Working Patterns)
   - Add explicit role reminder
   - Document Felipe's teaching
   - Clarify working relationship (human interface only)

---

## Changes Made

### File 1: AGENTS.md

**Section:** `<critical_behavioral_overrides>` (after Delegation Discipline)
**Edit type:** insert (new section)
**Lines added:** 58 lines

**Diff:**
```diff
+### Role Clarity Protocol *(CRITICAL)*
+**NEVER** bypass session checks when resuming work. **ALWAYS** check session results before assuming work needs to be done.
+
+**Core role distinction:**
+- **Orchestrator:** Human interface, routes work, coordinates specialists, maintains conversation
+- **Implementor/Specialist:** Executes tasks, makes file changes, implements solutions
+
+**Forbidden actions:**
+- ❌ Creating TodoWrite and starting execution when SESSION-STATE.md shows active agents
+- ❌ Bypassing mcp__genie__view when resuming with active sessions
+- ❌ Implementing work manually when implementor session exists
+- ❌ Assuming "no messages" means "work not done" (could be MCP bug)
+
+**Required workflow:**
+
+**When resuming session with SESSION-STATE.md references:**
+1. **FIRST ACTION:** Check each session: `mcp__genie__view with sessionId="<id>"`
+2. **Sessions found:** Resume or continue work via `mcp__genie__resume`
+3. **Sessions not found:** Report to Felipe, ask for guidance
+4. **NEVER:** Create TodoWrite + start execution when agents referenced
+
+**When Felipe says "execute directly":**
+- ✅ Use Edit/Write/Read tools directly
+- ✅ Create TodoWrite for tracking
+- ✅ Execute implementation yourself
+
+**When Felipe does NOT say "execute directly":**
+- ✅ Check sessions FIRST
+- ✅ Delegate to implementor via MCP
+- ❌ NEVER execute implementation yourself
+
+**Why:**
+- Role clarity: Human interface ≠ implementor
+- Session continuity: Respect active specialist work
+- Evidence trail: Check results before redoing work
+- Efficiency: Don't duplicate specialist efforts
+
+**Recent violation (2025-10-17 22:45 UTC):**
+- Felipe resumed with SESSION-STATE.md showing 2 active agents (implementor, learn)
+- Both showed "completed" but "No messages yet" (suspected MCP bug)
+- Instead of checking sessions first, I:
+  - Created TodoWrite immediately
+  - Started reading AGENTS.md to extract sections MYSELF
+  - Bypassed implementor session entirely
+  - Began manual implementation work
+- **Pattern:** See SESSION-STATE.md → ignore it → implement manually
+- **Root cause:** Confusion between orchestrator role (route) and implementor role (execute)
+- **Result:** Bypassed specialist work, violated human interface principle
+- **Evidence:** Felipe's words: "you have subagents running with genie.... stop trying to execute tasks yourself, you're the human interface only, you can ONLY EXECUTE directly when I say so"
+- **Additional evidence:** mcp__genie__view returned "No run found" for both sessions, should have reported this immediately instead of assuming work needed
+
+**Validation:** When resuming with SESSION-STATE.md references:
+- First action: `mcp__genie__view` for each sessionId
+- Sessions not found: Report to Felipe immediately
+- Sessions found incomplete: Resume via `mcp__genie__resume`
+- Default mode: delegation
+- Direct execution: ONLY when Felipe explicitly says so
+- Document "checked session first" in response
```

**Reasoning:** Creates explicit protocol for session resume workflow, preventing future role confusion. Places responsibility clearly: orchestrator checks first, implementor executes.

### File 2: CLAUDE.md

**Section:** Delegation Discipline (validation section)
**Edit type:** insert (additional guidance)
**Lines added:** 15 lines

**Diff:**
```diff
+**Session Resume Protocol (CRITICAL):**
+- **When SESSION-STATE.md shows active agents:**
+  1. FIRST ACTION: Check sessions with `mcp__genie__view with sessionId="<id>"`
+  2. Sessions found: Resume via `mcp__genie__resume`
+  3. Sessions not found: Report to Felipe, ask for guidance
+  4. NEVER: Create TodoWrite + start implementation when agents exist
+
+**Role Clarity:**
+- **I am the human interface/orchestrator** - I route, coordinate, and guide
+- **I am NOT the implementor** - I do NOT execute multi-file implementation work
+- **Direct execution allowed ONLY when Felipe says "execute directly"**
+- **Default mode: delegation** - Check sessions, delegate to specialists
+
 **Validation:**
 - Before using Edit tool, count files affected
 - If >2 files → delegate to implementor
 - If repetitive pattern → delegate, don't implement
 - Track delegation vs manual work ratio in context updates
+- When resuming with active sessions → Check sessions FIRST, never bypass
```

**Reasoning:** Strengthens existing delegation discipline section with explicit session resume protocol and role clarity statements. Makes it immediately visible when reading CLAUDE.md.

### File 3: .genie/USERCONTEXT.md

**Section:** Core Working Patterns
**Edit type:** append (new pattern)
**Lines added:** 5 lines

**Diff:**
```diff
 ### Core Working Patterns
 - **Evidence-first:** Always show file paths, commits, diffs
 - **Ultrathink before acting:** Deep analysis > rushed decisions
 - **Surgical precision:** Minimal targeted edits
 - **One decision at a time:** Sequential > parallel (cognitive load)
 - **Dig deeper first:** Analyze codebase before asking for guidance
 - **Maintain TODO.md:** Track work priorities, not just ideas
+- **Role clarity (CRITICAL):** I am human interface ONLY (orchestrator), NOT implementor (executor)
+  - Check sessions FIRST when resuming with active agents (SESSION-STATE.md)
+  - Direct execution ONLY when Felipe explicitly says "execute directly"
+  - Default mode: delegation to specialists via MCP
+  - Never bypass session checks to start manual implementation
```

**Reasoning:** Adds explicit role reminder to user context patterns so it's loaded on every session. Makes the human interface principle immediately visible to future sessions.

---

## Validation

### How to Verify

**Test 1: Session resume with active agents**
1. Create implementor session via `mcp__genie__run`
2. Create SESSION-STATE.md with sessionId reference
3. Resume session
4. Expected: First action is `mcp__genie__view with sessionId="<id>"`
5. Expected: No TodoWrite created until session checked

**Test 2: Sessions not found**
1. SESSION-STATE.md references non-existent sessionId
2. Resume session
3. Expected: Report "No run found" to Felipe immediately
4. Expected: Ask for guidance instead of starting manual work

**Test 3: Direct execution**
1. Felipe says "execute directly" or equivalent
2. Expected: TodoWrite created, manual implementation begins
3. Expected: Edit/Write tools used for implementation

### Follow-up Actions

- [ ] Monitor next session resume with active agents
- [ ] Verify session check happens first (no TodoWrite before check)
- [ ] Confirm "No run found" is reported immediately
- [ ] Document pattern adherence in session notes

---

## Evidence

### Before (Violation)
```
Felipe: [resumes session with SESSION-STATE.md showing active agents]
Assistant: *Creates TodoWrite immediately*
Assistant: *Reads AGENTS.md to extract sections*
Assistant: *Starts manual implementation with Edit tool*
Result: Bypassed implementor session, violated human interface principle
```

### After (Correction)
```
Felipe: [resumes session with SESSION-STATE.md showing active agents]
Assistant: *First action: mcp__genie__view for each sessionId*
Assistant: *Sessions not found: "No run found for both sessions. What should I do?"*
Felipe: [provides guidance]
Assistant: *Follows Felipe's guidance*
Result: Role clarity respected, Felipe maintains control
```

---

## Meta-Notes

**Pattern observed:** Tendency to bypass session checks when seeing SESSION-STATE.md references, assuming work needs to be done manually.

**Root cause:** Insufficient distinction between orchestrator role (human interface) and implementor role (executor).

**Key insight:** "No messages yet" or "No run found" does NOT mean "do the work myself" - it means "report to Felipe and ask for guidance."

**Critical teaching:** Felipe's words capture the essence: "you're the human interface only, you can ONLY EXECUTE directly when I say so"

**Architectural principle:** SESSION-STATE.md is the source of truth for active work. Checking sessions FIRST is non-negotiable.

---

**Learning absorbed and propagated successfully.** 🧞📚✅

**Report location:** `.genie/reports/01-role-clarity-learn.md`

**Files modified:**
1. `AGENTS.md` - Added Role Clarity Protocol (58 lines)
2. `CLAUDE.md` - Added Session Resume Protocol (15 lines)
3. `.genie/USERCONTEXT.md` - Added Role Clarity pattern (5 lines)

**Total changes:** 78 lines added across 3 critical files

**Severity justified:** CRITICAL - Violated core "human interface only" principle, bypassed active specialist work, ignored SESSION-STATE.md references.

**Future prevention:** Explicit protocol now documented in all three knowledge files (AGENTS.md, CLAUDE.md, USERCONTEXT.md) with concrete workflows and validation steps.
