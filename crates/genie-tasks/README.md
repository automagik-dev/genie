# genie-tasks

Genie's v7 task record, as a library: the pure state machine, its Rust-owned tables in the per-repo
`.genie/genie.db`, and the machine-wide `<GENIE_HOME>/tasks.jsonl` export usagemeter reads. Licensed
Apache-2.0. The `genie-rs` verbs over it (`forge-sync`, `export --rebuild`, `status`, `list`, `start`,
`push`) arrive in later groups of the `genie-v7-tasks` wish.

## State machine

`apply(state, event, clock) -> Result<TaskState, Refusal>` has no I/O; the clock is injected and only a
refusal reads it. A task's state is named after its last event. The whole table (rows: state before,
columns: event):

| state \ event | created | opened | merged | closed |
|---|---|---|---|---|
| none | created | opened | merged | closed |
| created | refused | opened | merged | closed |
| opened | refused | refused | merged | closed |
| merged | refused | refused | refused | refused |
| closed | created | refused | refused | refused |

- A task first seen by forge-sync starts at whatever the forge reports, since it never had a `created`.
- `created` is refused while the task is at `created`, `opened` or `merged`, so an id whose PR is open or
  merged cannot be started. A PR closed without merging can: `closed -> created` is accepted.
- `merged` is final. `closed` is final for forge events, so a reopened PR's `merged` is refused and
  forge-sync skips and reports it.
- Lanes are derived, never stored: created -> Working, opened -> Review, merged -> Merged,
  closed -> Closed.

## Store

`open_store(repo)` resolves the main checkout through `git rev-parse --git-common-dir`, exactly as
`src/lib/v5/genie-db.ts` does, and opens its `.genie/genie.db` without the create flag. It refuses, with
exit code 2 and nothing written: a missing file or one at `user_version = 0` (`run 'genie task list' once
in this repository to initialize .genie/genie.db`), and `<GENIE_HOME>/genie.db`. Pragmas are
`sqlite-open.ts`'s (`busy_timeout` 5000, WAL, `foreign_keys`) with `synchronous=FULL`, and a contended
lock is retried on the same schedule.

Rust writes only the four `v7_` tables in `src/schema.sql`, created on first open when `v7_schema` has no
version row. `PRAGMA user_version` and every TS table stay untouched, and TS names its tables when it
exports, imports or deletes, so the `v7_` rows never reach `roadmap.json`. The TS tests seed the same
file with `readFileSync`.

`record(store, store.project(), row)` runs one `BEGIN IMMEDIATE` transaction: skip an event whose
`dedupe_key` is already recorded (a no-op, `Recorded::Duplicate`), `apply`, insert into
`v7_task_events`, upsert `v7_tasks`. It then appends one export row. A refusal writes nothing.

- `task_key` is the task id, or `pr:<forge>:<url>` for a PR/MR whose branch carries none.
- `dedupe_key` is the SHA-256 of `project, task, event, url, commit, worktree` joined with NUL, `''` for
  an absent part; a NUL in any part is refused (exit 1).
- `commit` per event: created = the base sha, opened = the first head seen, merged = the merge sha,
  closed = the head at the sync that first sees the PR closed.
- `title` rides on the event row as well as `v7_tasks`, so `v7_tasks` is always a replay of the events.

`Error::exit_code()` maps every failure onto Decision 4: 2 for a refusal that changed nothing, 1 for
anything else, external input included.

## Export

One row per committed event: `{v, event, project, task, branch, forge, url, type, at, commit, lead,
counted, exclude_reason, pushed_after_open, dedupe_key}`. `task` is JSON `null` for a PR with no task id.
Each append holds a shared lock on `tasks.jsonl.lock` and makes one `write(2)` on an `O_APPEND`
descriptor. `export::rebuild(genie_home, projects)` takes the exclusive lock, only then reads each
project's events, keeps every other project's rows, and replaces the file by temp + fsync + rename. An
event committed before that read but appended after the rename appears twice; readers dedupe on
`dedupe_key`. The
locks are `std::fs::File::lock_shared` / `File::lock`; no crate.
