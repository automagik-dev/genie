# Wish: Centralized CLI Output Helper

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `cli-output-helper` |
| **Date** | 2026-04-06 |

## Summary

Create a centralized `output.ts` module for genie CLI that handles all stdout writes with pipe-safe chunked I/O. Replace 55 scattered `console.log(JSON.stringify(...))` calls across 26 files with `output.json(data)`. Fixes truncation at 8192 bytes when stdout is piped (ssh, subprocess, `| jq`). Also includes the postAction async fix that eliminates 1s idle timeout on every CLI command.

## Scope

### IN
- Create `src/lib/output.ts` with `json()`, `text()`, `error()` helpers using chunked `writeSync(1, ...)`
- Migrate all 55 `console.log(JSON.stringify(...))` sites to `output.json()`
- Fix postAction commander hook: make async so audit write completes before `shutdownDb`
- Remove profiling instrumentation (GENIE_PROFILE_DB, _T_BOOT) added during investigation

### OUT
- Migrating non-JSON `console.log()` calls (table rendering, status messages) — those don't hit the pipe bug
- Changing the 340ms Bun startup baseline (that's bundle parse, not fixable here)
- Reducing `getConnection()` overhead (measured at 70ms, acceptable)
- Touching omni CLI output (separate repo, already has its own output module)

## Decisions

| Decision | Rationale |
|----------|-----------|
| `writeSync(1, ...)` in 4KB chunks | Bun truncates single `writeSync` to 8192 bytes on pipes. 4KB chunks confirmed working for 22KB+ output |
| Centralized module, not patching `console.log` | Bundle doesn't propagate global patches — tested and failed. Explicit import is reliable |
| `output.json(data, opts?)` API | Matches omni CLI pattern (`import * as output`). Supports `indent` option for pretty vs compact |
| postAction as `async` hook | Fire-and-forget postAction creates orphan PG connection with 1s idle_timeout. Awaiting it reuses existing connection. Measured: 1.5s → 0.43s |

## Success Criteria

- [ ] `genie dir ls --json --builtins | wc -c` returns full byte count (22KB+), not 8192
- [ ] `genie dir ls --json --builtins | jq length` succeeds (valid JSON through pipe)
- [ ] `genie events list --json | jq length` succeeds
- [ ] `genie ls --json | jq length` succeeds
- [ ] `time genie dir ls --json > /dev/null` completes in < 600ms (was 1.5s)
- [ ] `time genie --version` unchanged (~340ms baseline)
- [ ] Zero `console.log(JSON.stringify(` remaining in src/ (excluding tests)
- [ ] `bun run typecheck` clean
- [ ] `bun run check` passes (biome lint + format)

## Execution Strategy

### Wave 1 (sequential)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Create output.ts + fix postAction + migrate all 55 sites |
| review | reviewer | Verify pipe output + latency + zero remaining console.log(JSON.stringify) |

## Execution Groups

### Group 1: Output Module + Migration

**Goal:** Replace all JSON stdout writes with pipe-safe centralized helper.

**Deliverables:**
1. `src/lib/output.ts` — `json(data, opts?)`, `text(str)`, `error(str)` using chunked writeSync
2. Migrate 55 `console.log(JSON.stringify(...))` across 26 files to `output.json()`
3. Fix `postAction` hook in `src/genie.ts` — make async with await
4. Remove GENIE_PROFILE_DB instrumentation from `src/lib/db.ts` and `src/genie.ts`

**Acceptance Criteria:**
- [ ] `grep -rn "console.log(JSON.stringify" src/ --include="*.ts" | grep -v test | wc -l` returns 0
- [ ] `genie dir ls --json --builtins | wc -c` > 8192
- [ ] `time genie dir ls > /dev/null` < 600ms
- [ ] Typecheck + lint clean

**Validation:**
```bash
bun run typecheck && bun run build && \
  test "$(dist/genie.js dir ls --json --builtins | wc -c)" -gt 8192 && \
  test "$(grep -rn 'console.log(JSON.stringify' src/ --include='*.ts' | grep -v test | wc -l)" -eq 0 && \
  echo "PASS"
```

**depends-on:** none

---

## QA Criteria

- [ ] Pipe output: `genie dir ls --json --builtins | python3 -c "import sys,json; json.load(sys.stdin)"` succeeds
- [ ] Pipe output: `genie ls --json | jq .` succeeds
- [ ] Latency: all DB-touching commands < 600ms
- [ ] No regressions: `bun test` passes

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Some `console.log(JSON.stringify(...))` in streaming contexts (events stream --json) | Medium | Those use line-delimited JSON (small per-line), unlikely to hit 8KB. Migrate anyway for consistency |
| Bun chunked writeSync could still fail on very slow pipes | Low | 4KB chunks well under any known buffer limit |

---

## Files to Create/Modify

```
src/lib/output.ts                          (CREATE)
src/genie.ts                               (MODIFY — postAction fix)
src/lib/db.ts                              (MODIFY — remove profiling)
src/genie-commands/setup.ts                (MODIFY)
src/term-commands/agent/directory.ts       (MODIFY)
src/term-commands/agent/inbox.ts           (MODIFY)
src/term-commands/agent/log.ts             (MODIFY)
src/term-commands/agent/show.ts            (MODIFY)
src/term-commands/agents.ts                (MODIFY)
src/term-commands/audit-events.ts          (MODIFY)
src/term-commands/board.ts                 (MODIFY)
src/term-commands/dir.ts                   (MODIFY)
src/term-commands/exec/index.ts            (MODIFY)
src/term-commands/history.ts               (MODIFY)
src/term-commands/metrics.ts               (MODIFY)
src/term-commands/msg.ts                   (MODIFY)
src/term-commands/notify.ts                (MODIFY)
src/term-commands/omni.ts                  (MODIFY)
src/term-commands/project.ts               (MODIFY)
src/term-commands/qa.ts                    (MODIFY)
src/term-commands/release.ts               (MODIFY)
src/term-commands/schedule.ts              (MODIFY)
src/term-commands/sessions.ts              (MODIFY)
src/term-commands/tag.ts                   (MODIFY)
src/term-commands/task.ts                  (MODIFY)
src/term-commands/task/release-mgmt.ts     (MODIFY)
src/term-commands/team.ts                  (MODIFY)
src/term-commands/template.ts              (MODIFY)
src/term-commands/type.ts                  (MODIFY)
```
