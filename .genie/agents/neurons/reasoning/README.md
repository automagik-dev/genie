# Reasoning Framework

**Purpose:** Persistent reasoning chains with different cognitive modes for problem-solving, analysis, and decision-making.

## Reasoning Modes

### Core Reasoning Styles

**challenge.md** - Adversarial pressure-testing
- Critical evaluation and adversarial analysis
- Identify risks, weaknesses, and edge cases
- Pressure-test plans, assumptions, and decisions
- Use when: Validating existing ideas, finding flaws

**explore.md** - Discovery-focused investigation
- Open-ended exploration without adversarial pressure
- Learning mode for unfamiliar territory
- Pattern discovery and landscape mapping
- Use when: Discovering NEW, learning unknown domains

**consensus.md** - Multi-perspective synthesis
- Synthesize multiple viewpoints and models
- Build agreement from diverse perspectives
- Find common ground and unified direction
- Use when: Resolving conflicts, building alignment

**socratic.md** - Question-driven inquiry
- Deep questioning to uncover assumptions
- Challenge thinking through iterative inquiry
- Reveal hidden complexity through dialogue
- Use when: Understanding fundamentals, teaching

## Universal Applicability

All reasoning modes work across ANY domain:
- **Code:** Architecture decisions, debugging, refactoring
- **Create:** Research papers, content strategy, learning projects
- **Legal:** Contract analysis, case strategy, compliance
- **Medical:** Treatment planning, diagnosis, research protocols
- **Finance:** Risk assessment, investment strategy, audits

## Architecture

**Modes are separate files** for selective context loading:
```markdown
# Load only needed reasoning mode
@.genie/agents/neurons/reasoning/challenge.md

# Or multiple modes
@.genie/agents/neurons/reasoning/explore.md
@.genie/agents/neurons/reasoning/consensus.md
```

**Token optimization:** Load only the reasoning style needed for the task.

## Usage Pattern

**Via MCP:**
```
mcp__genie__run with agent="reasoning/challenge" and prompt="[context]"
mcp__genie__run with agent="reasoning/explore" and prompt="[context]"
```

**In prompts:**
```markdown
Mode: challenge
Task: Pressure-test the migration plan for risks
```

---

**Philosophy:** Reasoning is a fundamental cognitive process. Different modes = different lenses for thinking through problems.
