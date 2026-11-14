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
            .env("METER_STATE_DIR", home.join("meter-state"))
            .env("PATH", &self.bin)
            .env("USAGEMETER_BIN", self.bin.join("usagemeter"))
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
        "meter_state",
        "meter_reason",
        "tokens",
        "cost",
        "activity_hours",
        "actors",
        "work_min",
        "branch_usage",
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

#[test]
fn meter_query_uses_repo_alias_isolates_branch_usage_and_keeps_db_readonly() {
    let fx = fixture("meter-d6", true);
    let git_ok = |args: &[&str]| {
        assert!(Command::new("git").args(args).current_dir(&fx.repo).status().unwrap().success());
    };
    git_ok(&["remote", "set-url", "origin", "https://github.com/automagik-si/genie.git"]);
    let today = recent("2026-11-11T10:00:00Z");
    for id in ["gn-1", "gn-2", "gn-3", "gn-4", "gn-5", "gn-8", "gn-9", "gn-10"] {
        seed(&fx, id, TaskEvent::Created, &today, &format!("/wt/{id}"));
    }
    seed(&fx, "gn-6", TaskEvent::Created, "2020-01-01T00:00:00Z", "/wt/gn-6");
    seed(&fx, "gn-7", TaskEvent::Created, "2020-01-01T00:00:00Z", "/wt/gn-7");

    // Envelopes and rows copy real `usagemeter query --json` output (3.129.x) and the meter's canonical
    // `meter/schema/query/v1/examples/*.json`, names made synthetic; all are schema-valid but gn-1's
    // deliberate unknown field.
    let env_json = |v: &str, status: &str, err: Value, rows: Value| {
        let ok = |x: Value| if status == "ok" { x } else { Value::Null };
        let branches: Vec<Value> = rows.as_array().unwrap().iter().filter_map(|r| r.get("branch").cloned()).collect();
        let mut query = json!({"repo": "github.com/automagik-si/genie", "repo_aliases": ["github.com/automagik-dev/genie"], "window": "d30", "branch_count": branches.len(), "branches": branches, "branches_complete": true, "request_sha256": "0".repeat(64)});
        if branches.is_empty() {
            query["by"] = json!("task");
        }
        json!({
            "contract": "usagemeter.query", "contract_version": 1, "capability": "meter.usage@1",
            "meter_version": v, "status": status, "error": err, "generated_at": "2026-11-11T15:00:00Z",
            "as_of": ok(json!("2026-11-11T14:55:00Z")),
            "machine": if matches!(status, "ok" | "too_large") { json!({"id": "0123456789abcdef0123456789abcdef", "scope": "local"}) } else { Value::Null },
            "store": if matches!(status, "usage" | "absent_store" | "locked" | "unsupported_contract") { Value::Null } else { json!({"schema_version": 3, "location": "current"}) },
            "ingestion": ok(json!({"watermark": "2026-11-11T14:55:00Z", "counted_from": "2026-10-03T00:00:00Z", "evidence_from": "2026-11-07T00:00:00Z", "complete": true, "backlog": {"bytes": 0, "files": 0}, "stale": false, "stale_after_s": 7200})),
            "window": ok(json!({"name": "d30", "requested_start": "2026-10-12T15:00:00Z", "start": "2026-10-12T15:00:00Z", "end": "2026-11-11T15:00:00Z", "clipped": false})),
            "sources": if status == "ok" { json!([{"harness": "claude-code", "status": "ok", "reason": null, "last_success": "2026-11-11T14:55:00Z", "stale": false}]) } else { json!([]) },
            "unattributed": ok(json!({"tokens_total": 0, "harnesses": []})),
            "actor_unattributed": ok(json!({"tokens_total": 0, "tokens_ambiguous": 0, "tokens_unlinked": 0, "tokens_before_evidence": 0, "parts": [], "absent_bot_is_zero": false})),
            "pricing": ok(json!({"table": {"origin": "bundled", "date": "2026-10-06", "source": "usagemeter bundled list prices", "label": "list prices, an estimate", "sha256": null}, "reported_wins": true, "long_prompt_tiers": false})),
            "query": if status == "usage" { Value::Null } else { query },
            "rows": rows
        })
        .to_string()
    };
    let tok_r = |n: u64, reasoning: Value| json!({"input": n / 2, "cache_read": 0, "cache_write_5m": 0, "cache_write_1h": 0, "output": n - (n / 2), "reasoning": reasoning, "unsplit": 0, "total": n});
    let tok = |n: u64| tok_r(n, json!(0));
    let cost = |state: &str, usd: Value, priced: u64, unpriced: u64, models: Value| json!({"state": state, "usd": usd, "usd_reported": if usd.is_null() { Value::Null } else { json!(0) }, "usd_estimated": usd, "tokens_priced": priced, "tokens_reported": 0, "tokens_unpriced": unpriced, "unpriced_models": models, "unpriced_models_omitted": 0});
    // What task and branch rows share; a row without tokens has no models, precision, actor block or activity.
    let body = |precision: &str, state: &str, reason: Value, tokens: Value, cost: Value, hours: u64| {
        let n = tokens["total"].as_u64();
        let (models, prec) = match n {
            Some(t) if t > 0 => (
                json!([{"model": "claude-opus-5-5", "calls": 12, "tokens": tokens, "cost_usd": cost["usd"]}]),
                json!("exact"),
            ),
            _ => (json!([]), Value::Null),
        };
        let mut attribution =
            json!({"precision": precision, "exclusive": false, "shared": false, "coverage": "complete"});
        if let Some(t) = n {
            attribution["actor"] = json!({"tokens_attributed": t, "tokens_ambiguous": 0, "tokens_unlinked": 0, "tokens_before_evidence": 0, "tokens_by_basis": {"session": t, "label": 0, "worktree": 0}, "tokens_by_branch_basis": {"log": t, "ledger": 0, "none": 0}});
        }
        let activity = n.map(|t| match t {
            0 => json!({"first_hour": null, "last_hour": null, "hours": 0, "harnesses": []}),
            _ => json!({"first_hour": "2026-11-11T09:00:00Z", "last_hour": "2026-11-11T12:00:00Z", "hours": hours, "harnesses": ["claude-code"]}),
        });
        json!({"state": state, "reason": reason, "tokens": tokens, "cost": cost, "models": models, "models_omitted": 0, "token_precision": prec, "attribution": attribution, "activity": activity, "incomplete_sources": []})
    };
    let task_row = |task: &str, actors: Value, state: &str, tokens: Value, cost: Value, hours: u64| {
        let reason = match state {
            "stale" => json!("ingestion_stale"),
            "missing" => json!("task_ambiguous"),
            _ => Value::Null,
        };
        let omitted = u64::from(actors.as_array().is_some_and(|a| a.is_empty()) && state != "missing");
        let mut r = body("task_interval", state, reason, tokens, cost, hours);
        (r["task"], r["actors"], r["actors_omitted"]) = (json!(task), actors, json!(omitted));
        r
    };
    let branch_row = |branch: &str, state: &str, reason: Value, tokens: Value, cost: Value| {
        let mut r = body("branch_window", state, reason, tokens, cost, 2);
        (r["branch"], r["requested"]) = (json!(branch), json!(1));
        r
    };
    let actor = |bot: &str, role: &str, harness: &str| json!({"bot": bot, "kind": "worker", "role": role, "squad": "b-lead", "unrecorded": [], "harness": harness});
    let write_bin = |name: &str, body: &str| fs::write(fx.bin.join(name), body).unwrap();
    let read_lines = |name: &str| -> Vec<String> {
        fs::read_to_string(fx.bin.join(name)).unwrap().lines().map(String::from).collect()
    };

    let mut gn1 = task_row(
        "gn-1",
        json!([actor("b-worker-1", "dev", "claude-code"), actor("b-worker-2", "review", "codex")]),
        "measured",
        tok_r(500, json!(120)),
        cost("priced", json!(3.75), 500, 0, json!([])),
        4,
    );
    gn1["future_row_field"] = json!(true);
    write_bin(
        "task-alias.json",
        &env_json(
            "3.129.2",
            "ok",
            Value::Null,
            json!([
                gn1,
                task_row(
                    "gn-2",
                    json!([actor("b-worker-1", "dev", "claude-code")]),
                    "measured",
                    tok_r(250, Value::Null),
                    cost("partial", json!(1.25), 150, 100, json!(["custom-model"])),
                    4
                ),
                task_row(
                    "gn-3",
                    json!([actor("b-lead", "dev", "claude-code")]),
                    "measured",
                    tok(600),
                    cost("unpriced", Value::Null, 0, 600, json!(["local-v1"])),
                    2
                ),
                task_row("gn-4", json!([]), "measured", tok(500), cost("priced", json!(0.0), 500, 0, json!([])), 1),
                task_row(
                    "gn-6",
                    json!([actor("b-worker-1", "dev", "claude-code")]),
                    "measured",
                    tok(180),
                    cost("priced", json!(0.90), 180, 0, json!([])),
                    1
                ),
                task_row("gn-9", json!([]), "missing", Value::Null, Value::Null, 0),
                task_row(
                    "gn-10",
                    json!([actor("b-worker-1", "dev", "claude-code")]),
                    "stale",
                    tok(300),
                    cost("priced", json!(9.99), 300, 0, json!([])),
                    2
                ),
            ]),
        ),
    );
    write_bin(
        "branch-alias.json",
        &env_json(
            "3.129.2",
            "ok",
            Value::Null,
            json!([
                branch_row(
                    "feat/gn-5-x",
                    "measured",
                    Value::Null,
                    tok(500),
                    cost("priced", json!(1.75), 500, 0, json!([]))
                ),
                branch_row("feat/gn-8-x", "zero", Value::Null, tok(0), cost("zero", json!(0.0), 0, 0, json!([])))
            ]),
        ),
    );

    let script = format!(
        "#!/bin/sh\ndir=\"{}\"\nprintf '%s\\n' \"$*\" >> \"$dir/meter.log\"\nemit() {{\n  rc=0\n  if [ -f \"$dir/exit.code\" ]; then IFS= read -r rc < \"$dir/exit.code\"; fi\n  while IFS= read -r line || [ -n \"$line\" ]; do\n    printf '%s\\n' \"$line\"\n    if [ \"$rc\" = \"0\" ]; then\n      case \"$line\" in\n        *'\"status\":\"usage\"'*) rc=2 ;;\n        *'\"status\":\"absent_store\"'*) rc=10 ;;\n        *'\"status\":\"locked\"'*) rc=11 ;;\n        *'\"status\":\"newer_schema\"'*) rc=12 ;;\n        *'\"status\":\"outdated_store\"'*) rc=13 ;;\n        *'\"status\":\"unsupported_contract\"'*) rc=14 ;;\n        *'\"status\":\"too_large\"'*) rc=15 ;;\n        *'\"status\":\"error\"'*) rc=1 ;;\n      esac\n    fi\n  done < \"$1\"\n  printf '%s\\n' \"$rc\" >> \"$dir/exit.log\"\n  exit \"$rc\"\n}}\ncase \"$*\" in\n  *\"--repo github.com/automagik-si/genie --repo-alias github.com/automagik-dev/genie --by task\"*) emit \"$dir/task-alias.json\" ;;\n  *\"--repo github.com/automagik-si/genie --repo-alias github.com/automagik-dev/genie --window d30 --branch\"*) emit \"$dir/branch-alias.json\" ;;\n  *\"--repo github.com/o/r --by task\"*) emit \"$dir/task-noalias.json\" ;;\n  *\"--repo github.com/o/r --window d30 --branch\"*) emit \"$dir/branch-alias.json\" ;;\n  *) printf '2\\n' >> \"$dir/exit.log\"; exit 2 ;;\nesac\n",
        fx.bin.display()
    );
    write_bin("usagemeter", &script);
    fs::set_permissions(fx.bin.join("usagemeter"), fs::Permissions::from_mode(0o755)).unwrap();

    let meter_state_dir = fx.home.join("meter-state");
    assert!(meter_state_dir.starts_with(&fx.home));
    let db_path = fx.repo.join(".genie/genie.db");
    let db_before = fs::read(&db_path).unwrap();
    assert!(!db_before.is_empty(), "seeded genie.db must be non-empty");
    let assert_db_untouched = || {
        assert_eq!(fs::read(&db_path).unwrap(), db_before, "genie.db must remain byte-identical");
        assert!(!Path::new(&format!("{}-wal", db_path.display())).exists());
        assert!(!Path::new(&format!("{}-shm", db_path.display())).exists());
        assert!(!meter_state_dir.exists(), "read-only query must not create METER_STATE_DIR");
    };
    let list = json_out(&fx.run(&["list", "--json"]));
    assert_db_untouched();

    let calls = read_lines("meter.log");
    assert_eq!(calls.len(), 2, "1 --by task call + 1 batched --branch call: {calls:?}");
    assert!(calls.iter().all(|c| c.contains("--repo-alias github.com/automagik-dev/genie")
        && !c.contains("gn-6")
        && !c.contains("gn-7")
        && !c.contains("gn-9")
        && !c.contains("gn-10")));
    assert!(calls[1].contains("--branch feat/gn-5-x") && calls[1].contains("--branch feat/gn-8-x"));

    let by_id = |arr: &Value, id: &str| arr.as_array().unwrap().iter().find(|t| t["task"] == id).unwrap().clone();
    let gn1 = by_id(&list, "gn-1");
    assert_eq!(
        (
            gn1["meter_state"].as_str(),
            gn1["tokens"]["total"].as_u64(),
            gn1["tokens"]["reasoning"].as_u64(),
            gn1["cost"]["usd"].as_f64(),
            gn1["activity_hours"].as_u64()
        ),
        (Some("measured"), Some(500), Some(120), Some(3.75), Some(4))
    );
    assert!(gn1["meter_reason"].is_null() && gn1["work_min"].is_null() && gn1["branch_usage"].is_null());
    assert_eq!(gn1["actors"].as_array().unwrap().len(), 2);
    assert!(gn1["actors"][0]["usd"].is_null() && gn1["actors"][0]["work_min"].is_null());

    let gn2 = by_id(&list, "gn-2");
    assert_eq!(
        (
            gn2["meter_state"].as_str(),
            gn2["cost"]["state"].as_str(),
            gn2["cost"]["usd"].as_f64(),
            gn2["tokens"]["reasoning"].is_null()
        ),
        (Some("measured"), Some("partial"), Some(1.25), true)
    );

    let gn3 = by_id(&list, "gn-3");
    assert_eq!(
        (gn3["meter_state"].as_str(), gn3["meter_reason"].as_str(), gn3["cost"]["state"].as_str()),
        (Some("measured"), Some("unpriced_models"), Some("unpriced"))
    );
    assert!(gn3["cost"]["usd"].is_null());

    let gn4 = by_id(&list, "gn-4");
    assert_eq!(
        (
            gn4["meter_state"].as_str(),
            gn4["cost"]["state"].as_str(),
            gn4["tokens"]["total"].as_u64(),
            gn4["cost"]["usd"].as_f64()
        ),
        (Some("measured"), Some("priced"), Some(500), Some(0.0))
    );

    let gn5 = by_id(&list, "gn-5");
    assert_eq!((gn5["meter_state"].as_str(), gn5["meter_reason"].as_str()), (Some("missing"), Some("no_task_usage")));
    assert!(gn5["cost"].is_null() && gn5["tokens"].is_null());
    assert_eq!(
        (
            gn5["branch_usage"]["branch"].as_str(),
            gn5["branch_usage"]["state"].as_str(),
            gn5["branch_usage"]["cost"]["usd"].as_f64(),
            gn5["branch_usage"]["tokens"]["total"].as_u64()
        ),
        (Some("feat/gn-5-x"), Some("measured"), Some(1.75), Some(500))
    );

    let gn6 = by_id(&list, "gn-6");
    assert_eq!(
        (gn6["meter_state"].as_str(), gn6["cost"]["usd"].as_f64(), gn6["tokens"]["total"].as_u64()),
        (Some("measured"), Some(0.90), Some(180))
    );
    assert!(gn6["meter_reason"].is_null() && gn6["branch_usage"].is_null());

    let gn7 = by_id(&list, "gn-7");
    assert_eq!(
        (gn7["meter_state"].as_str(), gn7["meter_reason"].as_str()),
        (Some("missing"), Some("outside_d30_window"))
    );
    assert!(gn7["cost"].is_null() && gn7["tokens"].is_null() && gn7["branch_usage"].is_null());

    let gn8 = by_id(&list, "gn-8");
    assert_eq!((gn8["meter_state"].as_str(), gn8["meter_reason"].as_str()), (Some("missing"), Some("no_task_usage")));
    assert!(gn8["cost"].is_null() && gn8["tokens"].is_null());
    assert_eq!(
        (
            gn8["branch_usage"]["branch"].as_str(),
            gn8["branch_usage"]["state"].as_str(),
            gn8["branch_usage"]["cost"]["state"].as_str(),
            gn8["branch_usage"]["cost"]["usd"].as_f64(),
            gn8["branch_usage"]["tokens"]["total"].as_u64()
        ),
        (Some("feat/gn-8-x"), Some("zero"), Some("zero"), Some(0.0), Some(0))
    );

    let gn9 = by_id(&list, "gn-9");
    assert_eq!(
        (gn9["meter_state"].as_str(), gn9["meter_reason"].as_str(), gn9["actors"].as_array().unwrap().len()),
        (Some("missing"), Some("task_ambiguous"), 0)
    );
    assert!(gn9["cost"].is_null() && gn9["branch_usage"].is_null());

    let gn10 = by_id(&list, "gn-10");
    assert_eq!(
        (gn10["meter_state"].as_str(), gn10["meter_reason"].as_str(), gn10["actors"].as_array().unwrap().len()),
        (Some("stale"), Some("ingestion_stale"), 1)
    );
    assert!(gn10["cost"]["usd"].is_null() && gn10["branch_usage"].is_null());

    // Case 2: Older usagemeter (< 3.129.2) invoked with --repo-alias exits 2 with status == "usage" -> "needs usagemeter >= 3.129.2", no fallback call
    write_bin(
        "task-alias.json",
        &env_json(
            "3.126.1",
            "usage",
            json!({"code": "usage", "message": "unknown option \"--repo-alias\" for query; see usagemeter --help"}),
            json!([]),
        ),
    );
    let direct_old = Command::new(fx.bin.join("usagemeter"))
        .args([
            "query",
            "--repo",
            "github.com/automagik-si/genie",
            "--repo-alias",
            "github.com/automagik-dev/genie",
            "--by",
            "task",
        ])
        .env("PATH", &fx.bin)
        .output()
        .unwrap();
    assert_eq!(direct_old.status.code(), Some(2));
    fs::remove_file(fx.bin.join("meter.log")).unwrap();
    let _ = fs::remove_file(fx.bin.join("exit.log"));
    let list_old = json_out(&fx.run(&["list", "--json"]));
    assert_eq!(read_lines("meter.log").len(), 1, "no fallback call without --repo-alias");
    assert_eq!(read_lines("exit.log"), vec!["2"]);
    let gn1_old = by_id(&list_old, "gn-1");
    assert_eq!(
        (gn1_old["meter_state"].as_str(), gn1_old["meter_reason"].as_str()),
        (Some("missing"), Some("needs usagemeter >= 3.129.2"))
    );
    assert!(gn1_old["cost"].is_null() && gn1_old["tokens"].is_null());

    // Case 3: Repository with no entry in KNOWN_PREVIOUS_REPO_SLUGS passes no --repo-alias and works with 3.126.1 floor
    fs::remove_file(fx.bin.join("meter.log")).unwrap();
    git_ok(&["remote", "set-url", "origin", "https://github.com/o/r.git"]);
    write_bin(
        "task-noalias.json",
        &env_json(
            "3.126.1",
            "ok",
            Value::Null,
            json!([task_row(
                "gn-1",
                json!([]),
                "measured",
                tok(100),
                cost("priced", json!(0.50), 100, 0, json!([])),
                1
            )]),
        ),
    );
    let list_noalias = json_out(&fx.run(&["list", "--json"]));
    assert!(read_lines("meter.log").iter().all(|c| !c.contains("--repo-alias")));
    let gn1_noalias = by_id(&list_noalias, "gn-1");
    assert_eq!(
        (gn1_noalias["meter_state"].as_str(), gn1_noalias["cost"]["usd"].as_f64()),
        (Some("measured"), Some(0.50))
    );

    // Case 3b (M2a on branch_usage stale + unsupported + M2c failed --branch call keeps task meter_reason == "no_task_usage"):
    write_bin(
        "branch-alias.json",
        &env_json(
            "3.126.1",
            "ok",
            Value::Null,
            json!([
                branch_row(
                    "feat/gn-5-x",
                    "stale",
                    json!("ingestion_stale"),
                    tok(500),
                    cost("priced", json!(8.88), 500, 0, json!([]))
                ),
                branch_row("feat/gn-8-x", "unsupported", json!("source_unsupported"), Value::Null, Value::Null)
            ]),
        ),
    );
    let list_stale_br = json_out(&fx.run(&["list", "--json"]));
    let gn5_stale_br = by_id(&list_stale_br, "gn-5");
    assert_eq!(
        (
            gn5_stale_br["meter_state"].as_str(),
            gn5_stale_br["meter_reason"].as_str(),
            gn5_stale_br["branch_usage"]["state"].as_str(),
            gn5_stale_br["branch_usage"]["reason"].as_str(),
            gn5_stale_br["branch_usage"]["cost"]["usd"].is_null()
        ),
        (Some("missing"), Some("no_task_usage"), Some("stale"), Some("ingestion_stale"), true)
    );
    let gn8_unsup_br = by_id(&list_stale_br, "gn-8");
    assert_eq!(
        (
            gn8_unsup_br["meter_state"].as_str(),
            gn8_unsup_br["meter_reason"].as_str(),
            gn8_unsup_br["branch_usage"]["state"].as_str(),
            gn8_unsup_br["branch_usage"]["reason"].as_str(),
            gn8_unsup_br["branch_usage"]["cost"].is_null()
        ),
        (Some("missing"), Some("no_task_usage"), Some("unsupported"), Some("source_unsupported"), true)
    );

    write_bin(
        "branch-alias.json",
        &env_json(
            "3.126.1",
            "locked",
            json!({"code": "locked", "message": "no consistent snapshot of the store within 2 s", "retry_after_s": 5}),
            json!([]),
        ),
    );
    let gn5_br_err = by_id(&json_out(&fx.run(&["list", "--json"])), "gn-5");
    assert_eq!(
        (
            gn5_br_err["meter_state"].as_str(),
            gn5_br_err["meter_reason"].as_str(),
            gn5_br_err["branch_usage"]["state"].as_str(),
            gn5_br_err["branch_usage"]["reason"].as_str(),
            gn5_br_err["branch_usage"]["cost"].is_null()
        ),
        (Some("missing"), Some("no_task_usage"), Some("missing"), Some("locked"), true)
    );

    // Case 4 (Reviewer M1): every non-zero exit (1, 2, 10..15), asserted as the fake's real exit status, with
    // the meter's envelope and with no stdout at all (the reason then comes from the exit code alone).
    // Each error object carries the fields its status requires (`meter/schema/query/v1/examples/*.json`).
    let schema_versions = json!({"store_schema_version": 4, "supported_schema_version": 3});
    for (code, status, extra, bare_reason) in [
        (1, "error", json!({"code": "store_unreadable"}), "internal_error"),
        (2, "usage", json!({}), "needs usagemeter >= 3.126.1"),
        (10, "absent_store", json!({}), "absent_store"),
        (11, "locked", json!({"retry_after_s": 5}), "locked"),
        (12, "newer_schema", schema_versions.clone(), "newer_schema"),
        (13, "outdated_store", schema_versions, "outdated_store"),
        (14, "unsupported_contract", json!({"supported_contracts": [1]}), "unsupported_contract"),
        (15, "too_large", json!({"limit_bytes": 458_752, "needed_bytes": 921_869, "rows_fit": 3}), "too_large"),
    ] {
        write_bin("exit.code", &format!("{code}\n"));
        let mut err = json!({"code": status, "message": "simulated failure"});
        err.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        let envelope = env_json("3.129.2", status, err.clone(), json!([]));
        for (stdout, reason) in [(envelope.as_str(), err["code"].as_str().unwrap()), ("", bare_reason)] {
            write_bin("task-noalias.json", stdout);
            let direct = Command::new(fx.bin.join("usagemeter"))
                .args(["query", "--repo", "github.com/o/r", "--by", "task"])
                .env("PATH", &fx.bin)
                .output()
                .unwrap();
            assert_eq!((direct.status.code(), direct.stdout.is_empty()), (Some(code), stdout.is_empty()));
            let _ = fs::remove_file(fx.bin.join("exit.log"));
            let listed = by_id(&json_out(&fx.run(&["list", "--json"])), "gn-1");
            let status_json = json_out(&fx.run(&["status", "gn-1", "--json"]));
            for t in [&listed, &status_json] {
                assert_eq!((t["meter_state"].as_str(), t["meter_reason"].as_str()), (Some("missing"), Some(reason)));
                assert!(t["cost"].is_null() && t["tokens"].is_null(), "exit {code}: never a number");
            }
            assert_eq!(read_lines("exit.log"), vec![code.to_string(); 2], "the fake exited {code} for list and status");
        }
    }
    let _ = fs::remove_file(fx.bin.join("exit.code"));
    let _ = fs::remove_file(fx.bin.join("exit.log"));
    assert_db_untouched();

    // Case 5: 50 tasks via a git worktree (--project <worktree>) resolves the main checkout's non-empty genie.db.
    for n in 11..=50 {
        let id = format!("gn-{n}");
        seed(&fx, &id, TaskEvent::Created, &today, &format!("/wt/{id}"));
    }
    write_bin(
        "task-noalias.json",
        &env_json(
            "3.129.2",
            "ok",
            Value::Null,
            json!([task_row(
                "gn-1",
                json!([]),
                "measured",
                tok(100),
                cost("priced", json!(0.50), 100, 0, json!([])),
                1
            )]),
        ),
    );
    let wt = fx.repo.parent().unwrap().join("wt");
    git_ok(&["-c", "user.name=t", "-c", "user.email=t@e", "commit", "--allow-empty", "-q", "-m", "init"]);
    git_ok(&["worktree", "add", "-q", "-b", "feat/wt", wt.to_str().unwrap()]);
    assert!(!wt.join(".genie").exists());
    fs::remove_file(fx.bin.join("meter.log")).unwrap();
    let db_50_before = fs::read(&db_path).unwrap();
    assert!(db_50_before.len() > db_before.len());
    let list_50 = json_out(&fx.run(&["list", "--json", "--project", wt.to_str().unwrap()]));
    assert_eq!(list_50.as_array().unwrap().len(), 50);
    assert_eq!(read_lines("meter.log").len(), 2);
    let status_50 = json_out(&fx.run(&["status", "gn-1", "--json", "--project", wt.to_str().unwrap()]));
    assert_eq!(status_50["cost"]["usd"].as_f64(), Some(0.50));
    assert_eq!(fs::read(&db_path).unwrap(), db_50_before);
    assert!(!Path::new(&format!("{}-wal", db_path.display())).exists());
    assert!(!Path::new(&format!("{}-shm", db_path.display())).exists());
    assert!(!wt.join(".genie").exists());

    // Case 6 (M1a): a meter past METER_CALL_TIMEOUT is killed, reaped, and degraded to usagemeter_timeout.
    let assert_pid_dead = |pid_file: &str| {
        let pid = fs::read_to_string(fx.bin.join(pid_file)).unwrap().trim().to_string();
        assert!(
            !Command::new("/bin/kill")
                .args(["-0", &pid])
                .stderr(std::process::Stdio::null())
                .status()
                .unwrap()
                .success()
        );
    };
    write_bin(
        "usagemeter",
        &format!("#!/bin/sh\nprintf '%s\\n' \"$$\" > \"{}/meter.pid\"\nexec /bin/sleep 20\n", fx.bin.display()),
    );
    fs::set_permissions(fx.bin.join("usagemeter"), fs::Permissions::from_mode(0o755)).unwrap();
    let t_start = std::time::Instant::now();
    let list_timeout = json_out(&fx.run(&["list", "--json"]));
    assert!(t_start.elapsed() < genie_tasks::METER_CALL_TIMEOUT + std::time::Duration::from_millis(1500));
    let timeout_arr = list_timeout.as_array().unwrap();
    assert_eq!(timeout_arr.len(), 50);
    for t in timeout_arr {
        assert_eq!(
            (t["meter_state"].as_str(), t["meter_reason"].as_str()),
            (Some("missing"), Some("usagemeter_timeout"))
        );
        assert!(t["cost"].is_null() && t["tokens"].is_null());
    }
    assert_pid_dead("meter.pid");

    // Case 7 (M1b): stdout past MAX_METER_OUTPUT_BYTES stops the read at the cap, well before the deadline, and is
    // killed, reaped, and degraded to output_too_large (not the meter's own exit-15 too_large).
    write_bin(
        "usagemeter",
        &format!(
            "#!/bin/sh\nprintf '%s\\n' \"$$\" > \"{}/meter.pid\"\ns=\"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\"\ni=0\nwhile [ \"$i\" -lt 14 ]; do s=\"$s$s\"; i=$((i + 1)); done\nprintf '%s' \"$s\"\nexec /bin/sleep 20\n",
            fx.bin.display()
        ),
    );
    fs::set_permissions(fx.bin.join("usagemeter"), fs::Permissions::from_mode(0o755)).unwrap();
    let t_start = std::time::Instant::now();
    let list_flood = json_out(&fx.run(&["list", "--json"]));
    assert!(t_start.elapsed() < genie_tasks::METER_CALL_TIMEOUT);
    let flood_arr = list_flood.as_array().unwrap();
    assert_eq!(flood_arr.len(), 50);
    for t in flood_arr {
        assert_eq!(
            (t["meter_state"].as_str(), t["meter_reason"].as_str()),
            (Some("missing"), Some("output_too_large"))
        );
        assert!(t["cost"].is_null() && t["tokens"].is_null());
    }
    assert_pid_dead("meter.pid");
}

/// `usage` (meter wish Group 2): the one `usagemeter query --by task` call `genie metrics export` makes
/// per repository, with `--repo-alias` from `KNOWN_PREVIOUS_REPO_SLUGS` and the asked window, and every
/// meter that cannot answer as `meter_state: "missing"` with its reason and `rows: null`, exit 0.
#[test]
fn usage_queries_by_task_with_the_alias_and_window_and_reports_a_meter_that_cannot_answer() {
    let fx = fixture("usage", false);
    let set_origin = |url: &str| {
        assert!(
            Command::new("git")
                .args(["remote", "set-url", "origin", url])
                .current_dir(&fx.repo)
                .status()
                .unwrap()
                .success()
        );
    };
    set_origin("https://github.com/automagik-si/genie.git");
    // Shell builtins only: PATH holds git and the fakes, nothing else.
    let script = format!(
        "#!/bin/sh\ndir=\"{}\"\nprintf '%s\\n' \"$*\" >> \"$dir/meter.log\"\nrc=0\nif [ -f \"$dir/exit.code\" ]; then IFS= read -r rc < \"$dir/exit.code\"; fi\nwhile IFS= read -r l || [ -n \"$l\" ]; do printf '%s\\n' \"$l\"; done < \"$dir/envelope.json\"\nexit \"$rc\"\n",
        fx.bin.display()
    );
    fs::write(fx.bin.join("usagemeter"), script).unwrap();
    fs::set_permissions(fx.bin.join("usagemeter"), fs::Permissions::from_mode(0o755)).unwrap();
    let serve = |envelope: &str, exit: i32| {
        fs::write(fx.bin.join("envelope.json"), envelope).unwrap();
        fs::write(fx.bin.join("exit.code"), exit.to_string()).unwrap();
    };
    let calls = || {
        fs::read_to_string(fx.bin.join("meter.log")).unwrap_or_default().lines().map(String::from).collect::<Vec<_>>()
    };
    let tok = |n: u64| json!({"input": n, "cache_read": 0, "cache_write_5m": 0, "cache_write_1h": 0, "output": 0, "reasoning": 0, "unsplit": 0, "total": n});
    let cost = |state: &str, usd: Value, unpriced: Value| json!({"state": state, "usd": usd, "usd_reported": 0, "usd_estimated": usd, "tokens_priced": 0, "tokens_reported": 0, "tokens_unpriced": 0, "unpriced_models": unpriced, "unpriced_models_omitted": 0});
    let row = |task: &str, c: Value| json!({"task": task, "actors": [{"bot": "b-1", "kind": "worker", "role": "dev", "squad": null, "unrecorded": [], "harness": "claude-code"}], "actors_omitted": 0, "state": "measured", "reason": null, "tokens": tok(900), "cost": c, "activity": {"first_hour": "2026-11-13T10:00:00Z", "last_hour": "2026-11-13T10:00:00Z", "hours": 1, "harnesses": ["claude-code"]}});
    let envelope = |version: &str, status: &str, rows: Value| {
        json!({"contract": "usagemeter.query", "contract_version": 1, "capability": "meter.usage@1", "meter_version": version,
            "status": status, "error": if status == "ok" { Value::Null } else { json!({"code": status, "message": "x"}) },
            "window": {"name": "d7"}, "ingestion": {"complete": true}, "sources": [], "unattributed": {"tokens_total": 0, "harnesses": []},
            "actor_unattributed": {"tokens_total": 0}, "pricing": {"table": {"origin": "bundled"}}, "rows": rows})
        .to_string()
    };
    let alias_call = |window: &str| {
        format!(
            "query --repo github.com/automagik-si/genie --repo-alias github.com/automagik-dev/genie --by task --window {window} --json"
        )
    };

    // 1. Renamed repository: one call with the alias and the window; rows as the meter gave them.
    serve(
        &envelope(
            "3.138.5",
            "ok",
            json!([
                row("gn-1", cost("priced", json!(0.0275), json!([]))),
                row("gn-4", cost("unpriced", Value::Null, json!(["acme-local-1"])))
            ]),
        ),
        0,
    );
    let ok = json_out(&fx.run(&["usage", "--window", "d7", "--json"]));
    assert_eq!(calls(), [alias_call("d7")]);
    assert_eq!(
        (ok["repo"].as_str(), ok["repo_aliases"].clone(), ok["window"].as_str(), ok["meter_state"].as_str()),
        (
            Some("github.com/automagik-si/genie"),
            json!(["github.com/automagik-dev/genie"]),
            Some("d7"),
            Some("measured")
        )
    );
    assert!(ok["meter_reason"].is_null());
    assert_eq!(ok["meter"]["meter_version"], "3.138.5");
    assert_eq!(ok["meter"]["pricing"], json!({"table": {"origin": "bundled"}}));
    assert_eq!(ok["rows"][0]["cost"]["usd"], 0.0275);
    assert_eq!(
        (ok["rows"][1]["reason"].as_str(), ok["rows"][1]["cost"]["usd"].is_null()),
        (Some("unpriced_models"), true)
    );
    assert_eq!(ok["rows"][1]["tokens"]["total"], 900);
    let text = fx.run(&["usage", "--window", "d7"]);
    assert_eq!(code(&text), 0);
    assert!(String::from_utf8_lossy(&text.stdout).contains("gn-4  900 tokens  –  unpriced_models"));

    let missing = |args: &[&str]| -> (Value, Value) {
        let out = json_out(&fx.run(args));
        assert_eq!(out["meter_state"], "missing");
        assert!(out["rows"].is_null() && out["meter"].is_null(), "unknown is never an empty list: {out}");
        (out["meter_reason"].clone(), out["repo_aliases"].clone())
    };
    // 2. d90 needs 3.129.5: a 3.129.2 answer is refused, and nothing is asked again.
    serve(&envelope("3.129.2", "ok", json!([row("gn-1", cost("priced", json!(1.0), json!([])))])), 0);
    assert_eq!(missing(&["usage", "--window", "d90", "--json"]).0, "needs usagemeter >= 3.129.5");
    assert_eq!(calls().len(), 3);
    assert_eq!(calls().last().unwrap(), &alias_call("d90"));
    // 3. A meter older than the alias exits 2 with a usage envelope: never a call without the alias.
    serve(&envelope("3.128.0", "usage", json!([])), 2);
    assert_eq!(missing(&["usage", "--json"]).0, "needs usagemeter >= 3.129.2");
    serve("", 2);
    assert_eq!(missing(&["usage", "--json"]).0, "needs usagemeter >= 3.129.2");
    assert_eq!(calls().len(), 5);
    assert!(calls().iter().all(|c| c.contains("--repo-alias github.com/automagik-dev/genie")), "{:?}", calls());
    // 4. Top-level errors: a non-ok status, unreadable JSON, a missing binary.
    serve(&envelope("3.138.5", "internal_error", json!([])), 1);
    assert_eq!(missing(&["usage", "--json"]).0, "internal_error");
    serve("{not json", 0);
    assert_eq!(missing(&["usage", "--json"]).0, "invalid_json");
    // 5. A repository with no previous name passes no alias and keeps the 3.126.1 floor.
    set_origin("https://github.com/o/r.git");
    serve(&envelope("3.126.1", "ok", json!([])), 0);
    let plain = json_out(&fx.run(&["usage", "--json"]));
    assert_eq!(
        (plain["meter_state"].as_str(), plain["rows"].clone(), plain["repo_aliases"].clone()),
        (Some("measured"), json!([]), json!([]))
    );
    assert_eq!(calls().last().unwrap(), "query --repo github.com/o/r --by task --window d30 --json");
    let before = calls().len();
    fs::remove_file(fx.bin.join("usagemeter")).unwrap();
    assert_eq!(missing(&["usage", "--json"]).0, "usagemeter_unavailable");
    assert!(Command::new("git").args(["remote", "remove", "origin"]).current_dir(&fx.repo).status().unwrap().success());
    assert_eq!(missing(&["usage", "--json"]), (json!("no_repo_slug"), json!([])));

    // 6. Refusals of the request itself: exit 2, nothing asked of the meter.
    for args in
        [&["usage", "--window", "d14"][..], &["usage", "--window"], &["usage", "extra"], &["usage", "--rebuild"]]
    {
        let out = fx.run(args);
        assert_eq!(code(&out), 2, "{args:?}");
        assert!(out.stdout.is_empty());
    }
    assert!(stderr(&fx.run(&["usage", "--window", "d14"])).contains("--window takes d1, d7, d30 or d90, not 'd14'"));
    assert_eq!(calls().len(), before);
}
