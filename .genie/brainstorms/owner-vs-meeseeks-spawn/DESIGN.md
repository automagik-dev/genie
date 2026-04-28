# Design: Master-Aware Team Spawn + Recovery Hardening (`.5`)

| Field | Value |
|-------|-------|
| **Slug** | `owner-vs-meeseeks-spawn` (rename to `master-aware-spawn` if shipping) |
| **Date** | 2026-04-26 |
| **WRS** | 100/100 |
| **Origin** | Power-outage recovery thread (2026-04-25 outage → 2026-04-26 healing). Felipe lost ability to start `genie serve`, lost view of recoverable sessions, and lost his email-agent's 10K-message context to a fresh-UUID spawn. |

## Problem

The genie team-spawn code path doesn't consult `shouldResume` when the recipient agent has no live worker row but DOES have a `dir:<name>` directory entry. Result: every "team-lead hires <master-agent>" invocation generates `--session-id <new>` and destroys the master's persistent conversation history.

The taxonomy already exists in the schema — it's just not being read by the one call site that needs it.

## Scope

### IN
- **Primary fix:** wire `resolveResumeSessionId` in `src/lib/protocol-router.ts` to fall back to `dir:<recipientId>` when `worker == null`. Reuses the existing chokepoint (`shouldResume`) and existing `--resume` plumbing in `spawnWorkerFromTemplate`. ~3 line change.
- **Recovery verb:** ship `genie agent recover <name>` that runs the manual surgery I performed tonight (flip `auto_resume`, clear stale `spawning` executor, anchor session UUID, resume).
- **Self-healing partition rotation:** `genie_runtime_events_maintain_partitions` PG function detects "rows in default partition for date X" and runs the DETACH/CREATE/INSERT/DROP sequence automatically.
- **Status surface for recoverables:** `genie status` shows "session on disk" when chokepoint locates a UUID even with `auto_resume=false`, with the `genie agent recover` hint inline.
- **Watchdog autoFix non-interactive guard:** if `!process.stdin.isTTY && !sudoPasswordless`, return `refused` instead of blocking on `sudo`.
- **`--emergency` flag:** replace test-only `GENIE_SKIP_PRECONDITIONS=1` with a documented operator escape that emits an audit event.
- **Reconciler heal-not-wipe:** when a reconciler detects PG↔disk team mismatch on a `dir:` row, update the column instead of deleting the row.
- **jsonl preservation:** when `claude --resume` exits without a clean closure, preserve the `.bak` and refuse to corrupt the active jsonl with state-marker tail.
- **Stale-`spawning` reconciler:** TTL-based reaper for executors stuck in `state='spawning'` for >5min, with `close_reason='born_stuck'`.
- **JSONL fallback identity match relaxation:** allow `agentName`-only match when `team` differs (with audit event flagging the relaxation), to support agents whose `team` changed between session capture and now.
- **Doctor partition_count audit:** reconcile the `13` reported vs `10` in `pg_inherits`. One-line audit.

### OUT
- New `agents.role_class` enum or any schema migration to encode Master/Buddy/Member/Ephemeral. The existing primitives (`kind`, `reports_to`, `team`, `task_id`/`wish_slug`, `repo_path`, `dir:` id prefix) already discriminate.
- TUI redesign for visual class distinction (separate brainstorm).
- Long-form lifecycle redesign for v5 (e.g., partial-checkpoint resume mid-task).
- Migration tooling for legacy multi-UUID owner agents (those whose history fragmented across many session UUIDs).
- Auto-compaction (`.trimmed.jsonl`) deep-dive — flagged as documentation backlog, not in this wish.

## Approach

### 1. Spawn-path patch (the actual lifecycle fix)

`src/lib/protocol-router.ts:resolveResumeSessionId` — current early-return on `worker==null` skips the chokepoint. Patch:

```typescript
async function resolveResumeSessionId(
  worker: registry.Agent | null,
  template: registry.WorkerTemplate,
  recipientId: string,
): Promise<string | undefined> {
  if (template.provider !== 'claude') return undefined;

  // Master agents ('dir:<name>' rows) won't have a live worker after a
  // power-outage / restart, but they DO have a directory entry whose
  // current_executor anchors a recoverable session UUID. Probe the
  // chokepoint via the directory id when no live worker exists, so
  // team-lead "hires" honor the master's persistent session instead of
  // forking a fresh UUID and orphaning the conversation history.
  const agentIdToProbe = worker?.id ?? `dir:${recipientId}`;
  const decision = await shouldResume(agentIdToProbe);

  if (worker && await isExecutorResumable(worker)) {
    if (!decision.sessionId) throw new MissingResumeSessionError(worker.id, recipientId);
  }
  return decision.sessionId;
}
```

Why this is sufficient:
- **Master** (e.g., `email`, `genie`, `felipe`) → has `dir:<name>` row → chokepoint returns its session UUID → `--resume` honored.
- **Member (hired)** without dir-row but with bare-name agent row → `worker.id` path unchanged.
- **Buddy** spawned by master with `reports_to=<master.id>` → either has its own runtime row (covered by `worker.id` path) or fresh spawn (intended behavior).
- **Ephemeral** (`task_id`/`wish_slug` set) → `dir:<recipientId>` won't exist → `unknown_agent` reason → fresh spawn (intended behavior).

No false positives because Master is the only class with a `dir:<name>` row.

### 2. Recovery verb (`genie agent recover <name>`)

Encapsulates the surgery I did tonight:

```bash
genie agent recover email
  → assert agent row exists in PG (by name or dir:name)
  → UPDATE agents SET auto_resume = true WHERE id = <agentId>
  → UPDATE executors SET state = 'terminated', closed_at = now(),
      close_reason = 'recovery_anchor'
    WHERE agent_id = <agentId> AND state = 'spawning' AND ended_at IS NULL
  → If no current_executor with claude_session_id, prompt for jsonl scan
    (or auto-scan the agent's repo_path for the most recent jsonl whose
     agentName/teamName match — reuse the existing fallback)
  → genie agent resume <name>   (uses the patched resolveResumeSessionId)
  → Print pane id + tmux attach hint
```

Surfaces all the steps tonight required as one verb. Idempotent.

### 3. Partition self-heal in `maintain_partitions`

`src/db/migrations/<NNN>_partition_self_heal.sql` — replace `genie_runtime_events_maintain_partitions(retention_days, forward_days)` with a version that:

```sql
FOR i IN 0..forward_days LOOP
  target_date := CURRENT_DATE + i;
  -- detect overflow: rows in default partition for target_date
  IF EXISTS (
    SELECT 1 FROM genie_runtime_events_default
    WHERE created_at >= target_date::TIMESTAMPTZ
      AND created_at <  (target_date + 1)::TIMESTAMPTZ
  ) THEN
    -- run the surgery I did manually tonight (DETACH/RENAME/CREATE/INSERT/DROP)
    -- inside an explicit serializable transaction
    PERFORM genie_runtime_events_self_heal_default_overflow(target_date);
  END IF;
  PERFORM genie_runtime_events_create_partition(target_date);
END LOOP;
```

The `_self_heal_default_overflow` helper does the surgery I executed by hand:
1. `ALTER TABLE genie_runtime_events DETACH PARTITION genie_runtime_events_default`
2. Rename existing default to `_old_default`
3. Create empty new default
4. Create the missing daily partitions
5. `INSERT INTO genie_runtime_events OVERRIDING SYSTEM VALUE SELECT * FROM _old_default`
6. `DROP TABLE _old_default`

All inside one transaction. Self-healing.

### 4. Status surface for recoverables

`src/genie-commands/status.ts` (or wherever the status renderer lives) — for each agent in the STUCK section, also call `getResumeSessionId` (or the chokepoint) and surface:

```
[p] email        57635c8b last:24h ago    auto_resume_disabled (RECOVERABLE)
   → genie agent recover email  # session on disk, jsonl 10422 lines
```

Reuses the existing chokepoint output. Just renders the `sessionId` field that `shouldResume` already returns even when `resume=false`.

### 5. Watchdog non-interactive guard

`src/term-commands/serve/ensure-ready.ts:checkWatchdog` (or its installer):

```typescript
async function defaultInstallWatchdog(): Promise<WatchdogInstallResult> {
  if (!process.stdin.isTTY && !await isSudoPasswordless()) {
    throw new Error('autoFix: non-interactive context, sudo would prompt — refusing to block boot');
  }
  // existing install logic
}
```

`isSudoPasswordless` runs `sudo -n true` with a 1s timeout. If non-interactive AND not passwordless, throw — caught by existing `try/catch` in `checkWatchdog` which surfaces as `refused`.

### 6. `--emergency` flag

`src/term-commands/serve.ts:runStartPreconditions`:

```typescript
async function runStartPreconditions(autoFix: boolean, emergency: boolean): Promise<void> {
  if (emergency) {
    console.warn('genie serve start: --emergency flag set — preconditions bypassed');
    await recordAuditEvent('serve', 'preconditions', 'serve.precondition.bypassed', 'cli', {
      reason: 'emergency_flag',
    });
    return;
  }
  if (process.env.GENIE_SKIP_PRECONDITIONS === '1') {
    console.warn('GENIE_SKIP_PRECONDITIONS=1: this env var is test-only. Use --emergency in production.');
    return;
  }
  // existing logic
}
```

Surface the emergency in `genie doctor` until cleared (after a clean boot).

### 7. Reconciler heal-not-wipe

Locate the code path that hard-deleted `dir:email` between resume.succeeded and now (audit-events trace). Likely a reconciler in `src/lib/reconcile-stale-spawns.ts` or similar that DELETEd on team mismatch. Replace DELETE with UPDATE — heal the team column from disk source of truth.

Specific guardrail: never DELETE a row where `kind='permanent'` and `repo_path` points to an existing directory. Those rows MUST be healed, not wiped.

### 8. JSONL preservation

`src/lib/providers/claude-code.ts` — when `claude --resume` exits non-cleanly:

1. Detect via wrapper script that the process died without writing a clean closure marker.
2. Before any next resume, compare `<uuid>.jsonl` tail to the most recent `.bak`. If the active file's last 10 lines are state markers (`last-prompt`, `custom-title`, `agent-name`, `permission-mode`, `pr-link`) without subsequent conversation entries, assume corruption and prefer `.bak`.
3. Also: hold a session-write lock (advisory PG lock keyed on session UUID) so two `--resume` processes can't race on the same jsonl.

### 9. Stale-`spawning` reconciler

`src/lib/reconcile-stale-spawns.ts` — add a TTL pass:

```typescript
const STALE_SPAWNING_TTL_MIN = 5;
await sql`
  UPDATE executors
  SET state = 'terminated',
      ended_at = now(),
      closed_at = now(),
      close_reason = 'born_stuck'
  WHERE state = 'spawning'
    AND started_at < now() - interval '${STALE_SPAWNING_TTL_MIN} minutes'
    AND claude_session_id IS NULL
`;
```

Critical: only kill `spawning` executors that NEVER acquired a claude_session_id. Preserve those that did (they're alive, just not yet promoted to running).

### 10. JSONL fallback identity match relaxation

`src/lib/executor-registry.ts:defaultScanForSession` — current strict match `(teamName, agentName)`. Relax to:

```typescript
for (const candidate of sorted) {
  const { teamName, agentName } = await readJsonlIdentity(candidate.full);
  if (agentName !== identity.customName) continue;
  if (teamName !== identity.team) {
    // log audit event flagging team mismatch — recovery anyway because
    // agentName + repo_path + dir:<name> uniqueness is sufficient identity
    await recordAuditEvent('agent', identity.customName, 'resume.recovered_via_jsonl_team_mismatch', 'cli', {
      jsonlTeam: teamName,
      currentTeam: identity.team,
    });
  }
  return candidate.name.replace(/\.jsonl$/, '');
}
```

Tonight's email scenario: jsonl had `teamName='genie'`, agent had `team='felipe'` (per agent.yaml). Strict match refused → I had to bypass with manual executor INSERT. Relaxation lets the recovery work automatically.

### 11. Doctor partition_count audit

`src/genie-commands/observability-health.ts` — partition_count likely includes archived and legacy partitions. Either filter to active dailies + default OR rename the field to `partition_count_total` and add `partition_count_active` for clarity.

## Decisions

| Decision | Rationale |
|----------|-----------|
| **No new schema column for Master/Buddy/Member/Ephemeral** | The existing primitives (`kind`, `reports_to`, `team`, `task_id`/`wish_slug`, `repo_path`, `dir:` id prefix) already discriminate. Adding a `role_class` enum would be redundant and create dual-source-of-truth risk. |
| **`dir:<name>` lookup as the Master-recovery bridge** | Masters are exactly the rows with `id LIKE 'dir:%'` that have a workspace `repo_path`. The chokepoint already returns sessions for them. The team-spawn router just needs to ASK. |
| **Self-heal in PG function, not in autoFix orchestrator** | Partition surgery should be atomic (single transaction) and idempotent. Living inside `genie_runtime_events_maintain_partitions` keeps it transactional and reusable from any caller, not just `ensureServeReady`. |
| **`--emergency` over docs-only `GENIE_SKIP_PRECONDITIONS`** | Production needs a documented escape. Env var hides intent in shell history; flag puts it in command-line and audit log. |
| **Heal-not-wipe in reconcilers, gated on `kind='permanent'`** | Master agents own irreplaceable identity. Wholesale deletion of a Master row is a data-loss bug. Other rows can still be deleted; the guardrail scopes to permanence. |
| **JSONL fallback relaxation with audit-event-on-mismatch** | Strict match was correct security default but produced false-negative recoveries when team membership history changed. Audit event preserves traceability. |
| **One wish, multi-wave delivery** | All 11 items are recovery-hardening — same theme, same review surface. Wave them in PR (chokepoint patch + recover verb in wave 1; partition self-heal + status surface in wave 2; reconciler heal + jsonl preservation in wave 3). Atomic conceptual ship. |

## Risks & Assumptions

| Risk | Severity | Mitigation |
|------|----------|------------|
| `dir:<recipientId>` lookup might match an archived/orphan dir row | Medium | `shouldResume` already checks `state != 'archived'` implicitly via the join; add an explicit guard if not. Test: ensure recovery only fires for non-archived `dir:` rows. |
| Reconciler heal-not-wipe still wipes when it CAN'T heal (unparseable yaml, permission denied) | Medium | Fall back to "mark inconsistent + alert" rather than DELETE. Surface via `genie doctor`. |
| JSONL fallback relaxation could attach wrong session if two agents share `agentName` across teams | Low | The relaxation requires `agentName + repo_path` to match. `repo_path` is per-agent and unique. The strict-team check was a defensive layer that's not load-bearing once `repo_path` is verified. |
| Stale-spawning reaper kills a real spawn that's just slow | Low | Only acts on `claude_session_id IS NULL` — a real spawn writes its session UUID quickly (~1-2s after pane creation). 5-minute TTL is generous. |
| `maintain_partitions` self-heal under concurrent writes | Medium | Wrap surgery in an advisory lock + serializable transaction. Concurrent inserts to default during surgery either get blocked or roll back; existing PG semantics. |
| Recovery verb runs in non-interactive context with confirmation prompts | Low | `--yes` flag for unattended use; default to interactive confirm. |

## Success Criteria

- [ ] `genie agent resume email` (after killing felipe team-lead's auto-spawn-fresh) resumes with `--resume 57635c8b…`, not `--session-id <new>`. Verifiable via `ps -ef | grep --resume`.
- [ ] When the felipe team-lead hires email, the spawn cmd emits `--resume <existing-uuid>`, not `--session-id <new>`. Verifiable via the audit-events `agent.boot_pass.eager_invoked` event payload.
- [ ] `genie agent recover <name>` flips `auto_resume`, terminates stale `spawning` executors, and resumes — all in one command.
- [ ] `genie_runtime_events_maintain_partitions(2, 30)` succeeds when the default partition has rows for date X, instead of erroring with "constraint violation".
- [ ] `genie status` shows recoverable sessions inline with attach hint.
- [ ] Watchdog precondition in `--no-fix` mode never hangs in non-interactive context (returns `refused` within 2s).
- [ ] `genie serve start --emergency` boots and emits `serve.precondition.bypassed` audit event; same boot without flag respects preconditions.
- [ ] No reconciler can DELETE an agents row with `kind='permanent' AND repo_path != ''`. Add unit test that asserts.
- [ ] Stale-spawning reconciler kills `spawning` executors with `claude_session_id IS NULL` after 5 minutes; preserves those with a session UUID.
- [ ] JSONL fallback finds a session when `agentName` matches but `teamName` differs; emits `resume.recovered_via_jsonl_team_mismatch` audit event.
- [ ] `genie doctor` partition_count matches `pg_inherits` count or is renamed for clarity.

## Touch points (for /wish breakdown)

| File | Change |
|------|--------|
| `src/lib/protocol-router.ts:257` | `resolveResumeSessionId` dir-lookup fallback (item 1) |
| `src/term-commands/agents.ts` | new `recover` subcommand (item 2) |
| `src/db/migrations/<NNN>_partition_self_heal.sql` | self-heal PG functions (item 3) |
| `src/genie-commands/status.ts` (or `src/genie-commands/derived-signals/*`) | recoverable-session inline render (item 4) |
| `src/term-commands/serve/ensure-ready.ts:checkWatchdog` | non-interactive guard (item 5) |
| `src/term-commands/serve.ts:runStartPreconditions` | `--emergency` flag (item 6) |
| `src/lib/reconcile-stale-spawns.ts` (or wherever the dir-row reconciler lives) | heal-not-wipe + permanent guardrail (item 7) |
| `src/lib/providers/claude-code.ts` + new helper | jsonl preservation + tail check (item 8) |
| `src/lib/reconcile-stale-spawns.ts` | stale-spawning reaper (item 9) |
| `src/lib/executor-registry.ts:defaultScanForSession` | identity-match relaxation (item 10) |
| `src/genie-commands/observability-health.ts` | partition_count audit (item 11) |

## Wave plan

- **Wave 1 (CRITICAL):** items 1, 2, 7. The team-spawn fix + recovery verb + heal-not-wipe guardrail. These three together close the "Felipe loses Master agent on reboot" loop.
- **Wave 2 (HIGH):** items 3, 4, 8, 10. Partition self-heal, status surface, jsonl preservation, fallback relaxation. Improves the *automatic* resilience.
- **Wave 3 (MED/LOW):** items 5, 6, 9, 11. Watchdog guard, `--emergency` flag, stale-spawning reaper, doctor audit. Polish + operator UX.

Each wave is a separate PR; all three on dev → main for `.5`.

## Notes

- This brainstorm explicitly **does not** propose a `role_class` column or any schema migration for the Master/Buddy/Member/Ephemeral taxonomy. Felipe's review confirmed: legos exist, just need connecting.
- The taxonomy is captured here for vocabulary alignment — useful for future docs and for `genie status` rendering — but not for runtime discrimination beyond what `kind`+`reports_to`+`team`+`task_id`+`repo_path`+`dir:` prefix already provide.
