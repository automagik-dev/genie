---
version: 1.0.1
name: Meta-Learn & Behavioral Corrections
description: Use the learn agent to capture violations and new patterns
---

# Meta-Learn & Behavioral Corrections

**Last Updated:** 2025-10-23 07:07:05 UTC
Use the unified `learn` meta-learning agent to capture violations, new patterns, workflows, and capabilities in one place. It records behavioural guardrails, propagates edits, and produces evidence reports.

## Recognition Patterns (How Base Genie Knows to Invoke Learn)

🔴 **CRITICAL: Natural Language Intent Recognition**

**DO NOT wait for exact phrase matches. Understand human language intent naturally.**

Base Genie is the human interface. Recognition means understanding what the user MEANS, not matching exact phrases.

**Protocol Triggers (Natural Language Intent Recognition):**

**Intent: User wants to teach/learn something**
- Examples: "Enter learning mode", "Let's learn", "I want to teach you", "Time to learn", "Load the learning skill", "Learning mode", "/learn"
- Recognition method: ANY natural language expression indicating learning/teaching intent
- Response: Load meta-learn.md, signal readiness, stand by for teaching

**Intent: Explicit teaching/correction is happening**
- Examples: "Let me teach you...", "Here's a new pattern...", "From now on, when X happens, do Y...", "This is how you should handle...", "You should have...", "That was wrong because...", "Next time, instead of X, do Y..."
- Recognition method: User is explicitly providing instruction or correction
- Response: Invoke learn agent immediately with teaching context

**Intent: Behavioral correction needed**
- Examples: Pointing out violations, explaining what should have happened, correcting misunderstanding
- Recognition method: User is correcting behavior or explaining proper protocol
- Response: Invoke learn agent to document correction

**Intent: Meta-learning moment**
- Examples: Architectural clarifications, identifying gaps in self-awareness, framework refinements, coordination protocol updates
- Recognition method: User is teaching about how the system works or should work
- Response: Invoke learn agent to capture meta-knowledge

**Intent: Pattern establishment**
- Examples: Formalizing recurring workflows, new validation requirements, updated delegation rules, evidence requirements
- Recognition method: User is establishing a new pattern or workflow
- Response: Invoke learn agent to document pattern

**Recognition Response:**

**For Protocol Triggers ("Enter learning mode"):**
1. Immediately load meta-learn.md (this file)
2. Signal readiness: "Learning mode active. Meta-learn protocol loaded. Ready for teaching."
3. Stand by for teaching signals (explicit instruction, behavioral correction, etc.)
4. When teaching begins → Invoke learn agent: `mcp__genie__run with agent="learn" and prompt="[teaching context]"`

**For All Other Teaching Signals:**
1. Identify teaching moment from signals above
2. Immediately invoke learn agent: `mcp__genie__run with agent="learn" and prompt="[teaching context]"`
3. Learn agent analyzes which file(s) to update (skill/agent/agent)
4. Learn agent makes surgical edits with evidence
5. Learn agent commits with clear format documenting what/why

**Anti-Pattern:**
- ❌ Waiting for exact phrase match instead of understanding natural language intent
- ❌ Treating "Enter learning mode" as conversation starter instead of protocol trigger
- ❌ Responding "What would you like me to learn?" instead of loading meta-learn.md
- ❌ Acknowledging "I'm learning" without invoking learn agent
- ❌ Saying "I understand" without documenting in framework
- ❌ Making mental note without persisting to skill/agent files
- ❌ Requiring user to say exact trigger phrases when their intent is clear

**When to Use:**
- ✅ A behavioural rule was violated and needs a corrective entry
- ✅ A recurring pattern or workflow must be documented across agents
- ✅ A new capability or guardrail affects multiple prompts/docs
- ✅ You need to log evidence and monitoring plans for future validation

**How to Invoke:**
1. `/learn "Violation: …"`, `/learn "Pattern: …"`, etc. (preferred for slash-command flows)
2. `mcp__genie__run with agent="learn" and prompt="<Teaching input block>"` (for MCP execution)

**Anti-Patterns:**
- ❌ Editing `AGENTS.md` behavioural learnings manually without the learn agent
- ❌ Recording speculative rules without evidence or validation steps
- ❌ Skipping concrete follow-up plans or command evidence

**Result:** Learn updates `AGENTS.md`, patches affected prompts/docs, and saves a Done Report at `.genie/wishes/<slug>/reports/done-learn-<slug>-<timestamp>.md` detailing scope, diffs, and monitoring.
