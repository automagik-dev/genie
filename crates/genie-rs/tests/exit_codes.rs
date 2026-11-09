//! The `genie-rs` binary's exit codes (Decision 4), asserted here because only this package's tests
//! get `CARGO_BIN_EXE_genie-rs` (review LOW-3): T9's refusal (exit 2, the init remedy, no file left)
//! and T5's codes through the binary (0, the refused-transition 0 with one stderr line, the NUL 1,
//! the missing-gh 1). The fake forge is genie-forge's fixture, run with a PATH that holds it and git.

use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use genie_forge::client::{parse_time, rfc3339};
use genie_tasks::{EventRow, TaskEvent, open_store_at, record};
use serde_json::{Value, json};

static N: AtomicUsize = AtomicUsize::new(0);
const BIN: &str = env!("CARGO_BIN_EXE_genie-rs");

struct Fx {
    repo: PathBuf,
    home: PathBuf,
    bin: PathBuf,
}

fn git_path() -> PathBuf {
    let path = std::env::var_os("PATH").unwrap_or_default();
    std::env::split_paths(&path).map(|d| d.join("git")).find(|p| p.is_file()).expect("git on PATH")
}

/// A repository with a github `origin`, a TS-initialized `genie.db` unless `db` is false, and a bin
/// dir holding git plus the fake forge as `gh` and `glab`.
fn fixture(tag: &str, db: bool) -> Fx {
    let root = std::env::temp_dir().join(format!(
        "genie-rs-{tag}-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = fs::remove_dir_all(&root);
    let (repo, home, bin) = (root.join("repo"), root.join("home"), root.join("bin"));
    for dir in [&repo, &home, &bin] {
        fs::create_dir_all(dir).unwrap();
    }
    for args in [&["init", "-q", "-b", "main"][..], &["remote", "add", "origin", "https://github.com/o/r.git"]] {
        assert!(Command::new("git").args(args).current_dir(&repo).status().unwrap().success());
    }
    if db {
        fs::create_dir_all(repo.join(".genie")).unwrap();
        let conn = rusqlite::Connection::open(repo.join(".genie/genie.db")).unwrap();
        conn.execute_batch("PRAGMA journal_mode = WAL; CREATE TABLE meta (key TEXT); PRAGMA user_version = 1;")
            .unwrap();
    }
    symlink(git_path(), bin.join("git")).unwrap();
    let fake = Path::new(env!("CARGO_MANIFEST_DIR")).join("../genie-forge/tests/fixtures/fake-forge");
    for name in ["gh", "glab"] {
        fs::copy(&fake, bin.join(name)).unwrap();
        fs::set_permissions(bin.join(name), fs::Permissions::from_mode(0o755)).unwrap();
    }
    Fx { repo: fs::canonicalize(repo).unwrap(), home, bin }
}

impl Fx {
    fn run(&self, args: &[&str]) -> Output {
        self.run_home(args, &self.home)
    }

    fn run_home(&self, args: &[&str], home: &Path) -> Output {
        Command::new(BIN)
            .args(args)
            .current_dir(&self.repo)
            .env("GENIE_HOME", home)
            .env("PATH", &self.bin)
            .output()
            .unwrap()
    }

    fn serve(&self, prs: &[Value]) {
        fs::write(self.bin.join("list.json"), Value::Array(prs.to_vec()).to_string()).unwrap();
    }

    fn rows(&self) -> usize {
        fs::read_to_string(self.home.join("tasks.jsonl")).map_or(0, |t| t.lines().count())
    }
}

/// These tests' fixed dates, moved to yesterday with their time of day kept: the binary runs on the
/// wall clock, and forge-sync's first pass records nothing older than 30 days.
fn recent(at: &str) -> String {
    let day = |s: i64| s - s.rem_euclid(86_400);
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64;
    let at = parse_time(at).unwrap();
    rfc3339(at - day(at) + day(now) - 86_400)
}

fn pr(n: u64, branch: &str, state: &str, updated: &str) -> Value {
    let (created, updated) = (recent("2026-11-01T10:00:00Z"), recent(updated));
    json!({
        "number": n, "html_url": format!("https://github.com/o/r/pull/{n}"), "title": "fix: x",
        "state": if state == "open" { "open" } else { "closed" },
        "head": {"ref": branch, "sha": format!("head-{n}")}, "merge_commit_sha": format!("merge-{n}"),
        "created_at": created, "updated_at": updated,
        "merged_at": if state == "merged" { json!(updated) } else { Value::Null },
        "closed_at": if state == "open" { Value::Null } else { json!(updated) },
    })
}

fn code(out: &Output) -> i32 {
    out.status.code().expect("exited, not signalled")
}

fn stderr(out: &Output) -> String {
    String::from_utf8_lossy(&out.stderr).into_owned()
}

#[test]
fn t9_a_missing_or_uninitialized_db_and_the_global_path_refuse_with_2_and_leave_no_file() {
    let fx = fixture("no-db", false);
    for verb in [&["forge-sync"][..], &["list"], &["status", "gh-1"]] {
        let out = fx.run(verb);
        assert_eq!(code(&out), 2, "{verb:?}: {}", stderr(&out));
        assert!(stderr(&out).contains("run 'genie task list' once in this repository"), "{}", stderr(&out));
        assert!(!fx.repo.join(".genie").exists(), "{verb:?} created nothing");
    }
    assert!(!fx.bin.join("calls.log").exists(), "the refusal comes before any forge call");

    fs::create_dir_all(fx.repo.join(".genie")).unwrap();
    rusqlite::Connection::open(fx.repo.join(".genie/genie.db")).unwrap().execute_batch("CREATE TABLE t (x);").unwrap();
    let before = fs::read(fx.repo.join(".genie/genie.db")).unwrap();
    let out = fx.run(&["list"]);
    assert_eq!(code(&out), 2, "{}", stderr(&out));
    assert!(stderr(&out).contains("user_version = 0"));
    assert_eq!(fs::read(fx.repo.join(".genie/genie.db")).unwrap(), before, "a version-0 file stays byte-identical");

    let ts = fixture("global", true);
    let out = ts.run_home(&["list"], &ts.repo.join(".genie"));
    assert_eq!(code(&out), 2, "{}", stderr(&out));
    assert!(stderr(&out).contains("GENIE_HOME/genie.db"), "{}", stderr(&out));
}

#[test]
fn t5_forge_sync_exits_0_and_list_status_and_rebuild_read_what_it_recorded() {
    let fx = fixture("sync", true);
    fx.serve(&[pr(1, "feat/gh-11-add", "open", "2026-11-01T10:05:00Z")]);
    let out = fx.run(&["forge-sync", "--json"]);
    assert_eq!(code(&out), 0, "{}", stderr(&out));
    let report: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!((report["appended"].as_u64(), report["forge"].as_str()), (Some(1), Some("github")));

    let list: Value = serde_json::from_slice(&fx.run(&["list", "--json"]).stdout).unwrap();
    assert_eq!(list[0]["task"], "gh-11");
    assert_eq!((list[0]["state"].as_str(), list[0]["lane"].as_str()), (Some("opened"), Some("Review")));
    let status = fx.run(&["status", "gh-11", "--json"]);
    assert_eq!(code(&status), 0);
    let status: Value = serde_json::from_slice(&status.stdout).unwrap();
    assert_eq!(status["events"][0]["commit"], "head-1");
    assert_eq!(status["events"][0].get("pushed_after_open"), Some(&Value::Null), "only a merge carries the count");

    fs::remove_file(fx.home.join("tasks.jsonl")).unwrap();
    let rebuilt = fx.run(&["export", "--rebuild", "--project", fx.repo.to_str().unwrap()]);
    assert_eq!(code(&rebuilt), 0, "{}", stderr(&rebuilt));
    assert_eq!(fx.rows(), 1, "export --rebuild restores the row");
}

#[test]
fn t5_a_refused_transition_exits_0_with_one_stderr_line_and_commits_the_rest() {
    let fx = fixture("reopen", true);
    fx.serve(&[pr(30, "fix/gh-30-flaky", "closed", "2026-11-01T10:05:00Z")]);
    assert_eq!(code(&fx.run(&["forge-sync"])), 0);
    fs::remove_dir_all(fx.home.join("cache")).unwrap(); // expire the 60 s cache without sleeping
    fx.serve(&[
        pr(30, "fix/gh-30-flaky", "merged", "2026-11-01T10:09:00Z"),
        pr(31, "feat/gh-31-next", "open", "2026-11-01T10:07:00Z"),
    ]);
    let out = fx.run(&["forge-sync"]);
    assert_eq!(code(&out), 0, "{}", stderr(&out));
    let err = stderr(&out);
    assert_eq!(err.lines().count(), 1, "{err}");
    assert!(err.contains("gh-30") && err.contains("refused closed -> merged"), "{err}");
    assert_eq!(fx.rows(), 3, "the first PR's opened and closed rows plus the other PR's opened row");
}

#[test]
fn t5_a_nul_in_the_reply_and_a_missing_gh_exit_1_and_write_nothing() {
    let fx = fixture("nul", true);
    let mut bad = pr(2, "feat/gh-2-bad", "open", "2026-11-01T10:05:00Z");
    bad["head"]["sha"] = json!("head\u{0}2");
    fx.serve(&[pr(1, "feat/gh-1-ok", "open", "2026-11-01T10:04:00Z"), bad]);
    let out = fx.run(&["forge-sync"]);
    assert_eq!(code(&out), 1, "{}", stderr(&out));
    assert!(stderr(&out).contains("NUL"));
    assert_eq!(fx.rows(), 0);

    let fx = fixture("no-gh", true);
    fs::remove_file(fx.bin.join("gh")).unwrap();
    let out = fx.run(&["forge-sync"]);
    assert_eq!(code(&out), 1, "{}", stderr(&out));
    assert!(stderr(&out).contains("gh auth login"), "the git on PATH resolved origin, so gh is what is missing");
    assert_eq!(fx.rows(), 0);
}

#[test]
fn usage_errors_and_an_unknown_task_refuse_with_2() {
    let fx = fixture("usage", true);
    for args in [
        &[][..],
        &["frobnicate"],
        &["status"],
        &["list", "extra"],
        &["export"],
        &["forge-sync", "--bogus"],
        &["status", "gh-404"],
    ] {
        let out = fx.run(args);
        assert_eq!(code(&out), 2, "{args:?}: {}", stderr(&out));
        assert!(stderr(&out).starts_with("genie-rs: "), "{args:?}");
    }
    assert_eq!(code(&fx.run(&["--help"])), 0);
}

#[test]
fn the_stdio_seam_runs_the_same_dispatch() {
    let fx = fixture("stdio", true);
    let mut child = Command::new(env!("CARGO_BIN_EXE_genie-rs-stdio"))
        .current_dir(&fx.repo)
        .env("GENIE_HOME", &fx.home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    writeln!(stdin, "{}", json!({"argv": ["list", "--json"]})).unwrap();
    writeln!(stdin, "{}", json!({"argv": ["status", "gh-404"]})).unwrap();
    drop(stdin);
    let lines: Vec<Value> = BufReader::new(child.stdout.take().unwrap())
        .lines()
        .map(|l| serde_json::from_str(&l.unwrap()).unwrap())
        .collect();
    assert!(child.wait().unwrap().success());
    assert_eq!(lines[0], json!({"ready": true}));
    assert_eq!((lines[1]["code"].as_i64(), lines[1]["stdout"].as_str()), (Some(0), Some("[]\n")));
    assert_eq!(lines[2]["code"], 2);
}

#[test]
fn a_token_in_the_origin_url_reaches_neither_genie_home_nor_stderr() {
    const TOKEN: &str = "FAKE_TOKEN_77ab";
    let fx = fixture("token", true);
    let set_origin = |url: String| {
        let status = Command::new("git").args(["remote", "set-url", "origin", &url]).current_dir(&fx.repo).status();
        assert!(status.unwrap().success());
    };
    set_origin(format!("https://ci-user:{TOKEN}@github.com/o/r.git"));
    fx.serve(&[pr(30, "fix/gh-30-flaky", "closed", "2026-11-01T10:05:00Z")]);
    assert_eq!(code(&fx.run(&["forge-sync"])), 0);
    fs::remove_file(fx.home.join("tasks.jsonl")).unwrap();
    let forge_dir = fx.home.join("cache/forge");
    for entry in fs::read_dir(&forge_dir).unwrap() {
        let path = entry.unwrap().path();
        if !path.to_string_lossy().ends_with(".cursor.json") {
            fs::remove_file(path).unwrap(); // expire the reply, keep the cursor
        }
    }
    fx.serve(&[pr(30, "fix/gh-30-flaky", "merged", "2026-11-01T10:09:00Z")]);
    let out = fx.run(&["forge-sync"]);
    assert_eq!(code(&out), 0);
    assert!(stderr(&out).contains("refused closed -> merged"), "{}", stderr(&out));
    let mut files = 0;
    for entry in fs::read_dir(&forge_dir).unwrap() {
        let bytes = fs::read(entry.unwrap().path()).unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains(TOKEN));
        files += 1;
    }
    assert_eq!(files, 2, "the reply cache and the cursor");
    for out in [&out, &fx.run(&["forge-sync", "--json"])] {
        assert!(!stderr(out).contains(TOKEN) && !String::from_utf8_lossy(&out.stdout).contains(TOKEN));
    }

    set_origin(format!("https://ci-user:{TOKEN}@github.com"));
    let out = fx.run(&["forge-sync"]);
    assert_eq!(code(&out), 1, "{}", stderr(&out));
    assert!(stderr(&out).contains("names no forge host") && !stderr(&out).contains(TOKEN), "{}", stderr(&out));
}

/// Record `event` for `task` through the store, as `start` and forge-sync do.
fn seed(fx: &Fx, task: &str, event: TaskEvent, at: &str, worktree: &str) {
    let store = open_store_at(&fx.repo, &fx.home).unwrap();
    let mut row = EventRow::new(event);
    let n = &task[3..];
    row.task = task.to_string();
    row.title = format!("feat: task {n}");
    row.branch = format!("feat/{task}-x");
    row.lead = "bot".to_string();
    row.worktree = worktree.to_string();
    row.at = Some(at.to_string());
    row.commit = format!("{event:?}-{at}");
    if event != TaskEvent::Created {
        row.forge = "github".to_string();
        row.url = format!("https://github.com/o/r/pull/{n}");
    }
    record(&store, store.project(), &row).unwrap();
}

fn json_out(out: &Output) -> Value {
    assert_eq!(code(out), 0, "{}", stderr(out));
    serde_json::from_slice(&out.stdout).unwrap()
}

#[test]
fn t1_list_and_status_carry_the_lifecycle_timestamps_worktree_and_project() {
    let fx = fixture("fields", true);
    seed(&fx, "gh-1", TaskEvent::Created, "2026-11-02T09:00:00Z", "/wt/gh-1-x");
    seed(&fx, "gh-1", TaskEvent::Opened, "2026-11-02T09:10:00Z", "");
    seed(&fx, "gh-1", TaskEvent::Merged, "2026-11-02T09:20:00Z", "");
    seed(&fx, "gh-2", TaskEvent::Created, "2026-11-02T08:00:00Z", "/wt/gh-2-first");
    seed(&fx, "gh-2", TaskEvent::Closed, "2026-11-02T08:30:00Z", "");
    seed(&fx, "gh-2", TaskEvent::Created, "2026-11-02T10:00:00Z", "/wt/gh-2-second");
    seed(&fx, "gh-3", TaskEvent::Opened, "2026-11-02T11:00:00Z", "");

    let link = fx.repo.parent().unwrap().join("link");
    symlink(&fx.repo, &link).unwrap();
    let list = json_out(&fx.run(&["list", "--json", "--project", link.to_str().unwrap()]));
    let project = fx.repo.to_str().unwrap();
    let keys: Vec<&str> = list[0].as_object().unwrap().keys().map(String::as_str).collect();
    let mut expected = vec![
        "task",
        "task_key",
        "state",
        "lane",
        "title",
        "lead",
        "forge",
        "url",
        "branch",
        "updated_at",
        "created_at",
        "opened_at",
        "merged_at",
        "closed_at",
        "worktree",
        "project",
        "age_min",
        "task_open_min",
        "task_lead_min",
        "pr_open_min",
        "pr_lead_min",
    ];
    expected.sort_unstable();
    assert_eq!(keys, expected, "every old key kept, lifecycle and time fields added");
    let task = |id: &str| list.as_array().unwrap().iter().find(|t| t["task"] == id).unwrap().clone();
    let restarted = task("gh-2");
    assert_eq!(restarted["task_open_min"].as_i64(), restarted["age_min"].as_i64().map(|m| m - 120));
    assert!(restarted["pr_open_min"].is_null());
    let life =
        |t: &Value| ["created_at", "opened_at", "merged_at", "closed_at", "worktree", "project"].map(|k| t[k].clone());
    let (gh1, gh2, gh3) = (task("gh-1"), task("gh-2"), task("gh-3"));
    assert_eq!(
        life(&gh1),
        [
            json!("2026-11-02T09:00:00Z"),
            json!("2026-11-02T09:10:00Z"),
            json!("2026-11-02T09:20:00Z"),
            Value::Null,
            json!("/wt/gh-1-x"),
            json!(project),
        ]
    );
    assert_eq!((gh1["state"].as_str(), gh1["lane"].as_str()), (Some("merged"), Some("Merged")));
    assert_eq!(
        life(&gh2),
        [
            json!("2026-11-02T10:00:00Z"),
            Value::Null,
            Value::Null,
            json!("2026-11-02T08:30:00Z"),
            json!("/wt/gh-2-second"),
            json!(project),
        ],
        "a restart: the LATEST created row's at and worktree"
    );
    assert_eq!(
        life(&gh3),
        [Value::Null, json!("2026-11-02T11:00:00Z"), Value::Null, Value::Null, Value::Null, json!(project)],
        "a forge-first task has no created row"
    );

    let status = json_out(&fx.run(&["status", "gh-1", "--json"]));
    assert_eq!(life(&status), life(&gh1), "status --json carries the same six fields");
    assert_eq!(status["events"].as_array().unwrap().len(), 3);

    let text = fx.run(&["list"]);
    assert_eq!(code(&text), 0);
    assert_eq!(
        String::from_utf8_lossy(&text.stdout),
        "gh-1  merged  Merged  feat: task 1\ngh-2  created  Working  feat: task 2\ngh-3  opened  Review  feat: task 3\n",
        "the text output is unchanged"
    );
}

fn v7_tables(db: &Path) -> Vec<String> {
    let conn = rusqlite::Connection::open(db).unwrap();
    let mut stmt = conn.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'v7_%'").unwrap();
    stmt.query_map([], |r| r.get(0)).unwrap().collect::<Result<_, _>>().unwrap()
}

#[test]
fn t1b_list_and_status_run_no_write_statement() {
    let fx = fixture("read-only", true);
    let db = fx.repo.join(".genie/genie.db");
    let before = fs::read(&db).unwrap(); // the fixture's writer is closed: an empty WAL
    let list = fx.run(&["list", "--json"]);
    assert_eq!((code(&list), String::from_utf8_lossy(&list.stdout).as_ref()), (0, "[]\n"), "{}", stderr(&list));
    let status = fx.run(&["status", "gh-1", "--json"]);
    assert_eq!(code(&status), 2, "{}", stderr(&status));
    assert!(stderr(&status).contains("no v7 task gh-1"), "{}", stderr(&status));
    assert!(fs::read(&db).unwrap() == before, "a v5-only main file stays byte-identical");
    assert!(v7_tables(&db).is_empty(), "list and status create no v7_ table");

    // A WAL database copied without its sidecars still lists.
    seed(&fx, "gh-1", TaskEvent::Created, "2026-11-02T09:00:00Z", "/wt/gh-1-x");
    let main = fs::read(&db).unwrap();
    for suffix in ["", "-wal", "-shm"] {
        let _ = fs::remove_file(format!("{}{suffix}", db.display()));
    }
    fs::write(&db, &main).unwrap();
    assert_eq!((main[18], main[19]), (2, 2), "the copy is a WAL-mode database");
    let list = json_out(&fx.run(&["list", "--json"]));
    assert_eq!(list[0]["task"], "gh-1");
    assert!(fs::read(&db).unwrap() == main, "listing a sidecar-less WAL database leaves it byte-identical");

    // A newer v7 schema refuses with 2 before any read and leaves the file unchanged.
    rusqlite::Connection::open(&db).unwrap().execute_batch("UPDATE v7_schema SET version = 99").unwrap();
    let before = fs::read(&db).unwrap();
    for verb in [&["list", "--json"][..], &["status", "gh-1"]] {
        let out = fx.run(verb);
        assert_eq!(code(&out), 2, "{verb:?}: {}", stderr(&out));
        assert!(stderr(&out).contains("has v7 schema 99, newer than this build's"), "{}", stderr(&out));
    }
    assert!(fs::read(&db).unwrap() == before, "a newer-schema file stays byte-identical");
}

#[test]
fn full_is_in_the_help_with_its_cost_and_forge_sync_help_still_refuses() {
    let fx = fixture("help", true);
    let help = fx.run(&["help"]);
    assert_eq!(code(&help), 0);
    let usage = String::from_utf8_lossy(&help.stdout).into_owned();
    let line = usage.lines().find(|l| l.trim_start().starts_with("forge-sync ")).unwrap();
    assert!(line.contains("[--full]"), "{line}");
    assert!(usage.contains("one count call per merged PR/MR"), "{usage}");
    assert!(usage.contains("thousands on a large repository"), "{usage}");

    let out = fx.run(&["forge-sync", "--help"]);
    assert_eq!(code(&out), 2);
    assert!(stderr(&out).contains("unknown option '--help'") && stderr(&out).contains(line), "{}", stderr(&out));
    for args in [&["forge-sync", "--bogus"][..], &["list", "--full"], &["status", "gh-1", "--full"]] {
        let out = fx.run(args);
        assert_eq!(code(&out), 2, "{args:?}: {}", stderr(&out));
        assert!(stderr(&out).contains("unknown option"), "{args:?}");
    }
}

#[test]
fn a_nul_on_page_2_exits_1_keeps_page_1_and_says_only_that_page_was_not_written() {
    let fx = fixture("nul-page-2", true);
    let page1: Vec<Value> = (1..=100).rev().map(|n| pr(n, "chore/paged", "open", "2026-11-01T10:05:00Z")).collect();
    fs::write(fx.bin.join("list-1.json"), Value::Array(page1).to_string()).unwrap();
    let mut bad = pr(101, "chore/paged", "open", "2026-11-01T10:04:00Z");
    bad["head"]["sha"] = json!("head\u{0}101");
    fs::write(fx.bin.join("list-2.json"), Value::Array(vec![bad]).to_string()).unwrap();

    let out = fx.run(&["forge-sync"]);
    assert_eq!(code(&out), 1, "{}", stderr(&out));
    let err = stderr(&out);
    assert!(err.contains("#101 carries a NUL byte"), "{err}");
    assert!(err.contains("no events from this page were written; earlier pages may have committed"), "{err}");
    assert!(!err.contains("nothing was written"), "the pass did write page 1: {err}");
    assert_eq!(fx.rows(), 100, "page 1's rows persist in tasks.jsonl");
    let list = json_out(&fx.run(&["list", "--json"]));
    assert_eq!(list.as_array().unwrap().len(), 100, "page 1's tasks persist in genie.db");
}

#[test]
fn board_time_fields_are_shared_by_list_and_status_without_changing_export_v1() {
    let fx = fixture("time-json", true);
    for (task, event, at) in [
        ("gn-1", TaskEvent::Created, "2026-11-02T09:00:00Z"),
        ("gn-1", TaskEvent::Opened, "2026-11-02T09:10:00Z"),
        ("gn-1", TaskEvent::Closed, "2026-11-02T09:40:59Z"),
        ("gn-2", TaskEvent::Merged, "2026-11-02T09:40:00Z"),
        ("gn-3", TaskEvent::Opened, "2026-11-02T09:00:00Z"),
    ] {
        seed(&fx, task, event, at, "");
    }
    let before = fs::read(fx.home.join("tasks.jsonl")).unwrap();
    let list_out = fx.run(&["list", "--json"]);
    assert!(list_out.stderr.is_empty());
    let list = json_out(&list_out);
    for task in list.as_array().unwrap() {
        let status_out = fx.run(&["status", task["task"].as_str().unwrap(), "--json"]);
        assert!(status_out.stderr.is_empty());
        let status = json_out(&status_out);
        for key in ["age_min", "task_open_min", "task_lead_min", "pr_open_min", "pr_lead_min"] {
            assert!(task.get(key).is_some(), "{key} is present even when null");
            assert_eq!(task[key], status[key]);
        }
    }
    assert!(list[0]["age_min"].as_i64().unwrap() > 0);
    assert_eq!(list[0]["task_lead_min"], 40);
    assert!(list[0]["task_open_min"].is_null());
    assert_eq!(list[0]["pr_lead_min"], 30);
    assert!(list[0]["pr_open_min"].is_null());
    assert!(list[1]["task_lead_min"].is_null());
    assert!(list[2]["task_open_min"].is_null());
    assert!(list[1]["pr_lead_min"].is_null());
    assert!(list[2]["pr_open_min"].as_i64().unwrap() > 0);
    assert_eq!(fs::read(fx.home.join("tasks.jsonl")).unwrap(), before);
    for line in String::from_utf8(before).unwrap().lines() {
        let event: Value = serde_json::from_str(line).unwrap();
        assert_eq!(event["v"], 1);
        assert!(
            event.get("age_min").is_none()
                && event.get("pr_lead_min").is_none()
                && event.get("task_open_min").is_none()
                && event.get("task_lead_min").is_none()
        );
    }
}

#[test]
fn linking_replays_without_rewriting_history_and_survives_sync_and_rebuild() {
    let fx = fixture("link-replay", true);
    let url = "https://github.com/o/r/pull/731";
    let untouched = "https://github.com/o/r/pull/732";
    fx.serve(&[
        pr(731, "feat/existing-731", "open", "2026-11-01T12:00:00Z"),
        pr(732, "fix/incidental-732", "open", "2026-11-01T12:00:00Z"),
    ]);
    let out = fx.run(&["forge-sync"]);
    assert_eq!(code(&out), 0, "{}", stderr(&out));
    let store = open_store_at(&fx.repo, &fx.home).unwrap();
    let history = store.events().unwrap();
    assert!(history.iter().all(|e| e.task.is_empty()));
    let mut started = EventRow::new(TaskEvent::Created);
    started.task = "gn-1".into();
    started.branch = "feat/gn-1-started".into();
    started.worktree = "/isolated/gn-1".into();
    record(&store, store.project(), &started).unwrap();
    let life_before = store.events().unwrap();

    let out = fx.run(&["link", "gn-1", "--pr", url, "--json"]);
    assert_eq!(code(&out), 0, "{}", stderr(&out));
    assert!(stderr(&out).is_empty());
    assert_eq!(serde_json::from_slice::<Value>(&out.stdout).unwrap()["changed"], true);
    for args in [vec!["list"], vec!["status", "gn-1"]] {
        let text = fx.run(&args);
        assert_eq!(code(&text), 0, "{}", stderr(&text));
        assert!(
            String::from_utf8_lossy(&text.stdout).lines().any(|line| line.starts_with("gn-1  ")),
            "{args:?} hides the linked ID: {}",
            String::from_utf8_lossy(&text.stdout)
        );
    }
    let rows = fx.rows();
    let again = fx.run(&["link", "gn-1", "--pr", url, "--json"]);
    assert_eq!(code(&again), 0, "{}", stderr(&again));
    assert_eq!(serde_json::from_slice::<Value>(&again.stdout).unwrap()["changed"], false);
    assert_eq!(fx.rows(), rows);
    let conflict = fx.run(&["link", "gh-9", "--pr", url]);
    assert_eq!(code(&conflict), 2);
    assert!(stderr(&conflict).contains("gn-1") && stderr(&conflict).contains("unlink"));
    assert!(conflict.stdout.is_empty());
    assert_eq!(fx.rows(), rows);
    assert_eq!(store.events().unwrap(), life_before, "lifecycle history stays byte for byte");

    let linked = fx.run(&["status", "gn-1", "--json"]);
    assert_eq!(code(&linked), 0, "{}", stderr(&linked));
    let status: Value = serde_json::from_slice(&linked.stdout).unwrap();
    assert_eq!((status["task"].as_str(), status["url"].as_str()), (Some("gn-1"), Some(url)));
    assert_eq!(status["worktree"], "/isolated/gn-1");
    let list = || -> Vec<Value> {
        let out = fx.run(&["list", "--json"]);
        assert_eq!(code(&out), 0, "{}", stderr(&out));
        serde_json::from_slice(&out.stdout).unwrap()
    };
    let tasks = list();
    assert_eq!(tasks.len(), 2, "the created card joins its linked PR");
    assert!(tasks.iter().find(|t| t["url"] == untouched).unwrap()["task"].is_null());
    assert_eq!(code(&fx.run(&["forge-sync"])), 0);
    assert_eq!(list(), tasks);
    fx.serve(&[
        pr(731, "feat/existing-731", "merged", "2026-11-01T14:00:00Z"),
        pr(732, "fix/incidental-732", "open", "2026-11-01T12:00:00Z"),
    ]);
    let out = fx.run(&["forge-sync", "--full"]);
    assert_eq!(code(&out), 0, "{}", stderr(&out));
    let merged = list().into_iter().find(|t| t["url"] == url).unwrap();
    assert_eq!((merged["task"].as_str(), merged["state"].as_str()), (Some("gn-1"), Some("merged")));
    let original = fs::read(fx.home.join("tasks.jsonl")).unwrap();
    let exported: Vec<Value> =
        String::from_utf8(original.clone()).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect();
    assert!(exported.iter().any(|e| e["event"] == "link" && e["task"] == "gn-1"));
    assert!(exported.iter().any(|e| e["event"] == "merged" && e["task"] == "gn-1"));
    fs::remove_file(fx.home.join("tasks.jsonl")).unwrap();
    let out = fx.run(&["export", "--rebuild", "--project", fx.repo.to_str().unwrap()]);
    assert_eq!(code(&out), 0, "{}", stderr(&out));
    assert_eq!(fs::read(fx.home.join("tasks.jsonl")).unwrap(), original);
    assert_eq!(code(&fx.run(&["unlink", "gn-1", "--pr", url])), 0);
    assert!(list().iter().find(|t| t["url"] == url).unwrap()["task"].is_null());
    let untracked_key = format!("pr:github:{url}");
    for args in [vec!["list"], vec!["status", untracked_key.as_str()]] {
        let text = fx.run(&args);
        assert_eq!(code(&text), 0, "{}", stderr(&text));
        assert!(
            String::from_utf8_lossy(&text.stdout).lines().any(|line| line.starts_with(&format!("{untracked_key}  ")))
        );
    }
    let rows = fx.rows();
    assert_eq!(code(&fx.run(&["unlink", "gn-1", "--pr", url])), 0);
    assert_eq!(fx.rows(), rows);
    assert_eq!(code(&fx.run(&["link", "gl-92", "--pr", url])), 0);
    assert_eq!(list().iter().find(|t| t["url"] == url).unwrap()["task"], "gl-92");
    for args in [vec!["list"], vec!["status", "gl-92"]] {
        let text = fx.run(&args);
        assert_eq!(code(&text), 0, "{}", stderr(&text));
        assert!(String::from_utf8_lossy(&text.stdout).lines().any(|line| line.starts_with("gl-92  ")));
    }
    assert_eq!(code(&fx.run(&["unlink", "gl-92", "--pr", url])), 0);
    assert_eq!(code(&fx.run(&["link", "gn-1", "--pr", url])), 0, "a relink appends a new event");
    let before = fs::read(fx.home.join("tasks.jsonl")).unwrap();
    assert_eq!(code(&fx.run(&["export", "--rebuild", "--project", fx.repo.to_str().unwrap()])), 0);
    assert_eq!(fs::read(fx.home.join("tasks.jsonl")).unwrap(), before);
}

#[test]
fn branch_links_refuse_ambiguous_reuse_and_cross_target_conflicts() {
    let fx = fixture("link-branch", true);
    let url = "https://github.com/o/r/pull/51";
    assert_eq!(code(&fx.run(&["link", "gh-3", "--branch", "feat/old-name"])), 0);
    fx.serve(&[pr(51, "feat/old-name", "open", "2026-11-01T12:00:00Z")]);
    assert_eq!(code(&fx.run(&["forge-sync"])), 0);
    let out = fx.run(&["status", "gh-3", "--json"]);
    assert_eq!(code(&out), 0, "{}", stderr(&out));
    assert_eq!(serde_json::from_slice::<Value>(&out.stdout).unwrap()["url"], url);
    let exported: Vec<Value> = fs::read_to_string(fx.home.join("tasks.jsonl"))
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    let opened = exported.iter().find(|e| e["event"] == "opened").unwrap();
    assert_eq!(opened["task"], "gh-3");
    assert!(
        opened.get("original_task").unwrap().is_null(),
        "unlink can restore null even when the first sighting was linked"
    );
    let before = fs::read(fx.home.join("tasks.jsonl")).unwrap();
    assert_eq!(code(&fx.run(&["export", "--rebuild", "--project", fx.repo.to_str().unwrap()])), 0);
    assert_eq!(fs::read(fx.home.join("tasks.jsonl")).unwrap(), before);
    let conflict = fx.run(&["link", "gl-4", "--pr", url]);
    assert_eq!(code(&conflict), 2);
    assert!(stderr(&conflict).contains("gh-3"));
    assert_eq!(code(&fx.run(&["unlink", "gh-3", "--branch", "feat/old-name"])), 0);
    assert_eq!(code(&fx.run(&["link", "gl-4", "--pr", url])), 0);
    let conflict = fx.run(&["link", "gh-3", "--branch", "feat/old-name"]);
    assert_eq!(code(&conflict), 2);
    assert!(stderr(&conflict).contains("gl-4"));
    assert_eq!(code(&fx.run(&["unlink", "gl-4", "--pr", url])), 0);
    fx.serve(&[
        pr(51, "feat/old-name", "merged", "2026-11-01T14:00:00Z"),
        pr(52, "feat/old-name", "open", "2026-11-01T15:00:00Z"),
    ]);
    assert_eq!(code(&fx.run(&["forge-sync", "--full"])), 0);
    let ambiguous = fx.run(&["link", "gh-3", "--branch", "feat/old-name"]);
    assert_eq!(code(&ambiguous), 2);
    assert!(stderr(&ambiguous).contains("multiple PRs"));
    assert_eq!(code(&fx.run(&["link", "gh-3", "--pr", url])), 0);
}

#[test]
fn a_future_branch_reuse_keeps_attribution_unknown_until_prs_are_linked_explicitly() {
    let fx = fixture("link-future-reuse", true);
    assert_eq!(code(&fx.run(&["link", "gh-17", "--branch", "fix/reused"])), 0);
    fx.serve(&[
        pr(81, "fix/reused", "open", "2026-11-01T12:00:00Z"),
        pr(82, "fix/reused", "open", "2026-11-01T12:00:00Z"),
    ]);
    assert_eq!(code(&fx.run(&["forge-sync"])), 0);
    let out = fx.run(&["list", "--json"]);
    let tasks: Vec<Value> = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(tasks.len(), 2);
    assert!(tasks.iter().all(|t| t["task"].is_null()));
}

#[test]
fn link_usage_project_isolation_and_export_failures_have_the_promised_codes() {
    let a = fixture("link-project-a", true);
    let b = fixture("link-project-b", true);
    let url = "https://github.com/o/r/pull/9";
    let store = open_store_at(&a.repo, &a.home).unwrap();
    let mut created = EventRow::new(TaskEvent::Created);
    created.task = "gn-7".into();
    record(&store, store.project(), &created).unwrap();
    for args in [
        vec!["link", "gn-7", "--pr", url, "--project", b.repo.to_str().unwrap()],
        vec!["link", "gn-999", "--pr", url],
        vec!["link", "gh-0", "--pr", url],
        vec!["link", "gh-01", "--pr", url],
        vec!["link", "task-12", "--pr", url],
        vec!["link", "gh-1", "--pr", "not-a-url"],
        vec!["link", "gh-1", "--branch", ""],
        vec!["link", "gh-1", "--branch", "bad\nbranch"],
        vec!["link", "gh-1", "--pr", url, "--branch", "main"],
        vec!["link", "gh-1"],
        vec!["unlink", "gh-1", "--pr"],
    ] {
        let out = a.run(&args);
        assert_eq!(code(&out), 2, "{args:?}: {}", stderr(&out));
        assert!(!stderr(&out).is_empty());
        assert!(out.stdout.is_empty());
    }
    assert_eq!(code(&a.run(&["link", "gn-7", "--pr", url])), 0);
    assert!(open_store_at(&b.repo, &b.home).unwrap().tasks().unwrap().is_empty());
    // A gh/gl id is accepted locally even when no forge client is installed or queried.
    assert_eq!(code(&b.run(&["link", "gh-44", "--pr", url])), 0);
    assert_eq!(code(&b.run(&["link", "gl-44", "--branch", "fix/offline"])), 0);
    assert!(!b.bin.join("calls.log").exists());
    fs::remove_file(b.home.join("tasks.jsonl")).unwrap();
    fs::create_dir(b.home.join("tasks.jsonl")).unwrap();
    let failed = b.run(&["link", "gh-45", "--branch", "fix/export-fails"]);
    assert_eq!(code(&failed), 1);
    assert!(stderr(&failed).contains("committed") && stderr(&failed).contains("export --rebuild"));
}

#[test]
fn simultaneous_conflicting_links_commit_only_one_owner() {
    let fx = fixture("link-race", true);
    // Initialize once so this test measures the competing link transaction, not DDL.
    drop(open_store_at(&fx.repo, &fx.home).unwrap());
    let mut children = Vec::new();
    for id in ["gh-31", "gl-32"] {
        children.push(
            Command::new(BIN)
                .args(["link", id, "--branch", "fix/race"])
                .current_dir(&fx.repo)
                .env("GENIE_HOME", &fx.home)
                .env("PATH", &fx.bin)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap(),
        );
    }
    let outputs: Vec<_> = children.into_iter().map(|c| c.wait_with_output().unwrap()).collect();
    let mut codes: Vec<_> = outputs.iter().map(code).collect();
    codes.sort();
    assert_eq!(codes, [0, 2], "{outputs:?}");
    assert!(outputs.iter().find(|o| code(o) == 2).is_some_and(|o| stderr(o).contains("unlink")));
    assert_eq!(fx.rows(), 1);
}

#[test]
fn link_refusals_and_absent_unlinks_do_not_install_or_migrate_rust_schema() {
    let fx = fixture("link-refusal-no-migration", true);
    let db = fx.repo.join(".genie/genie.db");
    for v1 in [false, true] {
        if v1 {
            let sql = genie_tasks::SCHEMA_SQL
                .split("-- Link history")
                .next()
                .unwrap()
                .replace("VALUES (1, 2)", "VALUES (1, 1)");
            rusqlite::Connection::open(&db).unwrap().execute_batch(&sql).unwrap();
        }
        let before = fs::read(&db).unwrap();
        let no_task = fx.run(&["link", "gn-999", "--branch", "fix/unknown"]);
        assert_eq!(code(&no_task), 2, "{}", stderr(&no_task));
        assert!(stderr(&no_task).contains("not started in project"));
        let absent = fx.run(&["unlink", "gh-1", "--branch", "fix/absent", "--json"]);
        assert_eq!(code(&absent), 0, "{}", stderr(&absent));
        assert_eq!(serde_json::from_slice::<Value>(&absent.stdout).unwrap()["changed"], false);
        assert_eq!(fs::read(&db).unwrap(), before);
        let conn = rusqlite::Connection::open(&db).unwrap();
        let links: i64 = conn
            .query_row("SELECT count(*) FROM sqlite_master WHERE name IN ('v7_link_events', 'v7_links')", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(links, 0, "no schema install or migration on refusal/no-op");
    }
}

#[test]
fn tracked_restart_keeps_historical_branch_ambiguity_in_live_and_rebuilt_rows() {
    let fx = fixture("link-tracked-restart", true);
    let branch = "fix/gh-41-reused";
    let second_url = "https://github.com/o/r/pull/102";
    assert_eq!(code(&fx.run(&["link", "gh-9", "--branch", branch])), 0);
    fx.serve(&[pr(101, branch, "closed", "2026-11-01T12:00:00Z")]);
    assert_eq!(code(&fx.run(&["forge-sync", "--full"])), 0);
    let store = open_store_at(&fx.repo, &fx.home).unwrap();
    // The valid transition start records after close, on the same task and branch.
    let mut restart = EventRow::new(TaskEvent::Created);
    restart.task = "gh-41".into();
    restart.branch = branch.into();
    restart.worktree = "/isolated/restarted-gh-41".into();
    record(&store, store.project(), &restart).unwrap();
    fx.serve(&[pr(102, branch, "open", "2026-11-01T15:00:00Z")]);
    let sync = fx.run(&["forge-sync", "--full"]);
    assert_eq!(code(&sync), 0, "{}", stderr(&sync));
    let list = fx.run(&["list", "--json"]);
    assert_eq!(code(&list), 0, "{}", stderr(&list));
    let tasks: Vec<Value> = serde_json::from_slice(&list.stdout).unwrap();
    assert_eq!(tasks.len(), 1, "restart replaces the tracked task's current PR row");
    assert_eq!(tasks[0]["url"], second_url);
    assert!(tasks[0]["task"].is_null(), "the historical PR makes this branch ambiguous: {}", tasks[0]);
    let before = fs::read(fx.home.join("tasks.jsonl")).unwrap();
    let rows: Vec<Value> =
        String::from_utf8(before.clone()).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect();
    let opened = rows.iter().find(|e| e["event"] == "opened" && e["url"] == second_url).unwrap();
    assert!(opened["task"].is_null(), "live export must also preserve ambiguity");
    let rebuild = fx.run(&["export", "--rebuild", "--project", fx.repo.to_str().unwrap()]);
    assert_eq!(code(&rebuild), 0, "{}", stderr(&rebuild));
    assert_eq!(fs::read(fx.home.join("tasks.jsonl")).unwrap(), before);
    assert_eq!(code(&fx.run(&["unlink", "gh-9", "--branch", branch])), 0);
    let count = fx.rows();
    let ambiguous = fx.run(&["link", "gh-8", "--branch", branch]);
    assert_eq!(code(&ambiguous), 2, "{}", stderr(&ambiguous));
    assert!(stderr(&ambiguous).contains("multiple PRs"));
    assert!(ambiguous.stdout.is_empty());
    assert_eq!(fx.rows(), count, "historical ambiguity refusal appends nothing");
    assert_eq!(code(&fx.run(&["link", "gh-9", "--pr", second_url])), 0);
    let resolved = fx.run(&["status", "gh-9", "--json"]);
    assert_eq!(code(&resolved), 0, "{}", stderr(&resolved));
    assert_eq!(serde_json::from_slice::<Value>(&resolved.stdout).unwrap()["task"], "gh-9");
}
