# Genie v5 State Taxonomy

The v5 "lightweight body": **documents live in git, operational state lives in
`.genie/genie.db`**. Zero daemons, zero Postgres, zero background services. A CLI
invocation opens the SQLite file, runs one transaction, and exits.

## Documents-in-git vs state-in-genie.db

| Concern | Home | Rationale |
|---------|------|-----------|
| Wishes, designs, skills, runbooks (`.md`) | git (`.genie/wishes/**`, `.genie/**/*.md`) | Human-authored, review-worthy, diffable, mergeable. Belong in PRs. |
| Task rows, dependency edges, checkout claims, stage log, board membership, wish-group execution state | `.genie/genie.db` (SQLite, WAL) | High-churn operational state. Would create merge conflicts and noisy diffs if versioned. Never committed. |

The database is **never** git-versioned. `.gitignore` excludes `genie.db`,
`genie.db-wal`, and `genie.db-shm`. Losing the DB loses *runtime* state (what is
in progress, who claimed what) but never loses *intent* — that is recoverable
from the committed documents.

## `.genie/` layout

```
.genie/
  genie.db              # SQLite state engine (WAL) — gitignored
  genie.db-wal          # WAL sidecar — gitignored
  genie.db-shm          # shared-memory index — gitignored
  wishes/<slug>/WISH.md  # committed documents (git)
  ...                    # other committed docs
```

### Worktree sharing

All linked worktrees of a repository share **one** `genie.db`. The path is
resolved from `git rev-parse --path-format=absolute --git-common-dir`, whose
parent directory is the main repo root regardless of which worktree the CLI runs
in. Task created in worktree A is immediately visible in worktree B with no
daemon and no sync step — SQLite's single-file store is the shared medium.

## ID scheme

| Entity | Prefix | Example | Generation |
|--------|--------|---------|------------|
| Task | `t_` | `t_lr8x0k2a3f9c` | `t_` + base36(epoch-ms) + 6 random base36 chars |
| Board | `b_` | `b_lr8x0k2q1w8e` | `b_` + base36(epoch-ms) + 6 random base36 chars |
| Wish group | — | `(wish, name)` | Natural key: `(wish slug, group name)` |
| Stage-log entry | integer | `1, 2, 3…` | SQLite `AUTOINCREMENT` rowid |

Time-prefixed IDs sort chronologically; the random suffix removes cross-process
collision risk without a shared counter (no extra write, no lock).

## Schema reference (`user_version = 1`)

`PRAGMA user_version = 1` is the authoritative "this is a genie-v5 database"
marker. All timestamps are epoch milliseconds (`INTEGER`).

### `meta`
Key/value store for database-level metadata (wish-group signatures, markers).

| Column | Type | Notes |
|--------|------|-------|
| `key` | TEXT PK | e.g. `wish_sig:<slug>` |
| `value` | TEXT NOT NULL | opaque string |

### `boards`
Named grouping for tasks.

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | `b_…` |
| `name` | TEXT NOT NULL UNIQUE | |
| `created_at` | INTEGER NOT NULL | |

### `tasks`
Generic unit of work with checkout-claim + ready-set semantics.

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | `t_…` |
| `board_id` | TEXT | nullable FK → `boards(id)` ON DELETE SET NULL |
| `title` | TEXT NOT NULL | |
| `status` | TEXT NOT NULL | `blocked` \| `ready` \| `in_progress` \| `done` |
| `claimed_by` | TEXT | worker holding the checkout, or NULL |
| `claimed_at` | INTEGER | epoch-ms of claim, or NULL |
| `created_at` | INTEGER NOT NULL | |
| `updated_at` | INTEGER NOT NULL | |

### `task_dependencies`
Directed edges: `task_id` depends on `depends_on_id`.

| Column | Type | Notes |
|--------|------|-------|
| `task_id` | TEXT NOT NULL | FK → `tasks(id)` ON DELETE CASCADE |
| `depends_on_id` | TEXT NOT NULL | FK → `tasks(id)` ON DELETE CASCADE |
| — | PRIMARY KEY (`task_id`, `depends_on_id`) | |

Cycles are rejected at **insertion** time (see Concurrency rules).

### `stage_log`
Append-only audit trail of stage transitions per task.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK AUTOINCREMENT | |
| `task_id` | TEXT NOT NULL | FK → `tasks(id)` ON DELETE CASCADE |
| `stage` | TEXT NOT NULL | |
| `note` | TEXT | nullable |
| `created_at` | INTEGER NOT NULL | |

There is no update or delete API for this table — it only grows.

### `wish_groups`
Execution state machine for a wish's groups. Natural key `(wish, name)`.

| Column | Type | Notes |
|--------|------|-------|
| `wish` | TEXT NOT NULL | slug |
| `name` | TEXT NOT NULL | group name |
| `status` | TEXT NOT NULL | `blocked` \| `ready` \| `in_progress` \| `done` |
| `depends_on` | TEXT NOT NULL | JSON array of group names, default `[]` |
| `assignee` | TEXT | nullable |
| `started_at` | INTEGER | nullable |
| `completed_at` | INTEGER | nullable |
| `created_at` | INTEGER NOT NULL | |
| `updated_at` | INTEGER NOT NULL | |
| — | PRIMARY KEY (`wish`, `name`) | |

The **drift-guard signature** for a wish is stored in `meta` under
`wish_sig:<slug>` — a SHA-256 of the group names + sorted `dependsOn` per group
(prose changes to WISH.md do not flip it). Re-running against a drifted plan
throws `WishGroupDriftError`.

## Concurrency rules

- **WAL mode** (`PRAGMA journal_mode = WAL`): concurrent readers never block the
  single writer; the writer never blocks readers.
- **`busy_timeout`** (`PRAGMA busy_timeout = 5000`): a writer that finds the
  write lock held waits up to 5s for it rather than immediately failing with
  `SQLITE_BUSY`. This turns lock contention into a clean serialized outcome —
  concurrent claimants surface as **claim conflicts**, not `SQLITE_BUSY` flake.
- **Transaction per mutation**: every state-changing operation runs inside a
  single transaction. The atomic checkout claim uses `BEGIN IMMEDIATE` so the
  write lock is taken up front and the read-modify-write cannot interleave.
- **Checkout claim semantics**: claiming a task is a conditional `UPDATE`
  (`… WHERE id = ? AND (status = 'ready' OR stale)`) guarded so that exactly one
  concurrent claimant matches (`changes === 1`) and transitions the task to
  `in_progress`; every loser matches zero rows and receives a typed
  `CheckoutConflictError`. No advisory locks, no coordinator.
- **Stale-claim expiry**: a task stuck `in_progress` whose `claimed_at` is older
  than the stale threshold (default 15 min) is eligible for re-claim by another
  worker, so a crashed claimant cannot deadlock the task forever.
- **Ready-set recompute** is idempotent and monotonic: a `blocked` task whose
  every dependency is `done` transitions to `ready`; the operation never moves a
  task backward (`ready`/`in_progress`/`done` are never demoted), so it is safe
  to run repeatedly.
- **Foreign / malformed refusal**: opening a non-SQLite file raises
  `MalformedDbError`; opening a SQLite file whose `user_version` is neither `0`
  (fresh/uninitialized) nor `1` (ours), or an unversioned file that already
  holds foreign tables, raises `ForeignDbError`. The engine never mutates a
  database it does not recognize.
