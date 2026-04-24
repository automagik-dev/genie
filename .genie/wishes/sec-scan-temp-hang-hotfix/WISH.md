# Wish: Sec Scan Temp-Hang Hotfix

| Field | Value |
|-------|-------|
| **Status** | APPROVED |
| **Slug** | `sec-scan-temp-hang-hotfix` |
| **Date** | 2026-04-24 |
| **Author** | Genie (trace-driven hotfix, Felipe approved) |
| **Appetite** | small (~4h) |
| **Branch** | `fix/sec-scan-temp-hang-hotfix` |
| **Repos touched** | `automagik-dev/genie` |
| **Umbrella** | [canisterworm-incident-response/DESIGN.md](../../brainstorms/canisterworm-incident-response/DESIGN.md) |
| **Trace report** | `/tmp/trace-scanTempArtifacts-report.md` |

## Summary

`genie sec scan` hangs for minutes on every host with a non-empty `/tmp` or populated caches. Root cause: the per-file `onFile` callback in `scanTempArtifacts` runs a synchronous pipeline (`statSync → readFileSync → gunzipSync → regex scan → sha256 → toString → more regex`) for up to **15 595 files / 839 MB** on a typical `/tmp`, blocking the event loop so the progress ticker, SIGINT handler, and phase budgets never fire. Published on `@automagik/genie@next` 4.260424.1 as of tonight — **every end-user hitting the scan sees "hang" with no telemetry and no interrupt**.

Secondary bug: the 5 MB content-scan ceiling is bypassed when the basename matches `TEMP_ARTIFACT_NAME_REGEX`, allowing an attacker-planted multi-GB tarball to be read fully into memory. Availability risk.

Tertiary bug: `collectTempRoots` adds `~/.npm`, `~/.bun`, `~/.cache` as top-level walk roots even though `WALK_SKIP_DIRS` is meant to exclude them (skip-set only applies to sub-entries, not chosen roots).

This wish ships **all three fixes in a single small hotfix PR** so `@next` can republish and end-users can actually use the scanner.

## Preconditions

- `sec-scan-progress` G1+G2 shipped ✅ (PR #1362 on dev).
- Trace report exists and has been reviewed ✅ (`/tmp/trace-scanTempArtifacts-report.md`).
- Reproducible hang captured ✅ (`/tmp/sec3-stderr.log` — 180s, `/tmp/sec2-stderr.log` — 9s with HOME override).

## Scope

### IN

**Fix 1: Event-loop yielding + per-phase read budget**
- Modify `onFile` callback in `scripts/sec-scan.cjs` (around line 2594–2635) so it yields control back to the event loop periodically (`await new Promise(setImmediate)` every N files, where N is tunable — default 128).
- Add a per-phase bytes-read budget (default 256 MB) tracked in the runtime context; when breached, record a `phase.cap_hit` event with `reason=bytes_budget` and move on.
- Add a per-phase files-scanned budget (default 5 000) with same event-based cap behaviour.
- Both caps expose existing `--phase-budget` override; defaults are safe for a normal laptop.

**Fix 2: Size-ceiling bypass closure**
- At `scripts/sec-scan.cjs:2608`, remove the name-regex fast path that lets files larger than `MAX_TEMP_CONTENT_SCAN_SIZE` get fully read. The name-match should still flag the file for reporting (basename hit the IOC name list) but MUST NOT short-circuit the size gate. Basename-only findings emit a `size_capped_not_hashed` flag in the finding so operators know the file content wasn't inspected.

**Fix 3: `collectTempRoots` root overreach**
- Remove `~/.npm`, `~/.bun`, `~/.cache` from the top-level roots emitted by `collectTempRoots` (they stay in `WALK_SKIP_DIRS` as sub-entry skips, unchanged).
- Keep `~/Library/Caches`, `~/AppData/Local/Temp`, `~/AppData/Local/npm-cache` as roots on macOS/Windows only — platform gating already in the function; verify and tighten if needed.
- `scanNpmCache` / `scanBunCache` remain the dedicated scanners for those trees with their own tighter walk caps — no regression for detection parity.

**Tests**
- Unit test: `scripts/sec-scan.test.ts` — mock a 10 000-file fixture under `/tmp`, assert scan completes in <5s wall time with caps recorded in coverage.
- Unit test: mock a name-matching 50 MB file, assert it's flagged but NOT fully read into memory (heap delta <6 MB during the scan).
- Chaos test: SIGINT mid-temp-scan on a 10k-file fixture — assert flush + exit 2 within 500 ms (previously impossible because event loop was blocked).
- Detection parity: existing CanisterWorm fixture findings unchanged.

**Telemetry**
- New event kind: `phase.cap_hit` with fields `{phase, reason: 'bytes_budget'|'files_budget', breached_at_ms, entries_processed, bytes_processed}`.
- Progress-JSON stream emits the event so UI wrappers (sec-fix-one-shot wish) can surface cap hits visually.

### OUT

- New UX / progress bar / single-command wrapper (owned by `sec-fix-one-shot` wish).
- `--verbose` styling improvements (owned by `sec-fix-one-shot` G3).
- Any change to scanner detection logic / IOC list.
- Multi-host orchestration.
- Async-refactor of the whole scanner (this is the minimum-diff fix).

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Yield via `setImmediate` every N files rather than async-refactor the whole pipeline | Smallest possible diff that unblocks end-users; full async refactor is a separate wish if needed. |
| 2 | Per-phase bytes + files budgets configurable via existing `--phase-budget` surface | Reuses G1's flag; no new CLI surface in a hotfix. |
| 3 | Basename-IOC-hit files become reports-only when over size limit | Preserves detection signal without the availability risk. |
| 4 | `~/.npm`, `~/.bun`, `~/.cache` dropped as top-level roots, not just skipped | `WALK_SKIP_DIRS` skip-set only applies to sub-entries — explicit root removal is the only correct fix. |
| 5 | Ship as a single small PR, not folded into `sec-fix-one-shot` | Every hour `@next` stays broken is real stakeholder pain; decouple from the bigger UX wish. |

## Success Criteria

- [ ] `genie sec scan --root /tmp` on a typical dev machine (15k+ temp files, `.npm`/`.bun`/`.cache` populated) completes in <10 s with coverage caps recorded.
- [ ] `genie sec scan` honours SIGINT within 500 ms during the temp-artifacts phase (previously impossible).
- [ ] `--phase-budget scanTempArtifacts=5000` enforces the budget; `phase.cap_hit` event emitted when breached.
- [ ] Name-matching 50 MB file: flagged but NOT fully read (heap-delta test).
- [ ] `~/.npm`, `~/.bun`, `~/.cache` no longer appear as top-level roots in `collectTempRoots` output (unit assertion).
- [ ] CanisterWorm fixture detection parity: identical findings pre/post hotfix.
- [ ] Existing 48/48 scan tests still pass; new tests added for each fix.
- [ ] Published `@automagik/genie@next` version bumps + includes the fix.

## Execution Strategy

### Single group — 4-hour wall

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | All three fixes + tests + parity check, single PR. |

## Execution Groups

### Group 1: Hotfix

**Goal:** End-users' `genie sec scan` completes in seconds, respects SIGINT, and can't be DoS'd by a large name-matching file.

**Deliverables:**
1. `scripts/sec-scan.cjs` edits at the three documented locations (onFile callback, size-ceiling fast path, collectTempRoots root list). See trace report for exact line numbers.
2. New runtime counters: bytes-read-this-phase, files-scanned-this-phase, plumbed through to coverage JSON and the events stream.
3. `phase.cap_hit` event kind registered in the events registry/schema.
4. `scripts/sec-scan.test.ts` — three new tests:
   - 10k-file `/tmp` fixture: scan completes in <5s with caps recorded.
   - 50 MB name-matching file: flagged, heap-delta <6 MB, content-not-hashed flag present.
   - SIGINT during temp-scan: <500 ms flush + exit 2.
5. Detection-parity regression: existing CanisterWorm fixture findings identical before/after.
6. Changelog note + release-note snippet in PR body.

**Acceptance Criteria:**
- [ ] All new tests pass.
- [ ] Existing 48/48 scan tests still pass.
- [ ] Hyperfine on 10k-file fixture: p50 <5 s wall time.
- [ ] SIGINT chaos test passes at 1s / 5s intervals.
- [ ] Heap-delta test on 50 MB fixture <6 MB.
- [ ] `collectTempRoots` unit assertion confirms three cache dirs dropped from top-level roots.

**Validation:**
```bash
bun test scripts/sec-scan.test.ts
hyperfine --warmup 2 'bun scripts/sec-scan.cjs --root ./test-fixtures/10k-files --json > /dev/null'
bun scripts/sec-scan.cjs --root /tmp --verbose  # completes <10s on a real /tmp
```

**depends-on:** none

---

## QA Criteria

- [ ] End-user `npx -y @automagik/genie@next sec scan --all-homes` returns in <30s on a normal laptop (currently: hangs indefinitely).
- [ ] SIGINT interruptible at any point of the scan.
- [ ] No detection regression against CanisterWorm fixture.
- [ ] Auto-version workflow fires after merge → `@next` republishes → end-users pull the fix with no cache busting needed.

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Yielding changes event ordering and destabilises other scanner phases | Medium | Yield only inside `onFile` — no structural change to phase ordering. Full-suite scan tests validate. |
| Per-phase budgets hide real IOC hits in legitimate large-cache hosts | Medium | Caps emit `phase.cap_hit` + coverage banner at TOP of report (existing G2 behaviour) so operators know to re-run with larger budgets. |
| Heap-delta test flaky under Bun's GC timing | Low | Use `--smol` or `gc()` fence around the measurement; accept ±2 MB tolerance. |
| Dropping cache dirs as roots leaves a detection gap | Low | Dedicated `scanNpmCache` + `scanBunCache` phases still cover them with appropriate caps. |
| Rebasing on `dev` introduces merge conflicts with `sec-fix-one-shot` follow-up | Low | Hotfix is isolated to `scripts/sec-scan.cjs` + test file + events registry; UX wish wraps but doesn't modify these. |

## Review Results

_Populated by `/review` after execution completes._

## Files to Create/Modify

```
scripts/sec-scan.cjs                    # modify: onFile yield, size-ceiling fix, collectTempRoots root list, new counters
scripts/sec-scan.test.ts                # modify: 3 new tests (perf, heap, SIGINT under load)
src/lib/events/schemas/*.ts             # modify (if needed): register phase.cap_hit event
```
