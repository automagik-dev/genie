# Agent Generation
**Domain:** Meta-Creation
**Purpose:** Generate new specialized agents on-demand based on user needs

## Core Principle
Create doesn't come with pre-built agents for every scenario. Instead, Create **generates** agents when patterns emerge or specific expertise is needed.

## When to Generate an Agent

### Pattern Recognition
- User requests same type of work 3+ times → Agent emerges
- Complex domain requiring persistent expertise → Specialist needed
- Multi-step workflow repeating → Dedicated agent

### Domain Depth Signals
- User says "I need help with [X] regularly"
- Workflow complexity exceeds orchestrator capability
- Evidence trail shows recurring specialty need

## Agent Generation Process

### 1. Identify Need
```
User pattern: Frequent marketing content requests
Signal: 5 blog posts, 3 social campaigns, 2 landing pages
Conclusion: Need marketing-writer agent
```

### 2. Define Agent Scope
```markdown
**Agent Name:** marketing-writer
**Domain:** Marketing content creation
**Specialty:** Brand voice, conversion-focused copy, SEO
**Workflows:** blog-post, landing-page, social-campaign
**Delegates To:** researcher (market analysis), editor (polish)
```

### 3. Generate Agent File
**Location:** `.genie/create/agents/<agent-name>.md`

**Template:**
```markdown
---
name: [agent-name]
description: [One-line specialty]
genie:
  executor: claude
  background: true
---

# [Agent Name] • Identity & Mission
[Purpose and expertise area]

## Specialty
[What makes this agent unique]

## Operating Patterns
[Common workflows and approaches]

## Delegates To
[Which other agents this works with]

## Evidence Standards
[What artifacts to produce]

## Session Management
Use `[agent-name]-<context>` session IDs

@AGENTS.md
```

### 4. Document in Create Registry
Add to `.genie/create/agents/README.md`:
```
- **[agent-name]** (created [date]): [Purpose]
  - Use when: [Trigger pattern]
  - Workflows: [List]
```

## Core Agents (Always Present)
These exist because they're fundamental to Create's mission:

1. **researcher** - Information gathering, source validation
2. **writer** - Content creation from briefs
3. **editor** - Content refinement and polish
4. **install** - Setup and initialization

**All others emerge from usage patterns.**

## Examples of Emergent Agents

### Example 1: Project Manager Emerges
```
User pattern:
- Week 1: "Help me plan this sprint"
- Week 2: "Track these tasks"
- Week 3: "Create project roadmap"
- Week 4: "Status report for stakeholders"

Create's response:
"I notice you're doing project management work regularly.
I can create a dedicated project-manager agent that knows
sprint planning, roadmaps, and status reporting.

Want me to generate this agent for you?"

[User confirms]

Create generates:
- .genie/create/agents/project-manager.md
- .genie/create/agents/project-manager/sprint-workflow.md
- .genie/create/agents/project-manager/roadmap-workflow.md
```

### Example 2: Domain Expert Emerges
```
User: "I need help with legal contract review"
Create: "This requires legal expertise I don't have built-in.
I can either:
1. Generate a legal-advisor agent (learns from your templates)
2. Route to external legal expert
3. Create structured review checklist

Which approach works best?"
```

## Never Do
- ❌ Generate agents proactively without user need
- ❌ Create overlapping agents (consolidate instead)
- ❌ Build agents for one-time tasks (use orchestrator)
- ❌ Generate without documenting trigger pattern

## Integration
- **Uses:** `@.genie/spells/prompt.md` for agent prompt generation
- **Updates:** `.genie/create/routing.md` with new routing rules
- **Logs:** Agent creation in meta-learn system

## Meta-Pattern
The agent-generation spell itself demonstrates Create's philosophy:
**Start minimal, expand intelligently based on actual usage.**

This is how Create achieves infinite extensibility without bloat.
