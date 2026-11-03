//! The store: Rust-owned `v7_` tables inside the per-repo `.genie/genie.db` that TS creates.
//!
//! Resolution follows `src/lib/v5/genie-db.ts`: the main checkout through
//! `git rev-parse --git-common-dir`, falling back to the given directory outside git. The store
//! never creates `genie.db`, refuses a version-0 file and `<GENIE_HOME>/genie.db`, uses the
//! pragmas of `src/lib/v5/sqlite-open.ts` with `synchronous=FULL` as the one difference, and writes
//! nothing but its own tables.

use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread::sleep;
use std::time::Duration;

use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use sha2::{Digest, Sha256};

use crate::export;
use crate::state::{Clock, Refusal, SystemClock, TaskEvent, TaskState, apply};

/// The DDL and the `v7_schema` version row, shared with the TS T9 fixtures.
pub const SCHEMA_SQL: &str = include_str!("schema.sql");
/// The `v7_schema` version this build writes.
pub const SCHEMA_VERSION: i64 = 1;
/// `src/lib/v5/sqlite-open.ts` `BUSY_TIMEOUT_MS`.
pub const BUSY_TIMEOUT: Duration = Duration::from_millis(5_000);
/// `sqlite-open.ts` `BUSY_RETRY_DELAYS_MS`: paces the rare straggler that outlives busy_timeout.
const BUSY_RETRY_MS: [u64; 5] = [25, 50, 100, 200, 400];
/// The remedy DESIGN.md row 3 names for a missing or uninitialized database.
pub const INIT_REMEDY: &str = "run 'genie task list' once in this repository to initialize .genie/genie.db";

#[derive(Debug)]
pub enum Error {
    /// `apply` refused the event; nothing was written.
    Refused(Refusal),
    /// No `.genie/genie.db` in the main checkout; nothing was created.
    NoDatabase(PathBuf),
    /// `genie.db` exists at `user_version = 0`; it was left untouched.
    Uninitialized(PathBuf),
    /// The path names `<GENIE_HOME>/genie.db`, the machine-scope database.
    GlobalDatabase(PathBuf),
    /// `v7_schema` carries a version this build does not know.
    NewerSchema {
        path: PathBuf,
        version: i64,
    },
    /// The event cannot be recorded as given (a NUL in a dedupe part, an untracked PR with no url).
    InvalidEvent(String),
    /// The event committed, but its `tasks.jsonl` row was not written; `export --rebuild` restores it.
    Export {
        seq: i64,
        source: io::Error,
    },
    Db(rusqlite::Error),
    Io(io::Error),
}

impl Error {
    /// Decision 4: 2 is a refusal that changed nothing, 1 every other failure.
    pub fn exit_code(&self) -> i32 {
        match self {
            Error::Refused(_)
            | Error::NoDatabase(_)
            | Error::Uninitialized(_)
            | Error::GlobalDatabase(_)
            | Error::NewerSchema { .. } => 2,
            Error::InvalidEvent(_) | Error::Export { .. } | Error::Db(_) | Error::Io(_) => 1,
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Refused(r) => write!(f, "{r}"),
            Error::NoDatabase(p) => {
                write!(f, "no Genie database at {}: {INIT_REMEDY}", p.display())
            }
            Error::Uninitialized(p) => {
                write!(f, "{} is not initialized (user_version = 0): {INIT_REMEDY}", p.display())
            }
            Error::GlobalDatabase(p) => write!(
                f,
                "refusing {}: that file is GENIE_HOME/genie.db, the machine-scope database; run the command from inside a repository",
                p.display()
            ),
            Error::NewerSchema { path, version } => {
                write!(f, "{} has v7 schema {version}, newer than this build's {SCHEMA_VERSION}", path.display())
            }
            Error::InvalidEvent(why) => write!(f, "invalid event: {why}"),
            Error::Export { seq, source } => {
                write!(
                    f,
                    "event {seq} committed but its tasks.jsonl row was not written ({source}); run export --rebuild"
                )
            }
            Error::Db(e) => write!(f, "genie.db: {e}"),
            Error::Io(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for Error {}

impl From<rusqlite::Error> for Error {
    fn from(e: rusqlite::Error) -> Self {
        Error::Db(e)
    }
}

impl From<io::Error> for Error {
    fn from(e: io::Error) -> Self {
        Error::Io(e)
    }
}

/// An event to record. Absent text parts are `''`; `at` defaults to the store's clock.
#[derive(Debug, Clone)]
pub struct EventRow {
    pub task: String,
    pub event: TaskEvent,
    pub forge: String,
    pub url: String,
    pub branch: String,
    /// Decision 5: created = base sha, opened = first head seen, merged = merge sha, closed = head
    /// at the sync that first sees it closed.
    pub commit: String,
    pub worktree: String,
    /// The conventional-commit type (`type` in the tables and the export).
    pub kind: String,
    pub title: String,
    pub lead: String,
    pub at: Option<String>,
    pub counted: bool,
    pub exclude_reason: String,
    /// Commits pushed after the PR opened; `None` when the forge cannot say.
    pub pushed_after_open: Option<i64>,
}

impl EventRow {
    pub fn new(event: TaskEvent) -> EventRow {
        EventRow {
            task: String::new(),
            event,
            forge: String::new(),
            url: String::new(),
            branch: String::new(),
            commit: String::new(),
            worktree: String::new(),
            kind: String::new(),
            title: String::new(),
            lead: String::new(),
            at: None,
            counted: true,
            exclude_reason: String::new(),
            pushed_after_open: None,
        }
    }

    /// The task id, or `pr:<forge>:<url>` for a PR/MR whose branch carries none.
    pub fn task_key(&self) -> Result<String, Error> {
        task_key(&self.task, &self.forge, &self.url)
            .ok_or_else(|| Error::InvalidEvent("an event with no task id needs its forge and url".into()))
    }
}

/// The key a task's rows share: its id, or `pr:<forge>:<url>` when it has none.
pub fn task_key(task: &str, forge: &str, url: &str) -> Option<String> {
    if !task.is_empty() {
        Some(task.to_string())
    } else if !forge.is_empty() && !url.is_empty() {
        Some(format!("pr:{forge}:{url}"))
    } else {
        None
    }
}

/// SHA-256 of the six parts joined with NUL, `''` for an absent part.
pub fn dedupe_key(project: &str, task: &str, event: TaskEvent, url: &str, commit: &str, worktree: &str) -> String {
    lifecycle_dedupe_key(project, task, event, url, commit, worktree, 0)
}

/// The key of an event in lifecycle `generation` (R1-32): a `created` event's generation is the
/// number of `closed` events its task already has, so a task restarted after its PR closed gets a
/// new key even at the same base and worktree, while a retry inside one lifecycle keeps its key.
/// Generation 0 adds no part, so every key of the first lifecycle is the six-part key unchanged.
pub fn lifecycle_dedupe_key(
    project: &str,
    task: &str,
    event: TaskEvent,
    url: &str,
    commit: &str,
    worktree: &str,
    generation: i64,
) -> String {
    let mut framed = [project, task, event.as_str(), url, commit, worktree].join("\0");
    if generation > 0 {
        framed.push('\0');
        framed.push_str(&generation.to_string());
    }
    Sha256::digest(framed.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// One `v7_task_events` row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredEvent {
    pub seq: i64,
    pub project: String,
    pub task_key: String,
    pub task: String,
    pub event: TaskEvent,
    pub forge: String,
    pub url: String,
    pub branch: String,
    pub commit: String,
    pub worktree: String,
    pub kind: String,
    pub title: String,
    pub lead: String,
    pub at: String,
    pub counted: bool,
    pub exclude_reason: String,
    pub pushed_after_open: Option<i64>,
    pub dedupe_key: String,
}

/// One `v7_tasks` row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskRow {
    pub project: String,
    pub task_key: String,
    pub task: String,
    pub state: TaskState,
    pub title: String,
    pub lead: String,
    pub forge: String,
    pub url: String,
    pub branch: String,
    pub last_seq: i64,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Recorded {
    Appended {
        seq: i64,
        dedupe_key: String,
        state: TaskState,
    },
    /// The identical event is already recorded: a no-op, with no export row.
    Duplicate {
        dedupe_key: String,
    },
}

/// Where a project's database is, resolved and checked but not opened.
#[derive(Debug, Clone)]
pub struct Location {
    /// The canonical main-checkout path: the `project` of every row.
    pub project: String,
    pub db_path: PathBuf,
}

/// `<GENIE_HOME>`, as `src/lib/genie-home.ts` resolves it (an empty value counts as unset).
pub fn genie_home() -> PathBuf {
    match std::env::var_os("GENIE_HOME") {
        Some(home) if !home.is_empty() => PathBuf::from(home),
        _ => PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".genie"),
    }
}

/// The main checkout that owns `repo`'s `.genie/`, canonical. Runs git; never call it under a lock.
pub fn project_root(repo: &Path) -> Result<PathBuf, Error> {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["rev-parse", "--path-format=absolute", "--git-common-dir"])
        .output();
    let root = match out {
        Ok(o) if o.status.success() => {
            let common = PathBuf::from(String::from_utf8_lossy(&o.stdout).trim());
            common.parent().map_or_else(|| repo.to_path_buf(), Path::to_path_buf)
        }
        _ => repo.to_path_buf(),
    };
    Ok(fs::canonicalize(root)?)
}

/// The path with its directory canonicalized (the file itself may not exist).
fn canonical_file(path: &Path) -> PathBuf {
    match (path.parent().and_then(|d| fs::canonicalize(d).ok()), path.file_name()) {
        (Some(dir), Some(name)) => dir.join(name),
        _ => path.to_path_buf(),
    }
}

/// Resolve and check `repo`'s database: the global path and a missing file are refused here.
pub fn locate(repo: &Path, genie_home: &Path) -> Result<Location, Error> {
    let root = project_root(repo)?;
    let db_path = root.join(".genie").join("genie.db");
    if canonical_file(&db_path) == canonical_file(&genie_home.join("genie.db")) {
        return Err(Error::GlobalDatabase(db_path));
    }
    if !db_path.is_file() {
        return Err(Error::NoDatabase(db_path));
    }
    Ok(Location { project: root.to_string_lossy().into_owned(), db_path })
}

fn is_busy(e: &rusqlite::Error) -> bool {
    matches!(e, rusqlite::Error::SqliteFailure(f, _) if matches!(f.extended_code & 0xff, 5 | 6 | 15))
}

/// Run `f`, retrying a contended lock on the `sqlite-open.ts` schedule.
fn retry_busy<T>(mut f: impl FnMut() -> Result<T, Error>) -> Result<T, Error> {
    let mut delays = BUSY_RETRY_MS.iter();
    loop {
        match f() {
            Err(Error::Db(e)) if is_busy(&e) => match delays.next() {
                Some(ms) => sleep(Duration::from_millis(*ms)),
                None => return Err(Error::Db(e)),
            },
            other => return other,
        }
    }
}

/// An open handle on one repository's `v7_` tables.
pub struct Store {
    conn: Connection,
    location: Location,
    genie_home: PathBuf,
    clock: Box<dyn Clock>,
}

/// Open `repo`'s store, exporting to the environment's `<GENIE_HOME>`.
pub fn open_store(repo: &Path) -> Result<Store, Error> {
    open_store_at(repo, &genie_home())
}

/// Open `repo`'s store with an explicit `<GENIE_HOME>`.
pub fn open_store_at(repo: &Path, genie_home: &Path) -> Result<Store, Error> {
    let location = locate(repo, genie_home)?;
    let conn = retry_busy(|| open_conn(&location.db_path))?;
    Ok(Store { conn, location, genie_home: genie_home.to_path_buf(), clock: Box::new(SystemClock) })
}

fn open_conn(db_path: &Path) -> Result<Connection, Error> {
    // No CREATE flag: a file that vanished since `locate` is an error, never a new database.
    let conn =
        Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
    conn.busy_timeout(BUSY_TIMEOUT)?;
    // Read before any pragma that writes, so a version-0 file stays byte-identical.
    let user_version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if user_version == 0 {
        return Err(Error::Uninitialized(db_path.to_path_buf()));
    }
    let _mode: String = conn.query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))?;
    conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;")?;
    let version: Option<i64> = match conn.query_row("SELECT version FROM v7_schema WHERE id = 1", [], |r| r.get(0)) {
        Ok(v) => Some(v),
        Err(rusqlite::Error::QueryReturnedNoRows) => None,
        Err(rusqlite::Error::SqliteFailure(_, Some(msg))) if msg.contains("no such table") => None,
        Err(e) => return Err(e.into()),
    };
    match version {
        Some(SCHEMA_VERSION) => {}
        Some(v) => {
            return Err(Error::NewerSchema { path: db_path.to_path_buf(), version: v });
        }
        None => {
            conn.execute_batch("BEGIN IMMEDIATE")?;
            if let Err(e) = conn.execute_batch(SCHEMA_SQL).and_then(|()| conn.execute_batch("COMMIT")) {
                let _ = conn.execute_batch("ROLLBACK");
                return Err(e.into());
            }
        }
    }
    Ok(conn)
}

const EVENT_COLUMNS: &str = "seq, project, task_key, task, event, forge, url, branch, \"commit\", worktree, type, \
     title, lead, at, counted, exclude_reason, pushed_after_open, dedupe_key";

fn event_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<StoredEvent> {
    let event: String = r.get(4)?;
    Ok(StoredEvent {
        seq: r.get(0)?,
        project: r.get(1)?,
        task_key: r.get(2)?,
        task: r.get(3)?,
        event: TaskEvent::parse(&event).ok_or(rusqlite::Error::InvalidColumnType(
            4,
            "event".into(),
            rusqlite::types::Type::Text,
        ))?,
        forge: r.get(5)?,
        url: r.get(6)?,
        branch: r.get(7)?,
        commit: r.get(8)?,
        worktree: r.get(9)?,
        kind: r.get(10)?,
        title: r.get(11)?,
        lead: r.get(12)?,
        at: r.get(13)?,
        counted: r.get::<_, i64>(14)? != 0,
        exclude_reason: r.get(15)?,
        pushed_after_open: r.get(16)?,
        dedupe_key: r.get(17)?,
    })
}

/// Every event of `project` in `conn`, in replay order. A database without the table has none.
pub(crate) fn read_events(conn: &Connection, project: &str) -> Result<Vec<StoredEvent>, Error> {
    let sql = format!("SELECT {EVENT_COLUMNS} FROM v7_task_events WHERE project = ?1 ORDER BY seq");
    let mut stmt = match conn.prepare(&sql) {
        Ok(stmt) => stmt,
        Err(rusqlite::Error::SqliteFailure(_, Some(msg))) if msg.contains("no such table") => {
            return Ok(Vec::new());
        }
        Err(e) => return Err(e.into()),
    };
    let rows = stmt.query_map([project], event_from_row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

impl Store {
    /// Replace the clock (tests inject a fixed one).
    pub fn with_clock(mut self, clock: Box<dyn Clock>) -> Store {
        self.clock = clock;
        self
    }

    /// The canonical main-checkout path rows are recorded under.
    pub fn project(&self) -> &str {
        &self.location.project
    }

    pub fn db_path(&self) -> &Path {
        &self.location.db_path
    }

    pub fn genie_home(&self) -> &Path {
        &self.genie_home
    }

    pub fn events(&self) -> Result<Vec<StoredEvent>, Error> {
        read_events(&self.conn, &self.location.project)
    }

    pub fn tasks(&self) -> Result<Vec<TaskRow>, Error> {
        let mut stmt = self.conn.prepare(
            "SELECT project, task_key, task, state, title, lead, forge, url, branch, last_seq, updated_at \
             FROM v7_tasks WHERE project = ?1 ORDER BY task_key",
        )?;
        let rows = stmt.query_map([&self.location.project], |r| {
            let state: String = r.get(3)?;
            Ok(TaskRow {
                project: r.get(0)?,
                task_key: r.get(1)?,
                task: r.get(2)?,
                state: TaskState::parse(&state).unwrap_or(TaskState::Created),
                title: r.get(4)?,
                lead: r.get(5)?,
                forge: r.get(6)?,
                url: r.get(7)?,
                branch: r.get(8)?,
                last_seq: r.get(9)?,
                updated_at: r.get(10)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// The `v7_tasks` row of `task_key` in this project, if any.
    pub fn task(&self, task_key: &str) -> Result<Option<TaskRow>, Error> {
        Ok(self.tasks()?.into_iter().find(|t| t.task_key == task_key))
    }

    /// The latest `created` event whose worktree is `worktree`: the task a worktree belongs to.
    pub fn created_in(&self, worktree: &str) -> Result<Option<StoredEvent>, Error> {
        Ok(self.events()?.into_iter().rev().find(|e| e.event == TaskEvent::Created && e.worktree == worktree))
    }

    /// Tx 1 of `start`: reserve the next `gn-<seq>` in one short `BEGIN IMMEDIATE`, with no git or
    /// network inside it. The sequence is past every reservation and every `gn-` task already
    /// recorded (forge-sync may have seen one first), so an id is never reused.
    pub fn reserve_gn(&self) -> Result<String, Error> {
        let project = self.location.project.as_str();
        let at = self.clock.now();
        retry_busy(|| {
            self.conn.execute_batch("BEGIN IMMEDIATE")?;
            let body = || -> rusqlite::Result<String> {
                let seq: i64 = self.conn.query_row(
                    "SELECT 1 + max(coalesce((SELECT max(seq) FROM v7_task_ids WHERE project = ?1), 0), \
                     coalesce((SELECT max(CAST(substr(task, 4) AS INTEGER)) FROM v7_tasks \
                     WHERE project = ?1 AND task GLOB 'gn-[0-9]*'), 0))",
                    [project],
                    |r| r.get(0),
                )?;
                let task = format!("gn-{seq}");
                self.conn.execute(
                    "INSERT INTO v7_task_ids (project, seq, task, reserved_at) VALUES (?1, ?2, ?3, ?4)",
                    params![project, seq, task, at],
                )?;
                Ok(task)
            };
            match body().and_then(|task| self.conn.execute_batch("COMMIT").map(|()| task)) {
                Ok(task) => Ok(task),
                Err(e) => {
                    let _ = self.conn.execute_batch("ROLLBACK");
                    Err(e.into())
                }
            }
        })
    }

    /// A failed `start` marks its reservation abandoned: the gap stays, the id is never reused.
    pub fn abandon_gn(&self, task: &str) -> Result<(), Error> {
        retry_busy(|| {
            self.conn.execute(
                "UPDATE v7_task_ids SET abandoned = 1 WHERE project = ?1 AND task = ?2",
                [self.location.project.as_str(), task],
            )?;
            Ok(())
        })
    }

    /// The transaction body: key, dedupe, apply, insert, upsert. The caller owns BEGIN/COMMIT. Returns
    /// the dedupe key with the stored event, `None` for a duplicate.
    fn record_tx(&self, project: &str, key: &str, row: &EventRow) -> Result<(String, Option<StoredEvent>), Error> {
        // Read inside the transaction, so the generation is the replay's: the closed events before this one.
        let generation: i64 = if row.event == TaskEvent::Created {
            self.conn.query_row(
                "SELECT count(*) FROM v7_task_events WHERE project = ?1 AND task_key = ?2 AND event = 'closed'",
                [project, key],
                |r| r.get(0),
            )?
        } else {
            0
        };
        let dedupe =
            lifecycle_dedupe_key(project, &row.task, row.event, &row.url, &row.commit, &row.worktree, generation);
        let dedupe = dedupe.as_str();
        let seen: Option<i64> = self
            .conn
            .query_row("SELECT seq FROM v7_task_events WHERE dedupe_key = ?1", [dedupe], |r| r.get(0))
            .optional()?;
        if seen.is_some() {
            return Ok((dedupe.to_string(), None));
        }
        let state: Option<String> = self
            .conn
            .query_row("SELECT state FROM v7_tasks WHERE project = ?1 AND task_key = ?2", [project, key], |r| r.get(0))
            .optional()?;
        let next = apply(state.as_deref().and_then(TaskState::parse), &row.event, self.clock.as_ref())
            .map_err(Error::Refused)?;
        let at = row.at.clone().unwrap_or_else(|| self.clock.now());
        self.conn.execute(
            "INSERT INTO v7_task_events (project, task_key, task, event, forge, url, branch, \"commit\", worktree, \
             type, title, lead, at, counted, exclude_reason, pushed_after_open, dedupe_key) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
            params![
                project,
                key,
                row.task,
                row.event.as_str(),
                row.forge,
                row.url,
                row.branch,
                row.commit,
                row.worktree,
                row.kind,
                row.title,
                row.lead,
                at,
                i64::from(row.counted),
                row.exclude_reason,
                row.pushed_after_open,
                dedupe
            ],
        )?;
        let seq = self.conn.last_insert_rowid();
        // Title, lead and the PR fields keep their last non-empty value.
        self.conn.execute(
            "INSERT INTO v7_tasks (project, task_key, task, state, title, lead, forge, url, branch, last_seq, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11) \
             ON CONFLICT (project, task_key) DO UPDATE SET state = excluded.state, task = excluded.task, \
             title = coalesce(nullif(excluded.title, ''), v7_tasks.title), \
             lead = coalesce(nullif(excluded.lead, ''), v7_tasks.lead), \
             forge = coalesce(nullif(excluded.forge, ''), v7_tasks.forge), \
             url = coalesce(nullif(excluded.url, ''), v7_tasks.url), \
             branch = coalesce(nullif(excluded.branch, ''), v7_tasks.branch), \
             last_seq = excluded.last_seq, updated_at = excluded.updated_at",
            params![project, key, row.task, next.as_str(), row.title, row.lead, row.forge, row.url, row.branch, seq, at],
        )?;
        let sql = format!("SELECT {EVENT_COLUMNS} FROM v7_task_events WHERE seq = ?1");
        Ok((dedupe.to_string(), Some(self.conn.query_row(&sql, [seq], event_from_row)?)))
    }
}

/// Record one event: one `BEGIN IMMEDIATE` transaction (apply + insert + upsert, `synchronous=FULL`),
/// then one export row under the shared sidecar lock. A refusal writes nothing.
pub fn record(store: &Store, project: &str, row: &EventRow) -> Result<Recorded, Error> {
    let key = row.task_key()?;
    for (name, part) in [
        ("project", project),
        ("task", &row.task),
        ("url", &row.url),
        ("commit", &row.commit),
        ("worktree", &row.worktree),
    ] {
        if part.contains('\0') {
            return Err(Error::InvalidEvent(format!("a NUL byte in {name}")));
        }
    }
    let (dedupe, stored) = retry_busy(|| {
        store.conn.execute_batch("BEGIN IMMEDIATE")?;
        match store.record_tx(project, &key, row) {
            Ok(stored) => match store.conn.execute_batch("COMMIT") {
                Ok(()) => Ok(stored),
                Err(e) => {
                    let _ = store.conn.execute_batch("ROLLBACK");
                    Err(e.into())
                }
            },
            Err(e) => {
                let _ = store.conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    })?;
    let Some(stored) = stored else {
        return Ok(Recorded::Duplicate { dedupe_key: dedupe });
    };
    export::append(&store.genie_home, &export::line(&stored))
        .map_err(|source| Error::Export { seq: stored.seq, source })?;
    Ok(Recorded::Appended { seq: stored.seq, dedupe_key: dedupe, state: stored.event.target() })
}
