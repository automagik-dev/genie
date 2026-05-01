# Wish: Agent Observability Snapshot

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `agent-observability-snapshot` |
| **Date** | 2026-05-01 |
| **Author** | felipe + Codex |
| **Appetite** | large |
| **Branch** | `wish/agent-observability-snapshot` |
| **Repos touched** | `genie`, `packages/genie-app` |
| **Design** | Direct wish from live DB investigation |

## Summary

Create one canonical agent observability surface that every CLI, TUI, and app view can trust. Today each surface rebuilds partial truth from `agents`, `executors`, `sessions`, `audit_events`, `tool_events`, and `genie_runtime_events`, which makes bugs invisible or misleading. This wish creates a shared SQL/query layer plus user-facing commands for "what is this agent doing, what is slow, what failed, and what data backs that answer?"

**depends-on:** fix-agent-session-linkage, observability-signal-normalization

**blocks:** `genie-command-telemetry-boundary`

## Scope

### IN

- Canonical SQL view or query module for per-agent observability.
- `genie agent observe <name>` command with machine-readable JSON option.
- `genie observe agents` fleet summary.
- App/TUI/status wiring to the same query layer.
- Derived health signals for stale executor, missing session, missing attribution, high hook latency, recent failure, and cost/token usage.
- Clear separation of agent rows from harness/system rows in the output.

### OUT

- Mutating repair commands already owned by `fix-agent-session-linkage`.
- New event ingestion pipelines.
- Full dashboard redesign.
- Long-term retention policy.
- Replacing existing `genie log` transcript behavior.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | One query layer powers all surfaces | Avoids CLI, TUI, and app each encoding different truth. |
| 2 | Use derived health flags, not just raw states | Operators need "why this is weird" without hand-joining six tables. |
| 3 | JSON output is required | Agents and scripts need the same observability surface humans use. |
| 4 | Keep repair out of observe commands | Observability should explain first; mutation stays explicit. |

## Success Criteria

- [ ] `genie agent observe <name>` shows identity, current executor, session, tmux/pid liveness, recent events, recent tools, cost, and health flags.
- [ ] `genie observe agents --json` returns stable machine-readable records.
- [ ] App, TUI, and `genie status` use the shared query layer for agent work state.
- [ ] A stale/spawning executor with live pane is flagged distinctly from a missing pane.
- [ ] Harness/system activity is not mixed into agent activity unless explicitly requested.
- [ ] Query performance is acceptable on the richer `felipe` DB.

## Execution Strategy

### Wave 1 (sequential)

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Build canonical query/view and fixture tests |
| 2 | engineer | Add CLI observe commands |
| 3 | engineer | Wire status, TUI, and app to shared query layer |
| 4 | qa | Validate against local and `felipe` DBs |

## Execution Groups

### Group 1: Canonical Query Layer

**Goal:** Provide one tested source of truth for agent observability.

**Deliverables:**
1. `v_agent_observability` SQL view or TypeScript query module.
2. Joins across `agents`, `executors`, `sessions`, `tool_events`, normalized usage view, and latest runtime/audit events.
3. Fallback link from `executors.claude_session_id` to `sessions.id` for compatibility.
4. Derived health flags and timestamps.
5. Query performance test on fixture data approximating the remote DB scale.

**Acceptance Criteria:**
- [ ] One row per visible agent by default.
- [ ] Current executor and session are resolved correctly.
- [ ] Missing linkage and attribution flags are explicit.
- [ ] Query includes agent-vs-harness classification.

**Validation:**
```bash
bun test src/lib/agent-observability.test.ts
genie --no-tui db query "select count(*) from v_agent_observability"
```

**depends-on:** none

---

### Group 2: CLI Observability Commands

**Goal:** Give operators and agents a direct way to inspect agent state.

**Deliverables:**
1. `genie agent observe <name> [--json]`.
2. `genie observe agents [--json] [--include-harness]`.
3. Output sections for lifecycle, session, recent events, recent tools, usage, and health flags.
4. Exit codes: `0` healthy, `1` degraded, `2` not found or blocked by missing dependencies.

**Acceptance Criteria:**
- [ ] Human output is concise and actionable.
- [ ] JSON output is stable and documented.
- [ ] Degraded agents produce non-zero exit when requested with `--strict`.

**Validation:**
```bash
genie --no-tui agent observe genie --json
genie --no-tui observe agents --json
```

**depends-on:** Group 1

---

### Group 3: Surface Wiring

**Goal:** Remove duplicate partial joins from status, TUI, and app backend.

**Deliverables:**
1. `genie status` reads health/work-state from shared query layer.
2. TUI agent badges read the same work-state fields.
3. App agent detail and session list use the shared query layer where applicable.
4. Snapshot output includes "source of truth" version for debugging.

**Acceptance Criteria:**
- [ ] CLI, TUI, and app agree on current executor/session for the same agent.
- [ ] No read path emits lifecycle audit events.
- [ ] Existing app routes keep backward-compatible response fields where needed.

**Validation:**
```bash
bun test src/tui packages/genie-app
genie --no-tui status --json
```

**depends-on:** Group 2

---

### Group 4: Cross-Instance QA

**Goal:** Validate the unified surface on both development and daily-use data.

**Deliverables:**
1. Local QA transcript.
2. `ssh felipe` QA transcript.
3. Performance notes for query latency on 1.8k sessions and 70k tool events.

**Acceptance Criteria:**
- [ ] Remote `genie observe agents --json` completes quickly.
- [ ] Known broken cases appear as degraded with specific health flags.
- [ ] App and CLI show matching current executor/session state.

**Validation:**
```bash
ssh felipe 'export PATH=/home/genie/.bun/bin:/home/genie/.local/share/fnm/node-versions/v24.14.1/installation/bin:$PATH; cd /home/genie/workspace/repos/genie && genie --no-tui observe agents --json'
```

**depends-on:** Group 3

---

## QA Criteria

- [ ] Agent detail view is explainable from one query result.
- [ ] Missing data appears as a diagnostic flag, not silent blank UI.
- [ ] JSON output can be consumed by future agents.
- [ ] Runtime and audit events are visibly separated.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| View becomes too expensive as data grows | Medium | Keep heavy aggregates bounded by recent windows and indexes. |
| Existing app consumers expect old fields | Medium | Preserve compatibility shape while changing source query. |
| Harness/system rows need more taxonomy first | Low | Include provisional classification and refine in dependent wish. |

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```text
src/lib/agent-observability.ts
src/term-commands/agent.ts
src/term-commands/observe.ts
src/term-commands/status.ts
src/tui/db.ts
packages/genie-app/src-backend/index.ts
packages/genie-app/src-backend/pg-bridge.ts
src/db/migrations/*_agent_observability_view.sql
```
