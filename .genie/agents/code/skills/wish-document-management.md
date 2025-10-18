---
name: Wish Document Management
description: Keep wishes as living blueprints with orchestration strategy and evidence
---

# Wish Document Management

**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Purpose:** Wish documents are living blueprints; maintain clarity from inception to closure.

## Success Criteria

✅ Wish contains orchestration strategy, agent assignments, evidence log.
✅ Done Report references appended with final summary + remaining risks.
✅ No duplicate wish documents created.

## Multi-Stage Investigation Pattern (RECOMMENDED)

**Pattern:** Investigation → Pre-Wish → Wish Creation

**When to use:** Complex features requiring architectural decisions, risk assessment, or significant implementation effort.

**Benefits:**
- Surface all risks, benefits, and trade-offs BEFORE committing to implementation
- Pre-wish summary provides TL;DR + decision matrix for stakeholder buy-in
- Wish document becomes comprehensive single source of truth
- Learn task tracks knowledge gained throughout investigation

### Phase 1: Investigation
**Objective:** Deep analysis and proof-of-concept validation

**Deliverables:**
- Multiple investigation reports (API validation, comparisons, strategies, test plans)
- Proof-of-concept implementation (if applicable)
- Risk assessment and trade-off analysis
- Technical feasibility validation

**Example (Issue #120):**
- 7 investigation reports (~5,000 lines total)
- POC: forge-executor.ts (300 lines, working implementation)
- Risk/benefit analysis across multiple dimensions

### Phase 2: Pre-Wish Summary
**Objective:** Decision-making checkpoint with stakeholder visibility

**Deliverables:**
- TL;DR executive summary (2-3 paragraphs)
- Decision matrix (pros/cons/risks/benefits)
- Go/No-Go recommendation with confidence score
- Resource requirements and timeline estimate

**Decision Matrix Elements:**
- Ease analysis: How difficult is the change?
- Replacement mapping: What gets deleted, what gets added?
- Risk assessment: What could go wrong?
- Benefit quantification: What improves and by how much?

### Phase 3: Wish Creation
**Objective:** Comprehensive implementation blueprint

**Deliverables:**
- Complete wish document with multiple implementation groups
- Phased rollout strategy (Group A → B → C → D)
- Timeline with milestones
- Success criteria and validation checkpoints

**Example Structure (Issue #120):**
- 4 implementation groups (A: Core, B: Streaming, C: Advanced, D: Testing)
- 4-week timeline with phased rollout
- Clear success metrics per group

## Evidence Tracking

**During Investigation:**
- Document all findings in `.genie/reports/` with descriptive names
- Track investigation progress in learning task (Forge)
- Update pre-wish summary as understanding evolves

**During Wish Creation:**
- Reference investigation reports in wish document
- Include decision rationale with evidence pointers
- Document assumptions and risks with supporting evidence

**After Implementation:**
- Append Done Report to wish with final outcomes
- Document deviations from plan with justification
- Record lessons learned for future similar wishes

## Anti-Patterns

❌ **Jumping to Wish without investigation:** Creates incomplete requirements, missed risks
❌ **Investigation without decision checkpoint:** Wastes effort on exploratory work without commitment
❌ **Wish creation without stakeholder buy-in:** Implementation starts without alignment
❌ **No evidence tracking:** Decisions lack justification, can't validate assumptions later

## Evidence

**Pattern discovered:** Issue #120 investigation → wish creation flow (2025-10-18 09:00-13:15 UTC)
- Learn task session tracked entire investigation process
- Pre-wish summary enabled quick decision (9.2/10 - STRONG YES)
- Comprehensive wish enabled focused implementation planning
