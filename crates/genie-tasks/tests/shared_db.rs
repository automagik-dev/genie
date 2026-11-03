//! T9 (Rust half) and the T3 store case: the store shares a TS-initialized `genie.db`, built here
//! as a facsimile at `user_version = 1` so `bun` is not a `cargo test` prerequisite.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};

use genie_tasks::{Error, EventRow, Recorded, SCHEMA_SQL, TaskEvent, TaskState, open_store_at, record};
use rusqlite::Connection;

static N: AtomicUsize = AtomicUsize::new(0);

struct Tmp(PathBuf);

impl Tmp {
    fn new(tag: &str) -> Tmp {
        let dir = std::env::temp_dir().join(format!(
            "genie-tasks-{tag}-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        Tmp(fs::canonicalize(dir).unwrap())
    }
}

impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn git(dir: &Path, args: &[&str]) {
    let ok = Command::new("git")
        .args(["-c", "user.name=t", "-c", "user.email=t@example.com"])
        .args(args)
        .current_dir(dir)
        .status()
        .unwrap();
    assert!(ok.success(), "git {args:?}");
}

/// The TS schema's table set (`src/lib/v5/genie-db.ts`), with a row in each, at `user_version = 1`.
const TS_FACSIMILE: &str = "
PRAGMA journal_mode = WAL;
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE boards (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, lanes TEXT NOT NULL);
CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL, board_id TEXT REFERENCES boards(id), lane TEXT, wish TEXT);
CREATE TABLE task_dependencies (task_id TEXT NOT NULL REFERENCES tasks(id), depends_on TEXT NOT NULL REFERENCES tasks(id), PRIMARY KEY (task_id, depends_on));
CREATE TABLE stage_log (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, stage TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE task_events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, kind TEXT NOT NULL, body TEXT, at TEXT NOT NULL);
CREATE TABLE wish_groups (wish TEXT NOT NULL, grp TEXT NOT NULL, status TEXT NOT NULL, PRIMARY KEY (wish, grp));
INSERT INTO meta VALUES ('stage_log_backfill', '1');
INSERT INTO boards VALUES ('b1', 'roadmap', '[\"Idea\",\"Work\"]');
INSERT INTO tasks VALUES ('t_1', 'a card', 'ready', 'b1', 'Work', 'genie-v7-tasks'), ('t_2', 'another', 'ready', 'b1', 'Idea', NULL);
INSERT INTO task_dependencies VALUES ('t_1', 't_2');
INSERT INTO stage_log (task_id, stage, at) VALUES ('t_1', 'work', '2026-11-03T00:00:00Z');
INSERT INTO task_events (task_id, kind, body, at) VALUES ('t_1', 'comment', 'hello', '2026-11-03T00:00:01Z');
INSERT INTO wish_groups VALUES ('genie-v7-tasks', '1a', 'IN_PROGRESS');
PRAGMA user_version = 1;
";

/// A git repository with a TS-shaped `.genie/genie.db`.
fn ts_repo(tmp: &Tmp) -> PathBuf {
    let repo = tmp.0.join("repo");
    fs::create_dir_all(repo.join(".genie")).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    git(&repo, &["commit", "-q", "--allow-empty", "-m", "init"]);
    Connection::open(repo.join(".genie/genie.db")).unwrap().execute_batch(TS_FACSIMILE).unwrap();
    repo
}

/// `user_version`, every non-`v7_` schema entry and every row of every non-`v7_` table.
fn ts_snapshot(db: &Path) -> Vec<String> {
    let conn = Connection::open(db).unwrap();
    let mut out =
        vec![format!("user_version={}", conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap())];
    let mut stmt = conn
        .prepare("SELECT type, name, coalesce(sql, '') FROM sqlite_master WHERE name NOT LIKE 'v7_%' AND name NOT LIKE 'sqlite_autoindex_v7_%' ORDER BY type, name")
        .unwrap();
    let entries: Vec<(String, String, String)> =
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap().map(Result::unwrap).collect();
    for (kind, name, sql) in entries {
        out.push(format!("{kind} {name} {sql}"));
        if kind == "table" {
            let mut rows = conn.prepare(&format!("SELECT * FROM \"{name}\" ORDER BY rowid")).unwrap();
            let width = rows.column_count();
            let dumped: Vec<String> = rows
                .query_map([], |r| {
                    let cells: Vec<String> = (0..width).map(|i| format!("{:?}", r.get_ref(i).unwrap())).collect();
                    Ok(cells.join("|"))
                })
                .unwrap()
                .map(Result::unwrap)
                .collect();
            out.push(format!("{name}: {}", dumped.join(" ; ")));
        }
    }
    out
}

fn v7_tables(db: &Path) -> Vec<String> {
    let conn = Connection::open(db).unwrap();
    let mut stmt =
        conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'v7_%' ORDER BY name").unwrap();
    stmt.query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect()
}

fn opened(task: &str, url: &str) -> EventRow {
    let mut row = EventRow::new(TaskEvent::Opened);
    row.task = task.into();
    row.forge = "github".into();
    row.url = url.into();
    row.commit = "c".repeat(40);
    row
}

#[test]
fn ts_first_then_rust_adds_only_its_tables() {
    let tmp = Tmp::new("ts-first");
    let repo = ts_repo(&tmp);
    let db = repo.join(".genie/genie.db");
    let before = ts_snapshot(&db);
    let store = open_store_at(&repo, &tmp.0.join("home")).unwrap();
    assert_eq!(v7_tables(&db), ["v7_schema", "v7_task_events", "v7_task_ids", "v7_tasks"]);
    let version: i64 =
        Connection::open(&db).unwrap().query_row("SELECT version FROM v7_schema", [], |r| r.get(0)).unwrap();
    assert_eq!(version, genie_tasks::SCHEMA_VERSION);
    record(&store, store.project(), &opened("gh-1", "https://github.com/o/r/pull/1")).unwrap();
    drop(store);
    assert_eq!(ts_snapshot(&db), before, "user_version and every TS table are byte-identical");
    // A second open finds the version row and runs no DDL.
    let again = open_store_at(&repo, &tmp.0.join("home")).unwrap();
    assert_eq!(again.events().unwrap().len(), 1);
}

#[test]
fn a_database_seeded_from_schema_sql_alone_is_complete() {
    let tmp = Tmp::new("schema-sql");
    let repo = ts_repo(&tmp);
    let db = repo.join(".genie/genie.db");
    let conn = Connection::open(&db).unwrap();
    conn.execute_batch(SCHEMA_SQL).unwrap();
    conn.execute_batch(SCHEMA_SQL).unwrap();
    let rows: i64 = conn.query_row("SELECT count(*) FROM v7_schema WHERE version = 1", [], |r| r.get(0)).unwrap();
    assert_eq!(rows, 1, "the version row is written once, by INSERT OR IGNORE");
    let store = open_store_at(&repo, &tmp.0.join("home")).unwrap();
    record(&store, store.project(), &opened("gh-2", "https://github.com/o/r/pull/2")).unwrap();
    assert_eq!(store.tasks().unwrap()[0].state, TaskState::Opened);
}

#[test]
fn rust_first_refuses_with_the_remedy_and_leaves_no_file() {
    let tmp = Tmp::new("rust-first");
    let repo = tmp.0.join("repo");
    fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    let err = open_store_at(&repo, &tmp.0.join("home")).err().expect("no genie.db is refused");
    assert!(matches!(err, Error::NoDatabase(_)), "{err:?}");
    assert_eq!(err.exit_code(), 2);
    assert!(err.to_string().contains("run 'genie task list' once in this repository to initialize .genie/genie.db"));
    assert!(!repo.join(".genie").exists(), "not even .genie/ is created");
    assert!(!tmp.0.join("home").exists(), "nothing is written under GENIE_HOME");
}

#[test]
fn a_version_zero_file_is_refused_and_left_byte_identical() {
    let tmp = Tmp::new("version-zero");
    let repo = tmp.0.join("repo");
    fs::create_dir_all(repo.join(".genie")).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    let db = repo.join(".genie/genie.db");
    Connection::open(&db)
        .unwrap()
        .execute_batch("CREATE TABLE stray (x INTEGER); INSERT INTO stray VALUES (1);")
        .unwrap();
    let bytes = fs::read(&db).unwrap();
    let err = open_store_at(&repo, &tmp.0.join("home")).err().expect("user_version = 0 is refused");
    assert!(matches!(err, Error::Uninitialized(_)), "{err:?}");
    assert_eq!(err.exit_code(), 2);
    assert_eq!(fs::read(&db).unwrap(), bytes);
    let names: Vec<_> = fs::read_dir(repo.join(".genie")).unwrap().map(|e| e.unwrap().file_name()).collect();
    assert_eq!(names, ["genie.db"], "no -wal or -shm beside it");
}

#[test]
fn genie_home_genie_db_is_refused_in_every_spelling() {
    let tmp = Tmp::new("global");
    let home = tmp.0.join("user");
    fs::create_dir_all(home.join(".genie")).unwrap();
    Connection::open(home.join(".genie/genie.db")).unwrap().execute_batch("PRAGMA user_version = 1;").unwrap();
    let link = tmp.0.join("genie-home-link");
    std::os::unix::fs::symlink(home.join(".genie"), &link).unwrap();
    for genie_home in [home.join(".genie"), link] {
        // `home` is no git repository, so it resolves to itself and to <GENIE_HOME>/genie.db.
        let err = open_store_at(&home, &genie_home).err().expect("the machine-scope database is refused");
        assert!(matches!(err, Error::GlobalDatabase(_)), "{err:?}");
        assert_eq!(err.exit_code(), 2);
    }
    assert_eq!(v7_tables(&home.join(".genie/genie.db")), Vec::<String>::new());
}

#[test]
fn a_linked_worktree_resolves_the_main_checkouts_database() {
    let tmp = Tmp::new("worktree");
    let repo = ts_repo(&tmp);
    let wt = tmp.0.join("repo.worktrees").join("gn-1-x");
    git(&repo, &["worktree", "add", "-q", "-b", "fix/gn-1-x", wt.to_str().unwrap()]);
    let store = open_store_at(&wt, &tmp.0.join("home")).unwrap();
    assert_eq!(store.project(), repo.to_str().unwrap());
    assert_eq!(store.db_path(), repo.join(".genie/genie.db"));
}

#[test]
fn two_untracked_prs_get_two_keys_and_never_refuse_each_other() {
    let tmp = Tmp::new("untracked");
    let repo = ts_repo(&tmp);
    let store = open_store_at(&repo, &tmp.0.join("home")).unwrap();
    let (a, b) = ("https://github.com/o/r/pull/7", "https://github.com/o/r/pull/8");
    for url in [a, b] {
        record(&store, store.project(), &opened("", url)).unwrap();
        let mut merged = opened("", url);
        merged.event = TaskEvent::Merged;
        merged.commit = "d".repeat(40);
        assert!(matches!(record(&store, store.project(), &merged).unwrap(), Recorded::Appended { .. }));
    }
    let tasks = store.tasks().unwrap();
    let keys: Vec<&str> = tasks.iter().map(|t| t.task_key.as_str()).collect();
    assert_eq!(keys, [format!("pr:github:{a}"), format!("pr:github:{b}")]);
    assert!(tasks.iter().all(|t| t.state == TaskState::Merged && t.task.is_empty()));
    assert_eq!(store.events().unwrap().len(), 4);
    let export = fs::read_to_string(tmp.0.join("home/tasks.jsonl")).unwrap();
    assert_eq!(export.matches("\"task\":null").count(), 4, "M3: no task id is JSON null");
    // An event with neither a task id nor a url has no key, and is not recorded under ''.
    let mut keyless = EventRow::new(TaskEvent::Opened);
    keyless.forge = "github".into();
    let err = record(&store, store.project(), &keyless).unwrap_err();
    assert_eq!(err.exit_code(), 1, "{err}");
}
