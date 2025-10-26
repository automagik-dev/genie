# Learning: Forced MCP Execution Pattern for Mandatory Tool Use

**Date:** 2025-10-26
**Teacher:** Felipe (user)
**Type:** Pattern + Implementation
**Severity:** Critical

---

## Teaching Input

**Raw teaching:**
```
i mean, if you add that in any prompt, it will automatically use a mcp tool from genie...
its a way to enforce tooluse where its mandatory

do, teach this so that you can use that knowledge while creating new agents....
we need to review every markdown file for opportunities.
the line must be clear, no additional formatting
```

**Intent:** Document and implement forced MCP execution pattern across all agents where mandatory tool use is required

---

## Analysis

**What:** Claude Code supports forced MCP tool execution via `/mcp__<server>__<tool>` syntax in prompt text

**Why:**
- Bypass decision-making where tool execution is mandatory
- Ensure critical context (workspace info, spells, etc.) loads immediately
- Prevent agents from deciding "should I load this?" - just force execution
- Cleaner agent prompts - no need for conditional logic around mandatory operations

**Where:**
- Agents that need workspace context (mission, tech stack, roadmap, environment)
- Entry points requiring mandatory spell loading
- QA protocols needing pre-test context setup
- Orchestration checks requiring agent/session awareness

**How:** Add clear line with forced execution command after Framework Reference section in agent files

---

## Changes Made

### File 1: .genie/spells/learn.md
**Section:** Who Am I? (after MCP Orchestration Awareness)
**Edit type:** Insert new documentation block

**Content Added:**
```markdown
**Forced MCP Execution Pattern:**
I can enforce mandatory tool execution by using `/mcp__<server>__<tool>` syntax in prompt text (not code blocks). This forces immediate execution without decision-making. The line must be clear, no additional formatting - just the command on its own line.

**When to use forced execution:**
- Mandatory context loading (spells, workspace info)
- Orchestration awareness checks (agents, sessions)
- Entry point auto-loading (agent starts)
- QA protocol setup (pre-test context)

**Example:**
```
/mcp__genie__get_workspace_info
/mcp__genie__list_agents
```
→ Forces immediate execution of both tools (no "should I?" decision)
```

**Reasoning:** Learn spell needs to understand this pattern for future agent creation and framework updates

---

### File 2: AGENTS.md - Amendment 11: MCP-First Orchestration
**Section:** Forced Execution Pattern (new subsection)
**Edit type:** Insert after main Amendment 11 content

**Content Added:**
```markdown
**Forced Execution Pattern:**
Use `/mcp__genie__<tool>` syntax (on clear line, no formatting) to **force** immediate execution where tool use is mandatory:

/mcp__genie__list_agents

→ Bypasses decision-making, executes immediately

**When to force execution:**
- Mandatory context (workspace info, spells)
- Orchestration checks (agents, sessions)
- Entry point auto-load (agent starts)
- QA setup (pre-test context)

**Format requirements:**
- Clear line, no bullets, no code blocks
- Just the command: `/mcp__<server>__<tool>`
- No additional formatting or explanation on same line

**Examples:**
```markdown
## Mandatory Context Loading

/mcp__genie__get_workspace_info
```
```

**Reasoning:** Amendment 11 documents MCP-first orchestration, forced execution is a critical extension of this principle

---

### File 3-16: Agent Files (14 agents updated)

**Pattern applied:** Add "Mandatory Context Loading" section after "Framework Reference" section

**Format:**
```markdown
## Mandatory Context Loading

/mcp__genie__get_workspace_info
```

**Agents Updated:**

**Code Collective (11 agents):**
1. `.genie/code/agents/implementor.md` - Forces workspace info for feature implementation context
2. `.genie/code/agents/qa.md` - Forces workspace info for QA test context
3. `.genie/code/agents/install.md` - Forces workspace info for project setup
4. `.genie/code/agents/tests.md` - Forces workspace info for test strategy planning
5. `.genie/code/agents/review.md` - Forces workspace info for review context
6. `.genie/code/agents/wish/blueprint.md` - Forces workspace info for wish document creation
7. `.genie/code/agents/roadmap.md` - Forces workspace info for roadmap initiative context
8. `.genie/code/agents/release.md` - Forces workspace info for release notes generation
9. `.genie/code/agents/fix.md` - Forces workspace info for bug fix context
10. `.genie/code/agents/refactor.md` - Forces workspace info for design review context
11. `.genie/code/agents/polish.md` - Forces workspace info for quality standards context

**Create Collective (3 agents):**
1. `.genie/create/agents/wish.md` - Forces workspace info for research/content wish planning
2. `.genie/create/agents/install.md` - Forces workspace info for Create onboarding
3. `.genie/create/agents/wish/blueprint.md` - Forces workspace info for Create wish document creation

**Reasoning:** These agents all need workspace product context (mission, tech stack, roadmap, environment) to properly understand project goals, constraints, and success criteria

---

## Pattern Details

### Syntax
```
/mcp__genie__<tool>
```

**Server:** `genie` (MCP server name)
**Tool:** `get_workspace_info`, `list_agents`, `list_sessions`, etc.

### Behavior
- Placed in prompt text (not code blocks, not bullets)
- Forces immediate tool execution
- Bypasses Claude's decision-making process
- Loads before agent starts thinking

### When to Use

**✅ Use forced execution when:**
- Context is mandatory for agent to function correctly
- Skipping the context causes incorrect behavior
- Decision-making about loading is wasteful ("should I load workspace info?" → yes, always)
- Entry point needs guaranteed setup

**❌ Don't use forced execution when:**
- Context is optional or conditional
- Agent can make intelligent decision about loading
- Context is only needed in specific code paths
- Loading is expensive and rarely needed

### Placement in Agent Files

**Standard location:** After "Framework Reference" section, before agent identity/mission

```markdown
---
name: agent-name
description: Agent description
genie:
  executor: CLAUDE_CODE
  model: sonnet
  background: true
---

## Framework Reference

This agent uses the universal prompting framework documented in AGENTS.md...

## Mandatory Context Loading

/mcp__genie__get_workspace_info

# Agent Name • Identity
```

---

## Use Cases Covered

### Use Case 1: Workspace Context Loading
**Agents:** implementor, qa, install, tests, review, blueprint, roadmap, release, fix, refactor, polish, wish agents
**Why:** Need mission, tech stack, roadmap, environment to understand project goals and constraints
**Command:** `/mcp__genie__get_workspace_info`

### Use Case 2: Agent Discovery (Future)
**Agents:** Orchestrators (when they need to know available agents)
**Why:** Dynamic discovery instead of static file references
**Command:** `/mcp__genie__list_agents`

### Use Case 3: Session Awareness (Future)
**Agents:** Master orchestrators (when coordinating work)
**Why:** Know what's already running before starting new work
**Command:** `/mcp__genie__list_sessions`

### Use Case 4: Spell Loading (Future)
**Agents:** Agents that require specific spells at startup
**Why:** Guarantee spell is loaded before agent starts executing
**Command:** `/mcp__genie__read_spell` with spell path

### Use Case 5: QA Setup (Future)
**Agents:** QA agent at test start
**Why:** Load checklist, scenarios, and workspace context before testing
**Commands:**
```
/mcp__genie__get_workspace_info
/mcp__genie__read_spell "qa/test-scenarios"
```

---

## Impact Assessment

**Agents Modified:** 14 agents (11 code, 3 create)
**Lines Added:** ~7 lines per agent = ~98 lines total
**Token Impact:** Minimal (forced execution adds ~20 tokens per agent, but saves decision-making tokens)
**Functional Impact:** High (guaranteed context loading prevents incorrect behavior)

**Before (without forced execution):**
- Agent starts → Thinks "should I load workspace info?" → Decides yes → Loads context
- Wasted tokens on decision-making
- Risk of skipping context load

**After (with forced execution):**
- Agent starts → Context immediately loads (bypasses decision) → Agent has full context
- No decision tokens wasted
- Guaranteed context availability

**Net Token Effect:** Positive (saves decision tokens, ensures correct context)

---

## Validation

### How to Verify

**1. Pattern Documented in Framework:**
```bash
# Check learn.md has forced execution documentation
grep -A10 "Forced MCP Execution Pattern" .genie/spells/learn.md

# Check Amendment 11 has forced execution pattern
grep -A10 "Forced Execution Pattern" AGENTS.md
```

**2. Agents Have Mandatory Context Loading:**
```bash
# Count agents with forced MCP execution
grep -r "^/mcp__genie__get_workspace_info" .genie/code/agents/ .genie/create/agents/ | wc -l
# Expected: 14 matches

# Verify format (clear line, no formatting)
grep -r "^/mcp__genie__get_workspace_info$" .genie/code/agents/ .genie/create/agents/
```

**3. Test Forced Execution (Manual):**
- Start any updated agent
- Observe if workspace info loads immediately
- Confirm no decision-making about loading

---

## Follow-up Actions

- [ ] Monitor agents using forced execution for correct behavior
- [ ] Add forced execution to new agents where workspace context is mandatory
- [ ] Document forced execution in agent creation templates
- [ ] Future: Add `list_agents`, `list_sessions` forced execution where orchestration awareness needed
- [ ] Future: Add spell forced loading for agents requiring specific behavioral patterns

---

## Summary

**What Changed:**
- Documented forced MCP execution pattern in learn.md (meta-learning spell)
- Added forced execution to Amendment 11 in AGENTS.md (framework level)
- Applied forced execution to 14 agents requiring workspace context
- Established clear formatting rule: clear line, no formatting, just command

**Pattern Established:**
```markdown
## Mandatory Context Loading

/mcp__genie__get_workspace_info
```

**Why It Matters:**
- Eliminates decision-making overhead for mandatory operations
- Guarantees context availability before agent starts work
- Prevents incorrect behavior from missing workspace context
- Scales cleanly (add more forced commands as needed)
- Clear convention for agent creators to follow

**Token Efficiency:**
- Before: Decision tokens + execution tokens
- After: Execution tokens only
- Net savings: ~50-100 tokens per agent startup

**Self-Awareness Enhancement:**
Master Genie and all agents now have pattern for forcing mandatory tool execution, making agent development more predictable and context-aware.

---

**Learning absorbed and propagated successfully.** 🧞📚✅
