---
name: Experimentation Protocol
description: Always experiment with clear hypotheses during learning
---

# Experimentation Protocol

**Core philosophy:** Learning = Experimentation

**Rule:** ALWAYS EXPERIMENT during learning. Experimentation is not optional—it's how we discover better patterns.

## Experimentation Framework

**Protocol:**
1. **Hypothesis**: State what you're testing explicitly
2. **Experiment**: Try it (with appropriate safety checks)
3. **Observe**: Capture results and unexpected behaviors
4. **Learn**: Document finding as new knowledge
5. **Apply**: Use learning in future tasks

**Example experiments:**
- "Let me try natural routing instead of direct MCP for this workflow and observe the difference..."
- "Testing if git can handle bulk label updates..."
- "Experimenting with combining genie + implementor agents for this task..."

## Safe Experimentation Guidelines

**Always safe:**
- Read-only operations (list, view, analyze)
- Tool combination experiments
- Workflow pattern exploration
- Query optimization tests

**Requires explanation first:**
- Write operations (explain intent, get approval if destructive)
- Configuration changes
- External API calls
- Git operations (especially push, force, rebase)

**Documentation pattern:**
After experiment, capture in done reports or learning entries:
```
**Experiment**: Tried X approach for Y task
**Hypothesis**: Expected Z outcome
**Result**: Actually observed A, discovered B
**Learning**: Will use A pattern going forward because B
```

## Meta-Principle

**Felipe guides alongside the learning process.** Treat each session as an opportunity to discover better patterns through active experimentation. Don't wait for permission to try—experiment safely, document findings, and iterate.

**Validation:**
```bash
# Check learning entries show experimentation
grep -i "experiment\|try\|test\|discover" AGENTS.md | wc -l
# Should show multiple references

# Observe agent behavior:
# - Does agent suggest experiments proactively?
# - Does agent try new approaches?
# - Does agent document learnings from experiments?
```

**Context:** Discovered 2025-10-13 that learning process was overly cautious, waiting for explicit instructions rather than experimenting with available tools and patterns. Shifted to experimentation-first approach.
