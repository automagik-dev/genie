# Wish: Genie v7 tasks — every piece of agent work is a tracked task, in Rust

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `genie-v7-tasks` |
| **Date** | 2026-11-03 |
| **Author** | Genie Orchestrator t247 |
| **Appetite** | large |
| **Branch** | `wish/genie-v7-tasks` |
| **Repos touched** | `automagik-dev/genie` |
| **Design** | [DESIGN.md](../../brainstorms/genie-v7-tasks/DESIGN.md) |

## Summary

Agent work on this machine cannot be tied to a task: branches carry no id, and nothing records when a task started, opened its PR or merged, so the Herdr Space Row's merges, lead-time and first-pass chips show "–" and cost cannot be credited to a task. This wish builds the task contract as Rust crates that mirror Unfold's part contract: an event-sourced task log in Rust-owned `v7_` tables of the per-repo `genie.db`, a one-shot forge poller that records `opened`/`merged`/`closed`, the machine-wide `<GENIE_HOME>/tasks.jsonl` export usagemeter reads, and (group 2) the `start` and `push` verbs that mint `gn-<seq>` ids, cut a task worktree from a fresh base and lock plain `git push` out of it. The design was reviewed SHIP in round 4 (digest `b28c3c09…`); this plan copies its interfaces, criteria and constraints and folds in the round-4 findings carried to the wish (M1–M4, L1–L4, L6).

## Scope

### IN

Every row is DESIGN.md's IN row of the same number, copied in substance; where this wish changes a row it says so and names the round-4 finding.

- **Row 1 — Rust workspace (group 1).** A root Cargo workspace with `members = ["crates/*"]`, `resolver = "3"`, `edition = "2024"`, Apache-2.0, exact-pinned dependencies and toolchain `1.94.0` (source: `~/workspace/repos/rth/rust-toolchain.toml`). Release targets `aarch64-apple-darwin`, `x86_64-unknown-linux-musl` (shipped for both the `linux-x64-glibc` and `linux-x64-musl` tarballs, since it is static) and `aarch64-unknown-linux-musl`. No OpenSSL and no network crate; SQLite from `rusqlite` with the `bundled` feature. Biome, knip and tsc ignore `crates/` and `target/`.
- **Row 2 — `genie-part`, the Unfold part contract mirrored (group 1).** `trait Part { manifest, digest, schema, asks, call }`, `PartManifest { schema, id, version, title, tools: [PartTool { name, effect, description? }] }`, `Effect { None, Reversible, Irreversible }`, field for field; a parity test against a frozen, normalized copy of Unfold's declarations (`rth-tools/src/parts.rs`, `authority.rs`, `profile.rs` under `bench/staging/agentd-rc5.13.3/ws/crates/`) stored with source paths and SHA-256; the re-pin step documented in the crate README.
- **Row 3 — `genie-tasks`, the state machine and its tables in `genie.db` (group 1).** Pure core `enum TaskState`, `enum TaskEvent { Created, Opened, Merged, Closed }`, `fn apply(state, event) -> Result<state, Refusal>` with no I/O and an injected clock; store in the per-repo `.genie/genie.db` resolved as `src/lib/v5/genie-db.ts` does, refusing `<GENIE_HOME>/genie.db`, with the `src/lib/v5/sqlite-open.ts` pragmas; tables `v7_task_events`, `v7_tasks`, `v7_task_ids`, `v7_schema`; Rust never creates `genie.db`; `task_key` = task id or `pr:<forge>:<url>`; one `BEGIN IMMEDIATE` transaction per event with `synchronous=FULL`; `dedupe_key`; lanes derived, never stored. **Changed by this wish:** `v7_task_events` rows carry `forge` and `url` (L4); `apply` refuses `created` for a task already at `opened` (M2, pure-core half); `closed` gets a derived lane (L1); `commit` is defined per event (M4).
- **Row 4 — the machine-wide export `<GENIE_HOME>/tasks.jsonl` (group 1).** One row per committed event, one `write(2)` on an `O_APPEND` descriptor; shared `flock` on the `tasks.jsonl.lock` sidecar around each append; `genie-rs export --rebuild --project <path>…` under the exclusive lock with temp + fsync + rename. **Changed by this wish:** the row's `task` field is JSON `null`, not `''`, for a PR with no task id (M3); rebuild reads `v7_task_events` only after it holds the exclusive lock (L3); the lock uses `std::fs::File::lock_shared` / `File::lock` with no crate (L6).
- **Row 5 — `genie-forge`, the one-shot poller (group 1).** `genie-rs forge-sync [--project <path>]` through `gh api` / `glab api`, read-only with the operator's own login; `opened`, `merged`, `closed`-without-merge events; `type` from the conventional-commit title; exclusions flagged; `pushed_after_open`; task id from the branch; 60 s reply cache; one pass, then exit; also a `Part` with tool `forge_sync`, effect `Reversible`. **Changed by this wish:** `opened` is emitted once per task, with `commit` = the first head seen (M4).
- **Row 6 — `genie-rs`, the Rust front door (group 1).** One binary, hand-rolled `std::env::args` dispatch (no clap); verbs `forge-sync`, `export --rebuild`, `status <id>`, `list` (group 1) and `start`, `push` (group 2); stdio JSON-lines test seam in `src/bin/`. **Changed by this wish:** the exit vocabulary is stated as a rule (L2, Decision 4 below).
- **Row 7 — the TS CLI hands these verbs to Rust (group 1, plus two verbs in group 2).** `genie task forge-sync|v7-status|v7-list` (group 1) and `genie task start|push` (group 2) exec `genie-rs` with the tail argv untouched, exactly as `mikro` does, and return its exit code; binary resolution `GENIE_RS_BIN` → payload `plugins/genie-rs/bin/genie-rs` → `target/release/genie-rs`; a missing binary exits 1 with one line naming the fix.
- **Row 8 — build, CI and ship (group 1).** `scripts/build-binary.sh` maps its 4 platforms to the 3 Rust targets, built natively on each `.github/workflows/build-tarballs.yml` runner (`musl-tools` on linux, `rustup` pinned to 1.94.0 through a SHA-pinned toolchain action); `plugins/genie-rs/bin/genie-rs` staged at mode 0755 inside the existing `plugins` member; `cargo fmt --check`, `cargo clippy -D warnings` and `cargo test --locked` on the linux leg and the `unit-darwin` leg; `bun run check` runs `cargo test --locked` and fails with a one-line remedy when `cargo` is missing, never skipping.
- **Row 9 — start, push and short ids (group 2).** `genie-rs start (<gh-N|gl-N> | --title <t>) --lead <bot id> [--type fix|feat|docs|…]` — fresh base fetched into a private `refs/genie/start/<nonce>` ref, `gn-<seq>` minted in a short transaction, worktree at `<repo>.worktrees/<id>-<slug>` with no upstream, per-worktree push lockout, `created` recorded in a second short transaction, JSON output; `genie-rs push` pushes only to the recorded task branch. **Changed by this wish:** `start` refuses an id that already has a `v7_tasks` row before the fetch, at zero cost (M2, verb half).

### OUT

- **On-merge actions:** kill the workers, remove the worktree, close the forge issue with a cost and lead-time comment. These become the first reactions, in a later wish subscribed to the `merged` event this wish records (DESIGN OUT; R1-15, R1-2).
- **Reactions to public issue text** wait for lockdown (R1-7).
- **The board mod** (`plugins/genie-herdr`), its feed and the `genie.tasks.waiting` badge: the next wish, reading `v7_tasks` (R1-12, R1-16).
- **Migrating TS cards and verbs to Rust.** Trigger: this wish merged. `genie task list` stays TS until then, and v7 tasks show in `genie task v7-list` (R1-22).
- **A To-do lane from open forge issues.** Trigger: the board wish (R1-1).
- **Cost on the task record:** usagemeter computes cost from Herdr's worker ledger and this export (R1-19).
- **Removing `plugins/genie-dsh`'s coding path:** an open owner question (R1-10).
- **Home directories on NFS/SMB** (reviewer MEDIUM-1).
- **Re-opening a closed PR.** `closed` is terminal in this wish's state machine; a reopen is not modelled.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | DESIGN.md Decisions 1–10 apply unchanged: Genie owns the task record, ids are `gh-N`/`gl-N`/`gn-<seq>`, a task starts when its worktree is created, Rust-owned `v7_` tables in the per-repo `genie.db` with `tasks.jsonl` as an export, Rust crates mirroring Unfold's part contract, one-pass poller, forge access only through `gh`/`glab` read-only, push lockout in code, the binary inside the `plugins` payload member, worktrees at `<repo>.worktrees/<id>-<slug>` | Reviewed SHIP in round 4 (DESIGN.md, digest `b28c3c09…`); restated here so a group worker sees them without opening the design |
| 2 | Exactly two groups: (1) IN rows 1–8, (2) IN row 9 | Owner decision R1-20 (DRAFT.md) |
| 3 | **M3 — the export row's `task` field is JSON `null` for a PR with no task id.** DESIGN.md row 3 and T5 say `task: ''`; this wish supersedes that literal with `null`. The override is confined to the JSON export row: the `dedupe_key` framing still uses `''` for any absent part, exactly as DESIGN.md row 3 states, so the key is unchanged | R1-19 records "task from the branch or null"; usagemeter t22b confirmed `null` on 2026-11-03 (DRAFT.md Open item 0; its reader also maps `''` to `null`) |
| 4 | **L2 — the exit vocabulary.** 0 ok. 1 = an external-input failure, even when nothing was written: a forge reply with a NUL byte in a dedupe part or that cannot be parsed, a missing or logged-out `gh`/`glab`, a failed `git fetch`, a missing `genie-rs` binary behind the TS front door. 2 = a refusal of the operator's own request that changed nothing: a missing or `user_version = 0` `genie.db`, a `<GENIE_HOME>/genie.db` path, `start` of an id that already has a task row, `start` in a repo whose shared config sets `core.bare`/`core.worktree`, `push` to any branch but the recorded task branch | Round-4 L2: row 6's "2 = refusal" and row 3's "NUL exits 1" read as contradictory; Risk 4 already treats a logged-out forge CLI as 1 |
| 5 | **M4 — `commit` per event.** `created` = the base sha the worktree was cut from; `opened` = the first head sha forge-sync sees for the PR/MR; `merged` = the merge commit sha; `closed` = the head sha at the sync that first sees the PR/MR closed. forge-sync emits `opened` only for a task that is not already at `opened` or later (no `v7_tasks` row, or a row at `created`), so a later push never yields a second `opened`, and the dedupe key of the one `opened` row is fixed | Round-4 M4: `commit` is a dedupe part, so a moving head made a second `opened` possible. `opened` and `merged` are as carried in DRAFT.md Open item 0; `created` and `closed` are this plan's fill-in so no event is undefined — the plan reviewer confirms or corrects them |
| 6 | **M2 — a task id that already has a `v7_tasks` row cannot be started.** Pure core: `apply(Opened, Created)` is a `Refusal`. Verb: `start <id>` reads `v7_tasks` first and exits 2 before step (a), with no fetch, ref, reservation, worktree, branch or event. Ids in `created`, `merged` or `closed` take the same early exit, because `apply` already refuses `created` for them at step (e); the pre-check only moves that refusal ahead of every side effect | Round-4 M2: a hand-opened PR on `fix/gh-5-…` leaves `gh-5` at `opened`, and `start gh-5` would otherwise reach the refusal only after fetch, worktree and lockout |
| 7 | **L1 — derived lanes:** created → Working, opened → Review, merged → Merged, closed → Closed | Round-4 L1: `none → closed` creates a row with no lane |
| 8 | The TS pass-through for `start` and `push` lands in group 2 with the verbs, not in group 1 | DESIGN.md row 6 already defers both `genie-rs` verbs to group 2; registering their TS front door earlier would ship two verbs that only refuse |

## Simplicity Case

- **Simplest complete design:** three library crates and one binary; four Rust-owned tables in the existing per-repo database; one export file with one lock sidecar; forge access by shelling out to `gh`/`glab`.
- **Added machinery:**
  - The `genie-part` mirror: Unfold compatibility is required now (R1-24).
  - The 60 s forge cache: the Space Row spec's "Forge and CI calls are cached, at most once a minute" (`~/workspace/repos/HERDR-SPACE-ROW-BUILD.md`, R1-19).
  - `dedupe_key`: a re-run must not double-count (R1-19, reviewer HIGH-2).
  - The `v7_task_ids` reservation table: race-free ids without holding a lock across git (reviewer HIGH-3).
  - Per-worktree config: the push lockout (R1-27).
  - **The `<GENIE_HOME>/tasks.jsonl.lock` sidecar plus temp-file + fsync + rename for rebuild (M1):** appends hold a shared `flock` on the sidecar, rebuild holds it exclusive, so no append lands on a replaced file (DESIGN.md row 4, round-3 MEDIUM-N2). The sidecar survives the rename, which locking the data file would not. It is `std::fs::File::lock_shared` / `File::lock`, so it adds no crate (L6).
- **Deferred until measured:**
  - **Batching events per transaction.** Trigger: a measured sync that spends more than 1 s in fsync.
  - **A shared writer process.** Trigger: `SQLITE_BUSY` past `busy_timeout` in the 128-process test.
  - **Snapshots of `v7_task_events`.** Trigger: more than 1M events in one repository.
- **Complexity removed:**
  - No HTTP or TLS stack, no tokens and no daemon.
  - No stored lane, no second database, and no FETCH_HEAD dependency.
  - No `created` rows before group 2, so group 1 lead times are an honest "–".

## Dependencies

**depends-on:** none
**blocks:** none

## Success Criteria

T1–T10 are DESIGN.md's criteria. Additions from round 4 are marked **(M2)**, **(M3)**, **(M4)**, **(L1)**, **(L2)**, **(L3)**, **(L4)**; none removes or loosens a DESIGN.md case.

- [ ] **T1 workspace:** `cargo test --workspace --locked` and `cargo clippy -D warnings` pass on the linux and darwin CI legs, and each tarball runner builds its Rust target. **Proof:** `.github/workflows/ci.yml`, `.github/workflows/build-tarballs.yml`.
- [ ] **T2 part parity:** the mirror's `Part`, `PartManifest` and `Effect` match the frozen Unfold copy; changing one field on either side fails the test. **Proof:** `crates/genie-part/tests/parity.rs`.
- [ ] **T3 state machine:** accepted created→opened→merged and opened→closed; accepted for a task with no `created` event none→opened, none→merged and none→closed; two untracked PRs in one project get two `task_key`s (`pr:<forge>:<url>`) and neither ever refuses the other's events; refused merged→opened, merged→closed, a second created, and **(M2)** a `created` for a task already at `opened`; a repeated identical event is a no-op; lanes derive as Working, Review, Merged and **(L1)** Closed. **Proof:** `crates/genie-tasks/tests/apply.rs`.
- [ ] **T4 128 writers:** 128 processes append distinct events to one repository's `genie.db` at once; every event lands exactly once; `v7_tasks` equals a replay of `v7_task_events`, **(L4)** with each untracked task's `task_key` rebuilt from the event row's own `forge` and `url`; `tasks.jsonl` holds each row once, with no torn line. **Proof:** `crates/genie-tasks/tests/parallel.rs`.
- [ ] **T5 forge-sync:** a fake `gh` on PATH serves canned PRs. First run appends opened, merged and closed rows with the right `type`, `counted` and `exclude_reason`; `pushed_after_open` 0 and 2 cases; task ids taken from the branch, an untracked branch keyed by its PR url, and **(M3)** its export row carries `task: null` (JSON null, superseding DESIGN.md's `''` per Decision 3) plus its `url`; two untracked PRs in a row (A opens and merges, then B opens and merges) yield four rows and two `v7_tasks` rows with no refusal; a PR that opened and merged between two syncs yields one `merged` row; a canned PR with a NUL in its url or head commit **(L2)** exits 1 and writes nothing; a merged PR the forge also marks closed yields only `merged`; a second run, including the untracked-branch PR, appends nothing; **(M4)** a PR whose head moves between two syncs yields exactly one `opened` row, whose `commit` is the head seen by the first sync, and its `merged` row's `commit` is the merge sha; a run within 60 s makes no forge call; a fake `glab` on a non-github host gives the same results; a missing `gh` exits 1 and writes nothing. **Proof:** `crates/genie-forge/tests/sync.rs`.
- [ ] **T6 front door:** `genie task forge-sync --project <fixture> --json` runs `genie-rs` with `--json` intact and returns its exit code. With no binary it exits 1 and names the fix. **Proof:** `src/term-commands/v5-task.test.ts`.
- [ ] **T7 start and push (group 2):** upstream `dev` one commit ahead of the local `dev`: `start --title "sync hangs" --lead b-x` creates `fix/gn-1-sync-hangs` at the upstream tip, in `<repo>.worktrees/gn-1-sync-hangs`, with no upstream; it writes one `created` event and one export row, and writes no FETCH_HEAD, and any `refs/genie/start/*` ref it leaves behind is swept by the next start; 32 parallel starts mint 32 distinct `gn` ids and 32 worktrees; a plain `git push` from the worktree exits non-zero, `genie-rs push` reaches the fixture's bare remote, pushing another branch or any of `dev`, `main`, `master` is refused, and the main checkout can still push; a failed fetch leaves no worktree, branch or event; **(M2)** `start gh-5` when `gh-5` is already `opened` (recorded by forge-sync) exits 2 before any fetch, leaving no `refs/genie/start/*` ref, no `v7_task_ids` reservation, no worktree, no branch, no event and no export row, and makes no network call. **Proof:** `crates/genie-tasks/tests/start.rs`.
- [ ] **T8 payload:** the built tarball carries `plugins/genie-rs/bin/genie-rs` for its platform, with mode 0755 after promotion, and still exactly the 8 top-level members. **Proof:** the existing payload-member test in `scripts/` plus a new mode assertion.
- [ ] **T9 shared database, both init orders:** TS initializes first and Rust adds its `v7_` tables, or Rust is run first and refuses with exit 2 and the init remedy, leaving no file behind. In both orders, the existing TS task, board, export, import `--replace`, delete and `doctor` tests then pass unchanged, `roadmap.json` gains nothing, and the `v7_` rows survive `import --replace`. **Proof:** `src/term-commands/v5-task.test.ts`, `src/term-commands/v5-board.test.ts`.
- [ ] **T10 rebuild:** after deleting `tasks.jsonl`, `export --rebuild --project <fixture>` restores its rows exactly, and other projects' rows are left alone. Concurrent appends: a rebuild run while 16 processes append leaves every committed event in the file at least once, and exactly once after deduping on `dedupe_key`; **(L3)** rebuild opens its `v7_task_events` read only after it holds the exclusive lock on `tasks.jsonl.lock`, asserted by the test (an event committed while rebuild waits for the lock is in the rebuilt file). **Proof:** `crates/genie-tasks/tests/export.rs`.

## Execution Strategy

### Wave 1 (sequential)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 1 | engineer | High — new Rust workspace, shared `genie.db` with TS, cross-process locking, CI and payload changes on two platforms; over the admission band (see Assumptions / Risks) | inherit | Rust foundation + forge poller → task log: workspace, `genie-part`, `genie-tasks`, the export, `genie-forge`, `genie-rs`, the TS front door, build/CI/ship (IN rows 1–8; T1–T6, T8–T10) |

### Wave 2 (sequential, after wave 1)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 2 | engineer | Medium-high — git plumbing under parallel starts (private refs, worktree config, push lockout); consumes group 1's tables and dispatch unchanged | inherit | `start`, `push` and `gn` ids (IN row 9; T7) |

**Global constraints:**
- Toolchain `1.94.0` (source `~/workspace/repos/rth/rust-toolchain.toml`); workspace `members = ["crates/*"]`, `resolver = "3"`, `edition = "2024"`, Apache-2.0, exact-pinned dependencies.
- Release targets: `aarch64-apple-darwin`, `x86_64-unknown-linux-musl` (shipped for both the `linux-x64-glibc` and `linux-x64-musl` tarballs), `aarch64-unknown-linux-musl`. Stable is Linux and macOS; Windows is not a target.
- No OpenSSL and no network crate: forge access goes through `gh`/`glab`. SQLite comes from `rusqlite` with the `bundled` feature. No clap. File locks use `std::fs::File::lock_shared` / `File::lock`, no crate.
- Rust writes only its own tables, all prefixed `v7_`; `PRAGMA user_version` and every TS table stay untouched; Rust never creates `genie.db`.
- No network call or git command ever runs inside a write lock.
- Zero-daemon: every verb is a short process; callers own the cadence.
- Exit codes: 0 ok, 1 failed (external input included), 2 a refusal that changed nothing (Decision 4). Errors go to stderr; `--json` output goes to stdout.
- The 8 `INSTALL_PAYLOAD_MEMBERS` stay frozen; the binary ships at `plugins/genie-rs/bin/genie-rs`, mode 0755.
- The repository gate `bun run check` stays required and green; it runs `cargo test --locked` and fails, never skips, without `cargo`.

## Execution Groups

### Group 1: Rust foundation + forge poller → task log

**Goal:** Ship the Rust workspace, the task state machine and its `v7_` tables, the `tasks.jsonl` export, the one-shot forge poller and the `genie-rs` binary, reachable from `genie task` and shipped in every tarball.

**Deliverables:**
1. Root `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`; `.gitignore`, `biome.json`, `knip.json` and tsc ignore `crates/` and `target/` (IN row 1).
2. `crates/genie-part/` with its README re-pin step and `tests/fixtures/rth-tools-part.txt` (IN row 2).
3. `crates/genie-tasks/`: pure `apply` with `apply(Opened, Created)` refused (M2) and the Closed lane (L1); the store with `v7_task_events` (carrying `forge` and `url`, L4), `v7_tasks`, `v7_task_ids`, `v7_schema`; `commit` per event as Decision 5 (M4) (IN row 3).
4. `crates/genie-tasks/src/export.rs`: rows with `task: null` for no task id (M3), the sidecar flock via `std::fs::File` (L6), rebuild reading events under the exclusive lock (L3) (IN row 4).
5. `crates/genie-forge/` and `genie-rs forge-sync`, emitting `opened` once per task (M4) and exit 1 on a NUL or other external-input failure (L2) (IN row 5).
6. `crates/genie-rs/` with `forge-sync`, `export --rebuild`, `status <id>`, `list`, the exit vocabulary of Decision 4, and the stdio test seam in `src/bin/` (IN row 6).
7. `genie task forge-sync|v7-status|v7-list` pass-through in `src/term-commands/v5-task.ts` (IN row 7; `start`/`push` wait for group 2, Decision 8).
8. `scripts/build-binary.sh`, `.github/workflows/build-tarballs.yml`, `.github/workflows/ci.yml`, `package.json`, and the payload tests (`scripts/release-docs.test.ts`, `src/lib/install-promotion.test.ts` with the new mode assertion) (IN row 8).

**Interfaces:**
- Consumes: none. From the repository: `src/lib/v5/genie-db.ts` path resolution and `GlobalDbPathError` behaviour, `src/lib/v5/sqlite-open.ts` pragmas, `src/term-commands/mikro.ts` pass-through shape, `INSTALL_PAYLOAD_MEMBERS` in `src/lib/install-promotion.ts`.
- Produces:
  - `genie_tasks::apply(state: Option<TaskState>, event: &TaskEvent, now: <injected clock>) -> Result<TaskState, Refusal>`; `enum TaskEvent { Created, Opened, Merged, Closed }`; lanes `Working | Review | Merged | Closed`, derived.
  - `v7_tasks` keyed by `(project, task_key)`, holding current state, title and lead; `task_key` = task id or `pr:<forge>:<url>`.
  - `v7_task_events`, append-only: `project, task_key, task (NULL-free, '' when absent), event, forge, url, branch, commit, worktree, type, lead, at, counted, exclude_reason, pushed_after_open, dedupe_key TEXT NOT NULL UNIQUE`.
  - `dedupe_key` = SHA-256 of `project, task, event, url, commit, worktree` joined with `\0`, `''` for an absent part.
  - `v7_task_ids` (the `gn` sequence reservations, with an abandoned marker), created empty in group 1; `v7_schema` (one version row).
  - The append API `genie_tasks::record(db, project, event_row) -> Result<Recorded, Refusal>`: one `BEGIN IMMEDIATE` transaction (apply + insert + upsert, `synchronous=FULL`), then one export row under the shared sidecar lock.
  - Export row: `{v:1, event, project, task (string or null), branch, forge, url, type, at, commit, lead, counted, exclude_reason, pushed_after_open, dedupe_key}`.
  - `genie-rs` dispatch table (`std::env::args`) that group 2 extends with `start` and `push`; exit codes per Decision 4.
  - TS pass-through helper in `v5-task.ts` resolving `GENIE_RS_BIN` → `plugins/genie-rs/bin/genie-rs` → `target/release/genie-rs`.

**Acceptance Criteria:**
- [ ] T1 workspace (Success Criteria).
- [ ] T2 part parity.
- [ ] T3 state machine, including the M2 refusal and the L1 Closed lane.
- [ ] T4 128 writers, including the L4 replay.
- [ ] T5 forge-sync, including M3 `task: null`, the M4 one-`opened` case and the L2 NUL exit 1.
- [ ] T6 front door.
- [ ] T8 payload.
- [ ] T9 shared database, both init orders.
- [ ] T10 rebuild, including the L3 lock-then-read case.
- [ ] The Simplicity Case's lock sidecar is the only lock mechanism added, and it adds no crate (M1, L6): `Cargo.lock` holds no file-lock crate.

**Validation:**
```bash
cargo fmt --check && cargo clippy --workspace --all-targets --locked -- -D warnings && cargo test --workspace --locked && bun run check
```

**depends-on:** none

---

### Group 2: start, push and gn ids

**Goal:** Let a worker start a task from a fresh base in its own worktree with a short id, and push only that task's branch.

**Deliverables:**
1. `genie-rs start (<gh-N|gl-N> | --title <t>) --lead <bot id> [--type fix|feat|docs|…]`, steps (a)–(f) and the failure cleanup exactly as DESIGN.md IN row 9.
2. **(M2)** Before step (a), `start <id>` reads `v7_tasks` and exits 2 when the id already has a row (`opened` is the case found in review; Decision 6), with no fetch, ref, reservation, worktree, branch, event or export row.
3. `created` records `commit` = the base sha (Decision 5).
4. `genie-rs push`: `HEAD:refs/heads/<recorded task branch>` to the main checkout's real remote URL passed as argv, refusing any other branch plus `dev`, `main`, `master` and the recorded base (exit 2).
5. `genie task start|push` pass-through in `src/term-commands/v5-task.ts` with tests (Decision 8).

**Interfaces:**
- Consumes: from group 1, exactly as produced there — `apply`, `record`, the `v7_tasks` / `v7_task_events` / `v7_task_ids` schemas, the export row, the `genie-rs` dispatch table and exit codes, the TS pass-through helper.
- Produces: `start` prints `{task, branch, worktree, lead, base_sha}` to stdout for `automagik-herdr worker --task <id> --worktree <dir> --lead <bot>`; branch `<type>/<id>-<slug>`; worktree `<repo>.worktrees/<id>-<slug>`; per-worktree `remote.<remote>.pushurl = genie-no-push://use-genie-rs-push`.

**Acceptance Criteria:**
- [ ] T7 start and push (Success Criteria), including the M2 already-opened case.
- [ ] T3 still passes unchanged (group 2 adds no state-machine transition).
- [ ] The full group 1 suite still passes.

**Validation:**
```bash
cargo test -p genie-tasks --test start --locked && cargo clippy --workspace --all-targets --locked -- -D warnings && cargo test --workspace --locked && bun run check
```

**depends-on:** 1

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] **Functional:** in a scratch clone with a real GitHub remote, `genie task forge-sync --json` records each open/merged PR once, a second run within 60 s makes no `gh` call, and `<GENIE_HOME>/tasks.jsonl` rows for branches without a task id carry `"task":null`.
- [ ] **Functional (group 2):** `genie task start --title "qa probe" --lead b-qa` prints `{task, branch, worktree, lead, base_sha}` with a `gn-` id; a plain `git push` from that worktree fails; `genie task push` reaches the task branch only.
- [ ] **Integration:** the dev tarball for linux-x64-musl and darwin-arm64 installs `plugins/genie-rs/bin/genie-rs` at mode 0755, and `genie update --dev` on a v6 host still converges (8 top-level payload members).
- [ ] **Integration:** usagemeter t22b reads the dev `tasks.jsonl` and shows merges and lead times for a task started with `genie task start`.
- [ ] **Regression:** `genie task list`, `genie board`, `genie task export --write`, `genie task import --replace` and `genie doctor` behave as before on a repo whose `genie.db` holds `v7_` rows, and `roadmap.json` gains nothing.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| **Group 1 is over the admission band (≤ 25 files, ≤ 2,000 insertions per group).** Estimate: about 40 files and 3,500–4,800 insertions. Files: root workspace 3 (`Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`) + ignore configs 3 (`.gitignore`, `biome.json`, `knip.json`); `genie-part` 5 (manifest, `lib.rs`, README, `tests/parity.rs`, fixture); `genie-tasks` 9–10 (manifest, `lib.rs`, state, store, `export.rs`, README, `tests/apply.rs`, `parallel.rs`, `export.rs`); `genie-forge` 7–8 (manifest, `lib.rs`, gh/glab client, sync, `tests/sync.rs`, fake `gh` and `glab`, canned replies); `genie-rs` 3–4 (manifest, `main.rs`, `src/bin/` seam); TS 3 (`v5-task.ts`, `v5-task.test.ts`, `v5-board.test.ts`); build/CI 6 (`build-binary.sh`, `build-tarballs.yml`, `ci.yml`, `package.json`, `scripts/release-docs.test.ts`, `src/lib/install-promotion.test.ts`). Insertions: Rust source and tests 2,800–3,600; `Cargo.lock` 400–550 (about 40–50 packages for `rusqlite` bundled, `sha2`, `serde`/`serde_json` and test helpers, at the ~10.5 lines per package measured in `~/workspace/repos/rth/Cargo.lock`, 6,614 lines / 622 packages); TS, CI and build 250–400 | High | Not split by the plan writer: R1-20 fixes two groups and the brief forbids splitting here. The wish skill treats a group over the band as a sibling wish, so this is raised to the orchestrator (t247) for an owner decision before the plan review. A natural seam if the owner splits: 1a rows 1–4 + 6–7 (workspace, part, tasks, export, binary, front door) and 1b rows 5 + 8 (forge-sync, build/CI/ship). Group 2 is within the band: about 6–8 files and 1,000–1,400 insertions |
| A busy repository serializes its writers behind SQLite's one writer | Medium | Short `BEGIN IMMEDIATE` transactions with no I/O inside, plus `busy_timeout`. T4 proves 128 parallel writers to one repository, with no lost or duplicated event |
| TS and Rust share one `genie.db` file | Medium | Disjoint `v7_` tables, Rust's own `v7_schema` version, `user_version` never written by Rust, and Rust refusing a missing or version-0 file. Same pragmas except `synchronous=FULL` on Rust's event transactions. T9 proves both init orders |
| Unfold's `Part` trait changes before it is published | Medium | The test catches only drift from the frozen copy. The README re-pin step is run when Unfold publishes or edits the three source files |
| `gh`/`glab` are missing or logged out | Low | `forge-sync` exits 1, names `gh auth login` / `glab auth login`, writes nothing, and has no fallback |
| `extensions.worktreeConfig=true` changes repo config once | Low | Named on stderr the first time; refused with a remedy when `core.bare`/`core.worktree` are set. It changes only how per-worktree config is read, and the main checkout keeps pushing (T7) |
| Power loss between the commit and the export write | Low | `synchronous=FULL` on event transactions; a lost export row is restored by `export --rebuild` |
| Decision 5's `commit` for `created` (base sha) and `closed` (head at first sight) are this plan's fill-in, not carried verbatim from round 4 | Low | Flagged for the plan reviewer; changing either touches only Decision 5, T5 and T7 text |
| A consumer still testing `task === ''` misses untracked rows after M3 | Low | usagemeter t22b, the only reader, confirmed `null` and also maps `''` to `null` (DRAFT.md Open item 0) |

---

## Review Results

_The read-only reviewer returns evidence; the invoking orchestrator appends a timestamped block here after plan, execution, and PR reviews._

---

## Files to Create/Modify

```
# Group 1
Cargo.toml                                   (new)
Cargo.lock                                   (new)
rust-toolchain.toml                          (new)
.gitignore
biome.json
knip.json
crates/genie-part/                           (new: Cargo.toml, README.md, src/lib.rs, tests/parity.rs)
crates/genie-part/tests/fixtures/rth-tools-part.txt   (new)
crates/genie-tasks/                          (new: Cargo.toml, README.md, src/lib.rs, src/state.rs, src/store.rs,
                                              tests/apply.rs, tests/parallel.rs, tests/export.rs)
crates/genie-tasks/src/export.rs             (new)
crates/genie-forge/                          (new: Cargo.toml, src/lib.rs, src/sync.rs, tests/sync.rs, tests/fixtures/)
crates/genie-rs/                             (new: Cargo.toml, src/main.rs, src/bin/<stdio seam>.rs)
src/term-commands/v5-task.ts
src/term-commands/v5-task.test.ts
src/term-commands/v5-board.test.ts
scripts/build-binary.sh
.github/workflows/build-tarballs.yml
.github/workflows/ci.yml
package.json
scripts/release-docs.test.ts                 (build-script payload checks: genie-rs staged in plugins/)
src/lib/install-promotion.test.ts            (8 INSTALL_PAYLOAD_MEMBERS: add the 0755-after-promotion assertion)

# Group 2
crates/genie-tasks/src/start.rs              (new)
crates/genie-tasks/src/push.rs               (new)
crates/genie-tasks/tests/start.rs            (new)
crates/genie-tasks/src/lib.rs
crates/genie-rs/src/main.rs
src/term-commands/v5-task.ts
src/term-commands/v5-task.test.ts
```
