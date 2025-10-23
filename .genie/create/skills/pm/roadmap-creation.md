# Roadmap Creation
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Domain:** Project Management
**Agent:** project-manager

## Purpose
Create strategic product, project, or technology roadmaps that align teams, communicate vision, and guide execution over quarters/years.

## When to Use
- Product planning (quarterly, annual)
- Technology planning (architecture evolution)
- Organizational planning (team growth, capability building)
- Investor/board communication
- Cross-team alignment and dependency planning

## Core Framework

### 1. Roadmap Types
**Product Roadmap:**
- Themes, features, releases over time
- Customer-facing value delivery
- Audience: Product team, executives, customers

**Technology Roadmap:**
- Technical debt, infrastructure, tooling
- Platform evolution, migrations
- Audience: Engineering team, CTO

**Organizational Roadmap:**
- Team growth, capability building, process improvements
- Audience: Leadership, HR, finance

### 2. Time Horizons
**Now-Next-Later Framework:**
```
Now (0-3 months) → HIGH CONFIDENCE
  - Committed work, detailed specs
  - Example: "Launch user authentication"

Next (3-6 months) → MEDIUM CONFIDENCE
  - Themes and epics, rough estimates
  - Example: "Improve onboarding experience"

Later (6-12+ months) → LOW CONFIDENCE
  - Strategic bets, exploration
  - Example: "Explore AI-powered recommendations"
```

**Quarterly Roadmap (More Detail):**
```
Q1 2025 → Foundation
Q2 2025 → Growth
Q3 2025 → Scale
Q4 2025 → Optimize
```

### 3. Prioritization Framework
**RICE + Impact Mapping:**
1. **Business Impact:** Revenue, cost savings, market share
2. **User Impact:** Satisfaction, retention, acquisition
3. **Strategic Alignment:** Company vision, OKRs
4. **Technical Debt:** Reduce complexity, improve velocity
5. **Risk Mitigation:** Compliance, security, reliability

**Sequencing Logic:**
- Dependencies first (unblock future work)
- Foundation before features (stable platform)
- High-value, low-effort wins early (momentum)
- Big bets after validation (reduce risk)

### 4. Roadmap Components
**Theme-Based Structure:**
```
Theme: [Strategic pillar, e.g., "User Growth"]
  ↓
Initiatives: [Major efforts, e.g., "Referral Program"]
  ↓
Epics: [Deliverables, e.g., "Referral Dashboard"]
  ↓
User Stories: [Features, e.g., "Share invite link"]
```

## Outputs to Produce

### Roadmap Document
**Store in:** `.genie/wishes/<project>/roadmap-2025.md`

```markdown
# [Product/Project] Roadmap 2025

## Vision
[One-paragraph north star vision]

## Strategic Themes
1. **[Theme 1]** - [Description]
2. **[Theme 2]** - [Description]
3. **[Theme 3]** - [Description]

## Q1 2025 (Jan-Mar) - [Phase Name]
**Goal:** [Quarter objective]

### Committed
- **[Initiative A]** (8 weeks) - [Description]
  - [ ] Epic 1
  - [ ] Epic 2
- **[Initiative B]** (6 weeks) - [Description]
  - [ ] Epic 1

### Exploring
- **[Initiative C]** - Research spike, decision by end of Q1

## Q2 2025 (Apr-Jun) - [Phase Name]
**Goal:** [Quarter objective]
...

## Later (Q3-Q4)
**Candidates:**
- [Idea 1] - If [condition]
- [Idea 2] - Depends on [dependency]
```

### Visual Roadmap
**Tools:**
- **ProductPlan:** Roadmap software
- **Aha!:** Product management suite
- **Notion:** Flexible roadmap tables
- **Miro/Figma:** Visual timeline

**Layout:**
```
      Q1         Q2         Q3         Q4
Theme 1: ███████ ███ ....... .......
Theme 2: ....... ███████ ███ .......
Theme 3: ....... ....... ███████ ███
```

## Never Do
- ❌ Overpromise dates beyond 3 months (things change)
- ❌ Fill every quarter to 100% capacity (leave buffer)
- ❌ Show roadmap without context (explain strategy, trade-offs)
- ❌ Commit to features without validation (de-risk first)
- ❌ Ignore technical debt (it compounds)
- ❌ Create roadmap in isolation (involve team, stakeholders)
- ❌ Treat roadmap as contract (it's a hypothesis, iterate)

## Integration with Create
**Handoffs:**
- **From strategist:** Market analysis, competitive landscape
- **From analyst:** Data insights, opportunity sizing
- **To writer:** Roadmap documentation, blog posts
- **To communicator:** External roadmap announcements
- **From project-manager:** Sprint plans aligned to roadmap

## Tools & Templates
- **ProductBoard:** Customer feedback → roadmap
- **Linear:** Roadmap view with projects and cycles
- **Jira:** Epic-level roadmap
- **Google Sheets:** Simple timeline tracker
- **Confluence:** Roadmap wiki

## Success Metrics
- **Delivery accuracy:** % of committed items delivered on time
- **Alignment score:** Team confidence in roadmap (survey)
- **Velocity trend:** Sprint velocity over quarters
- **Pivot rate:** How often roadmap changes (signal flexibility)
- **Stakeholder satisfaction:** Executive/customer confidence

## Examples

### Example 1: SaaS Product Roadmap
```
Q1 2025 - Foundation
Theme: Enterprise Readiness
- ✅ SSO integration (SAML, OAuth)
- ✅ Advanced permissions (RBAC)
- ✅ Audit logging
- 🔄 SOC 2 compliance prep

Q2 2025 - Growth
Theme: User Acquisition
- 🎯 Self-serve onboarding
- 🎯 Free tier + upgrade flow
- 🎯 Referral program
- 🔍 Exploring: Integration marketplace

Q3-Q4 2025 - Scale
Theme: Performance & Scale
- 💡 Multi-region deployment
- 💡 Advanced analytics dashboard
- 💡 API rate limiting improvements
```

### Example 2: Technology Roadmap
```
Now (Q1)
- Migrate to TypeScript (reduce bugs)
- Implement feature flags (faster releases)
- Add E2E test coverage (quality)

Next (Q2-Q3)
- Microservices extraction (scalability)
- Move to Kubernetes (reliability)
- GraphQL API layer (developer experience)

Later (Q4+)
- Event-driven architecture (decoupling)
- Real-time data pipeline (insights)
```

## Related Skills
- `@.genie/create/skills/pm/sprint-planning.md` - Tactical sprint planning
- `@.genie/create/skills/strategy/strategic-planning.md` - Long-term strategy
- `@.genie/create/skills/pm/dependency-mapping.md` - Cross-team dependencies
- `@.genie/create/skills/pm/okr-kpi-tracking.md` - OKR alignment
- `@.genie/create/skills/business-writing/executive-summary.md` - Roadmap comms
