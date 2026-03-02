# Brainstorm Design — WRS Backlog Reorganization

Date: 2026-02-13
Participants: Felipe, Genie, Sofia
Status: Validated for /wish handoff

## 1) Problem Statement
We need to reorganize all active work into a consistent Wish Readiness/priority system, then produce a shared, execution-ready backlog order with Sofia.

## 2) Scope

### In scope
- Define a single scoring framework for backlog prioritization
- Define triage method (Now/Next/Later) grounded in blocking/stability/impact
- Produce first-pass ranked backlog from current items discussed:
  - forge-resilience
  - hooks-v2
  - upgrade-brainstorm
  - workflow-rebrand
  - omni drafts/in-progress:
    - media-drive-download
    - medium-features
    - whatsapp-openclaw-integration-test
    - telegram-channel-activation
    - provider-system-refactor
    - omnichannel-agent-platform
  - Omni bug list #7 #8 #9
- Align proposal with Sofia for PM-ready backlog governance

### Out of scope
- Implementing the items themselves
- Re-architecting wish internals/tooling in this brainstorm
- Multi-week epic execution plans beyond first-pass ordering

## 3) Decisions and Rationale

### 3.1 Scoring Framework (weighted)
Use weighted priority score per item:
- Blocking power (30%)
- Stability/Reliability impact (25%)
- Cross-cutting impact (20%)
- Quick-win potential (15%)
- Complexity inverse / delivery risk (10%)

Rationale:
- Puts unblockers and production stability first
- Prevents shallow feature-first sequencing when foundation is unstable
- Still rewards fast wins to keep delivery cadence

### 3.2 Triage Method
1. Pull P0 bugs/incidents and blockers to top.
2. Resolve foundation/integration before surface features.
3. Deliver in 1–3 day slices when possible.
4. Keep epics in discovery/decomposition until dependencies are stable.

### 3.3 First-Pass Priority (Top 10)
1. provider-system-refactor
2. whatsapp-openclaw-integration-test
3. Omni bug #7
4. Omni bug #8
5. Omni bug #9
6. telegram-channel-activation
7. medium-features
8. media-drive-download
9. workflow-rebrand
10. hooks-v2

Deferred / special handling:
- omnichannel-agent-platform → epic, decompose first
- upgrade-brainstorm → validate shipped status; close residuals only
- forge-resilience → monitor/hardening if already shipped; no fresh build priority unless regressions appear

## 4) Risks / Assumptions

### Risks
- Incomplete inventory if source-of-truth set is unclear
- Prioritization drift if teams bypass weighting model
- Epics may consume capacity if decomposition is not enforced

### Assumptions
- Discussed item list represents current immediate planning universe
- Sofia co-owns backlog curation and can enforce triage policy
- Existing shipped items can be quickly validated/closed

## 5) Acceptance Criteria for Wish
1. A wish exists that codifies the weighted scoring framework and triage rules.
2. Backlog items are tagged/scored and grouped into Now/Next/Later.
3. Top 10 priority order is documented with short rationale.
4. Deferred epics have explicit decomposition gate before execution.
5. Sofia + Genie ownership model for recurring backlog review is defined.

## 6) Dependencies / Cross-Agent Notes
- Dependency: Sofia review and PM governance enforcement
- Potential dependency: Guga visibility for orchestration sequencing once wish is approved

---

Design validated (WRS 100/100). Run /wish to turn this into an executable plan.
