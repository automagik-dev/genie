//! T10: `export::rebuild` restores a project's rows, leaves other projects' rows alone, survives 16
//! concurrent appenders (re-executed test binaries), and reads events only under its lock (L3).

use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use genie_tasks::{EventRow, TaskEvent, open_store, open_store_at, rebuild, record};

const ROLE: &str = "GENIE_TASKS_T10_APPENDER";
const APPENDERS: usize = 16;
const PER_APPENDER: usize = 20;

static N: AtomicUsize = AtomicUsize::new(0);

fn tmp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "genie-tasks-{tag}-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    fs::canonicalize(dir).unwrap()
}

/// A git repository whose `.genie/genie.db` TS has initialized (`user_version = 1`).
fn repo(dir: &Path, name: &str) -> PathBuf {
    let repo = dir.join(name);
    fs::create_dir_all(repo.join(".genie")).unwrap();
    assert!(Command::new("git").args(["init", "-q", "-b", "main"]).current_dir(&repo).status().unwrap().success());
    let db = rusqlite::Connection::open(repo.join(".genie/genie.db")).unwrap();
    db.execute_batch(
        "PRAGMA journal_mode = WAL; CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); PRAGMA user_version = 1;",
    )
    .unwrap();
    repo
}

fn created(task: &str) -> EventRow {
    let mut row = EventRow::new(TaskEvent::Created);
    row.task = task.into();
    row.worktree = format!("/w/{task}");
    row.commit = "e".repeat(40);
    row.lead = "b-x".into();
    row
}

fn file(home: &Path) -> String {
    fs::read_to_string(home.join("tasks.jsonl")).unwrap_or_default()
}

fn project_of(line: &str) -> String {
    serde_json::from_str::<serde_json::Value>(line).unwrap()["project"].as_str().unwrap().to_string()
}

fn keys_of(text: &str, project: &str) -> Vec<String> {
    text.lines()
        .map(|l| serde_json::from_str::<serde_json::Value>(l).unwrap_or_else(|e| panic!("torn line {l:?}: {e}")))
        .filter(|v| v["project"] == project)
        .map(|v| v["dedupe_key"].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn rebuild_restores_a_projects_rows_and_leaves_the_others_alone() {
    let dir = tmp_dir("t10-restore");
    let home = dir.join("home");
    let (a, b) = (repo(&dir, "a"), repo(&dir, "b"));
    let (sa, sb) = (open_store_at(&a, &home).unwrap(), open_store_at(&b, &home).unwrap());
    for (store, tasks) in [(&sa, ["gn-1", "gn-2", "gn-3"].as_slice()), (&sb, ["gn-1", "gn-9"].as_slice())] {
        for task in tasks {
            record(store, store.project(), &created(task)).unwrap();
        }
    }
    let mut untracked = EventRow::new(TaskEvent::Opened);
    untracked.forge = "github".into();
    untracked.url = "https://github.com/o/a/pull/4".into();
    record(&sa, sa.project(), &untracked).unwrap();
    let foreign = r#"{"v":1,"event":"merged","project":"/elsewhere","task":null,"dedupe_key":"x"}"#;
    writeln!(OpenOptions::new().append(true).open(home.join("tasks.jsonl")).unwrap(), "{foreign}").unwrap();
    let original = file(&home);
    let rows_of = |text: &str, p: &str| -> String {
        text.lines().filter(|l| project_of(l) == p).map(|l| format!("{l}\n")).collect()
    };
    let (a_rows, others): (String, String) = (
        rows_of(&original, sa.project()),
        original.lines().filter(|l| project_of(l) != sa.project()).map(|l| format!("{l}\n")).collect(),
    );
    assert_eq!(a_rows.lines().count(), 4);
    assert!(a_rows.contains("\"task\":null"), "M3: the untracked row's task is JSON null");

    let report = rebuild(&home, std::slice::from_ref(&a)).unwrap();
    assert_eq!(report.projects, [(sa.project().to_string(), 4)]);
    assert_eq!(report.kept, 3, "b's two rows and the foreign row");
    assert_eq!(file(&home), format!("{others}{a_rows}"), "other rows kept in place, a's rows rewritten byte for byte");

    fs::remove_file(home.join("tasks.jsonl")).unwrap();
    rebuild(&home, &[a.join(".")]).unwrap();
    assert_eq!(file(&home), a_rows, "after deleting tasks.jsonl, a's rows are restored exactly");
    let leftovers: Vec<_> =
        fs::read_dir(&home).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
    assert!(
        leftovers.iter().all(|n| n == "tasks.jsonl" || n == "tasks.jsonl.lock"),
        "no temp file left: {leftovers:?}"
    );
    fs::remove_dir_all(&dir).unwrap();
}

fn appender(i: usize) {
    let repo = PathBuf::from(std::env::var("T10_REPO").unwrap());
    let go = PathBuf::from(std::env::var("T10_GO").unwrap());
    let deadline = Instant::now() + Duration::from_secs(60);
    while !go.exists() {
        assert!(Instant::now() < deadline, "the start barrier never opened");
        std::thread::sleep(Duration::from_millis(2));
    }
    let store = open_store(&repo).unwrap();
    for j in 0..PER_APPENDER {
        record(&store, store.project(), &created(&format!("gn-{i}-{j}"))).unwrap();
    }
}

#[test]
fn rebuild_while_sixteen_processes_append() {
    if let Ok(i) = std::env::var(ROLE) {
        appender(i.parse().unwrap());
        return;
    }
    let dir = tmp_dir("t10-concurrent");
    let (home, go) = (dir.join("home"), dir.join("go"));
    let a = repo(&dir, "a");
    let exe = std::env::current_exe().unwrap();
    let mut children: Vec<_> = (0..APPENDERS)
        .map(|i| {
            Command::new(&exe)
                .args(["rebuild_while_sixteen_processes_append", "--exact", "--test-threads=1"])
                .env(ROLE, i.to_string())
                .env("GENIE_HOME", &home)
                .env("T10_REPO", &a)
                .env("T10_GO", &go)
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap()
        })
        .collect();
    fs::write(&go, "").unwrap();
    let mut rebuilds = 0;
    while rebuilds < 3 || children.iter_mut().any(|c| c.try_wait().unwrap().is_none()) {
        rebuild(&home, std::slice::from_ref(&a)).unwrap();
        rebuilds += 1;
    }
    for (i, child) in children.into_iter().enumerate() {
        let out = child.wait_with_output().unwrap();
        assert!(out.status.success(), "appender {i} failed: {}", String::from_utf8_lossy(&out.stderr));
    }

    let store = open_store_at(&a, &home).unwrap();
    let committed: HashSet<String> = store.events().unwrap().into_iter().map(|e| e.dedupe_key).collect();
    assert_eq!(committed.len(), APPENDERS * PER_APPENDER);
    let exported = keys_of(&file(&home), store.project());
    let deduped: HashSet<String> = exported.iter().cloned().collect();
    assert_eq!(deduped, committed, "every committed event is in the file at least once, and nothing else is");
    assert!(exported.len() >= committed.len());
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn rebuild_reads_the_events_only_after_it_holds_the_lock() {
    let dir = tmp_dir("t10-lock");
    let (home, elsewhere) = (dir.join("home"), dir.join("elsewhere"));
    let a = repo(&dir, "a");
    let store = open_store_at(&a, &home).unwrap();
    record(&store, store.project(), &created("gn-1")).unwrap();
    // Hold the exclusive lock from a second open file description, as another rebuild would.
    let held = OpenOptions::new().read(true).write(true).open(home.join("tasks.jsonl.lock")).unwrap();
    held.lock().unwrap();
    let (h, r) = (home.clone(), a.clone());
    let waiting = std::thread::spawn(move || rebuild(&h, &[r]));
    std::thread::sleep(Duration::from_millis(500));
    assert!(!waiting.is_finished(), "rebuild waits for the exclusive lock");
    // Commit an event while rebuild waits; its own export row goes to another GENIE_HOME, so only
    // a rebuild that reads after taking the lock can put it in this file.
    let late = open_store_at(&a, &elsewhere).unwrap();
    let genie_tasks::Recorded::Appended { dedupe_key, .. } = record(&late, late.project(), &created("gn-2")).unwrap()
    else {
        panic!("gn-2 is new");
    };
    assert!(!waiting.is_finished());
    held.unlock().unwrap();
    waiting.join().unwrap().unwrap();
    let keys = keys_of(&file(&home), store.project());
    assert_eq!(keys.len(), 2);
    assert!(keys.contains(&dedupe_key), "the event committed while rebuild waited is in the rebuilt file");
    fs::remove_dir_all(&dir).unwrap();
}
