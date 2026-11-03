# genie-tasks

Genie's v7 task record, as a library: the pure state machine, its Rust-owned tables in the per-repo
`.genie/genie.db`, and the machine-wide `<GENIE_HOME>/tasks.jsonl` export usagemeter reads. Licensed
Apache-2.0. It also owns the `start` and `push` verbs (below); the `genie-rs` binary dispatches
`forge-sync`, `export --rebuild`, `status`, `list`, `start` and `push` over it.

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
counted, exclude_reason, pushed_after_open, dedupe_key}`. `task` is JSON `null` for a PR with no task id, and
`pushed_after_open` is JSON `null` when the forge cannot say (a known `0` stays `0`).
Each append holds a shared lock on `tasks.jsonl.lock` and makes one `write(2)` on an `O_APPEND`
descriptor. `export::rebuild(genie_home, projects)` takes the exclusive lock, only then reads each
project's events, keeps every other project's rows, and replaces the file by temp + fsync + rename. An
event committed before that read but appended after the rename appears twice; readers dedupe on
`dedupe_key`. The locks are `std::fs::File::lock_shared` / `File::lock`; no crate.

## Start and push

`start(repo, genie_home, opts, notes)` never defaults to the current directory. Before any fetch it
refuses (exit 2, nothing written) an id whose task is `opened` or `merged`, a shared config with
`core.bare = true` or `core.worktree`, and a request with no title to name the branch (an id falls back
to its recorded title). The base is a local `dev`, else `origin/HEAD`'s branch, as
`src/lib/v5/base-state.ts` resolves it, and it is always fetched:

1. `git fetch --no-tags --no-write-fetch-head --refmap= origin +refs/heads/<base>:refs/genie/start/<secs>-<pid>-<n>`,
   peeled, then deleted (one retry; a leftover older than 10 minutes is swept by the next start). A failed
   fetch exits 1 and never falls back to a local ref.
2. An id-less task reserves `gn-<seq>` in one short `BEGIN IMMEDIATE` (`Store::reserve_gn`).
3. `git worktree add --no-track -b <type>/<id>-<slug> <repo>.worktrees/<id>-<slug> <base sha>`.
4. `extensions.worktreeConfig=true` once per repository (one line on `notes`), then per worktree
   `remote.origin.pushurl = genie-no-push://use-genie-rs-push` and `genie.base = <base>`.
5. The `created` event, `commit` = the base sha.

A failure after 2 abandons the reservation (the gap stays); after 3 it also removes the worktree and
branch; neither writes an event. A git failure that names another start's work in flight (a
`refs/genie/start/` ref, a half-written `.git/worktrees/<name>/commondir`) is retried a few times, which
is what lets 32 starts run at once.

`push(dir, genie_home, branch)` finds the task by the `created` event whose worktree contains `dir`, and
pushes `HEAD:refs/heads/<recorded branch>` to the main checkout's `git remote get-url --push origin`,
passed as argv. It refuses (exit 2) a requested or checked-out branch that is not the recorded one, or
is `dev`, `main`, `master` or the recorded base.
