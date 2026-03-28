# Wish: Stable Release Fixes — Zero Open Bugs for dev→main

| Field | Value |
|-------|-------|
| **Status** | SHIPPED |
| **Slug** | `stable-release-fixes` |
| **Date** | 2026-03-21 |
| **Issues** | #678, #679, #680, #682 |

## Summary

Fix all 4 remaining open bugs on dev before the stable release promotion to main. These were identified during the QA council review of PR #676. One P1 (cron infinite loop) and three P2s (timezone, lease-timeout, sendMessage result). #681 was closed as not-a-bug (already fixed in ce5e2f69). After fixing, bump version and publish @next for final validation.

## Scope

### IN
- #678 (P1): Reject `step=0` in cron field parser — prevents infinite loop on `*/0` input
- #679 (P2): Apply `--timezone` to cron due computation — pass timezone through to `computeNextCronDue()`
- #680 (P2): Store `--lease-timeout` in `run_spec` JSONB column — not just metadata
- #682 (P2): Check `sendMessage` delivery result in wave-complete notification — log warning on failure
- Bump version and publish @next after all fixes
- Run full test suite to confirm no regressions

### OUT
- #574 (inbox-driven session management) — future feature, not a bug
- #681 — closed as not-a-bug (`computeNextCronDue` already works correctly)
- No new features or refactoring beyond the 4 fixes
- No changes to pgserve, fire-and-forget, or scheduler daemon core logic

## Decisions

| Decision | Rationale |
|----------|-----------|
| Fix all 4 in one wish | Small, focused fixes — sequential groups avoid file collision on schedule.ts |
| Sequential groups for schedule.ts | Groups 1 and 2 both touch schedule.ts; serializing avoids merge conflicts |
| Version bump after fixes | Ensures @next publish includes all fixes for final QA |

## Success Criteria

- [ ] `parseCronField('*/0')` throws validation error instead of infinite loop
- [ ] `computeNextCronDue('0 9 * * *', { timezone: 'America/New_York' })` computes correct UTC time
- [ ] `genie schedule create --lease-timeout 600000` stores value in `run_spec` JSONB column (not just metadata)
- [ ] `genie done` logs warning when `sendMessage` returns `delivered: false`
- [ ] `bun run check` passes (928+ tests, 0 failures)
- [ ] All 4 issues closeable with `Fixes #N` in commit messages
- [ ] @next version bumped and published

## Execution Strategy

### Wave 1 (sequential — both touch schedule.ts)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Cron fixes: step=0 guard (#678), timezone passthrough (#679) |

### Wave 2 (after Wave 1)
| Group | Agent | Description |
|-------|-------|-------------|
| 2 | engineer | Schedule + state fixes: lease-timeout in run_spec (#680), sendMessage result check (#682) |

### Wave 3 (after Wave 2)
| Group | Agent | Description |
|-------|-------|-------------|
| 3 | reviewer | Review all changes against issue descriptions |

### Wave 4 (after Wave 3)
| Group | Agent | Description |
|-------|-------|-------------|
| 4 | engineer | Version bump + push + verify @next publish |

## Execution Groups

### Group 1: Cron fixes (#678, #679)

**Goal:** Fix cron parser infinite loop and timezone passthrough.

**Deliverables:**

1. **#678 — Reject step=0** in `src/lib/cron.ts`:
   - In `expandRange()` (line 44), add guard at top: `if (step === 0) throw new Error('Cron step value cannot be 0')`
   - Add test: `parseCronField('*/0', 0, 59)` throws
   - Add test: `parseCronField('1-10/0', 0, 59)` throws

2. **#679 — Apply --timezone to cron computation**:
   - In `src/lib/cron.ts`: update `computeNextCronDue()` signature to accept optional `options?: { timezone?: string }` parameter. When timezone is provided, convert candidate times to the target timezone for field matching, then return result as UTC Date.
   - In `src/term-commands/schedule.ts` line 111: pass `{ timezone: options.timezone }` to `computeNextCronDue()`
   - Add test: `computeNextCronDue('0 9 * * *', { timezone: 'America/New_York' })` returns 9 AM ET converted to UTC
   - Handle DST: use `Intl.DateTimeFormat` with `timeZone` option to get correct local hour/minute

**Acceptance Criteria:**
- [ ] `*/0` input throws validation error
- [ ] Timezone-aware cron computes correct UTC time
- [ ] All existing cron tests still pass

**Validation:**
```bash
bun test src/lib/cron.test.ts && bun test src/term-commands/schedule.test.ts
```

**depends-on:** none

---

### Group 2: Schedule + state fixes (#680, #682)

**Goal:** Fix lease-timeout storage and sendMessage result checking.

**Deliverables:**

1. **#680 — Store --lease-timeout in run_spec** in `src/term-commands/schedule.ts`:
   - The `schedules` table has a `run_spec JSONB DEFAULT '{}'` column (added in migration 002)
   - In `scheduleCreateCommand` around line 218, add `run_spec` to the INSERT:
     ```sql
     INSERT INTO schedules (id, name, cron_expression, timezone, command, run_spec, metadata, status)
     VALUES (..., ${JSON.stringify(runSpec)}, ...)
     ```
   - Build `runSpec` object: `{ lease_timeout_ms: parseDuration(options.leaseTimeout) }` when provided, else `{}`
   - The scheduler daemon reads `schedule.run_spec` in `fireTrigger()` and passes it to `resolveRunSpec()` — no daemon changes needed
   - Add test: creating schedule with `--lease-timeout 10m` results in `run_spec` containing `lease_timeout_ms: 600000`

2. **#682 — Check sendMessage delivery result** in `src/term-commands/state.ts`:
   - At line ~214, after the `sendMessage` call in wave-complete notification, check return value
   - If result has `delivered: false`, log: `console.warn('⚠️ Wave-complete notification may not have been delivered')`
   - Do NOT fail or throw — this is best-effort notification
   - Add test: mock sendMessage returning `{ delivered: false }`, verify warning is logged

**Acceptance Criteria:**
- [ ] `--lease-timeout` value stored in `run_spec` JSONB column on schedules table
- [ ] Failed sendMessage in `genie done` logs warning instead of silent drop
- [ ] Existing state and schedule tests still pass

**Validation:**
```bash
bun test src/term-commands/schedule.test.ts && bun test src/term-commands/state.test.ts
```

**depends-on:** Group 1

---

### Group 3: Review

**Goal:** Review all fixes against the 4 issue descriptions.

**Deliverables:**
1. Verify each fix matches the issue's problem statement
2. Verify no regressions in existing tests
3. Verify commit messages reference `Fixes #N`

**Acceptance Criteria:**
- [ ] All 4 fixes reviewed and approved
- [ ] No regressions

**Validation:**
```bash
bun run check
```

**depends-on:** Group 1, Group 2

---

### Group 4: Version bump + publish

**Goal:** Bump version, push, verify @next publish.

**Deliverables:**
1. Run `bun run version` to bump version
2. Push to dev
3. Verify CI publishes @next
4. Install @next and verify version includes fixes

**Acceptance Criteria:**
- [ ] New @next version published
- [ ] `npm info @automagik/genie@next version` shows bumped version

**Validation:**
```bash
npm info @automagik/genie@next version
```

**depends-on:** Group 3

---

## QA Criteria

- [ ] `bun run check` passes with 928+ tests, 0 failures
- [ ] `*/0 * * * *` cron input is rejected with error
- [ ] Timezone-aware cron schedules compute correct UTC time
- [ ] Custom lease timeouts stored in `run_spec` and honored by scheduler
- [ ] Wave-complete notifications log warning on delivery failure
- [ ] @next version published and installable

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Timezone handling requires Intl API | Low | Bun supports Intl.DateTimeFormat natively |
| DST edge cases in timezone cron | Medium | Test with known DST transition dates; use Intl for authoritative offset |
| @next publish may require manual trigger | Low | Check CI workflow; manually trigger if needed |

## Files to Create/Modify

```
src/lib/cron.ts                    — step=0 guard in expandRange, timezone param on computeNextCronDue
src/lib/cron.test.ts               — new tests for step=0, timezone-aware cron
src/term-commands/schedule.ts      — pass timezone to computeNextCronDue, store lease-timeout in run_spec column
src/term-commands/schedule.test.ts — lease-timeout in run_spec test
src/term-commands/state.ts         — check sendMessage return value, log warning
src/term-commands/state.test.ts    — sendMessage delivery failure test
```
