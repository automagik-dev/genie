# Wish: Dependency Hygiene & Pgserve-Absence Resilience

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `dep-hygiene-and-resilience` |
| **Date** | 2026-05-05 |
| **Author** | felipe + council synthesis (architect / simplifier / ergonomist / operator / sentinel) |
| **Appetite** | medium (~6 surgical patches across 4 files + 1 pgserve-side PR + manifest cleanup) |
| **Branch** | `wish/dep-hygiene-and-resilience` |
| **Repos touched** | `genie` (primary); `pgserve` (one wrapper PR — out of this wish's branch but blocks G1 acceptance) |
| **Design** | _No brainstorm — direct wish_ |

## Summary

Today's outage exposed a class of silent failure: pgserve's bun-runtime resolution can fail at install time, and when it does, genie's `doctor` reports green while the TUI renders blank chrome and `--fix` no-ops. Pgserve stays — Postgres earns its keep through LISTEN/NOTIFY, real concurrent writers, JSONB, and audit replay; this wish is **not** a pgserve-removal exercise. What this wish delivers is the dependency-hygiene and degrade-path work that makes today's failure mode either impossible (PATH fallback, log permissions, postinstall pinning) or loudly visible (real doctor probes, TUI degraded-mode banner). It is a companion to `pgserve-canonical-cutover` — the cutover separates ownership; this wish hardens the seams the cutover leaves intact.

## Scope

### IN

- `pgserve-wrapper.cjs` falls back to `$PATH` `bun` (and `$BUN_INSTALL/bin/bun`) before declaring failure — drives a PR upstream in the pgserve repo; genie pins to the patched version once released.
- TUI renders a full-screen "pgserve unreachable" panel with literal recovery commands instead of empty chrome when the pgserve probe fails on boot.
- `genie doctor` runs **real probes** for the daemon: opens the UDS, runs `SELECT 1`, exec's `bun --version`. Existence-on-disk no longer counts as a green check. `genie doctor --fix` either takes a deterministic action or prints a copy-paste recovery block — never silent no-op.
- `~/.genie/hook-fallback.log` chmod to `0600` and apply token-shape redaction at write time (`gh[ps]_…`, `sk-…`, `glpat-…`, generic 40+ char hex) — sentinel found this file world-readable today with full bash command lines.
- All postinstall-downloaded binaries (`postinstall-tmux.js`, `postinstall-hook-binary.js`) verify a SHA-256 pinned in `package.json` before chmod +x. Pin failure aborts the install.
- `pm2` declared as a runtime `dependency` in `package.json` (it is currently a hard prereq shelled out to from `src/genie-commands/install.ts` but not declared anywhere — install fails opaquely if the user's bun-global doesn't have it). `genie install`, `genie update`, and `genie doctor --fix` self-redeploy pm2 via `bun add -g pm2@<pinned>` when missing or below pinned minimum — pm2 runs user-scoped, so no sudo is needed.
- **pm2 becomes the canonical supervisor lock for `genie-serve`**: once `genie install` registers the pm2 entry, no other code path can spawn an orphan `genie-serve`. The CLI, hooks, `genie doctor --fix`, and TUI auto-spawn all detect an existing pm2-registered entry and route recovery through `pm2 restart genie-serve` instead of forking a detached daemon. Live observed today: agents repeatedly spawned orphan `genie-serve` processes whose pidfile blocked pm2's supervised entry, leaving pm2 in a stopped/loop state — this wish forbids that pattern by construction.
- **`genie serve start` does not detach when invoked under pm2**. The current double-fork pattern is what makes pm2 see "exit 0" and treat the supervised entry as crashed; the loop never converges. Under pm2 supervision (detected via `PM2_HOME` / `pm_id` env vars or PPID = pm2 daemon), the command runs in the foreground until SIGTERM and never writes the global `~/.genie/serve.pid`.
- **Pidfile sanity check**: on every read of `~/.genie/serve.pid`, verify the recorded PID is alive AND that its parent chain leads to either pm2's daemon (when pm2 owns the entry) or to a TTY-attached genie process (developer foreground). Any PID whose parent is `init` (orphan re-parented) is treated as stale and overwritten.
- Audit `package.json` `dependencies` against the actual `dist/genie.js` bundle. Anything externalized but not consumed at runtime moves to `devDependencies`. Anything inlined by `bun build` moves to `devDependencies`. Result published to repo as `docs/_internal/dep-audit.md`.
- `trustedDependencies` pruned to the minimum that genie actually needs at install time — `@biomejs/biome` removed (devDep, no install-time code), `bun` re-evaluated post-cutover.
- Doctor + TUI failure-paths exit code standardized: `EX_UNAVAILABLE = 69` for pgserve-unreachable, distinct from `EX_USAGE = 64` and `1` (generic).

### OUT

- **Removing pgserve / switching to SQLite** — explicitly rejected. Postgres features are load-bearing. Questioner's adversarial position was useful to hear; the decision is no.
- **Release pipeline (auto-publish from dev, canary tags, fresh-host smoke matrix)** — orthogonal concern, separate wish if pursued. Today's outage was *not* caused by `next` drift in any way that this wish's changes depend on. The wrapper PATH fallback alone retroactively prevents the outage regardless of release cadence.
- **Distribution channels (`curl | sh` installer, GitHub Releases binaries, Homebrew formula)** — orthogonal; npm-via-bun-add stays primary in this wish.
- **TUI architecture refactor (drop react/react-dom, opentui consolidation)** — separate concern; the degrade-mode panel adds bounded code, doesn't touch the rendering stack.
- **Replacing pm2 with systemd-user / launchd** — pm2 stays as the canonical supervisor. Operator's "pm2 should be optional" position from the council is rejected: pm2 runs user-scoped (no sudo), is already a hard prereq today, and being npm-installed lets genie self-redeploy it from `install`/`update`/`doctor --fix` on any host where bun is present. Replacing it with OS-level supervisors would *add* a permission ladder we don't currently need.
- **UDS+TCP escape hatch on pgserve** — pgserve's call, not genie's; tracked separately if needed.
- **Generic dependency upgrade sweep** — explicitly not; this wish only audits and reclassifies, doesn't bump versions.
- **Migration tooling for `~/.genie/data/pgserve` legacy data** — owned by `pgserve-canonical-cutover` G1.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Pgserve stays; Postgres is a load-bearing dependency | LISTEN/NOTIFY, JSONB queries, real concurrent writers, audit replay. Questioner's SQLite proposal explicitly rejected. |
| 2 | PATH fallback in wrapper is a pgserve-repo PR, not a genie monkey-patch | Fixing it in pgserve makes every consumer benefit and removes a "genie owns pgserve" anti-pattern. Genie pins to the patched version. |
| 3 | TUI degrade pattern matches hook degrade pattern (log + render + exit non-zero) | Two different degrade contracts within the same product is the bug; one contract everywhere. |
| 4 | Doctor must execute real probes, not file-existence checks | Today doctor reported all green while pgserve was dead for hours. Trust contract: green means "I just proved it." |
| 5 | Hook-fallback log permissions tightened in this wish, not deferred | Sentinel's finding is a credential dragnet today on multi-user boxes; two-line fix, no reason to defer. |
| 6 | Postinstall binary pinning is mandatory, not optional | Same code path that produced empty `bin/bun` today is the path a tarball-swap attack would exploit. Pin-or-fail closes both. |
| 7 | Drop `@biomejs/biome` from `trustedDependencies` | Devdep with no install-time role on end-user machines. Smaller allowlist = smaller install-time RCE surface. |
| 8 | Release-pipeline concerns (auto-publish, canary, smoke matrix) are out of scope | Council off-topic drift; orthogonal to dependency hygiene. Track separately if pursued. |
| 9 | This wish lands AFTER `pgserve-canonical-cutover` G1–G3 | Cutover establishes consumer-only ownership; this wish hardens the consumer's failure handling. Reverse order would harden a model about to change. |
| 10 | pm2 stays canonical and becomes a declared `dependency`; genie self-redeploys it from install / update / doctor --fix | pm2 is a user-scoped supervisor (no sudo), already a hard prereq via `install.ts`, and npm-installable. Declaring it removes today's "fails opaquely if pm2 missing" gap and makes recovery deterministic. systemd-user / launchd would require per-OS code paths and elevated-privilege handling we don't currently need. |
| 11 | Once pm2 owns the `genie-serve` entry, no other code path can spawn an orphan `genie-serve`; `genie serve start` invoked outside pm2 routes through `pm2 restart` instead of forking | Today's failure mode: `genie serve start` double-forks → pm2's child exits with code 0 → pm2 treats as crash → restart loop → orphan daemon owns `~/.genie/serve.pid` → next restart sees "already running" and exits → loop forever. The decision tree (`pm2 entry registered + not running under pm2 → route through pm2`) closes this by construction. The wish is the user's directive: pm2 is the source of truth, agents/hooks/--fix paths must not override it. |
| 12 | The pidfile at `~/.genie/serve.pid` is honored only when its PID's parent chain matches the canonical supervisor or an attached TTY | Orphan re-parenting to init is the giveaway that a daemon detached from its supervisor. Treating any init-parented PID as stale prevents resurrected orphans from blocking pm2's clean restart. Cheap check (`/proc/<pid>/stat` or `ps -o ppid`), zero-runtime-cost on the happy path. |

## Success Criteria

- [ ] `pgserve-wrapper.cjs` resolves bun via `$PATH` / `$BUN_INSTALL/bin/bun` when its node_modules search misses; demonstrated by simulating today's empty-`@oven/bun-linux-x64/bin/bun` state and observing pgserve start successfully.
- [ ] Killing pgserve and launching the TUI renders a recovery panel with the literal `bun add -g pgserve@^2 && pgserve install && pgserve start` block. Never blank chrome.
- [ ] `genie doctor` against a stopped pgserve reports RED with reason `pgserve UDS probe failed: <socket-path> ENOENT` and exit code `69`. Against a running pgserve, reports GREEN only after a successful `SELECT 1` round-trip.
- [ ] `genie doctor --fix` either restarts pgserve via the canonical supervisor command, or prints the 5-line recovery block and exits non-zero. Never silent no-op.
- [ ] `ls -l ~/.genie/hook-fallback.log` shows mode `-rw-------` (0600). New entries containing `gh[ps]_`, `sk-`, `glpat-`, or 40+ hex-char tokens are written redacted as `[REDACTED:<kind>]`.
- [ ] `scripts/postinstall-tmux.js` and `scripts/postinstall-hook-binary.js` verify a SHA-256 from `package.json` `binarySha256` block before chmod +x. A modified tarball or a download-corrupted binary aborts the install with a clear error.
- [ ] `pm2` is listed in `package.json` `dependencies` with a pinned minimum. On a host where `bun add -g pm2` was never run, `genie install` self-redeploys pm2 (`bun add -g pm2@<pinned>`), then proceeds; `genie update` does the same on every update path; `genie doctor --fix` re-runs the same redeploy step idempotently when pm2 is missing or below the pinned minimum. None of these paths require sudo.
- [ ] After `genie install` registers the pm2 entry, running `genie serve start` (or any code path that triggers auto-spawn) NEVER produces an orphan daemon. Either (a) it routes through `pm2 restart genie-serve` and reports the pm2 result, or (b) when invoked BY pm2 (env `pm_id` / `PM2_HOME` set), it runs in foreground without detaching. Verified by a regression test that asserts no `dist/genie.js serve` process has parent PID 1 immediately after a forced restart loop.
- [ ] The pidfile at `~/.genie/serve.pid` is treated as authoritative ONLY when the recorded process's parent chain matches the canonical supervisor (pm2 daemon) or an attached TTY. An orphan PID re-parented to init is overwritten on next start, never honored.
- [ ] `docs/_internal/dep-audit.md` exists, lists every `dependencies` entry as either RUNTIME (consumed by `dist/genie.js` at runtime, externalized intentionally) or BUNDLED (inlined by `bun build`, should be devDep) or PEER (sibling tool, should not be a dep at all). Anything in BUNDLED has been moved to `devDependencies` in this PR.
- [ ] `trustedDependencies` no longer includes `@biomejs/biome`. `bun test`, `bun run build`, `bun run check` all pass.
- [ ] `bun run check` (typecheck + lint + dead-code + test) passes. New tests cover doctor probes, TUI degrade panel, log redaction, postinstall SHA mismatch, and wrapper PATH fallback.
- [ ] CHANGELOG entry documents the security-relevant changes (log perms, postinstall pinning, allowlist shrink) under a `Security` heading.

## Execution Strategy

### Wave 1 — Independent hardening (parallel; no cross-deps)

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | pgserve-wrapper PATH fallback (PR against pgserve repo) |
| 2 | engineer | TUI pgserve-unreachable degrade panel |
| 3 | engineer | Hook-fallback log perms + token redaction |
| 4 | engineer | Postinstall binary SHA-256 pinning |
| 5 | engineer | pm2 declared dep + install/update/doctor self-redeploy |

### Wave 2 — Builds on Wave 1 (sequential)

| Group | Agent | Description |
|-------|-------|-------------|
| 6 | engineer | Doctor real probes + standardized exit codes (depends on G2's degrade-panel error format and G5's pm2-redeploy helper for `--fix`) |
| 7 | engineer | Dependency audit + manifest cleanup + trustedDependencies prune (audits the manifest after G5 has added pm2) |

### Wave 3 — QA + review

| Group | Agent | Description |
|-------|-------|-------------|
| 8 | qa | Run full check suite + simulate today's outage; verify all success criteria |
| (review) | reviewer | Wish-criteria validation against PR diff |

---

## Execution Groups

### Group 1: pgserve-wrapper PATH fallback

**Goal:** When pgserve's wrapper cannot find bun in its node_modules tree, fall back to `$PATH` and `$BUN_INSTALL/bin/bun` before failing. Eliminates today's outage class permanently for every pgserve consumer.

**Deliverables:**
1. PR against `automagik-dev/pgserve` (sibling repo) modifying `bin/pgserve-wrapper.cjs`:
   - After the existing 7-path search, append fallback to `process.env.BUN_INSTALL ? join(process.env.BUN_INSTALL, 'bin', bunBin) : null` and `which bun` (via `execSync('command -v bun')`).
   - On fallback hit, emit one stderr line `[pgserve] using PATH bun (<resolved-path>); local @oven/bun-* missing or broken` so operators see the degraded resolution.
   - Failure message expanded: list both the `node_modules` paths AND the PATH lookup result.
2. Once pgserve PR merges and a patch version ships, bump genie's pinned `pgserve` minimum. Where the bump lands depends on cutover state: if `pgserve-canonical-cutover` G2 has already moved pgserve to `peerDependencies`, update there; otherwise bump the minimum in `dependencies`. Document the resolved location and the minimum version in `docs/_internal/dep-audit.md`.
3. Reproduction harness in `scripts/repro-empty-oven-bun.sh`: simulates today's state by truncating `node_modules/@oven/bun-linux-*/bin/bun` to zero bytes and runs `pgserve --version` to assert successful PATH fallback.

**Acceptance Criteria:**
- [ ] pgserve PR merged + new pgserve version released.
- [ ] `scripts/repro-empty-oven-bun.sh` exits 0 against the patched wrapper, exits non-zero (with clear error) against the unpatched wrapper.
- [ ] genie's `package.json` (or post-cutover `peerDependencies`) bumps the minimum pgserve to the patched version.

**Validation:**
```bash
# Against patched wrapper, simulate today's outage and assert recovery
bash scripts/repro-empty-oven-bun.sh
# Expect: "[pgserve] using PATH bun (/home/.../bin/bun); local @oven/bun-* missing or broken"
# Expect: pgserve version output, exit 0
```

**depends-on:** none

---

### Group 2: TUI pgserve-unreachable degrade panel

**Goal:** TUI never renders empty chrome when pgserve is unreachable. Connect-fail → full-screen recovery panel → exit non-zero.

**Deliverables:**
1. `src/tui/index.ts` — wrap pgserve client init in try/catch matching the hook's degrade pattern (`src/hooks/dispatch-client.ts:105-109`). On failure, mount a single full-screen component instead of the normal layout.
2. New component `src/tui/components/PgserveUnreachable.tsx`:
   - Shows the literal recovery commands from the canonical install (`bun add -g pgserve@^2 && pgserve install && pgserve start`).
   - Shows the probed UDS path and the underlying error code (e.g. `ENOENT`, `ECONNREFUSED`).
   - Shows `genie doctor --verbose` as the next-step diagnostic.
   - Quitting the TUI exits with code `69` (`EX_UNAVAILABLE`).
3. New test `src/tui/__tests__/pgserve-unreachable.test.tsx` — mounts the TUI with a mocked failing pgserve client and asserts the panel renders, never the normal chrome.

**Acceptance Criteria:**
- [ ] Stopping pgserve and launching the TUI renders the recovery panel within 2 seconds.
- [ ] Quitting the unreachable-state TUI returns exit code 69.
- [ ] No code path in `src/tui/` mounts the normal layout when the pgserve probe fails on boot.
- [ ] Test passes.

**Validation:**
```bash
# Manual repro
pgserve stop  # or pm2 stop pgserve, depending on cutover state
genie  # expect recovery panel; quit; echo $? -> 69

# Automated
bun test src/tui/__tests__/pgserve-unreachable.test.tsx
```

**depends-on:** none.

---

### Group 3: Hook-fallback log security

**Goal:** `~/.genie/hook-fallback.log` stops being a credential dragnet. Mode `0600`, token-shape redaction at write time.

**Deliverables:**
1. `src/hooks/dispatch-client.ts` — at log-open time, ensure `chmod 0600` on the file (atomic create-or-chmod). On upgrade, if a pre-existing `hook-fallback.log` is found with looser permissions, chmod it to `0600` on first open after upgrade (one-time migration, logged as a stderr line so operators see the fix). Document why in a one-line comment (load-bearing security boundary).
2. Add `redactTokenShapes(text: string): string` helper in `src/hooks/dispatch-client.ts` (or a new `src/hooks/redaction.ts` if it grows) that replaces matches of:
   - `gh[ps]_[A-Za-z0-9]{30,}` → `[REDACTED:gh-token]`
   - `sk-[A-Za-z0-9-]{20,}` → `[REDACTED:sk-token]`
   - `glpat-[A-Za-z0-9_-]{20,}` → `[REDACTED:glpat]`
   - `\\b[a-f0-9]{40,}\\b` → `[REDACTED:hex]` (broad catch for sha-shaped or hex-secret-shaped strings)
3. Apply redaction to the `command` field of every fallback log entry before write.
4. New test `src/hooks/__tests__/redaction.test.ts` covering each token shape + a "no false positives on plain English" case.

**Acceptance Criteria:**
- [ ] `ls -l ~/.genie/hook-fallback.log` shows mode `-rw-------`.
- [ ] An entry constructed from a `gh pr create` command with `gh_pat_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` in the args is written with `[REDACTED:gh-token]` substituted.
- [ ] Plain English commands without secrets pass through unchanged.
- [ ] Test passes.

**Validation:**
```bash
# Trigger a hook with a synthetic secret in the command
GENIE_AGENT_NAME=test bash -c 'echo "{}" | dist/dispatch.js' || true
ls -l ~/.genie/hook-fallback.log
grep REDACTED ~/.genie/hook-fallback.log

bun test src/hooks/__tests__/redaction.test.ts
```

**depends-on:** none.

---

### Group 4: Postinstall binary SHA-256 pinning

**Goal:** Every binary downloaded by genie's postinstall scripts is verified against a pinned SHA-256 before being made executable. Pin failure aborts install.

**Deliverables:**
1. New top-level `package.json` block:
   ```json
   "binarySha256": {
     "tmux-3.5a-linux-x64": "<sha256>",
     "tmux-3.5a-darwin-arm64": "<sha256>",
     "hook-binary-<version>-linux-x64": "<sha256>"
   }
   ```
2. `scripts/postinstall-tmux.js` — after download, before `chmod +x`:
   - Compute SHA-256 of the downloaded file.
   - Read the expected SHA from `package.json` `binarySha256[<key>]`.
   - On mismatch: delete the file, print `Error: <key> SHA-256 mismatch — expected <pinned>, got <actual>. Aborting install.`, exit 1.
3. `scripts/postinstall-hook-binary.js` — same pattern. If the script *compiles* the binary locally (rather than downloading), it's exempt from pinning but must log the source path so operators can verify by other means.
4. `scripts/postinstall-migrations.js` audit — confirm it doesn't fetch external resources; if it does, apply the same pinning.
5. CI step that recomputes the SHAs on every release and surfaces drift in the PR diff so updates are explicit.

**Acceptance Criteria:**
- [ ] Modifying any pinned binary by one byte and re-running `genie install` aborts with a clear SHA mismatch error and exit 1.
- [ ] An unmodified install completes successfully.
- [ ] `package.json` `binarySha256` block is documented in the install README.
- [ ] No hardcoded SHAs in `.js` source files — all live in `package.json`.
- [ ] CI workflow file (e.g. `.github/workflows/binary-sha-drift.yml`) exists, triggers on release-tag PRs, and surfaces SHA drift as a deliberate diff comment.

**Validation:**
```bash
# Tamper test
cp ~/.genie/bin/tmux ~/.genie/bin/tmux.bak
echo "tampered" >> ~/.genie/bin/tmux
node scripts/postinstall-tmux.js  # expect: SHA mismatch error, exit 1
mv ~/.genie/bin/tmux.bak ~/.genie/bin/tmux

# Clean install
rm -rf ~/.genie/bin && node scripts/postinstall-tmux.js  # expect: success
```

**depends-on:** none.

---

### Group 5: pm2 lifecycle — declared dep, self-redeploy, canonical-supervisor lock

**Goal:** pm2 stops being an undeclared hard prereq. It becomes a `dependency` in `package.json`, genie self-redeploys it from install / update / doctor --fix, and once a `genie-serve` pm2 entry is registered, **no other code path can spawn an orphan `genie-serve`**. The double-fork bug that caused today's pm2 restart-loop is eliminated. pm2 becomes the single source of truth for the daemon lifecycle. Recovery requires no sudo.

**Deliverables:**

*Sub-goal A — declared dep + redeploy (foundational)*
1. `package.json` — add `pm2` to `dependencies` with a pinned minimum (current local install is `6.0.14`; pin `"pm2": "^6.0.14"` unless dep-audit in G7 finds reason to tighten).
2. New helper module `src/lib/pm2-bootstrap.ts` exporting:
   - `pm2IsAvailable(): boolean` (replace the local copies in `install.ts`/`doctor.ts` so there is one definition).
   - `pm2InstalledVersion(): string | null`.
   - `ensurePm2Installed(opts: { minVersion: string; allowInstall: boolean }): { action: 'present' | 'installed' | 'failed'; version: string | null; message?: string }` — when missing or below `minVersion` and `allowInstall=true`, runs `bun add -g pm2@<minVersion>` (no sudo), reports the resulting version. When `allowInstall=false`, returns the diagnosis only.
3. `src/genie-commands/install.ts` — replace the existing pm2 check (currently at `pm2IsAvailable()` line ~92) with `ensurePm2Installed({ minVersion, allowInstall: true })`. On `action: 'failed'` exit with the canonical install hint plus the underlying error.
4. `src/genie-commands/update.ts` — at the top of every update path (next / via-bun / git), call `ensurePm2Installed({ minVersion, allowInstall: true })` before any pm2 invocation. If install fails, abort the update with a clear error.
5. `src/genie-commands/doctor.ts` — under `--fix`, when pm2 is missing or below `minVersion`, call `ensurePm2Installed({ minVersion, allowInstall: true })`. Without `--fix`, doctor reports RED with the underlying diagnosis (not auto-installed).

*Sub-goal B — canonical-supervisor lock (the orphan-prevention work)*

6. Extend `src/lib/pm2-bootstrap.ts` with:
   - `pm2GenieServeRegistered(): { registered: boolean; status?: 'online' | 'stopped' | 'errored' | 'waiting'; pid?: number; pm_id?: number }` — calls `pm2 jlist`, finds the `genie-serve` entry, returns its current state.
   - `runningUnderPm2(): boolean` — returns true when `process.env.pm_id` is set OR when the parent process is the pm2 daemon. Used to detect "I am pm2's child" vs "I am a user-invoked CLI."
   - `routeServeStartThroughPm2(): { action: 'restarted' | 'started' | 'noop' | 'unsupported'; message: string }` — when a pm2 entry is registered, runs `pm2 restart genie-serve` (or `pm2 start <id>` if stopped) and returns the result. When no entry is registered, returns `unsupported`.
7. `src/term-commands/serve.ts` (`genie serve start` handler) — replace the current behavior with this decision tree, in order:
   1. If `pm2GenieServeRegistered().registered === true` AND `runningUnderPm2() === false`: print `genie-serve is registered under pm2; routing through pm2 restart genie-serve.` then call `routeServeStartThroughPm2()` and exit with its result code. **Never spawn a detached daemon in this branch.**
   2. If `runningUnderPm2() === true`: run all services in the foreground, never write `~/.genie/serve.pid`, install signal handlers for `SIGTERM`/`SIGINT` for clean shutdown. **Never `setsid` / never double-fork.**
   3. Otherwise (no pm2 entry, no pm2 supervision — developer foreground): existing foreground behavior; pidfile is fine because there's no supervisor to confuse.
8. New helper `src/lib/serve-pidfile.ts` (or extend existing module if one exists) — when reading `~/.genie/serve.pid`:
   - Validate the recorded PID is alive (`process.kill(pid, 0)`).
   - Read `/proc/<pid>/stat` (Linux) / `ps -o ppid <pid>` (cross-platform fallback) to get parent PID.
   - If parent is `1` (orphan re-parented to init) AND `pm2GenieServeRegistered().registered === true`, treat the pidfile as STALE, ignore it, log a stderr warning ("orphan genie-serve detected at PID X — overwriting stale pidfile, recovery via pm2"), and proceed.
   - If pidfile validates, honor it as today.
9. `src/hooks/handlers/auto-spawn.ts` and `src/genie-commands/doctor.ts --fix` paths that invoke `genie serve start`: route through `routeServeStartThroughPm2()` when a pm2 entry is registered. **Never bypass pm2 by calling `genie serve start` directly when pm2 owns the entry.**
10. New tests in `src/lib/__tests__/pm2-bootstrap.test.ts`:
   - "ensurePm2Installed reports `present` when pm2 is at or above minVersion".
   - "ensurePm2Installed reports `installed` after a missing-pm2 path runs `bun add -g`".
   - "ensurePm2Installed reports `failed` and never throws when `bun add -g` fails (e.g. offline)".
   - "ensurePm2Installed with allowInstall=false never invokes a child process".
   - "pm2GenieServeRegistered returns `registered: false` when pm2 jlist has no entry".
   - "pm2GenieServeRegistered returns the entry status when registered".
   - "runningUnderPm2 returns true when env.pm_id is set, false otherwise".
   - "routeServeStartThroughPm2 returns 'restarted' for an online entry, 'started' for a stopped entry, 'unsupported' for no entry".
11. New regression test `src/term-commands/__tests__/serve-orphan-prevention.test.ts`:
   - With pm2 entry mocked as registered, calling `genie serve start` does NOT spawn a detached daemon (assert no `dist/genie.js serve` process with PPID=1 after the call).
   - With pm2 entry mocked as unregistered, calling `genie serve start` runs in foreground in the developer-mode path.
   - With `env.pm_id` set, calling `genie serve start` runs in foreground and never writes `~/.genie/serve.pid`.

**Acceptance Criteria:**
- [ ] `pm2` is in `package.json` `dependencies` with a pinned minimum.
- [ ] On a host where pm2 was uninstalled (`bun remove -g pm2`), `genie install` runs the self-redeploy and completes successfully without sudo.
- [ ] Same path works for `genie update` and `genie doctor --fix`.
- [ ] No `pm2 --version` exec calls remain duplicated across `install.ts` / `doctor.ts` / `update.ts` — all routed through `pm2-bootstrap.ts`.
- [ ] After `genie install` (which registers the pm2 entry), running `/home/genie/.bun/bin/genie serve start --headless --no-tui --no-interactive` from any non-pm2 shell prints "routing through pm2 restart genie-serve" and exits without forking a detached daemon. `pgrep -f 'dist/genie.js serve'` shows zero processes with PPID=1.
- [ ] Manual `pm2 restart genie-serve` (after a forced stop) brings the entry back online and stays online for at least 60 seconds (no restart loop).
- [ ] When the pidfile contains an orphan PID re-parented to init, the next pm2 restart cycle ignores the stale pidfile and proceeds without reporting "already running."
- [ ] All eleven new tests pass (eight in `pm2-bootstrap.test.ts`, three in `serve-orphan-prevention.test.ts`).

**Validation:**
```bash
# Sub-goal A: declared dep + redeploy
bun remove -g pm2
genie install 2>&1 | grep -E "pm2 .* installed|action: 'installed'"
which pm2 && pm2 --version

bun remove -g pm2
genie update --next 2>&1 | grep -E "pm2 .* installed"

bun remove -g pm2
genie doctor --fix 2>&1 | grep -E "pm2 .* installed"

# Sub-goal B: canonical-supervisor lock
genie install                                          # registers pm2 entry
pm2 stop genie-serve
genie serve start --headless --no-tui --no-interactive 2>&1 | grep "routing through pm2"
pgrep -fa 'dist/genie.js serve' | grep -v ' 1 ' || echo "no orphans (PPID != 1) — PASS"
pm2 restart genie-serve
sleep 60
pm2 describe genie-serve | grep -E "status.*online"  # expect online and stable

# Tests
bun test src/lib/__tests__/pm2-bootstrap.test.ts
bun test src/term-commands/__tests__/serve-orphan-prevention.test.ts
```

**depends-on:** none

---

### Group 6: Doctor real probes + standardized exit codes

**Goal:** `genie doctor` only reports green when it has *just proven* each check. `--fix` is deterministic or instructive — never silent no-op.

**Deliverables:**
1. `src/genie-commands/doctor.ts`:
   - Replace any `existsSync()`-only check for pgserve with a UDS connect + `SELECT 1` round-trip via the existing `postgres` client. Timeout 2s; on fail report `RED: pgserve UDS probe failed (<reason>)`.
   - Add a `bun --version` exec check; on fail or version <`engines.bun`, report RED.
   - Add a wrapper-resolution check: confirm `pgserve --version` exec succeeds (this transitively validates G1's PATH fallback).
   - For the existing tmux check, run `tmux -V` rather than just checking the binary exists.
2. Standardize exit codes in `src/genie-commands/doctor.ts` and `src/term-commands/serve.ts`:
   - All-green → exit 0.
   - Pgserve unreachable → exit 69 (`EX_UNAVAILABLE`).
   - Configuration / arg errors → exit 64 (`EX_USAGE`).
   - Generic failure → exit 1.
3. `genie doctor --fix` rewrite:
   - For each RED check, attempt the canonical fix (e.g. `pm2 restart pgserve` or whatever the cutover specifies).
   - If the fix is not safe to attempt automatically, print the 5-line copy-paste recovery block from the operator's recommendation:
     ```
     pm2 status pgserve || bun add -g pm2
     pgserve --version || bun add -g pgserve@^2
     pm2 delete pgserve 2>/dev/null; pgserve install
     pm2 logs pgserve --lines 50 --nostream
     genie doctor
     ```
   - If everything is green, print `Nothing to fix. Run \`genie doctor --verbose\` for diagnostic detail.` and exit 0.
   - Never exit 0 silently when checks are RED.
4. New tests `src/genie-commands/doctor.test.ts`:
   - "doctor against running pgserve reports green only after SELECT 1"
   - "doctor against stopped pgserve reports red with EX_UNAVAILABLE"
   - "doctor --fix on green system prints 'Nothing to fix' and exits 0"
   - "doctor --fix on red system prints recovery block and exits non-zero"

**Acceptance Criteria:**
- [ ] All four new tests pass.
- [ ] `genie doctor` against today's outage state (empty `bin/bun`, dead pgserve) reports RED with the precise reason; against a healthy system reports GREEN only after a real probe.
- [ ] `genie doctor --fix` exits 0 only when all checks are green.
- [ ] Exit codes documented in `docs/_internal/cli-exit-codes.md`.

**Validation:**
```bash
pgserve stop
genie doctor; echo $?  # expect 69
genie doctor --fix     # expect recovery block, exit non-zero

pgserve start
genie doctor; echo $?  # expect 0

bun test src/genie-commands/doctor.test.ts
```

**depends-on:** Group 1, Group 2, Group 5

---

### Group 7: Dependency audit + manifest cleanup + trustedDependencies prune

**Goal:** Every entry in `package.json` `dependencies` is justified. Anything inlined by `bun build` moves to `devDependencies`. `trustedDependencies` shrinks to the install-time minimum.

**Deliverables:**
1. **Capture pre-audit reference** as the first step: run `bun run build` against the unchanged manifest, record `sha256sum dist/genie.js` and the byte size into the top of `docs/_internal/dep-audit.md` under a `## Pre-audit reference` heading. The post-audit comparison criterion below is verified against this captured value.
2. New `scripts/audit-deps.ts` that:
   - Builds the bundle (`bun run build`).
   - For each `dependencies` entry, checks whether the bundle's source map (or static analysis of `dist/genie.js`) references that package.
   - Classifies each as RUNTIME (referenced + intentionally externalized), BUNDLED (referenced + inlined), or UNUSED (not referenced).
   - Writes `docs/_internal/dep-audit.md` with the table + rationale per entry.
3. `package.json` — move BUNDLED entries to `devDependencies`, delete UNUSED entries (with one-line justification in the audit). RUNTIME entries stay where they are. Notable candidates flagged by the council:
   - `react`, `react-dom`, `@opentui/keymap`, `@opentui/react` — verify whether actually consumed by TUI at runtime; if `bun build` inlines them, move to dev.
   - `@tauri-apps/api` — verify any genuine runtime use; if none, delete.
   - `uuid` — `crypto.randomUUID()` exists; if no other call sites, delete and inline.
   - `js-yaml`, `chokidar`, `systeminformation` — verify, classify, act.
   *(Each decision documented in the audit; nothing deleted without justification.)*
4. `package.json` — `trustedDependencies` updated:
   - Remove `@biomejs/biome` (devDep, no install-time role for end users).
   - Re-evaluate `bun` post-cutover (if pgserve no longer pulls bun transitively, the allowlist may be unnecessary).
5. CHANGELOG entry under `Security` section.

**Acceptance Criteria:**
- [ ] `bun run build` produces a `dist/genie.js` byte-identical (or smaller) than the pre-audit reference captured in deliverable #1, with the comparison shown in `dep-audit.md`.
- [ ] `bun test` passes.
- [ ] `bun run typecheck` passes.
- [ ] `docs/_internal/dep-audit.md` exists, every `dependencies` entry classified.
- [ ] `package.json` `trustedDependencies` reduced (or empty if post-cutover).
- [ ] CHANGELOG `Security` entry references the trusted-deps change.

**Validation:**
```bash
bun run scripts/audit-deps.ts
bun run build && stat -c '%s' dist/genie.js  # compare against pre-audit
bun run check
test -f docs/_internal/dep-audit.md
```

**depends-on:** Group 1, Group 3, Group 4, Group 5

---

### Group 8: QA — full validation against today's outage scenario

**Goal:** Prove that every success criterion holds end-to-end, including a live replay of today's outage.

**Deliverables:**
1. Run `bun run check` clean.
2. Reproduce today's outage on a clean install:
   - Fresh container.
   - `bun add -g @automagik/genie` (post-merge build).
   - Truncate `~/.bun/install/global/node_modules/@oven/bun-linux-x64/bin/bun` to zero bytes (simulating today's empty-postinstall state).
   - `genie doctor` → expect RED with the precise reason, exit 69.
   - `pgserve start` → expect SUCCESS via PATH fallback.
   - `genie` (TUI) → expect normal layout (if pgserve up) or degrade panel (if down).
3. Tamper test for postinstall pinning.
4. Multi-user-host test for hook-fallback log permissions (verify another UID cannot read).
5. QA report at `.genie/wishes/dep-hygiene-and-resilience/qa-report.md` with timestamps + observations.

**Acceptance Criteria:**
- [ ] All success criteria from the wish marked verified in the QA report.
- [ ] Outage replay proves recovery without manual symlink workaround.
- [ ] `bun run check` clean.

**Validation:**
```bash
bun run check
bash scripts/repro-empty-oven-bun.sh
```

**depends-on:** Group 1, Group 2, Group 3, Group 4, Group 5, Group 6, Group 7

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] On a host where `@oven/bun-linux-x64/bin/bun` is empty/missing, `pgserve` starts via PATH fallback and `genie` works end-to-end.
- [ ] Stopping pgserve, launching the TUI, and observing the recovery panel — never blank chrome.
- [ ] `genie doctor` correctly distinguishes between "pgserve socket present and responsive" and "socket present but daemon dead" — file existence alone never produces GREEN.
- [ ] `~/.genie/hook-fallback.log` has mode `0600` after a fresh install on a clean home.
- [ ] Tampering with a pinned binary causes `genie install` to abort with a clear error.
- [ ] `bun run check` passes on a fresh clone.
- [ ] No regression in spawn / mailbox / wish-state flows that depended on the unaudited dependencies.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| pgserve PR (G1) not merged in time, blocking G5's wrapper-resolution check | High | G5's wrapper check degrades to a soft warning if the patched pgserve is not yet pinned. Hard-promote to RED once the pin lands. Track in CHANGELOG. |
| Token-redaction regex (G3) catches false positives in legitimate command output (e.g. a long hex SHA in a normal git command) | Low | Only redact at write time, not on read. Keep a `GENIE_HOOK_REDACTION=off` opt-out env var for debugging. Document in `docs/_internal/redaction.md`. |
| Postinstall SHA pinning (G4) breaks on legitimate binary updates because the pin wasn't refreshed | Medium | CI step in G4 deliverable #5 surfaces SHA drift as a deliberate PR diff. Release process documents the "bump pin" step. |
| Dep audit (G6) classifies a dynamically-imported package as UNUSED and breaks runtime | Medium | G7 QA includes a full smoke of every spawn / mailbox / wish flow before marking the audit done. Audit script flags dynamic imports explicitly. |
| Doctor probe (G5) introduces a 2s delay on every `genie doctor` invocation that becomes annoying | Low | Probe runs in parallel; total wall-clock budget capped at 3s. `--quick` flag skips probes for users who want the fast path. |
| Hook-log chmod (G3) races with concurrent writers and produces a partially-written entry | Low | Use `O_APPEND` write semantics; chmod at file-create time only, not per-write. Existing log preserved on upgrade. |
| pgserve cutover lands first and changes the canonical install commands; this wish's recovery blocks become stale | Medium | G2 + G5 read the recovery commands from a single shared constant in `src/lib/pgserve-recovery.ts`. Changes there propagate to TUI panel + doctor `--fix` simultaneously. |

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
# Create
scripts/audit-deps.ts
scripts/repro-empty-oven-bun.sh
src/tui/components/PgserveUnreachable.tsx
src/tui/__tests__/pgserve-unreachable.test.tsx
src/hooks/__tests__/redaction.test.ts
src/lib/pgserve-recovery.ts
src/lib/pm2-bootstrap.ts
src/lib/serve-pidfile.ts
src/lib/__tests__/pm2-bootstrap.test.ts
src/term-commands/__tests__/serve-orphan-prevention.test.ts
docs/_internal/dep-audit.md
docs/_internal/cli-exit-codes.md
docs/_internal/redaction.md

# Modify
package.json                                      # binarySha256, trustedDependencies, dep classification, pm2 dep added
src/tui/index.ts                                  # mount degrade panel on probe fail
src/hooks/dispatch-client.ts                      # 0600 chmod, redaction at write
src/genie-commands/install.ts                     # route pm2 check through pm2-bootstrap.ts
src/genie-commands/update.ts                      # call ensurePm2Installed at every update path
src/genie-commands/doctor.ts                      # real probes, --fix rewrite, exit codes, pm2 redeploy, route auto-spawn through pm2
src/term-commands/serve.ts                        # exit-code standardization, routeServeStartThroughPm2 decision tree, no detach under pm2
src/hooks/handlers/auto-spawn.ts                  # route auto-spawn through pm2 when pm2 entry registered
scripts/postinstall-tmux.js                       # SHA-256 verification
scripts/postinstall-hook-binary.js                # SHA-256 verification (or local-compile branch)
scripts/postinstall-migrations.js                 # audit pass
CHANGELOG.md                                      # Security section entry

# External (separate PR, separate repo)
automagik-dev/pgserve:bin/pgserve-wrapper.cjs     # PATH fallback
```
