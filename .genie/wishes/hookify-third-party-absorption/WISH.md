# Wish: Hookify Third-Party Absorption

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `hookify-third-party-absorption` |
| **Date** | 2026-04-29 |
| **Author** | felipe@namastex.ai |
| **Appetite** | large |
| **Branch** | `wish/hookify-third-party-absorption` |
| **Repos touched** | automagik-dev/genie |
| **Design** | [DESIGN.md](../../brainstorms/hookify-third-party-absorption/DESIGN.md) |

## Summary

Make `genie` the only Claude Code hook entry. Absorb existing foreign hooks (Token Optimizer, ultratoken, future plugins) into genie's daemon dispatch via a one-time settings.json rewrite + subprocess-passthrough handlers, and let operators deploy custom hooks (e.g. `rlmx run` on every Bash) as plain TS code in `.genie/hooks/`. Three-tier scoping (per-team > per-repo > global), trust-allowlisted, with reload + test for inner-loop iteration. Council-reviewed; rides delivery #1's TS daemon (no Rust, no daemon rewrite).

## Scope

### IN

- Trust-gated `.genie/hooks/` loader scanning three S3 tiers (`~/.claude/teams/<team>/hooks/`, `<repo>/.genie/hooks/`, `~/.genie/hooks/`) at boot, refusing any `.ts` not in `~/.genie/hooks/trusted.json` (path → SHA-256 + scope), dynamic-`import()`ing trusted modules, validating exports, registering them in the dispatch chain.
- Registry mutation contract: `src/hooks/index.ts` migrates `const handlers: Handler[]` (line 48) to `let registryRef: ReadonlyArray<Handler>`. `dispatch()` and `resolveHandlers()` read from `registryRef` at call time so each invocation captures a stable snapshot.
- External `Handler` interface contract (extends `src/hooks/types.ts`): adds `version: '1' | <future>` (discriminated union with vNext strategy), `source: 'builtin' | 'repo' | 'team' | 'global' | 'absorbed'`, `manifest_path: string`. Loader validates the export shape before registering; partial registration is forbidden. v1 and future v2 handlers run side-by-side until v1 sunset.
- In-process invariants documented and partially enforced: no `process.exit`, no `process.env` writes, no top-level await > 100 ms, no direct `pg` imports (handlers receive a daemon-supplied `Context`).
- Trust commands: `genie hook trust <path>` (prints diff + capabilities, demands confirmation) and `genie hook trust --repo` (per-repo opt-in keyed by `git remote URL + path`). Capability declarations follow `// @capabilities: <list>` JSDoc syntax surfaced at trust time.
- Three-tier scoping with explicit precedence: per-team > per-repo > global. Same-`name` collisions emit `console.warn` listing both source paths and surface in `genie hook list` as `[shadowed by <path>]`. `genie serve --strict-hooks` refuses to start on any collision.
- `genie hook scaffold <name>` — templates a `defineHook(...)` config-object file at the right tier (`--team <name>` / `--global` / default per-repo) with `--event`, `--tool`, `--run '<cmd>'`, header comments naming the docs page, and a commented-out `handler:` callback escape hatch.
- `genie hook list` — debug surface showing discovered + trusted + loaded hooks per scope; annotates same-`name` shadowing as `[shadowed by <path>]`, broken imports as `[BROKEN]`, stale absorbed targets as `[STALE]`; runs `which` on each absorbed hook's `run` command at list time.
- `genie hook test <name> --payload <fixture.json>` — runs a single hook against a recorded payload without daemon restart.
- `genie hook reload` — SIGHUP-style command that re-runs the boot scan, rebuilds the registry, atomically replaces the live reference (in-flight dispatches finish on the old reference). Single-writer guarantee enforced at the CLI level.
- Quarantine for broken hook files: daemon startup ALWAYS succeeds; loader catches parse/validation errors per-file, moves the offender to `_quarantine/<basename>` with sidecar `<basename>.error`, continues registering other hooks. `genie hook list` shows `[BROKEN]` rows. `genie hook quarantine --revert <name>` moves a file back from `_quarantine/` and re-validates.
- `genie hook import --from claude-settings` (renamed from `absorb`) with `--dry-run` (default) emitting a settings.json diff + generated `_absorbed/*.ts` list + checksum. `--apply` writes a versioned snapshot at `~/.genie/hooks/_absorbed/snapshots/<ISO>-<sha256>.json` (keep last 10, `latest` symlink, atomic GC), an audit-log entry at `~/.genie/audit/import.jsonl`, and rewrites settings. Refuses if already-imported (idempotency check via post-import hash).
- Subprocess-passthrough env capture in two modes: live probe (when a CC session is reachable) + offline fallback (capture from `process.env` + repo root + fixture). Both modes apply the same denylist (`GENIE_*`, `ANTHROPIC_API_KEY`). Captured env always includes `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PROJECT_DIR`, `CLAUDE_SESSION_ID` (synthetic UUID in offline mode), `LANG`, `LC_ALL`, `PATH`, `HOME`, `USER`, `TMPDIR`. `--apply --offline-only` and `--apply --probe-fixture <path>` flags. Halt with remediation hint if both modes fail.
- `genie hook import --eject` — verifies current settings.json checksum matches the post-apply hash; refuses without `--force` on drift; restores the original from the latest snapshot.
- `genie hook prune` — removes `_absorbed/*.ts` handlers whose `which` resolution fails. Dry-run by default; `--apply` to remove.
- Per-team hook archive lifecycle: `src/term-commands/team.ts` `archiveTeam(name)` extended to also move `~/.claude/teams/<team>/hooks/` to `~/.claude/teams/_archived/<team>-<ts>/hooks/`. Resolver excludes paths under `_archived/`. `genie hook list --orphans` surfaces them. `genie team disband` prompts archive/delete/migrate-to-global.
- Telemetry parity: every hook (builtin / repo / team / global / absorbed) emits `hook.delivery` spans with `data.hook_name` + `data.source`; rides delivery #1's wiring. `genie doctor --perf` includes a baked-in microbench (100 events through a no-op passthrough) reporting P50/P95/P99.
- `genie doctor --hooks` enumerates loaded / skipped / quarantined hooks per tier with file paths and load status.
- Alert-rule template at `docs/_internal/hookify/alerting.md` (P99 alert on absorbed-hook latency).
- Public docs at `docs/hookify.mdx` (Handler contract, `defineHook`, scoping, trust workflow, scaffold/import/eject) and internal docs at `docs/_internal/hookify/authoring.md` (in-process invariants, capability declaration, broken-hook runbook).

### OUT

- Pooled worker subprocess for non-JS plugins (Python/Ruby in-process speed). Deferred to delivery #3+.
- Plugin marketplace / discovery / signature verification beyond SHA-256.
- Full filesystem watcher (live hot reload without `genie hook reload`). Deferred to delivery #4.
- Active remediation / auto-restart on hook failures.
- `vm.Context` isolation of in-process hooks (stretch, dependent on Node/Bun support).
- Rust thin client + per-language Rust worker host (delivery #5).
- Flag-based `genie hook attach` that doesn't write a file (preserves the code-is-the-contract invariant).
- Cross-host hook sync.
- Multi-tenant filesystem ACL enforcement (out of genie's scope; threat model documented in DESIGN.md "Threat Model").

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Hooks are TS code in `.genie/hooks/`, not manifests | Code is the contract; one parser; one debug surface. |
| 2 | In-process execution by default | Performance demands no per-event fork; `runHandler` try/catch contains throwing handlers. |
| 3 | S3 three-tier scoping (per-team > per-repo > global) | Operator's actual use case ("rlmx for security only"). |
| 4 | Loud shadowing instead of silent suppression | Silent shadowing is exactly how supply-chain attacks land. |
| 5 | Trust allowlist (`trusted.json`) — filesystem presence is not consent | Without this, write to `$HOME` = persistent keylogging on every CC event. |
| 6 | External `Handler` gains `version: '1'` discriminated union, `source`, `manifest_path` | Versioning the contract before consumers depend on it is cheap; v1/v2 dual-load for migrations. |
| 7 | In-process invariants are a hard contract | Daemon stability is non-negotiable; mutable-runtime registry needs locked-down abuse surface. |
| 8 | Versioned absorb snapshots + audit log + drift detection on eject | Single snapshot is silently destroyed by a second `--apply`. |
| 9 | Two-mode env capture (live probe + offline fallback) with denylist | Allowlists silently break plugins; offline fallback ensures import works without a live CC session. |
| 10 | Ship `genie hook reload` + `genie hook test` with this delivery | Restart-per-edit is a flow-killer; reload + test make the inner loop livable. |
| 11 | Quarantine for broken hook files (daemon never refuses to start) | Broken hooks must be visible without grepping daemon logs; recovery should take seconds. |
| 12 | `genie hook scaffold` produces `defineHook({...})` config-object form | Operators shouldn't need to learn the full `Handler` interface for a one-line shell command. |
| 13 | Per-team hook archive lifecycle wired into `archiveTeam()` | Without this, archived teams' hooks orphan and fire surprise events. |
| 14 | Frozen registry, single-writer (`let registryRef: ReadonlyArray<Handler>`) | Atomic reload-swap by JS reference semantics. |
| 15 | 5 ms passthrough overhead becomes a measured SLO with bench + alert template | Without measurement, "≤5 ms" is unfalsifiable. |
| 16 | `absorb` → `import --from claude-settings`; `--dry-run` is default | Verb matches operator mental model; destructive operations should never be the default. |
| 17 | No Rust here; rides delivery #1's TS daemon | Don't rewrite proven code; Rust earns its keep on the cold-start path (delivery #5). |
| 18 | Threat model: single-operator machine; trust allowlist guards casual inclusion | `vm.Context` isolation is delivery #4; multi-tenant ACLs are out of genie's scope. |

## Success Criteria

### Functional
- [ ] `genie hook trust <path>` adds an entry to `~/.genie/hooks/trusted.json`; daemon refuses any `.ts` not listed (or whose SHA-256 doesn't match).
- [ ] `genie hook trust --repo` records repo-keyed trust under `<git-remote-url>/<path>`; cloning a hostile repo with a `.genie/hooks/` does not auto-arm.
- [ ] A trusted `.ts` file exporting `{ default: defineHook(...) }` placed in any of the three tier dirs is discovered, validated, and dispatched against matching events after `genie serve restart` OR `genie hook reload`.
- [ ] `genie hook list` correctly reports discovered + trusted + loaded hooks per scope; annotates `[shadowed by <path>]`, `[BROKEN]`, `[STALE]`.
- [ ] `genie serve --strict-hooks` refuses to start when any same-`name` collision exists across tiers.
- [ ] Per-team scope filters by `payload.team_name`; a hook in `~/.claude/teams/security/hooks/` does NOT fire for events on team `dev`.
- [ ] `genie hook scaffold rlmx-bash --event PreToolUse --tool Bash --run 'rlmx run --json'` produces an editable `defineHook(...)` file with header comments naming the docs page.
- [ ] `genie hook test rlmx-bash --payload fixtures/bash-pre.json` runs without daemon restart and prints the resulting decision JSON.
- [ ] `genie hook reload` re-runs the boot scan without dropping the UDS socket or in-flight dispatches.
- [ ] `genie hook quarantine --revert <name>` round-trips: bad file → `[BROKEN]`, fix file, revert → `[loaded]`. Bad-after-revert → back to `_quarantine/` with updated error.
- [ ] `genie hook import --dry-run` emits a settings.json diff + generated `_absorbed/*.ts` list + checksum.
- [ ] `genie hook import --apply` writes a versioned snapshot, an audit-log entry, and rewrites settings; captured env includes `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PROJECT_DIR`, `CLAUDE_SESSION_ID`, `LANG`, `LC_ALL`, `PATH`, `HOME`, `USER`, `TMPDIR`.
- [ ] `--apply --offline-only` works without a live CC session; `--probe-fixture <path>` consumes a saved capture; both-modes-fail halts with remediation hint.
- [ ] `genie hook import --eject` verifies checksum, refuses on drift without `--force`, restores the original byte-for-byte.
- [ ] After `--apply`, Token Optimizer keeps working unchanged end-to-end (`read_cache.py` still fires on PreToolUse Read).
- [ ] `genie hook prune --dry-run` lists `[STALE]` absorbed handlers; `--apply` removes them and updates `trusted.json`.
- [ ] `genie team archive <team>` moves `~/.claude/teams/<team>/hooks/` to `_archived/<team>-<ts>/hooks/`; resolver stops dispatching them; `genie hook list --orphans` surfaces them.
- [ ] `genie team disband` prompts archive/delete/migrate-to-global before proceeding when team has hooks.
- [ ] `genie doctor --hooks` enumerates loaded / skipped / quarantined hooks per tier.

### Performance & observability
- [ ] In-process external hook adds ≤ 0.5 ms to dispatcher P50 vs delivery #1's bench baseline.
- [ ] Subprocess-passthrough overhead measured by `genie doctor --perf` baked-in microbench: 100 events through a no-op passthrough handler, P50 ≤ 1 ms, P99 ≤ 5 ms.
- [ ] Daemon startup time grows ≤ 200 ms total even with 20 trusted hooks present.
- [ ] Every absorbed + user-authored hook emits `hook.delivery` spans with `data.hook_name` + `data.source`; no new instrumentation.
- [ ] `genie doctor --perf` regression detection works equally for first-party + absorbed + user-authored hooks; alert template ships at `docs/_internal/hookify/alerting.md`.

### Coexistence & safety
- [ ] `genie hook import --apply` is idempotent: re-running over an already-imported `settings.json` errors with a remediation hint, NOT silently overwriting.
- [ ] `_absorbed/snapshots/` retains last 10 snapshots; older ones GC'd; `latest` symlink updated atomically.
- [ ] Audit log at `~/.genie/audit/import.jsonl` records every import + eject + reload with timestamp, user, file paths, before/after checksums.
- [ ] If a generated `_absorbed/*.ts` handler crashes at runtime, `runHandler`'s try/catch contains it; failure surfaced via `genie doctor --perf` HIGH severity.
- [ ] Daemon startup succeeds even when 100 % of `.genie/hooks/*.ts` files are broken — every broken file lands in `_quarantine/`; UDS listener still serves builtin handlers.
- [ ] `Handler` discriminated-union loader: `version: '99'` rejected as `[BROKEN]`; v1 loads; future v2 + v1 register together without conflict.
- [ ] Registry mutation unit test verifies that `dispatch()` invoked during a `genie hook reload` finishes on its captured snapshot, and the next `dispatch()` after reload sees the new array.
- [ ] Council sentinel concerns explicitly tested in delivery report: trust allowlist invariant (unlisted file rejected), env-capture probe verified across 3+ representative plugins, versioned snapshots round-tripped (apply → eject → reapply → eject) with byte-for-byte equivalence.

### Delivery report
- [ ] `REPORT.md` documents the trust model decisions, threat model boundaries (`vm.Context` deferred), env-capture probe design (live + offline modes, denylist rationale), and the F1 fallback story for absorbed hooks.

## Execution Strategy

| Wave | Groups | Mode | Notes |
|------|--------|------|-------|
| 1 | Group 1 | sequential | Foundation — registry mutation, Handler v1 union, loader, trust gate. Everything else depends on this. |
| 2 | Group 2, Group 3 | parallel | Inner-loop CLI and absorb pipeline are independent and both depend only on Group 1. |
| 3 | Group 4 | sequential after Wave 2 | Lifecycle integration, telemetry/microbench, docs, delivery report — depends on the surfaces shipped in Waves 1–2. |

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Foundation: registry → `let registryRef`, `Handler` v1 discriminated union, loader, three-tier resolver, trust allowlist |
| 2 | engineer | Operator inner loop: `genie hook scaffold` / `list` / `test` / `reload` / `quarantine --revert` |
| 3 | engineer | Foreign-hook absorption: `genie hook import` (dry-run/apply/eject/prune) + two-mode env capture + versioned snapshots + audit log |
| 4 | qa | Lifecycle wiring, telemetry parity + microbench, docs, delivery report with measured numbers |

## Execution Groups

### Group 1: Foundation — registry, Handler contract, loader, trust gate

**Goal:** Make the daemon's handler registry mutable-but-safe, extend the Handler contract for external authors, ship the boot-scan loader with the trust allowlist as the security boundary.

**Deliverables:**
1. `src/hooks/index.ts` — migrate `const handlers: Handler[]` (line 48) to `let registryRef: ReadonlyArray<Handler>`. `dispatch()` and `resolveHandlers()` read from `registryRef` at call time. Helper `setRegistry(next: ReadonlyArray<Handler>): void` (single-writer).
2. `src/hooks/types.ts` — extend `Handler` to a discriminated union on `version: '1' | <future>`, add `source: 'builtin' | 'repo' | 'team' | 'global' | 'absorbed'` and `manifest_path: string` fields. Future-proof for v2 dual-load.
3. `src/hooks/loader.ts` (new) — boot-scan over the three S3 tiers. Per file: check trust allowlist, dynamic-`import()`, validate export shape, register with the right `source`. Errors quarantine to `_quarantine/<basename>` with sidecar `<basename>.error`. Emits `console.warn` on same-`name` collisions; `genie serve --strict-hooks` refuses to start on any collision.
4. `src/hooks/trust.ts` (new) + `src/term-commands/hook/trust.ts` (new) — `~/.genie/hooks/trusted.json` schema, reader + verifier, `genie hook trust <path>` CLI, `genie hook trust --repo`. Capability declarations parsed from `// @capabilities: <list>` JSDoc.
5. `src/serve/hook-socket.ts` — invoke loader during `startHookSocket()` BEFORE `server.listen()` (single-writer at boot).
6. `defineHook()` helper exported from a new `src/hooks/define-hook.ts` for external authors.
7. `src/hooks/dispatch-command.ts` + `src/genie.ts` — extend `registerHookNamespace()` to wire the `trust` subcommand (and reserve registration points for the rest of the `hook *` family that Groups 2 + 3 add). The `--strict-hooks` flag lives on `genie serve` (added in `src/term-commands/serve.ts` and consumed by the loader at boot).

**Acceptance Criteria:**
- [ ] `let registryRef: ReadonlyArray<Handler>`; `dispatch()` captures the reference at call time (registry-mutation unit test).
- [ ] `Handler` interface has `version: '1' | <future>`, `source`, `manifest_path` fields; loader rejects unknown versions as `[BROKEN]`.
- [ ] Loader scans three tiers, refuses any `.ts` not in `trusted.json`, dynamic-`import()`s trusted modules, validates exports, registers with correct `source`. Same-`name` collisions emit `console.warn`.
- [ ] `genie serve --strict-hooks` refuses to start on any same-`name` collision.
- [ ] `genie hook trust <path>` adds an entry; daemon refuses to load any `.ts` not listed; modifying a trusted file (changing its SHA-256) requires re-trust.
- [ ] `genie hook trust --repo` records repo-keyed trust; same hook in a different repo is independently trusted.
- [ ] Daemon startup succeeds even when every hook file is broken — broken files quarantined, builtin handlers still dispatch.
- [ ] `defineHook()` helper produces a valid `Handler` v1 object that the loader registers.

**Validation:**
```bash
cd /home/genie/workspace/repos/genie && bun run check && bun test src/hooks src/serve
```

**depends-on:** none

---

### Group 2: Operator inner loop — scaffold, list, test, reload, quarantine

**Goal:** Make hook authoring + iteration livable without restarting the daemon per edit.

**Deliverables:**
1. `src/term-commands/hook/scaffold.ts` (new) — `genie hook scaffold <name>` with `--event`, `--tool`, `--run '<cmd>'`, `--team <name>` / `--global`. Templates a `defineHook(...)` config-object file with header comments and a commented-out `handler:` callback escape hatch.
2. `src/term-commands/hook/list.ts` (new) — `genie hook list` enumerating discovered + trusted + loaded hooks per scope. Annotates `[shadowed by <path>]`, `[BROKEN]`, `[STALE]` (`which` probe at list time). `--orphans` filter for hooks under `_archived/`.
3. `src/term-commands/hook/test.ts` (new) — `genie hook test <name> --payload <fixture.json>` invoking the named hook (subject to trust) against the fixture and printing the decision JSON without daemon restart.
4. `src/term-commands/hook/reload.ts` (new) — `genie hook reload`. Re-runs the boot scan, builds a new `ReadonlyArray<Handler>`, calls `setRegistry()`. CLI-level single-writer lock prevents concurrent reload; UDS listener stays up.
5. `src/term-commands/hook/quarantine.ts` (new) — `genie hook quarantine --revert <name>` moves a file back from `_quarantine/` to its origin tier, triggers re-validation. Bad-after-revert returns to `_quarantine/` with updated `.error` sidecar.

**Acceptance Criteria:**
- [ ] `genie hook scaffold rlmx-bash --event PreToolUse --tool Bash --run 'rlmx run --json'` produces an editable file in `<repo>/.genie/hooks/rlmx-bash.ts`.
- [ ] `genie hook list` correctly reports per-tier hooks with annotation states (`[loaded]` / `[BROKEN]` / `[STALE]` / `[shadowed by <path>]`); `--orphans` surfaces archived-team hooks.
- [ ] `genie hook test rlmx-bash --payload fixtures/bash-pre.json` runs without daemon restart and prints the resulting decision JSON.
- [ ] `genie hook reload` rebuilds the registry without dropping the UDS socket; an in-flight `dispatch()` started before reload finishes on its captured snapshot; the next `dispatch()` after reload sees the new array.
- [ ] `genie hook quarantine --revert <name>` round-trips: bad file → `[BROKEN]`, fix file, revert → `[loaded]`. Bad-after-revert → back to `_quarantine/` with updated error.

**Validation:**
```bash
cd /home/genie/workspace/repos/genie && bun run check && bun test src/term-commands/hook
```

**depends-on:** Group 1

---

### Group 3: Foreign-hook absorption — import / eject / prune + env capture

**Goal:** One-time migration that takes the operator from "Token Optimizer's hook lives next to genie's" to "genie is the only entry; foreign hooks now live in genie's chain as `_absorbed/*.ts` handlers."

**Deliverables:**
1. `src/term-commands/hook/import.ts` (new) — `genie hook import --from claude-settings`. `--dry-run` (default) emits a settings.json diff + generated `_absorbed/*.ts` list + checksum. `--apply` writes a versioned snapshot at `~/.genie/hooks/_absorbed/snapshots/<ISO>-<sha256>.json` (keep last 10, `latest` symlink, atomic GC), an audit-log entry at `~/.genie/audit/import.jsonl`, rewrites `~/.claude/settings.json`. Idempotency check refuses re-import (post-import hash on settings.json).
2. `src/hooks/env-capture.ts` (new) — two-mode env capture. **Live mode:** spawn a probe hook through CC (when reachable), capture `env` + `pwd` + stdin verbatim. **Offline mode:** capture from `process.env` + repo root + a fixture stored under `~/.genie/hooks/_absorbed/probes/`. Both modes apply the same denylist (`GENIE_*`, `ANTHROPIC_API_KEY`). Captured env always includes minimum-required vars. `--apply --offline-only` and `--apply --probe-fixture <path>` flags. Halt with remediation hint if both modes fail.
3. Generated `_absorbed/<plugin>-<event>.ts` template — each absorbed hook is a `defineHook({ name, event, tool, source: 'absorbed', run: <Bun.spawn wrapper that injects captured env + pwd + stdin> })`. Auto-trusted at import time (entry added to `trusted.json` with the file's SHA-256).
4. `src/term-commands/hook/eject.ts` (new) — `genie hook import --eject`. Verifies current settings.json checksum matches the post-apply hash; refuses without `--force` on drift; restores the original from the latest snapshot. Removes `_absorbed/*.ts` files and their `trusted.json` entries.
5. `src/term-commands/hook/prune.ts` (new) — `genie hook prune`. Runs `which` on each absorbed hook's resolved command; `--dry-run` lists `[STALE]` entries; `--apply` removes them.

**Acceptance Criteria:**
- [ ] `genie hook import --dry-run` emits a settings.json diff + generated-files list + checksum.
- [ ] `genie hook import --apply` writes versioned snapshot + audit log + rewrites settings; `_absorbed/snapshots/` retains last 10; `latest` symlink updated atomically.
- [ ] After `--apply`, Token Optimizer keeps working unchanged end-to-end (`read_cache.py` still fires on PreToolUse Read).
- [ ] Captured env (unit test asserts the minimum-required keys: `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PROJECT_DIR`, `CLAUDE_SESSION_ID`, `LANG`, `LC_ALL`, `PATH`, `HOME`, `USER`, `TMPDIR` are all populated in both live and offline modes; QA later verifies live capture across 3+ representative plugins as part of post-merge testing).
- [ ] `--apply --offline-only` works without a live CC session; `--probe-fixture <path>` consumes a saved capture; both-modes-fail halts with remediation hint.
- [ ] `--apply` is idempotent: second invocation errors with remediation hint, NOT silently overwriting.
- [ ] `--eject` round-trips byte-for-byte (apply → eject → reapply → eject equivalence test).
- [ ] `--eject` refuses on settings.json drift unless `--force`.
- [ ] `genie hook prune --dry-run` lists stale absorbed handlers; `--apply` removes them and updates `trusted.json`.

**Validation:**
```bash
cd /home/genie/workspace/repos/genie && bun run check && bun test src/term-commands/hook src/hooks/env-capture.test.ts
```

**depends-on:** Group 1

---

### Group 4: Lifecycle, telemetry, docs, delivery report

**Goal:** Wire per-team hook lifecycle into existing team archive, ship the `genie doctor --perf` microbench + alert template, write public + internal docs, and produce the delivery report with measured numbers.

**Deliverables:**
1. `src/term-commands/team.ts` — extend `archiveTeam(name)` to also move `~/.claude/teams/<team>/hooks/` to `~/.claude/teams/_archived/<team>-<ts>/hooks/` (skip if absent). `disbandTeam()` prompts archive/delete/migrate-to-global when the team has hooks.
2. `src/hooks/loader.ts` — resolver excludes paths under `_archived/`. `genie hook list --orphans` surfaces hooks under `_archived/`.
3. `src/genie-commands/perf-check.ts` — extend with a baked-in microbench (100 events through a no-op passthrough handler) reporting P50/P95/P99 with pass/fail (P50 ≤ 1 ms, P99 ≤ 5 ms). Add `--hooks` subcommand to `genie doctor` enumerating loaded/skipped/quarantined hooks per tier.
4. `docs/_internal/hookify/alerting.md` (new) — P99 alert template for absorbed-hook latency.
5. `docs/hookify.mdx` (new public docs) — Handler contract, `defineHook` helper, scoping, trust workflow, scaffold/import/eject CLI walkthrough.
6. `docs/_internal/hookify/authoring.md` (new) — in-process invariants, capability declaration syntax, broken-hook runbook (quarantine → revert → reload).
7. `.genie/wishes/hookify-third-party-absorption/REPORT.md` — delivery report with measured numbers from `genie doctor --perf` microbench against a representative bench.

**Acceptance Criteria:**
- [ ] `genie team archive <team>` moves `~/.claude/teams/<team>/hooks/` to `_archived/<team>-<ts>/hooks/`; resolver stops dispatching them.
- [ ] `genie team disband <team>` prompts archive/delete/migrate-to-global before proceeding when team has hooks.
- [ ] `genie hook list --orphans` surfaces hooks under `_archived/`.
- [ ] `genie doctor --perf` runs the new passthrough microbench (100 events) and reports P50/P95/P99 with pass/fail; both first-party and absorbed hooks emit `hook.delivery` spans visible to regression detection.
- [ ] `genie doctor --hooks` enumerates loaded/skipped/quarantined hooks per tier.
- [ ] `docs/hookify.mdx` covers Handler contract, `defineHook`, scoping, trust workflow, scaffold/import/eject; `docs/_internal/hookify/authoring.md` covers invariants + capability syntax + runbook; `docs/_internal/hookify/alerting.md` ships the P99 alert template.
- [ ] `REPORT.md` includes measured passthrough P50/P99 (post-import) vs delivery #1 baseline, daemon startup time with 20 trusted hooks, and council sentinel concerns explicitly addressed (allowlist test, env-capture verification across 3 plugins, versioned-snapshots round-trip).

**Validation:**
```bash
cd /home/genie/workspace/repos/genie && bun run check && bun test src/term-commands/team src/genie-commands/perf-check.test.ts && cat .genie/wishes/hookify-third-party-absorption/REPORT.md | head -100
```

**depends-on:** Group 1, Group 2, Group 3

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] `genie hook trust ~/.genie/hooks/example.ts` round-trips (trust → reload → list shows `[loaded]`).
- [ ] Hostile clone test: a freshly-cloned repo with a `.genie/hooks/keylogger.ts` does NOT load any handlers without explicit `genie hook trust --repo`.
- [ ] Live import test against the operator's actual `~/.claude/settings.json` (Token Optimizer + any other plugin): `--dry-run` shows the plan, `--apply` migrates, Token Optimizer continues to function.
- [ ] Eject round-trip on the live config: `--eject` restores byte-for-byte; re-applying produces the same generated handlers.
- [ ] `genie team archive <name>` against a team with `~/.claude/teams/<name>/hooks/` → folder moved to `_archived/`, hooks no longer dispatch.
- [ ] `genie doctor --perf` against the live workload: passthrough microbench passes, no regressions on first-party handlers.
- [ ] Daemon stays up under 100 % broken hook files: place 5 files with parse errors in `~/.genie/hooks/`, restart `genie serve`, all 5 land in `_quarantine/`, `genie hook list` shows them all `[BROKEN]`, builtin handlers still dispatch.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Filesystem-presence-is-consent → daemon-level RCE via hostile `<repo>/.genie/hooks/`, npm postinstall, or `$HOME`-write attacker | High | Trust allowlist (`genie hook trust`), per-repo opt-in keyed by remote URL, capability declaration. Threat model documented (single-operator machine; `vm.Context` deferred to delivery #4). |
| A handler's transitive dep pulls in a conflicting `pg` major and corrupts the daemon's pool | High | In-process invariants as hard contract; loader rejects direct `pg` imports; daemon-supplied Context. Worker pool deferred to delivery #3+. |
| Second `genie hook import --apply` destroys the original snapshot | High | Versioned snapshots + idempotency check + drift detection on eject. |
| Subprocess passthrough loses an env var, silently breaking a plugin | High | Two-mode probe (live + offline); denylist sensitive vars; verified across 3+ plugins. |
| Same-name shadowing silently disables an audited hook | Medium | Loud shadowing warning + `[shadowed]` annotation + `--strict-hooks` mode. |
| Boot-time scan only → flow-killer for hook authoring | Medium | `genie hook reload` + `genie hook test --payload` ship with this delivery. |
| Broken hook file silently disappears from `genie hook list` | Medium | Quarantine + sidecar error file + `[BROKEN]` row + `genie doctor --hooks` + `quarantine --revert`. |
| Archived team's hooks orphan and fire surprise events | Medium | `genie team archive` moves under `_archived/`; resolver excludes; `--orphans` surfaces. |
| Absorbed hook's target binary disappears | Low | `which` probe at `genie hook list` time; `[STALE]` annotation; `genie hook prune`. |
| "≤ 5 ms passthrough overhead" unfalsifiable without measurement | Low | Baked-in microbench in `genie doctor --perf`; per-handler timing spans; alert template. |
| `Handler` v1 contract becomes load-bearing for external authors before fully exercised | Medium | Discriminated union on `version` + dual-load v1/v2 strategy; deprecation period documented. |
| Multi-tenant or shared-machine threat model not addressed | Low | Documented in DESIGN.md "Threat Model": out of scope; OS-level ACLs are the operator's responsibility. |

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
src/hooks/index.ts                        # registry mutation: const → let registryRef
src/hooks/types.ts                        # Handler v1 discriminated union + source + manifest_path
src/hooks/define-hook.ts                  # NEW — defineHook() helper for external authors
src/hooks/loader.ts                       # NEW — boot-scan + tier resolver + quarantine
src/hooks/trust.ts                        # NEW — trusted.json schema + verifier
src/hooks/env-capture.ts                  # NEW — two-mode env capture (live + offline)
src/serve/hook-socket.ts                  # invoke loader before server.listen()
src/term-commands/serve.ts                # --strict-hooks flag
src/term-commands/team.ts                 # archiveTeam → also move hooks/
src/term-commands/hook/                   # NEW dir
  trust.ts                                # genie hook trust (+ --repo)
  scaffold.ts                             # genie hook scaffold
  list.ts                                 # genie hook list
  test.ts                                 # genie hook test
  reload.ts                               # genie hook reload
  quarantine.ts                           # genie hook quarantine --revert
  import.ts                               # genie hook import (dry-run/apply)
  eject.ts                                # genie hook import --eject
  prune.ts                                # genie hook prune
src/genie-commands/perf-check.ts          # extend with passthrough microbench
src/genie-commands/doctor.ts              # add --hooks subcommand
docs/hookify.mdx                          # NEW public docs
docs/_internal/hookify/authoring.md       # NEW invariants + runbook
docs/_internal/hookify/alerting.md        # NEW P99 alert template
.genie/wishes/hookify-third-party-absorption/REPORT.md  # NEW delivery report
```
