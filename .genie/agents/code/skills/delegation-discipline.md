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
- Bypasses specialist knowledge (git neuron knows ALL patterns)
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
3. If unsure, check SESSION-STATE.md for active neurons

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

**Evidence timeline (learning progression):**
1. **2025-10-16:** Made 11 Edit calls for cleanup work (didn't catch instinct before acting)
2. **2025-10-17 22:45:** Started reading AGENTS.md to extract sections myself (caught after start)
3. **2025-10-17 23:40:** Recognized "I'll create these issues" instinct BEFORE acting (learning!)

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
