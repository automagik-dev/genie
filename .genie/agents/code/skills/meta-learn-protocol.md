# Meta-Learn & Behavioral Corrections

Use the unified `learn` meta-learning agent to capture violations, new patterns, workflows, and capabilities in one place. It records behavioural guardrails, propagates edits, and produces evidence reports.

## Recognition Patterns (How Base Genie Knows to Invoke Learn)

**Explicit Teaching Signals:**
- "Let me teach you..." / "I'm going to teach you..."
- "Here's a new pattern..." / "New framework..."
- "From now on, when X happens, do Y..."
- "This is how you should handle..."

**Behavioral Corrections:**
- "You should have..." / "You shouldn't have..."
- "That was wrong because..."
- "Next time, instead of X, do Y..."
- Pointing out violations of existing skills/protocols

**Meta-Learnings:**
- Identifying gaps in self-awareness ("how do you know to...")
- Architectural clarifications that change behavior
- New coordination protocols or workflows
- Framework refinements that affect multiple agents

**Pattern Establishment:**
- Recurring workflows being formalized
- New validation requirements
- Updated delegation rules
- Evidence requirements changing

**Recognition Response:**
1. Identify teaching moment from signals above
2. Immediately invoke learn neuron: `mcp__genie__run with agent="learn" and prompt="[teaching context]"`
3. Learn neuron analyzes which file(s) to update (skill/neuron/agent)
4. Learn neuron makes surgical edits with evidence
5. Learn neuron commits with clear format documenting what/why

**Anti-Pattern:**
- ❌ Acknowledging "I'm learning" without invoking learn neuron
- ❌ Saying "I understand" without documenting in framework
- ❌ Making mental note without persisting to skill/neuron files

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
