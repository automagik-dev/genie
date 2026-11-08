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
    assert_eq!(
        v7_tables(&db),
        ["v7_link_events", "v7_links", "v7_schema", "v7_task_events", "v7_task_ids", "v7_tasks"]
    );
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
    let rows: i64 = conn
        .query_row("SELECT count(*) FROM v7_schema WHERE version = ?1", [genie_tasks::SCHEMA_VERSION], |r| r.get(0))
        .unwrap();
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

/// Fixed-clock receipts for every time field, including restarts whose legacy timestamps
/// intentionally still describe the first PR and the latest worktree.
#[test]
fn board_time_fields_follow_the_current_pr_epoch_and_first_creation() {
    use genie_tasks::{FixedClock, TaskEvent as E};
    let tmp = Tmp::new("board-time");
    let repo = ts_repo(&tmp);
    let home = tmp.0.join("home");
    let store = open_store_at(&repo, &home).unwrap().with_clock(Box::new(FixedClock("2026-11-08T12:00:59Z".into())));
    struct Case<'a> {
        task: &'a str,
        events: &'a [(TaskEvent, &'a str)],
        expected: (Option<i64>, Option<i64>, Option<i64>),
    }
    let cases = [
        Case { task: "gn-1", events: &[(E::Created, "2026-11-08T10:00:00Z")], expected: (Some(120), None, None) },
        Case { task: "gn-2", events: &[(E::Opened, "2026-11-08T11:00:00Z")], expected: (None, Some(60), None) },
        Case {
            task: "gn-3",
            events: &[(E::Opened, "2026-11-08T10:00:00Z"), (E::Merged, "2026-11-08T11:30:59Z")],
            expected: (None, None, Some(90)),
        },
        Case {
            task: "gn-4",
            events: &[(E::Opened, "2026-11-08T10:00:00Z"), (E::Closed, "2026-11-08T11:00:00Z")],
            expected: (None, None, Some(60)),
        },
        Case { task: "gn-5", events: &[(E::Merged, "2026-11-08T11:00:00Z")], expected: (None, None, None) },
        Case { task: "gn-6", events: &[(E::Closed, "2026-11-08T11:00:00Z")], expected: (None, None, None) },
        Case {
            task: "gn-7",
            events: &[(E::Opened, "2026-11-08T11:00:00Z"), (E::Merged, "2026-11-08T10:00:00Z")],
            expected: (None, None, None),
        },
        Case {
            task: "gn-8",
            events: &[(E::Opened, "2026-11-08T11:00:00Z"), (E::Closed, "2026-11-08T10:00:00Z")],
            expected: (None, None, None),
        },
        Case {
            task: "gn-9",
            events: &[(E::Created, "2026-11-08T13:00:00Z"), (E::Opened, "2026-11-08T13:01:00Z")],
            expected: (None, None, None),
        },
        Case { task: "gn-10", events: &[(E::Opened, "invalid")], expected: (None, None, None) },
        Case {
            task: "gn-11",
            events: &[(E::Opened, "2026-11-08T11:00:00Z"), (E::Merged, "2026-11-08T11:00:00Z")],
            expected: (None, None, Some(0)),
        },
        Case {
            task: "gn-12",
            events: &[(E::Opened, "2026-11-08T11:00:00.900Z"), (E::Closed, "2026-11-08T11:01:00.100Z")],
            expected: (None, None, Some(0)),
        },
        Case { task: "gn-13", events: &[(E::Opened, "2026-11-08T13:00:00+02:00")], expected: (None, Some(60), None) },
        Case { task: "gn-14", events: &[(E::Created, "")], expected: (None, None, None) },
        Case { task: "gn-15", events: &[(E::Opened, "")], expected: (None, None, None) },
        Case {
            task: "gn-16",
            events: &[(E::Opened, "2026-11-08T11:00:00Z"), (E::Closed, "invalid")],
            expected: (None, None, None),
        },
        Case { task: "gn-17", events: &[(E::Created, "invalid")], expected: (None, None, None) },
    ];
    for Case { task, events, expected } in &cases {
        for (event, at) in *events {
            let mut row = opened(task, &format!("https://github.com/o/r/pull/{task}"));
            row.event = *event;
            row.at = Some((*at).into());
            record(&store, store.project(), &row).unwrap();
        }
        let listed = store.listed().unwrap().into_iter().find(|l| l.row.task == *task).unwrap();
        assert_eq!((listed.age_min, listed.pr_open_min, listed.pr_lead_min), *expected, "{task}");
    }
    // Reading twice cannot alter the event ledger or the unchanged v1 export.
    let before = fs::read(home.join("tasks.jsonl")).unwrap();
    assert_eq!(store.listed().unwrap(), store.listed().unwrap());
    assert_eq!(fs::read(home.join("tasks.jsonl")).unwrap(), before);
}

#[test]
fn a_restart_discards_old_pr_endpoints_but_keeps_the_tasks_first_age() {
    use genie_tasks::{FixedClock, TaskEvent as E};
    let tmp = Tmp::new("board-restart");
    let repo = ts_repo(&tmp);
    let store = open_store_at(&repo, &tmp.0.join("home"))
        .unwrap()
        .with_clock(Box::new(FixedClock("2026-11-08T12:00:00Z".into())));
    for (event, at, expected) in [
        (E::Created, "2026-11-08T08:00:00Z", (Some(240), None, None)),
        (E::Opened, "2026-11-08T08:10:00Z", (Some(240), Some(230), None)),
        (E::Closed, "2026-11-08T09:00:00Z", (Some(240), None, Some(50))),
        (E::Created, "2026-11-08T10:00:00Z", (Some(240), None, None)),
        // First observed merged in the restarted epoch: the old opening cannot be borrowed.
        (E::Merged, "2026-11-08T11:00:00Z", (Some(240), None, None)),
    ] {
        let mut row = opened("gn-1", "https://github.com/o/r/pull/1");
        row.event = event;
        row.at = Some(at.into());
        row.commit = at.into();
        record(&store, store.project(), &row).unwrap();
        let l = store.listed().unwrap().remove(0);
        assert_eq!((l.age_min, l.pr_open_min, l.pr_lead_min), expected, "{event:?}");
    }
    for terminal in [E::Merged, E::Closed] {
        let task = if terminal == E::Merged { "gn-2" } else { "gn-3" };
        for (event, at) in [
            (E::Opened, "2026-11-08T08:00:00Z"),
            (E::Closed, "2026-11-08T09:00:00Z"),
            (E::Created, "2026-11-08T10:00:00Z"),
            (E::Opened, "2026-11-08T11:00:00Z"),
            (terminal, "2026-11-08T11:30:00Z"),
        ] {
            let mut row = opened(task, &format!("https://github.com/o/r/pull/{task}"));
            row.event = event;
            row.at = Some(at.into());
            row.commit = at.into();
            record(&store, store.project(), &row).unwrap();
            let l = store.listed().unwrap().into_iter().find(|l| l.row.task == task).unwrap();
            if event == E::Opened && at.contains("11:00") {
                assert_eq!(l.pr_open_min, Some(60), "current opening, not the old one");
            }
        }
        let l = store.listed().unwrap().into_iter().find(|l| l.row.task == task).unwrap();
        assert_eq!((l.age_min, l.pr_open_min, l.pr_lead_min), (Some(120), None, Some(30)));
    }

    // Reversed wall clocks do not change which creation/opening belongs to the restarted PR.
    for (event, at) in [
        (E::Created, "2026-11-08T10:00:00Z"),
        (E::Opened, "2026-11-08T10:10:00Z"),
        (E::Closed, "2026-11-08T11:00:00Z"),
        (E::Created, "2026-11-08T08:00:00Z"),
        (E::Opened, "2026-11-08T08:10:00Z"),
        (E::Merged, "2026-11-08T09:00:00Z"),
    ] {
        let mut row = opened("gn-4", "https://github.com/o/r/pull/4");
        row.event = event;
        row.at = Some(at.into());
        row.commit = at.into();
        record(&store, store.project(), &row).unwrap();
    }
    let l = store.listed().unwrap().into_iter().find(|l| l.row.task == "gn-4").unwrap();
    assert_eq!((l.age_min, l.pr_open_min, l.pr_lead_min), (Some(120), None, Some(50)));
}

#[test]
fn board_durations_validate_endpoints_and_preserve_submillisecond_precision() {
    use genie_tasks::{FixedClock, TaskEvent as E};
    let cases = [
        ("2026-11-08T11:00:00.0004Z", "2026-11-08T11:01:00.0000Z", Some(0)),
        ("2026-11-08T11:00:00.0004Z", "2026-11-08T11:00:00.0000Z", None),
        ("2026-11-08T11:00:00.0004Z", "2026-11-08T11:01:00.0004Z", Some(1)),
        ("2026-11-08T11:00:00.9999Z", "2026-11-08T11:01:00.9998Z", Some(0)),
        ("2026-11-08T11:00:00.0000000000001Z", "2026-11-08T11:01:00Z", Some(0)),
        ("2026-11-08T11:00:00.1Z", "2026-11-08T11:01:00.100000Z", Some(1)),
        ("2026-11-08T11:00:00.0004Z", "2026-11-08T13:01:00.0000+02:00", Some(0)),
        ("2026-02-30T11:00:00Z", "2026-03-02T12:00:00Z", None),
        ("2461352", "2026-11-08T12:00:00Z", None),
        ("now", "2026-11-08T12:00:00Z", None),
        ("2026-11-08T12:00:00Z", "now", None),
        ("2026-11-08T12:00:00Z", "2461352", None),
        ("2026-03-02T12:00:00Z", "2026-02-30T11:00:00Z", None),
        ("2026-02-29T11:00:00Z", "2026-03-01T12:00:00Z", None),
        ("2100-02-29T11:00:00Z", "2100-03-01T12:00:00Z", None),
        ("2000-02-29T11:00:00Z", "2000-02-29T12:00:00Z", Some(60)),
        ("2024-02-29T23:59:59.1Z", "2024-03-01T00:00:59.1000Z", Some(1)),
        ("2026-04-31T11:00:00Z", "2026-05-01T12:00:00Z", None),
        ("2026-11-08T24:00:00Z", "2026-11-09T01:00:00Z", None),
        ("2026-11-08T11:00:00+24:00", "2026-11-08T12:00:00Z", None),
        ("2026-11-08T11:00:00+00:60", "2026-11-08T12:00:00Z", None),
        ("2026-11-08T11:00:00.+02:00", "2026-11-08T12:00:00Z", None),
        ("2026-11-08 11:00:00Z", "2026-11-08T12:00:00Z", None),
    ];
    for (start, end, expected) in cases {
        let tmp = Tmp::new("precise-board-time");
        let repo = ts_repo(&tmp);
        let store = open_store_at(&repo, &tmp.0.join("home")).unwrap().with_clock(Box::new(FixedClock(end.into())));
        for (task, event, at) in [
            ("gn-1", E::Created, start),
            ("gn-2", E::Opened, start),
            ("gn-3", E::Opened, start),
            ("gn-3", E::Merged, end),
            ("gn-4", E::Opened, start),
            ("gn-4", E::Closed, end),
        ] {
            let mut row = opened(task, &format!("https://github.com/o/r/pull/{task}"));
            row.event = event;
            row.at = Some(at.into());
            record(&store, store.project(), &row).unwrap();
        }
        let durations: Vec<_> =
            store.listed().unwrap().iter().map(|l| (l.age_min, l.pr_open_min, l.pr_lead_min)).collect();
        assert_eq!(
            durations,
            [(expected, None, None), (None, expected, None), (None, None, expected), (None, None, expected)],
            "{start} -> {end}"
        );
    }
}

#[test]
fn link_schema_upgrade_is_additive_idempotent_and_preserves_v1_events() {
    let tmp = Tmp::new("links-upgrade");
    let repo = ts_repo(&tmp);
    let db = repo.join(".genie/genie.db");
    let home = tmp.0.join("home");
    let before = ts_snapshot(&db);
    // Frozen v1 schema: remove the new tables and restore its independent version marker.
    let v1 = SCHEMA_SQL.split("-- Link history").next().unwrap().replace("VALUES (1, 2)", "VALUES (1, 1)");
    Connection::open(&db).unwrap().execute_batch(&v1).unwrap();
    let reader = genie_tasks::store::open_store_read_at(&repo, &home).unwrap();
    assert!(reader.listed().unwrap().is_empty());
    assert_eq!(v7_tables(&db), ["v7_schema", "v7_task_events", "v7_task_ids", "v7_tasks"]);
    drop(reader);
    let conn = Connection::open(&db).unwrap();
    conn.execute("INSERT INTO v7_task_events (project, task_key, task, event, at, dedupe_key) VALUES (?1, 'gh-1', 'gh-1', 'created', '2026-11-08T00:00:00Z', 'legacy-key')", [repo.to_str().unwrap()]).unwrap();
    let event_snapshot: Vec<String> = conn
        .prepare("SELECT seq || ':' || task || ':' || event || ':' || dedupe_key FROM v7_task_events")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    drop(conn);
    for _ in 0..2 {
        let store = open_store_at(&repo, &home).unwrap();
        let events = store.events().unwrap();
        let after: Vec<String> =
            events.iter().map(|e| format!("{}:{}:{}:{}", e.seq, e.task, e.event.as_str(), e.dedupe_key)).collect();
        assert_eq!(after, event_snapshot);
        assert_eq!(ts_snapshot(&db), before);
        assert_eq!(v7_tables(&db).len(), 6);
    }
}
