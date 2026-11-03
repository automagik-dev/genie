# Design: Genie v7 tasks — every piece of agent work is a tracked task, in Rust

| Field | Value |
|-------|-------|
| **Slug** | `genie-v7-tasks` |
| **Date** | 2026-11-02 |
| **WRS** | 100/100 (every load-bearing choice is a Settled id; review round 1's two owner questions answered as R1-26, R1-27) |
| **Size** | G · one wish, two groups: (1) Rust foundation + forge poller → task log, (2) start and push verbs + `gn-<seq>` ids (owner, R1-20) |

<!-- Source: a Settled id (R1-n) in `.genie/brainstorms/genie-v7-tasks/DRAFT.md`, "reviewer HIGH-1" for a recorded round-1 finding, or a backticked repository path that exists. -->

## Problem

Agent work on this machine can't be tied to a task. Workers `cd` between worktrees, branches carry no id, and nothing records when a task started, opened its PR or merged. So the Herdr Space Row's merges, lead-time and first-pass chips show "–", and cost can't be credited to a task (HANDOFF "Gaps today", R1-19).

The owner wants Genie to own the task contract and be rebuilt as Rust crates that later become Unfold parts. Those crates run as short parallel processes on one 128-core machine, with no daemon (R1-4, R1-21..R1-25).

## Scope

### IN

| # | Deliverable | Files changed | Source |
|---|-------------|---------------|--------|
| 1 | **Rust workspace.** A root Cargo workspace with `members = ["crates/*"]`, `resolver = "3"`, `edition = "2024"`, Apache-2.0, exact-pinned dependencies and toolchain `1.94.0`. Toolchain source: `~/workspace/repos/rth/rust-toolchain.toml` (`1.94.0`). Release targets: `aarch64-apple-darwin`, `x86_64-unknown-linux-musl` (shipped for both the `linux-x64-glibc` and `linux-x64-musl` tarballs, since it is static) and `aarch64-unknown-linux-musl`. No OpenSSL and no network crate: forge access goes through `gh`/`glab`. SQLite comes from `rusqlite` with the `bundled` feature. Biome, knip and tsc ignore `crates/` and `target/`. | `Cargo.toml` (new), `rust-toolchain.toml` (new), `.gitignore`, `biome.json`, `knip.json` | R1-22, R1-23 |
| 2 | **`genie-part`: the Unfold part contract, mirrored.** `trait Part { manifest, digest, schema, asks, call }`, `PartManifest { schema, id, version, title, tools: [PartTool { name, effect, description? }] }` and `Effect { None, Reversible, Irreversible }`, field for field as Unfold declares them. A test compares the mirror against a frozen, normalized copy of Unfold's declarations, stored with their source paths (`rth-tools/src/parts.rs`, `authority.rs`, `profile.rs` under `bench/staging/agentd-rc5.13.3/ws/crates/`) and SHA-256. It proves only that the mirror still equals that copy, never that Unfold has not moved. The **re-pin step** (copy, normalize, update the digest, fix the mirror) is documented in the crate README. It runs when Unfold publishes `rth-tools` or changes these files. | `crates/genie-part/` (new), `crates/genie-part/tests/fixtures/rth-tools-part.txt` (new) | R1-24, reviewer MEDIUM-2, MEDIUM-4 |
| 3 | **`genie-tasks`: the state machine and its tables in `genie.db`.** <br>**Pure core:** `enum TaskState`, `enum TaskEvent { Created, Opened, Merged, Closed }`, and `fn apply(state, event) -> Result<state, Refusal>`, with no I/O and an injected clock. <br>**Store:** the per-repo `.genie/genie.db`, resolved exactly as `src/lib/v5/genie-db.ts` does (the main checkout through `git rev-parse --git-common-dir`). It refuses `<GENIE_HOME>/genie.db` like `GlobalDbPathError`, and uses the same pragmas as `src/lib/v5/sqlite-open.ts` (WAL, `busy_timeout`). Rust writes only its own tables, all prefixed `v7_` so none can collide with a TS name (TS already owns `task_events`, `src/lib/v5/genie-db.ts`): `v7_task_events` (append-only, never updated or deleted), `v7_tasks` (current state, including title and lead, keyed by `(project, task_key)`), `v7_task_ids` (the `gn` sequence reservations) and `v7_schema` (its own version row). `PRAGMA user_version` and every TS table stay untouched. `exportState` enumerates its tables by name, so `genie task export`/`sync` never publish the `v7_` tables to `roadmap.json`, and `import --replace` and `deleteTask` never touch them. **Rust never creates `genie.db`:** a missing file, or one at `user_version = 0`, is refused with exit 2 and `run 'genie task list' once in this repository to initialize .genie/genie.db`. TS's `ForeignDbError` would otherwise refuse a file Rust created. <br>**Task key:** `task_key` is the task id when one exists, else `pr:<forge>:<url>` for a PR/MR whose branch carries no task id. Every untracked PR is its own task, and nothing is ever upserted under `''`. A task first seen by forge-sync may start at `opened`, `merged` or `closed` (none → opened, none → merged, none → closed), because it never had a `created` event. The export row keeps `task: ''` plus its `url`, as agreed with usagemeter. <br>**Writes:** each event is one `BEGIN IMMEDIATE` transaction that runs `apply`, inserts the event and upserts the task, with the TS pragmas plus `synchronous=FULL` for these transactions, the one deliberate difference (TS uses NORMAL; both are safe in WAL). Events are a handful per task, so a durable commit costs little. <br>**Dedupe:** `dedupe_key TEXT NOT NULL UNIQUE` is the SHA-256 of the six parts `project, task, event, url, commit, worktree` joined with a NUL byte (`\0`). No part can contain one: Genie-made parts never do, and forge-sync refuses a forge reply with a NUL in any of them (exit 1, nothing written), with `''` for any absent part. So a NULL can never slip past the unique key, and two distinct tuples can never frame to the same bytes. <br>**Lanes:** derived, never stored. created → Working, opened → Review, merged → Merged. | `crates/genie-tasks/` (new) | R1-1, R1-6, R1-25, R1-26, reviewer HIGH-1, HIGH-2, round-2 HIGH-A, HIGH-B, MEDIUM-1, round-3 HIGH-N1, LOW-N4 |
| 4 | **The machine-wide export, `<GENIE_HOME>/tasks.jsonl`.** <br>**Row:** written after each committed event, exactly as agreed with usagemeter: `{v:1, event, project, task, branch, forge, url, type, at, commit, lead, counted, exclude_reason, pushed_after_open}`, plus `dedupe_key`. <br>**Write:** one row is one `write(2)` call on an `O_APPEND` descriptor, and a short write is an error. That is atomic in practice on the local filesystems this targets (APFS, ext4). A home on NFS or SMB is out of scope. Readers tolerate one torn last line. <br>**Rebuild:** the file is an export, not the store. `genie-rs export --rebuild --project <path>…` rewrites the rows of the named projects from their `v7_task_events`. There is no global registry, so the operator names the projects. <br>**Rebuild vs live appends:** every append holds a shared `flock` on `<GENIE_HOME>/tasks.jsonl.lock` around its open and write. Rebuild takes the exclusive lock, copies the other projects' rows, writes the rebuilt rows to a temp file in the same folder, fsyncs it and renames it over `tasks.jsonl`. No append can land on the replaced file. An event committed before the rebuild read but appended after it shows up twice, and readers already dedupe on `dedupe_key`. | `crates/genie-tasks/src/export.rs` (new) | R1-19, R1-25, reviewer MEDIUM-1, MEDIUM-5, round-3 MEDIUM-N2 |
| 5 | **`genie-forge`: the one-shot poller (group 1).** `genie-rs forge-sync [--project <path>]`. <br>**Inputs:** the project defaults to the main checkout of the current folder. The forge comes from the `origin` URL: github.com → `gh api`, otherwise a host `glab` reports as configured (`glab auth status --hostname <host>`) → `glab api`. Access is read-only through the operator's own logged-in CLI, and Genie never reads or stores a token. <br>**Events:** it lists PRs/MRs updated since the last sync and appends `opened`, `merged`, or `closed` for a PR/MR closed WITHOUT merging (a merged GitHub PR, which the forge also marks closed, records `merged` only). <br>**Fields:** `type` comes from the conventional-commit title. Excluded rows get `counted:false` with `exclude_reason` (`docs-memory`, `release`, `version-bump`). `pushed_after_open` is an integer count of commits pushed after the open, null only when the forge cannot say. The task id is parsed from the branch (`^[a-z]+/((?:gh\|gl\|gn)-\d+)-`). A branch without one keys the task by its PR/MR url (row 3). A forge reply with a NUL byte in any dedupe part is refused: exit 1, nothing written. <br>**Cache and cadence:** forge replies are cached for 60 s in `<GENIE_HOME>/cache/forge/<sha256(project)>.json`. Each run is one pass, then exit; callers own the cadence. <br>**Part:** also exposed as a `Part` with tool `forge_sync`, effect `Reversible`. | `crates/genie-forge/` (new) | R1-19, R1-20, R1-24, reviewer MEDIUM-2 |
| 6 | **`genie-rs`: the Rust front door.** One binary, dispatching with hand-rolled `std::env::args` (no clap). Verbs: `forge-sync`, `export --rebuild`, `status <id>` and `list` (both read `v7_tasks`), plus `start` and `push` in group 2. Exit codes: 0 ok, 1 failed, 2 a refusal that changed nothing. Errors go to stderr; `--json` output goes to stdout. A stdio JSON-lines test seam lives in `src/bin/`, following Unfold's `rth-tasks-stdio`. | `crates/genie-rs/` (new) | R1-22, R1-23, reviewer HIGH-1 |
| 7 | **The TS CLI hands these verbs to Rust.** `genie task forge-sync|start|push|v7-status|v7-list` exec `genie-rs` with the tail argv untouched, exactly as `mikro` does: `enablePositionalOptions()` on the `task` group plus `allowUnknownOption()` and `passThroughOptions()` on each of those subcommands (`src/term-commands/mikro.ts`) and return its exit code. The binary is resolved from `GENIE_RS_BIN`, then the installed payload's `plugins/genie-rs/bin/genie-rs`, then `target/release/genie-rs` in a checkout. A missing binary exits 1 with one line naming the fix. As with `mikro`, genie's global options (`-V`/`--version`, `-h`/`--help`, `--no-interactive`) are consumed by the program wherever they appear in the tail; `genie-rs` called directly sees every token. This is the first step of replacing the TS CLI. | `src/term-commands/v5-task.ts`, `src/term-commands/v5-task.test.ts` | R1-22, reviewer LOW-3, round-3 LOW-N5 |
| 8 | **Build, CI and ship.** <br>**Build:** `scripts/build-binary.sh` maps its 4 platforms to the 3 Rust targets (row 1). It builds natively on each tarball runner of `.github/workflows/build-tarballs.yml` (`musl-tools` from apt on the linux runners, `rustup` pinned to 1.94.0 through a SHA-pinned toolchain action, per `action-pins`). It stages `plugins/genie-rs/bin/genie-rs` with mode 0755 inside the existing `plugins` member, so the 8 `INSTALL_PAYLOAD_MEMBERS` stay frozen. <br>**Signing:** `sign-attest.yml` signs the tarball, so the binary is covered unchanged. <br>**CI:** `cargo fmt --check`, `cargo clippy -D warnings` and `cargo test --locked` run on the linux leg and the `unit-darwin` leg. <br>**Local gate:** `bun run check` runs `cargo test --locked` and FAILS with a one-line remedy when `cargo` is missing. It never skips. | `scripts/build-binary.sh`, `.github/workflows/build-tarballs.yml`, `.github/workflows/ci.yml`, `package.json` | R1-22, `src/lib/install-promotion.ts`, reviewer MEDIUM-3 |
| 9 | **Start, push and short ids (group 2).** <br>**Start:** `genie-rs start (<gh-N\|gl-N> \| --title <t>) --lead <bot id> [--type fix\|feat\|docs\|…]`. <br>**(a) Fresh base, race-free:** `git fetch --no-tags --no-write-fetch-head <remote> +refs/heads/<base>:refs/genie/start/<nonce>` in the main checkout. It reads that private ref, peels it to a commit, then deletes it. A delete that loses a `packed-refs.lock` race is retried once and otherwise left behind; the next `start` sweeps `refs/genie/start/*` refs older than 10 minutes. FETCH_HEAD is neither read nor written, so parallel starts cannot race each other. A failed fetch refuses and never falls back to the local HEAD. <br>**(b) Mint the id, tx 1:** an untracked task gets `gn-<seq>`. One short `BEGIN IMMEDIATE` inserts a `v7_task_ids` reservation at max + 1, with no network inside the lock. <br>**(c) Create the worktree:** `git worktree add --no-track -b <type>/<id>-<slug> <repo>.worktrees/<id>-<slug> <base sha>`. <br>**(d) Push lockout:** set `extensions.worktreeConfig=true` once per repo (named on stderr the first time). Per the git docs, that step first refuses with exit 2 and a remedy if the repo's shared config sets `core.bare` or `core.worktree`, which must then move to `config.worktree`. Then `git config --worktree remote.<remote>.pushurl genie-no-push://use-genie-rs-push`, so a plain `git push` from the worktree fails. <br>**(e) Record, tx 2:** the `created` event (task start = worktree created). <br>**(f) Output:** prints `{task, branch, worktree, lead, base_sha}` for `automagik-herdr worker --task <id> --worktree <dir> --lead <bot>`. <br>**Failure:** a failure after (b) marks the reservation abandoned, which leaves a sequence gap. A failure after (c) also removes that worktree and branch. Neither writes a `created` event. <br>**Push:** `genie-rs push` runs inside a task worktree. It pushes `HEAD:refs/heads/<recorded task branch>` to the main checkout's real remote URL, passed as argv and never stored. It refuses any other branch, plus `dev`, `main`, `master` and the recorded base. | `crates/genie-tasks/`, `crates/genie-rs/` | R1-11, R1-14, R1-10, R1-17, R1-27, reviewer HIGH-3, HIGH-4 |

### OUT

- **On-merge actions:** kill the workers, remove the worktree, close the forge issue with a cost and lead-time comment. These become the first reactions, in a later wish subscribed to the `merged` event this wish records (Source: R1-15, R1-2).
- **Reactions to public issue text** wait for lockdown (Source: R1-7).
- **The board mod** (`plugins/genie-herdr`), its feed and the `genie.tasks.waiting` badge: the next wish, reading `v7_tasks` (Source: R1-12, R1-16).
- **Migrating TS cards and verbs to Rust.** Trigger: this wish merged. `genie task list` stays TS until then, and v7 tasks show in `genie task v7-list` (Source: R1-22).
- **A To-do lane from open forge issues.** Trigger: the board wish (Source: R1-1).
- **Cost on the task record:** usagemeter computes cost from Herdr's worker ledger and this export (Source: R1-19).
- **Removing `plugins/genie-dsh`'s coding path:** an open owner question (Source: R1-10).
- **Home directories on NFS/SMB** (Source: reviewer MEDIUM-1).

## Approach

**Zero-daemon.** Genie keeps its rule: every verb is a short process, and the parallelism comes from many processes, not from threads in one server.

**Why SQLite, not a raw log.** A raw log makes every cold start replay the whole file, and leaves cross-process locking to us. SQLite in WAL gives indexed reads, one serialized writer per file and safe access across processes. Event sourcing inside it (the append-only `v7_task_events` beside the derived `v7_tasks`, both in one transaction) keeps the log semantics Unfold uses without the replay cost.

**Spread across files.** The store is the existing per-repo `genie.db`. So 128 cores working across several repositories write to different files, and a card and a task join in one query.

**Locks stay short.** No network call or git command ever runs inside a write lock. `start` fetches into a private ref first, and mints and records in two short transactions.

**Unfold compatibility.** Every crate is a library first, so Unfold can load it later as a part.

**Push safety in code.** Plain `git push` is disabled in a task worktree, and `genie-rs push` is the one route, scoped to the task's own branch. This morning's near push to `dev` through a tracked upstream is exactly the failure it removes.

**Alternatives that lost:**
- **Raw JSONL as the store:** replay on every cold start, and locking by hand (R1-25).
- **A second `.genie/tasks.db`:** two stores per repo with no join (reviewer HIGH-1, R1-26).
- **LMDB or redb:** no queries, or one process at a time (R1-25).
- **A resident poller:** breaks zero-daemon (CLAUDE.md).
- **Unfold's MCP-as-part:** a protocol hop on every call (R1-24).
- **Branch protection as the only push boundary:** unverified until lockdown (R1-27).
- **FETCH_HEAD for the base:** races under parallel starts (reviewer HIGH-3).

## Simplicity Case

- **Simplest complete design:** three library crates and one binary; four Rust-owned tables in the existing per-repo database; one export file; forge access by shelling out to `gh`/`glab`.
- **Added machinery:**
  - The `genie-part` mirror: Unfold compatibility is required now (R1-24).
  - The 60 s forge cache: the Space Row spec's "Forge and CI calls are cached, at most once a minute" (`~/workspace/repos/HERDR-SPACE-ROW-BUILD.md`, R1-19).
  - `dedupe_key`: a re-run must not double-count (R1-19, reviewer HIGH-2).
  - The `v7_task_ids` reservation table: race-free ids without holding a lock across git (reviewer HIGH-3).
  - Per-worktree config: the push lockout (R1-27).
- **Deferred until measured:**
  - **Batching events per transaction.** Trigger: a measured sync that spends more than 1 s in fsync.
  - **A shared writer process.** Trigger: `SQLITE_BUSY` past `busy_timeout` in the 128-process test.
  - **Snapshots of `v7_task_events`.** Trigger: more than 1M events in one repository.
- **Complexity removed:**
  - No HTTP or TLS stack, no tokens and no daemon.
  - No stored lane, no second database, and no FETCH_HEAD dependency.
  - No `created` rows before group 2, so group 1 lead times are an honest "–".

## Decisions

| # | Decision | Rationale | Source |
|---|----------|-----------|--------|
| 1 | Genie owns the task record, the `task=<id>` label, the branch, the worktree and the lead bot; Herdr and usagemeter copy them | One authority for the contract every surface reads | R1-4, R1-17 |
| 2 | Ids are `gh-N`, `gl-N` and a per-repo `gn-<seq>`; the internal `t_…` id never leaves the TS tables | Short and branch-safe, and they match Herdr's `^[a-z0-9][a-z0-9-]{0,40}$` | R1-11, R1-17 |
| 3 | A task starts when its worktree is created; the final numbers are cost and lead time | The owner's metric; grades are not a metric | R1-6 |
| 4 | Rust-owned `v7_` tables inside the per-repo `genie.db`, event-sourced; Rust never creates the file; `tasks.jsonl` is an export | 128 parallel cold-start processes; one database per repo | R1-25, R1-26 |
| 5 | Rust crates that mirror Unfold's part contract and toolchain | The owner: everything in Genie becomes Rust and must fit Unfold | R1-21..R1-24 |
| 6 | The poller is one pass per run; callers own the cadence | Zero-daemon | R1-1, R1-20 |
| 7 | Forge access only through the operator's `gh`/`glab`, read-only | No credential handling in Genie; fits lockdown | R1-7 |
| 8 | Push lockout in code: plain `git push` fails in a task worktree; `genie-rs push` reaches only the task's own branch | The owner chose enforcement in code over forge-side protection | R1-27, R1-10 |
| 9 | The binary ships inside the existing `plugins` payload member | The 8 top-level members are frozen for older updaters | `src/lib/install-promotion.ts` |
| 10 | Worktrees at `<repo>.worktrees/<id>-<slug>`, not `GENIE_WORKTREES_DIR` | The owner's task layout; `GENIE_WORKTREES_DIR` is the doctor/review-snapshot base | HANDOFF decision 1, reviewer LOW-1 |

## Risks & Assumptions

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| 1 | A busy repository serializes its writers behind SQLite's one writer | Medium | Short `BEGIN IMMEDIATE` transactions with no I/O inside, plus `busy_timeout`. T4 proves 128 parallel writers to one repository, with no lost or duplicated event |
| 2 | TS and Rust share one `genie.db` file | Medium | Disjoint `v7_` tables, Rust's own `v7_schema` version, `user_version` never written by Rust, and Rust refusing a missing or version-0 file. Same pragmas except `synchronous=FULL` on Rust's event transactions. T9 proves both init orders |
| 3 | Unfold's `Part` trait changes before it is published | Medium | The test catches only drift from the frozen copy. The README re-pin step is run when Unfold publishes or edits the three source files |
| 4 | `gh`/`glab` are missing or logged out | Low | `forge-sync` exits 1, names `gh auth login` / `glab auth login`, writes nothing, and has no fallback |
| 5 | `extensions.worktreeConfig=true` changes repo config once | Low | Named on stderr the first time; refused with a remedy when `core.bare`/`core.worktree` are set. It changes only how per-worktree config is read, and the main checkout keeps pushing (T7; proven by the round-2 reviewer on git 2.50.1) |
| 6 | Power loss between the commit and the export write | Low | `synchronous=FULL` on event transactions; a lost export row is restored by `export --rebuild` |

## Success Criteria

- [ ] **T1 workspace:** `cargo test --workspace --locked` and `cargo clippy -D warnings` pass on the linux and darwin CI legs, and each tarball runner builds its Rust target. **Proof:** `.github/workflows/ci.yml`, `.github/workflows/build-tarballs.yml`.
- [ ] **T2 part parity:** the mirror's `Part`, `PartManifest` and `Effect` match the frozen Unfold copy; changing one field on either side fails the test. **Proof:** `crates/genie-part/tests/parity.rs`.
- [ ] **T3 state machine:**
  - Accepted: created→opened→merged and opened→closed.
  - Accepted for a task with no `created` event: none→opened, none→merged and none→closed.
  - Two untracked PRs in one project get two `task_key`s (`pr:<forge>:<url>`), and neither ever refuses the other's events.
  - Refused: merged→opened, merged→closed, and a second created.
  - A repeated identical event is a no-op.
  - Lanes derive as Working, Review and Merged.
  - **Proof:** `crates/genie-tasks/tests/apply.rs`.
- [ ] **T4 128 writers:** 128 processes append distinct events to one repository's `genie.db` at once.
  - Every event lands exactly once.
  - `v7_tasks` equals a replay of `v7_task_events`.
  - `tasks.jsonl` holds each row once, with no torn line.
  - **Proof:** `crates/genie-tasks/tests/parallel.rs`.
- [ ] **T5 forge-sync:** a fake `gh` on PATH serves canned PRs.
  - **First run:** appends opened, merged and closed rows with the right `type`, `counted` and `exclude_reason`.
  - **`pushed_after_open`:** 0 and 2 cases.
  - **Task ids:** taken from the branch. An untracked branch is keyed by its PR url, and its export row carries `task: ''`.
  - **Two untracked PRs in a row:** PR A opens and merges, then PR B opens and merges. That yields four rows and two `v7_tasks` rows, with no refusal.
  - **First seen merged:** a PR that opened and merged between two syncs yields one `merged` row.
  - **NUL:** a canned PR with a NUL in its url or head commit exits 1 and writes nothing.
  - **Merged PRs:** a merged PR the forge also marks closed yields only `merged`.
  - **Repeats:** a second run, including the untracked-branch PR, appends nothing.
  - **Cache:** a run within 60 s makes no forge call.
  - **GitLab:** a fake `glab` on a non-github host gives the same results.
  - **Missing CLI:** a missing `gh` exits 1 and writes nothing.
  - **Proof:** `crates/genie-forge/tests/sync.rs`.
- [ ] **T6 front door:** `genie task forge-sync --project <fixture> --json` runs `genie-rs` with `--json` intact and returns its exit code. With no binary it exits 1 and names the fix. **Proof:** `src/term-commands/v5-task.test.ts`.
- [ ] **T7 start and push (group 2):**
  - **Fresh base:** upstream `dev` is one commit ahead of the local `dev`. `start --title "sync hangs" --lead b-x` creates `fix/gn-1-sync-hangs` at the upstream tip, in `<repo>.worktrees/gn-1-sync-hangs`, with no upstream.
  - **Records:** it writes one `created` event and one export row, and writes no FETCH_HEAD. Any `refs/genie/start/*` ref it leaves behind is swept by the next start.
  - **Parallel ids:** 32 parallel starts mint 32 distinct `gn` ids and 32 worktrees.
  - **Push routes:** a plain `git push` from the worktree exits non-zero. `genie-rs push` reaches the fixture's bare remote. Pushing another branch, or any of `dev`, `main`, `master`, is refused. The main checkout can still push.
  - **Failure cleanup:** a failed fetch leaves no worktree, branch or event.
  - **Proof:** `crates/genie-tasks/tests/start.rs`.
- [ ] **T8 payload:** the built tarball carries `plugins/genie-rs/bin/genie-rs` for its platform, with mode 0755 after promotion, and still exactly the 8 top-level members. **Proof:** the existing payload-member test in `scripts/` plus a new mode assertion.
- [ ] **T9 shared database, both init orders:** TS initializes first and Rust adds its `v7_` tables, or Rust is run first and refuses with exit 2 and the init remedy, leaving no file behind. In both orders, the existing TS task, board, export, import `--replace`, delete and `doctor` tests then pass unchanged, `roadmap.json` gains nothing, and the `v7_` rows survive `import --replace`. **Proof:** `src/term-commands/v5-task.test.ts`, `src/term-commands/v5-board.test.ts`.
- [ ] **T10 rebuild:** after deleting `tasks.jsonl`, `export --rebuild --project <fixture>` restores its rows exactly, and other projects' rows are left alone. **Concurrent appends:** a rebuild run while 16 processes append leaves every committed event in the file at least once, and exactly once after deduping on `dedupe_key`. **Proof:** `crates/genie-tasks/tests/export.rs`.

## Next Step

After an independent design review returns SHIP, persist the evidence below and verify its content digest before running `wish`.

<!-- genie-design-review:start -->
## Design Review Evidence

- **Verdict:** SHIP
- **Reviewed content SHA-256:** `b28c3c09f133cfe9adee7d504ba33894a2b0b21ba4508a64e398ed1a8edde7f5`
- **Reviewer:** claude-fable-5-1
- **Reviewed at:** 2026-11-03T03:10:30.000Z
<!-- genie-design-review:end -->
