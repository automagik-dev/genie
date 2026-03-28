# Wish: Test Schema Isolation — Stop Polluting Production PG

| Field | Value |
|-------|-------|
| **Status** | SHIPPED |
| **Slug** | `test-schema-isolation` |
| **Date** | 2026-03-24 |

## Summary

Tests write directly to the production genie PG database and never clean up. We just deleted 46k stale tasks and 2.9k test messages. Fix this by isolating tests into ephemeral schemas that auto-destroy on teardown.

## Scope

### IN
- Create test helper that provisions ephemeral PG schema per test suite
- Auto-cleanup on afterAll (DROP SCHEMA CASCADE)
- Update existing test files to use the isolated connection
- Add CI check that production tables have zero `/tmp/%` rows after test run

### OUT
- Migrating to a separate PG instance (too heavy — schema isolation is sufficient)
- Changing the migration system itself
- Fixing existing test data (already cleaned manually)

## Decisions

| Decision | Rationale |
|----------|-----------|
| Schema-per-suite, not per-test | Per-test is too slow (migration overhead). Per-suite balances isolation vs speed |
| DROP CASCADE on teardown | Nuclear cleanup — guaranteed no leaks |
| CI guard as safety net | Even if a test leaks, CI catches it before merge |

## Success Criteria

- [ ] Test helper exists: `getTestConnection()` returns an isolated PG connection
- [ ] All test files using `getConnection()` switched to `getTestConnection()`
- [ ] `bun test` leaves zero new rows in production `public.tasks` and `public.messages`
- [ ] CI check validates no test artifacts in production schema
- [ ] All 1137+ tests still pass

## Execution Strategy

### Wave 1 (sequential)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Create test DB helper with schema isolation + teardown |
| 2 | engineer | Migrate all test files to use isolated connection |
| 3 | reviewer | Verify zero leaks after full test run |

## Execution Groups

### Group 1: Test DB Helper

**Goal:** Create a test utility that gives each test suite its own PG schema.

**Deliverables:**
1. New file `src/lib/test-db.ts`:
   ```typescript
   export async function getTestConnection(): Promise<{sql: Sql, cleanup: () => Promise<void>}> {
     const schema = 'test_' + process.pid + '_' + Date.now();
     const sql = await getConnection();
     await sql`CREATE SCHEMA ${sql(schema)}`;
     await sql`SET search_path TO ${sql(schema)}, public`;
     await runMigrations(sql); // apply schema to test schema
     return {
       sql,
       cleanup: async () => {
         await sql`DROP SCHEMA IF EXISTS ${sql(schema)} CASCADE`;
       }
     };
   }
   ```
2. Export from test utilities
3. Document usage pattern in a code comment

**Acceptance Criteria:**
- [ ] `getTestConnection()` creates a unique schema
- [ ] `cleanup()` drops the schema and all its data
- [ ] Multiple test suites can run in parallel (unique schema names)

**Validation:**
```bash
bun test src/lib/test-db.test.ts
```

**depends-on:** none

---

### Group 2: Migrate Test Files

**Goal:** Update all test files that write to PG to use `getTestConnection()`.

**Deliverables:**
1. Find all test files that import `getConnection` or write to PG:
   ```bash
   grep -rl "getConnection\|from.*db" src/**/*.test.ts
   ```
2. Replace with `getTestConnection()` + add `afterAll(cleanup)`
3. Ensure all tests still pass

**Acceptance Criteria:**
- [ ] No test file imports `getConnection` for write operations
- [ ] All test suites call `cleanup()` in afterAll
- [ ] `bun test` passes (all 1137+ tests)
- [ ] Production `public.tasks` has no new `/tmp/%` rows after test run

**Validation:**
```bash
# Count before
BEFORE=$(psql -h 127.0.0.1 -p 19642 -U postgres -d genie -tAc "SELECT count(*) FROM tasks WHERE repo_path LIKE '/tmp/%'")
bun test
AFTER=$(psql -h 127.0.0.1 -p 19642 -U postgres -d genie -tAc "SELECT count(*) FROM tasks WHERE repo_path LIKE '/tmp/%'")
[ "$BEFORE" = "$AFTER" ] && echo "PASS: zero leaks" || echo "FAIL: $((AFTER - BEFORE)) leaked"
```

**depends-on:** 1

---

### Group 3: Review + CI Guard

**Goal:** Verify isolation works and add a CI safety net.

**Deliverables:**
1. Run full test suite, verify zero production leaks
2. Add CI step to `.github/workflows/ci.yml`:
   ```yaml
   - name: Verify no test artifacts in production
     run: |
       COUNT=$(psql ... -tAc "SELECT count(*) FROM tasks WHERE repo_path LIKE '/tmp/%'")
       [ "$COUNT" = "0" ] || (echo "FAIL: $COUNT test tasks leaked" && exit 1)
   ```

**depends-on:** 1, 2

---

## Files to Create/Modify

```
src/lib/test-db.ts              (new — test isolation helper)
src/lib/test-db.test.ts         (new — tests for the helper)
src/**/*.test.ts                (modify — switch to getTestConnection)
.github/workflows/ci.yml        (modify — add leak check)
```
