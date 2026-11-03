//! T4: 128 processes append distinct events to one repository's `genie.db` at once. The writers are
//! this test binary, re-executed through `std::env::current_exe()` under an env marker.

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use genie_tasks::{
    EventRow, StoredEvent, SystemClock, TaskEvent, TaskRow, apply, open_store, open_store_at,
    record, task_key,
};

const ROLE: &str = "GENIE_TASKS_T4_WRITER";
const WRITERS: usize = 128;
const TEST: &str = "one_hundred_twenty_eight_writers";

fn tmp_dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("genie-tasks-t4-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("repo/.genie")).unwrap();
    fs::canonicalize(dir).unwrap()
}

fn initialized_repo(repo: &Path) {
    assert!(
        Command::new("git")
            .args(["init", "-q", "-b", "main"])
            .current_dir(repo)
            .status()
            .unwrap()
            .success()
    );
    let db = rusqlite::Connection::open(repo.join(".genie/genie.db")).unwrap();
    db.execute_batch("PRAGMA journal_mode = WAL; CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); PRAGMA user_version = 1;")
        .unwrap();
}

/// Writer `i`: an even writer starts a tracked task and opens its PR; an odd one records an
/// untracked PR opening and merging. Two events each, after the shared start barrier.
fn writer(i: usize) {
    let repo = PathBuf::from(std::env::var("T4_REPO").unwrap());
    let go = PathBuf::from(std::env::var("T4_GO").unwrap());
    let deadline = Instant::now() + Duration::from_secs(60);
    while !go.exists() {
        assert!(Instant::now() < deadline, "the start barrier never opened");
        std::thread::sleep(Duration::from_millis(2));
    }
    let store = open_store(&repo).unwrap();
    let url = format!("https://github.com/o/r/pull/{i}");
    let mut first = EventRow::new(if i.is_multiple_of(2) {
        TaskEvent::Created
    } else {
        TaskEvent::Opened
    });
    first.forge = "github".into();
    first.title = format!("task {i}");
    first.lead = format!("b-{i}");
    let mut second = EventRow::new(if i.is_multiple_of(2) {
        TaskEvent::Opened
    } else {
        TaskEvent::Merged
    });
    second.forge = "github".into();
    second.url = url.clone();
    if i.is_multiple_of(2) {
        first.task = format!("gn-{i}");
        first.worktree = format!("/w/gn-{i}");
        first.commit = format!("{i:040}");
        second.task = first.task.clone();
        second.commit = format!("{:040}", i + 1);
    } else {
        first.url = url;
        first.commit = format!("{i:040}");
        second.commit = format!("{:040}", i + 2);
    }
    for row in [first, second] {
        record(&store, store.project(), &row).unwrap();
    }
}

/// `v7_tasks` as a replay of the events computes it, each key rebuilt from the row's own parts.
fn replay(events: &[StoredEvent]) -> Vec<TaskRow> {
    let mut tasks: BTreeMap<String, TaskRow> = BTreeMap::new();
    for e in events {
        let key = task_key(&e.task, &e.forge, &e.url).expect("every event has a key");
        assert_eq!(
            key, e.task_key,
            "L4: the stored key is the one its own forge and url give"
        );
        let prev = tasks.get(&key);
        let state = apply(prev.map(|t| t.state), &e.event, &SystemClock)
            .expect("a recorded event was accepted");
        let keep = |new: &str, old: Option<&String>| {
            if new.is_empty() {
                old.cloned().unwrap_or_default()
            } else {
                new.to_string()
            }
        };
        let row = TaskRow {
            project: e.project.clone(),
            task_key: key.clone(),
            task: e.task.clone(),
            state,
            title: keep(&e.title, prev.map(|t| &t.title)),
            lead: keep(&e.lead, prev.map(|t| &t.lead)),
            forge: keep(&e.forge, prev.map(|t| &t.forge)),
            url: keep(&e.url, prev.map(|t| &t.url)),
            branch: keep(&e.branch, prev.map(|t| &t.branch)),
            last_seq: e.seq,
            updated_at: e.at.clone(),
        };
        tasks.insert(key, row);
    }
    tasks.into_values().collect()
}

#[test]
fn one_hundred_twenty_eight_writers() {
    if let Ok(i) = std::env::var(ROLE) {
        writer(i.parse().unwrap());
        return;
    }
    let dir = tmp_dir();
    let (repo, home, go) = (dir.join("repo"), dir.join("home"), dir.join("go"));
    initialized_repo(&repo);
    let exe = std::env::current_exe().unwrap();
    let children: Vec<_> = (0..WRITERS)
        .map(|i| {
            Command::new(&exe)
                .args([TEST, "--exact", "--test-threads=1"])
                .env(ROLE, i.to_string())
                .env("GENIE_HOME", &home)
                .env("T4_REPO", &repo)
                .env("T4_GO", &go)
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap()
        })
        .collect();
    fs::write(&go, "").unwrap();
    for (i, child) in children.into_iter().enumerate() {
        let out = child.wait_with_output().unwrap();
        assert!(
            out.status.success(),
            "writer {i} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    let store = open_store_at(&repo, &home).unwrap();
    let events = store.events().unwrap();
    assert_eq!(events.len(), WRITERS * 2, "every event lands exactly once");
    let keys: HashSet<&str> = events.iter().map(|e| e.dedupe_key.as_str()).collect();
    assert_eq!(keys.len(), events.len());
    let per_task: HashSet<(&str, TaskEvent)> = events
        .iter()
        .map(|e| (e.task_key.as_str(), e.event))
        .collect();
    assert_eq!(
        per_task.len(),
        WRITERS * 2,
        "no writer's event is lost or doubled"
    );
    assert_eq!(
        store.tasks().unwrap(),
        replay(&events),
        "v7_tasks equals a replay of v7_task_events"
    );

    let text = fs::read_to_string(home.join("tasks.jsonl")).unwrap();
    assert!(text.ends_with('\n'), "no torn last line");
    let mut exported = HashSet::new();
    for line in text.lines() {
        let row: serde_json::Value =
            serde_json::from_str(line).unwrap_or_else(|e| panic!("torn line {line:?}: {e}"));
        assert!(
            exported.insert(row["dedupe_key"].as_str().unwrap().to_string()),
            "a row is exported twice: {line}"
        );
    }
    assert_eq!(
        exported.iter().map(String::as_str).collect::<HashSet<_>>(),
        keys,
        "tasks.jsonl holds each row once"
    );
    fs::remove_dir_all(&dir).unwrap();
}
