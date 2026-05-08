# Wish: Observability Signal Normalization

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `observability-signal-normalization` |
| **Date** | 2026-05-01 |
| **Author** | felipe + Codex |
| **Appetite** | medium |
| **Branch** | `wish/observability-signal-normalization` |
| **Repos touched** | `genie` |
| **Design** | Direct wish from live DB investigation |

## Summary

Normalize Genie observability so signal is trustworthy before adding more dashboards. The daily-use `felipe` DB shows `242553` `resume.found` audit rows in 24 hours, `32177` `hook.delivery` runtime rows with `agent = unknown`, and OTel cost stored under `details.value` while app queries expect `details.cost_usd`. This wish removes self-noise and fixes metric shape mismatches.

**depends-on:** none

**blocks:** agent-observability-snapshot, genie-command-telemetry-boundary

## Scope

### IN

- Make resume/session lookup read paths pure.
- Move resume lifecycle events to actual resume attempts and transitions.
- Normalize Claude usage metrics into one queryable view.
- Fix app and CLI cost queries to use the normalized view.
- Pass real agent context into hook spans instead of defaulting to `unknown`.
- Redact or drop sensitive OTel resource attributes before they enter `audit_events`.

### OUT

- Replacing `audit_events` or `genie_runtime_events`.
- New UI screens.
- Full RBAC or WORM audit tier.
- Hook daemon performance work from `hookify-perf-foundation`.
- Historical deletion of old noisy rows.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Reads must not emit lifecycle audit events | Status, TUI, and list commands can run frequently; read amplification poisoned audit signal. |
| 2 | Usage normalization belongs in SQL first | App, CLI, and diagnostics need the same cost/token interpretation. |
| 3 | Hook spans must derive agent from payload or executor context | `GENIE_AGENT_NAME` is not reliable enough for all hook invocation paths. |
| 4 | Redaction happens before insert | Once sensitive user/account attributes are in JSONB, every reader becomes part of the risk surface. |

## Success Criteria

- [ ] `resume.found` no longer grows from `genie ls`, `genie status`, or TUI refresh.
- [ ] Resume attempts still emit explicit lifecycle events when an actual resume is attempted.
- [ ] `genie db query` usage view returns non-zero cost for OTel `claude_code.cost.usage`.
- [ ] App cost summary matches CLI cost summary on the same DB.
- [ ] New hook delivery rows have meaningful agent context or a clear non-agent harness classification.
- [ ] New OTel audit rows do not include `user.email`, `user.id`, `user.account_id`, `user.account_uuid`, or `organization.id`.

## Execution Strategy

### Wave 1 (sequential)

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Purify resume/session lookup read paths |
| 2 | engineer | Normalize usage/cost metrics |
| 3 | engineer | Fix hook context and sensitive OTel resource handling |
| 4 | reviewer | Verify signal-to-noise on local and `felipe` DBs |

## Execution Groups

### Group 1: Pure Read Paths

**Goal:** Stop read-only commands from writing audit rows.

**Deliverables:**
1. Split `getResumeSessionId()` into a pure lookup and an eventful resume-attempt helper.
2. Update `shouldResume()`, `status`, `ls`, and TUI work-state calls to use the pure lookup.
3. Add regression tests proving repeated status/list calls do not insert audit rows.

**Acceptance Criteria:**
- [ ] `genie status` repeated 10 times inserts zero `resume.found` rows.
- [ ] Actual resume attempt still records an explicit event.
- [ ] Existing state-machine invariant tests are updated to the new ownership boundary.

**Validation:**
```bash
bun test src/__tests__/state-machine.invariants.test.ts src/lib/should-resume.test.ts
genie --no-tui db query "select count(*) from audit_events where event_type = 'resume.found' and created_at > now() - interval '1 minute'"
```

**depends-on:** none

---

### Group 2: Usage Metric Normalization

**Goal:** Make cost and token reporting correct across app, CLI, and SQL.

**Deliverables:**
1. SQL view `v_claude_usage_events` that maps OTel metrics and legacy rows into `model`, `cost_usd`, token fields, `agent_id`, `executor_id`, `session_id`, and `created_at`.
2. App backend cost routes read from the normalized view.
3. CLI cost summaries read from the same view.
4. Tests with OTel metric rows using `details.value`.

**Acceptance Criteria:**
- [ ] `claude_code.cost.usage` with `details.value` contributes to cost totals.
- [ ] Legacy rows with `details.cost_usd` still work.
- [ ] App and CLI totals match on the same fixture.

**Validation:**
```bash
bun test packages/genie-app src/term-commands/events.test.ts
genie --no-tui db query "select sum(cost_usd) from v_claude_usage_events"
```

**depends-on:** Group 1

---

### Group 3: Hook Context and OTel Redaction

**Goal:** Prevent unknown-agent hook spans and sensitive OTel attributes from becoming default data.

**Deliverables:**
1. Hook span context resolver that checks payload, executor env, session context, and harness fallback in that order.
2. Classify non-agent hook activity as harness/system instead of `unknown`.
3. OTel receiver allowlist for resource attributes copied into `details`.
4. Regression tests for sensitive user/account fields.

**Acceptance Criteria:**
- [ ] New hook rows do not use `agent = 'unknown'` when payload/session context identifies an agent.
- [ ] Harness-owned rows are explicitly marked as harness/system.
- [ ] Sensitive OTel resource keys are absent from inserted rows.

**Validation:**
```bash
bun test src/hooks src/lib/otel-receiver.test.ts
genie --no-tui db query "select count(*) from audit_events where created_at > now() - interval '5 minutes' and (details ? 'user.email' or details ? 'user.account_id')"
```

**depends-on:** Group 1

---

### Group 4: Signal Verification

**Goal:** Confirm the normalized signals behave on both small and daily-use DBs.

**Deliverables:**
1. Verification report with before/after counts for `resume.found`, unknown hook rows, usage totals, and sensitive OTel keys.
2. Remote `ssh felipe` dry-run query transcript.
3. Short operator note explaining the new metric shapes.

**Acceptance Criteria:**
- [ ] `resume.found` does not increase from read-only command loops.
- [ ] Unknown hook rate drops sharply for new rows.
- [ ] Cost totals are non-zero on the remote DB without special-case app code.

**Validation:**
```bash
ssh felipe 'export PATH=/home/genie/.bun/bin:/home/genie/.local/share/fnm/node-versions/v24.14.1/installation/bin:$PATH; cd /home/genie/workspace/repos/genie && genie --no-tui db query "select sum(cost_usd) from v_claude_usage_events"'
```

**depends-on:** Group 2, Group 3

---

## QA Criteria

- [ ] `genie status`, `genie ls`, and TUI refresh do not create audit storms.
- [ ] App dashboard and CLI cost summary agree.
- [ ] Hook delivery timeline shows agent or harness ownership.
- [ ] Redaction test prevents new sensitive OTel keys.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Some consumers depend on `resume.found` volume | Low | Keep a deliberate resume-attempt event with clearer semantics. |
| Cost rows have multiple historical shapes | Medium | Normalize through a view with fixture coverage for each shape. |
| Hook payload may lack enough context | Medium | Use explicit harness/system classification instead of `unknown`. |

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```text
src/lib/executor-registry.ts
src/lib/should-resume.ts
src/tui/db.ts
src/term-commands/status.ts
src/lib/otel-receiver.ts
src/hooks/index.ts
packages/genie-app/src-backend/index.ts
src/db/migrations/*_claude_usage_view.sql
.genie/wishes/observability-signal-normalization/REPORT.md
```
