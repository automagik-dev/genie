# Wish: Genie v7 board — the real Herdr Tasks board, read-only

| Field | Value |
|-------|-------|
| **Status** | APPROVED |
| **Slug** | `genie-v7-board` |
| **Date** | 2026-11-04 |
| **Author** | Genie Orchestrator t2ww |
| **Appetite** | medium |
| **Branch** | `wish/genie-v7-board-<group>` — each group (1, 2, 3) gets its own branch and its own PR |
| **Repos touched** | `automagik-dev/genie` |
| **Design** | [DESIGN.md](../../brainstorms/genie-v7-board/DESIGN.md) |

## Summary

The owner-approved Tasks mock (`~/.config/herdr-app/mods/tasks-mock`, branch `tasks-plain-time-cost`) draws a static `board.json`, while the real tasks now live in each repository's `genie.db` (genie-v7-tasks: #3201, #3205, #3206, #3209) and nothing in Herdr shows them; the footer's `genie.tasks.waiting` badge has no live source (R1-16). This wish ships the real board, read-only: `genie-rs list --json` gains its timestamps, worktree and project and opens `genie.db` without writing, forge-sync's first pass is bounded to 30 days and resumable (group 1); the plain-JS mod `plugins/genie-herdr` reads `list`, runs forge-sync on a budget and reads cost and time from usagemeter's `herdr-meter` doc (group 2); `genie install` / `genie update` copy the mod into Herdr's mods folder, backup-first and recorded (group 3). The design was reviewed SHIP in round 4 (digest `ddb667d4…`); this plan copies its groups, interfaces, criteria and constraints unweakened and folds in the round-4 findings carried to the wish (M4, M5 and the six LOWs).

## Scope

### IN

- **Group 1 — Genie (Rust):** `genie-rs list --json` and `status --json` gain `created_at`, `opened_at`, `merged_at`, `closed_at`, `worktree` and `project` (design IN row 1); `list` and `status` run no write statement (row 1); forge-sync's cursorless first pass stops at a 30-day horizon, commits per page, resumes, and gains a hand-run `--full` (row 1b); `--full` saves its cursor only at completion (r4 M4); the `--full` help text names its cost (r4 LOW6).
- **Group 2 — the mod `plugins/genie-herdr`:** the mod and its footer entry, project discovery, finding `genie-rs`, the refresh with the forge-sync budget, lanes and the read-only card, the drawer, cost/time/ETA from usagemeter, the `genie.tasks.waiting` badge, graceful degradation, packaging and tests (design IN rows 2–11); the never-synced probe is one script in `data.js` that the tests run (r4 M5); a focused never-synced project takes the one never-synced slot (r4 LOW5); an `origin`-mismatched cursor is accepted as synced (r4 LOW4).
- **Group 3 — the Herdr mod channel:** `genie install` and `genie update` copy `<GENIE_HOME>/plugins/genie-herdr` to `~/.config/herdr-app/mods/genie-herdr`, with a sha256 record and backup-first replacement, under the workflows channel's consent gate (design IN row 12).

### OUT

- **Actions** (merge, start, kill): they wait for lockdown (Source: R1-7, B1-1).
- **The DSH hand-off to Herdr:** a separate wish (Source: R1-31).
- **Pocket** (Source: B1-1, the brief's boundary).
- **A To-do lane from open forge issues:** deferred by genie-v7-tasks; `list` has none. Trigger: the owner asks after v1 (Source: R1-1).
- **The mock's pets, filters and `.herdr/bots.json` looks:** not in B1-1's card. Trigger: owner feedback on v1 (A16).
- **Spaces on other machines.** Trigger: a project on a linked machine (Source: B1-4; A2).
- **Mod removal on `genie uninstall`, and a `genie doctor` check:** B1-5 names install and update only (A19).
- **Genie computing cost or lead time:** usagemeter does it (Source: B1-3, R1-19).
- **A resident poller or daemon:** zero-daemon; the open tab owns the cadence.
- **A resident badge refresher** and **a `--since` or lane filter on `list`:** deferred until measured (Simplicity Case).

## Decisions

Decisions 1–15 are the design's, copied; 16–23 are this plan's, each tied to the r4 finding or structure it answers; 24 is the orchestrator's call on execution review g1 HIGH-1.

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | v1 is read-only: lanes, cost and time per card, the drawer, the terminal icon and the badge | Actions wait for lockdown. Read-only means no owner action. `list` writes nothing; the board's forge-sync turn records only what the forge already did, creating the `v7_` tables and appending to `tasks.jsonl` (B1-1, R1-7) |
| 2 | Tasks come only from spawning `genie-rs list --json --project <p>` | Rust is the only code that knows the database layout (B1-2) |
| 3 | Cost and time come only from usagemeter's `herdr-meter` doc; null shows "–", never 0 | "We are one": one cost authority, already deduped (B1-3, R1-19, R1-32) |
| 4 | A project is any local Herdr space folder holding `.genie/genie.db` | No setup (B1-4) |
| 5 | While its tab is open, the board runs `list` for every project each minute, and forge-sync at most 10 a minute (focused first, round-robin, one never-synced per minute until a pass completes, backoff to 1 h on any failure, no overlapping ticks); first passes look back 30 days and resume per page | `tasks.jsonl` stays live with no daemon, and API calls stay bounded. The H2/H3 parts are orchestrator calls (owner may override) (B1-6, DRAFT H2, H3) |
| 6 | `list --json` gains `created_at`, `opened_at`, `merged_at`, `closed_at`, `worktree` and `project`, additively | One spawn per project instead of one per task; the usagemeter join uses Genie's own realpath. `created_at` is the latest `created` row; `list`/`status` open read-only (orchestrator call O4, owner may override; R1-32; review r1) |
| 7 | A card click only toggles the drawer; only the terminal icon opens a worker | The owner-approved mock's behaviour (R1-18) |
| 8 | The badge = Review cards + Working cards with a blocked worker, counted once, null at 0 | The footer contract (R1-16) |
| 9 | The mod lives at `plugins/genie-herdr` and ships inside the existing `plugins` payload member | The 8 top-level members are frozen; `cp -R plugins` already stages it (R1-12, `src/lib/install-promotion.ts`, `scripts/build-binary.sh`) |
| 10 | `genie install` and `genie update` copy the mod to `~/.config/herdr-app/mods/genie-herdr` with a record of genie's files, backup-first, leaving Herdr's generated files alone | The mod always matches the `genie-rs` it ships beside; same channel shape and consent gate as workflows (selection not `'none'`, an install record exists): orchestrator call N1 (owner may override) (B1-5) |
| 11 | `genie-rs` is resolved from `GENIE_RS_BIN`, then the payload's `plugins/genie-rs/bin/genie-rs` | Same order as the TS front door (`src/term-commands/v5-task.ts`) |
| 12 | ETA = the conditional median of past `lead_min` values above the elapsed time, minus it | Orchestrator call O2 (owner may override); derived from usagemeter's numbers, so B1-3 holds (R1-13) |
| 13 | A merged card shows `lead_min`, which stays null until merge. A Working card shows now − `started_at`, live. usagemeter adds `started_at` and `state` to each task | Orchestrator call O3 (owner may override), on usagemeter's answer: `lead_min` is the finished lead time (R1-6) |
| 14 | Blocked workers and the icon's terminal join by the terminal labels `task`, `task.project` and `task.lead` first, with `workers.jsonl` only as the fallback | Orchestrator call O5 (owner may override); labels are exact and live in `terminals()`; both sides realpath-normalized (R1-17) |
| 15 | `doc get` succeeds only on exit 0 with one line of JSON; any non-zero exit (3 no such doc, 1 another failure, 2 usage), a launch failure, unparseable output or a missing pinned path shows "–" | The Herdr contract, automagik#283 (merged, pack 3.69.5) (B1-3) |
| 16 | One branch and one PR per group, `wish/genie-v7-board-<group>`; group 1 first, then groups 2 and 3 in parallel | Same shape as genie-v7-tasks. Groups 2 and 3 own disjoint files (`plugins/genie-herdr/**` + `scripts/` against `src/**`), so they need no shared worktree |
| 17 | `--full` saves its cursor only when the pass completes, never per page; a killed `--full` leaves the previous cursor file byte-identical | r4 M4: a per-page save would write `"since":null` over a completed cursor, and the board would reclassify the project as never-synced and start a parallel 30-day first pass. Saving only at completion removes that window |
| 18 | The forge reply cache (`sync.rs:250`, `sync.rs:311`) keeps today's cadence in every mode: written only when a pass completes | r4 M4 names the cache's cadence as unstated. A cut pass leaves no fresh reply cache, so its rerun re-lists from the newest page as row 1b requires |
| 19 | The never-synced probe is one exported shell script string in `data.js` (`PROBE_SCRIPT`), run by `main.js` as `exec('sh', ['-c', PROBE_SCRIPT, 'sh', ...folders])`; its output, one line per folder, is parsed by the pure `parseProbe` | r4 M5: `data.test.ts` can then run the very script `main.js` runs against temp cursor fixtures, so T7's "cut first pass" proof reaches the grep. `data.js` stays free of `herdr`/`gpui-kit` imports |
| 20 | A cursor whose `origin` no longer matches greps as synced; accepted | r4 LOW4: sync discards it (`sync.rs:248`) and runs one 30-day first pass in an ordinary rotation slot after a remote re-point. Grepping `origin` too would cost a `git remote get-url` per project per tick for a rare, bounded event (one first pass per re-point); same class as Risk 7 |
| 21 | A focused project that is itself never-synced takes the tick's one never-synced slot | r4 LOW5: the bound "at most one never-synced project per tick" (row 5) then holds with no exception, and the focused project still goes first |
| 22 | The install record is one optional field `herdrMod: {dir, ref, files: <relative path> → sha256}` on `skills-install.json` (A17), CARRIED FORWARD VERBATIM by the skills channel exactly as `workflows` is (`src/lib/skills-installer.ts:2629`) | The skills channel rewrites that file on every run; a field it does not carry forward is dropped on the next update and orphans every installed mod file. This adds `src/lib/skills-installer.ts` to group 3's files (not in the design's row 12 list) |
| 23 | `--full` is parsed in `crates/genie-rs/src/lib.rs` (`parse` rejects unknown options at `lib.rs:100`) and reaches `genie_forge::SyncOptions` as `full: bool` | r4 LOW2: row 1b's file list omitted `lib.rs`; the TS front door forwards the flag untouched (`v5-task.ts`), so no TS edit |
| 24 | A completed pass writes `since` = max(the newest `updated_at` it listed, the previous `since`, the pass's floor), or the horizon when none of those exist; `since` never moves backward | Execution review g1 HIGH-1 (orchestrator call): "the newest `updated_at` it listed" was written to fix the listed-vs-processed bug (r4 LOW1), never to move `since` back. A `since` older than the horizon would drop a later default pass's floor below it, and that pass would record PRs older than 30 days |

## Simplicity Case

- **Simplest complete design:** one plain-JS mod (per minute: a `list` per project, at most 10 forge-syncs, one `doc get`; state: the last good replies, the round-robin pointer, the backoff map and one in-flight boolean; writes: the badge and its forge-sync turns) and one installer on an existing channel shape.
- **Added machinery:**
  - **The `genie-rs list` fields:** they remove per-task spawns and give the exact usagemeter key (DRAFT dependency "Genie (ours)", O4).
  - **Running forge-sync from the board, on a budget, with backoff and a bounded first pass:** usagemeter needs a live `tasks.jsonl`, zero-daemon leaves nobody else to run it, and the gh quota is shared (B1-6, H2).
  - **The `workers.jsonl` fallback:** for unlabelled workers (DRAFT scout facts).
  - **The install record and backups:** the mod folder sits in another app's home, which a person may edit (B1-5).
  - **`PROBE_SCRIPT` as a `data.js` export (Decision 19):** no new mechanism — the same `sh -c` loop the design already runs, moved where its test can execute it.
- **Deferred until measured:**
  - **A resident badge refresher.** Trigger: the owner sees a stale badge while the Tasks tab is closed.
  - **A `--since` or lane filter on `list`.** Trigger: a project's output nears `exec`'s 8 MiB cap.
  - **An `origin` check in the never-synced probe (Decision 20).** Trigger: a measured quota spike after a remote re-point.
- **Complexity removed:** no To-do lane, no actions, no pictures on disk, no project config, no second database reader and no cost arithmetic in Genie; no per-page cursor save under `--full` (Decision 17).

## Dependencies

**depends-on:** none
**blocks:** none

genie-v7-tasks (SHIPPED 2026-11-03) is the prerequisite and is met. External, none of them blocking a merge:

- **usagemeter#8 (t2wv, confirmed 2026-11-03; amended 2026-11-04):** the pinned `space.projects[<project path>].tasks[]` (absent from the live 0.3.0 doc), with `started_at` and `state`. Until it ships every number on the board is "–" by rule. **Needs from Genie:** a written `tasks.jsonl` (the board's forge-sync, group 2) and workers started with `--task` (R1-5).
- **Herdr `automagik-herdr doc get`:** met (automagik#283, pack 3.69.5, installed); contract in Decision 15.
- **A dev release with `genie-rs` (1c, #3206):** payload-only, so `genie update --dev` once it ships, and again after this wish (which installs the mod).
- **Herdr v0.5.0** (footer, R1-16) and **v0.6.0** (worker labels, R1-17).

## Success Criteria

The design's criteria T1–T10, each owned by one group and copied in full into that group's Acceptance Criteria with the r4 fold-ins added:

- [ ] **T1 list fields, T1b read-only, T1c first pass** — group 1 (`crates/genie-rs/tests/exit_codes.rs`, `crates/genie-forge/tests/sync.rs`), plus the M4 `--full` cursor criterion and the LOW1/LOW3/LOW6 clauses.
- [ ] **T2 discovery, T3 lanes and card, T4 cost/time/ETA, T5 badge, T6 degradation, T7 forge budget, T9 payload** — group 2 (`plugins/genie-herdr/data.test.ts`, `scripts/release-docs.test.ts`), plus the M5 probe criterion and the LOW4/LOW5 clauses.
- [ ] **T8 the mod loads** — group 2, local only (needs the desktop app): `herdr-app check plugins/genie-herdr` exits 0.
- [ ] **T10 mod channel** — group 3 (`src/lib/herdr-mod-installer.test.ts`), plus the Decision 22 carry-forward criterion.
- [ ] `bun run check` exits 0 on every group's branch, on the linux and `unit-darwin` CI legs.

## Execution Strategy

### Wave 1 (sequential)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 1 | engineer | Medium — three crates (`genie-rs`, `genie-tasks`, `genie-forge`); the read-only open must keep the main file byte-identical, and the per-page cursor must never make a cut pass look synced; the fake forge exists and gains paging (review r1 HIGH-1). Size: 7 files (the design's 6 plus `crates/genie-forge/tests/fixtures/fake-forge`), about 400–700 inserted lines with tests (design estimate) | inherit | The six list fields, the read-only `list`/`status`, forge-sync's 30-day horizon, per-page commit, resume and `--full` (design IN rows 1, 1b; T1, T1b, T1c; r4 M4, LOW1, LOW2, LOW3, LOW6) |

### Wave 2 (parallel, after group 1)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 2 | engineer | Medium-high — the scheduling seam (`planTick`, `skipWhileBusy`) over 128 simulated projects, the badge's two-path join, Herdr mod APIs that only the desktop app can check (T8 is local). Size: 10 files, about 1,200–1,800 inserted lines (design estimate), itemized (review r1 LOW-7): view `main.js` 500–650 (the mock's is 613), rules `data.js` 250–350 (the mock's is 152), `data.test.ts` 450–750, manifest + three SVGs + `.gitignore` about 30, the build entry and its pin about 10. The test is the uncertain line: the reviewer estimates 500–900, which puts the top near the 2,000-line ceiling (Assumptions / Risks) | inherit | The mod `plugins/genie-herdr` and its packaging (design IN rows 2–11; T2–T9; r4 M5, LOW4, LOW5) |
| 3 | engineer | Medium — the workflows channel's shape applied to one directory in another app's home; the record field must survive the skills channel's rewrite; hooks on the release-pipeline path (`update.ts`). Size: 6 files, about 700–1,000 inserted lines (estimated from the analog `workflows-installer.ts` + test, 934 lines) | inherit | The Herdr mod install/update channel (design IN row 12; T10; Decision 22) |

Group 1 runs first, on its own branch and PR. Groups 2 and 3 each start from `dev` after group 1 merges, on their own branches and PRs, and own disjoint files. The owner-facing end-to-end check (QA) needs all three merged and a dev release.

**Global constraints:**
- Exit codes: 0 ok, 1 failed (external input included), 2 a refusal that changed nothing (Decision 4). Errors go to stderr; `--json` output goes to stdout. (genie-v7-tasks)
- Rust writes only its own tables, all prefixed `v7_`; `PRAGMA user_version` and every TS table stay untouched; Rust never creates `genie.db`. (genie-v7-tasks)
- No OpenSSL and no network crate: forge access goes through `gh`/`glab`. SQLite comes from `rusqlite` with the `bundled` feature. No clap. (genie-v7-tasks)
- No network call or git command ever runs inside a write lock. (genie-v7-tasks)
- Zero-daemon: every verb is a short process; callers own the cadence. The open Tasks tab owns the board's cadence; no resident poller or daemon. (genie-v7-tasks; design OUT)
- The 8 `INSTALL_PAYLOAD_MEMBERS` stay frozen; the binary ships at `plugins/genie-rs/bin/genie-rs`, mode 0755; the mod ships inside the `plugins` member at `plugins/genie-herdr` (Decision 9).
- The repository gate `bun run check` stays required and green in every group; it runs `cargo test --locked` and fails, never skips, without `cargo`. CI runs on the linux and `unit-darwin` legs. (genie-v7-tasks; CLAUDE.md)
- No test skips for a missing tool: a test that cannot run is a failing gate. T8 is the one criterion outside CI, because it needs the desktop app. (genie-v7-tasks; design T8)
- Tasks come only from spawning `genie-rs list --json --project <p>`; the board never opens `genie.db` (B1-2).
- Cost and time come only from usagemeter's `herdr-meter` doc; null shows "–", never 0; the board derives only live elapsed time and the ETA (B1-3).
- v1 is read-only: no action buttons (B1-1).
- Plain JS (A13): pure rules in `data.js` (no `herdr` or `gpui-kit` import), the view in `main.js`; no build step.
- Stable is Linux and macOS; Windows is not a target. (CLAUDE.md)
- Biome: single quotes, 2-space indent, 120 line width, trailing commas; no `console.log` in source. Biome lints `plugins/**`. (CLAUDE.md; design row 11)

## Execution Groups

### Group 1: the Genie list fields, the read-only list, and forge-sync's first-pass horizon and `--full`

**Goal:** Give `genie-rs list --json` everything the board needs in one spawn per project without writing to `genie.db`, and make forge-sync's first pass bounded, resumable and completable by hand.

**Deliverables:**
1. **`genie-rs list --json` gains six fields per task** (design IN row 1). `created_at` and `worktree` come from the LATEST `created` row (a restart is a new lifecycle; usagemeter's `started_at` uses the same row); `opened_at`, `merged_at`, `closed_at` from the first row of each kind; `project` is the realpath `project_root` already computes. Null when absent or `''`, so a forge-first task has `created_at: null`. Additive only: text output unchanged, and `status --json` gains the same fields through `task_json`. One aggregate in `store.tasks()`, no schema change (A1).
2. **Read-only in effect** (design IN row 1): `list` and `status` open with normal read-write flags but run no write statement (no `SCHEMA_SQL`, no `journal_mode = WAL` or `synchronous`), so the main file stays byte-identical and a WAL file without sidecars still reads (`SQLITE_OPEN_READONLY` would refuse it). `tasks()` tolerates `no such table` as `read_events` does, so a v5-only database lists `[]`, exit 0. Refusals stay exit 2: a missing file, `user_version = 0`, and `NewerSchema` (a newer `v7_schema` version), refused before any read.
3. **forge-sync's first pass is bounded and resumable** (design IN row 1b). Today a cursorless pass pages the whole history, a call per merged PR, saving only at the end.
   - **Horizon:** a cursorless pass stops at now − 30 days (the feed's `d30`); older PRs are never recorded.
   - **Per page:** each page's events commit, then the cursor's `seen` map saves; a per-page save leaves `since` unchanged (null on a first pass, N on an incremental one) until the pass completes. A cut pass re-lists from the newest page (one call per 100 PRs) and skips seen PRs, so no count call repeats.
   - **Completion:** a completed pass writes `since` = max(the newest `updated_at` it listed (page 1's top), the previous `since`, the pass's floor), or the horizon when none of those exist, so `since` never moves backward and `since: null` means exactly "no completed pass" (H3; Decision 24). Today `advance` (`sync.rs:98–107`) takes `newest` from `processed` (`sync.rs:102`), which after a resume excludes page 1's seen PRs; the completion value must come from what was LISTED, not what was processed (r4 LOW1).
   - **Order:** `tasks.jsonl` appends per page, newest first, not oldest-first; R1-19 readers dedupe on `dedupe_key`.
   - **Accepted edge:** a locally `created` task whose PR merged before the horizon stays Working on a never-synced project. Remedy: `genie task forge-sync --project <p> --full`.
4. **`--full`** (hand-run only; A21): lists the whole history once, ignoring horizon and `since`. Parsed in `crates/genie-rs/src/lib.rs` (`parse` rejects unknown options, `lib.rs:100`) into `SyncOptions { full: bool, .. }` (r4 LOW2, Decision 23). **Cursor cadence (r4 M4, Decision 17):** `--full` saves its cursor only when the pass completes, through `advance`, never per page, so it never writes `"since":null` over a completed cursor and a killed `--full` leaves the previous cursor byte-identical. **Help text (r4 LOW6, review r1 LOW-1):** the text lives in `USAGE` (`crates/genie-rs/src/lib.rs:20–22`): the `forge-sync` line gains `[--full]` and states that `--full` makes one count call per merged PR in the whole history — thousands on a large repository — against the shared gh quota. The exit shape stays today's: `genie-rs help` / `--help` / `-h` (the verb, `lib.rs:302`) prints `USAGE` on stdout and exits 0; `genie-rs forge-sync --help` still reaches `parse` and exits 2 with `unknown option '--help'` and `USAGE` on stderr. Exit codes and `--json` are otherwise unchanged.
5. **The reply cache** (`sync.rs:250`, `sync.rs:311`) keeps today's cadence in every mode: written only when a pass completes (Decision 18, r4 M4).
6. **The fake forge gains paging (review r1 HIGH-1).** `crates/genie-forge/tests/fixtures/fake-forge` today routes every list endpoint to one `list.json` (`*) file=$dir/list.json`), ignoring `page=N`, and its `!fail` marker is per file, so it cannot serve two pages or fail on page 2. It gains page-aware list replies: a list endpoint carrying `page=N` serves `list-<N>.json`, falling back to `list.json` when that file is absent, so every existing test is unchanged. `!fail` stays the first-line marker of a reply file, so a `list-2.json` beginning with `!fail` fails page 2 only. `calls.log` already records the full endpoint, one line per call, so `page=N` is assertable for the horizon. The fake matches `*[?&]page=*` (never bare `page=`, which `per_page=` precedes); a page file that should be followed by another holds exactly 100 rows (`client.rs:14`), and the paged fixture helper beside `serve_values` writes `list-<N>.json`. `crates/genie-rs/tests/exit_codes.rs:52` copies the same fixture, so both test crates pick the change up.
7. Tests in `crates/genie-rs/tests/exit_codes.rs` (T1, T1b) and `crates/genie-forge/tests/sync.rs` (T1c and the `--full` cases), on the paged fake.

**Interfaces:**
- Consumes: none from this wish. From the repository (`origin/dev`): `genie_tasks::open_store` / `Store::tasks()` / `read_events` (`crates/genie-tasks/src/store.rs`), `task_json` and `parse` (`crates/genie-rs/src/lib.rs`), `genie_forge::sync(&SyncOptions)`, `Cursor { origin, since: Option<i64>, seen }` and `advance` (`crates/genie-forge/src/sync.rs`), `Cli::list(since)` (`crates/genie-forge/src/client.rs:154–183`).
- Produces (group 2 consumes these exactly):
  - `genie-rs list --json --project <p>`: a JSON array; each element keeps every existing key (`task` string or null, `task_key`, `state`, `lane` ∈ `Working | Review | Merged | Closed`, `title`, `lead`, `forge`, `url`, `branch`, `updated_at`) and adds `created_at`, `opened_at`, `merged_at`, `closed_at` (the event row's `at`, the same string `status --json` prints in `events[].at`, or null), `worktree` (string or null) and `project` (the realpath of the main checkout, `store.project()`). Text output unchanged.
  - `genie-rs status <id> --json`: the same six fields, through `task_json`.
  - Exit codes for `list` and `status`: 0 (a v5-only database lists `[]`); 2 for a missing file, `user_version = 0`, or `NewerSchema`, refused before any read and leaving the file unchanged.
  - `genie-rs forge-sync --project <p> [--full] [--json]`: exit codes and `--json` report unchanged. Cursor file `<GENIE_HOME>/cache/forge/<sha256(project)>.cursor.json`, lowercase hex of `Sha256::digest(project.as_bytes())` over `store.project()`, written as compact JSON (`serde_json::to_vec`) through tmp + rename. `"since":null` means exactly "no completed pass"; a number means at least one pass completed. The board's never-synced probe greps `"since":[0-9]` on that file.
  - `genie_forge::SyncOptions { project, genie_home, path, now, full: bool }`.
  - `<GENIE_HOME>/tasks.jsonl` appended per page, newest first.

**Acceptance Criteria:**
- [x] **T1 list fields:** a task that went created → opened → merged lists `opened_at` and `merged_at` from its events, `closed_at: null`, and `project` equal to the realpath of the main checkout. A task restarted with a second `created` row lists that row's `at` as `created_at` and its worktree. A forge-first task lists `created_at: null` and `worktree: null`. Old keys and the text output are unchanged. **Proof:** `crates/genie-rs/tests/exit_codes.rs`.
- [x] **T1b read-only:** on a v5-only `genie.db`, `list --json` prints `[]`, exits 0, and leaves the main file byte-identical (sha256 before and after) with no `v7_` table created; a WAL database copied without its sidecars still lists; `status` likewise creates nothing; a database whose `v7_schema` is newer exits 2 and is unchanged. **WAL caveat (r4 LOW3):** "byte-identical" holds only with an empty WAL, because closing the last read-write connection checkpoints pending frames into the main file; the fixture closes its writer (checkpointing the WAL) before taking the "before" sha256. **Proof:** `crates/genie-rs/tests/exit_codes.rs`.
- [x] **T1c first pass:** a fake `gh` serves PRs updated over 90 days.
  - **Horizon:** a cursorless pass requests no page past the 30-day horizon (the fake's call log) and records no PR older than 30 days. The fixture serves `list-1.json`, `list-2.json`, `list-3.json` spanning the 90 days, and `calls.log` shows no `page=N` request beyond the page holding the horizon (review r1 HIGH-1).
  - **Resume:** when the fake fails on page 2, page 1's events and `seen` map persist, and the cursor's `since` stays null. The rerun finishes with no repeated `pushed_after_open` call. The failure is `!fail` in `list-2.json` only; the test asserts `calls.log` holds a `page=1` and a `page=2` line (page 2 is only requested after a full page 1, `client.rs:177–180`) and that page 1's rows are in `v7_task_events` and its PRs in `seen`, so the criterion cannot pass with page 1 never run (review r1 HIGH-1).
  - **Incremental cut (review r1 LOW-5):** over a cursor whose `since` is a number N, an incremental pass that pages and is cut on page 2 leaves `since` = N (never null) and adds page 1's new `seen` entries, so the project stays in the synced lane.
  - **Completion:** `since` then equals page 1's newest `updated_at` — including after that resume, when page 1's PRs are all seen and absent from `processed` (r4 LOW1, `sync.rs:102`). A first pass that lists nothing writes the horizon. `--full` records a merge older than the horizon.
  - **Proof:** `crates/genie-forge/tests/sync.rs`.
- [x] **`--full` cursor (r4 M4):** over a completed cursor, a `--full` run whose fake fails on page 2 leaves the cursor file byte-identical (its `since` still a number); a `--full` run that completes writes `since` = max(the newest `updated_at` it listed, the previous `since`), never older (Decision 24). The page-2 failure is `!fail` in `list-2.json` with page 1 served, and `calls.log` holds a `page=1` and a `page=2` line (page 2 is only requested after a full page 1, `client.rs:177–180`), so the byte-identical cursor is proven against a run that did list a page (review r1 HIGH-1). **Proof:** `crates/genie-forge/tests/sync.rs`.
- [x] **Cursor file name (review r1 MEDIUM-2):** for the fixture repository, the cursor file forge-sync writes is named exactly `<lowercase hex sha256(store.project())>.cursor.json` under `<GENIE_HOME>/cache/forge/`, the digest computed in the test independently of `sync.rs` (today `tests/sync.rs:379`, `:566` assert only the `.cursor.json` suffix). This is the name group 2's probe recomputes. **Proof:** `crates/genie-forge/tests/sync.rs`.
- [x] **`--full` help (r4 LOW6, review r1 LOW-1):** `genie-rs help` exits 0 with `USAGE` on stdout naming `--full` and its one-count-call-per-merged-PR cost; `genie-rs forge-sync --help` still exits 2 with `USAGE` (the same line) on stderr; an unknown option still exits 2. **Proof:** `crates/genie-rs/tests/exit_codes.rs`.
- [x] Every existing genie-v7-tasks test (T1–T10 of that wish) still passes unchanged.

**Validation:**
```bash
cargo fmt --check && cargo clippy --workspace --all-targets --locked -- -D warnings && cargo test --workspace --locked && bun run check
```

**depends-on:** none

---

### Group 2: the mod `plugins/genie-herdr`

**Goal:** Ship the read-only Tasks board as a plain-JS Herdr mod inside the `plugins` payload member: lanes and cards from `genie-rs list`, forge-sync on a bounded budget, cost and time from usagemeter, and the live `genie.tasks.waiting` badge.

**Deliverables:**
1. **The mod and its footer entry** (design IN row 2). As the mock: `mod.json` has `place: "none"`, a 1×1 popup that toggles a `Tasks` tab (`toggleTasks`), and one footer entry, `{id: "tasks", label: "Tasks", icon: "mods/genie-herdr/tasks.svg", command: "mod.open", args: {name: "genie-herdr"}, badge: "genie.tasks.waiting"}`. Plain JS (A13): pure rules in `data.js` (no `herdr` or `gpui-kit` import), the view in `main.js`.
2. **Project discovery** (design IN row 3). Every Herdr space folder holding `.genie/genie.db`, with no setup. One `exec('sh', ['-c', loop, 'sh', ...folders])` prints each such folder's `pwd -P` realpath; realpaths are deduped. Worktree spaces hold no `genie.db`, so only main checkouts get a board. Local spaces only, re-probed when `spaces()` changes (A2, A3). **The loop is `PROBE_SCRIPT` (r4 M5, Decision 19):** one exported string in `data.js`; per folder holding `.genie/genie.db` it prints one line, `<synced|never>\t<realpath>`, where `synced` means the row-5 test `grep -q '"since":[0-9]' "$f"` passed on `$f` = `${GENIE_HOME:-$HOME/.genie}/cache/forge/<printf %s "$d" | shasum -a 256>.cursor.json`. The pure `parseProbe(stdout)` returns `{projects, neverSynced}` with realpaths deduped.
3. **Finding `genie-rs`** (design IN row 4). As the TS front door's `resolveGenieRsBin`: `GENIE_RS_BIN`, then `<GENIE_HOME>/plugins/genie-rs/bin/genie-rs` (`GENIE_HOME` defaults to `~/.genie`). Resolved through `exec('sh', ['-c', …])`, which has the user's real environment (A4); no `target/release` fallback.
4. **Refresh: `list` for all, forge-sync on a budget** (design IN row 5). On mount, and then on `cx.timer.every(60000, …)` while the Tasks tab is mounted. The handler returns synchronously, so `main.js` holds one in-flight boolean (via `skipWhileBusy` in `data.js`): a tick firing while one runs is skipped, never queued.
   - **`list`:** every project runs `genie-rs list --json --project <p>` (local, no forge call).
   - **forge-sync:** a global budget of 10 `genie-rs forge-sync --project <p>` calls per tick. The focused space's project, if it is one, goes first (at most once a minute). The other projects take the remaining slots round-robin, so with 128 synced projects each is reached within ceil(127/9) = 15 minutes (owner: "15 minutes is fine, keep the cap").
   - **Bounding API calls:** at most one never-synced project takes a slot per tick. A focused project that is itself never-synced takes that one slot (r4 LOW5, Decision 21). **Never-synced** (H3): the cursor file is missing, or it holds `"since":null` (the `PROBE_SCRIPT` line says `never`). A cut first pass stays in that lane until a pass completes. A cursor whose `origin` no longer matches greps as synced and is accepted (r4 LOW4, Decision 20).
   - **Backoff:** any failed forge-sync backs off 1, 2, 4… minutes, cap 1 h, reset on success; failure is a non-zero exit or an `exec` rejection (the 30 s limit too: `ExecResult` has no timeout marker).
   - **Seam:** pure `planTick(state, {now, projects, focused, neverSynced, results})` in `data.js` returns what to sync and list and the next state: the round-robin pointer (last synced realpath) and the backoff map, both kept across a re-probe (a vanished pointer resumes at the next path in sort order). `main.js` runs the plan under the in-flight guard. At most 8 spawns in flight at once (A5).
5. **Lanes and the read-only card** (design IN row 6). Working, Review, Merged and Closed (the `lane` field). **Card:** id (`task`, or "untracked" with the url), title, lead, lane, cost, time, and the ETA on open cards; no buttons; a click toggles the drawer. Order `updated_at`, a cap of 12, and the selection kept in `localStorage` (A6). **Terminal icon:** the only way into a worker, shown while a live terminal belongs to the card: `agent.focus` when a pane shows it, else `terminal.peek`, on the row-9 join's terminal, `task.lead` first; for an unlabelled worker, the lead is matched on `botId` equal to `lead` (A7).
6. **The drawer** (design IN row 7). The id, a lane chip, the terminal icon and the title; the PR/MR url (opens) and branch (copy); `usd`, `work_min`, elapsed or `lead_min`, the ETA with its merge count, and one row per `bots[]` entry; the row-1 event times and worktree. No action buttons.
7. **Cost, time and ETA from usagemeter** (design IN row 8). Each refresh runs `exec('automagik-herdr', ['doc', 'get', 'herdr-meter'])` once.
   - **Pinned path:** `doc.space.projects[<project>].tasks`, keyed by the realpath `project` from row 1, read only when that field is present as an array (usagemeter#8).
   - **Today's doc** (`meter_version` 0.3.0, `schema_version` 2) has no `space`: `projects[]` is keyed by `repo` with `tasks` a count, `tasks[]` by (`repo`, `branch`). The board reads neither, so every number is "–" by rule.
   - **Feed row:** `{key, task, url, branch, usd, work_min, lead_min, started_at, state, bots: [{bot, usd, work_min}]}`.
   - **Join:** the key is `(project, task)`, or the `url` when `task` is null.
   - **Time:** merged cards show `lead_min` (null until merge); Working cards show now − `started_at`, live; a null `started_at` shows "–" for time and ETA (A20).
   - **ETA:** the median of the project's past `lead_min` values above the elapsed time, minus it; past the slowest, "over" (the mock's `estimateOf`).
   - **Display:** null shows "–", never 0; minutes render in the mock's hour format; a measured 0 shows `$0.00`/`0m` (A8).
8. **The `genie.tasks.waiting` badge** (design IN row 9). Distinct cards across projects: every Review card (a PR ready to merge) plus every Working card with a blocked worker.
   - **Blocked join, labels first:** `terminals()` with `status === 'blocked'` whose labels carry `task` and `task.project` → that task's card in the project with the label's realpath. Each new `task.project` value is realpathed at join time (one `sh -c` `pwd -P` loop per refresh), since a label need not be a space folder; realpaths are cached per string for the tab's life (A22).
   - **Fallback, unlabelled workers only:** the latest `workers.jsonl` `start` row with `kind: "worker"` for that `terminal` → its realpathed `project` → the card matching its `task`, else its `task` or `branch` as a branch (recent rows carry branch names as `task`), else its `worktree`. An unmatched blocked terminal is not counted (A9). `workers.jsonl` is read at `<appHome>/automagik-herdr/workers.jsonl` through `tail -n 2000` (A10).
   - **Writes:** null at 0, `setShared` only on change. The overlay copy runs `list` alone for the badge (A11).
9. **Graceful degradation** (design IN row 10).
   - **`genie-rs` missing** (no file, or `exec` rejects): one line replaces the lanes, `genie-rs not found: run 'genie update'` plus the path (A12).
   - **`doc get` failing** (Decision 15): every cost, time and ETA shows "–"; the lanes still render.
   - **Forge offline** (any failed forge-sync, a non-zero exit or an `exec` rejection): a "forge not synced" note, `list` still runs, and the project backs off (row 5).
   - **`list` failing** (exit 1, a timeout, unparseable output): the last good list stays, with its age.
   - **No project database:** hidden, as is any project whose `list` exits 2 (`user_version = 0`, or `NewerSchema`: A23).
   - **Who writes:** `list` is read-only: a v5-only `genie.db` shows `[]` and stays byte-unchanged. The board's forge-sync turn is what opens it read-write, creates the `v7_` tables and appends to `tasks.jsonl`, within 15 minutes of discovery; forge-sync stays the one creator.
   - **Older `genie-rs`:** fields missing from row 1 read as null.
10. **Packaging and tests** (design IN row 11). `cp -R plugins` already stages the mod inside the frozen `plugins` member; the one build edit adds `plugins/genie-herdr/mod.json` to the `required` list in `scripts/build-binary.sh`, inserted BEFORE `"plugins/genie-rs/bin/genie-rs"` so that entry stays last and the existing pin `release-docs.test.ts:628` (`'"plugins/genie-rs/bin/genie-rs"; do'`) holds unchanged; a new pin in `scripts/release-docs.test.ts` names the new entry (review r1 LOW-4). `prune_release_tests` strips `data.test.ts`; Biome lints `plugins/**`; a `.gitignore` covers Herdr's generated files (A14).

**Interfaces:**
- Consumes: from group 1, exactly as produced there — the `genie-rs list --json --project <p>` element shape (old keys plus `created_at`, `opened_at`, `merged_at`, `closed_at`, `worktree`, `project`, each nullable except `project`), `list`'s exit codes (0, `[]` for v5-only; 2 for missing / `user_version = 0` / `NewerSchema`), `genie-rs forge-sync --project <p>` exit codes, and the cursor file path and compact `"since":null | "since":<int>` encoding. From Herdr (`~/.config/herdr-app/mods/tasks-mock/gpui-kit.d.ts`): `exec(cmd, args, {cwd, on})` (30 s, 8 MiB), `spaces()`, `terminals()`, `setShared`, `cx.timer.every` with a `(cx) => void` handler (`gpui-kit.d.ts:20616`). From usagemeter: the feed row above. From the TS front door: `resolveGenieRsBin`'s order (`src/term-commands/v5-task.ts`).
- Produces:
  - The tree `plugins/genie-herdr/` = `mod.json`, `main.js`, `data.js`, `tasks.svg`, `terminal.svg`, `clock.svg`, `.gitignore` (plus `data.test.ts`, pruned from the payload). Group 3 copies whatever this tree ships under `<GENIE_HOME>/plugins/genie-herdr`; it names no file of it.
  - `data.js` exports (pure, no `herdr`/`gpui-kit` import): `PROBE_SCRIPT: string`, `parseProbe(stdout: string) -> {projects: string[], neverSynced: Set<string>}`, `planTick(state, {now, projects, focused, neverSynced, results}) -> {sync: string[], list: string[], state}`, `skipWhileBusy(fn) -> (…args) => void`, plus the lane, card, join, ETA, format and badge rules the tests drive.
  - `scripts/build-binary.sh` `required` entry `plugins/genie-herdr/mod.json`, placed before the last entry `plugins/genie-rs/bin/genie-rs`.
  - The shared key `genie.tasks.waiting`: a positive integer, or null at 0.

**Acceptance Criteria:**
- [x] **T2 discovery:** from injected `spaces()` and the probe loop's output, a local folder holding `.genie/genie.db` is one project even when two spaces reach it through a symlink; a worktree, a folder without the file, a remote space and a project whose `list` exits 2 are not shown. **Proof:** `plugins/genie-herdr/data.test.ts`.
- [x] **T3 lanes and card:** a canned `list --json` lands in Working, Review, Merged and Closed by `lane`; a null `task` renders "untracked" with its url; the card model carries title, id, lead, lane, cost, time and ETA and no action. **Proof:** `plugins/genie-herdr/data.test.ts`.
- [x] **T4 cost, time and ETA:** a canned doc with the pinned path joins by `(project, task)`, or by `url` for a null `task`.
  - **Formatting and time:** null renders "–" and 0 renders `$0.00`. A merged card shows `lead_min`. A Working card whose `started_at` is an injected 90 minutes ago shows 1.5h, and a null `started_at` shows "–".
  - **ETA:** past `lead_min` values of 60, 120 and 240 with 90 elapsed give `~1.5h` left; 300 elapsed shows "over".
  - **Missing feed:** the live 0.3.0 shape, a missing task, `doc get` exiting 1, 2 or 3, a launch failure or invalid JSON leaves every number "–" and the lanes intact.
  - **Proof:** `plugins/genie-herdr/data.test.ts`.
- [x] **T5 badge:** 2 Review cards plus 1 Working card with a `blocked` worker gives 3.
  - **Matching:** a labelled blocked terminal matches through `task`/`task.project` without reading `workers.jsonl`, also when its `task.project` is a symlink to the project's realpath. For unlabelled terminals, the branch-as-`task` and worktree fallbacks each match.
  - **Counting:** a card is never counted twice, and a blocked terminal with no matching card adds nothing.
  - **Writes:** no waiting card gives `null`, and an unchanged count makes no `setShared` call.
  - **Proof:** `plugins/genie-herdr/data.test.ts`.
- [x] **T6 degradation:** no binary gives one line naming `genie update` and the path; any failed forge-sync (a non-zero exit or an `exec` rejection) still runs `list` and shows the note; a failed `list` keeps the last list with its age; an older `list` without the row-1 fields yields nulls. **Proof:** `plugins/genie-herdr/data.test.ts`.
- [x] **T7 forge budget:** `planTick` and `skipWhileBusy`, over simulated minutes with 128 fake projects, one focused:
  - **Cap:** no minute plans more than 10 forge-syncs, and the focused project is first every minute.
  - **Rotation:** with every project already synced once, each is synced within ceil(127/9) = 15 minutes; each tick lists all 128.
  - **Never-synced:** with 20 never-synced projects, no minute plans more than one of them, and all 20 are reached within 20 minutes. When the focused project is itself never-synced, it is first and it is that minute's one never-synced project: no other never-synced project is planned that minute (r4 LOW5).
  - **Backoff:** a project whose forge-sync fails three times in a row, by any non-zero exit or rejection, is skipped 1, 2 and 4 minutes, then never more than 60; a success resets it.
  - **Cut first pass (r4 M5):** `data.test.ts` runs the exported `PROBE_SCRIPT` under `sh` against temp folders holding `.genie/genie.db`, with a temp `GENIE_HOME` whose cursor files are missing, hold `"since":null`, or hold `"since":<number>`. `parseProbe` of that output classifies the first two as never-synced and the third as synced, and `planTick` keeps a `"since":null` project in the never-synced lane until its cursor's `since` is a number. A cursor whose `origin` names another remote but whose `since` is a number classifies as synced (r4 LOW4, accepted). **Fixture names (review r1 MEDIUM-2):** the test names each cursor file by an independently computed `sha256` of the folder's `pwd -P` string (`node:crypto` `createHash('sha256')` or `Bun.CryptoHasher`, never by running the script's own `shasum` formula), so a byte-level disagreement between the probe's name and Rust's `sha256(store.project())` fails the test instead of passing silently.
  - **No overlap:** `skipWhileBusy` skips (never queues) a tick fired while the last tick's promise is pending, and runs again once it settles.
  - **Re-probe:** dropping and adding projects mid-rotation keeps the pointer, so no project waits past the bound.
  - **Proof:** `plugins/genie-herdr/data.test.ts`.
- [x] **T8 the mod loads (local, not CI: needs the desktop app):** `herdr-app check plugins/genie-herdr` exits 0. **Proof:** `herdr-app check plugins/genie-herdr`, run by the group's engineer and pasted into the PR body.
- [x] **T9 payload:** `scripts/build-binary.sh`'s `required` list names `plugins/genie-herdr/mod.json`, so a tarball without it fails the build; the release-docs test pins that entry. **Proof:** `scripts/release-docs.test.ts`.
- [x] `main.js` runs the probe as `exec('sh', ['-c', PROBE_SCRIPT, 'sh', ...folders])` with the imported constant, never a second copy of the loop (read in review).

**Validation:**
```bash
bun test plugins/genie-herdr/data.test.ts scripts/release-docs.test.ts && bun run check
```

**depends-on:** 1

---

### Group 3: the herdr-mod install channel

**Goal:** Make `genie install` and `genie update` deliver the payload's `plugins/genie-herdr` into Herdr's mods folder, recorded and backup-first, under the workflows channel's consent gate, so the mod always matches the `genie-rs` it ships beside.

**Deliverables:**
1. **The Herdr mod channel** (design IN row 12): `src/lib/herdr-mod-installer.ts` copies `<GENIE_HOME>/plugins/genie-herdr` to `~/.config/herdr-app/mods/genie-herdr`. Same shape as the workflows channel (`src/lib/workflows-installer.ts`).
   - **Consent gate (orchestrator call N1):** runs only when the selection is not `'none'` and an install record exists, like workflows (`src/lib/workflows-installer.ts:115-127`); B1-5 is read as "under genie's normal channel consent".
   - **Record and backup:** a sha256 record of delivered files; a file matching neither the record nor the delivered bytes is copied to `<GENIE_HOME>/state-backups/herdr-mod-collision-<ISO>/` before replacement; equal bytes are left alone, so a rerun backs up nothing. `gpui-kit.d.ts`, `jsconfig.json` and every undelivered file are never touched.
   - **Herdr app home:** the installer honours `$HERDR_APP_HOME` (default `~/.config/herdr-app`), and skips with one line when there is no Herdr app home; genie creates no product home (A18).
   - **Stale files:** an unmodified recorded file the payload no longer ships is removed (A19).
   - **No mod in the payload (review r1 MEDIUM-1):** when `<GENIE_HOME>/plugins/genie-herdr` is missing (a dev release can carry group 3 before group 2), the channel prints `herdr-mod: skipped (no mod in payload — <path>)`, removes nothing, and leaves the record untouched. It is a skip, never an empty catalog: A19's stale-file rule applies only when the payload directory exists.
2. **The record field** (A17, Decision 22): one optional field `herdrMod: {dir, ref, files: <relative path> → sha256}` on the `skills-install.json` schema in `src/lib/skills-installer.ts`, carried forward verbatim by the skills channel's record rewrite beside `workflows` (`skills-installer.ts:2629`), optional so no existing record on disk is invalidated.
3. **Hooks:** `install` beside `runWorkflowsChannelConvergence` (`src/genie-commands/install.ts:201`); `update` inside the NEW binary's `update --post-delivery-converge`, beside `runUpdateWorkflowsChannel` (`src/genie-commands/update.ts:2686`, called at `update.ts:2731`), after the workflows channel. Its result is surfaced beside `workflows` in `ManualUpdateConvergenceResult`, so a failed channel reaches the exit code.
4. Tests in `src/lib/herdr-mod-installer.test.ts` (T10) and the carry-forward case beside the existing `workflows` carry-forward test for `src/lib/skills-installer.ts`.

**Interfaces:**
- Consumes: from group 1, nothing at the code level (group 3 is sequenced after it so the channel never ships a board ahead of the `list` fields it reads). The payload tree `<GENIE_HOME>/plugins/genie-herdr` is group 2's, consumed as an opaque directory: tests build a temp fixture tree, so group 3 does not wait for group 2. From the repository: `IntegrationSelection`, `inspectSkillsInstallRecord(genieHome)`, the `workflows` record field and its carry-forward (`src/lib/skills-installer.ts`), `WorkflowsChannelConvergenceOptions` / `WorkflowsChannelConvergenceResult` (`src/lib/workflows-installer.ts:88-105`), `runManualUpdateConvergence` (`src/genie-commands/update.ts`).
- Produces:
  - `runHerdrModChannelConvergence(options: HerdrModChannelConvergenceOptions): HerdrModChannelConvergenceResult` in `src/lib/herdr-mod-installer.ts`.
  - `HerdrModChannelConvergenceOptions { selection: IntegrationSelection; version: string; genieHome: string; herdrAppHome?: string /* test seam; production resolves $HERDR_APP_HOME, else ~/.config/herdr-app */; log?: (line: string) => void; now?: () => Date }`.
  - `HerdrModChannelConvergenceResult { status: 'installed' | 'skipped' | 'failed'; warnings: string[] }`.
  - Skip lines in the workflows channel's form: `herdr-mod: skipped (consent: none)`, `herdr-mod: skipped (no install record — run genie update)`, `herdr-mod: skipped (no Herdr app home — <path> does not exist)`, `herdr-mod: skipped (no mod in payload — <path>)`.
  - The optional `herdrMod` field on `skills-install.json`.

**Acceptance Criteria:**
- [x] **T10 mod channel:** against a temp `GENIE_HOME` and Herdr app home:
  - **Runs:** the first run copies every payload file and records its sha256; a second run changes nothing and creates no backup root.
  - **Backups:** a hand-edited genie file is copied to `state-backups/herdr-mod-collision-*` before replacement.
  - **Hands off:** a file genie never delivered, `gpui-kit.d.ts` and `jsconfig.json` stay byte-identical, and a host with no Herdr app home is skipped with one line.
  - **Hooks:** `genie install` runs the channel, and so does `update --post-delivery-converge`, never the old binary's update path.
  - **Consent:** a `'none'` selection or a missing install record skips the channel and writes nothing.
  - **No mod in payload (review r1 MEDIUM-1):** with a recorded, installed mod and no `<GENIE_HOME>/plugins/genie-herdr`, the run prints the one `no mod in payload` line, every installed file stays byte-identical, and the `herdrMod` record field is unchanged.
  - **Proof:** `src/lib/herdr-mod-installer.test.ts`.
- [x] **Stale file (A19):** an unmodified recorded file the payload no longer ships is removed and dropped from the record; a modified one is backed up first. **Proof:** `src/lib/herdr-mod-installer.test.ts`.
- [x] **Record carry-forward (Decision 22):** a skills-channel record rewrite keeps an existing `herdrMod` field byte-for-byte, and a record without the field still parses. **Proof:** the skills-installer test beside the `workflows` carry-forward case.
- [x] **Exit code:** a `failed` herdr-mod result on the update seam reaches the exit code as a `failed` workflows result does, and `genie install` exits 1 on a `failed` herdr-mod result (`install.ts:243`, beside `skills`/`workflows`; review r1 LOW-3). **Proof:** `src/lib/herdr-mod-installer.test.ts` or the existing update and install convergence tests.
- [x] Before editing, the engineer reads `.claude/rules/workflows-channel.md`, `.claude/rules/skills-installer.md` and `.claude/rules/release-pipeline.md`, whose `paths:` globs cover the files this group edits.

**Validation:**
```bash
bun test src/lib/herdr-mod-installer.test.ts src/lib/skills-installer.test.ts && bun run check
```

**depends-on:** 1

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] **Functional:** after `genie update --dev` on a release carrying all three groups, `~/.config/herdr-app/mods/genie-herdr` holds the delivered files, the footer shows the Tasks entry, and opening it shows this repository's tasks in their lanes with the drawer opening on a card click and no action buttons.
- [ ] **Integration:** with the tab open for a few minutes, `<GENIE_HOME>/tasks.jsonl` grows from the board's forge-sync turns, no minute runs more than 10 forge-syncs, and a Review card raises `genie.tasks.waiting` in the footer; cost/time show "–" until usagemeter#8 ships the pinned path.
- [ ] **Read-only:** `shasum -a 256 .genie/genie.db` before and after `genie-rs list --json --project <repo>` on a v5-only repository matches, taken after a checkpoint (`sqlite3 .genie/genie.db 'PRAGMA wal_checkpoint(TRUNCATE)'`) or on a repository with no `-wal` file (the T1b WAL caveat; review r1 LOW-2).
- [ ] **Regression:** `genie task v7-list`, `v7-status`, `forge-sync`, `start` and `push` behave as on `dev` before this wish; `genie update` with consent `none` writes nothing into the Herdr app home; the workflows and skills channels report as before.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| `workers.jsonl` is 300 KB and growing; `readTextFile` stops at 1 MiB | Low | Only the fallback (Decision 14), read by its tail (A10); an older worker is just not joined |
| forge-sync burns the shared gh quota (5,000/h per token) | High | Bounded in API calls: a synced pass costs one list call per 100 PRs since its cursor plus one count call per new merge, about 10–20 calls a minute at the cap (≈600–1,200/h). A project with no completed pass (`since` null) costs at most ceil(PRs in 30 d / 100) plus its 30-day merges, one such per minute even when cut, so a backlog ramps over hours. Passes resume, failures back off, ticks never overlap (group 1 T1c, group 2 T7) |
| The installer writes into another app's home | Medium | Backup-first, recorded files only, Herdr's own files untouched (T10) |
| The badge goes stale while the Tasks tab is closed | Low | The overlay copy refreshes it on each open; a resident refresher is deferred |
| The `herdr-meter` shape changes before usagemeter#8 ships | Medium | One pinned path, read only when present. Anything else degrades to "–" (group 2 deliverable 9) |
| `list --json` returns every task ever recorded, while `exec` caps output at 8 MiB | Low | The board caps what it draws. A `--since` or lane filter is deferred until measured |
| A local `created` task whose PR merged before the horizon stays Working on a never-synced project | Low | Accepted; remedy `genie task forge-sync --project <p> --full` (group 1) |
| `--full` on a repository with thousands of merges is thousands of count calls in one run (`sync.rs:276–283`) | Medium | Hand-run only, never on the board's argv; the help text says so (r4 LOW6); it saves only at completion (Decision 17) |
| A remote re-point leaves an `origin`-mismatched cursor that greps as synced, so one 30-day first pass runs outside the never-synced lane (r4 LOW4) | Low | Accepted (Decision 20): one first pass per re-point, in an ordinary capped slot |
| Group 2's size: 10 files, 1,200–1,800 inserted lines (design estimate), itemized in the Wave 2 row; with the reviewer's 500–900-line estimate for `data.test.ts` the top sits near the 2,000-line ceiling (review r1 LOW-7) | Medium | Not split (brief and design: three groups), and no split is pre-approved: `data.test.ts` ships in group 2's PR even at 700 lines or more. The mock the view grows from holds 765 lines (`main.js` 613 + `data.js` 152; `characters.js` is pets, OUT; review r1 LOW-6). A measured overrun past 2,000 lines is reported to the orchestrator and the owner before review, never a reason to shrink scope (`skills/wish/references/native-fallback.md:77`) |
| Group 1: 7 files (the design's rows 1 and 1b, plus `crates/genie-forge/tests/fixtures/fake-forge`, review r1 HIGH-1; `crates/genie-rs/src/lib.rs` now also carries `--full`, r4 LOW2), 400–700 lines; group 3: 6 files (the design's 4 plus `src/lib/skills-installer.ts` and its test), about 700–1,000 lines, estimated from the workflows-channel analog (934 lines) | Low | All under 25 files and 2,000 lines |
| T8 (`herdr-app check`) needs the desktop app and cannot run on CI | Low | Local proof pasted into group 2's PR; every other mod criterion runs in `bun test` on both legs |
| The Herdr pack lives in the automagik repo under `herdr/` (automagik-dev/automagik-herdr is archived) | Low | Read the `workers.jsonl` contract and the pack code from `~/workspace/repos/automagik/herdr`, never from the archived checkout (DRAFT repo note) |

---

## Review Results

_The read-only reviewer returns evidence; the invoking orchestrator appends a timestamped block here after plan, execution, and PR reviews._

### Plan review r1 — 2026-11-04T13:16:10Z — FIX-FIRST

- **Reviewer:** claude-fable-5-1 (independent, read-only). **Target:** PR #3220 head `35eec87e3`. Report: the orchestrator scratchpad `board-plan-review-r1.md`.
- **Verdict:** FIX-FIRST — one HIGH, two MEDIUM, seven LOW. Design fidelity, sizes, validation commands, interfaces and identity held (no finding).
- **HIGH-1** (T1c and the M4 cursor criterion unprovable: `fake-forge` serves one `list.json` and fails per file) → group 1 deliverable 6 makes the fake page-aware (`list-<N>.json`, falling back to `list.json`; `!fail` per page file; `calls.log` asserts `page=N`); the fixture joins group 1's files (7); T1c Horizon/Resume and the `--full` cursor criterion now assert a successful page 1.
- **MEDIUM-1** (no disposition for a payload without `plugins/genie-herdr`) → group 3 deliverable 1 and Interfaces add `herdr-mod: skipped (no mod in payload — <path>)`, removing nothing and leaving the record untouched; a T10 case pins it.
- **MEDIUM-2** (probe and Rust cursor-file names never proven equal) → group 1 asserts the exact `<hex sha256(store.project())>.cursor.json` name; T7 names its fixtures by an independently computed sha256 of the `pwd -P` string.
- **LOW-1** (`forge-sync --help` location and exit shape) → the text lives in `USAGE` (`lib.rs:20–22`); `genie-rs help` exits 0 on stdout, `forge-sync --help` keeps exit 2 with `USAGE` on stderr; criterion updated.
- **LOW-2** (QA read-only check without the WAL caveat) → QA checkpoints first or uses a repository with no `-wal` file.
- **LOW-3** (install seam exit code) → the criterion adds `genie install` exiting 1 on a `failed` herdr-mod result (`install.ts:243`).
- **LOW-4** (T9 vs the last-entry pin `release-docs.test.ts:628`) → the new `required` entry is inserted before `plugins/genie-rs/bin/genie-rs`, which stays last; a new pin names the new entry.
- **LOW-5** (an incremental pass cut mid-paging) → a T1c clause: `since` stays N and page 1's `seen` entries are added.
- **LOW-6** (mock size) → 765 lines (`main.js` 613 + `data.js` 152), corrected in Risks.
- **LOW-7** (group 2 estimate not itemized) → the Wave 2 row itemizes view / rules / test / assets; Risks says `data.test.ts` ships in group 2's PR and no split is pre-approved; an overrun is reported, never a scope cut.
- **Status:** stays DRAFT, awaiting re-review.

### Plan review r2 — 2026-11-04T13:27:23Z — SHIP

- **Reviewer:** claude-fable-5-1 (independent, read-only). **Target:** PR #3220 head `4d26426f06df181005780c4e75d6befc991ad94a`. Report: the orchestrator scratchpad `board-plan-review-r2.md`.
- **Verdict:** SHIP. All ten r1 findings (HIGH-1, MEDIUM-1, MEDIUM-2, LOW-1..7) verified fixed.
- **Three LOWs, folded in after the review as worded:** LOW-1, T1c Resume and the `--full` cursor criterion prove page 1 completed by a `page=2` line in `calls.log` (`fake-forge:14` logs a request before its outcome); LOW-2, deliverable 6 says the fake matches `*[?&]page=*` and a page followed by another holds exactly `PAGE` = 100 rows (`client.rs:14`); LOW-3, deliverable 3 "Per page" says a per-page save leaves `since` unchanged (null on a first pass, N on an incremental one).
- **Status:** APPROVED.

---

## Files to Create/Modify

```
# Group 1
crates/genie-rs/src/lib.rs
crates/genie-rs/tests/exit_codes.rs
crates/genie-tasks/src/store.rs
crates/genie-forge/src/sync.rs
crates/genie-forge/src/client.rs
crates/genie-forge/tests/sync.rs
crates/genie-forge/tests/fixtures/fake-forge   (page-aware list replies, per-page !fail)

# Group 2
plugins/genie-herdr/mod.json                (new)
plugins/genie-herdr/main.js                 (new)
plugins/genie-herdr/data.js                 (new)
plugins/genie-herdr/data.test.ts            (new)
plugins/genie-herdr/tasks.svg               (new)
plugins/genie-herdr/terminal.svg            (new)
plugins/genie-herdr/clock.svg               (new)
plugins/genie-herdr/.gitignore              (new)
scripts/build-binary.sh
scripts/release-docs.test.ts

# Group 3
src/lib/herdr-mod-installer.ts              (new)
src/lib/herdr-mod-installer.test.ts         (new)
src/lib/skills-installer.ts                 (the optional herdrMod record field, carried forward)
src/lib/skills-installer.test.ts            (the carry-forward case)
src/genie-commands/install.ts
src/genie-commands/update.ts
```
