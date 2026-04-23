# Wish: Sec Scan Progress And Bounded Runtime

| Field | Value |
|-------|-------|
| **Status** | APPROVED |
| **Slug** | `sec-scan-progress` |
| **Date** | 2026-04-23 |
| **Author** | Codex + Genie Council (split from monolith per reviewer BLOCKED verdict) |
| **Appetite** | medium |
| **Branch** | `wish/sec-scan-progress` |
| **Repos touched** | `automagik-dev/genie` |
| **Umbrella** | [canisterworm-incident-response/DESIGN.md](../../brainstorms/canisterworm-incident-response/DESIGN.md) |
| **Design** | [DESIGN.md](../../brainstorms/sec-scan-progress/DESIGN.md) |
| **Council** | [COUNCIL.md](../../brainstorms/sec-scan-progress/COUNCIL.md) |
| **Task** | `#23` / `task-e654bdc9` |

## Summary

`genie sec scan --all-homes --root "$PWD"` can run for a long time with no output, leaving incident responders unable to tell whether it is working, stuck, or trapped in an expensive filesystem path. This wish — the first of four siblings under the `canisterworm-incident-response` umbrella — makes the scanner observable, bounded, and shrunk to load-bearing code only. It delivers the versioned JSON envelope + `scan_id` ULID + telemetry surface that the `sec-remediate` and `sec-incident-runbook` siblings consume. Remediation itself is out of scope for this wish.

## Preconditions

- **Umbrella committed:** `canisterworm-incident-response/DESIGN.md` exists and was approved.
- **Base branch:** ✅ satisfied — `codex/sec-scan-command` merged via PR #1348 (squash into `dev`, 2026-04-23T17:53Z). `scripts/sec-scan.cjs` + `src/term-commands/sec.ts` + `src/term-commands/sec.test.ts` exist on `origin/main` and `origin/dev` at commit `3d7e6609` (`fix(sec): address scan review feedback`). `git merge-base` reports "not merged" only because the branch SHAs were rewritten on squash; content is present. Wish branches from `dev`.
- **Council-validated scope.** Every IN bullet traces to a council recommendation in COUNCIL.md.

## Scope

### IN

- Scanner runtime context with injectable clock; phase lifecycle, progress emission, cap/skip accounting, entry/byte counters.
- Versioned JSON envelope: `reportVersion: 1`, `scan_id` (ULID), `hostId` hash, `scannerVersion`, `startedAt`, `finishedAt`, `invocation`, `platform`.
- Exit-code trichotomy: `0` clean-and-complete, `1` findings present, `2` clean-but-incomplete (caps hit, no findings).
- CLI flags: `--no-progress`, `--quiet`, `--verbose`, `--progress-interval <ms>`, `--progress-json`, phase budgets, `--events-file <path>`, `--redact`, `--persist`/`--no-persist`, `--impact-surface`.
- `walkProjectRoots` bounded with `{maxDepth, maxEntries}`; `COMMON_WORKSPACE_DIRS` kept for zero-config but capped.
- `walkTreeFiles` uses `dev:ino` dedup (fixes real symlink-cycle re-traversal); fallback to path-dedup when inode is `0` on exotic FS.
- `process.resourceUsage()` wall/cpu-user/cpu-sys snapshot per phase start/end for I/O-vs-CPU fingerprint.
- Per-root fingerprint: `fs_type`, `is_remote`, `mount_source`, `cross_device`.
- SIGINT/SIGTERM handler flushes coverage + partial findings in <500ms; exits code `2`.
- `GENIE_SEC_SCAN_DISABLED=1` env kill switch.
- Deletion pass (all four simplifier cuts): `inspectPackageDirectory` walk → 3 named IOC file checks only; matcher-table collapse (`IOC_STRINGS` + `TEXT_MATCHERS` → one compile-at-load table); four text-walks collapsed into one classifier pass; `.pth` + `twine` dropped from IOCs; `scanImpactSurface` gated behind `--impact-surface`; `timeline` rebuilt post-hoc; 10 `try/catch` blocks in `main()` collapsed into phase-registry array.
- `--events-file <path.jsonl>` NDJSON emitter (explicit flag only, mode `0600`, alias sidecar also `0600`, stderr banner names file as sensitive).
- Events schema: `{ts_ms, scan_id, event, phase, root_id, path_hash, fs_device, mount_type, depth, entries_seen_delta, elapsed_ms, cap_hit, skip_reason, error_class, errno}`. Event kinds: `phase.start/end/error`, `root.enter/exit`, `walk.capped/skipped/error`, `readdir.slow`, `symlink.cycle`, plus `action.start/end` stubs consumed by sec-remediate.
- `--redact` mode: hashes `$HOME`-prefixed paths; scrubs AWS/GitHub/npm/JWT secret patterns in snippets and error messages.
- Silent `catch {}` blocks in `safeReaddir`/`safeStat`/`safeRealpath`/`safeJsonParse` replaced with structured `walk.error` events (helpers still return null for backward-compat with detection logic).
- Scan report persisted to `$GENIE_HOME/sec-scan/<scan_id>.json` (mode `0600`, banner on stderr); `--no-persist` opts out. On filesystems without POSIX mode semantics (FAT32, some network mounts), emit a warning to stderr but do not fail.
- Audit log plumbing: `$GENIE_HOME/sec-scan/audit/<scan_id>.jsonl` (append-only, mode `0600`, `fsync` per event). Scanner events populate it; sec-remediate extends with action events.
- Coverage-gap banner at the TOP of the human report; top-5 slowest roots printed to stderr under `--verbose`.
- `genie sec print-cleanup-commands [--scan-report <path>]` subcommand emits exact shell one-liners per finding kind (`npm cache clean --force`, `systemctl --user disable`, `launchctl unload`, etc.). User reviews and executes. Destructive lines commented-out by default.
- Fixtures: 10k-file tree, symlink-cycle, 10MB shell history, 50k-entry npm cache, 25k temp files, 20MB near-limit file. Deterministic, reproducible, generated by `scripts/sec-scan-bench.cjs`.
- Hyperfine baseline + post-deletion measurement published as PR artifacts.
- `scripts/sec-scan.test.ts` created covering every deliverable.

### OUT

- `genie sec remediate` and `genie sec restore` — owned by sibling wish `sec-remediate`.
- Cosign/SLSA release signing and `genie sec verify-install` — owned by sibling wish `genie-supply-chain-signing`.
- `SECURITY.md` invariants section + full incident runbook — owned by sibling wish `sec-incident-runbook`.
- Daemon/worker pool/TUI.
- Expanding CanisterWorm/TeamPCP IOC coverage.
- Scanning every mounted filesystem by default.
- Automated credential rotation.
- Network-delivered IOC list updates.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Central scanner runtime context with injectable clock | Progress, budgets, coverage, and telemetry are testable in one place |
| 2 | Progress to stderr; JSON to stdout; NDJSON progress via `--progress-json` | Humans, CI, and automation all get appropriate channels |
| 3 | Scanner stays a single CJS payload | Preserves zero-config install for the incident-response path |
| 4 | Versioned JSON envelope with `scan_id` ULID | Every sibling wish keys off `scan_id`; retrofit is breakage |
| 5 | Exit code trichotomy distinguishes clean-complete from clean-but-incomplete | Capped roots must not pass automation gates |
| 6 | `dev:ino` dedup with path-dedup fallback | Real symlink-cycle bug fix; exotic FS (FAT32) handled gracefully |
| 7 | `process.resourceUsage()` wall/CPU ratio as primary I/O-vs-CPU signal | One snapshot per phase; decisive discriminator |
| 8 | `--events-file` is explicit-flag-only, never implicit under `--verbose` | Syscall-detail telemetry on a compromised host must not be written unless asked for |
| 9 | Persist to `$GENIE_HOME/sec-scan/<scan_id>.json` by default (mode `0600`, banner) | Audit trail is non-negotiable; `--no-persist` covers ephemeral use |
| 10 | Scanner and remediate are sibling CJS payloads, not one file | Different blast radii, different review bars, different signing posture |
| 11 | Deletion pass lands as real source changes in Group 3 | Delete-first shrinks surface before instrumentation hardens; benchmarker + simplifier both concur in COUNCIL.md |
| 12 | `COMMON_WORKSPACE_DIRS` stays (bounded) | Zero-config `npx genie sec scan --all-homes` is load-bearing for adoption |

## Success Criteria

- [ ] Long `genie sec scan --all-homes` emits progress within 5s; `--no-progress`/`--quiet` suppresses; `--progress-json` emits NDJSON to stderr.
- [ ] `genie sec scan --json` pipes cleanly to `jq`; envelope has `reportVersion: 1`, `scan_id`, `hostId`, `scannerVersion`, timestamps, `invocation`, `platform`.
- [ ] Exit code `0` on clean-complete, `1` on findings, `2` on clean-but-incomplete.
- [ ] Capped/skipped roots render at the TOP of human report.
- [ ] SIGINT flushes coverage + findings in <500ms with exit `2`.
- [ ] `walkTreeFiles` symlink-cycle fixture terminates; symlink-cycle event emitted.
- [ ] Coverage records wall/CPU split per phase + fs fingerprint per root.
- [ ] `inspectPackageDirectory` no longer recurses; detection parity verified against CanisterWorm fixtures.
- [ ] `IOC_STRINGS` + `TEXT_MATCHERS` compile-at-load; per-call `new RegExp` eliminated.
- [ ] `scanImpactSurface` silent unless `--impact-surface`.
- [ ] `--events-file` mode `0600`; alias sidecar `0600`; banner on stderr; on FAT32/network mounts emit warning but do not fail.
- [ ] `--redact` scrubs AWS/GitHub/npm/JWT patterns; assertion strings contain `<REDACTED:{kind}>` markers.
- [ ] No silent `catch {}` in `safe*` helpers; replaced with `walk.error` events.
- [ ] Persisted report round-trips; `--no-persist` leaves `$GENIE_HOME` untouched.
- [ ] Audit log append-only, `fsync`-per-event.
- [ ] `genie sec print-cleanup-commands` produces a review-ready shell script; `bash -n` parse succeeds; destructive lines commented by default.
- [ ] Hyperfine: median wall-time reduction ≥30% on 10k-file fixture cold cache (before → after deletion).
- [ ] LOC count of `scripts/sec-scan.cjs` decreases ≥15%.

## Execution Strategy

### Wave 1 (sequential)

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Runtime context, versioned JSON envelope, exit codes, CLI surface, SIGINT handler. |
| 2 | engineer | Bounded walks, `dev:ino` dedup, phase instrumentation with wall/CPU, fs fingerprint, coverage banner. |
| 3 | engineer | Simplifier deletion pass, matcher collapse, phase-registry refactor, hyperfine baseline. |
| 4 | engineer | Events file NDJSON emitter, redaction, persistence, audit log plumbing. |
| 5 | engineer | `genie sec print-cleanup-commands` mode (detect → exec pathway). |

## Execution Groups

### Group 1: Runtime Contract, Versioned Envelope, CLI Surface

**Goal:** Establish the runtime context, stable JSON envelope, exit codes, and full CLI flag surface without changing detection or adding instrumentation.

**Deliverables:**
1. Scanner runtime context in `scripts/sec-scan.cjs` with injectable clock + interval provider.
2. Versioned JSON envelope (`reportVersion`, `scan_id` ULID, `hostId`, `scannerVersion`, `startedAt`, `finishedAt`, `invocation`, `platform`).
3. Exit code trichotomy wiring (`0`/`1`/`2`).
4. Progress reporter to stderr; `--progress-json` NDJSON mode.
5. CLI flag parsing + `src/term-commands/sec.ts` pass-through for every IN-scope flag.
6. SIGINT/SIGTERM handler with <500ms flush.
7. `GENIE_SEC_SCAN_DISABLED=1` kill switch.
8. `scripts/sec-scan.test.ts` covering envelope shape, SIGINT flush latency, exit-code trichotomy, injected-clock progress, JSON stdout integrity, `--redact` CLI wiring.

**Acceptance Criteria:**
- [ ] CLI flags surface in `genie sec scan --help` and `scripts/sec-scan.cjs --help`.
- [ ] `genie sec scan --json | jq .reportVersion` prints `1`.
- [ ] Envelope shape asserted in unit test against a JSON Schema fixture.
- [ ] SIGINT chaos test: flush + exit 2 within 500ms on 10k-file fixture.
- [ ] `GENIE_SEC_SCAN_DISABLED=1 genie sec scan` exits 0 with reason.
- [ ] Detection parity: CanisterWorm fixture findings unchanged in content (envelope wraps them).

**Validation:**
```bash
bun test src/term-commands/sec.test.ts scripts/sec-scan.test.ts
bun scripts/sec-scan.cjs --help
bun scripts/sec-scan.cjs --json --root ./test-fixtures/empty | jq .reportVersion
```

**depends-on:** none

---

### Group 2: Bounded Walks, dev:ino Dedup, Phase Measurement, Coverage Banner

**Goal:** Every phase observable with two-dimensional timing; every walk bounded; symlink-cycle bug fixed; coverage gaps loud.

**Deliverables:**
1. `walkTreeFiles` `seen` set replaced with `dev:ino` Set (fallback to path when inode is `0`); emit `symlink.cycle` when same inode reappears.
2. `walkProjectRoots` bounded with `{maxDepth, maxEntries}`; `COMMON_WORKSPACE_DIRS` bounded aggressively per root.
3. Phase instrumentation via `runtime.phase.start/end` with `process.resourceUsage()` snapshots; coverage records `wall_ns`, `cpu_user_ns`, `cpu_sys_ns`, `entries`, `bytes`, `errors`, `caps`, `skips` per phase.
4. Per-root fingerprint emitter (Linux `/proc/self/mountinfo`, macOS `fs.statfsSync` w/ `mount | grep` fallback, WSL `drvfs`/`9p` detection); `cross_device` flag.
5. Coverage-gap banner at TOP of human report (`⚠ INCOMPLETE SCAN: <N> capped roots, <M> skipped roots`); snapshot test asserts position.
6. Top-5 slowest roots printed to stderr under `--verbose` (realpath + mount-type + elapsed).
7. Conservative `--all-homes` and temp/cache defaults that record blind spots.
8. Chaos-test fixture: SIGINT at 5s / 30s / 5min; asserts coverage JSON well-formed, active phase marked `interrupted`, exit `2`.

**Acceptance Criteria:**
- [ ] Symlink-cycle fixture terminates; `symlink.cycle` event structure matches schema.
- [ ] Huge-fixture `--all-homes` completes with cap records, no hang.
- [ ] Coverage JSON contains wall/CPU split per phase + fs fingerprint per root.
- [ ] Capped-root banner appears at TOP of human report.
- [ ] `--verbose` prints top-5 slowest roots.
- [ ] SIGINT chaos test passes at 5s/30s/5min with <500ms flush.
- [ ] CanisterWorm detection parity preserved.

**Validation:**
```bash
bun test scripts/sec-scan.test.ts src/term-commands/sec.test.ts
GENIE_TEST_SKIP_PGSERVE=1 bun test scripts/sec-scan.test.ts
bun scripts/sec-scan.cjs --root ./test-fixtures/symlink-cycle --verbose
```

**depends-on:** Group 1

---

### Group 3: Deletion Pass, Matcher Collapse, Phase-Registry Refactor

**Goal:** Shrink the payload to load-bearing detection only; collapse duplicate walks and matcher tables; turn `main()` into a phase-registry loop.

**Deliverables:**
1. `inspectPackageDirectory`'s recursive walk replaced with named-file checks against `IOC_FILE_SUFFIXES`.
2. `IOC_STRINGS` + `TEXT_MATCHERS` collapsed into one canonical, module-load-compiled matcher table keyed by context (`binary`, `text`, `snippet`).
3. Four text walks collapsed into one classifier pass over a deduplicated candidate set keyed by kind.
4. `.pth` and `twine` removed from `IOC_STRINGS`.
5. `scanImpactSurface` gated behind `--impact-surface`.
6. `timeline` computed post-hoc from typed finding arrays.
7. `main()` refactored to phase-registry array `[{id, fn, scope}, ...]` with one try/catch wiring `runtime.phase.start/end` + `phase.error`.
8. `scripts/sec-scan-bench.cjs` fixture generator (10k-file tree, 10MB history, 50k npm cache, 25k temp files, 20MB near-limit file) + hyperfine runner.
9. Hyperfine baseline vs after-deletion runs published as PR artifacts.

**Acceptance Criteria:**
- [ ] `scripts/sec-scan.cjs` LOC decreases ≥15%.
- [ ] CanisterWorm fixture detection parity: every pre-wish finding appears in post-wish output with same IOC kind.
- [ ] `collectTextIndicators` no longer calls `new RegExp(...)` in hot paths (grep audit).
- [ ] `scanImpactSurface` silent without `--impact-surface`.
- [ ] `timeline` empty until end-of-scan, then populated from findings.
- [ ] Hyperfine median wall-time reduction ≥30% on 10k-file fixture cold cache.
- [ ] Every scanner phase goes through `runtime.phase.start/end`; audit test asserts zero ad-hoc calls.

**Validation:**
```bash
bun test scripts/sec-scan.test.ts
bun scripts/sec-scan-bench.cjs --fixture 10k-files --hyperfine
bun scripts/sec-scan.cjs --root ./test-fixtures/canisterworm --json | jq '.findings | length'
```

**depends-on:** Group 2

---

### Group 4: Events File, Redaction, Persistence, Audit Log

**Goal:** Ship the structured telemetry surface and secret-aware redaction that makes output shareable and remote triage possible.

**Deliverables:**
1. `--events-file <path.jsonl>` NDJSON emitter (explicit flag only, mode `0600`). On filesystems without POSIX mode semantics, emit stderr warning but do not fail.
2. Event schema + event kinds per Scope IN; `action.start` / `action.end` stubs reserved for sec-remediate.
3. Alias sidecar `<events-file>.aliases.json` (mode `0600`) mapping `root_id` → absolute path; loud stderr banner on every write naming file as incident-sensitive.
4. `--redact` mode: `$HOME`-prefixed path hashing + secret-pattern scrubber (AWS AKIA, GitHub `gh[pousr]_`, npm `npm_`, JWT `ey[A-Za-z0-9]+\.ey…`, generic 40-char hex).
5. Silent `catch {}` in `safeReaddir`/`safeStat`/`safeRealpath`/`safeJsonParse` routed through `runtime.walk.error` events with `error_class` + `errno`; helpers still return null.
6. Scan report persisted to `$GENIE_HOME/sec-scan/<scan_id>.json` by default (mode `0600`, banner); `--no-persist` opt-out; FAT32 warning path.
7. Audit log plumbing: `$GENIE_HOME/sec-scan/audit/<scan_id>.jsonl` (append-only, mode `0600`, `fsync` per event).

**Acceptance Criteria:**
- [ ] `--events-file` produces valid NDJSON; JSON Schema fixture validates.
- [ ] File mode `0600` asserted via `fs.statSync().mode` on Linux; on FAT32/network mount test, warning logged + no failure.
- [ ] Banner prints on stderr on every `0600` write.
- [ ] `--redact` fixtures: AWS/GitHub/npm/JWT strings replaced with `<REDACTED:{kind}>`.
- [ ] Silent `catch {}` audit: grep returns zero hits in `safe*` helpers.
- [ ] Persisted report round-trips to same structured content as JSON stdout.
- [ ] `--no-persist` leaves `$GENIE_HOME/sec-scan/` untouched.
- [ ] Audit log survives `openSync` + `O_APPEND` truncation attempt test.

**Validation:**
```bash
bun test scripts/sec-scan.test.ts
bun scripts/sec-scan.cjs --json --events-file /tmp/evt.jsonl --redact --root . | jq '.scan_id'
stat -c '%a' /tmp/evt.jsonl  # must print 600
```

**depends-on:** Group 3

---

### Group 5: print-cleanup-commands Mode (Detect → Exec)

**Goal:** Scanner emits exact shell one-liners a competent operator would run. No write capability added.

**Deliverables:**
1. `genie sec print-cleanup-commands [--scan-report <path>]` subcommand in `src/term-commands/sec.ts`.
2. Per-finding command templates: `npm cache clean --force <entry>`, `systemctl --user disable <unit>` (Linux), `launchctl unload <plist>` (macOS), `HISTFILE=/dev/null` shell history reset, `gh auth refresh` / `npm token list` / `aws sts get-caller-identity` for credential audit.
3. Script header: `scan_id`, `hostId`, generation timestamp, pinned-key fingerprint (consumed from sec-incident-runbook once available; placeholder string until then).
4. Every emitted line has a comment describing what it does and why; destructive lines (`rm`, `npm cache clean --force`) commented-out by default with a banner explaining selective uncomment.
5. Platform branching (macOS vs Linux vs WSL); no `systemctl` emitted on macOS, no `launchctl` on Linux.
6. Snapshot test on CanisterWorm fixture asserting deterministic output.

**Acceptance Criteria:**
- [ ] `bash -n` parses the emitted script successfully.
- [ ] Destructive lines start with `#` by default; banner explains how to uncomment.
- [ ] Platform branching correct on Linux + macOS + WSL fixture matrix.
- [ ] Output deterministic for the same scan JSON input (snapshot test).

**Validation:**
```bash
bun test scripts/sec-scan.test.ts src/term-commands/sec.test.ts
bun run typecheck
bunx biome check scripts/sec-scan.cjs scripts/sec-scan.test.ts scripts/sec-scan-bench.cjs src/term-commands/sec.ts src/term-commands/sec.test.ts
bun scripts/sec-scan.cjs --root ./test-fixtures/canisterworm --persist
genie sec print-cleanup-commands --scan-report "$GENIE_HOME/sec-scan/$(ls -t $GENIE_HOME/sec-scan/*.json | head -1 | xargs basename)" | bash -n
```

**depends-on:** Group 4

---

## QA Criteria

- [ ] `genie sec scan --all-homes --root "$PWD"` on a 10k-file fixture prints progress within 5s; median wall-time ≥30% lower than pre-deletion baseline.
- [ ] `genie sec scan --json` envelope has every versioned field.
- [ ] `--no-progress` / `--quiet` suppresses all progress.
- [ ] Capped fixture: banner at TOP of report; coverage JSON lists caps; exit `2`.
- [ ] Pre-existing CanisterWorm fixture detection parity preserved.
- [ ] `GENIE_SEC_SCAN_DISABLED=1` exits `0` with reason.
- [ ] `--events-file /tmp/e.jsonl --redact` writes mode-`0600` file with `<REDACTED:{kind}>` markers on secret fixtures.
- [ ] Silent `catch {}` grep audit zero-hit in `safe*`.
- [ ] `genie sec print-cleanup-commands` outputs a `bash -n`-parseable review-ready script.

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Default caps miss evidence on very large hosts | Medium | Caps in coverage + top-of-report banner; remediate refuses on capped scans unless `--remediate-partial` + typed ack |
| Progress leaks sensitive path names into shared logs | Medium | Default phase/root-level; path detail only under `--verbose`; `--redact` scrubber |
| JSON automation breaks if progress uses stdout | High | Progress to stderr; stdout JSON parse asserted |
| Deletion pass regresses detection | High | Detection-parity snapshot tests against CanisterWorm fixtures as Group 3 merge gate |
| Time-based tests flaky | Medium | Injectable clock; deterministic fixtures |
| `dev:ino` dedup breaks on exotic FS (FAT, some network mounts) | Medium | Fallback to path-dedup when inode is `0`; `symlink.cycle` events record which fallback path was taken |
| `--events-file` outlives incident | High | Mode `0600`, explicit flag only, loud banner, FAT32 warning path |
| Persisted scan reports accumulate and leak secrets-adjacent data | Medium | Mode `0600`, banner on every write, `--no-persist` documented; IR-artifact handling guidance lives in sec-incident-runbook |
| Fixture coverage misses an IOC-carrying code path before Group 3's deletion | High | Fixture coverage audit as part of Group 3 acceptance: every IOC kind touched by deleted code must appear in a fixture |
| `0600` mode is theater on FAT32/network mounts | Medium | Warning-not-fail; test asserts warning emitted on mock FAT32 mount |

## Review Results

_Populated by `/review` after execution completes._

## Files to Create/Modify

```
scripts/sec-scan.cjs                        # modify: runtime, envelope, bounded walks, deletion, instrumentation, events
scripts/sec-scan.test.ts                    # create: unit tests incl. SIGINT chaos, dev:ino, redaction
scripts/sec-scan-bench.cjs                  # create: fixture generator + hyperfine runner
src/term-commands/sec.ts                    # modify: pass-through flags + print-cleanup-commands subcommand
src/term-commands/sec.test.ts               # modify: subcommand dispatch tests

# Test fixtures
test-fixtures/symlink-cycle/                # create
test-fixtures/canisterworm/                 # existing; extend for detection-parity snapshot
test-fixtures/10k-files/                    # create (generated by sec-scan-bench)
test-fixtures/huge-history.bash_history     # create
test-fixtures/npm-cache-50k/                # create
```
