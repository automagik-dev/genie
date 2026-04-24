# Wish: Sec Scan AV-Grade UI and False-Positive Reduction

| Field | Value |
|-------|-------|
| **Status** | DRAFT (reviewer round-1 FIX-FIRST + round-2 MEDIUM-gap fix applied 2026-04-24) |
| **Slug** | `sec-scan-av-ui` |
| **Date** | 2026-04-24 |
| **Author** | Genie + Felipe (post-hotfix observation) |
| **Appetite** | medium (~1 week) |
| **Branch** | `wish/sec-scan-av-ui` |
| **Repos touched** | `automagik-dev/genie` |
| **Umbrella** | [canisterworm-incident-response/DESIGN.md](../../brainstorms/canisterworm-incident-response/DESIGN.md) |

## Summary

The scanner works but doesn't feel like a security tool. When an operator runs `genie sec scan --all-homes --root "$PWD" --verbose` they see only `phase.start` / `phase.end` ticks with 10+ second silences inside phases. Empirically this reads as "hang" or "dead" even when the scanner is working fine. At the same time, the scanner's **findings are noisy with false positives** — on a confirmed-clean host the 2026-04-24 scan reported "LIKELY COMPROMISED, 100/100 suspicion" because (a) the scanner binary flags itself (its own IOC database is detected as IOC), (b) package matching is version-agnostic (`pgserve@1.1.10` clean gets flagged because the name matches the compromise list), and (c) investigation / remediation commands in shell history are matched as compromise activity.

This wish fixes both: ships a **real-time AV-grade progress UI** (sticky one-line, per-file ticks, file count, bytes, current-path, spinner, findings counter) and **reduces false positives** via self-path exclusion, version-gated matching, and shell-history exclusion patterns. Result: stakeholders get a scanner that feels professional AND reports accurate verdicts.

## Preconditions

- ✅ `sec-scan-progress` Group 1+2 on dev (#1362) — runtime + envelope + phase-lifecycle scaffolding exists
- ✅ `sec-scan-temp-hang-hotfix` on dev (#1371) — temp phase no longer blocks the event loop (prerequisite for per-file ticks to actually render during long phases)
- ✅ `sec-incident-runbook` G1+G2 merged — help-text conventions already in place
- Reviewer-approved design and user validation on the exact on-screen UX before implementation

## Scope

### IN

**A. Real-time progress UI**

- New progress renderer module `src/sec/ui/progress.ts`:
  - TTY-detect: `isatty(stderr)` → fancy mode (ANSI colors, cursor moves, spinner); non-TTY → plain append-only lines
  - Sticky single-line header (cursor return + clear) showing the active phase, spinner frame, `files_scanned`, `bytes_scanned`, truncated current path, findings-so-far, elapsed wall + CPU
  - Per-phase completion line printed above the sticky header as each phase closes: `✓ scanNpmCache   0.4s   2 hits   42 MiB   12 files`
  - Coverage-gap banner at the top preserved; new: lower-right elapsed-since-phase-start counter so the user can see "idle" vs "still working"

- Scanner emits new telemetry:
  - `phase.tick { phase, files_scanned_delta, bytes_scanned_delta, current_path_hash, findings_delta, elapsed_ms }` — emitted every `--progress-interval` (default 500ms) or every 128 files, whichever comes first, from inside each phase loop
  - `phase.file { phase, path_hash, size_bytes, hit }` — emitted for each file the phase processes (redacted when `--redact`). Aggregated in renderer for live counters; NOT written to stdout JSON by default.

- CLI flags:
  - `--progress-compact` (NEW, default when TTY) — sticky one-line + terse phase completion lines
  - `--progress-verbose` (alias for existing stderr verbose) — full event stream, no sticky rendering
  - `--no-progress` — nothing on stderr
  - `--progress-interval <ms>` — tick interval
  - `--progress-json` — NDJSON event stream to stderr (existing, untouched)

- Duplicate-phase-run bug fixed:
  - `scanNpmCache` and `scanBunCache` currently run twice (once per home dir). Refactor: collect roots once, iterate inside the phase, emit one `phase.start` / `phase.end` pair per phase kind. Phase coverage records merge across roots.

- Output sketch (TTY, `--progress-compact`):
  ```
  🛡  genie sec — host compromise sweep · host my-laptop · v4.260424.6
     Signatures loaded: 1 (canisterworm-2026-04)

     ⠸ scanTempArtifacts           [████████░░░░]  3 421 / 5 000 files   154 MiB
       /var/folders/.../pgserve-sock-67438.../postmaster.pid
       ↑ 4 hits so far · 0 caps · 0.2s idle
     ──────────────────────────────────────────────────────────────────────────
     ✓ scanNpmCache               0.4s   0 hits     42 MiB     12 files
     ✓ scanBunCache               0.3s   0 hits      0 MiB      0 files
     ✓ scanGlobalInstallCandidates 0.2s   2 hits     ~          8 files
     ✓ scanProjectRoots           0.2s   3 hits     ~          4 files
     ✓ scanShellHistories         0.0s   1 hit      ~          2 files
     ⏳ 6 more phases queued
  ```

- Output sketch (non-TTY, plain fallback): unchanged from today, one line per phase start / end plus per-findings summary. CI-friendly.

**B. False-positive reduction**

- **Self-path exclusion:** determine the scanner's own install path at startup (`realpathSync(process.argv[1])` → walk up to the package root). During all scans (install, live-process, temp, shell-history), skip any match whose resolved path is inside the scanner's own install directory. Emits a `self.skip { path }` event when elided. Net effect: `@automagik/genie@<clean-version>` no longer reports itself as compromised.

- **Version-gated matching:** today's IOC matchers return a hit on package *name* alone. Refactor to return a hit only when the observed version is in the `COMPROMISED_VERSIONS` list for that package. Where version is unknown (temp artifacts with no manifest), classify as `observed` instead of `affected` and tag with `version_unknown: true`.

- **Live-process version resolution:** live-process hits today flag any process whose command line contains a compromised package name. Extend the process-scanner to resolve the executable's install manifest (walk up from executable path to nearest `package.json`, read `version`) and match against `COMPROMISED_VERSIONS` before flagging.

- **Shell-history exclusion patterns:** add a documented `SHELL_HISTORY_EXCLUSIONS` table. Exclude lines that match remediation / investigation patterns:
  - `npm uninstall <compromised-package>`
  - `rm -rf .../node_modules/<compromised-package>`
  - `genie sec scan`, `genie sec remediate`, `genie sec verify-install`
  - `fc`-style history-inspection lines that start with `: <timestamp>:0;` where the rest is a documented IOC probe
  Emit `shell_history.excluded { line_hash, reason }` events so the exclusion is auditable.

- **Scoring recalibration:** current scoring weights `shellHistoryFindings` = 1 per hit with no decay. Redesign per the FP-reduction rules:
  - Score ≥ 80 requires at least one `compromised` signal (not just `affected` / `observed`)
  - Self-skip hits excluded from counts
  - Version-unknown temp artifact findings count 0.1 each, capped at 1.0 total
  - `install` findings count only when version matches compromise list

- **Deployment strategy (back-compat for band shift)** — The new bands (`CLEAN<20`, `OBSERVED 20-49`, `AFFECTED 50-79`, `COMPROMISED≥80`) change the user-facing verdict for hosts that previously scored 20-79 under the old bands (`CLEAN<50`, `AFFECTED 50-79`, `COMPROMISED≥80`). Automation keying off `summary.status == "CLEAN"` or `suspicionScore < 50` WILL start reporting differently. Three-release deprecation plan:
  1. **Release N (this wish):** JSON envelope emits BOTH `summary.status_v1` (old band) and `summary.status_v2` (new band). `summary.status` alias defaults to v2. Document the v1 alias in the runbook + release notes. Operators using old thresholds read `status_v1` during transition. Bump `reportVersion` to `1.1` (minor — additive).
  2. **Release N+1 (1 minor later):** deprecation warning on stderr — fires AT MOST ONCE per scan invocation when `summary.status_v1` has been read. Implementation: the scanner constructs the JSON envelope with `summary` as a tracked object — a thin `Object.defineProperty(summary, 'status_v1', { get })` that, on first access, flips a `v1_was_read` flag (no re-fire on subsequent reads of the same scan). At end-of-scan, if `v1_was_read`, write a single line to stderr: `⚠ summary.status_v1 is deprecated (will be removed in release N+2 = <version>). Switch automation to summary.status (v2) or summary.status_v2. See docs/sec-scan/verdict-bands-migration.md.` Operators see the warning once per scan, not per access. Snapshot test locks the warning text + single-emit behaviour.
  3. **Release N+2 (2 minors later):** drop `status_v1` from JSON output. Bump `reportVersion` to `2`.
  - Snapshot tests lock both `status_v1` and `status_v2` output for every verdict fixture for Release N.
  - Documented in `docs/sec-scan/verdict-bands-migration.md` (created in this wish).

- **Shell-history exclusion governance (threat-model + ownership)** — The exclusion table is a *convenience* layer, not a security boundary. Threat model explicitly documented:
  - An attacker who can write to `.zsh_history` can dodge shell-history detection by writing lines that match the exclusion patterns (e.g. fake `npm uninstall`). **Mitigation:** shell-history is the weakest signal in the scoring model; `install` / `live-process` / `temp-artifact` findings carry ≥40x the weight per hit. An attacker can only suppress shell-history evidence, not the entire compromise footprint.
  - Exclusion patterns are reviewed + added by Namastex security team only. Community contributions go through the `automagik-dev/genie-signatures` review gate (owned by `sec-signature-registry` wish). Ad-hoc regex-spaghetti additions in PRs are rejected.
  - Every exclusion entry includes a `justification: string` field in addition to `pattern`, `reason`, `comment`. Snapshot tests lock the full exclusion table in CI; any addition requires PR + Namastex security reviewer sign-off.
  - Initial exclusion table in wish:
    - `^npm uninstall .*@automagik/genie$` — reason `remediation`, justification: operator removing the compromised package is not execution evidence
    - `^npm uninstall .*pgserve$` — same as above
    - `^rm -rf .*(node_modules|\.bun)/.*@automagik/genie` — reason `remediation`, justification: operator purging install is not execution
    - `^genie sec (scan|remediate|restore|rollback|verify-install|print-cleanup-commands)` — reason `investigation`, justification: operator running the scanner
    - `^: \d+:0;` — reason `ioc-probe`, justification: fc-style history-inspection prefix — the line describes a probe, not an execution. NOTE: lines that have a probe-like command *without* the `: <ts>:0;` prefix still get matched (the prefix is how zsh fc output is distinguished from real execution).

### OUT

- Scanner G3 (deletion pass + matcher collapse + hyperfine bench) — separate wish `sec-scan-progress` #1368
- Scanner G4 (events file + redaction + persistence + audit log) — same wish as G3
- Scanner G5 (`print-cleanup-commands` mode) — same wish as G3
- Signature registry (multi-incident database, signed signature packs, remote update) — separate wish `sec-signature-registry`
- Changes to any mutating subcommand (`remediate`, `rollback`, `quarantine`) — out of scope; this wish is scanner-only
- Changes to signing / verify-install — out of scope

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Sticky-line renderer only when `isatty(stderr)` | CI and piped output get clean append lines; humans get the AV experience |
| 2 | `phase.file` events emitted but not written to stdout JSON by default | Renderer needs per-file ticks; JSON envelope stays compact |
| 3 | Self-skip uses `realpathSync(process.argv[1])` at startup | Symlink-safe; one root to exclude |
| 4 | Version-gated matching made mandatory, not opt-in | Default posture on a clean host must be "clean verdict"; false "LIKELY COMPROMISED" on npm-install of clean-latest breaks trust immediately |
| 5 | Shell-history exclusions documented as a table, not regex spaghetti | Operators + contributors can audit / extend; each pattern has a comment explaining why |
| 6 | Scoring recalibration is a Decision, not a "mitigation" | Scoring is user-facing; changing the verdict band is a deliberate spec change and is documented in the wish |
| 7 | `--progress-compact` becomes the default on TTY | Matches industry AV UX; existing `--progress-verbose` preserved for power users and CI debugging |

## Success Criteria

- [ ] On a clean host (no compromised versions installed, no compromise-window shell history apart from investigation lines), `genie sec scan --all-homes --root "$PWD"` returns `Status: OBSERVED ONLY` or `CLEAN` with score ≤ 20.
- [ ] On a confirmed-compromised fixture (one compromised package installed), scan returns `Status: LIKELY COMPROMISED` with score ≥ 80.
- [ ] The scanner binary itself is never in the install or live-process findings list (self-skip verified).
- [ ] `pgserve@1.1.10` (clean) installed on the host produces zero `install` findings and zero `live-process` findings for pgserve.
- [ ] `pgserve@1.1.11` (compromised) installed on the host produces one `install` finding with version tag.
- [ ] Shell history line `npm uninstall -g @automagik/genie` does NOT produce a shell-history finding.
- [ ] Shell history line `curl telemetry.api-monitor.com` still produces a finding (that's real IOC execution).
- [ ] `scanNpmCache` and `scanBunCache` run exactly once, not once per home.
- [ ] Running the scanner in a TTY shows the sticky compact renderer; piping to `| cat` shows plain append-only lines with same information density.
- [ ] During a long phase (`scanTempArtifacts` on a populated /tmp), the renderer updates at least every 500ms with growing `files_scanned` / `bytes_scanned` counters and the current path.
- [ ] `--progress-json` still emits untouched NDJSON; JSON stdout envelope shape unchanged.
- [ ] Snapshot test locks the expected banner wording for `CLEAN`, `OBSERVED ONLY`, `LIKELY AFFECTED`, `LIKELY COMPROMISED`.
- [ ] Existing scanner tests (56 pass / 0 fail / 202 expects on hotfix merge) still pass + 20+ new tests covering self-skip, version-gating, shell-history exclusion, sticky renderer TTY-detect fallback.

## Execution Strategy

Single wave, 4 sequential groups. Each group lands its own PR to keep review surface small.

### Wave 1 (sequential)

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Self-path exclusion + version-gated matching + install-finding schema change |
| 2 | engineer | Shell-history exclusion table + scoring recalibration + banner wording + snapshot tests |
| 3 | engineer | Duplicate-phase de-dupe + `phase.tick` + `phase.file` telemetry emitters |
| 4 | engineer | Sticky-line renderer + `--progress-compact` flag + TTY detection + plain fallback + full-fixture screenshot capture |

## Execution Groups

### Group 1: Self-Path + Version-Gated Matching

**Goal:** the scanner never reports itself; package-name matches require version membership.

**Deliverables:**
1. `resolveSelfInstallRoot()` helper: `realpathSync(process.argv[1])` → walk up to the nearest `package.json` whose `name === '@automagik/genie'`. Cache the root. On any scan finding, compare the finding's path against `startsWith(selfRoot)` and skip+emit `self.skip` event if matched.
2. Rework `installFindings`, `liveProcessFindings`, `tempArtifactFindings` to take a `version` argument and match against `COMPROMISED_VERSIONS` per-package, not against package name alone.
3. For live-process: walk up from the executable path to the nearest `package.json` to resolve the package's version; tag each live-process finding with `package_version` and `version_matched: true|false|unknown`. Resolution algorithm (explicit fallback chain — in order):
   1. `realpathSync(executable_path)` — canonical path through symlinks (handles `node_modules/.bin/*` shims).
   2. Walk up from the resolved path looking for `package.json`. Read `name` + `version`. If `name` matches one of the tracked packages, use it.
   3. If the walk traverses a `.pnpm/` directory segment, extract the package name + version from the pnpm virtual-store path pattern (`.pnpm/<name>@<version>/node_modules/<name>/`).
   4. If the walk traverses a `.yarn/cache/` or `.yarn/berry-*` segment, fall back to reading `.yarn/install-state.gz` when present; else `version_unknown`.
   5. For a monorepo layout (multiple `package.json` while walking up), take the FIRST `package.json` whose `name` matches a tracked package — stops before reaching the workspace root.
   6. For `.bun/install/global/node_modules/<name>/` layout, version is read directly from the inner `package.json` (bun's global install mirror).
   7. Otherwise classify as `version_unknown: true` and downgrade the finding severity to `observed`.
   - Fixture coverage for each path: `test-fixtures/version-layouts/{npm, pnpm-virtual-store, yarn-berry, bun-global, monorepo-workspaces, symlink-bin, unresolvable}/`.
4. For temp artifacts where version is unrecoverable, classify as `observed` with `version_unknown: true`.
5. Detection-parity test against the existing CanisterWorm fixture: every finding today that's on a compromised version should still be produced; every self-detection should disappear; every version-unknown finding now classified correctly.

**Acceptance Criteria:**
- [ ] Running the scanner on a host with `@automagik/genie@<clean-version>` installed produces zero `install` findings for `@automagik/genie`.
- [ ] Running on a seeded `@automagik/genie@4.260421.35` (compromised) produces one `install` finding with `package_version: 4.260421.35` and `version_matched: true`.
- [ ] Live-process finding for `bun @automagik/genie/dist/genie.js` at clean version excluded via self-skip.
- [ ] Detection-parity snapshot passes against CanisterWorm fixture with the expected delta (self-skips disappear, version-gated matches stay).

**Validation:**
```bash
bun test scripts/sec-scan.test.ts
GENIE_SEC_SCAN_DISABLED=0 bun scripts/sec-scan.cjs --all-homes --root ./test-fixtures/clean-host --json | jq '.installFindings | length'   # expect 0
bun scripts/sec-scan.cjs --all-homes --root ./test-fixtures/canisterworm --json | jq '.installFindings[0].package_version'               # expect "4.260421.35"
```

**depends-on:** none

---

### Group 2: Shell-History Exclusion + Scoring Recalibration + Banner Wording

**Goal:** investigation / remediation commands are excluded; verdict bands reflect reality on a clean host.

**Deliverables:**
1. `SHELL_HISTORY_EXCLUSIONS` table in `scripts/sec-scan.cjs`: array of `{ pattern: RegExp, reason: string, comment: string }`. Every pattern must include a comment explaining why the line is NOT compromise evidence.
2. Pre-filter `scanShellHistories` input through the exclusion table. Excluded lines emit a `shell_history.excluded { line_hash, reason }` event.
3. Scoring function redesign:
   - Rename to `computeSuspicionScore`
   - Unit-test each signal in isolation
   - Implement the decay / weight table: `compromised` = 40 per kind, `affected` = 15 per kind, `observed` = 3 per kind, `version_unknown` = 0.1 each (cap 1.0), self-skip = 0
   - Verdict band: `CLEAN` < 20, `OBSERVED ONLY` 20–49, `LIKELY AFFECTED` 50–79, `LIKELY COMPROMISED` ≥ 80
4. Banner wording updates per the verdict bands.
5. Snapshot tests locking banner + score for every verdict band.

**Acceptance Criteria:**
- [ ] Shell-history line `npm uninstall -g @automagik/genie` excluded with reason `remediation`.
- [ ] Shell-history line `genie sec scan` excluded with reason `investigation`.
- [ ] Shell-history line `: 1776920603:0;curl telemetry.api-monitor.com` excluded with reason `ioc-probe` AND, if it represents a real execution attempt not prefixed by `:`, still produces a finding.
- [ ] On 2026-04-24 sample-output fixture (Felipe's machine), replay produces score < 20 and verdict `CLEAN` or `OBSERVED ONLY`.
- [ ] Snapshot test locks all four banner strings and score-to-band mapping.

**Validation:**
```bash
bun test scripts/sec-scan.test.ts
bun scripts/sec-scan.cjs --root ./test-fixtures/2026-04-24-felipe-mac-replay --json | jq '.summary.status'  # expect "OBSERVED ONLY" or "CLEAN"
```

**depends-on:** Group 1

---

### Group 3: Duplicate-Phase De-dupe + `phase.tick` + `phase.file` Telemetry

**Goal:** one phase-start per phase kind; per-file ticks available for the renderer.

**Deliverables:**
1. Refactor `main()` phase loop: collect all roots once, iterate inside each phase's function, emit `phase.start` and `phase.end` exactly once per phase kind.
2. Thread a `recordPhaseTick(delta)` helper into each phase function (already exists as `recordPhaseCapHit` scaffolding from the hotfix — extend it).
3. Emit `phase.tick` events at the lesser of `--progress-interval` cadence or every 128 files processed, whichever comes first.
4. Emit `phase.file` events on every file processed (hashed path when `--redact`).
5. Back-compat: existing `--progress-json` NDJSON stream format unchanged — new events append without removing fields.
6. Unit tests: each phase emits exactly one `phase.start` and `phase.end`; `phase.tick` cadence respected; `phase.file` count matches actual files processed.

**Acceptance Criteria:**
- [ ] `scanNpmCache` phase.start count in events = 1 (was 2 before)
- [ ] `scanBunCache` phase.start count in events = 1 (was 2 before)
- [ ] A phase processing 5000 files emits 5000 `phase.file` events and ≥ 5000/128 ≈ 39 `phase.tick` events.
- [ ] `--progress-interval 100` forces tick cadence ≤ 100ms even when fewer than 128 files are processed in that window.
- [ ] `--progress-json` NDJSON stream parses correctly on both pre-hotfix and post-wish output schemas (back-compat).

**Validation:**
```bash
bun test scripts/sec-scan.test.ts
bun scripts/sec-scan.cjs --progress-json --root ./test-fixtures/10k-files 2>/tmp/events.ndjson >/dev/null
jq -c 'select(.event == "phase.start") | .phase' /tmp/events.ndjson | sort | uniq -c    # each phase = 1
```

**depends-on:** Group 2

---

### Group 4: Sticky Renderer + `--progress-compact` + TTY Detection

**Goal:** the AV experience ships.

**Deliverables:**
1. `src/sec/ui/progress.ts` module:
   - `createProgressRenderer({ mode: 'compact'|'verbose'|'plain'|'off', stream, intervalMs })`
   - Compact: spinner frame, sticky header line, per-phase completion line; uses `\r` + clearline ANSI + cursor moves. Redrawn on every `phase.tick`.
   - Verbose: append-only; prints every `phase.tick` as a single line (legacy behaviour).
   - Plain: append-only, no ANSI (non-TTY default).
   - Off: no output.
2. TTY detection: `isatty(stream)` → compact; else plain.
3. CLI flag wiring:
   - `--progress-compact` forces compact even on non-TTY (human validation in CI logs etc.)
   - `--progress-verbose` forces verbose
   - `--no-progress` forces off
   - Default = compact-if-TTY-else-plain
4. Banner + verdict block written AFTER the last phase, below the final sticky snapshot.
5. Ensure `--progress-json` still emits identical NDJSON (the renderer only reads events, doesn't replace them).
6. Screenshot fixtures:
   - `docs/sec-scan/progress-ui-compact-tty.png`
   - `docs/sec-scan/progress-ui-plain-pipe.txt`
   - Replayable by running `bun scripts/sec-scan.cjs --progress-compact --root ./test-fixtures/10k-files`.

**Acceptance Criteria:**
- [ ] On a TTY, the rendered header updates at least every 500ms with live `files_scanned`, `bytes_scanned`, `current_path` (truncated to terminal width), and findings counter.
- [ ] On a non-TTY (`| cat`), output is plain append-only with same information density, no ANSI sequences.
- [ ] `--progress-verbose` produces today's behaviour (every event as a line).
- [ ] Empty phases (`scanNpmCache` on no npm cache) render a single `✓ scanNpmCache   0.0s   0 hits` line.
- [ ] The renderer never corrupts the terminal on SIGINT — cleanup writes a newline + cursor-show + clear-line.
- [ ] Snapshot test locks at least one compact-mode render for a 3-phase fixture.

**Validation:**
```bash
bun test scripts/sec-scan.test.ts src/sec/ui/progress.test.ts
bun scripts/sec-scan.cjs --progress-compact --root ./test-fixtures/10k-files  # human verification
bun scripts/sec-scan.cjs --root ./test-fixtures/10k-files | cat                # plain fallback
```

**depends-on:** Group 3

---

## QA Criteria

- [ ] Clean-host scan produces `CLEAN` or `OBSERVED ONLY` verdict with score < 20.
- [ ] Compromised-fixture scan produces `LIKELY COMPROMISED` with score ≥ 80 and version-matched install finding.
- [ ] Self-skip verified on both a `bun install -g @automagik/genie` layout and an `npm install -g @automagik/genie` layout.
- [ ] `pgserve@1.1.10` clean on host = 0 findings; `pgserve@1.1.11` compromised on host = 1 finding tagged with version.
- [ ] Shell-history exclusions: `npm uninstall`, `genie sec scan`, `fc`-style `: <ts>:0;` prefixed investigation lines all excluded with documented reasons.
- [ ] Real IOC execution (`curl telemetry.api-monitor.com` not prefixed by `:`) still produces a finding.
- [ ] Exactly one `phase.start` / `phase.end` pair per phase kind in the event stream.
- [ ] TTY scan shows sticky compact header updating at ≤ 500ms intervals; non-TTY shows plain append-only output.
- [ ] `--progress-json` back-compat preserved (schema parses against v1 + v2 consumers).
- [ ] Banner wording locked by snapshot tests for all four verdict bands.
- [ ] Running the scanner on Felipe's 2026-04-24 sample produces `CLEAN` / `OBSERVED ONLY`, not `LIKELY COMPROMISED`.

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Scoring recalibration downgrades a truly-compromised host by accident | Critical | Seeded compromised-fixture regression test in CI as merge gate; manual review on every signature change |
| Self-skip is too aggressive (excludes a legitimately-compromised copy of the scanner itself) | High | Self-skip only excludes the *running* binary's install root; a second compromised copy at a different path is still detected. Signature match on scanner bytes (hash) still fires regardless of self-skip. |
| Version resolution fails on unusual layouts (pnpm, yarn berry) | Medium | Fallback chain: walk up for `package.json`, else `.bun` metadata, else classify as `version_unknown` |
| Shell-history exclusion table becomes regex spaghetti | Medium | Structured table with per-entry comment; review gate requires justification on new exclusions |
| Sticky renderer corrupts terminal on SIGINT | Medium | Cleanup hook writes `\n\x1b[?25h\x1b[2K`; chaos test asserts terminal is readable post-SIGINT |
| Per-file `phase.file` events balloon NDJSON file size on 1M-file hosts | Medium | Events file already 0600 + explicit flag; document expected size. Add `--events-file-sample <N>` for reservoir sampling if operator wants compact NDJSON. |
| Banner wording change breaks downstream CI parsers | Low | Banner is human-facing; automation should parse `--json` envelope's `summary.status` field (stable schema) |
| Renderer interferes with stdout JSON when user pipes `--json | jq` | Low | Renderer writes only to stderr; stdout is untouched |

## Review Results

_Populated by `/review` after execution completes._

## Files to Create/Modify

```
scripts/sec-scan.cjs                          # modify: self-skip, version-gate, shell-history exclusions, scoring recalibration, phase.tick / phase.file emitters, duplicate-phase de-dupe
scripts/sec-scan.test.ts                      # modify: 20+ new tests
src/sec/ui/progress.ts                        # create: renderer module (compact / verbose / plain / off)
src/sec/ui/progress.test.ts                   # create: TTY detection, sticky rendering, SIGINT cleanup
src/term-commands/sec.ts                      # modify: --progress-compact flag + default selection
src/term-commands/sec.test.ts                 # modify: flag dispatch tests
docs/sec-scan/progress-ui-compact-tty.png     # create: screenshot fixture
docs/sec-scan/progress-ui-plain-pipe.txt      # create: plain-output fixture
test-fixtures/clean-host/                     # create: detection-parity fixture for clean machines
test-fixtures/2026-04-24-felipe-mac-replay/   # create: real-world false-positive replay
```
