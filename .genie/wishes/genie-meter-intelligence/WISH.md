# Wish: Genie on the Rust Meter and the Learning Loop

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `genie-meter-intelligence` |
| **Date** | 2026-11-11 |
| **Author** | Genie Dev (`gn-2`) |
| **Appetite** | medium; four bounded groups (all within the 10-file / 800-line ideal band), plus two declared sibling wishes and four cross-repo meter/herdr requests |
| **Branch** | `docs/gn-2-plan-genie-on-the-rust-meter-and-the-lea` (plan); implementation branches minted per group after owner approval |
| **Repos touched** | `automagik-si/genie` (consumer surfaces only; requests to `automagik-si/automagik` are read-only cross-repo REQUESTS) |
| **Design** | _No brainstorm — direct wish_ |

## Summary

This wish plans how Genie adopts the shared Rust usage meter (`~/.local/bin/usagemeter`, capability `meter.usage@1`, Contract 1 envelope per `docs/rfcs/0017-usagemeter-crate.md`, `docs/rfcs/0018-meter-query-contract.md`, `docs/rfcs/0021-meter-attribution.md`, and `docs/rfcs/0026-bot-tag-coverage.md`) across the Herdr Tasks board (`plugins/genie-herdr` and `crates/genie-rs`) and Genie's CLI reporting (`genie metrics export`, `genie wish report`), retiring Genie's duplicate TypeScript session-log parsers and Phoenix OpenTelemetry span projection behind frozen shared-input comparison fixtures and a one-release deprecation path. It also closes the **learning loop** ("learn from our own past") with a read-only Rust report verb (`genie-rs learn` / `genie metrics learn`) that joins `usagemeter query`, `usagemeter outcomes`, and `usagemeter coverage` with git/PR task history (`.genie/tasks.jsonl`) to produce per-task and per-role efficiency/outcome metrics and **ranked, evidence-cited advisory proposals** for team setup (model per role, repair budget, brief size) without ever auto-editing files or bot definitions. Finally, it specifies how the learning loop runs **24/7 with zero daemon** by pairing fork-and-exit Rust commands with OS/Herdr-pack timers and fleet-wide summary roll-ups between the owner's laptop and the build box via four explicit cross-repo **REQUESTS** (`REQUEST-1`..`REQUEST-4`) to the meter and Herdr pack owners.

## Scope

### IN

- **Part A — Board cost from the meter (program's S1):** Rust `usagemeter query` consumer in `crates/genie-tasks` and `crates/genie-rs` plus the Herdr Tasks board (`plugins/genie-herdr/data.js`, `main.js`) reading `usagemeter query --repo <host/owner/repo> --by task --json` with per-branch (`--branch <b>`) fallback, canonical repo-slug normalization (`host/owner/repo` per `meter/schema/query/v1/repo-normalization.json`), and honest display rules (time, tokens, and estimated USD per card; `null` / `missing` / `unpriced` is never rendered as `0`; branch fallback is badged `branch est.` so it is never confused with task-attributed spend).
- **Part B — One source of truth (program's R):** Frozen shared-input comparison fixtures comparing the legacy TypeScript session-log parser against `usagemeter`; cutting `genie metrics export` and `genie wish report` over to `usagemeter query`; and a one-release deprecation stub (exit `2` with migration notice on `stderr`, matching `genie orca`) for `genie metrics export --phoenix`, `genie metrics prices update`, `scripts/observability/backfill.ts`, `scripts/observability/annotate.ts`, `scripts/mikro/phoenix.ts`, and `.claude/workflows/observability-review.js`.
- **Part C — The learning loop ("learn from our own past"):** Read-only Rust report verb (`genie-rs learn [--window d1|d7|d30] [--json] [--write-latest]`, surfaced at `genie metrics learn`) combining `usagemeter query` (`--by task`, `--by bot`, branch), `usagemeter outcomes --json` (`tool_error`, `api_error`, `run_failed`, two-clock time to PR `to_open_s`/`to_merge_s` and `launch_to_open_s`/`launch_to_merge_s`), and `usagemeter coverage --json` (`bot_coverage`, unattributed classes) with `.genie/tasks.jsonl` / `genie-forge` PR repair history (`pushed_after_open`), ending in ranked, evidence-cited advisory proposals for team setup (model per role, repair budget, brief size / group split threshold).
- **Part D — 24/7 without a daemon (consumer side + named cross-repo requests):** Consuming local/fleet snapshots on demand and writing `.genie/metrics/learn-latest.json` via fork-and-exit execution with zero resident Genie process, paired with four named cross-repo **REQUESTS** (`REQUEST-1`..`REQUEST-4`) to the meter and Herdr pack owners for task-keyed outcomes, headless OS timer installation, multi-machine query/outcomes roll-up, and periodic post-sync report generation.
- **Part E — Everything Rust boundary:** Implementing the meter query client, canonical repo-slug normalizer, and learning-loop engine in `crates/genie-tasks` and `crates/genie-rs` now, while keeping `src/term-commands/metrics.ts` and `src/term-commands/wish.ts` as thin TypeScript CLI front doors until the sibling Rust CLI cutover wish.

### OUT

- Any modification to `usagemeter`, its SQLite store, its Contract 1 schema, or `herdr/mods/am-sidebar/meter.js` inside this repository (Genie is strictly a consumer; meter and Herdr pack capabilities are requested via `REQUEST-1`..`REQUEST-4` to the Automagik meter/herdr owners).
- Any resident daemon, background file watcher, or network telemetry push from Genie.
- Any automatic mutation of bot definitions, model assignments, skills, or repository configuration by the learning loop (proposals are strictly advisory; the owner or Captain reviews and applies them).
- Exporting or syncing raw session transcripts across machines (raw logs never leave the machine where the harness wrote them; only `usagemeter` aggregate envelopes travel).
- Full deletion of the one-release deprecation stubs and full replacement of the TypeScript Commander CLI front doors (`src/term-commands/metrics.ts`, `src/term-commands/wish.ts`) with a pure-Rust CLI binary (scoped into Sibling Wish 1: `genie-metrics-rust-cutover`).
- Cross-machine fleet digest consumption and multi-squad rollout before `REQUEST-2`..`REQUEST-4` and owner decisions `D1`–`D4` are settled (scoped into Sibling Wish 2: `genie-fleet-learning-digest`).

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 (`PENDING OWNER`) | **PENDING OWNER:** The hub's first consumer is the Genie squad's own orchestrators and the owner (a report plus board numbers), not an external product. | Focuses the schema and CLI output on actionable squad operations (Herdr Tasks board cards + Captain/owner learning report) before adding external UI or multi-tenant abstractions. |
| D2 (`PENDING OWNER`) | **PENDING OWNER:** Proposals are advisory; nothing auto-tunes the team. | `genie-rs learn` outputs ranked, evidence-cited recommendations (model per role, repair budget, brief size), never mutating bot definitions, skills, or configs; the owner or Captain decides and applies changes. |
| D3 (`PENDING OWNER`) | **PENDING OWNER:** Raw transcripts never leave their machine; only the meter's aggregates travel. | Preserves privacy and small payload bounds across the owner's laptop and the build box; only `usagemeter` aggregate envelopes (`query`, `outcomes`, `coverage`, `herdr-meter`) cross machine boundaries. |
| D4 (`PENDING OWNER`) | **PENDING OWNER:** Scope is the genie repo first; other squads adopt it later through the same meter contract. | Proves the Contract 1 consumer, deprecation path, and learning-loop heuristics on `.genie/tasks.jsonl` and `automagik-si/genie` before generalizing to other squad repos. |
| D5 (Board attribution & fallback) | Query `usagemeter query --repo <host/owner/repo> --by task --json` first; fall back to `--branch <branch>` per card when a task has no M3 task-tagged rows yet, and render `"–"` whenever state is `missing`, `unsupported`, or `unpriced`. | Matches RFC 0018 (`meter.usage@1`) and RFC 0021 (D4): unknown is never `0`, and branch-level estimates are explicitly badged (`branch est.`) so they are never confused with task-attributed spend. |
| D6 (One-release Phoenix & TS parser retirement) | Freeze shared-input comparison fixtures first; switch `genie metrics export` and `genie wish report` to `usagemeter query`; turn `--phoenix`, `genie metrics prices update`, `scripts/observability/*`, `scripts/mikro/phoenix.ts`, and `observability-review.js` into 1-release exit-`2` deprecation stubs. | Follows the repository's `genie orca` one-release retirement rule in `AGENTS.md` and proves numerical continuity on frozen inputs before deleting the legacy TypeScript log parser. |
| D7 (Rust-first boundary) | Implement the meter client, canonical repo normalizer, and learning-loop engine in `crates/genie-tasks` + `crates/genie-rs`; keep `src/term-commands/{metrics,wish}.ts` as thin argv forwarders. | Avoids writing new metering or aggregation logic in TypeScript while avoiding a premature rewrite of the entire Commander CLI tree in this wish. |
| D8 (Cross-repo requests vs execution groups) | Record the four meter/Herdr capabilities needed for task-level outcomes and 24/7 multi-machine scheduling as `REQUEST-1`..`REQUEST-4` to the meter/herdr owners, not as Genie execution groups. | Honors the consumer boundary: Genie consumes `usagemeter` and never forks or edits the meter contract. |

### Cross-Repo Requests to Meter & Herdr Owners (Not Genie Execution Groups)

- **`REQUEST-1` (to `usagemeter` owners — task-keyed outcomes in `usagemeter outcomes --json`):** Add optional `task` (`task_id` from launch tags per `docs/rfcs/0021-meter-attribution.md` D4) to `usagemeter outcomes --json` failure rows (`tool_error`, `api_error`, `run_failed`) and PR timing rows (or support `usagemeter outcomes --by task`), so `genie-rs learn` can join failures directly by `task_id` even when one bot works on multiple tasks in the same window. Until `REQUEST-1` lands, Group 4 joins outcomes via `branch` (`to_open_s`, `launch_to_open_s`) and `(bot, role)` actors from `usagemeter query --by task`.
- **`REQUEST-2` (to Herdr pack / `automagik-herdr` owners — headless 24/7 OS timer for `usagemeter sync`):** Today `herdr/mods/am-sidebar/meter.js` runs `usagemeter sync` every 10 minutes (`METER_EVERY_MS`) only while the Herdr desktop window is open. Request that `automagik-herdr meter install` optionally install a daemon-free OS timer (`systemd --user` timer on Linux, `launchd` `StartInterval` on macOS) that runs `~/.local/bin/usagemeter sync` every 10 minutes when Herdr UI is closed (e.g. on the build box or when the owner's laptop lid reopens), sharing the meter's 10-minute freshness gate.
- **`REQUEST-3` (to Herdr pack & `usagemeter` owners — multi-machine fleet roll-up for `query --by task` and `outcomes`):** Today `am-sidebar/meter.js` and `am/meterFleet.js` combine `usagemeter coverage` across connected linked machines (`hc exec --on <machine>`) into `fleet-coverage.json` and publish per-machine `herdr-meter` summary docs, but neither `query --by task` nor `outcomes` is rolled up across machines. Request a read-only fleet roll-up file (`fleet-usage.json` / `fleet-outcomes.json` beside `fleet-coverage.json`, or `automagik-herdr meter fleet-query`) combining aggregate envelopes from the owner's laptop and the build box without moving raw transcripts.
- **`REQUEST-4` (to Herdr pack owners — post-sync periodic trigger for `genie-rs learn`):** Request an optional post-sync hook in `am-sidebar/meter.js` (or the `REQUEST-2` timer script) that invokes `genie-rs learn --window d7 --json --write-latest` (fork-and-exit) at most once per 24 hours after a clean `usagemeter sync` on tracked Genie checkouts, writing `.genie/metrics/learn-latest.json` so the Captain and owner always have a fresh advisory report ready on disk with zero resident process.

### Declared Sibling Wishes (Outside This Wish's Admission Band)

- **Sibling Wish 1 (`genie-metrics-rust-cutover`):** Release N+1 removal of the one-release deprecation stubs (`--phoenix`, `genie metrics prices update`, `scripts/observability/*`, `scripts/mikro/phoenix.ts`, `src/lib/metrics-phoenix.ts`, `src/lib/metrics-prices.ts`, `.claude/workflows/observability-review.js`) and migration of the thin TypeScript CLI front doors (`genie metrics`, `genie wish report`) into the native `genie-rs` binary as part of the repo-wide TS-to-Rust CLI cutover.
- **Sibling Wish 2 (`genie-fleet-learning-digest`):** Multi-machine learning-loop ingestion (reading the `REQUEST-3` fleet roll-up across the owner's laptop and the build box, plus the `REQUEST-4` daily snapshot) and cross-squad rollout once `REQUEST-1`..`REQUEST-4` and owner decisions `D1`–`D4` are approved.

## Simplicity Case

- **Simplest complete design:** One Rust child-process adapter in `crates/genie-tasks` calling `~/.local/bin/usagemeter` (`query`, `outcomes`, `coverage` with `--json`), wired into `genie-tasks` / `genie-rs` for board cards, existing CLI report verbs, and one deterministic read-only `learn` report verb.
- **Added machinery:** Frozen shared-input comparison fixtures (`src/lib/__fixtures__/meter-parity/`) and 1-release exit-`2` deprecation stubs for Phoenix and legacy observability scripts, required by the repository's deprecation contract (`AGENTS.md`) and numerical parity gate.
- **Deferred until measured:** No resident daemon, no local caching SQLite table in `.genie/genie.db`, no auto-tuning mutation engine, and no cross-machine transport inside Genie (delegated to Herdr's existing `hc exec` fleet pass via `REQUEST-2`..`REQUEST-4` and Sibling Wish 2).
- **Complexity removed:** Retires ~2,300 lines of duplicate TypeScript session-log scanning, LiteLLM price-table fetching, and Phoenix OpenTelemetry span projection (`src/lib/metrics-usage.ts`, `src/lib/metrics-phoenix.ts`, `src/lib/metrics-prices.ts`, `scripts/observability/backfill.ts`, `scripts/observability/annotate.ts`, `scripts/mikro/phoenix.ts`, `.claude/workflows/observability-review.js`).

## Dependencies

**depends-on:** genie-v7-board
**blocks:** none

- **Prerequisite wish (`genie-v7-board`, SHIPPED):** Established the read-only Herdr Tasks board (`plugins/genie-herdr`) and `genie-rs list --json` / `forge-sync` pipeline that Group 1 extends with live `usagemeter query` task/branch attribution.
- **Runtime dependency (`~/.local/bin/usagemeter`, Contract 1 `meter.usage@1`):** Genie invokes `usagemeter` as a fork-and-exit subprocess (`USAGEMETER_BIN` override, falling back to `~/.local/bin/usagemeter` and `PATH`). When `usagemeter` is absent or returns non-zero (`1, 2, 10..15`), board cards degrade gracefully to `"–"` and CLI commands return structured Contract 1 error codes without crashing.
- **Cross-repo requests (`REQUEST-1`..`REQUEST-4`, non-blocking for Groups 1–4):** Owned by the Automagik meter/herdr squad (`automagik-si/automagik`). Groups 1–4 ship against today's `usagemeter` `0.3.x` Contract 1 CLI using branch/actor joins and local `--write-latest` snapshots, and automatically enrich when `REQUEST-1`..`REQUEST-4` land.
- **Follow-on sibling wishes (`genie-metrics-rust-cutover`, `genie-fleet-learning-digest`):** Sequenced after this wish ships and after owner decisions `D1`–`D4` and `REQUEST-1`..`REQUEST-4` settle.

## Success Criteria

- [ ] **Part A (Board cost from `usagemeter`):** `genie-rs list --json --project <p>` and `plugins/genie-herdr` populate each task card's `usd`, `tokens`, `work_min`, `cost_state`, and `attribution_basis` (`"task"` | `"branch_fallback"` | `null`) from `usagemeter query --repo <host/owner/repo> --by task --json` with `--branch <b>` fallback; unknown, missing, or unpriced values render as `"–"`, never `0`.
- [ ] **Part B.1 (Shared-input parity & CLI cutover):** Frozen shared-input comparison fixtures prove agreement between legacy TypeScript parsing and `usagemeter query` within documented normalization rules, and both `genie metrics export` and `genie wish report` source token/cost totals from `usagemeter query` while preserving `wish report` workflow fields (`verdict`, `repairs`, `gateExitCode`, `checks`, `wrs`, `offloads`).
- [ ] **Part B.2 (One-release Phoenix & TS parser deprecation):** `genie metrics export --phoenix`, `genie metrics prices update`, `scripts/observability/backfill.ts`, `scripts/observability/annotate.ts`, `scripts/mikro/phoenix.ts`, and `.claude/workflows/observability-review.js` exit `2` with a clear migration notice on `stderr`, and duplicate TypeScript log-scanning / Phoenix projection internals are removed.
- [ ] **Part C (The learning loop & advisory proposals):** `genie-rs learn [--window d1|d7|d30] [--json] [--write-latest]` (and `genie metrics learn`) joins `usagemeter query`, `usagemeter outcomes`, and `usagemeter coverage` with `.genie/tasks.jsonl` to report per-task and per-role efficiency, two-clock PR timing (`to_open_s`/`to_merge_s`, `launch_to_open_s`/`launch_to_merge_s`), failure classes (`tool_error`, `api_error`, `run_failed`), orchestration vs worker share, and ranked, evidence-cited advisory proposals without modifying any tracked file or bot definition.
- [ ] **Part D & E (Zero-daemon 24/7 operation & Rust boundary):** All new meter querying, repo-slug normalization, and learning-loop calculation live in `crates/genie-tasks` and `crates/genie-rs` as fork-and-exit commands; `.genie/metrics/learn-latest.json` can be written atomically by any OS/Herdr timer (`REQUEST-2`, `REQUEST-4`) with zero resident Genie process.
- [ ] **Full repository gate:** `bun run check` and `cargo test --workspace --locked` exit `0` across all groups.

## Execution Strategy

### Wave 1 (sequential foundation: Rust meter adapter + CLI parity cutover)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 1 | engineer | Medium — Rust `usagemeter` subprocess client, canonical `host/owner/repo` normalization (`repo-normalization.json`), task/branch fallback join in `genie-tasks`/`genie-rs`, and Herdr board card wiring in `plugins/genie-herdr`. Size: ~7 files, ~650 insertions | inherit | Board cost from the Rust meter (S1): wire `usagemeter query` into `genie-rs list/status` and `plugins/genie-herdr` with honest `"–"` states and `branch est.` fallback badges |
| 2 | engineer | Medium — deterministic parity fixtures comparing legacy TS parser vs `usagemeter query`, plus cutting `genie metrics export` and `genie wish report` over to `usagemeter`. Size: ~8 files, ~700 insertions | inherit | Shared-input comparison fixtures and CLI cutover to `usagemeter` (R — Part 1) |

### Wave 2 (parallel after Group 2: 1-release deprecation stubs + Rust learning loop)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 3 | engineer | Low-medium — 1-release exit-`2` deprecation stubs for `--phoenix`, `prices update`, `scripts/observability/*`, `scripts/mikro/phoenix.ts`, and `observability-review.js`, deleting ~1,900 lines of TS log/Phoenix internals. Size: ~10 files, ~450 insertions / ~1,900 deletions | inherit | One-release deprecation of Phoenix and TypeScript log parsers (R — Part 2) |
| 4 | engineer | Medium-high — `crates/genie-tasks/src/learn.rs` joining `usagemeter` (`query`, `outcomes`, `coverage`) + `.genie/tasks.jsonl`, per-task/per-role tables, evidence-cited advisory proposals, and `--write-latest` snapshot. Size: ~8 files, ~750 insertions | inherit | The Rust learning-loop report (`genie-rs learn` / `genie metrics learn`) and advisory team-setup proposals (Parts C, D & E) |

Wave 1 runs sequentially (Group 1 lands the Rust `usagemeter` client and repo normalizer; Group 2 builds on Group 1 to freeze parity fixtures and cut `genie metrics export` and `genie wish report` over to `usagemeter`). Wave 2 (Groups 3 and 4) can run in isolated worktrees after Group 2 merges, or sequentially if sharing `src/term-commands/metrics.ts`.

**Global constraints:**
- **Group admission cap:** Every group stays strictly within the 10-file / 800-insertion ideal band (and well below the 25-file / 2,000-insertion hard cap).
- **Consumer-only meter boundary:** Genie never modifies `usagemeter`, its SQLite store, or `herdr/mods/am-sidebar/meter.js`. Cross-repo capabilities live exclusively in `REQUEST-1`..`REQUEST-4`.
- **Zero-daemon invariant:** Every command in `genie-rs` and `genie` is fork-and-exit; there is no resident watcher or background daemon.
- **Unknown is never zero:** Missing, unsupported, or unpriced metrics must serialize as `null` with explicit state (`"missing"`, `"unsupported"`, `"unpriced"`) and render in UI/text tables as `"–"`, never `0` or `$0.00`.
- **Advisory-only learning loop:** `genie-rs learn` is strictly read-only on repository config, skills, and bot definitions (its only optional disk write is `--write-latest` to gitignored `.genie/metrics/learn-latest.json`).
- **Public repo hygiene:** Zero machine names, IP addresses, ports, user accounts, or absolute workstation filesystem paths in any code, fixture, test, or doc.
- **Shared-workspace git freeze:** Subagents never mutate repo-level git state (`checkout`, `switch`, `reset`, `stash`, `rebase`); only the orchestrator moves `HEAD`.
- **Full gate required:** `bun run check` and `cargo test --workspace --locked` must pass at the end of every group.

## Execution Groups

### Group 1: Board cost from the Rust meter (S1)

**Goal:** Connect `crates/genie-tasks`, `crates/genie-rs`, and the Herdr Tasks board (`plugins/genie-herdr`) to `~/.local/bin/usagemeter query` so every task card displays honest, deduplicated time, tokens, and estimated USD with per-branch fallback when task tags are absent.

**Deliverables:**
1. **`crates/genie-tasks/src/meter.rs`:** Implement canonical `host/owner/repo` slug normalization from `git remote get-url origin` matching `meter/schema/query/v1/repo-normalization.json` (handling SCP-like `git@host:owner/repo.git`, `ssh://`, `https://`, stripping credentials/ports/`.git`, lowercase `host/owner/repo`), plus a fork-and-exit `usagemeter` runner (`USAGEMETER_BIN` env override, then `~/.local/bin/usagemeter`, then `usagemeter` on `PATH`) that parses Contract 1 (`meter.usage@1`) JSON envelopes and handles exit codes `0, 1, 2, 10..15` without panicking.
2. **Task-first, branch-fallback attribution in `crates/genie-tasks/src/store.rs` and `crates/genie-rs/src/lib.rs`:** When `genie-rs list --json --project <p>` or `genie-rs status <id> --json` runs, query `usagemeter query --repo <slug> --by task --window d30 --json` once per project call and join rows by `task_id`. For open or merged tasks with no task-attributed row (pre-M3 tasks), query/match branch rows (`--branch <branch>`) and tag `attribution_basis: "branch_fallback"` vs `"task"`.
3. **Additive task JSON fields:** Add `usd: Option<f64>`, `tokens: Option<u64>`, `work_min: Option<u64>`, `cost_state: "priced" | "partial" | "unpriced" | "missing"`, `attribution_basis: Option<"task" | "branch_fallback">`, and `bots: Vec<TaskBotUsage>` to `list --json` and `status --json` task objects while keeping `genie.db` strictly read-only during `list` and `status`.
4. **Herdr Tasks board update (`plugins/genie-herdr/data.js`, `main.js`, `data.test.ts`):** Consume the new `genie-rs list --json` cost/time/token fields directly (falling back to `herdr-meter` doc if present), render `"–"` whenever `cost_state` is `"missing"` or `"unpriced"`, render `$0.00` only for measured zero, and show a subtle `branch est.` badge in the card/drawer when `attribution_basis === "branch_fallback"`.

**Interfaces:**
- Consumes:
  - `~/.local/bin/usagemeter query --repo <host/owner/repo> --by task --window d30 --json` and `--branch <branch> --json` (Contract 1 `meter.usage@1` envelope).
  - Existing `genie_tasks::Store::tasks()` and `genie-rs list --json --project <p>` from `genie-v7-board`.
- Produces:
  - `genie_tasks::meter::{normalize_repo_slug, query_repo_by_task, query_repo_by_branch, MeterTaskSummary, CostState, AttributionBasis}`.
  - Extended `genie-rs list --json` / `status --json` fields: `usd`, `tokens`, `work_min`, `cost_state`, `attribution_basis`, `bots`.

**Acceptance Criteria:**
- [ ] `normalize_repo_slug` passes all canonical vectors from `meter/schema/query/v1/repo-normalization.json` (`https://`, `git@`, `ssh://`, ports, `.git` suffix, case normalization).
- [ ] On a mocked `usagemeter` binary returning Contract 1 JSON, `genie-rs list --json` populates `usd`, `tokens`, `work_min`, `cost_state: "priced"`, and `attribution_basis: "task"` for task-tagged rows, and `attribution_basis: "branch_fallback"` for branch-matched tasks lacking a task tag.
- [ ] When `usagemeter` is missing, exits non-zero (`1, 2, 10..15`), or reports `unpriced_models` with `estimated_cost_usd: null`, `cost_state` is `"missing"` or `"unpriced"`, `usd` is `null`, and `plugins/genie-herdr` renders `"–"`, never `0`.
- [ ] `genie-rs list --json` still leaves `.genie/genie.db` byte-identical (sha256 before and after).

**Validation:**
```bash
cargo fmt --check && cargo clippy --workspace --all-targets --locked -- -D warnings && cargo test --workspace --locked && bun test plugins/genie-herdr/data.test.ts
```

**depends-on:** none

---

### Group 2: Shared-input comparison fixtures and CLI cutover to usagemeter (R — Part 1)

**Goal:** Prove numerical continuity between the legacy TypeScript session-log parser and `usagemeter query` on frozen fixtures, then switch `genie metrics export` and `genie wish report` to read usage and cost from `usagemeter`.

**Deliverables:**
1. **Frozen shared-input parity fixtures (`src/lib/__fixtures__/meter-parity/`):** Commit sanitized, synthetic Claude/Codex session JSONL fixtures and corresponding `usagemeter query --json` golden envelopes covering priced models, cache read/write tokens, unpriced models (`cost_state: "unpriced"`), and subagent deduplication.
2. **Parity test suite (`src/lib/metrics-parity.test.ts`):** Verify that on the frozen fixtures, token totals (`input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `total_tokens`) and `estimated_cost_usd` match between the legacy parser and `usagemeter` Contract 1 envelopes (and document the exact intentional improvements where `usagemeter` deduplicates subagent sidecars and uses embedded `pricing.json`).
3. **Cut over `genie metrics export` (`src/lib/metrics-export.ts`, `src/term-commands/metrics.ts`):** Replace calls to `collectUsageSummary` (`src/lib/metrics-usage.ts`) with `usagemeter query --window <w> --repo <slug> --json` (via `genie-rs` / `usagemeter`), mapping Contract 1 `totals`, `groups`, `cost_state`, and `warnings` into the export report while preserving `--json` and markdown table output.
4. **Cut over `genie wish report` (`src/term-commands/wish.ts`, `src/term-commands/wish-report.test.ts`):** Source wish/task token and USD totals from `usagemeter query` while preserving all workflow telemetry fields (`verdict`, `repairs`, `gateExitCode`, `checks`, `wrs`, `offloads`).

**Interfaces:**
- Consumes:
  - `genie_tasks::meter` / `usagemeter query --json` from Group 1.
- Produces:
  - Frozen parity fixture corpus under `src/lib/__fixtures__/meter-parity/`.
  - `genie metrics export` and `genie wish report` backed by `usagemeter query`.

**Acceptance Criteria:**
- [ ] `bun test src/lib/metrics-parity.test.ts` passes and asserts exact token and cost parity (plus documented subagent dedup delta) on frozen synthetic fixtures.
- [ ] `genie metrics export --json` and `genie wish report <slug> --json` invoke `usagemeter` (no direct `~/.claude/projects` or `~/.codex/sessions` scanning) and preserve exit codes (`0` success, `1` runtime error, `2` usage/refusal) and workflow fields.
- [ ] When `usagemeter` reports `"unpriced"` or `"partial"` cost state, `genie metrics export` and `genie wish report` surface the state honestly rather than coercing `null` cost to `0`.

**Validation:**
```bash
bun test src/lib/metrics-parity.test.ts src/lib/metrics-export.test.ts src/term-commands/wish-report.test.ts && bun run check
```

**depends-on:** 1

---

### Group 3: One-release deprecation of Phoenix and TypeScript log parsers (R — Part 2)

**Goal:** Retire Genie's duplicate TypeScript session-log scanner, LiteLLM price fetcher, and Phoenix OpenTelemetry span projection behind deterministic one-release exit-`2` deprecation stubs matching the `genie orca` retirement contract.

**Deliverables:**
1. **CLI deprecation stubs (`src/term-commands/metrics.ts`):** Make `genie metrics export --phoenix` and `genie metrics prices update` print a concise one-release retirement notice to `stderr` (`genie metrics --phoenix and local price-table updates are retired; usage and cost are now served by usagemeter (`usagemeter query`) and `genie metrics learn`.`) and exit `2`.
2. **Script & workflow deprecation stubs (`scripts/observability/backfill.ts`, `scripts/observability/annotate.ts`, `scripts/mikro/phoenix.ts`, `.claude/workflows/observability-review.js`):** Replace the Phoenix OTLP / GraphQL span upload and review scripts with 20-line exit-`2` retirement stubs printing the migration notice to `stderr`.
3. **Retire duplicate TS internals (`src/lib/metrics-usage.ts`, `src/lib/metrics-phoenix.ts`, `src/lib/metrics-prices.ts`):** Remove the ~1,900 lines of live `~/.claude` / `~/.codex` log traversal, LiteLLM remote fetch, and Phoenix span projection logic, keeping only the minimal types or fixture helpers needed by `metrics-parity.test.ts` until Sibling Wish 1 (`genie-metrics-rust-cutover`) removes the stubs in release N+1.
4. **Update tests (`src/lib/metrics-deprecation.test.ts`):** Test success, error exit code (`2`), `stderr` migration text, and idempotency across every deprecated surface.

**Interfaces:**
- Consumes:
  - Cut-over `genie metrics export` and `genie wish report` from Group 2.
- Produces:
  - Exit-`2` one-release retirement stubs for `--phoenix`, `genie metrics prices update`, `scripts/observability/{backfill,annotate}.ts`, `scripts/mikro/phoenix.ts`, and `.claude/workflows/observability-review.js`.

**Acceptance Criteria:**
- [ ] Running `genie metrics export --phoenix`, `genie metrics prices update`, `bun scripts/observability/backfill.ts`, `bun scripts/observability/annotate.ts`, `bun scripts/mikro/phoenix.ts`, or `node .claude/workflows/observability-review.js` writes the retirement notice to `stderr`, makes zero network or filesystem writes, and exits `2`.
- [ ] `bun run knip` (dead-code analysis) and `bun run check` pass with zero unused exports after removing the legacy TypeScript parser/Phoenix internals.

**Validation:**
```bash
bun test src/lib/metrics-deprecation.test.ts src/lib/metrics-parity.test.ts && bun run check
```

**depends-on:** 2

---

### Group 4: The Rust learning-loop report and advisory proposals (Parts C, D & E)

**Goal:** Build the read-only Rust learning-loop engine (`crates/genie-tasks/src/learn.rs`, `genie-rs learn`, `genie metrics learn`) that joins `usagemeter` (`query`, `outcomes`, `coverage`) with `.genie/tasks.jsonl` PR history to report per-task and per-role efficiency/outcomes and emit ranked, evidence-cited advisory proposals for team setup.

**Deliverables:**
1. **`crates/genie-tasks/src/learn.rs` data join & metrics engine:**
   - Invoke `usagemeter query --repo <slug> --by task --window <w> --json`, `usagemeter query --repo <slug> --by bot --window <w> --json`, `usagemeter outcomes --window <w> --json`, and `usagemeter coverage --window <w> --json`.
   - Join with `.genie/tasks.jsonl` (and `v7_task_events` / `genie-forge` `pushed_after_open` repair counts) by `task_id` first, then `branch` (`to_open_s`, `to_merge_s`, `launch_to_open_s`, `launch_to_merge_s`), then `(bot, role)` actor mapping (`captain`, `dev-lead`, `worker`, `reviewer`).
   - Compute **per-task rows** (`task_id`, `branch`, `lane`, `role_breakdown`, `tokens`, `usd`, `cost_state`, `to_open_s`, `to_merge_s`, `launch_to_open_s`, `launch_to_merge_s`, `repair_rounds`, `tool_errors`, `api_errors`, `run_failed`) and **per-role summary rows** (`role`, `models_used`, `task_count`, `p50_launch_to_open_s`, `p90_launch_to_open_s`, `mean_repair_rounds`, `failure_rate_by_class`, `tokens_per_merged_task`, `usd_per_merged_task`, `orchestration_share_pct` vs `worker_share_pct`). Unknown/unsupported fields stay `null` and render as `"–"`, never `0`.
2. **Deterministic advisory proposal generator (`Proposals` in `learn.rs`):**
   - Evaluate deterministic, threshold-gated rules (requiring sample size `n >= 3` tasks and `bot_coverage >= 0.70`, otherwise emitting a `low_coverage_warning` instead of noisy advice):
     - **Model-per-role proposal:** flags `(role, model)` pairs whose `usd_per_merged_task` exceeds the role median by `>= 1.5x` without lower `mean_repair_rounds` or lower `p50_launch_to_open_s`, or whose failure/repair rate exceeds a peer model on the same role.
     - **Repair-budget proposal:** flags roles or task categories where `pushed_after_open` repair rounds average `>= 2.0` or consume `> 30%` of role tokens, citing the specific tasks/PRs.
     - **Brief-size / group-split proposal:** correlates initial prompt size (from first turn input/cache-creation tokens or task group file count) with `tool_error` / `run_failed` spikes and repair rounds, recommending group split thresholds when oversized briefs show `>= 2x` repair or failure rates.
   - Every proposal includes `id`, `category` (`"model_per_role" | "repair_budget" | "brief_size"`), `confidence` (`"high" | "medium" | "low"`), `evidence` (task IDs, bot IDs, exact metric comparisons, `n`, and `bot_coverage`), and `advisory_action` (human-readable recommendation; never auto-applied).
3. **`genie-rs learn` verb & `genie metrics learn` thin front door (`crates/genie-rs/src/lib.rs`, `src/term-commands/metrics.ts`):**
   - Support `genie-rs learn [--project <p>] [--window d1|d7|d30] [--json] [--write-latest]`.
   - When `--write-latest` is passed (designed for the daemon-free `REQUEST-2` / `REQUEST-4` timer hook), atomically write the JSON report to `<project>/.genie/metrics/learn-latest.json` via temp-file + rename and exit `0`.
   - Forward `genie metrics learn` in `src/term-commands/metrics.ts` directly to `genie-rs learn`.
4. **Rust & CLI tests (`crates/genie-tasks/tests/learn.rs`, `crates/genie-rs/tests/exit_codes.rs`):** End-to-end fixture tests covering high-coverage advisory generation, low-coverage suppression, `"unsupported"` / `"partial"` failure states (`codex` `api_error: null`), two-clock PR metrics, and `--write-latest` atomic snapshot output.

**Interfaces:**
- Consumes:
  - `genie_tasks::meter` from Group 1.
  - `usagemeter query --json`, `usagemeter outcomes --json`, `usagemeter coverage --json`, and `.genie/tasks.jsonl`.
- Produces:
  - `genie-rs learn [--project <p>] [--window d1|d7|d30] [--json] [--write-latest]` (`schema_version: 1`, `capability: "genie.learn@1"`).
  - `genie metrics learn` CLI subcommand.
  - Optional `<project>/.genie/metrics/learn-latest.json` snapshot for zero-daemon 24/7 consumers.

**Acceptance Criteria:**
- [ ] `genie-rs learn --window d7 --json` joins `usagemeter` `query`, `outcomes`, and `coverage` with `.genie/tasks.jsonl` and outputs `summary`, `by_task`, `by_role`, `orchestration_vs_worker`, `coverage`, and ranked `proposals`.
- [ ] `unsupported` or `null` outcome metrics (such as `api_error` on `codex` or missing `launch_to_open_s` on untagged PRs) remain `null` in JSON and `"–"` in text output, never `0`.
- [ ] Proposals cite concrete task IDs, bot IDs, sample size `n`, and `bot_coverage`, and are suppressed with an explicit coverage notice when `n < 3` or `bot_coverage < 0.70`.
- [ ] Running `genie-rs learn` without `--write-latest` performs zero filesystem writes; running with `--write-latest` writes only `.genie/metrics/learn-latest.json` and never modifies any tracked file, skill, or bot config.

**Validation:**
```bash
cargo fmt --check && cargo clippy --workspace --all-targets --locked -- -D warnings && cargo test --workspace --locked && bun run check
```

**depends-on:** 1, 2

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] **Functional — Board cost & fallback (Group 1):** `genie-rs list --json --project .` returns `usd`, `tokens`, `work_min`, `cost_state`, and `attribution_basis` populated from `usagemeter query`, and `plugins/genie-herdr` renders `"–"` for missing/unpriced tasks and `branch est.` for branch-fallback tasks.
- [ ] **Functional — CLI cutover & parity (Group 2):** `genie metrics export --json` and `genie wish report <slug> --json` return usage/cost from `usagemeter query` and match frozen parity fixtures in `src/lib/metrics-parity.test.ts`.
- [ ] **Functional — One-release deprecation stubs (Group 3):** `genie metrics export --phoenix`, `genie metrics prices update`, `bun scripts/observability/backfill.ts`, `bun scripts/observability/annotate.ts`, `bun scripts/mikro/phoenix.ts`, and `node .claude/workflows/observability-review.js` each exit `2` with the migration notice on `stderr`.
- [ ] **Functional — Learning loop & advisory proposals (Group 4):** `genie metrics learn --window d7` and `genie-rs learn --window d7 --json` output per-task and per-role tables, two-clock PR timing, failure breakdowns, orchestration vs worker share, and ranked, evidence-cited advisory proposals without touching any tracked file.
- [ ] **Regression — Full repository gate:** `bun run check` and `cargo test --workspace --locked` exit `0` with zero warnings or dead-code findings.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| `~/.local/bin/usagemeter` is not installed on a contributor machine or CI runner | Medium | `genie_tasks::meter` treats a missing binary (`ENOENT` or exit `10..15`) as `cost_state: "missing"` (`"–"` on the board, structured warning in CLI); unit and integration tests inject a deterministic mock `usagemeter` script via `USAGEMETER_BIN` so CI never skips or depends on ambient machine state. |
| Pre-`REQUEST-1` `usagemeter outcomes --json` keys failure counts by `(provider, bot, role)` and PR timing by `(repo, branch)` rather than `task_id` | Medium | Group 4 joins PR timing to tasks via `branch` (exact 1:1 per task worktree branch) and joins failure rates by `(bot, role)` and task active window; once `REQUEST-1` adds `task_id` to `outcomes`, `learn.rs` prefers direct `task_id` matching automatically. |
| Work is split between the owner's laptop and the build box before `REQUEST-3` (multi-machine fleet roll-up) lands | Medium | Group 4 scopes `learn` to the local `usagemeter` store first and stamps `machine_scope: "local"` in the header; `REQUEST-3` and Sibling Wish 2 (`genie-fleet-learning-digest`) add multi-machine fleet ingestion without moving raw transcripts. |
| Historical windows with low `bot_coverage` (< 70% tagged turns) could skew per-role cost or model comparisons | Medium | `learn.rs` reads `usagemeter coverage --json` first, prints `bot_coverage` and unattributed breakdown (`untagged_human`, `subagent`, `untagged_other`) at the top of every report, and suppresses role-level proposals when `bot_coverage < 0.70` or `n < 3`. |

---

## Review Results

_The read-only reviewer returns evidence; the invoking orchestrator appends a timestamped block here after plan, execution, and PR reviews._

PENDING — plan-only DRAFT wish awaiting owner decisions D1–D4 and independent review before execution.

---

## Files to Create/Modify

```
# Plan deliverable in this PR (gn-2, docs-only):
.genie/wishes/genie-meter-intelligence/WISH.md

# Planned implementation files per execution group (after owner approval of D1–D4):

# Group 1 (~7 files, ~650 insertions):
crates/genie-tasks/src/meter.rs
crates/genie-tasks/src/store.rs
crates/genie-rs/src/lib.rs
crates/genie-rs/tests/exit_codes.rs
plugins/genie-herdr/data.js
plugins/genie-herdr/main.js
plugins/genie-herdr/data.test.ts

# Group 2 (~8 files, ~700 insertions):
src/lib/__fixtures__/meter-parity/sessions.jsonl
src/lib/__fixtures__/meter-parity/usagemeter-query.json
src/lib/metrics-parity.test.ts
src/lib/metrics-export.ts
src/lib/metrics-export.test.ts
src/term-commands/metrics.ts
src/term-commands/wish.ts
src/term-commands/wish-report.test.ts

# Group 3 (~10 files, ~450 insertions / ~1,900 deletions):
src/term-commands/metrics.ts
src/lib/metrics-usage.ts
src/lib/metrics-phoenix.ts
src/lib/metrics-prices.ts
src/lib/metrics-deprecation.test.ts
scripts/observability/backfill.ts
scripts/observability/annotate.ts
scripts/mikro/phoenix.ts
.claude/workflows/observability-review.js
package.json

# Group 4 (~8 files, ~750 insertions):
crates/genie-tasks/src/lib.rs
crates/genie-tasks/src/learn.rs
crates/genie-tasks/tests/learn.rs
crates/genie-rs/src/lib.rs
crates/genie-rs/tests/exit_codes.rs
src/term-commands/metrics.ts
src/term-commands/metrics-learn.test.ts
.gitignore
```
