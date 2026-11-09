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
pub const SCHEMA_VERSION: i64 = 2;
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

/// When a task's lifecycle reached each event, from its `v7_task_events` rows; `None` when there is
/// no such row or its value is `''`. `created_at` and `worktree` come from the LATEST `created` row
/// (a restart is a new lifecycle); `opened_at`, `merged_at` and `closed_at` from the first row of
/// their kind.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Lifecycle {
    pub created_at: Option<String>,
    pub worktree: Option<String>,
    pub opened_at: Option<String>,
    pub merged_at: Option<String>,
    pub closed_at: Option<String>,
}

/// One `v7_tasks` row with its lifecycle and derived whole-minute durations.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Listed {
    pub row: TaskRow,
    pub lifecycle: Lifecycle,
    /// Now minus the first recorded creation, across all restarts.
    pub age_min: Option<i64>,
    /// Now minus this epoch's creation, only while created or opened.
    pub task_open_min: Option<i64>,
    /// This epoch's merge/close minus its creation, only in a terminal state.
    pub task_lead_min: Option<i64>,
    /// Now minus this epoch's opening, only while its PR is open.
    pub pr_open_min: Option<i64>,
    /// This epoch's merge/close minus its opening, only in a terminal state.
    pub pr_lead_min: Option<i64>,
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
    pub(crate) conn: Connection,
    location: Location,
    genie_home: PathBuf,
    pub(crate) clock: Box<dyn Clock>,
}

/// Open `repo`'s store, exporting to the environment's `<GENIE_HOME>`.
pub fn open_store(repo: &Path) -> Result<Store, Error> {
    open_store_at(repo, &genie_home())
}

/// Open `repo`'s store with an explicit `<GENIE_HOME>`.
pub fn open_store_at(repo: &Path, genie_home: &Path) -> Result<Store, Error> {
    open_with(repo, genie_home, Access::Write)
}

/// Open `repo`'s store to read only, exporting to the environment's `<GENIE_HOME>`.
pub fn open_store_read(repo: &Path) -> Result<Store, Error> {
    open_with(repo, &genie_home(), Access::Read)
}

/// Open `repo`'s store to read only: the refusals of [`open_store_at`] (a missing file, the global
/// path, `user_version = 0`, a newer `v7_schema`), checked before any read, but no write statement
/// at all (no `journal_mode`, no `synchronous`, no `SCHEMA_SQL`), so the main file stays
/// byte-identical and a database without the `v7_` tables reads as empty. The flags stay read-write:
/// `SQLITE_OPEN_READONLY` refuses a WAL database copied without its `-shm` sidecar.
pub fn open_store_read_at(repo: &Path, genie_home: &Path) -> Result<Store, Error> {
    open_with(repo, genie_home, Access::Read)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Access {
    Read,
    Write,
}

fn open_with(repo: &Path, genie_home: &Path, access: Access) -> Result<Store, Error> {
    let location = locate(repo, genie_home)?;
    let conn = retry_busy(|| open_conn(&location.db_path, access))?;
    Ok(Store { conn, location, genie_home: genie_home.to_path_buf(), clock: Box::new(SystemClock) })
}

fn open_conn(db_path: &Path, access: Access) -> Result<Connection, Error> {
    // No CREATE flag: a file that vanished since `locate` is an error, never a new database.
    let conn =
        Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
    conn.busy_timeout(BUSY_TIMEOUT)?;
    // Read before any pragma that writes, so a version-0 file stays byte-identical.
    let user_version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if user_version == 0 {
        return Err(Error::Uninitialized(db_path.to_path_buf()));
    }
    if access == Access::Write {
        let _mode: String = conn.query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))?;
        conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;")?;
    }
    let version: Option<i64> = match conn.query_row("SELECT version FROM v7_schema WHERE id = 1", [], |r| r.get(0)) {
        Ok(v) => Some(v),
        Err(rusqlite::Error::QueryReturnedNoRows) => None,
        Err(e) if no_such_table(&e) => None,
        Err(e) => return Err(e.into()),
    };
    match version {
        Some(SCHEMA_VERSION) if access == Access::Write => {
            // Additive index for existing schema-2 databases; measured need is recorded in schema.sql.
            conn.execute_batch(
                "CREATE INDEX IF NOT EXISTS v7_task_events_by_branch_url ON v7_task_events (project, branch, url)",
            )?;
        }
        Some(SCHEMA_VERSION) => {}
        Some(1) if access == Access::Read => {}
        Some(1) => {
            conn.execute_batch("BEGIN IMMEDIATE")?;
            if let Err(e) = conn
                .execute_batch(SCHEMA_SQL)
                .and_then(|()| conn.execute_batch("UPDATE v7_schema SET version = 2 WHERE id = 1; COMMIT"))
            {
                let _ = conn.execute_batch("ROLLBACK");
                return Err(e.into());
            }
        }
        Some(v) => {
            return Err(Error::NewerSchema { path: db_path.to_path_buf(), version: v });
        }
        None if access == Access::Read => {}
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

fn no_such_table(e: &rusqlite::Error) -> bool {
    matches!(e, rusqlite::Error::SqliteFailure(_, Some(msg)) if msg.contains("no such table"))
}

/// The lifecycle of one event kind: the `at` (and, for `created`, the `worktree`) of its first row,
/// or of its latest when `latest`, as one correlated subquery over `v7_task_events_by_task`.
fn lifecycle_sql(column: &str, event: &str, latest: bool) -> String {
    let order = if latest { "DESC" } else { "ASC" };
    format!(
        "(SELECT NULLIF(e.{column}, '') FROM v7_task_events e WHERE e.project = t.project \
         AND e.task_key = t.task_key AND e.event = '{event}' ORDER BY e.seq {order} LIMIT 1)"
    )
}

struct Timestamp<'a> {
    seconds: i64,
    /// Decimal digits with trailing zeroes removed: lexicographic order is fractional order.
    fraction: &'a str,
}

fn decimal(s: &str) -> Option<i64> {
    if s.bytes().all(|b| b.is_ascii_digit()) { s.parse().ok() } else { None }
}

fn offset_seconds(s: &str) -> Option<i64> {
    if matches!(s, "Z" | "z") {
        return Some(0);
    }
    let b = s.as_bytes();
    if b.len() != 6 || !matches!(b[0], b'+' | b'-') || b[3] != b':' {
        return None;
    }
    let (hours, minutes) = (decimal(s.get(1..3)?)?, decimal(s.get(4..6)?)?);
    if hours > 23 || minutes > 59 {
        return None;
    }
    let seconds = hours * 3_600 + minutes * 60;
    Some(if b[0] == b'-' { -seconds } else { seconds })
}

/// Calendar-valid RFC 3339, without leap seconds (as with the previous SQLite reader).
/// Keep arbitrary fractional precision; SQLite rounds to milliseconds and accepts date expressions.
fn timestamp(s: &str) -> Option<Timestamp<'_>> {
    let b = s.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || !matches!(b[10], b'T' | b't') || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let num = |from, to| decimal(s.get(from..to)?);
    let (year, month, day) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (hour, minute, second) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days_in_month = match month {
        2 => {
            if leap {
                29
            } else {
                28
            }
        }
        4 | 6 | 9 | 11 => 30,
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        _ => return None,
    };
    if !(1..=days_in_month).contains(&day) || hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    let (fraction, zone) = if let Some(rest) = s.get(19..)?.strip_prefix('.') {
        let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            return None;
        }
        (rest[..digits].trim_end_matches('0'), &rest[digits..])
    } else {
        ("", &s[19..])
    };
    let offset = offset_seconds(zone)?;
    // Howard Hinnant's days-from-civil, inverting state::rfc3339.
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let yoe = year - era * 400;
    let doy = (153 * ((month + 9) % 12) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(Timestamp { seconds: days * 86_400 + hour * 3_600 + minute * 60 + second - offset, fraction })
}

/// Missing, invalid or reversed endpoints stay unknown; valid durations floor to whole minutes.
pub(crate) fn minutes_between(start: Option<&str>, end: Option<&str>) -> Option<i64> {
    let (start, end) = (timestamp(start?)?, timestamp(end?)?);
    // Borrow one whole second when the fractional difference is negative, before minute division.
    // Comparing digits preserves even sub-nanosecond reversals without float rounding or truncation.
    let seconds = end.seconds - start.seconds - i64::from(end.fraction < start.fraction);
    (seconds >= 0).then_some(seconds / 60)
}

/// Every event of `project` in `conn`, in replay order. A database without the table has none.
pub(crate) fn read_events(conn: &Connection, project: &str) -> Result<Vec<StoredEvent>, Error> {
    let sql = format!("SELECT {EVENT_COLUMNS} FROM v7_task_events WHERE project = ?1 ORDER BY seq");
    let mut stmt = match conn.prepare(&sql) {
        Ok(stmt) => stmt,
        Err(e) if no_such_table(&e) => return Ok(Vec::new()),
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

    /// This project's `v7_tasks` rows; a database without the table has none.
    pub fn tasks(&self) -> Result<Vec<TaskRow>, Error> {
        Ok(self.listed()?.into_iter().map(|l| l.row).collect())
    }

    /// This project's `v7_tasks` rows with their lifecycle, in one aggregate query and no schema
    /// change; a database without the tables has none.
    pub fn listed(&self) -> Result<Vec<Listed>, Error> {
        crate::link::project(self, self.raw_listed()?)
    }

    pub(crate) fn raw_listed(&self) -> Result<Vec<Listed>, Error> {
        // Sequence order defines epochs, not wall-clock order (timestamps can be reversed).
        // Use the latest opened after the preceding close/restart. For a terminal task the
        // current terminal row closes that epoch, so exclude it from the boundary search.
        // A restart without a new opened row must never borrow the previous PR's duration.
        let opened = "(SELECT NULLIF(e.at, '') FROM v7_task_events e WHERE e.project = t.project \
            AND e.task_key = t.task_key AND e.event = 'opened' AND e.seq > COALESCE(\
            (SELECT MAX(b.seq) FROM v7_task_events b WHERE b.project = t.project \
            AND b.task_key = t.task_key AND b.event IN ('created', 'closed', 'merged') \
            AND b.seq < t.last_seq), 0) ORDER BY e.seq DESC LIMIT 1)";
        let created = "(SELECT NULLIF(e.at, '') FROM v7_task_events e WHERE e.project = t.project \
            AND e.task_key = t.task_key AND e.event = 'created' AND e.seq > COALESCE(\
            (SELECT MAX(b.seq) FROM v7_task_events b WHERE b.project = t.project \
            AND b.task_key = t.task_key AND b.event IN ('closed', 'merged') \
            AND b.seq < t.last_seq), 0) ORDER BY e.seq DESC LIMIT 1)";
        let sql = format!(
            "WITH times AS (SELECT t.project, t.task_key, t.task, t.state, t.title, t.lead, t.forge, \
             t.url, t.branch, t.last_seq, t.updated_at, {} AS created_at, {} AS worktree, \
             {} AS opened_at, {} AS merged_at, {} AS closed_at, {} AS first_created, \
             {opened} AS epoch_opened, {created} AS epoch_created, \
             (SELECT NULLIF(e.at, '') FROM v7_task_events e WHERE e.project = t.project \
             AND e.task_key = t.task_key AND e.seq = t.last_seq \
             AND e.event IN ('merged', 'closed')) AS terminal_at \
             FROM v7_tasks t WHERE t.project = ?1) \
             SELECT project, task_key, task, state, title, lead, forge, url, branch, last_seq, \
             updated_at, created_at, worktree, opened_at, merged_at, closed_at, \
             first_created, epoch_opened, terminal_at, epoch_created FROM times ORDER BY task_key",
            lifecycle_sql("at", "created", true),
            lifecycle_sql("worktree", "created", true),
            lifecycle_sql("at", "opened", false),
            lifecycle_sql("at", "merged", false),
            lifecycle_sql("at", "closed", false),
            lifecycle_sql("at", "created", false),
        );
        let mut stmt = match self.conn.prepare(&sql) {
            Ok(stmt) => stmt,
            Err(e) if no_such_table(&e) => return Ok(Vec::new()),
            Err(e) => return Err(e.into()),
        };
        let now = self.clock.now();
        let rows = stmt.query_map([&self.location.project], |r| {
            let state: String = r.get(3)?;
            let row = TaskRow {
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
            };
            let lifecycle = Lifecycle {
                created_at: r.get(11)?,
                worktree: r.get(12)?,
                opened_at: r.get(13)?,
                merged_at: r.get(14)?,
                closed_at: r.get(15)?,
            };
            let first_created: Option<String> = r.get(16)?;
            let epoch_opened: Option<String> = r.get(17)?;
            let terminal_at: Option<String> = r.get(18)?;
            let epoch_created: Option<String> = r.get(19)?;
            let task_open_min = if matches!(row.state, TaskState::Created | TaskState::Opened) {
                minutes_between(epoch_created.as_deref(), Some(&now))
            } else {
                None
            };
            let task_lead_min = if matches!(row.state, TaskState::Merged | TaskState::Closed) {
                minutes_between(epoch_created.as_deref(), terminal_at.as_deref())
            } else {
                None
            };
            let age_min = minutes_between(first_created.as_deref(), Some(&now));
            let pr_open_min = if row.state == TaskState::Opened {
                minutes_between(epoch_opened.as_deref(), Some(&now))
            } else {
                None
            };
            let pr_lead_min = if matches!(row.state, TaskState::Merged | TaskState::Closed) {
                minutes_between(epoch_opened.as_deref(), terminal_at.as_deref())
            } else {
                None
            };
            Ok(Listed { row, lifecycle, age_min, task_open_min, task_lead_min, pr_open_min, pr_lead_min })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// The `v7_tasks` row of `task_key` in this project, if any.
    pub fn task(&self, task_key: &str) -> Result<Option<TaskRow>, Error> {
        Ok(self.tasks()?.into_iter().find(|t| t.task_key == task_key || t.task == task_key))
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
        let current: Option<(String, String, String)> = self
            .conn
            .query_row(
                "SELECT state, url, updated_at FROM v7_tasks WHERE project = ?1 AND task_key = ?2",
                [project, key],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        let state = current.as_ref().and_then(|(state, _, _)| TaskState::parse(state));
        let at = row.at.clone().unwrap_or_else(|| self.clock.now());
        // An old forge-sync may have recorded only the terminal event. Fill its missing open
        // evidence without reopening the task or moving its terminal sequence/timestamp.
        // Only the same PR, with a valid open at or before its terminal time, qualifies.
        let historical_open = row.event == TaskEvent::Opened
            && row.at.is_some()
            && !row.url.is_empty()
            && matches!(state, Some(TaskState::Merged | TaskState::Closed))
            && current.as_ref().is_some_and(|(_, url, terminal)| {
                *url == row.url && minutes_between(Some(&at), Some(terminal)).is_some()
            })
            && self.conn.query_row(
                "SELECT NOT EXISTS(SELECT 1 FROM v7_task_events \
                 WHERE project = ?1 AND task_key = ?2 AND url = ?3 AND event = 'opened')",
                params![project, key, row.url],
                |r| r.get::<_, bool>(0),
            )?;
        let next = if historical_open {
            state.unwrap()
        } else {
            apply(state, &row.event, self.clock.as_ref()).map_err(Error::Refused)?
        };
        let seq = crate::link::next_seq(&self.conn)?;
        self.conn.execute(
            "INSERT INTO v7_task_events (seq, project, task_key, task, event, forge, url, branch, \"commit\", worktree, \
             type, title, lead, at, counted, exclude_reason, pushed_after_open, dedupe_key) \
             VALUES (?18, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
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
                dedupe,
                seq
            ],
        )?;
        // Title, lead and the PR fields keep their last non-empty value. A historical open
        // adds evidence only; the materialized task remains byte-for-byte unchanged.
        if !historical_open {
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
        }
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
    let (dedupe, stored, line) = retry_busy(|| {
        store.conn.execute_batch("BEGIN IMMEDIATE")?;
        match store.record_tx(project, &key, row) {
            Ok((dedupe, stored)) => {
                let line = match stored.as_ref().map(|e| crate::link::lifecycle_line(store, e)).transpose() {
                    Ok(line) => line,
                    Err(e) => {
                        let _ = store.conn.execute_batch("ROLLBACK");
                        return Err(e);
                    }
                };
                match store.conn.execute_batch("COMMIT") {
                    Ok(()) => Ok((dedupe, stored, line)),
                    Err(e) => {
                        let _ = store.conn.execute_batch("ROLLBACK");
                        Err(e.into())
                    }
                }
            }
            Err(e) => {
                let _ = store.conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    })?;
    let Some(stored) = stored else {
        return Ok(Recorded::Duplicate { dedupe_key: dedupe });
    };
    export::append(&store.genie_home, line.as_deref().expect("an appended event has an export line"))
        .map_err(|source| Error::Export { seq: stored.seq, source })?;
    Ok(Recorded::Appended { seq: stored.seq, dedupe_key: dedupe, state: stored.event.target() })
}
