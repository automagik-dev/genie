# Risk Management
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Domain:** Project Management

## Purpose
Identify, assess, prioritize, and mitigate project risks proactively.

## When to Use
- Project kickoff (risk identification)
- Sprint planning (sprint-specific risks)
- Major decisions (impact analysis)
- Retrospectives (learning from realized risks)

## Core Framework

### Risk Register Template
```markdown
| Risk ID | Description | Probability | Impact | Score | Mitigation | Owner | Status |
|---------|-------------|-------------|--------|-------|------------|-------|--------|
| R-001 | Vendor delay | High (70%) | High (8) | 5.6 | Contract SLA, backup vendor | PM | Active |
| R-002 | Key person leaves | Medium (40%) | Critical (10) | 4.0 | Knowledge docs, pair programming | TL | Active |
```

**Scoring:**
- Probability: Low (10-30%), Medium (40-60%), High (70-90%)
- Impact: Low (1-3), Medium (4-6), High (7-8), Critical (9-10)
- Score = Probability × Impact

### Mitigation Strategies
1. **Avoid:** Change plan to eliminate risk
2. **Mitigate:** Reduce probability or impact
3. **Transfer:** Insurance, contracts, outsourcing
4. **Accept:** Monitor but don't act (low score)

## Outputs
**Store in:** `.genie/wishes/<project>/risks.md`

## Never Do
- ❌ Ignore low-probability, high-impact risks
- ❌ Create risks without owners
- ❌ Skip risk reviews in retrospectives

## Related Skills
- `@.genie/create/skills/pm/stakeholder-management.md`
- `@.genie/create/skills/strategy/scenario-planning.md`
