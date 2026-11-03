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

fn pr(n: u64, branch: &str, state: &str, updated: &str) -> Value {
    json!({
        "number": n, "html_url": format!("https://github.com/o/r/pull/{n}"), "title": "fix: x",
        "state": if state == "open" { "open" } else { "closed" },
        "head": {"ref": branch, "sha": format!("head-{n}")}, "merge_commit_sha": format!("merge-{n}"),
        "created_at": "2026-11-01T10:00:00Z", "updated_at": updated,
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
    assert_eq!(status["events"][0]["pushed_after_open"], 0);

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
    assert_eq!(fx.rows(), 2, "the closed row plus the other PR's opened row");
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
