# Unified Update Interface — Analysis & Proposal

**Goal**: One PR against `automagik-dev/genie` (→ `dev`) and one PR against `automagik/omni` (→ `dev`) that converge their `update` commands on a single shared design, with each side absorbing the best ideas from the other.

**Status**: Analysis complete. Awaiting confirmation before opening PRs.

---

## 1. Repo state at analysis time

| Repo | Branch | Worktree dirty? | PR base |
|------|--------|-----------------|---------|
| `repos/genie` | `wish/fix-auto-resume-stale-row` | yes (untracked wish dirs) | `dev` |
| `repos/omni`  | `dev` | yes (`turn-monitor.ts`) | `dev` |

**Implication**: I must branch off `dev` cleanly in each repo (not from the current dirty branch) and stage diffs against `dev`. I will not touch the unrelated dirty files.

---

## 2. What each `update` does today

### 2.1 `genie update` — `repos/genie/src/genie-commands/update.ts` (1060 lines)

| Capability | Notes |
|---|---|
| Multi-installer detection | `source` / `npm` / `bun` / `unknown`; binary path via `which genie` + `realpath`, then config hint, then legacy `~/.genie/src/.git`, then bun-preferred fallback. Symlink-chain regression covered by tests (`detectFromBinaryPath`). |
| Channel resolution | `--next` / `--stable`, persists to `~/.genie/config.json` `updateChannel`. |
| Source install path | `git fetch && git reset --hard origin/main && bun install && bun run build && copy dist binaries → ~/.genie/bin → symlink ~/.local/bin`. Cleans legacy `claudio.js`/`claudio` symlinks. Pre-flight checks for missing GENIE_SRC and `.git`. |
| Bun install path | `bun add -g @automagik/genie@<channel>`, with global lockfile pre-deletion. |
| npm install path | `npm install -g @automagik/genie@<channel>`. |
| Dual-install update | If both npm and bun globals exist, primary install is the detected one, secondary is best-effort warn-not-block. |
| Plugin sync | Copies `<pkg>/plugins/genie` → `~/.claude/plugins/cache/automagik/genie/<version>`; updates `installed_plugins.json`, `marketplace.json`, plugin `package.json`, repoints `skills` symlink, refreshes tmux scripts + tmux config + theme + `osc52-copy.sh`, reloads tmux server config. |
| Post-update maintenance | Calls `runPostUpdateMaintenance` from `doctor.js` with `GENIE_PG_NO_AUTOSTART=1`; capturable via `--skip-maintenance` or `GENIE_UPDATE_SKIP_MAINTENANCE`. |
| Diagnostics | Writes `~/.genie/logs/update-diagnostics-<iso>.json` — install metadata, runtime info, scheduler/tui-crash log signals, process snapshot. Schema versioned (`UPDATE_DIAGNOSTIC_SCHEMA_VERSION = 1`). |
| Tests | `__tests__/update.test.ts` — symlink resolution, dual-install logic, "post-update maintenance does not auto-start pgserve" source-string lock. |

**Missing relative to omni**: pre-flight registry version check (always tries to install even if already current), no confirmation prompt, no post-install verification (no health probe of running services), no auth re-validation.

### 2.2 `omni update` — `repos/omni/packages/cli/src/commands/update.ts` (542 lines)

| Capability | Notes |
|---|---|
| Single installer | bun only (`bun add -g @automagik/omni@<channel>`), with `--force --no-cache` to bypass bun global lockfile pinning. |
| Channel resolution | `--next` / `--stable`, persists to `~/.omni/config.json` `updateChannel`; legacy `'main'` value sanitized to `'latest'`. |
| Pre-flight registry check | `bunx npm view @automagik/omni@<channel> version`; early-exit "Already up to date" when current matches latest. |
| Confirmation prompt | TTY prompt unless `--yes`. |
| Restart-only-running | `pm2 jlist` → restart only services that were `online`; nothing to restart = nothing to verify. |
| Hermetic restart env | Builds env from `~/.omni/config.json` via `buildRuntimeEnv` so the calling shell's `DATABASE_URL`/`OMNI_API_KEY` cannot leak into the restarted server (root cause of the 2026-04-06 cross-DB incident). |
| 3-step verification | (1) CLI version known at compile; (2) `/api/v2/health` polled with 10s deadline + 500ms interval, version normalized to strip `+gitsha`; (3) `auth.validate()` against the just-restarted server with the stored key. |
| Tagged-union outcome | `decideUpdateVerify` is a pure function returning `ok` / `health-unreachable` / `version-mismatch` / `auth-invalid`. Caller renders + exits. Tests pin every branch + the exact error strings. |
| Sidecar cleanup | After successful restart, kills legacy `nats-reply-sidecar.mjs` (PM2 + raw); skippable with `--no-sidecar-cleanup`. Documented runbook for manual fallback. |
| Spinners + chalk | `ora` spinners on each step, green/red glyphs in success/error banner. |

**Missing relative to genie**: no source-install path, no npm install fallback, no dual-install awareness, no plugin cache sync (omni doesn't have a Claude Code plugin cache), no post-update maintenance hook, no diagnostics report.

---

## 3. Feature deltas — who has what

Legend: ✅ has it, ❌ missing, ➖ N/A for that product.

| Feature | genie | omni | Notes |
|---|---|---|---|
| Pre-flight "already up to date" check | ❌ | ✅ | genie always reinstalls — wastes time on every `genie update` |
| Confirmation prompt (TTY) + `--yes` | ❌ | ✅ | genie just installs; risky if a user types it by reflex |
| Channel resolution + persistence | ✅ | ✅ | already aligned |
| `--next` / `--stable` flags | ✅ | ✅ | aligned |
| Multi-installer detection | ✅ | ➖ | omni is bun-only by design today |
| Source install path | ✅ | ➖ | omni has no public source-install workflow |
| Dual-install (npm + bun) | ✅ | ❌ | omni could benefit but only if it adds npm support |
| Pure decision function for verification | ❌ | ✅ | genie has nothing testable; everything is impure |
| Tagged-union verify outcome | ❌ | ✅ | genie should adopt for testability |
| `normalizeVersion` (`+gitsha` stripped) | ❌ | ✅ | genie should adopt — same packaging |
| Health probe of running daemon | ❌ | ✅ | genie has pgserve/scheduler/tmux — could probe `genie doctor --json` |
| Auth/key revalidation post-restart | ❌ | ✅ | genie has no auth model today; ➖ |
| Hermetic restart env | ❌ | ✅ | genie's pgserve restart inherits shell env via tmux; bug equivalent possible |
| Spinners + colored banner | ❌ | ✅ | genie uses bare ANSI; could absorb |
| Plugin cache sync | ✅ | ➖ | omni has no Claude Code plugin |
| Post-update maintenance hook | ✅ | ❌ | omni could run `omni doctor` here |
| Diagnostics JSON report | ✅ | ❌ | omni's `--no-restart` failure path has no breadcrumbs |
| `--skip-maintenance` / env override | ✅ | ➖ | maps to omni's `--no-restart` semantically |
| Sidecar/legacy cleanup | ➖ | ✅ | genie has no sidecar; if a future deprecation lands, mirror this pattern |
| Tests for verify decision | ❌ | ✅ | genie should mirror |
| Tests for channel resolution | ❌ | ✅ | genie should mirror |

---

## 4. Proposed unified standard

A shared **shape** for both `update` commands. Implementation lives in each repo (no new shared package — too much coupling), but the public surface, internal stages, and exit semantics are identical.

### 4.1 Public flags (must be identical)

```
<cli> update [--yes] [--next] [--stable] [--no-restart] [--no-verify]
             [--skip-maintenance] [--no-sidecar-cleanup]
```

| Flag | genie | omni | Behavior |
|---|---|---|---|
| `--yes`, `-y` | NEW | exists | Skip TTY confirmation |
| `--next` | exists | exists | Switch to `@next` and persist |
| `--stable` | exists | exists | Switch to `@latest` and persist |
| `--no-restart` | NEW (no-op for source install) | exists | Don't restart daemons; skip verification |
| `--no-verify` | NEW | NEW | Restart daemons but skip the post-restart probe (escape hatch when probe is broken) |
| `--skip-maintenance` | exists | NEW | Skip the post-update health check / diagnostics block |
| `--no-sidecar-cleanup` | ➖ | exists | (omni-only; flag accepted as no-op in genie for portability) |

Env equivalents: `<CLI>_UPDATE_SKIP_MAINTENANCE`, `<CLI>_UPDATE_YES` (CI escape hatches).

### 4.2 Stage pipeline (must be identical, with per-repo implementations)

```
1. resolveChannel(opts, config)            — pure, persistable
2. checkLatestVersion(channel)             — registry probe, pure failure mode
3. shortCircuitIfCurrent(current, latest)  — exit 0 with "already up to date"
4. confirmIfTTY(current → latest)          — gated by --yes / non-TTY
5. detectInstallers()                      — genie: source|npm|bun; omni: bun
6. installPrimary(installer, channel)
7. installSecondary(if dual-install)       — best-effort, warn on fail
8. syncArtifacts()                         — genie: plugin cache + tmux;
                                             omni: no-op
9. restartServicesIfRunning(opts)          — genie: pgserve/scheduler/tmux;
                                             omni: pm2 tracked services
10. verifyOrFail(decideVerify(...))        — pure decision function,
                                             tagged-union outcome
11. postUpdateMaintenance()                — genie: doctor read-only sweep;
                                             omni: doctor health/auth probe
12. captureDiagnostics()                   — both: ~/.<cli>/logs/update-diagnostics-*.json
13. successBanner()                        — same 3-line shape:
                                             ✓ CLI:    v<latest>
                                             ✓ Server: v<latest> (healthy)  | (skipped)
                                             ✓ Auth:   key valid            | (n/a)
```

### 4.3 Verification — shared shape

Both repos export a pure `decideVerify` function returning the same tagged union, with one extra variant for genie (no daemon to probe in the source-only case):

```ts
type VerifyResult =
  | { kind: 'ok'; cliVersion: string; serverVersion: string | null }
  | { kind: 'health-unreachable'; endpoint: string }
  | { kind: 'version-mismatch'; cliVersion: string; serverVersion: string | null }
  | { kind: 'auth-invalid' }
  | { kind: 'skipped'; reason: 'no-restart' | 'no-running-services' | 'no-verify-flag' };
```

Tests in each repo cover every branch + exact error-message strings.

### 4.4 Diagnostics — shared schema

Both write `~/.<cli>/logs/update-diagnostics-<iso>.json` with a versioned schema:

```jsonc
{
  "schemaVersion": 1,
  "generatedAt": "ISO",
  "cli": "genie" | "omni",
  "update": { "channel": "...", "installer": "...", "primaryMethod": "...", "globalInstalls": [...] },
  "runtime": { "platform": "...", "arch": "...", "node": "...", "bun": "...", "npm": "..." },
  "verify": <VerifyResult>,                  // NEW: include the decision result
  "maintenance": { "outcome": "...", "durationMs": N, "lines": [...], "error": "..." },
  "recentLogSignals": { ... },               // genie continues to dump scheduler.log; omni dumps pm2 logs
  "paths": { ... }
}
```

`schemaVersion` bump rules documented in the PR description.

### 4.5 Exit-code contract (shared)

| Outcome | Exit code |
|---|---|
| Already up to date | 0 |
| Updated + verified | 0 |
| User declined prompt | 0 |
| Install failed | 1 |
| Restart failed | 1 |
| Verify mismatch / auth-invalid / health-unreachable | 1 |
| Maintenance failed (non-blocking) | 0, with banner warning |

---

## 5. PR plan — `automagik-dev/genie` → `dev`

**Branch**: `feat/update-unify-omni-parity-2026-05-01` off `dev`.

**Scope**: absorb omni's good ideas into `genie update`, without losing any current capability.

| # | Change | Files |
|---|---|---|
| 1 | Add pre-flight registry version check + early "already up to date" exit | `update.ts` (new `fetchLatestVersion`, `normalizeVersion` reused) |
| 2 | Add `normalizeVersion` (strip `+gitsha`) and use it everywhere a version is compared | `update.ts` |
| 3 | Add TTY confirmation prompt + `--yes` / `-y` flag + `GENIE_UPDATE_YES` env | `update.ts`, CLI registration |
| 4 | Extract `decideVerify` pure function returning the tagged union; cover with unit tests | `update.ts` + `__tests__/update.test.ts` |
| 5 | Add post-restart health probe — runs `genie doctor --json` (or pgserve/scheduler probe) and feeds `decideVerify`; gated by `--no-verify` | `update.ts`, light `doctor.ts` integration |
| 6 | Add `--no-restart` flag — skips post-update maintenance and verification (safe for CI) | `update.ts` |
| 7 | Add `--no-sidecar-cleanup` as accepted no-op for cross-CLI portability | `update.ts` |
| 8 | Migrate ANSI prints to `ora` spinners + `chalk` banner (single dep already in tree); fall back gracefully when `NO_COLOR` set | `update.ts`, `package.json` (only if not already a dep) |
| 9 | Add `verify` block to diagnostics JSON; bump `schemaVersion` to 2 | `update.ts` |
| 10 | Tests: `decideVerify` branches, `normalizeVersion` cases, channel resolution legacy values, exit codes | `__tests__/update.test.ts` |

**Backwards compatibility**: every existing flag keeps working; channel persistence file format unchanged; diagnostics consumers reading schemaVersion get a clean bump.

**Risk**: medium. The biggest risk is verification false-negatives (genie's daemon stack is async; pgserve takes longer to bounce than pm2). Mitigation: poll up to 15s, add `--no-verify` escape hatch, treat `health-unreachable` as a warning when `--no-restart` was implied.

---

## 6. PR plan — `automagik/omni` → `dev`

**Branch**: `feat/update-unify-genie-parity-2026-05-01` off `dev`.

**Scope**: absorb genie's good ideas into `omni update`, without losing any current capability.

| # | Change | Files |
|---|---|---|
| 1 | Add post-update maintenance hook calling `omni doctor --read-only` (or equivalent), gated by `--skip-maintenance` and `OMNI_UPDATE_SKIP_MAINTENANCE` env | `update.ts`, `doctor.ts` (verify a `--read-only` mode exists or add one) |
| 2 | Add diagnostics JSON capture on every `omni update` invocation: install metadata, registry result, install outcome, restart outcome, `decideUpdateVerify` result, recent pm2 log signals, key paths | `update.ts` (new `collectUpdateDiagnostics`), `~/.omni/logs/` writer |
| 3 | Adopt the shared diagnostics schema (`schemaVersion: 1`) and document the schema in the wish | `update.ts` + docs |
| 4 | Promote `decideUpdateVerify` to return the unified tagged-union shape (rename `decideUpdateVerify` → `decideVerify`, keep export alias) and add a `skipped` variant for `--no-restart` and a new `--no-verify` flag | `update.ts`, tests, callers |
| 5 | Multi-installer awareness: detect npm-global parallel install via `npm root -g`; if found, log a warning recommending uninstall (omni has no plan to support npm-global server, but the warning prevents stale binary confusion) | `update.ts` |
| 6 | Optional: add `--no-restart` aliasing (already exists) + new `--no-verify` flag that restarts but skips probe; useful when `/api/v2/health` is broken in a release | `update.ts` |
| 7 | Surface "Already up to date" with the same shape as genie ("CLI: v… (latest)") | `update.ts` |
| 8 | Tests: verify schemaVersion lock, diagnostics file shape, `decideVerify` skipped variant, npm-global warning, every existing case still passes | `__tests__/update-verify.test.ts` (extend), new `__tests__/update-diagnostics.test.ts` |

**Backwards compatibility**: every existing flag and exact error string is preserved. The renamed `decideVerify` keeps `decideUpdateVerify` as an alias to avoid breaking external consumers (none known, but cheap).

**Risk**: low. Diagnostics capture is additive; maintenance hook is gated; schema is versioned.

---

## 7. Open questions before I push code

1. **Branch base**: confirm both PRs target `dev` (per memory: "genie PRs target dev, not main"). For omni, dev is also the convention — confirming.
2. **Genie health endpoint**: does `genie doctor --json` exist today, or do I need to introduce a thin probe? (I'll inspect `doctor.ts` if you want me to proceed.)
3. **Shared package path**: keep both implementations independent (recommended) vs. introduce a tiny shared `@automagik/update-core` package. Strong recommendation: **independent**, because the coupling cost is greater than the duplication cost — one cross-cutting bug would jeopardize both releases simultaneously.
4. **Schema version coordination**: genie is currently `schemaVersion: 1`, omni has none. After this PR, both ship `schemaVersion: 2` for genie and `schemaVersion: 1` for omni. Is asymmetric OK, or do we want to keep the numbers aligned (omni starts at `2`)?
5. **Sidecar cleanup**: keep omni-only, or expose a generic "post-restart cleanup hook" pattern in genie too?
6. **Confirmation prompt default**: omni currently prompts unless `--yes`. Genie today does not prompt. Aligning means genie users will see a new prompt — is that acceptable, or should we keep genie silent and document the inconsistency?

---

## 8. Recommendation

**Open both PRs in parallel, not sequentially.** They share a design doc (this file) but ship independently against `dev` in their respective repos. Each PR description links the other for cross-reference.

**Order of work** (when you greenlight):

1. Genie PR — bigger surface area, more code change, more tests.
2. Omni PR — smaller delta, mostly additive (diagnostics + maintenance hook).
3. Both PRs reference this analysis doc.

I'll do nothing destructive — both PRs are additive against `dev` only.

**Next step on my side, on your "go"**: branch off `dev` in each repo, implement, run the existing test suites green, push, open PRs.
