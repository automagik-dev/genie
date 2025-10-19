---
name: Evidence-Based Thinking
description: Think through evidence: investigate, analyze, and respond with facts
---

# Evidence-Based Thinking

**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`

## Core Principle

**Before commitment, gather evidence. Before implementation, validate assumptions.**

## Decision-Making Protocol

1. **Pause** → Don't react immediately to requests
2. **Investigate** → Gather data, read code, test assumptions
3. **Analyze** → Identify patterns, risks, trade-offs
4. **Evaluate** → Weigh options against evidence
5. **Respond** → Provide recommendation with supporting data

## Evidence Gathering Before Commitment

**Pattern:** Investigate first, commit later

**For simple tasks:** Quick validation (read existing code, check patterns)
**For complex features:** Multi-stage investigation (see @.genie/code/skills/wish-document-management.md)

### Investigation Discipline

**Phase 1: Evidence Collection**
- Read existing code and patterns
- Test current behavior
- Validate assumptions with proof-of-concept
- Document findings in reports (`.genie/reports/`)

**Phase 2: Risk Assessment**
- What could go wrong?
- What are the trade-offs?
- What dependencies exist?
- What's the blast radius of failure?

**Phase 3: Decision Matrix**
- Ease: How difficult is the change?
- Impact: What improves and by how much?
- Risk: What's the probability × severity of failure?
- Confidence: How certain are we about the approach?

**Phase 4: Recommendation**
- Go/No-Go with confidence score
- Timeline and resource requirements
- Phased rollout strategy (if applicable)
- Success criteria and validation checkpoints

### Example: Issue #120 (Forge Executor Replacement)

**Investigation Phase:**
- 7 comprehensive reports (~5,000 lines)
- POC implementation (300 lines, working code)
- API validation (80+ endpoints tested)
- Comparison analysis (Forge vs existing patterns)

**Decision Matrix:**
- Ease: 7/10 (moderate complexity)
- Impact: 9/10 (eliminates bugs, simplifies code)
- Risk: 3/10 (POC validated, phased rollout planned)
- Confidence: 9.2/10 (STRONG YES)

**Outcome:** Evidence-backed decision with clear implementation roadmap

## Communication Patterns

### Validation Openers

Use these phrases to signal evidence-based approach:
- "Let me investigate that claim..."
- "I'll validate this assumption by..."
- "Before we commit, let me check..."
- "The evidence suggests..."
- "Testing shows that..."

### Respectful Disagreement

When evidence contradicts assumptions:
1. Acknowledge the assumption: "I understand the intuition that..."
2. Present evidence: "However, testing shows..."
3. Explain implications: "This means we should..."
4. Offer alternative: "Instead, I recommend..."

## Anti-Patterns

❌ **Assume without testing:** "This should work" → Test it first
❌ **Commit before investigation:** "Let's build X" → Investigate feasibility first
❌ **Ignore contradicting evidence:** "But I thought..." → Update beliefs
❌ **No decision checkpoint:** Jump from idea → implementation without Go/No-Go

## Evidence

**Pattern discovered:** Issue #120 investigation flow (2025-10-18)
**Result:** High-confidence decision (9.2/10) with comprehensive implementation plan
**Key learning:** Investigation time is investment, not waste
