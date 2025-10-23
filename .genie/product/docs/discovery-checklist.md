# Forge Integration - Discovery Checklist
**Date:** 2025-10-18
**Project:** automagik-genie ↔ Forge Backend
**Purpose:** Validation tasks for unmapped endpoints before implementation
**Status:** Ready for execution

---

## 📋 Overview

This checklist defines all **Discovery investigations** required before implementing Categories 6-15 endpoints. Each item includes:
- **Objective:** What we need to learn
- **Questions:** Specific validation points
- **Deliverable:** Expected output
- **Estimated Time:** Investigation duration
- **Priority:** HIGH/MEDIUM/LOW
- **Dependencies:** What else needs to be done first

---

## HIGH PRIORITY (Blocks Core Features)

### Discovery #1: Approvals Endpoint Validation
**Priority:** 🔴 HIGH
**Estimated Time:** 1-2 days
**Blocking:** Group A implementation (PR creation workflow)

**Objective:**
Validate Forge's `createApprovalRequest/get/respond` endpoints match our final approval gate use case.

**Questions:**
1. What is the exact payload structure for `createApprovalRequest()`?
2. Does it support blocking behavior (wait for response)?
3. Can we attach context (diffs, test results, branch status)?
4. How are approval responses communicated (polling? SSE?)?
5. What happens if approval times out?
6. Can we configure approval policies (required for PR/merge)?

**Investigation Steps:**
1. Read Forge API documentation for approval endpoints
2. Test `createApprovalRequest()` with sample data
3. Test `respondToApprovalRequest()` (approve/deny)
4. Verify SSE event emitted on approval request/response
5. Identify gaps between Forge endpoint and our needs

**Deliverable:**
- `.genie/discovery/approvals-validation.md`
  - Endpoint documentation (request/response schemas)
  - Behavior validation (blocking, timeout, policies)
  - Gap analysis (what Forge doesn't support)
  - Recommendation (use as-is, wrapper, or custom service)

**Success Criteria:**
- [ ] All endpoint payloads documented
- [ ] Blocking behavior confirmed or workaround designed
- [ ] SSE integration validated
- [ ] Recommendation documented (implement or defer)

---

### Discovery #2: Templates Inventory (Forge vs. Genie)
**Priority:** 🔴 HIGH
**Estimated Time:** 2-3 days
**Dependency:** Related to Wish #110 (Multi-template architecture)

**Objective:**
Inventory Forge's template system and decide unification strategy with Genie's "code/create" templates.

**Questions:**
1. What templates does Forge offer?
2. What metadata does each template contain (name, description, variables, files)?
3. Are Forge templates compatible with Genie's agent structure?
4. Can Forge templates be extended/customized?
5. Should we deprecate "code/create" in favor of Forge templates?
6. How do agent types map to Forge templates?

**Investigation Steps:**
1. Call `listTemplates()` and document all available templates
2. Call `getTemplate()` for each to extract full metadata
3. Compare with Genie's `.genie/agents/code/` and `.genie/agents/create/`
4. Test `createTemplate()` with custom template
5. Design mapping: agent type → Forge template

**Deliverable:**
- `.genie/discovery/templates-inventory.md`
  - Complete Forge template catalog
  - Comparison matrix (Forge vs. Genie)
  - Mapping proposal (agent types → templates)
  - Recommendation (unify, keep separate, or hybrid)

**Deliverable (if unified):**
- `.genie/docs/template-migration-guide.md`
  - Migration path from "code/create" to Forge templates
  - Breaking changes documentation
  - User communication plan

**Success Criteria:**
- [ ] All Forge templates documented
- [ ] Compatibility analysis complete
- [ ] Mapping proposal validated
- [ ] Decision made (unify/separate/hybrid)
- [ ] Migration guide written (if unified)

---

### Discovery #3: Executors/MCP Discovery Protocol
**Priority:** 🔴 HIGH
**Estimated Time:** 2-3 days
**Blocking:** Dynamic executor discovery in CLI

**Objective:**
Design protocol for discovering available executors from Forge and map to Genie-friendly names.

**Questions:**
1. What does `listExecutorProfiles()` return (structure, fields)?
2. How do we map Forge profile IDs to Genie executor names?
3. What happens when an executor is unavailable?
4. Can we query executor capabilities (models, features)?
5. How does Forge's MCP configuration relate to Genie's MCP servers?
6. Should MCP be unified or separate?

**Investigation Steps:**
1. Call `listExecutorProfiles()` and document response
2. Call `getExecutorProfile()` for each profile
3. Design mapping: Forge profile ID → Genie-friendly name
4. Test fallback when executor unavailable
5. Investigate `getMcpConfig()` and compare with Genie's MCP setup

**Deliverable:**
- `.genie/discovery/executors-discovery.md`
  - Executor profile catalog
  - Name mapping specification
  - Availability checking logic
  - Fallback behavior design
- `.genie/discovery/mcp-unification.md`
  - MCP configuration comparison
  - Unification strategy (shared vs. separate)
  - Configuration schema

**Success Criteria:**
- [ ] Executor profiles fully documented
- [ ] Name mapping implemented
- [ ] Fallback logic designed
- [ ] MCP unification decision made
- [ ] CLI `genie info executors` ready to implement

---

## MEDIUM PRIORITY (Enhances Features)

### Discovery #4: SSE Automations Catalog
**Priority:** 🟡 MEDIUM
**Estimated Time:** 2-3 days
**Dependency:** SSE listener foundation (Group A)

**Objective:**
Define safe automatic actions that can be triggered on SSE events.

**Questions:**
1. What events are available via `subscribeToEvents()`?
2. What payloads do events contain?
3. What actions can we safely automate?
4. How do we ensure idempotency?
5. What retry logic is needed?
6. What should require user confirmation vs. automatic?

**Investigation Steps:**
1. Subscribe to SSE and capture all event types
2. Document event payloads for each type
3. Brainstorm automation opportunities (safe + valuable)
4. Design idempotency checks for each action
5. Design retry logic for transient failures
6. Categorize: automatic vs. confirm vs. manual-only

**Deliverable:**
- `.genie/discovery/sse-automations-catalog.md`
  - Complete event catalog (types + payloads)
  - Automation proposals (ranked by safety/value)
  - Idempotency design
  - Retry logic specification
  - User confirmation gates

**Example Automations:**
- `task_completed` → Auto-pull logs, update wish status
- `pr_created` → Auto-open review, notify Omni
- `approval_requested` → Show CLI prompt, notify Omni
- `auth_failed` → Guide user to re-login
- `system_error` → Log to .genie/logs/, notify Omni

**Success Criteria:**
- [ ] All SSE events documented
- [ ] 5-10 safe automations identified
- [ ] Idempotency logic designed
- [ ] Retry strategy documented
- [ ] Implementation priority ranked

---

### Discovery #5: Drafts Validation (Real Use Cases)
**Priority:** 🟡 MEDIUM
**Estimated Time:** 1-2 days
**Blocking:** None (deprioritized)

**Objective:**
Validate whether drafts (checkpoints) add value vs. complexity.

**Questions:**
1. What use cases require checkpoints mid-execution?
2. Are task attempts sufficient for versioning/A/B testing?
3. Would auto-checkpoints help or add noise?
4. How often would users manually save/restore drafts?
5. What storage/performance implications exist?

**Investigation Steps:**
1. Review task attempt system (is it sufficient?)
2. Interview potential users (would they use drafts?)
3. Prototype auto-checkpoint logic (when to trigger?)
4. Estimate storage cost (how many checkpoints per task?)
5. Compare: drafts vs. multiple task attempts

**Deliverable:**
- `.genie/discovery/drafts-validation.md`
  - Use case analysis
  - Comparison with task attempts
  - User demand assessment
  - Storage/performance impact
  - Recommendation (implement, defer, or reject)

**Success Criteria:**
- [ ] Use cases identified (if any)
- [ ] Comparison with attempts complete
- [ ] User demand validated
- [ ] Decision made (yes/no/later)
- [ ] If yes: Design specification written

---

## LOW PRIORITY (Post-MVP)

### Discovery #6: Container Management UX
**Priority:** 🔵 LOW
**Estimated Time:** 1 day
**Blocking:** None (internal/automatic by default)

**Objective:**
Design expert mode diagnostics for container visibility (if needed).

**Questions:**
1. What container information is useful to users?
2. When would users need to see container status?
3. Should we expose logs, restart, or read-only only?
4. What about security (exposing internal infrastructure)?

**Investigation Steps:**
1. List all container operations Forge offers
2. Identify diagnostic use cases (debugging, monitoring)
3. Design read-only status display
4. Validate security implications of exposure

**Deliverable:**
- `.genie/discovery/container-ux.md`
  - Use cases for container visibility
  - Security considerations
  - UX design (CLI output format)
  - Recommendation (expose or keep internal)

**Success Criteria:**
- [ ] Use cases validated
- [ ] Security review complete
- [ ] UX design documented
- [ ] Decision made (expose or defer)

---

### Discovery #7: Image Management Advanced Features
**Priority:** 🔵 LOW
**Estimated Time:** 2 days
**Blocking:** None (basic image attach/list already approved)

**Objective:**
Explore advanced image features for future iterations.

**Questions:**
1. Would users benefit from a gallery view in CLI?
2. Are visual diffs (image comparison) valuable?
3. Should we support annotations/markup?
4. What about thumbnails for faster loading?

**Investigation Steps:**
1. Test current image attach workflow
2. Gather user feedback on pain points
3. Prototype gallery view (if valuable)
4. Investigate image diff libraries

**Deliverable:**
- `.genie/discovery/image-advanced-features.md`
  - User feedback summary
  - Gallery view design
  - Visual diff proposal
  - Annotations/markup feasibility

**Success Criteria:**
- [ ] User feedback collected
- [ ] Features prioritized by value
- [ ] Prototype(s) validated
- [ ] Roadmap for future implementation

---

## Discovery Execution Plan

### Phase 1: HIGH Priority (Week 1-2)
**Run in parallel:**
- Discovery #1: Approvals (1-2 days)
- Discovery #2: Templates (2-3 days)
- Discovery #3: Executors/MCP (2-3 days)

**Deliverables:**
- 3 discovery reports
- Go/no-go decision for each
- Updated endpoint mapping

**Gates Group A implementation:**
YES - must complete before proceeding

---

### Phase 2: MEDIUM Priority (Week 3-4)
**Run in parallel:**
- Discovery #4: SSE Automations (2-3 days)
- Discovery #5: Drafts (1-2 days)

**Deliverables:**
- 2 discovery reports
- Automation catalog
- Drafts decision

**Gates Group B implementation:**
NO - can proceed without these, add later

---

### Phase 3: LOW Priority (Week 5+)
**Run as needed:**
- Discovery #6: Container UX (1 day)
- Discovery #7: Image Advanced (2 days)

**Deliverables:**
- 2 discovery reports
- Post-MVP roadmap

**Gates any implementation:**
NO - nice-to-have features only

---

## Discovery Report Template

Each discovery investigation should produce a report following this template:

```markdown
# Discovery Report: [Topic]
**Date:** YYYY-MM-DD
**Investigator:** [Name]
**Priority:** HIGH/MEDIUM/LOW
**Status:** IN_PROGRESS | COMPLETE | BLOCKED

---

## Objective
[What we needed to learn]

## Investigation Summary
[What we did]

## Findings
[What we learned - detailed]

### Key Discoveries
1. [Discovery 1]
2. [Discovery 2]
3. [...]

### Surprises / Unexpected
[Things we didn't expect to find]

### Gaps / Limitations
[What Forge doesn't support that we need]

---

## Analysis

### Option A: [Approach 1]
**Pros:**
- [Pro 1]
- [Pro 2]

**Cons:**
- [Con 1]
- [Con 2]

**Estimated Effort:** [X days]

### Option B: [Approach 2]
[Same structure]

### Option C: [Approach 3]
[Same structure]

---

## Recommendation

**Selected Option:** [A/B/C]

**Rationale:**
[Why this option is best]

**Implementation Plan:**
1. [Step 1]
2. [Step 2]
3. [...]

**Timeline:** [X days/weeks]

**Dependencies:**
- [Dependency 1]
- [Dependency 2]

**Risks:**
- [Risk 1 + mitigation]
- [Risk 2 + mitigation]

---

## Next Steps

1. [ ] [Action 1]
2. [ ] [Action 2]
3. [ ] [Action 3]

---

## Appendix

### Test Scripts
[Code snippets used for investigation]

### API Payloads
[Request/response examples]

### References
- [Link 1]
- [Link 2]
```

---

## Success Metrics

**Discovery Phase Complete When:**
- [ ] All HIGH priority investigations done (3 reports)
- [ ] All MEDIUM priority investigations done (2 reports)
- [ ] Go/no-go decisions made for each feature
- [ ] Endpoint mapping updated with findings
- [ ] Implementation roadmap adjusted based on discoveries
- [ ] No blockers remaining for Group A

**Quality Gates:**
- [ ] Each report follows template
- [ ] Each report includes code examples/tests
- [ ] Each report has clear recommendation
- [ ] Each report reviewed by stakeholder
- [ ] Decisions logged in endpoint mapping doc

---

## Tracking

### Discovery Status Board

| ID | Topic | Priority | Status | Started | Completed | Owner |
|----|-------|----------|--------|---------|-----------|-------|
| #1 | Approvals | 🔴 HIGH | 📋 TODO | — | — | — |
| #2 | Templates | 🔴 HIGH | 📋 TODO | — | — | — |
| #3 | Executors/MCP | 🔴 HIGH | 📋 TODO | — | — | — |
| #4 | SSE Automations | 🟡 MEDIUM | 📋 TODO | — | — | — |
| #5 | Drafts | 🟡 MEDIUM | 📋 TODO | — | — | — |
| #6 | Container UX | 🔵 LOW | 📋 TODO | — | — | — |
| #7 | Image Advanced | 🔵 LOW | 📋 TODO | — | — | — |

**Update this table as discoveries progress.**

---

## Appendix: GitHub Issue Templates

### Template: Discovery Investigation

```markdown
**Title:** [Discovery] [Topic Name]

**Priority:** HIGH/MEDIUM/LOW
**Estimated Time:** [X days]
**Blocking:** [What this blocks, if anything]

## Objective
[What we need to learn]

## Questions
1. [Question 1]
2. [Question 2]
3. [...]

## Investigation Steps
- [ ] [Step 1]
- [ ] [Step 2]
- [ ] [...]

## Deliverable
`.genie/discovery/[topic].md` with:
- Findings summary
- Options analysis
- Recommendation
- Implementation plan

## Definition of Done
- [ ] All questions answered
- [ ] Discovery report written
- [ ] Recommendation reviewed
- [ ] Decision logged in endpoint mapping

**Labels:** `discovery`, `forge-integration`
**Assignee:** [Name]
**Project:** Forge Executor Replacement
**Milestone:** Discovery Phase
```

---

## Next Actions

1. **Create GitHub Issues**
   - Use template above for each discovery item
   - Assign priorities and estimates
   - Link to this checklist

2. **Schedule Discovery Sprint**
   - Block time for HIGH priority investigations (Week 1-2)
   - Assign owners
   - Set up progress tracking

3. **Prepare Investigation Environment**
   - Ensure Forge backend accessible
   - Set up test data/projects
   - Configure logging for API calls

4. **Begin Investigations**
   - Start with HIGH priority in parallel
   - Daily standups to track progress
   - Document findings as you go

---

**Checklist Author:** Genie (forge/120-executor-replacement)
**Version:** 1.0.0
**Status:** ✅ Ready for Execution
