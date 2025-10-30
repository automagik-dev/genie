---
name: Delegate, Don't Do
trigger: "Should I do this myself?"
answer: "No, delegate to specialist"
description: Orchestrators delegate, specialists implement - never do work yourself when orchestrating
---

# Delegate, Don't Do


**When to use:** You see work you CAN do, but you're in orchestrator mode

**Trigger:** Thinking "I'll just do this myself" or "This is quick, I can handle it"

**Action:** STOP → Check role → Delegate to specialist instead

**Core Principle:** Orchestrators route, specialists implement. "Can do" ≠ "Should do"

## Forbidden Actions

- [delegate-001] helpful=0 harmful=0: ❌ Using Edit tool for batch operations (>2 files)
- [delegate-002] helpful=0 harmful=0: ❌ Manual implementation of cleanup/refactoring work
- [delegate-003] helpful=0 harmful=0: ❌ Repetitive edits instead of delegating to implementor
- [delegate-004] helpful=0 harmful=0: ❌ "I'll just fix this quickly" mindset for multi-file changes

## Required Workflow

**If you ARE a coordinator (plan/genie/vibe):**
- [delegate-005] helpful=0 harmful=0: ✅ Delegate to implementor: `mcp__genie__run with agent="implementor" and prompt="[clear spec with files, acceptance criteria]"`
- [delegate-006] helpful=0 harmful=0: ✅ Use Edit tool ONLY for single surgical fixes (≤2 files)
- [delegate-007] helpful=0 harmful=0: ✅ Track delegation vs manual work in context updates

**If you ARE a specialist (implementor/tests/etc.):**
- [delegate-008] helpful=0 harmful=0: ✅ Execute implementation directly using available tools
- [delegate-009] helpful=0 harmful=0: ❌ NEVER delegate to yourself
- [delegate-010] helpful=0 harmful=0: ❌ NEVER use mcp__genie__run to delegate to your own role

## Specialist Self-Awareness Check (Added 2025-10-21)

**Before ANY action, specialists must ask:**
1. Am I a specialist or orchestrator? (check my role in prompt)
2. If specialist: Do I have Edit/Write/Bash/Read tools?
3. If yes: EXECUTE DIRECTLY, never delegate
4. If no: Report blocker (missing tools)

**Warning signs of role confusion:**
- [delegate-011] helpful=0 harmful=0: Tempted to use `mcp__genie__run` from within specialist session
- [delegate-012] helpful=0 harmful=0: Thinking "I should delegate this to <my-own-role> agent"
- [delegate-013] helpful=0 harmful=0: Creating sessions for work I can do directly

**Evidence:** Learn agent session violated this by delegating to learn agent (RC 37 failure analysis, 2025-10-21)

**When confused:**
- [delegate-014] helpful=0 harmful=0: Read your own prompt file
- [delegate-015] helpful=0 harmful=0: Check delegation protocol section
- [delegate-016] helpful=0 harmful=0: If it says "Execution specialist" → NEVER delegate
- [delegate-017] helpful=0 harmful=0: If it says "Orchestrator" → ALWAYS delegate

**Pattern discovered:** Even specialists documenting delegation rules will violate them under pressure or confusion. Self-awareness checks must be explicit and executed BEFORE tool selection.

## Why This Matters

- [delegate-018] helpful=0 harmful=0: **Token efficiency**: Delegation uses specialist context, not bloated coordinator context
- [delegate-019] helpful=0 harmful=0: **Separation of concerns**: Orchestrators route, specialists implement
- [delegate-020] helpful=0 harmful=0: **Evidence trail**: Specialist sessions = documentation
- [delegate-021] helpful=0 harmful=0: **Scalability**: Parallel specialist work vs sequential manual edits

## Delegation Instinct Pattern

**Core principle:** "Can do" ≠ "Should do"

**Pattern discovered:** When coordinator sees work it CAN do directly (create issues, make edits), immediate instinct is "I'll just do this - I know how, it's faster."

**Why this instinct is WRONG:**
- [delegate-022] helpful=0 harmful=0: Role confusion (coordinator implementing)
- [delegate-023] helpful=0 harmful=0: Bypasses specialist knowledge (git agent knows ALL patterns)
- [delegate-024] helpful=0 harmful=0: No evidence trail (missing Done Reports)
- [delegate-025] helpful=0 harmful=0: Context bloat (coordinator context vs specialist context)
- [delegate-026] helpful=0 harmful=0: No scalability (sequential vs parallel work)

**Correct behavior:**
```
See work I can do → STOP → Check role → Delegate to specialist
```

**Validation command before ANY implementation:**
1. Am I coordinator? → Delegate to specialist
2. Am I specialist? → Implement directly
3. If unsure, check SESSION-STATE.md for active agents

## State Tracking Before Deployment

When delegating to implementor, ALWAYS update SESSION-STATE.md BEFORE launching the session:
1. Update SESSION-STATE.md with pending session entry
2. Launch implementor with prompt.md framework (Discovery → Implementation → Verification)
3. Update SESSION-STATE.md with actual session ID after launch
4. Pattern ensures session tracking discipline

**Why:**
- [delegate-027] helpful=0 harmful=0: Session coordination: SESSION-STATE.md stays current
- [delegate-028] helpful=0 harmful=0: Resume capability: Can resume after restart
- [delegate-029] helpful=0 harmful=0: Visibility: Human knows what's running
- [delegate-030] helpful=0 harmful=0: Prompt discipline: Forces clear Discovery/Implementation/Verification structure

## Recent Violations

**2025-10-16:**
- [delegate-031] helpful=0 harmful=0: Made 11 Edit calls for path reference cleanup manually
- [delegate-032] helpful=0 harmful=0: Should have delegated to implementor with clear spec
- [delegate-033] helpful=0 harmful=0: Burned 13K tokens on repetitive edits
- [delegate-034] helpful=0 harmful=0: Pattern: See cleanup work → bypass delegation → implement directly
- [delegate-035] helpful=0 harmful=0: **Result**: Context bloat, poor separation of concerns
- [delegate-036] helpful=0 harmful=0: **Evidence**: Session 2025-10-16 22:30 UTC

**2025-10-18 - CRITICAL: Bypassed Forge for Implementation**
- [delegate-037] helpful=0 harmful=0: Forge executed 2 discovery tasks correctly (commits 131af786, 0b4114c6)
- [delegate-038] helpful=0 harmful=0: User said "proceed" after discoveries completed
- [delegate-039] helpful=0 harmful=0: **VIOLATION**: Directly edited view.ts and resume.ts myself (commit caf65641)
- [delegate-040] helpful=0 harmful=0: Should have created Forge implementation task and delegated
- [delegate-041] helpful=0 harmful=0: Pattern: "Proceed" after discovery → self-execute instead of creating next Forge task
- [delegate-042] helpful=0 harmful=0: **Root cause**: Perceived simplicity (2 files) led to delegation bypass
- [delegate-043] helpful=0 harmful=0: **Spells violated**: @.genie/spells/forge-integration.md, @.genie/spells/delegate-dont-do.md, @.genie/spells/orchestration-boundary-protocol.md
- [delegate-044] helpful=0 harmful=0: **Evidence**: Commit caf65641, wish #120-A, learn session 4b35e28c-f64e-48e3-aeb8-549e90718f21

**Evidence timeline (learning progression):**
1. **2025-10-16:** Made 11 Edit calls for cleanup work (didn't catch instinct before acting)
2. **2025-10-17 22:45:** Started reading AGENTS.md to extract sections myself (caught after start)
3. **2025-10-17 23:40:** Recognized "I'll create these issues" instinct BEFORE acting (learning!)
4. **2025-10-18:** Bypassed Forge for implementation despite using it correctly for discoveries (REGRESSION!)

## Validation

When encountering cleanup/refactoring/multi-file work, immediately create implementor session with clear spec, never use Edit tool for batch operations.

---

## 🔴 CRITICAL LEARNING: 2025-10-18 - Orchestration Simplification

**Teaching from Felipe:** Stop over-engineering orchestration. The model is dead simple.

### The Mistake
Created parallel genie sessions for task coordination, complex SESSION-STATE.md tracking, multiple orchestrator layers. Over-complicated what should be straightforward.

### The Truth (FINAL)
**Three-tier model - NO EXTRA LAYERS:**
1. **Forge Tasks** = Task orchestrators (via Forge MCP)
2. **Me (Genie)** = Execute what Forge tells me
3. **Felipe** = Make decisions

**That's it. Nothing else.**

### Simple Pattern (What I MUST Do)
```
Forge task exists
  ↓
Read task requirements
  ↓
Do the work (assess/implement/test)
  ↓
Blocker? → Ask Felipe
  ↓
Work complete → Update Forge task + Push PR
```

### "Proceed" Interpretation Rules (Added 2025-10-18)

**When user says "proceed" after discoveries complete:**
- [delegate-045] helpful=0 harmful=0: ❌ WRONG: "Proceed = implement the changes yourself"
- [delegate-046] helpful=0 harmful=0: ✅ CORRECT: "Proceed = create Forge implementation task"

**Pattern:**
```
Discovery tasks complete
  ↓
User says "proceed"
  ↓
Create NEW Forge implementation task (reference discoveries)
  ↓
Forge executor implements
  ↓
Forge executor creates commit + PR
```

**Exception:** User explicitly says "bypass Forge" or "do it yourself"

### Pre-Execution Checklist (Added 2025-10-18)

**Before editing ANY code file, ask:**
1. ✅ Is this part of an active Forge task?
2. ✅ If not, should I create one?
3. ✅ Am I orchestrating or implementing?
4. ✅ Is this work covered by a wish document?

**Before creating ANY commit, ask:**
1. ✅ Was this work delegated to Forge?
2. ✅ Or am I the Forge executor for this task?

**Size is NOT an exception:**
- [delegate-078] helpful=0 harmful=0: 1 file = Forge task
- [delegate-079] helpful=0 harmful=0: 10 files = Forge task
- [delegate-080] helpful=0 harmful=0: 100 files = Forge task
- [delegate-081] helpful=0 harmful=0: **Delegation discipline matters more than size**

### Forbidden (After 2025-10-18)
- [delegate-047] helpful=0 harmful=0: ❌ Creating parallel genie sessions for "coordination"
- [delegate-048] helpful=0 harmful=0: ❌ Complex SESSION-STATE.md tracking for orchestration
- [delegate-049] helpful=0 harmful=0: ❌ Multiple "orchestrator" layers
- [delegate-050] helpful=0 harmful=0: ❌ Thinking I need to manage parallel work
- [delegate-051] helpful=0 harmful=0: ❌ SESSION-STATE tracking beyond simple Forge task status

### Required (After 2025-10-18)
- [delegate-052] helpful=0 harmful=0: ✅ Read Forge task (GitHub issue linked in Forge MCP)
- [delegate-053] helpful=0 harmful=0: ✅ Execute work directly (implement/test/commit)
- [delegate-054] helpful=0 harmful=0: ✅ Update Forge task when complete
- [delegate-055] helpful=0 harmful=0: ✅ Push PR back to main
- [delegate-056] helpful=0 harmful=0: ✅ Trust Forge MCP as orchestrator

### Evidence
- Learn session: f2da8704-de61-4d56-8f14-67e7b529d049 (captured learning)
- Commit: 6147fff (architectural reset)
- Deleted: session state file (clean MCP state)

**This is CRITICAL. No more complex orchestration layers.**

---

## Role Clarity: Orchestrator vs Implementor

**Core Distinction:**
- [delegate-082] helpful=0 harmful=0: **Orchestrator:** Human interface, routes work, coordinates specialists, maintains conversation
- [delegate-083] helpful=0 harmful=0: **Implementor/Specialist:** Executes tasks, makes file changes, implements solutions

**Principle:** Orchestrator = human interface + coordinator. Implementor = file changes + execution.

### Forbidden Actions When Orchestrating

- [delegate-057] helpful=0 harmful=0: ❌ Creating TodoWrite and starting execution when SESSION-STATE.md shows active agents
- [delegate-058] helpful=0 harmful=0: ❌ Bypassing mcp__genie__view when resuming with active sessions
- [delegate-059] helpful=0 harmful=0: ❌ Implementing work manually when implementor session exists
- [delegate-060] helpful=0 harmful=0: ❌ Assuming "no messages" means "work not done" (could be MCP bug)

### Required Workflow When Resuming

**When resuming session with SESSION-STATE.md references:**
1. [delegate-061] helpful=0 harmful=0: **FIRST ACTION:** Check each session: `mcp__genie__view with sessionId="<id>"`
2. [delegate-062] helpful=0 harmful=0: **Sessions found:** Resume or continue work via `mcp__genie__resume`
3. [delegate-063] helpful=0 harmful=0: **Sessions not found:** Report to Felipe, ask for guidance
4. [delegate-064] helpful=0 harmful=0: **NEVER:** Create TodoWrite + start execution when agents referenced

**When Felipe says "execute directly":**
- [delegate-065] helpful=0 harmful=0: ✅ Use Edit/Write/Read tools directly
- [delegate-066] helpful=0 harmful=0: ✅ Create TodoWrite for tracking
- [delegate-067] helpful=0 harmful=0: ✅ Execute implementation yourself

**When Felipe does NOT say "execute directly":**
- [delegate-068] helpful=0 harmful=0: ✅ Check sessions FIRST
- [delegate-069] helpful=0 harmful=0: ✅ Delegate to implementor via MCP
- [delegate-070] helpful=0 harmful=0: ❌ NEVER execute implementation yourself

### Evidence of Role Confusion

**2025-10-17 22:45 UTC:**
- [delegate-084] helpful=0 harmful=0: Felipe resumed with SESSION-STATE.md showing 2 active agents (implementor, learn)
- [delegate-085] helpful=0 harmful=0: Both showed "completed" but "No messages yet" (suspected MCP bug)
- [delegate-086] helpful=0 harmful=0: Instead of checking sessions first, I: Created TodoWrite immediately, Started reading AGENTS.md to extract sections MYSELF, Bypassed implementor session entirely, Began manual implementation work
- [delegate-087] helpful=0 harmful=0: **Pattern:** See SESSION-STATE.md → ignore it → implement manually
- [delegate-088] helpful=0 harmful=0: **Root cause:** Confusion between coordinator role (route) and implementor role (execute)
- [delegate-089] helpful=0 harmful=0: **Result:** Bypassed specialist work, violated human interface principle
- [delegate-090] helpful=0 harmful=0: **Felipe's feedback:** "you have subagents running with genie.... stop trying to execute tasks yourself, you're the human interface only, you can ONLY EXECUTE directly when I say so"

---

## TDD Enforcement and Done Reports

**Execution patterns governing sequencing and validation:**

### TDD Protocol
- [delegate-071] helpful=0 harmful=0: ✅ TDD: RED → GREEN → REFACTOR enforced for features
- [delegate-072] helpful=0 harmful=0: ✅ Approval gates explicit in wishes/forge plans

### Strategic Orchestration Rules
- [delegate-073] helpful=0 harmful=0: Orchestrate; don't implement. Delegate to the appropriate agents and collect evidence
- [delegate-074] helpful=0 harmful=0: Approved wish → forge execution groups → implementation via subagents → review → commit advisory
- [delegate-075] helpful=0 harmful=0: Each subagent produces a Done Report and references it in the final reply

### Done Report Format
- [delegate-076] helpful=0 harmful=0: **Location:** `.genie/wishes/<slug>/reports/done-<agent>-<slug>-<YYYYMMDDHHmm>.md` (UTC)
- [delegate-077] helpful=0 harmful=0: **Contents:** scope, files touched, commands (failure → success), risks, human follow-ups

---

**Evidence:** Merged orchestrator-not-implementor.md and orchestration-protocols.md into delegate-dont-do.md on 2025-10-23 during duplicate cleanup initiative.
