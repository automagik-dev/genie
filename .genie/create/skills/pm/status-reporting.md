# Status Reporting
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Domain:** Project Management

## Purpose
Communicate project progress, risks, and blockers to stakeholders with clarity and actionability.

## When to Use
- Weekly team updates
- Monthly executive reports
- Sprint reviews
- Board/investor updates
- Cross-team synchronization

## Core Framework

### Status Report Structure
```markdown
# [Project] Status - [Date]

## 🎯 TL;DR
[One sentence: On track / At risk / Blocked]

## ✅ Wins This Week
- [Achievement 1]
- [Achievement 2]

## 🚧 In Progress
- [Task 1] - [% complete] - [Owner]
- [Task 2] - [% complete] - [Owner]

## 🔴 Blockers
- [Blocker 1] - [Impact] - [Action needed]

## 📊 Metrics
| Metric | Target | Current | Trend |
|--------|--------|---------|-------|
| Velocity | 30 pts | 28 pts | 🟢 |
| Bugs | <10 | 12 | 🔴 |

## 🎯 Next Week
- [Priority 1]
- [Priority 2]

## ❓ Asks
- [Decision needed from stakeholder]
```

### Traffic Light System
- 🟢 **Green:** On track, no concerns
- 🟡 **Yellow:** At risk, watching closely
- 🔴 **Red:** Blocked, need help

### Audience-Specific Reports
**Executive (5 min read):**
- High-level status (green/yellow/red)
- Business impact
- Critical blockers only
- Decision requests

**Team (15 min read):**
- Detailed progress
- Technical blockers
- Dependencies
- Upcoming work

**Stakeholders (10 min read):**
- Relevant updates only
- Impact on their work
- Timeline changes

## Outputs
**Store in:** `.genie/wishes/<project>/reports/status-2025-10-23.md`

## Never Do
- ❌ Hide bad news (escalate early)
- ❌ Report without context (explain why it matters)
- ❌ Over-report (weekly is usually enough)
- ❌ Write novels (be concise, use bullets)

## Integration with Create
- **To communicator:** External stakeholder updates
- **From PM:** Sprint metrics and blockers
- **To writer:** Format and polish reports

## Tools
- **Slack:** Daily standups (#status channel)
- **Notion/Confluence:** Weekly reports
- **Email:** Executive updates
- **Dashboards:** Real-time metrics (Linear, Jira)

## Examples

### Example 1: Sprint Status
```
# Sprint 12 Status - Week 2/2

🎯 **Status:** 🟢 On Track

✅ **Completed:**
- User authentication (8 pts)
- Profile editing (5 pts)

🚧 **In Progress:**
- Email verification (3 pts) - 80% done - @alice
- Password reset (5 pts) - 50% done - @bob

🔴 **Blockers:**
- Email service integration delayed by vendor (impact: 1 day)
  - Action: Using staging endpoint, production ready by Monday

📊 **Burn-down:** 34/40 pts complete (85%)

🎯 **Tomorrow:** Code freeze, QA testing
```

## Related Skills
- `@.genie/create/skills/pm/okr-kpi-tracking.md`
- `@.genie/create/skills/communication/stakeholder-updates.md`
- `@.genie/create/skills/business-writing/executive-summary.md`
