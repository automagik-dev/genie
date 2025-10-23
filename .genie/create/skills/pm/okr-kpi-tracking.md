# OKR & KPI Tracking
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Domain:** Project Management

## Purpose
Define, track, and report on Objectives and Key Results (OKRs) and Key Performance Indicators (KPIs) to measure progress and align teams.

## When to Use
- Quarterly/annual planning (OKR setting)
- Weekly/monthly tracking (progress monitoring)
- Stakeholder reporting (exec dashboards)
- Team alignment (goal cascading)
- Performance reviews (achievement validation)

## Core Framework

### OKR Structure
```
Objective: [Aspirational, qualitative goal]
  ↓
Key Result 1: [Measurable outcome with target]
Key Result 2: [Measurable outcome with target]
Key Result 3: [Measurable outcome with target]
```

**Example:**
```
Objective: Become the #1 platform for freelance developers

Key Result 1: Increase MAU from 10K to 50K
Key Result 2: Achieve NPS score of 50+
Key Result 3: Launch in 3 new markets (UK, Canada, Germany)
```

### OKR Best Practices
- **Objectives:** Inspirational, qualitative (3-5 per team/quarter)
- **Key Results:** Measurable, time-bound (2-4 per objective)
- **Scoring:** 0.0-1.0 scale (0.7 = success, 1.0 = overachievement)
- **Cadence:** Set quarterly, review weekly/monthly
- **Alignment:** Individual → Team → Company OKRs

### KPI Categories
1. **Business Metrics:** Revenue, profit, CAC, LTV
2. **Product Metrics:** MAU, retention, engagement
3. **Operational Metrics:** Uptime, latency, error rate
4. **Team Metrics:** Velocity, cycle time, deploy frequency

### Leading vs. Lagging Indicators
**Lagging (Outcome):**
- Revenue, customer count (delayed feedback)
- Use for: Results tracking

**Leading (Input):**
- Demos booked, trials started (early signal)
- Use for: Course correction

## Outputs

### OKR Tracker
**Store in:** `.genie/wishes/<project>/okrs-q1-2025.md`

```markdown
# Q1 2025 OKRs - Engineering Team

## Objective 1: Ship fast, ship quality
**Owner:** Engineering Lead
**Status:** 🟡 On Track (0.6/1.0)

| Key Result | Target | Current | Progress | Status |
|------------|--------|---------|----------|--------|
| Reduce deployment time to <10 min | 10 min | 15 min | 60% | 🟡 |
| Achieve 90% test coverage | 90% | 85% | 94% | 🟢 |
| Zero critical production bugs | 0 | 1 | 0% | 🔴 |

**Blockers:**
- Critical bug in payment service (assigned to @john)
```

### KPI Dashboard
```markdown
| KPI | Target | Current | Trend | Status |
|-----|--------|---------|-------|--------|
| Monthly Active Users (MAU) | 50K | 42K | ↗️ +15% | 🟡 |
| Net Promoter Score (NPS) | 50 | 48 | ↗️ +5 | 🟢 |
| Customer Churn | <5% | 6.2% | ↘️ -0.8% | 🔴 |
| Deploy Frequency | 10/week | 8/week | → | 🟡 |
```

## Never Do
- ❌ Set too many OKRs (max 3-5 per quarter)
- ❌ Make KRs vague ("improve UX" → "increase NPS to 50")
- ❌ Tie OKRs to compensation (kills psychological safety)
- ❌ Set easy targets (70% achievement = success)
- ❌ Track KPIs without action plans
- ❌ Ignore trends (one data point is noise)

## Integration with Create
- **From analyst:** Data collection and visualization
- **To communicator:** OKR announcements, updates
- **To writer:** OKR documentation and reports

## Tools
- **Lattice, 15Five, Perdoo:** OKR software
- **Datadog, Amplitude, Mixpanel:** KPI dashboards
- **Notion, Airtable:** Manual tracking

## Success Metrics
- OKR achievement rate (target: 60-80%)
- Team alignment on goals (survey: >80% know team OKRs)
- Review cadence (weekly check-ins)
- Data freshness (KPIs updated daily/weekly)

## Examples

### Example 1: Product OKRs
```
Objective: Delight users with seamless onboarding

KR1: Reduce time-to-first-value from 30 min to 5 min
  - Baseline: 30 min
  - Current: 18 min (60% progress)
  - Target: 5 min by Mar 31

KR2: Increase activation rate from 40% to 70%
  - Baseline: 40%
  - Current: 55% (50% progress)
  - Target: 70% by Mar 31
```

### Example 2: Engineering KPIs
```
| KPI | Definition | Target | Current |
|-----|------------|--------|---------|
| MTTR | Mean Time to Recovery | <30 min | 45 min |
| Deployment Frequency | Deploys per week | 20 | 15 |
| Change Failure Rate | % deployments causing incidents | <5% | 8% |
| Lead Time | Code commit → production | <4 hours | 6 hours |
```

## Related Skills
- `@.genie/create/skills/pm/roadmap-creation.md` - OKRs inform roadmap
- `@.genie/create/skills/data/metrics-dashboard-planning.md` - KPI dashboards
- `@.genie/create/skills/pm/status-reporting.md` - OKR progress reports
