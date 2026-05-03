# Wish: Retire Session Names — Identity is the UUID

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `retire-session-names-id-only` |
| **Date** | 2026-05-03 |
| **Author** | genie-4 (orchestrator) |
| **Appetite** | medium |
| **Branch** | `wish/retire-session-names-id-only` |
| **Repos touched** | `repos/genie` |
| **Design** | _No brainstorm — direct wish, derived from inline /trace findings (task #172)_ |

## Summary

Second cleanup pass on session-name retirement. The first pass (`claude-resume-by-session-id`, 2026-04-14) made `executors.claude_session_id` canonical and dropped `agents.claude_session_id`. Migrations 050/053 archived bare-name shadows. Commit `c5aa7314 feat(observability): purify resume/session read paths` (2026-05-02) split read-amplification audit emission from the resume reader — orthogonal to identity shape but eliminates one source of `resume.missing_session` event-storm pressure. But the regression engine has three corners — drop any one and name-handling grows back: **(a) every spawn writes TWO rows** (`findOrCreateAgent` writes UUID identity + `register({id: workerId})` writes bare-name runtime — agent-registry.ts:271, agents.ts:643), **(b) the schema has no FK discipline** across `mailbox.{from,to}_worker`, `team_chat.sender`, `teams.{leader,members}`, `agents.reports_to`, `agent_templates.id` (all TEXT, no FK to `agents.id`), **(c) hook consumers ignore `GENIE_AGENT_ID`** even though provider-adapters.ts:380/598 already propagate it on claude/codex paths (the native-team helper at :280 still only sets NAME — needs the same id-export added) — they read `GENIE_AGENT_NAME`+`GENIE_TEAM` and `getAgentByName(name, team)` instead. Drift always lands where the schema doesn't enforce shape, two-row spawn pre-creates the shadow, and the hook env keeps re-resolving by name. This wish closes all three corners simultaneously.

## Scope

### IN

- **DB invariant + FK lockdown** (one migration, 061 — dev shipped 058/059/060 already): (a) `agents.id` CHECK constraint — UUID OR `dir:<name>`; (b) FK every reference column to `agents.id`: `mailbox.{from,to}_worker`, `team_chat.sender`, `teams.leader`, `agents.reports_to`. UUID-array migrate for `teams.members JSONB`. UUID PK + unique `(name, team)` index for `agent_templates`. Backfill name → UUID inside the migration before adding FK.
- One-shot heal: archive any extant bare-name rows that survived 050/053 (heal-not-wipe).
- **Spawn writes ONE row.** Remove `register({id: workerId})` bare-name INSERT (agent-registry.ts:271). Spawn writes only the UUID identity row via `findOrCreateAgent`; runtime fields (pane, session, state) move onto `executors` (already there) or onto the UUID row. Update `resolveSpawnIdentity` (agents.ts:2350) and `registerSpawnWorker` (agents.ts:643) to operate on UUID + custom_name.
- Single resolver: `resolveAgentId(nameOrId, team) → agentId | null` in `agent-registry.ts`. Every name → row lookup goes through it.
- Delete the five JS-side fuzzy filters (`a.customName === name || a.role === name || a.id === name`) in show.ts, send.ts, log.ts, msg.ts, codex-inbox-deliver.ts. Plus `target-resolver.ts:259,267`, `team-manager.ts:220-244` killWorkersByName, `auto-spawn.ts:83`.
- Collapse `resolveAgentForRecover` 4-tier fallback (agents.ts:2964-2988) and `resolveWorkerByName` multi-strategy (agents.ts:2745-2772) into the single resolver.
- Tighten `findSpawnTemplate` to `(team, role)` lookup; remove the 3-way name confusion. Tighten `cleanupDeadWorkers`, `findKnownWorker`, `deliverViaNativeInbox`, `resolveRecipient` to id-only after CLI-boundary resolution.
- Fix `turn-close.ts:144-146` ghost-executor fallback — `WHERE agent_id = ${agentName}` compares FK-shaped column to bare name; use UUID lookup.
- **Hook env consumer flip:** `session-sync.ts:218`, `codex-inbox-deliver.ts:158`, `auto-spawn.ts:83`, `freshness.ts:100`, `identity-inject.ts:21`, `dispatch-client.ts:246` (currently mislabeled — `agent_id: GENIE_AGENT_NAME`), `hooks/index.ts:267` — all flip to prefer `process.env.GENIE_AGENT_ID` and `getAgent(id)`. Name is fallback only.
- Delete `dedupeShadowRows` / `shadowKey` / `listForRender` / `listAgentsForRender` (agent-registry.ts:314, :347, :356, :1046) + `dedupShadowsForSend` (protocol-router.ts) once the write-side invariant prevents shadow creation. Two consumers live in agent-registry.ts (Worker layer + AgentIdentity layer) — both must go.
- CLI surface: `genie send --to <name>`, `genie agent show <name>`, `genie log <name>`, `genie msg <name>` resolve name → id at parse time, then operate on id only.
- Reference prior wish (`claude-resume-by-session-id`) explicitly: DECISIONS table enumerates what shipped, what regressed, what this closes.

### OUT

- Renaming `claude_session_id` to `session_id` or `resume_token`. Cosmetic; column name carries provider context honestly.
- Migration of historical archived rows (the 050/053 heal output stays as-is).
- Provider-agnostic resume abstraction beyond claude-code (codex/app-pty resume semantics out of scope).
- Removing `process.env.GENIE_AGENT_NAME` entirely. `audit_events.actor` and human-display labels still legitimately use the name.
- Changing the `(custom_name, team)` partial unique index — that composite stays as the canonical human-identity key.
- Deleting `dir:<name>` master row id shape. Master persistence is by design.
- JSONL recovery fallback (`defaultScanForSession` at executor-registry.ts:404) — JSONL files only know name, so name-keyed scan is the last-resort recovery path.
- `BUILTIN_ROLES` / `BUILTIN_COUNCIL_MEMBERS` code constants — symbolic names, not identity rows.
- Claude-Code-owned `~/.claude/teams/<team>/config.json` schema — `name` is display, `agentId` is `<name>@<team>` per CC's contract.
- `tmuxSessionName` / `tmux_session_name` — runtime/UI identifiers, never used for agent identity (verified team-manager.ts:333-336, agents.ts:829, protocol-router-spawn.ts:342).
- Staged 3-release deprecation. Internal infra; one release ships the whole thing (council precedent from prior wish, decision row 4).

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | `agents.id` is UUID OR `dir:<name>`, enforced by DB constraint. | The structural cause of recurring drift is that `agents.id` accepted three shapes (UUID, `dir:<name>`, bare-name) and `ON CONFLICT (id) DO UPDATE` upserted whichever shape arrived. New code paths reach for the easiest insert (name) and re-create shadows. A constraint is the only durable answer. |
| 2 | One canonical name → id resolver (`resolveAgentId`). | Every fuzzy filter is a re-implementation of the same three-tier match (`customName \|\| role \|\| id`). Five copies in five files; each one re-creates the divergence on the next refactor. One resolver, one place to change. |
| 3 | Delete `dedupeShadowRows` + `dedupShadowsForSend` + `listForRender`. | These exist solely because the write side creates shadows. Once Decision 1 closes the write side, the read-side band-aids must go too — leaving them invites operators to accept shadows as normal again. If they delete cleanly with green tests, the cleanup is real. |
| 4 | One release, no staged deprecation. | Council precedent from `claude-resume-by-session-id` (2026-04-14, decision row 4). Internal infrastructure, not external API. Dual-writing hides bugs. |
| 5 | Heal-not-wipe for legacy rows. | Migration 053 set this precedent. Operators can recover a quiesced row via `genie agent unpause`. Hard DELETE forecloses that. |
| 6 | `GENIE_AGENT_ID` is ALREADY propagated; the work is flipping consumers. | provider-adapters.ts:380 + :598 already set `env.GENIE_AGENT_ID = params.agentId`. The regression isn't missing propagation — it's that `session-sync.ts:218`, `codex-inbox-deliver.ts:158`, `auto-spawn.ts:83`, `freshness.ts:100`, `dispatch-client.ts:246`, `hooks/index.ts:267` all read `GENIE_AGENT_NAME` instead. Earlier wish drafts treated this as "add env"; trace investigation corrected to "flip consumers." |
| 7 | Keep JSONL recovery name-keyed. | Last-resort recovery scans `~/.claude/projects/<cwd>/*.jsonl` for `(teamName, agentName)` matches. The JSONL file is what `claude --resume <uuid>` actually replays from; the file body carries name, not id. The recovery path is rare and gated; name-keying here is intentional. |
| 8 | Reference the prior wish explicitly. | This is wish #2 on the same problem. Operators reading the diff need to see what shipped from #1 (47, 50, 53), what regressed (5 fuzzies, 2 dedupes, two-row spawn), and what this closes (write-side invariant + single resolver + FK lockdown + spawn collapse). Without the link, this looks redundant. |
| 9 | `findLiveWorkerFuzzy` → `findLiveWorker(agentId)` only. | Send-path fuzzy resolution is the last surface where name leaks deep into delivery. After CLI-boundary resolution, every downstream call is id-only; `findLiveWorker` becomes a 5-line `getAgent(id) + isPaneAlive` instead of a 60-line dedupe-and-filter. |
| 10 | DB constraint over application-side guard. | Council preference (architect): durable invariants live in the schema. App guards rot; CHECK constraints don't. |
| 11 | **FK every reference column to `agents.id`.** | Drift always lands where the schema doesn't enforce shape. `executors.agent_id` is FK-constrained — uniformly UUID-keyed in production. `mailbox.{from,to}_worker`, `team_chat.sender`, `teams.leader`, `agents.reports_to`, `agent_templates.id` are all TEXT no-FK — every one of them is mixed-shape today. SQL is the only enforcement that holds across refactors. |
| 12 | **Spawn writes ONE row, not two.** | The regression engine source: `findOrCreateAgent(name, team)` writes a UUID identity row AND `register({id: workerId})` writes a bare-name runtime row, both on every spawn (agent-registry.ts:271, agents.ts:643, agents.ts:2350). The bare-name INSERT's `ON CONFLICT (id) DO UPDATE` keeps the shadow alive even after dedup writes. Until this is removed, every read-side band-aid grows back from the spawn primitive. |

## Success Criteria

- [ ] `agents.id` accepts UUID-shaped values OR strings matching `^dir:[a-zA-Z0-9_-]+$`; bare-name inserts fail at the DB level. SQL test asserts the failure mode.
- [ ] FK lockdown: `mailbox.from_worker`, `mailbox.to_worker`, `team_chat.sender`, `teams.leader`, `agents.reports_to` are all FK to `agents.id`. `agent_templates` has UUID PK + unique `(name, team)` index. `teams.members` is UUID array. Pre-FK backfill runs inside the migration.
- [ ] Migration archives any extant bare-name rows discovered post-053 (heal-not-wipe — `state='archived'`, `auto_resume=false`). Audit event `legacy_barename_archived` emitted per row.
- [ ] **Spawn writes ONE row.** `register({id: workerId})` bare-name INSERT path removed (agent-registry.ts:271). Spawn calls only `findOrCreateAgent(name, team)` (UUID PK). `resolveSpawnIdentity` (agents.ts:2350) and `registerSpawnWorker` (agents.ts:643) updated. SQL audit: `SELECT COUNT(*) FROM agents WHERE id NOT LIKE 'dir:%' AND id !~ '^[0-9a-f-]{36}$'` returns 0 after a fresh spawn cycle.
- [ ] `resolveAgentId(nameOrId, team) → string | null` exists in `src/lib/agent-registry.ts`, accepts UUID/`dir:<name>`/bare-name/role/custom_name input, returns canonical id. Eight+ fuzzy filter sites collapsed to single calls.
- [ ] `rg "a\.customName === |a\.role === |w\.role === |w\.customName ===" repos/genie/src` returns zero matches outside `agent-registry.ts` (where the resolver lives) and tests.
- [ ] `dedupeShadowRows`, `shadowKey`, `listForRender` (agent-registry.ts) and `dedupShadowsForSend` (protocol-router.ts) DELETED. Call sites switched to `list()` directly.
- [ ] **Hook consumers prefer `GENIE_AGENT_ID`:** `session-sync.ts`, `codex-inbox-deliver.ts`, `auto-spawn.ts`, `freshness.ts`, `identity-inject.ts`, `dispatch-client.ts`, `hooks/index.ts` all read id from env first, name as fallback. `dispatch-client.ts:246` mislabel (`agent_id: GENIE_AGENT_NAME`) corrected.
- [ ] `findSpawnTemplate` accepts `(team, role)` only; `recipientId`-as-role match removed. `cleanupDeadWorkers`, `findKnownWorker`, `deliverViaNativeInbox`, `resolveRecipient` operate on id only.
- [ ] `turn-close.ts:144-146` ghost-executor fallback uses UUID lookup (no cross-shape compare against `executors.agent_id`).
- [ ] `genie send 'msg' --to engineer` still works (UX preserved). Resolution happens at CLI boundary; downstream calls receive an id.
- [ ] Post-merge monitoring task filed (NOT a merge-gate criterion): two-week audit confirms zero new bare-name agents.id rows; zero new `resume.missing_session` events tied to shadow pairs (filter by `details.reason`).
- [ ] All existing tests pass; new tests cover: (a) constraint blocking bare-name insert, (b) FK rejection of orphan references, (c) resolver fall-through tiers, (d) end-of-shadow assertion (`list().length === listForRender_disabled().length`), (e) hook consumer id-preference, (f) single-row spawn.
- [ ] `bun test` and `genie wish lint retire-session-names-id-only` both green.
- [ ] Manual smoke matrix: spawn → resume → send → recover → reboot-and-resume. Each gate verifies no name-fuzzy resolution path fired (instrument resolver to count + assert zero on hot paths).

## Execution Strategy

### Wave 1 (parallel — write-side foundation)

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | DB invariant + FK lockdown migration (agents.id CHECK + FK on mailbox/team_chat/teams/reports_to/agent_templates + legacy archive). |
| 2 | engineer | Single resolver `resolveAgentId(nameOrId, team)` in agent-registry.ts. |
| 3 | engineer | Spawn collapses to ONE row: remove `register({id: bare-name})` INSERT path; spawn writes only the UUID identity row. |

### Wave 2 (sequential — collapse read-side fuzzies)

| Group | Agent | Description |
|-------|-------|-------------|
| 4 | engineer | Replace 5 JS-side fuzzy filters with `resolveAgentId` calls. |
| 5 | engineer | Collapse `resolveAgentForRecover` 4-tier fallback into single resolver call. |
| 6 | engineer | Tighten `findSpawnTemplate` to `(team, role)` and `cleanupDeadWorkers` to id-only. |

### Wave 3 (sequential — delete band-aids)

| Group | Agent | Description |
|-------|-------|-------------|
| 7 | engineer | Flip ALL hook consumers (session-sync + codex-inbox-deliver + auto-spawn + freshness + identity-inject + dispatch-client + hooks/index.ts) to prefer GENIE_AGENT_ID; getAgentByName is fallback. |
| 8 | engineer | Delete `dedupeShadowRows`/`shadowKey`/`listForRender` + `dedupShadowsForSend`. |

### Wave 4 (sequential — validate + comment cleanup)

| Group | Agent | Description |
|-------|-------|-------------|
| 9 | qa | Full smoke matrix + instrumented resolver counter (asserts zero name-fuzzy fires on hot paths). |
| 10 | engineer | Replace provider-adapters.ts:84 historical block with one-line note pointing to this wish + migration X. |

## Execution Groups

### Group 1: DB invariant + FK lockdown migration

**Goal:** Make the schema enforce the entire identity invariant: `agents.id` shape constraint + FK on every reference column. Drift cannot land where the schema rejects it.

**Deliverables:**
1. New migration `src/db/migrations/061_agents_id_invariant_and_fk_lockdown.sql`. Three passes (idempotent, heal-not-wipe):
   - Pass A — backfill: for each TEXT no-FK column listed below, resolve the existing name → UUID via `(custom_name, team)` composite. Rows that don't resolve (orphans) get archived; their reference column gets nulled where allowed, or row gets archived where not.
   - Pass B — add CHECK constraint on `agents.id`: `id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR id LIKE 'dir:%'`.
   - Pass C — add FK constraints: `mailbox.from_worker → agents.id`, `mailbox.to_worker → agents.id`, `team_chat.sender → agents.id`, `teams.leader → agents.id`, `agents.reports_to → agents.id`. Convert `agent_templates.id TEXT PK` to UUID PK + new unique `(name, team)` index. Convert `teams.members JSONB` element shape to UUID array (validated via CHECK).
2. Migration test `src/db/migrations/061_agents_id_invariant_and_fk_lockdown.test.ts`. Asserts: (a) UUID + `dir:<name>` insert succeed, (b) bare-name insert rejected, (c) orphan FK insert rejected (e.g., `INSERT INTO mailbox (to_worker) VALUES ('not-an-agent')` fails), (d) backfill logic resolves a representative name reference correctly, (e) `legacy_barename_archived` audit event emitted per archived violator.

**Acceptance Criteria:**
- [ ] Test passes. Migration is idempotent (second run is a no-op).
- [ ] `psql -c "INSERT INTO agents (id) VALUES ('foo')"` errors on CHECK.
- [ ] `psql -c "INSERT INTO mailbox (...) VALUES (..., 'orphan-name', ...)"` errors on FK.
- [ ] Audit count of `legacy_barename_archived` reflects the pre-migration violator set (0 expected on this host today).

**Validation:**
```bash
cd repos/genie && bun test src/db/migrations/061_agents_id_invariant_and_fk_lockdown.test.ts
```

**depends-on:** none

---

### Group 2: Single name → id resolver

**Goal:** One canonical resolver in `agent-registry.ts` that accepts any human input (UUID, `dir:<name>`, bare-name, role, custom_name) and returns the agent id.

**Deliverables:**
1. Add `resolveAgentId(nameOrId: string, team?: string): Promise<string | null>` in `src/lib/agent-registry.ts`. Resolution order: exact id → `dir:<name>` → `(custom_name, team)` → role-fallback. Emits `audit_events.event_type='agent_resolved'` with the matched tier (for telemetry on which tier fired).
2. Unit tests in `src/lib/agent-registry.test.ts`: each tier hits, ambiguity returns null, missing returns null.
3. Instrumentation: counter exported `getAgentResolverCounters(): { uuid: n, dir: n, customName: n, role: n }` for Wave 4 smoke assertion.

**Acceptance Criteria:**
- [ ] `resolveAgentId` exported from agent-registry; type signature stable.
- [ ] Tier resolution order matches spec; ambiguity (multi-row custom_name) returns null with audit event.
- [ ] Tests cover all four tiers, plus team-scoping correctness.

**Validation:**
```bash
cd repos/genie && bun test src/lib/agent-registry.test.ts -t "resolveAgentId"
```

**depends-on:** none

---

### Group 3: Spawn writes ONE row

**Goal:** Eliminate the dual-row spawn pattern. `findOrCreateAgent` writes the UUID identity; the bare-name `register({id: workerId})` INSERT is removed entirely. Runtime fields move onto the UUID row or the existing `executors` table.

**Deliverables:**
1. Remove `register({id: workerId, …})` bare-name INSERT path in `src/lib/agent-registry.ts:271`. Replace `register()` callers with code that takes a UUID id (the one returned by `findOrCreateAgent`).
2. Update `src/term-commands/agents.ts:643 registerSpawnWorker` and `:2350 resolveSpawnIdentity` to operate on UUID + `custom_name` only. The `WHERE id = ${name}` lookup at :2350 becomes `WHERE custom_name = ${name} AND team = ${team}` via `getAgentByName` (and eventually `resolveAgentId`).
3. Audit `register()`'s upsert semantics: if `register()` is now ONLY called with UUIDs, the `ON CONFLICT (id) DO UPDATE` clause becomes a sane upsert (no shape collision possible). If any caller still passes a name, fail loudly at the type system level — prefer a renamed `registerWorkerRuntime(agentId: string, runtime: …)` so the contract is unmistakable.
4. New tests in `src/lib/__tests__/spawn-single-row.test.ts`: spawn an agent end-to-end, query `SELECT id, custom_name FROM agents WHERE custom_name = $1`, assert exactly one row with UUID id (no bare-name twin).

**Acceptance Criteria:**
- [ ] After a fresh spawn, `SELECT COUNT(*) FROM agents WHERE id NOT LIKE 'dir:%' AND id !~ '^[0-9a-f-]{36}$'` returns 0.
- [ ] No call site passes a non-UUID, non-`dir:` id to `register()` (verify via type system or test grep).
- [ ] Existing spawn smoke tests pass without modification.

**Validation:**
```bash
cd repos/genie && bun test src/lib/__tests__/spawn-single-row.test.ts src/lib/agent-registry.test.ts
```

**depends-on:** Group 1 (the constraint must land first or this group breaks legacy fixtures)

---

### Group 4: Replace JS-side fuzzy filters

**Goal:** Collapse five `a.customName === name || a.role === name || a.id === name` filters into single `resolveAgentId` calls.

**Deliverables:**
1. `src/term-commands/agent/show.ts:46` — replace `agents.filter(...)` with `await resolveAgentId(name, team)` then `getAgent(id)`.
2. `src/term-commands/agent/send.ts:73-74` — sender + recipient lookups use resolver.
3. `src/term-commands/log.ts:218` — replace exact-match closure with resolver.
4. `src/term-commands/msg.ts:546` — sender lookup uses resolver.
5. `src/hooks/handlers/codex-inbox-deliver.ts:102` — replace inline filter with resolver.
6. `src/lib/target-resolver.ts:259,267` — replace `customName === target` filter with resolver call.

**Acceptance Criteria:**
- [ ] `rg "customName === |\.role === |\.id === " src/term-commands src/hooks src/lib/target-resolver.ts` returns zero hits.
- [ ] Existing tests for show/send/log/msg/codex-inbox-deliver pass without modification (behavior preserved).

**Validation:**
```bash
cd repos/genie && bun test src/term-commands/agent src/term-commands/log.test.ts src/term-commands/msg.test.ts src/hooks/handlers/codex-inbox-deliver.test.ts
```

**depends-on:** Group 2

---

### Group 5: Collapse resolveAgentForRecover

**Goal:** The 4-tier `resolveAgentForRecover` fallback in `agents.ts:2963` becomes a single resolver call.

**Deliverables:**
1. Replace `src/term-commands/agents.ts:2963 resolveAgentForRecover(name)` body with `const id = await resolveAgentId(name, /* team */ undefined); if (!id) throw new RecoverAgentNotFoundError(name); return registry.get(id);`.
2. Keep `RecoverAgentNotFoundError` shape (operator-facing message stays the same).
3. Update tests in `src/term-commands/__tests__/agents.recover.test.ts` (or sibling) — no behavioral change expected; just verify the resolver path is taken.

**Acceptance Criteria:**
- [ ] `resolveAgentForRecover` is ≤10 lines, no SQL queries inline.
- [ ] All existing recover tests pass.

**Validation:**
```bash
cd repos/genie && bun test src/term-commands -t "recover"
```

**depends-on:** Group 2

---

### Group 6: Tighten spawn-side name confusion

**Goal:** `findSpawnTemplate` and `cleanupDeadWorkers` operate on identity (team+role for templates, id for workers) only.

**Deliverables:**
1. `src/lib/protocol-router.ts:240 findSpawnTemplate(worker, recipientId)` — drop the `recipientId` candidate; match on `(worker.team, worker.role)` exclusively. If no worker, return null and let the caller surface "unknown agent."
2. `src/lib/protocol-router.ts:364 cleanupDeadWorkers(recipientId, team)` — change signature to `(agentId: string)`; match on `w.id === agentId` only. Caller resolves at CLI boundary first.
3. Update `src/lib/protocol-router.ts:316 resolveResumeSessionId` to require `worker?.id` — drop the `\`dir:\${recipientId}\`` fallback.
4. Update `protocol-router.test.ts` and `protocol-router-spawn.test.ts` to assert the tightened contracts.

**Acceptance Criteria:**
- [ ] `findSpawnTemplate` signature is `(worker: Agent | null) → Template | null`.
- [ ] `cleanupDeadWorkers` signature is `(agentId: string) → void`.
- [ ] `resolveResumeSessionId` requires non-null worker.
- [ ] All protocol-router tests pass.

**Validation:**
```bash
cd repos/genie && bun test src/lib/protocol-router.test.ts src/lib/protocol-router-spawn.test.ts
```

**depends-on:** Group 2

---

### Group 7: Flip ALL hook consumers to prefer GENIE_AGENT_ID

**Goal:** Every hook consumer that resolves a row from env reads `GENIE_AGENT_ID` first and falls back to name only if id is unset (legacy/external invocations).

**Deliverables:**
1. `src/hooks/handlers/session-sync.ts:218` — `if (GENIE_AGENT_ID) await getAgent(GENIE_AGENT_ID) else await getAgentByName(agentName, teamName)`.
2. `src/hooks/handlers/codex-inbox-deliver.ts:158` — same pattern; remove the `keys.add(fallback)` bare-name mailbox key now that mailbox is FK-locked (Group 1).
3. `src/hooks/handlers/auto-spawn.ts:83` — `agents.find` matches by id; pre-resolve at hook entry.
4. `src/hooks/handlers/freshness.ts:100` — read id from env.
5. `src/hooks/handlers/identity-inject.ts:21-22` — id-preferred resolution.
6. `src/hooks/dispatch-client.ts:246` — fix the mislabel: `agent_id: process.env.GENIE_AGENT_ID ?? null` (was: `process.env.GENIE_AGENT_NAME`).
7. `src/hooks/index.ts:267` — `agentId = process.env.GENIE_AGENT_ID ?? 'unknown'`.
8. `src/lib/provider-adapters.ts:280` (`appendNativeTeamFlags`) — also export `env.GENIE_AGENT_ID = params.agentId` alongside `GENIE_AGENT_NAME`. Native-team spawn path is the third propagation site, currently name-only.
9. Tests across `src/hooks/handlers/__tests__/`: id-preference path covered for every handler.

**Acceptance Criteria:**
- [ ] All seven sites flip to id-first; native-team env path also exports `GENIE_AGENT_ID`.
- [ ] `dispatch-client.ts:246` uses `GENIE_AGENT_ID` (mislabel fixed).
- [ ] Smoke test: spawn agent, observe via instrumentation that `getAgent(id)` is the hot path (not `getAgentByName(name, team)`) on subsequent hooks.
- [ ] Existing name-fallback behavior preserved when `GENIE_AGENT_ID` is unset (legacy/external invocations).

**Validation:**
```bash
cd repos/genie && bun test src/hooks/handlers/__tests__/ src/hooks/__tests__/dispatch-client.test.ts
```

**depends-on:** Group 1 (FK lockdown removes the legacy bare-name mailbox key requirement)

---

### Group 8: Delete shadow dedupe band-aids

**Goal:** Remove `dedupeShadowRows`, `shadowKey`, `listForRender`, `listAgentsForRender`, and `dedupShadowsForSend` once Wave 1's invariant prevents shadow creation. Two consumers live in agent-registry.ts (Worker + AgentIdentity layers) — both must go.

**Deliverables:**
1. Delete `src/lib/agent-registry.ts:314 dedupeShadowRows`, `:347 shadowKey`, `:356 listForRender`, `:1046 listAgentsForRender`. Update call sites: `src/term-commands/agents.ts:3907` (workers list-render), TUI/observability consumers, `genie status` aggregator.
2. Delete `src/lib/protocol-router.ts:201 dedupShadowsForSend`; update `findLiveWorkerFuzzy` (now `findLiveWorker(agentId)`) to a direct id-keyed lookup.
3. Update tests: `src/lib/agent-registry.test.ts:914-1001` `listForRender / listAgentsForRender (bare-name shadow dedup)` block — replace dedup assertions with end-of-shadow assertion (`list().length === listAgents().length === expected`).
4. Search-and-replace verification: `rg "dedupeShadowRows|dedupShadowsForSend|listForRender|listAgentsForRender" src/` returns zero hits outside removed-callsite migration notes.

**Acceptance Criteria:**
- [ ] All four functions deleted.
- [ ] All call sites switched to `list()` / `getAgent(id)`.
- [ ] No shadow-pair creation reproducible in test runs (full spawn matrix).

**Validation:**
```bash
cd repos/genie && rg -q "dedupeShadowRows|dedupShadowsForSend|listForRender" src/ && exit 1 || echo "clean" && bun test src/lib/agent-registry.test.ts src/lib/protocol-router.test.ts
```

**depends-on:** Group 1, Group 6

---

### Group 9: QA — instrumented smoke matrix

**Goal:** End-to-end validation that the new architecture holds under realistic load: spawn → resume → send → recover → reboot. Resolver counters MUST show zero name-fuzzy fires on hot paths (only id and dir tiers permitted).

**Deliverables:**
1. New QA spec `src/__tests__/qa/retire-session-names-smoke.test.ts`. Steps:
   - Spawn 5 agents in a team.
   - Send messages between each pair.
   - Suspend, resume each.
   - Kill one agent's pane, verify auto-recover via JSONL fallback (this is the ONE permitted name-fuzzy fire — the recovery path).
   - Read `getAgentResolverCounters()`; assert `counters.customName === 0 && counters.role === 0` on hot paths (only `uuid` and `dir` tiers are permitted on send/resume hot paths).
2. Reboot smoke (manual): document the procedure in `.genie/wishes/retire-session-names-id-only/QA.md`.

**Acceptance Criteria:**
- [ ] Smoke test passes.
- [ ] Resolver counter assertion green on hot paths.
- [ ] Manual reboot smoke documented + executed (signed-off in Review Results).

**Validation:**
```bash
cd repos/genie && bun test src/__tests__/qa/retire-session-names-smoke.test.ts
```

**depends-on:** Group 4, Group 5, Group 6, Group 7, Group 8

---

### Group 10: Comment cleanup + wish closure

**Goal:** Remove stale historical commentary that referenced bugs this wish closes; replace with a one-line pointer to the relevant migration.

**Deliverables:**
1. `src/lib/provider-adapters.ts:84` — replace the multi-line "Group 21 fix: producing phantom rows and 14M `resume.missing_session` events" block with one line: `// See migration 061_agents_id_invariant_and_fk_lockdown + wish retire-session-names-id-only for the full retirement story.`
2. `.genie/wishes/retire-session-names-id-only/CALL-SITES.md` — list every file:line touched (for future archaeology).
3. Mark wish status `SHIPPED` and link the merged PR.

**Acceptance Criteria:**
- [ ] Comment block trimmed.
- [ ] CALL-SITES.md exists.
- [ ] WISH.md status flipped to SHIPPED.

**Validation:**
```bash
cd repos/genie && rg -c "14M.*resume.missing_session" src/ ; test $(rg -c "14M.*resume.missing_session" src/ 2>/dev/null | wc -l) -eq 0
```

**depends-on:** Group 9

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] **Functional — name UX preserved:** `genie send 'hi' --to engineer`, `genie agent show engineer`, `genie log engineer` all still work. Operators don't notice a UX change.
- [ ] **Functional — id paths work:** `genie agent show <UUID>`, `genie log <UUID>` work the same as the name forms.
- [ ] **Integration — resume continuity:** spawn engineer, capture session UUID via `genie events`, kill pane, `genie resume engineer` → new executor row, same session UUID observed in provider, conversation history present.
- [ ] **Integration — session-sync id-preference:** spawn agent, observe `getAgent` (not `getAgentByName`) is the hot path on subsequent hooks (visible via instrumentation).
- [ ] **Regression — existing tests:** `bun test` green.
- [ ] **Regression — no shadow rows:** full smoke matrix run; `psql -c "SELECT id FROM agents WHERE id !~ '^[0-9a-f-]+$' AND id NOT LIKE 'dir:%'"` returns zero rows.
- [ ] **Regression — resume.missing_session:** 24h post-merge: zero new events in audit_events tied to shadow-pair patterns. Filter by `details.reason='no_executor'` to be sure baseline is unchanged.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Operators rely on undocumented name-as-id calls (e.g., `genie show engineer-5b6d`). | Medium | Wave 2 keeps name input working at CLI boundary — only deep paths get tightened. Operator UX preserved. |
| The DB CHECK constraint blocks a legitimate insert path we missed. | Medium | Pre-deploy test in Group 1 exercises every spawn path against the constraint. CI fails loudly if any path is missed. NO runtime kill-switch — an env-var bypass is the exact regression vector this wish exists to close. If a missed path emerges in production, revert the migration; do not bypass it. |
| Deleting `listForRender` regresses a TUI rendering path. | Low | Group 8 audit grep ensures every call site is migrated. TUI tests (`src/tui/db.ts`) cover the read path. |
| Two resolvers exist briefly during Wave 1 → 2 transition. | Low | All Wave 2 work is sequential after Wave 1; no shipped state has both. |
| `dir:<name>` master rows can still shadow if a UUID peer with `custom_name=<name>` exists in same team. | Medium | Migration 053 guardrail handles this; smoke matrix asserts no shadow creation. If a regression sneaks in, the `agents.id !~ UUID OR dir:%` constraint plus the resolver would still keep the read path consistent. |
| 14M `resume.missing_session` regression risk if a new write path bypasses the constraint. | High | Migration 058's CHECK is the brick wall; it MUST hold. Smoke test 058 asserts the failure mode explicitly. |

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
NEW:
  src/db/migrations/061_agents_id_invariant_and_fk_lockdown.sql
  src/db/migrations/061_agents_id_invariant_and_fk_lockdown.test.ts
  src/lib/__tests__/spawn-single-row.test.ts
  src/__tests__/qa/retire-session-names-smoke.test.ts
  .genie/wishes/retire-session-names-id-only/CALL-SITES.md
  .genie/wishes/retire-session-names-id-only/QA.md

MODIFY:
  src/lib/agent-registry.ts                              # add resolveAgentId; remove register() bare-name path; delete dedupeShadowRows/shadowKey/listForRender
  src/lib/protocol-router.ts                             # delete dedupShadowsForSend; tighten findSpawnTemplate/cleanupDeadWorkers/resolveResumeSessionId/findKnownWorker/deliverViaNativeInbox/resolveRecipient
  src/lib/protocol-router-spawn.ts                       # spawn writes single UUID row
  src/lib/target-resolver.ts                             # use resolveAgentId (kill customName === target filters)
  src/lib/team-manager.ts                                # killWorkersByName / leader / members → UUID-keyed
  src/lib/turn-close.ts                                  # ghost-executor fallback by UUID, not bare name
  src/lib/event-router.ts                                # reports_to walk by UUID FK
  src/term-commands/agents.ts                            # collapse resolveSpawnIdentity / registerSpawnWorker / resolveAgentForRecover / resolveWorkerByName
  src/term-commands/agent/show.ts                        # use resolveAgentId
  src/term-commands/agent/send.ts                        # use resolveAgentId for sender + recipient
  src/term-commands/log.ts                               # use resolveAgentId
  src/term-commands/msg.ts                               # use resolveAgentId
  src/hooks/handlers/session-sync.ts                     # prefer GENIE_AGENT_ID
  src/hooks/handlers/codex-inbox-deliver.ts              # prefer GENIE_AGENT_ID; remove bare-name mailbox key fallback
  src/hooks/handlers/auto-spawn.ts                       # id-keyed agent.find
  src/hooks/handlers/freshness.ts                        # id-keyed lookup
  src/hooks/handlers/identity-inject.ts                  # id-keyed lookup
  src/hooks/dispatch-client.ts                           # fix mislabel: agent_id should be UUID, not name
  src/hooks/index.ts                                     # agentId from GENIE_AGENT_ID
  src/lib/provider-adapters.ts                           # trim historical comment block (env exports already correct at :380, :598)
  src/tui/db.ts                                          # use list() instead of listForRender()

REFERENCE:
  .genie/wishes/claude-resume-by-session-id/WISH.md      # prior wish (DRAFT, partially implemented) — this wish closes the gaps
  src/db/migrations/005_pg_state.sql                     # original TEXT-PK + no-FK schema (the regression substrate)
  src/db/migrations/047_drop_agents_claude_session_id.sql # earlier cleanup
  src/db/migrations/050_archive_legacy_identity_rows.sql  # earlier cleanup
  src/db/migrations/053_master_backfill_and_shadow_cleanup.sql # earlier cleanup
```
