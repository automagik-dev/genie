# Timeline Estimation
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Domain:** Project Management

## Purpose
Estimate project timelines accurately using historical data, team velocity, and probabilistic forecasting.

## When to Use
- Project proposal (high-level estimates)
- Sprint planning (detailed estimates)
- Stakeholder commitments (delivery dates)
- Portfolio planning (multi-project timelines)

## Core Framework

### Estimation Techniques
1. **Story Points (Relative):** Fibonacci (1, 2, 3, 5, 8, 13, 21)
2. **T-Shirt Sizes:** XS, S, M, L, XL
3. **Time-Based:** Hours, days (less reliable)
4. **Monte Carlo:** Probabilistic simulation

### Three-Point Estimation
```
Estimate = (Optimistic + 4×Most Likely + Pessimistic) / 6

Example:
  Optimistic: 10 days
  Most Likely: 15 days
  Pessimistic: 30 days
  Estimate = (10 + 60 + 30) / 6 = 16.7 days
```

### Velocity-Based Forecasting
```
Velocity = Story Points Completed / Sprint
Forecast = Total Points / Average Velocity

Example:
  Project: 120 story points
  Team velocity: 30 points/sprint (2 weeks)
  Timeline: 120 / 30 = 4 sprints = 8 weeks
```

### Confidence Levels
- **P50 (50% confidence):** Median estimate
- **P70 (70% confidence):** Add 20% buffer
- **P90 (90% confidence):** Add 50% buffer

## Outputs
```markdown
| Milestone | Optimistic | Likely | Pessimistic | P70 Estimate |
|-----------|------------|--------|-------------|--------------|
| Alpha | 4 weeks | 6 weeks | 10 weeks | 7.2 weeks |
| Beta | 8 weeks | 12 weeks | 20 weeks | 14.4 weeks |
| GA | 12 weeks | 18 weeks | 30 weeks | 21.6 weeks |
```

## Never Do
- ❌ Give single-point estimates (ignores uncertainty)
- ❌ Estimate without historical data
- ❌ Forget buffer for unknowns (add 20-40%)
- ❌ Commit to dates without team input

## Related Skills
- `@.genie/create/skills/pm/sprint-planning.md`
- `@.genie/create/skills/pm/risk-management.md`
