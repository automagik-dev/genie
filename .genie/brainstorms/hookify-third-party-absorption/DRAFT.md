# Draft: Hookify Third-Party Absorption (delivery #2)

| Field | Value |
|-------|-------|
| **Slug** | `hookify-third-party-absorption` |
| **Date** | 2026-04-28 |
| **WRS** | 100/100 |
| **Umbrella** | Genie as universal Claude Code hookify layer (delivery #1 shipped as PR #1485, daemon + binary in production) |

## Context (from delivery #1)

- Daemon dispatch is live — `genie serve --headless` listens on `~/.genie/hook.sock`, multiplexes events to internal handler chain, retains caches across events.
- Native `genie-hook` binary is the one entry CC needs in `settings.json` for genie to function.
- Today the user's `~/.claude/settings.json` is a co-mingled mess: genie's hook entry lives next to Token Optimizer's, ultratoken's, any other plugin's. Each one fires its own fork-per-event, paying the same cold-start tax genie just escaped.
- Token Optimizer alone registers hooks on PreToolUse (Read, Bash, Agent|Task), PreCompact (3 entries), SessionStart (2+), and more — every hook spawns `bash → python` per event.

## Problem (one-liner)
Foreign Claude Code hooks each pay their own fork-per-event tax and clutter `~/.claude/settings.json`; genie should become the single CC hook entry that multiplexes downstream — preserving foreign hook semantics while eliminating their per-event cost.

## Scope

### IN
1. `.genie/hooks/` dir loader — daemon scans the three S3 tiers at boot, dynamic-`import()`s each `.ts` file, registers exported `Handler` in the dispatch chain.
2. Precedence resolver — same-`name` collisions resolved most-specific-wins; otherwise sorted by `priority`. Surfaced via `genie hook list`.
3. `genie hook scaffold <name>` — templates a `.genie/hooks/<name>.ts` with `--event`, `--tool`, `--run '<cmd>'`, and `--team <name>` / `--global` tier selectors.
4. `genie hook list` — debug surface showing discovered hooks per scope with effective precedence + conflicts.
5. `genie hook absorb` (with `--dry-run` / `--apply` / `--eject`) — one-time CC settings.json migration: generates `_absorbed/<plugin>-<event>.ts` subprocess-passthrough handlers preserving `CLAUDE_PLUGIN_ROOT` and per-hook env, then rewrites settings to point everything at genie.
6. Telemetry parity — external hooks get `hook.delivery` spans automatically (no new instrumentation; rides delivery #1's wiring).
7. Docs — public `docs/hookify.mdx` (Handler contract + scoping + scaffold/absorb) + internal `docs/_internal/hookify/authoring.md`.

### OUT (backlog for prioritization)
- **Hot reload of hook files** — boot-time scan only this delivery; operators restart `genie serve` to pick up new/changed hooks. fs-watcher + safe re-import lands in a follow-up (likely delivery #4 — active remediation).
- Pooled worker subprocess for non-JS plugins (Python/Ruby) — fast-path runtime for plugins that don't want to ship JS.
- Plugin marketplace / discovery / signature verification.
- Migration tooling for plugins that deeply integrate with `${CLAUDE_PLUGIN_ROOT}` beyond what the absorption layer preserves.
- Active remediation / auto-restart on hook failures.
- Rust thin client + per-language Rust worker host (delivery #5).
- Flag-based `genie hook attach` that doesn't write a file (keep code-is-the-contract invariant).
- Cross-host hook sync.

## Risks & Assumptions

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| 1 | Filesystem-presence-is-consent → daemon-level RCE via hostile `<repo>/.genie/hooks/`, npm postinstall, or `$HOME`-write attacker | **Critical** | Trust allowlist (`genie hook trust`), per-repo opt-in keyed by remote URL, capability declaration in manifest header, future `vm.Context` isolation. |
| 2 | A handler's transitive dep pulls in a conflicting `pg` major and corrupts the daemon's pool | High | In-process invariants documented as hard contract; loader rejects direct `pg` imports; handlers receive daemon-supplied Context. Worker-subprocess pool deferred to delivery #3+ for plugins that won't comply. |
| 3 | Second `genie hook import --apply` destroys the original snapshot, locking the operator out of rollback | High | Versioned snapshots + idempotency check + drift detection on eject. |
| 4 | Subprocess passthrough loses an env var (`CLAUDE_SESSION_ID`, `LANG`, `TMPDIR`, …), silently breaking a plugin | High | Probe-based env capture; denylist sensitive vars instead of allowlisting; replay verbatim. |
| 5 | Same-name shadowing silently disables an audited hook | Medium | Loud shadowing warning, `[shadowed]` annotation in `genie hook list`, `--strict-hooks` mode. |
| 6 | Boot-time scan only → flow-killer for hook authoring | Medium | `genie hook reload` (SIGHUP-style) + `genie hook test --payload` ship with this delivery. Full fs-watcher deferred. |
| 7 | Broken hook file silently disappears from `genie hook list` | Medium | Quarantine + sidecar error file + `[BROKEN]` row + `genie doctor --hooks`. |
| 8 | Archived team's hooks orphan and fire surprise events | Medium | `genie team archive` moves hooks under `_archived/`; resolver excludes; `--orphans` surfaces. |
| 9 | Absorbed hook's target binary disappears (e.g. user uninstalls Token Optimizer) | Low | `which` probe at `genie hook list` time; `[STALE]` annotation; `genie hook prune`. |
| 10 | "≤5 ms passthrough overhead" is unfalsifiable without measurement | Low | Baked-in microbench in `genie doctor --perf`; per-handler timing spans already plumbed; alert-rule template. |

## Success Criteria

### Functional gates
- [ ] `genie hook trust <path>` adds an entry to `~/.genie/hooks/trusted.json`; daemon refuses to load any `.ts` file not listed (or whose SHA-256 doesn't match).
- [ ] A trusted `.ts` file exporting `{ default: defineHook(...) }` placed in any of the three tier dirs is discovered, validated, and dispatched against matching events after `genie serve restart` OR `genie hook reload`.
- [ ] `genie hook list` correctly reports discovered + trusted + loaded hooks per scope, annotates same-`name` shadowing as `[shadowed by <path>]`, broken imports as `[BROKEN]`, stale absorbed targets as `[STALE]`.
- [ ] `genie serve --strict-hooks` refuses to start when any same-`name` collision exists across tiers.
- [ ] Per-team scope filters by `payload.team_name`; a hook in `~/.claude/teams/security/hooks/` does NOT fire for events on team `dev`.
- [ ] `genie hook scaffold rlmx-bash --event PreToolUse --tool Bash --run 'rlmx run --json'` produces an editable `defineHook(...)` config-object file with header comments naming the docs page and the `genie hook list` follow-up.
- [ ] `genie hook test rlmx-bash --payload fixtures/bash-pre.json` runs the hook against a recorded payload without daemon restart.
- [ ] `genie hook reload` re-runs the boot scan without dropping the UDS socket or in-flight dispatches.
- [ ] `genie hook import --dry-run` (default) emits a settings.json diff + the list of generated `_absorbed/*.ts` files + a checksum of the proposed final state. `--apply` writes a versioned snapshot at `~/.genie/hooks/_absorbed/snapshots/<ts>-<sha>.json`, an audit-log entry, and rewrites settings.
- [ ] `genie hook import --eject` consumes the latest snapshot, verifies current settings.json checksum matches the post-apply hash, refuses (without `--force`) if drift detected, restores the original.
- [ ] After `--apply`, Token Optimizer keeps working unchanged end-to-end (its `read_cache.py` still fires on PreToolUse Read), and the captured environment includes at minimum `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PROJECT_DIR`, `CLAUDE_SESSION_ID`, `LANG`, `LC_ALL`, `PATH`, `HOME`, `USER`, `TMPDIR`.
- [ ] `genie team archive <team>` moves the team's hooks folder to `_archived/<team>-<ts>/hooks/` and the resolver stops dispatching them.

### Performance & observability gates
- [ ] In-process external hook adds ≤ 0.5 ms to dispatcher P50 vs delivery #1's bench baseline (loader is free).
- [ ] Subprocess-passthrough overhead measured by `genie doctor --perf`'s baked-in microbench: 100 events through a no-op passthrough handler, P50 ≤ 1 ms, P99 ≤ 5 ms vs the foreign command's own baseline.
- [ ] Daemon startup time grows ≤ 200 ms total even with 20 trusted hooks present.
- [ ] Every absorbed hook + every user-authored hook emits `hook.delivery` spans with `data.hook_name` + `data.source` (`builtin|repo|team|global|absorbed`); no new instrumentation code.
- [ ] `genie doctor --perf` regression detection works equally for first-party + absorbed + user-authored hooks; alert-rule template ships at `docs/_internal/hookify/alerting.md`.

### Coexistence & safety gates
- [ ] `genie hook import --apply` is idempotent: re-running over an already-imported `settings.json` errors with a remediation hint, NOT silently overwriting.
- [ ] `_absorbed/snapshots/` retains the last 10 snapshots; older ones GC'd; `latest` symlink updated atomically.
- [ ] Audit log at `~/.genie/audit/import.jsonl` records every import + eject + reload with timestamp, user, file paths, before/after checksums.
- [ ] If a generated `_absorbed/*.ts` handler crashes at runtime, `runHandler`'s try/catch contains it; failure is surfaced via `genie doctor --perf` HIGH severity (delivery #1 telemetry path).

## Open questions

- **Discovery vs opt-in** — does genie scan `~/.claude/plugins/cache/*/*/hooks/hooks.json` and auto-absorb (zero plugin changes), or does each plugin opt in by registering with genie's API?
- **Trust model** — foreign hooks run arbitrary shell commands. If we run them in-process inside the daemon, a python crash in Token Optimizer takes down genie's hook listener. Sandbox boundary?
- **Per-call env** — CC sets `CLAUDE_PLUGIN_ROOT` per-hook. If genie multiplexes, we need to set it correctly when invoking each foreign command.
- **Backwards compat** — some plugins won't migrate. Do we leave their `settings.json` entries alone, or rewrite them under genie's control?
- **Async hooks** — Token Optimizer marks some hooks `async: true, timeout: 15000`. Genie's current chain is sequential. New abstraction?
- **Removal/uninstall** — if a plugin is uninstalled, how does genie know to stop dispatching to its hooks?

## Decisions
| Decision | Rationale |
|----------|-----------|
| **Hooks are TS/JS code in `.genie/hooks/`, not manifests or config** — drop a `.ts` file in the dir, it becomes a hook. No registration ceremony. | Code is the contract: an exported `Handler` (the same `src/hooks/types.ts` interface the existing internal handlers use) is all that's required. No new format, no parser, no schema drift. Plugin authors and operators write the same thing. |
| **In-process execution by default** — registered hooks run inside the daemon process (delivery #1's `dispatch()` chain), retaining caches and the pooled PG connection. | "Lightweight and performance" demands no subprocess fork per event for first-party + opt-in hooks. Crash isolation comes via `try/catch` per handler (already in `runHandler` at `src/hooks/index.ts:178-211`); a thrown handler doesn't kill the daemon. |
| **Filesystem discovery + hot reload** — daemon scans `.genie/hooks/*.ts` (per-repo) and `~/.genie/hooks/*.ts` (global) at startup and on file change; loads via dynamic `import()` and registers each module's exported handler. | No CLI registration step needed. `genie hook scaffold <name>` is sugar that templates a TS file; the file itself is the source of truth. Hot reload uses the same fs-watcher pattern as `agentWatcher` in `serve.ts`. |
| **Foreign-hook coexistence: passthrough absorption (subprocess on-demand)** — existing CC hooks in `~/.claude/settings.json` are absorbed by `genie hook absorb`. The command rewrites those entries to point at genie's binary, generates a thin generated-handler `.genie/hooks/_absorbed/<plugin>.ts` per foreign hook that shells out to the original command via `Bun.spawn`, and the daemon dispatches them like any other handler. Plugins don't change. | One-time migration; observable + measurable from then on; foreign perf cost is unchanged (still a subprocess) but they live in genie's chain so they're part of `genie doctor --perf` baselines and the F1 fallback story. Faster path is available later by replacing the generated handler with native TS. |
| **Custom hook deployment is just `genie hook scaffold`** — `genie hook scaffold rlmx-bash --event PreToolUse --tool Bash --run 'rlmx run --json'` writes a `.genie/hooks/rlmx-bash.ts` file from a template. | Operators get the "attach rlmx to every Bash" affordance without learning a config format. The TS file is editable post-scaffold for anything the template doesn't cover. |
| **No Rust here, no daemon rewrite** — Rust path stays in delivery #5 (binary size + per-language worker host); this delivery rides delivery #1's TS daemon. | Don't rewrite proven code. Lightweight = TS plus a fs-watcher; performance comes from the in-process call, not from a language change. |
| **Scoping: S3 — three-tier with explicit precedence** — `~/.claude/teams/<team>/hooks/*.ts` (per-team) > `<repo>/.genie/hooks/*.ts` (per-repo) > `~/.genie/hooks/*.ts` (global). Same `name` field across tiers → most-specific wins, others suppressed. Different names → all run, sorted by `priority`. | Lets operators isolate "rlmx for security team only" without affecting other teams. Maps onto existing event payload (`payload.team_name`, `payload.cwd`) and onto genie's existing dual-scope state model (worker registry global, wish state per-repo). |
| **Trust allowlist (council push-back: sentinel)** — hooks do NOT auto-load on filesystem presence; daemon refuses any `.ts` not listed in `~/.genie/hooks/trusted.json` (path → SHA-256 + scope). `genie hook trust <path>` is the only way to add an entry; it prints the diff + capabilities and demands explicit confirmation. Per-repo hooks default to off and require `genie hook trust --repo` keyed by `git remote URL + path`. | Without this, write access to `$HOME` (or a hostile `git clone`, npm postinstall, malicious PR landing in `<repo>/.genie/hooks/`) = persistent keylogging on every CC tool event. Filesystem presence is not consent. |
| **External `Handler` interface gains `version`/`source`/`manifest_path` fields (council push-back: architect)** — `Handler` (`src/hooks/types.ts`) extends with explicit version, origin tier, and source path. Loader validates the export shape before registering; partial registration is forbidden. | The contract becomes load-bearing for non-genie authors; versioning before any consumers depend on it is cheap, retrofitting later is not. |
| **In-process invariants are documented as a hard contract** — no `process.exit`, no `process.env` writes, no top-level await > 100 ms, no direct `pg` imports (handlers receive a daemon-supplied `Context` for DB access). Loader rejects modules that fail static checks where feasible. | Daemon stability is non-negotiable; today's frozen module-scope registry becomes mutable runtime data and we lock down the abuse surface before it bites in production. |
| **Loud shadowing instead of silent suppression (council push-back: architect, sentinel, ergonomist)** — same-`name` collisions emit `console.warn` at boot listing both source paths; `genie hook list` annotates suppressed entries with `[shadowed by <path>]`; `genie serve --strict-hooks` refuses to start on any collision (CI/prod opt-in). | Silent shadowing is exactly how supply-chain attacks land and how operator-edited configs go missing. The data model retains the suppressed entry so future `genie hook diff` surfaces what was discarded. |
| **Versioned absorb snapshots (council push-back: sentinel, operator)** — `genie hook import` (renamed from `absorb`) writes versioned snapshots at `~/.genie/hooks/_absorbed/snapshots/<ISO-timestamp>-<sha256>.json` (keep last 10) with a `latest` symlink. Refuses to import twice in a row (idempotency check via post-import hash on settings.json). Drift detection on `--eject` warns if settings.json was hand-edited after import. Audit log at `~/.genie/audit/import.jsonl` records every import/eject. | Single snapshot is silently destroyed by a second `--apply`; versioned + audited snapshots make the destructive operation safe to retry and reversible. |
| **Subprocess passthrough captures the full CC environment via probe, not an allowlist (council push-back: sentinel)** — on `genie hook import`, daemon spawns a probe hook through CC and captures `env` + `pwd` + stdin bytes. Stores the captured environment alongside the absorbed command; replays verbatim, with a hard *denylist* for sensitive vars (`GENIE_*`, `ANTHROPIC_API_KEY`, etc.) instead of an allowlist. | `CLAUDE_PLUGIN_ROOT` alone misses `CLAUDE_PROJECT_DIR`, `CLAUDE_SESSION_ID`, locale vars (Python plugins corrupt UTF-8 without `LANG`/`LC_ALL`), `TMPDIR`, `PATH`, and the cwd a direct CC invocation would have inherited. Allowlists silently break plugins; denylists silently leak less. |
| **`genie hook reload` ships with this delivery (council push-back: ergonomist, operator)** — SIGHUP-style command that re-runs the boot scan without dropping the socket or restarting the daemon. Pairs with **`genie hook test <name> --payload <fixture.json>`** for in-loop iteration without any reload. Full fs-watcher is still deferred to delivery #4. | "Restart `genie serve` per edit" is a flow-killer for hook authoring (the exact persona we want adopting this). The reload command is one extra subcommand; the test command lets the inner loop avoid restart entirely. |
| **`genie hook absorb` → `genie hook import --from claude-settings`** | "Absorb" reads as jargon. "Import" matches the operator's mental model (and leaves room for `--from <other-source>` later). `--dry-run` is the default; `--apply` is required to actually mutate. |
| **Quarantine for broken hook files** — failed-import files move to `_quarantine/` with a sidecar `<file>.error` containing the parse error; `genie hook list` displays them in a distinct `[BROKEN]` state with file path + line + remediation hint; `genie doctor --hooks` enumerates all hooks (loaded / skipped / quarantined). | Daemon must keep starting; broken hooks must be visible without grepping the daemon log; recovery from "daemon won't dispatch X" must take seconds, not minutes. |
| **Operator-friendly scaffold via `defineHook()` helper** — `genie hook scaffold` generates `export default defineHook({ name, event, tool, priority, run })` (config-object form) with the full `handler` callback escape hatch in commented-out below. | Operators authoring `rlmx-bash.ts` shouldn't need to learn the full `Handler` interface for a one-line shell command. The escape hatch keeps "code is the contract" intact for the 5% who need conditional logic. |
| **Per-team hook archive lifecycle (council push-back: operator)** — `genie team archive` moves `~/.claude/teams/<team>/hooks/` to `~/.claude/teams/_archived/<team>-<ts>/hooks/`; resolver excludes `_archived/`; `genie hook list --orphans` surfaces hooks whose owning team no longer exists; disband prompts archive/delete/migrate-to-global. | Without this, archived teams' hooks orphan and fire surprise events; "why is this old team's hook still running" is a real ops question we should never have to answer. |
| **Stale-target detection in `genie hook list`** — every absorbed hook's `run` command runs through `which` at list time; missing binaries get `[STALE] absorbed hook target missing: <path> — run 'genie hook prune'`. | Uninstalling Token Optimizer leaves absorbed handlers shelling out to a now-missing binary; the failure surface ("command not found" 50ms into every Bash) needs to be diagnosable without strace. |
| **Frozen registry, single-writer (council push-back: architect)** — registry is `let handlers: ReadonlyArray<Handler>`; populated once during `startHookSocket()` *before* `server.listen()`; `genie hook reload` builds a new array and atomically replaces the reference (in-flight dispatches finish on the old one). | Concurrent `dispatch()` calls today see a frozen array; making registration runtime data without locking down the mutation window is how subtle race bugs slip in. Designed today, the future hot-reload swap is one assignment, not a refactor. |
| **5 ms passthrough overhead becomes a measured SLO, not a vibe** — `genie doctor --perf` includes a baked-in microbench (100 events through a no-op passthrough hook) reporting P50/P95/P99 with pass/fail; per-handler `hook.delivery.duration_ms` already lands in `genie_runtime_events`; alert-rule template ships in `docs/_internal/hookify/alerting.md`. | Without a dashboard + alert template, "≤5 ms" is unfalsifiable. Operators need a single number to monitor and a documented threshold for "this hook just got slow." |

