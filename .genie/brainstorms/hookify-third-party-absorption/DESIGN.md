# Design: Hookify Third-Party Absorption (delivery #2)

| Field | Value |
|-------|-------|
| **Slug** | `hookify-third-party-absorption` |
| **Date** | 2026-04-28 |
| **WRS** | 100/100 |
| **Umbrella** | Genie as universal Claude Code hookify layer (delivery #1 shipped as PR #1485) |

## Problem

Foreign Claude Code hooks (Token Optimizer, ultratoken, future plugins) each pay their own fork-per-event tax and clutter `~/.claude/settings.json`; genie should become the single CC hook entry that multiplexes downstream — preserving foreign hook semantics while eliminating their per-event cost — and at the same time give operators a way to deploy custom hooks (e.g. `rlmx run` on every Bash) as plain code, not config.

## Scope

### IN
1. **Trust-gated `.genie/hooks/` loader** — daemon scans three S3 tiers at boot, refuses to load any `.ts` file not present in `~/.genie/hooks/trusted.json` (path → SHA-256 + scope), dynamic-`import()`s trusted modules, validates exports, registers them in the dispatch chain.
2. **Three-tier scoping with explicit precedence** — `~/.claude/teams/<team>/hooks/*.ts` (per-team) > `<repo>/.genie/hooks/*.ts` (per-repo) > `~/.genie/hooks/*.ts` (global). Same-`name` collisions emit `console.warn` listing both source paths and surface in `genie hook list` as `[shadowed by <path>]`. `genie serve --strict-hooks` refuses to start on any collision.
3. **External `Handler` interface contract** — `src/hooks/types.ts` `Handler` extends with `version: '1'`, `source: 'builtin' | 'repo' | 'team' | 'global' | 'absorbed'`, `manifest_path: string`. Loader validates the export shape before registering; partial registration is forbidden. In-process invariants documented as a hard contract: no `process.exit`, no `process.env` writes, no top-level await > 100 ms, no direct `pg` imports (handlers receive a daemon-supplied `Context`).
4. **Trust commands** — `genie hook trust <path>` (prints diff + capabilities, demands confirmation, writes the entry) and `genie hook trust --repo` (per-repo opt-in keyed by `git remote URL + path`).
5. **`genie hook scaffold <name>`** — templates a `defineHook(...)` config-object file at the right tier (`--team <name>` / `--global` / default per-repo), with `--event`, `--tool`, `--run '<cmd>'`, header comments naming the docs page + the `genie hook list` follow-up, and a commented-out `handler:` callback escape hatch for advanced cases.
6. **`genie hook list`** — debug surface showing discovered + trusted + loaded hooks per scope; annotates same-`name` shadowing as `[shadowed by <path>]`, broken imports as `[BROKEN]`, stale absorbed targets as `[STALE]`; runs `which` on each absorbed hook's `run` command at list time.
7. **`genie hook test <name> --payload <fixture.json>`** — runs a single hook against a recorded payload without daemon restart; in-loop iteration affordance.
8. **`genie hook reload`** — SIGHUP-style command that re-runs the boot scan, rebuilds the registry, and atomically replaces the live reference (in-flight dispatches finish on the old reference). Pairs with frozen-by-construction registry: `let handlers: ReadonlyArray<Handler>` populated once before `server.listen()`.
9. **`genie hook import --from claude-settings`** (renamed from `absorb`) — `--dry-run` (default) emits a settings.json diff + the list of generated `_absorbed/*.ts` files + a checksum of the proposed final state. `--apply` writes a versioned snapshot at `~/.genie/hooks/_absorbed/snapshots/<ISO>-<sha256>.json` (keep last 10, `latest` symlink, atomic GC), an audit-log entry at `~/.genie/audit/import.jsonl`, and rewrites settings. Refuses if already-imported (idempotency check). Subprocess-passthrough handlers capture the full CC environment via **two-mode capture**: (a) preferred — if a CC session is live, daemon spawns a probe hook through CC and captures `env` + `pwd` + stdin verbatim; (b) offline fallback — when no CC session is reachable, capture from the daemon's parent shell environment (`process.env`), `pwd` from the resolved repo root, and stdin shape from a known-good fixture stored in `~/.genie/hooks/_absorbed/probes/`. Both modes apply the same denylist for sensitive vars (`GENIE_*`, `ANTHROPIC_API_KEY`, etc.). The captured env always includes at minimum `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PROJECT_DIR`, `CLAUDE_SESSION_ID` (synthetic UUID in offline mode), `LANG`, `LC_ALL`, `PATH`, `HOME`, `USER`, `TMPDIR`. If both capture modes fail (e.g., `process.env.CLAUDE_PLUGIN_ROOT` missing in offline mode and no live CC session), `--apply` halts with a remediation hint: "Start a Claude Code session and retry, or use `--probe-fixture <path>` to point at a saved probe capture." `--apply --offline-only` skips the live probe attempt; `--apply --probe-fixture <path>` uses a hand-curated capture.
10. **`genie hook import --eject`** — verifies the current settings.json checksum matches the post-apply hash; refuses without `--force` if drift detected; restores the original from the latest snapshot.
11. **Quarantine for broken hook files** — daemon startup ALWAYS succeeds even when hook files are broken; the loader catches parse/validation errors per-file, moves the offending file to `_quarantine/<basename>` with a sidecar `<basename>.error` containing the parse error + line, and continues registering the other hooks. `genie hook list` shows quarantined files as `[BROKEN]` rows with file path + first error line + remediation hint (`fix the file then run 'genie hook reload'`). `genie doctor --hooks` enumerates loaded / skipped / quarantined. `genie hook quarantine --revert <name>` moves a file back from `_quarantine/` to its original tier (after the operator fixes it on disk) and triggers a re-validation pass.
12. **Per-team hook archive lifecycle** — `src/term-commands/team.ts` already exposes `archiveTeam(name)` (verified during plan review). This delivery extends `archiveTeam` to also move the team's hooks folder from `~/.claude/teams/<team>/hooks/` to `~/.claude/teams/_archived/<team>-<ts>/hooks/` (or skip if the folder doesn't exist); the loader's resolver excludes paths under `_archived/`; `genie hook list --orphans` surfaces any hooks discovered under `_archived/` so the operator can clean them up; `genie team disband` prompts archive/delete/migrate-to-global before proceeding.
13. **Telemetry & observability** — every hook (builtin / repo / team / global / absorbed) emits `hook.delivery` spans with `data.hook_name` + `data.source`; rides delivery #1's wiring (no new instrumentation code). `genie doctor --perf` includes a baked-in microbench (100 events through a no-op passthrough hook) reporting P50/P95/P99 with pass/fail. Alert-rule template ships in `docs/_internal/hookify/alerting.md`.
14. **Docs** — public `docs/hookify.mdx` (Handler contract, `defineHook` helper, scoping, trust workflow, scaffold/import/eject), internal `docs/_internal/hookify/authoring.md` (in-process invariants, capability declaration, runbook for broken hooks), `docs/_internal/hookify/alerting.md` (P99 alert template).
15. **`genie hook prune`** — removes `_absorbed/*.ts` handlers whose `which` resolution fails (the foreign target binary is gone). Dry-run by default; `--apply` to remove. Pairs with the `[STALE]` annotation in `genie hook list`.
16. **Registry mutation contract (deliverable, not just doc)** — `src/hooks/index.ts` migrates `const handlers: Handler[] = [...]` (line 48) to `let registryRef: ReadonlyArray<Handler>`. `dispatch()` and `resolveHandlers()` read from `registryRef` at call time so each invocation captures a stable snapshot. `genie hook reload` builds a new array (under a CLI-level single-writer lock) and assigns `registryRef = newArray`; in-flight dispatches finish on their captured snapshot. The migration is the foundational change that unlocks reload, hot reload (delivery #4), and external-handler registration.
17. **`Handler.version` discriminated union with vNext strategy** — `Handler` becomes a discriminated union on `version` (`'1' | <future>`). v1 is what this delivery ships. Loader rejects unknown versions as `[BROKEN]`. v2 is introduced as a new variant; v1 and v2 handlers run side-by-side in the same dispatch chain until v1 sunset is announced (deprecation period documented in `docs/hookify.mdx#versioning`). Authors get one full release cycle to migrate. Versioning the contract before any external consumers exist costs nothing today and is impossible to retrofit later.

### OUT (deferred to follow-up wishes)
- Pooled worker subprocess for non-JS plugins (Python/Ruby in-process speed) — fast-path for plugins that won't ship JS.
- Plugin marketplace / discovery / signature verification beyond SHA-256.
- Full filesystem watcher (live hot reload without `genie hook reload`) — likely delivery #4.
- Active remediation / auto-restart on hook failures — likely delivery #4.
- `vm.Context` isolation of in-process hooks — stretch goal once the contract is bedded in; dependent on Node/Bun support.
- Rust thin client + per-language Rust worker host (delivery #5).
- Flag-based `genie hook attach` that doesn't write a file (preserves the code-is-the-contract invariant).
- Cross-host hook sync.

## Threat Model

Single-operator machine. We assume the human running `genie` has trusted control of `$HOME` and the contents of every repository they `cd` into. If an attacker can write arbitrary files into `$HOME` (or land them in a checked-out repo via npm postinstall, malicious PR, dependency compromise), the *machine* is already compromised — they can also write to `trusted.json`, `~/.claude/settings.json`, or `dist/genie.js`. The trust allowlist (`~/.genie/hooks/trusted.json`) is therefore **not** a security boundary against `$HOME`-write attackers; it is a guard against accidental inclusion (a file landing in `<repo>/.genie/hooks/` from a `git clone` does not silently arm). Real isolation against `$HOME`-write attackers is the `vm.Context` work explicitly deferred to delivery #4. Operators in shared-machine or multi-tenant scenarios must apply OS-level filesystem ACLs (mode 0700 on `~/.genie`, ownership constraints) themselves; that's out of genie's scope.

## Approach

**Three-layer architecture, all riding delivery #1's daemon:**

```
                                   ┌──────────────────────────────────────────────┐
CC tool event ──► genie-hook ─UDS──┤  genie serve --headless                      │
                                   │   ┌─────────────────────────────────────┐   │
                                   │   │ dispatch() (delivery #1)            │   │
                                   │   │   builtin handlers                  │   │
                                   │   │   + global hooks (~/.genie/hooks/)  │   │
                                   │   │   + per-repo hooks                  │   │
                                   │   │   + per-team hooks                  │   │
                                   │   │   + _absorbed/*.ts (subprocess)     │   │
                                   │   │ resolved by S3 precedence           │   │
                                   │   │ all execute in-process; absorbed    │   │
                                   │   │ ones Bun.spawn the foreign command  │   │
                                   │   └─────────────────────────────────────┘   │
                                   │   registry: let handlers: Readonly<H[]>     │
                                   │   reload: build new array, atomic swap     │
                                   └──────────────────────────────────────────────┘
```

**Trust gate:** the loader is the security boundary. Filesystem-presence is not consent — every `.ts` file must appear in `~/.genie/hooks/trusted.json` with a matching SHA-256. `genie hook trust` is the only way to add an entry; capability declarations in the manifest header (e.g. `// @capabilities: pg-read, fs-read .genie/state/`) are surfaced at trust time so the operator approves the blast radius explicitly.

**Foreign-hook coexistence:** `genie hook import` is a one-time migration that takes the operator from "Token Optimizer's hook lives next to genie's in settings.json" to "genie is the only entry; Token Optimizer's hook is now a generated `_absorbed/<plugin>-<event>.ts` handler that `Bun.spawn`s the original command with the captured environment." Foreign perf cost is unchanged (still a subprocess), but they live in genie's chain, get spans, get measured by `genie doctor --perf`, and respect the F1 fallback story. Faster path is available later by replacing the generated handler with native TS.

**Custom hook deployment:** `genie hook scaffold rlmx-bash --event PreToolUse --tool Bash --run 'rlmx run --json'` writes a `.genie/hooks/rlmx-bash.ts` exporting `defineHook({ name, event, tool, priority, run })`. `genie hook trust .genie/hooks/rlmx-bash.ts` adds it to the allowlist. `genie hook reload` (or `genie serve restart`) makes it live. Same flow whether the operator wants `rlmx-on-Bash`, an audit hook, or anything else — code is the contract.

## Decisions

| Decision | Rationale |
|----------|-----------|
| Hooks are TS code in `.genie/hooks/`, not manifests | Code is the contract; one parser; one debug surface; `Handler` interface is already what internal handlers use. |
| In-process execution by default | Performance demands no per-event fork; `runHandler` try/catch contains throwing handlers; worker-subprocess pool deferred to delivery #3+ for plugins that won't comply with the in-process contract. |
| S3 three-tier scoping (per-team > per-repo > global) | Operator's actual use case ("rlmx for security only"); maps to existing event payload + genie's dual-scope state model. |
| Loud shadowing instead of silent suppression | Silent shadowing is exactly how supply-chain attacks land and how operator-edited configs go missing. |
| Trust allowlist (`trusted.json`) — filesystem presence is not consent | Without this, write to `$HOME` (or hostile `git clone`/npm postinstall/PR) = persistent keylogging on every CC event. |
| External `Handler` interface gains `version`/`source`/`manifest_path` | Versioning the contract before consumers depend on it is cheap; retrofitting later is not. |
| In-process invariants are a hard contract | Daemon stability is non-negotiable; mutable-runtime registry needs locked-down abuse surface. |
| Versioned absorb snapshots + audit log + drift detection on eject | Single snapshot is silently destroyed by a second `--apply`; versioned + audited makes the destructive operation safe to retry and reversible. |
| Probe-based env capture (denylist, not allowlist) | Allowlists silently break plugins (locale, cwd, session id); denylists silently leak less. |
| Ship `genie hook reload` + `genie hook test` with this delivery | "Restart serve per edit" is a flow-killer for the persona we want adopting this; reload + test make the inner loop livable without a full fs-watcher. |
| Quarantine for broken hook files + `[BROKEN]` rows in list | Broken hooks must be visible without grepping daemon logs; recovery should take seconds. |
| `genie hook scaffold` produces `defineHook({...})` config-object form | Operators shouldn't need to learn the full `Handler` interface for a one-line shell command; escape hatch preserves the contract for advanced cases. |
| Per-team hook archive lifecycle wired into `genie team archive` | Without this, archived teams' hooks orphan and fire surprise events. |
| Frozen registry, single-writer | Designed today, future hot-reload swap is one assignment, not a refactor. |
| 5 ms passthrough overhead becomes a measured SLO with bench + alert template | Without measurement, "≤5 ms" is unfalsifiable. |
| `absorb` → `import --from claude-settings`; `--dry-run` is default | Verb matches operator mental model; destructive operations should never be the default. |
| No Rust here; rides delivery #1's TS daemon | Don't rewrite proven code; Rust earns its keep on the cold-start path (delivery #5), not the daemon. |

## Risks & Assumptions

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| 1 | Filesystem-presence-is-consent → daemon-level RCE via hostile `<repo>/.genie/hooks/`, npm postinstall, or `$HOME`-write attacker | **Critical** | Trust allowlist, per-repo opt-in keyed by remote URL, capability declaration in manifest header, future `vm.Context` isolation. |
| 2 | A handler's transitive dep pulls in a conflicting `pg` major and corrupts the daemon's pool | High | In-process invariants as hard contract; loader rejects direct `pg` imports; handlers receive daemon-supplied Context. Worker pool deferred to delivery #3+. |
| 3 | Second `genie hook import --apply` destroys the original snapshot | High | Versioned snapshots + idempotency check + drift detection on eject. |
| 4 | Subprocess passthrough loses an env var, silently breaking a plugin | High | Probe-based env capture; denylist sensitive vars; replay verbatim. |
| 5 | Same-name shadowing silently disables an audited hook | Medium | Loud shadowing warning + `[shadowed]` annotation + `--strict-hooks` mode. |
| 6 | Boot-time scan only → flow-killer for hook authoring | Medium | `genie hook reload` + `genie hook test --payload` ship with this delivery. |
| 7 | Broken hook file silently disappears from `genie hook list` | Medium | Quarantine + sidecar error file + `[BROKEN]` row + `genie doctor --hooks`. |
| 8 | Archived team's hooks orphan and fire surprise events | Medium | `genie team archive` moves under `_archived/`; resolver excludes; `--orphans` surfaces. |
| 9 | Absorbed hook's target binary disappears | Low | `which` probe at `genie hook list` time; `[STALE]` annotation; `genie hook prune`. |
| 10 | "≤5 ms passthrough overhead" unfalsifiable without measurement | Low | Baked-in microbench in `genie doctor --perf`; per-handler timing spans; alert template. |

## Success Criteria

### Functional gates
- [ ] `genie hook trust <path>` adds an entry to `~/.genie/hooks/trusted.json`; daemon refuses to load any `.ts` file not listed (or whose SHA-256 doesn't match).
- [ ] A trusted `.ts` file exporting `{ default: defineHook(...) }` placed in any of the three tier dirs is discovered, validated, and dispatched against matching events after `genie serve restart` OR `genie hook reload`.
- [ ] `genie hook list` correctly reports discovered + trusted + loaded hooks per scope, annotates same-`name` shadowing as `[shadowed by <path>]`, broken imports as `[BROKEN]`, stale absorbed targets as `[STALE]`.
- [ ] `genie serve --strict-hooks` refuses to start when any same-`name` collision exists across tiers.
- [ ] Per-team scope filters by `payload.team_name`; a hook in `~/.claude/teams/security/hooks/` does NOT fire for events on team `dev`.
- [ ] `genie hook scaffold rlmx-bash --event PreToolUse --tool Bash --run 'rlmx run --json'` produces an editable `defineHook(...)` file with header comments naming the docs page + the `genie hook list` follow-up.
- [ ] `genie hook test rlmx-bash --payload fixtures/bash-pre.json` runs the hook against a recorded payload without daemon restart.
- [ ] `genie hook reload` re-runs the boot scan without dropping the UDS socket or in-flight dispatches.
- [ ] `genie hook import --dry-run` (default) emits a settings.json diff + generated `_absorbed/*.ts` list + checksum of the proposed final state. `--apply` writes a versioned snapshot, an audit-log entry, and rewrites settings.
- [ ] `genie hook import --eject` consumes the latest snapshot, verifies current settings.json checksum matches the post-apply hash, refuses (without `--force`) on drift, restores the original.
- [ ] After `--apply`, Token Optimizer keeps working unchanged end-to-end (its `read_cache.py` still fires on PreToolUse Read), and the captured env includes at minimum `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PROJECT_DIR`, `CLAUDE_SESSION_ID`, `LANG`, `LC_ALL`, `PATH`, `HOME`, `USER`, `TMPDIR`.
- [ ] `genie team archive <team>` moves the team's hooks folder to `_archived/<team>-<ts>/hooks/` and the resolver stops dispatching them.

### Performance & observability gates
- [ ] In-process external hook adds ≤ 0.5 ms to dispatcher P50 vs delivery #1's bench baseline.
- [ ] Subprocess-passthrough overhead measured by `genie doctor --perf`'s baked-in microbench: 100 events through a no-op passthrough handler, P50 ≤ 1 ms, P99 ≤ 5 ms vs the foreign command's own baseline.
- [ ] Daemon startup time grows ≤ 200 ms total even with 20 trusted hooks present.
- [ ] Every absorbed + user-authored hook emits `hook.delivery` spans with `data.hook_name` + `data.source`; no new instrumentation.
- [ ] `genie doctor --perf` regression detection works equally for first-party + absorbed + user-authored hooks; alert template ships at `docs/_internal/hookify/alerting.md`.

### Coexistence & safety gates
- [ ] `genie hook import --apply` works offline (no live CC session): falls back to `process.env` capture + repo-root cwd + fixture stdin; halts with remediation hint if both probe modes fail.
- [ ] `genie hook quarantine --revert <name>` moves a quarantined file back to its origin tier and triggers re-validation; on success it appears in `genie hook list` as `[loaded]`, on re-failure it returns to `_quarantine/` with an updated `.error` sidecar.
- [ ] Daemon startup succeeds even when 100% of `.genie/hooks/*.ts` files are broken — every broken file lands in `_quarantine/` with a sidecar; `genie hook list` shows them all as `[BROKEN]`; the daemon's UDS listener still serves builtin handlers.
- [ ] `Handler` discriminated-union loader: a `version: '99'` handler is rejected as `[BROKEN]`; a `version: '1'` handler loads; v2 (when introduced) and v1 handlers can register together without conflict.
- [ ] `genie team archive <team>` moves `~/.claude/teams/<team>/hooks/` to `_archived/<team>-<ts>/hooks/`; the resolver no longer dispatches them; `genie hook list --orphans` surfaces them; `genie team disband` prompts archive/delete/migrate-to-global.
- [ ] `genie hook prune --dry-run` (default) lists absorbed handlers whose `which` fails; `--apply` removes them; subsequent `genie hook list` no longer shows `[STALE]` rows.
- [ ] Registry mutation contract: a unit test verifies that `dispatch()` invoked during a `genie hook reload` finishes on its captured snapshot (no mid-event handler swap), and that the next `dispatch()` after reload sees the new array.
- [ ] `genie hook import --apply` is idempotent: re-running over an already-imported `settings.json` errors with a remediation hint, NOT silently overwriting.
- [ ] `_absorbed/snapshots/` retains last 10 snapshots; older ones GC'd; `latest` symlink updated atomically.
- [ ] Audit log at `~/.genie/audit/import.jsonl` records every import + eject + reload with timestamp, user, file paths, before/after checksums.
- [ ] If a generated `_absorbed/*.ts` handler crashes at runtime, `runHandler`'s try/catch contains it; failure is surfaced via `genie doctor --perf` HIGH severity (delivery #1 telemetry path).
- [ ] Council-flagged sentinel concerns explicitly addressed in the delivery report: trust allowlist invariant tested, env-capture probe verified across 3+ representative plugins (Token Optimizer + 2 others), versioned snapshots round-tripped (apply → eject → reapply → eject) with byte-for-byte equivalence.

## Council notes (round 1, abridged)

- **sentinel:** trust model is the load-bearing decision; allowlist is non-negotiable. Subprocess passthrough must capture full env via probe, not allowlist. Versioned snapshots required.
- **architect:** `Handler` interface needs versioning before external consumers; same-name silent suppression is the worst option; registry must be `ReadonlyArray<Handler>` with single-writer guarantee.
- **ergonomist:** `defineHook()` config-object form for scaffold; `genie hook reload` + `genie hook test` as the inner-loop affordance; rename `absorb` to `import`; broken hooks must be loud in `list`.
- **operator:** versioned snapshots (last 10) + audit log + checksum-guarded eject; per-team archive lifecycle; 5 ms claim must become a measured SLO with alert template.

Full Round 1 perspectives preserved in `.genie/brainstorms/hookify-third-party-absorption/COUNCIL.md` (orchestrator session transcript).
