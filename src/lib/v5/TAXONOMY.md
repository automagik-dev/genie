# Genie v5 State Taxonomy

The v5 "lightweight body": **documents live in git, operational state lives in
`.genie/genie.db`**. Zero daemons, zero Postgres, zero background services. A CLI
invocation opens the SQLite file, runs one transaction, and exits.

## Documents-in-git vs state-in-genie.db

| Concern | Home | Rationale |
|---------|------|-----------|
| Wishes, designs, brainstorms (`.md`) | git (`.genie/wishes/<slug>/`, `.genie/brainstorms/<slug>/`) | Human-authored, review-worthy, diffable, mergeable. Belong in PRs. |
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
  INDEX.md              # planning index — tracked
  wishes/<slug>/        # WISH.md + per-wish evidence (qa.md, …) — tracked
  brainstorms/<slug>/   # DESIGN.md / DRAFT.md / COUNCIL.md — tracked
```

`.genie/` holds both the tracked planning documents (wishes, designs,
brainstorms — genie's own taxonomy, versioned in git and reviewed in PRs) and
the untracked runtime state. Runtime state — the SQLite engine (`genie.db` and
its sidecars) plus legacy v4 state paths — is gitignored; the markdown
documents are committed.

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
| `wish` | TEXT | the lifecycle slug this task tracks, or NULL (see below) |
| `group_name` | TEXT | wish-group this task belongs to, or NULL |
| `created_at` | INTEGER NOT NULL | |
| `updated_at` | INTEGER NOT NULL | |

Plus the **runtime layer** — additive, all nullable, backfilled in place by
`ensureTaskColumns` so they stay within `user_version = 1`:

| Column | Type | Notes |
|--------|------|-------|
| `lane` | TEXT | lifecycle lane on a lane-defining board, or NULL |
| `agent_kind` | TEXT | authored runtime identity, or NULL |
| `heartbeat_at` | INTEGER | last liveness pulse, or NULL |
| `blocked_by` | TEXT | who placed the enforced block — NULL means unblocked |
| `blocked_reason` | TEXT | why, free prose |
| `block_kind` | TEXT | `work` \| `hold`; NULL/absent/unrecognized ⇒ `work` |

**`block_kind` distinguishes a broken card from a parked one.** `work` (the
default) means something must be resolved; `hold` means the work is fine and is
deliberately not to be picked up yet. The kind is **descriptive only** — a `hold`
refuses `task checkout` exactly as a `work` block does, because the carved
checkout exception reads `blocked_by`, never the kind. `genie task block --hold`
records a hold; plain `block` records `work`; `unblock` clears provenance,
reason, and kind together. Stored kinds are untrusted TEXT (a hand-merged
`roadmap.json` reaches the mapper unvalidated), so anything but exactly `hold`
normalizes to `work` at read time rather than at the column.

**`tasks.wish` is the lifecycle slug a card tracks — broadened semantic.** It is
no longer "the WISH.md slug once a wish exists"; it is the single stable slug
for a line of work, **valid from the moment the `.genie/brainstorms/<slug>/`
directory is created**, long before any `WISH.md`. One slug threads a card from
Idea → Brainstorm → Wish → Work → Review → Done. This is what lets the roadmap
board be the single tracker: the `jar: index-lane drift` doctor check joins a
hand-written `.genie/INDEX.md` entry to its roadmap card `WHERE tasks.wish =
slug` and lint-checks the card's lane against the INDEX section. A card may
carry a `wish` slug while still sitting in an early lane; the slug is an
identity, not a claim that a wish document exists yet.

**The identity is mutable in place.** `genie task set-wish <id> --wish <slug>
[--group <name>]` attaches or re-points a card's slug, and `--clear` sheds it;
`setTaskWish` writes only `wish`, `group_name`, and `updated_at`, so `id`,
`created_at`, and any live checkout claim survive untouched — a card that
outgrows its original framing is never deleted and recreated (which would break
every reference to its id and lose its timeline). Slugs are unvalidated TEXT,
exactly as `createTask` treats them; `--group` requires `--wish` in both verbs.
A group name only means something under the wish it was declared in, so the new
identity is taken whole: a wish change carries only the group given with it, and
clearing the wish clears the group too. Each change appends a `wish` event
(`old→new`, rendered as `slug#group`, `slug`, or `(none)`) to the card timeline
that `task status` prints, and the columns ride `task export` / `import` /
`sync` like any other task field.

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

## Row projections — which shapes carry the runtime layer

The runtime columns above exist in one table but are exposed by three deliberately
different projections. Which one a caller maps through IS the contract:

| Projection | Adds | Serialized by |
|------------|------|---------------|
| `TaskRow` | — (frozen) | laneless board `--json`, MCP tools, `task export` tasks |
| `LaneTaskRow` | `lane`, `enforcedBlock` | lane-grouped board `--json` |
| `TaskCardRow` | `agentKind`, `heartbeatAt`, `blockedBy`, `blockedReason` | nothing — human render + `task status` only |

`TaskRow` is **frozen**: its key set is asserted byte-for-byte by test, and no
runtime field may ever be added to it. `TaskCardRow` is the widest projection but
is never serialized — it feeds badge rendering, so widening it is safe.

`LaneTaskRow.enforcedBlock` is the one deliberate runtime field on a serialized
additive shape: `null` when the card is unblocked, otherwise
`{ reason: string, kind: 'work' | 'hold' }`. A lane-board consumer must be able to
tell a parked card from a live one, which the lane grouping alone cannot express;
block *provenance*, identity, and heartbeat stay off that path. Presence is keyed
on `blocked_by` — the same column the checkout gate reads — so the serialized
field can never disagree with whether checkout is actually refused; a row blocked
without a stored reason projects an empty reason rather than dropping the block.

`block_kind` travels in `task export` / `import` / `sync` within
`schemaVersion: 1`. Because the column is additive and nullable, a same-version
snapshot written by an older build may omit the key entirely; the import inserts
NULL for it and the row reads back as a `work` block.
