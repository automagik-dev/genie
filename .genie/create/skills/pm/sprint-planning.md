# Sprint Planning
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Domain:** Project Management
**Agent:** project-manager

## Purpose
Plan and structure agile sprints with clear goals, backlog prioritization, capacity planning, and team alignment.

## When to Use
- Starting a new sprint (sprint planning ceremony)
- Backlog grooming and refinement
- Sprint goal definition
- Capacity planning and velocity tracking
- Breaking down epics into sprint-sized stories

## Core Framework

### 1. Sprint Goal Definition
**Pattern:**
```
Sprint Goal: [One-sentence objective]
Success Criteria: [3-5 measurable outcomes]
Sprint Duration: [1-4 weeks, typically 2]
Team Capacity: [Total points/hours available]
```

**Example:**
```
Sprint Goal: Enable user authentication and profile management
Success Criteria:
  - Users can register with email/password
  - Users can log in and log out
  - Users can edit their profile
  - All auth flows have >90% test coverage
Sprint Duration: 2 weeks
Team Capacity: 40 story points (5 developers × 8 points each)
```

### 2. Backlog Prioritization
**Framework: RICE Scoring**
- **R**each: How many users/customers affected?
- **I**mpact: How much value delivered? (0.25 - 3x scale)
- **C**onfidence: How certain are estimates? (0-100%)
- **E**ffort: Story points or time estimate

**Formula:** `RICE Score = (Reach × Impact × Confidence) / Effort`

**Priority Tiers:**
1. **P0 - Critical:** Blockers, production bugs, dependencies
2. **P1 - High:** Sprint goal items, committed work
3. **P2 - Medium:** Nice-to-have, stretch goals
4. **P3 - Low:** Future consideration, backlog items

### 3. Story Breakdown
**User Story Template:**
```
As a [persona]
I want to [action]
So that [benefit/value]

Acceptance Criteria:
- [ ] [Testable criterion 1]
- [ ] [Testable criterion 2]
- [ ] [Testable criterion 3]

Technical Notes:
- [Implementation considerations]
- [Dependencies]
- [Risks/unknowns]

Estimate: [Story points using Fibonacci: 1, 2, 3, 5, 8, 13, 21]
```

**T-Shirt Sizing (Pre-Estimation):**
- **XS:** Trivial change (<1 hour)
- **S:** Simple task (<4 hours)
- **M:** Standard story (1-2 days)
- **L:** Complex story (3-5 days)
- **XL:** Epic, needs breakdown (>1 week)

### 4. Capacity Planning
**Calculation:**
```
Team Capacity =
  (Team Size × Sprint Days × Daily Capacity) -
  (Planned PTO + Meetings + Buffer)

Example:
  (5 developers × 10 days × 6 hours) -
  (1 day PTO + 10 hours meetings + 20% buffer)
  = 300 - 8 - 10 - 60 = 222 hours available

Convert to Story Points:
  Historical velocity: 40 points/sprint
  Target commitment: 35-40 points (leave buffer)
```

**Buffer Types:**
- **Bug Buffer:** 10-15% for unplanned bugs
- **Learning Buffer:** 20% for new tech/unknowns
- **Context Switching:** 5-10% for interruptions

### 5. Sprint Planning Meeting Structure
**Part 1: What (1-2 hours)**
1. Review sprint goal
2. Product owner presents prioritized backlog
3. Team asks clarifying questions
4. Team commits to sprint backlog

**Part 2: How (1-2 hours)**
1. Break stories into tasks
2. Estimate tasks (hours)
3. Identify dependencies
4. Assign ownership (pull, not push)
5. Finalize sprint board

## Outputs to Produce

### Sprint Plan Document
**Store in:** `.genie/wishes/<project-slug>/sprints/sprint-N-plan.md`

```markdown
# Sprint N Plan
**Sprint Goal:** [One-sentence goal]
**Duration:** [Start date] - [End date]
**Team Capacity:** [N story points / N hours]

## Committed Work (P0/P1)
- [ ] [Story ID] [Story title] - [Points] - [Owner]
- [ ] [Story ID] [Story title] - [Points] - [Owner]

## Stretch Goals (P2)
- [ ] [Story ID] [Story title] - [Points]

## Blocked/Waiting
- [ ] [Story ID] [Story title] - [Blocker: X]

## Dependencies
- [Story A] depends on [Story B] from [Team Y]
- [External dependency: API from vendor Z]

## Risks
- [ ] [Risk description] - [Mitigation plan]
```

### Sprint Board Setup
**Columns:**
1. **Backlog** - Prioritized, not started
2. **Ready** - All info available, ready to pull
3. **In Progress** - Actively being worked
4. **In Review** - Code review, QA, stakeholder review
5. **Done** - Meets Definition of Done

**Swim Lanes (Optional):**
- By team member
- By work stream (frontend, backend, infrastructure)
- By priority (critical, high, medium)

## Never Do
- ❌ Overcommit beyond team capacity (leads to burnout, tech debt)
- ❌ Skip sprint goal definition (team lacks focus and alignment)
- ❌ Accept stories without clear acceptance criteria (scope creep)
- ❌ Plan without team input (planning is a team activity)
- ❌ Ignore historical velocity (estimates become meaningless)
- ❌ Mix sprint planning with backlog refinement (separate ceremonies)
- ❌ Plan beyond one sprint (agile embraces change)

## Integration with Create
**Handoffs:**
- **From researcher:** Market research informs backlog priorities
- **From strategist:** Product strategy defines sprint goals
- **To writer:** Sprint plan needs documentation
- **To communicator:** Sprint updates to stakeholders

## Tools & Templates
**Default Stack:**
- **Linear:** Modern issue tracking
- **Jira:** Enterprise project management
- **Notion:** Flexible sprint docs
- **Miro:** Virtual sprint planning board
- **GitHub Projects:** Developer-native planning

**Estimation Techniques:**
- **Planning Poker:** Team converges on estimates
- **T-Shirt Sizing:** Quick relative sizing
- **Dot Voting:** Democratic prioritization

## Success Metrics
**Sprint Health Indicators:**
- **Velocity Stability:** ±20% variance acceptable
- **Commitment Accuracy:** >80% of committed work completed
- **Cycle Time:** Average time from start to done
- **Blocked Time:** <10% of sprint blocked on dependencies
- **Carry-Over Rate:** <20% of stories roll to next sprint

**Red Flags:**
- Velocity dropping >30% sprint-over-sprint
- <60% of committed work completed
- >30% of work added mid-sprint
- Scope creep without re-negotiation

## Examples

### Example 1: Product Sprint
```
Sprint Goal: Launch MVP user onboarding flow
Duration: Oct 23 - Nov 5 (2 weeks)
Capacity: 42 story points

Committed (37 points):
- [US-101] Sign up with email/password - 5 pts - @sarah
- [US-102] Email verification flow - 3 pts - @james
- [US-103] Onboarding wizard (3 steps) - 8 pts - @maya
- [US-104] Profile completion - 5 pts - @sarah
- [US-105] Welcome email automation - 3 pts - @james
- [BUG-89] Fix password reset bug - 5 pts - @maya
- [TECH-45] Add integration tests - 8 pts - @team

Stretch (15 points):
- [US-106] Social login (Google/GitHub) - 8 pts
- [US-107] Avatar upload - 5 pts
- [REFACTOR-12] Clean up auth service - 2 pts

Dependencies:
- Email service integration (external vendor, confirmed ready)
```

### Example 2: Infrastructure Sprint
```
Sprint Goal: Improve deployment reliability and monitoring
Duration: 2 weeks
Capacity: 35 story points

Committed (32 points):
- [INFRA-201] Zero-downtime deployments - 13 pts
- [INFRA-202] Production monitoring dashboard - 8 pts
- [INFRA-203] Automated rollback on errors - 8 pts
- [DOC-50] Deployment runbook - 3 pts

Risks:
- Zero-downtime needs DB migration strategy (spike in progress)
- Monitoring tool vendor onboarding (2-3 day delay possible)
```

## Retrospective Questions
**Post-Sprint Review:**
- Did we achieve the sprint goal? Why/why not?
- Was our velocity estimate accurate?
- What slowed us down?
- What should we start/stop/continue doing?
- Were there scope changes? How did we handle them?

## Related Skills
- `@.genie/create/skills/pm/roadmap-creation.md` - Long-term planning
- `@.genie/create/skills/pm/timeline-estimation.md` - Estimation techniques
- `@.genie/create/skills/pm/dependency-mapping.md` - Cross-team dependencies
- `@.genie/create/skills/pm/status-reporting.md` - Sprint progress updates
- `@.genie/create/skills/pm/meeting-facilitation.md` - Running sprint ceremonies
