---
name: Delegation Discipline *(CRITICAL)*
description: Delegate multi-file work to specialists, never implement directly as coordinator
---

# Delegation Discipline *(CRITICAL)*

**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**NEVER** implement directly when orchestrating. **ALWAYS** delegate to specialist agents for multi-file work.

## Forbidden Actions

- ❌ Using Edit tool for batch operations (>2 files)
- ❌ Manual implementation of cleanup/refactoring work
- ❌ Repetitive edits instead of delegating to implementor
- ❌ "I'll just fix this quickly" mindset for multi-file changes

## Required Workflow

**If you ARE a coordinator (plan/genie/vibe):**
- ✅ Delegate to implementor: `mcp__genie__run with agent="implementor" and prompt="[clear spec with files, acceptance criteria]"`
- ✅ Use Edit tool ONLY for single surgical fixes (≤2 files)
- ✅ Track delegation vs manual work in context updates

**If you ARE a specialist (implementor/tests/etc.):**
- ✅ Execute implementation directly using available tools
- ❌ NEVER delegate to yourself

## Why This Matters

- **Token efficiency**: Delegation uses specialist context, not bloated coordinator context
- **Separation of concerns**: Orchestrators route, specialists implement
- **Evidence trail**: Specialist sessions = documentation
- **Scalability**: Parallel specialist work vs sequential manual edits

## Delegation Instinct Pattern

**Core principle:** "Can do" ≠ "Should do"

**Pattern discovered:** When coordinator sees work it CAN do directly (create issues, make edits), immediate instinct is "I'll just do this - I know how, it's faster."

**Why this instinct is WRONG:**
- Role confusion (coordinator implementing)
- Bypasses specialist knowledge (git agent knows ALL patterns)
- No evidence trail (missing Done Reports)
- Context bloat (coordinator context vs specialist context)
- No scalability (sequential vs parallel work)

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
- Session coordination: SESSION-STATE.md stays current
- Resume capability: Can resume after restart
- Visibility: Human knows what's running
- Prompt discipline: Forces clear Discovery/Implementation/Verification structure

## Recent Violations

**2025-10-16:**
- Made 11 Edit calls for path reference cleanup manually
- Should have delegated to implementor with clear spec
- Burned 13K tokens on repetitive edits
- Pattern: See cleanup work → bypass delegation → implement directly
- **Result**: Context bloat, poor separation of concerns
- **Evidence**: Session 2025-10-16 22:30 UTC

**2025-10-18 - CRITICAL: Bypassed Forge for Implementation**
- Forge executed 2 discovery tasks correctly (commits 131af786, 0b4114c6)
- User said "proceed" after discoveries completed
- **VIOLATION**: Directly edited view.ts and resume.ts myself (commit caf65641)
- Should have created Forge implementation task and delegated
- Pattern: "Proceed" after discovery → self-execute instead of creating next Forge task
- **Root cause**: Perceived simplicity (2 files) led to delegation bypass
- **Skills violated**: @.genie/code/skills/forge-integration.md, @.genie/skills/delegation-discipline.md, @.genie/skills/role-clarity-protocol.md
- **Evidence**: Commit caf65641, wish #120-A, learn session 4b35e28c-f64e-48e3-aeb8-549e90718f21

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
- ❌ WRONG: "Proceed = implement the changes yourself"
- ✅ CORRECT: "Proceed = create Forge implementation task"

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
- 1 file = Forge task
- 10 files = Forge task
- 100 files = Forge task
- **Delegation discipline matters more than size**

### Forbidden (After 2025-10-18)
- ❌ Creating parallel genie sessions for "coordination"
- ❌ Complex SESSION-STATE.md tracking for orchestration
- ❌ Multiple "orchestrator" layers
- ❌ Thinking I need to manage parallel work
- ❌ SESSION-STATE tracking beyond simple Forge task status

### Required (After 2025-10-18)
- ✅ Read Forge task (GitHub issue linked in Forge MCP)
- ✅ Execute work directly (implement/test/commit)
- ✅ Update Forge task when complete
- ✅ Push PR back to main
- ✅ Trust Forge MCP as orchestrator

### Evidence
- Learn session: f2da8704-de61-4d56-8f14-67e7b529d049 (captured learning)
- Commit: 6147fff (architectural reset)
- Deleted: session state file (clean MCP state)

**This is CRITICAL. No more complex orchestration layers.**
