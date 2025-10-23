# Stakeholder Management
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Domain:** Project Management
**Agent:** project-manager

## Purpose
Identify, analyze, engage, and manage stakeholders throughout project lifecycle to ensure alignment, support, and successful outcomes.

## When to Use
- Project initiation (stakeholder identification)
- Requirement gathering and prioritization
- Change management and communication
- Conflict resolution and expectation management
- Project governance and decision-making

## Core Framework

### 1. Stakeholder Identification
**Categories:**
- **Primary:** Direct beneficiaries (users, customers, sponsors)
- **Secondary:** Indirect impact (support teams, partners, vendors)
- **Key:** Decision-makers (executives, product owners, budget holders)
- **Influencers:** Opinion leaders (domain experts, champions, blockers)

### 2. Stakeholder Analysis Matrix
**Power/Interest Grid:**
```
High Power, High Interest → MANAGE CLOSELY
  - Regular updates, deep involvement
  - Example: Executive sponsor, product owner

High Power, Low Interest → KEEP SATISFIED
  - High-level updates, minimal effort
  - Example: CFO, legal team

Low Power, High Interest → KEEP INFORMED
  - Detailed updates, engagement opportunities
  - Example: End users, support team

Low Power, Low Interest → MONITOR
  - Periodic updates, minimal engagement
  - Example: Peripheral teams, vendors
```

### 3. Engagement Strategies
**Communication Plans:**
- **Frequency:** Daily, weekly, bi-weekly, monthly
- **Channel:** Slack, email, meetings, dashboards
- **Format:** Status reports, demos, retrospectives
- **Content:** Progress, risks, decisions, blockers

**RACI Matrix:**
- **R**esponsible: Does the work
- **A**ccountable: Owns the outcome (only one)
- **C**onsulted: Provides input (two-way)
- **I**nformed: Kept updated (one-way)

### 4. Expectation Management
**Pattern:**
```
Stakeholder: [Name/Role]
Expectations:
  - [What they expect from project]
Reality Check:
  - [What's actually feasible]
Gap Analysis:
  - [Difference between expectation and reality]
Alignment Plan:
  - [How to bridge the gap]
```

## Outputs to Produce

### Stakeholder Register
**Store in:** `.genie/wishes/<project>/stakeholder-register.md`

```markdown
# Stakeholder Register - [Project Name]

| Name | Role | Power | Interest | Influence | Strategy | Contact | Notes |
|------|------|-------|----------|-----------|----------|---------|-------|
| Jane Doe | Executive Sponsor | High | High | Positive | Manage closely | jane@co | Weekly 1:1 |
| John Smith | End User Rep | Low | High | Positive | Keep informed | john@co | Demo invites |
| Sarah Lee | CFO | High | Low | Neutral | Keep satisfied | sarah@co | Monthly finance reports |
```

### Communication Plan
```markdown
| Stakeholder Group | Frequency | Channel | Content | Owner |
|-------------------|-----------|---------|---------|-------|
| Executive team | Monthly | Email | Executive summary | PM |
| Product team | Weekly | Slack + Meeting | Sprint review, demos | PM |
| End users | Bi-weekly | Email | Feature updates, beta invites | Product Owner |
| Support team | Weekly | Slack | Known issues, documentation | Tech Lead |
```

## Never Do
- ❌ Skip stakeholder identification at project start
- ❌ Treat all stakeholders equally (prioritize based on power/interest)
- ❌ Over-communicate to low-interest stakeholders (wastes their time)
- ❌ Under-communicate to high-power stakeholders (lose support)
- ❌ Ignore negative influencers (they become blockers)
- ❌ Promise what you can't deliver (destroys trust)
- ❌ Surprise stakeholders with bad news (communicate risks early)

## Integration with Create
**Handoffs:**
- **From strategist:** Strategic stakeholder mapping
- **To communicator:** Stakeholder announcements and updates
- **To writer:** Stakeholder reports and documentation
- **From researcher:** Stakeholder interviews and surveys

## Tools & Templates
- **Stakeholder maps:** Miro, Lucidchart, Mural
- **Communication:** Slack, email, Loom videos
- **Tracking:** Notion, Airtable, Excel
- **RACI matrices:** Google Sheets, Confluence

## Success Metrics
- Stakeholder satisfaction scores (surveys)
- Engagement rates (meeting attendance, email open rates)
- Decision velocity (time from proposal to approval)
- Conflict resolution time
- Sponsor confidence level

## Examples

### Example 1: Product Launch
```
Key Stakeholders:
1. CEO (High power, high interest)
   - Strategy: Weekly update, involve in major decisions
   - KPI: Product-market fit, revenue targets

2. Engineering Team (Low power, high interest)
   - Strategy: Daily standups, sprint reviews
   - KPI: Delivery on time, technical quality

3. Marketing (Medium power, high interest)
   - Strategy: Bi-weekly sync, early access to features
   - KPI: Launch readiness, campaign alignment
```

### Example 2: Internal Tool Migration
```
Negative Stakeholders:
- Legacy system champions (resistant to change)
- Strategy:
  1. Early involvement in design
  2. Address their concerns explicitly
  3. Show wins early (pilot with their team)
  4. Celebrate their input publicly
```

## Related Skills
- `@.genie/create/skills/pm/risk-management.md` - Stakeholder risks
- `@.genie/create/skills/communication/stakeholder-updates.md` - Updates
- `@.genie/create/skills/pm/meeting-facilitation.md` - Stakeholder meetings
- `@.genie/create/skills/strategy/decision-frameworks.md` - Decision-making
