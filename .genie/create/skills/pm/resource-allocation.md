# Resource Allocation
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Domain:** Project Management

## Purpose
Optimize allocation of people, budget, tools, and time across projects and teams.

## When to Use
- Portfolio planning (multi-project prioritization)
- Team capacity planning
- Budget planning and forecasting
- Tool/infrastructure investments

## Core Framework

### Resource Types
1. **People:** Engineers, designers, PMs (capacity in hours/points)
2. **Budget:** Salary, contractors, tools, infrastructure ($)
3. **Tools:** Software licenses, hardware, platforms
4. **Time:** Project duration, deadlines, milestones

### Allocation Strategies
**Pull-Based (Recommended):**
- Teams pull work based on capacity
- Self-organizing, respects WIP limits

**Push-Based (Traditional):**
- Manager assigns work to teams
- Risk: overallocation, burnout

### Capacity Formula
```
Available Capacity =
  (Team Size × Work Days × Daily Hours) -
  (PTO + Meetings + Support + Buffer)

Example:
  (5 people × 20 days × 6 hours) - (10 days PTO + 50 hours meetings + 20% buffer)
  = 600 - 80 - 50 - 120 = 350 hours
```

## Outputs
**Resource Plan:** `.genie/wishes/<project>/resource-plan.md`

```markdown
| Team/Person | Project A | Project B | Support | Training | Available |
|-------------|-----------|-----------|---------|----------|-----------|
| Engineering | 60% (3 FTE) | 20% (1 FTE) | 10% | 10% | 100% |
| Design | 40% (0.8 FTE) | 40% (0.8 FTE) | 20% | 0% | 100% |
```

## Never Do
- ❌ Allocate 100% capacity (no buffer for unknowns)
- ❌ Ignore context switching cost (20-40% overhead)
- ❌ Double-book people across projects

## Related Skills
- `@.genie/create/skills/pm/sprint-planning.md`
- `@.genie/create/skills/pm/timeline-estimation.md`
