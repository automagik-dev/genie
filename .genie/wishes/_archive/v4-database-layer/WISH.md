# Wish: v4 Stability — Database Layer Fixes

| Field | Value |
|-------|-------|
| **Status** | SHIPPED — PR #954 (v4 Stability Sprint, 2026-04-02) |
| **Slug** | `v4-database-layer` |
| **Date** | 2026-03-31 |
| **Design** | _Design not recovered — this wish pre-dates the brainstorm-commit convention (see #1132)._ |

## Summary
Fix 2 P0 SQL injection vulnerabilities and 3 P1 database reliability issues. The import command accepts user-supplied JSON with unvalidated table names passed directly to `sql.unsafe()`. The connection pool can exhaust under load. Data tables grow unbounded with no retention. Database restore is non-atomic.

## Scope
### IN
- Fix SQL injection in `import.ts` — validate table names against whitelist (P0)
- Fix SQL injection in `db-backup.ts` — use `current_database()` instead of interpolated DB_NAME (P0)
- Add retention policies for unbounded tables: `audit_events`, `heartbeats`, `machine_snapshots`, `genie_runtime_events` (P1)
- Fix connection pool error recovery — force fresh connection on migration/seed failure (P1)
- Fix migration file loading to use single deterministic directory (P1)

### OUT
- Database restore atomicity (P1 — complex, needs separate design for temp-schema swap)
- Health check timeout precision (P2)
- Composite key N+1 performance in import (P2)

## Decisions
| Decision | Rationale |
|----------|-----------|
| Use `GROUP_TABLES` constant from `export-format.ts` as whitelist | Already exists as the canonical table list. Flatten with `Object.values(GROUP_TABLES).flat()` and validate against it. No runtime query needed. |
| `current_database()` over string interpolation | Postgres-native, cannot be injected |
| 7-day retention for heartbeats, 30-day for audit_events | Balances debugging needs vs storage growth |
| Uncomment existing cleanup SQL + add cron | The SQL already exists in migrations, just commented out |

## Success Criteria
- [ ] `import.ts` rejects table names not in the schema whitelist
- [ ] `db-backup.ts` uses no string-interpolated SQL identifiers
- [ ] Retention policies are active for all 4 unbounded tables
- [ ] Pool recovers cleanly from partial migration failure
- [ ] Migration files load from exactly one directory per environment
- [ ] `bun test src/term-commands/import.test.ts` passes (add injection test)
- [ ] `bun test src/lib/db.test.ts` passes

## Execution Strategy

### Wave 1 (parallel — all independent)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Fix SQL injection (import + backup) |
| 2 | engineer | Add retention policies + fix pool recovery + migration loading |

### Wave 2
| Group | Agent | Description |
|-------|-------|-------------|
| review | reviewer | Review both groups |

## Execution Groups

### Group 1: SQL Injection Fixes
**Goal:** Eliminate SQL injection vectors.
**Deliverables:**
1. Import `GROUP_TABLES` from `export-format.ts`, flatten to `VALID_TABLES = new Set(Object.values(GROUP_TABLES).flat())`. Add `assertValidTable(name: string)` that throws if not in set.
2. Call `assertValidTable(table)` before every `sql.unsafe()` call in `import.ts` (lines 59, 69, 131, 132, 140, 149)
3. In `db-backup.ts`: replace `'${DB_NAME}'` string interpolation in SQL strings (lines 81, 117) with `current_database()`. For CLI commands (lines 127, 136), use `--dbname` flag or env var `PGDATABASE` instead of interpolating into shell commands.
4. Add test: import with malicious table name in JSON → rejected with error

**Acceptance Criteria:**
- [ ] `import.ts` throws on table name not in whitelist
- [ ] `db-backup.ts` has zero string-interpolated SQL identifiers
- [ ] Test proves injection attempt is blocked

**Validation:**
```bash
bun test src/term-commands/import.test.ts
grep -c "'\${DB_NAME}'" src/lib/db-backup.ts  # should be 0
```

**depends-on:** none

---

### Group 2: Retention + Pool + Migrations
**Goal:** Prevent unbounded growth and fix pool recovery.
**Deliverables:**
1. Create migration `0XX_retention.sql` that adds scheduled cleanup:
   - `DELETE FROM heartbeats WHERE created_at < now() - interval '7 days'`
   - `DELETE FROM machine_snapshots WHERE created_at < now() - interval '30 days'`
   - `DELETE FROM audit_events WHERE entity_type LIKE 'otel_%' AND created_at < now() - interval '30 days'`
   - `DELETE FROM genie_runtime_events WHERE created_at < now() - interval '14 days'`
2. Add retention run on `getConnection()` startup: execute retention DELETE once per process (guard with module-level `let retentionRan = false`). Run AFTER migrations succeed. If retention DELETE fails, log warning and continue — never block startup.
3. Fix `db.ts:420-439` error recovery: set both `sqlClient = null` AND `activePort = null` to force full reconnect on next `getConnection()` call. Verify no stale reference is cached by callers.
4. Verify `db-migrations.ts:60-90` migration directory resolution — if `import.meta.dir` is already the single source, mark as no-op. If multiple candidates exist, simplify to single path.

**Acceptance Criteria:**
- [ ] Old records are pruned on startup
- [ ] Migration failure leaves system in recoverable state (next call reconnects)
- [ ] Migrations load from deterministic single directory

**Validation:**
```bash
bun test src/lib/db.test.ts
```

**depends-on:** none

---

## Files to Create/Modify

```
src/term-commands/import.ts
src/lib/db-backup.ts
src/lib/db.ts
src/lib/db-migrations.ts
src/db/migrations/0XX_retention.sql (new)
src/term-commands/import.test.ts (new tests)
```
