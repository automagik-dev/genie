//! T7's exit codes through the `genie-rs` binary (review LOW-3): `start` 0 with its JSON line, a
//! failed fetch 1, an `opened` or `merged` task 2 before any fetch or forge call, a task whose PR
//! closed without merging 0, usage 2; `push` 0 to the fixture's bare remote, 2 for any other
//! branch and outside a task worktree; 32 parallel `start` processes, each 0 with its own id. The
//! opened/merged/closed states are recorded by `forge-sync` itself, against genie-forge's fake `gh`
//! on a PATH that holds nothing else but git. Remotes are bare repositories in a temp dir. The
//! same-id races (review H1) hold one start inside a pausing git wrapper; the restart at an
//! unchanged base (review H3, R1-32) runs created -> closed -> created through the binary.

use std::fs;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::{Value, json};

static N: AtomicUsize = AtomicUsize::new(0);
const BIN: &str = env!("CARGO_BIN_EXE_genie-rs");
const GITHUB: &str = "https://github.com/o/r.git";

struct Fx {
    remote: PathBuf,
    repo: PathBuf,
    home: PathBuf,
    bin: PathBuf,
}

fn git_path() -> PathBuf {
    let path = std::env::var_os("PATH").unwrap_or_default();
    std::env::split_paths(&path).map(|d| d.join("git")).find(|p| p.is_file()).expect("git on PATH")
}

fn git_out(dir: &Path, args: &[&str]) -> Output {
    Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"])
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .unwrap()
}

fn git(dir: &Path, args: &[&str]) -> String {
    let out = git_out(dir, args);
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// A bare remote with `main` and `dev`, a clone whose local `dev` is one commit behind it, a
/// TS-initialized `genie.db`, and a bin dir holding git plus the fake forge as `gh`.
fn fixture(tag: &str) -> Fx {
    let root = std::env::temp_dir().join(format!(
        "genie-rs-start-{tag}-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    let root = fs::canonicalize(root).unwrap();
    let (remote, seed, repo) = (root.join("remote.git"), root.join("seed"), root.join("repo"));
    let (home, bin) = (root.join("home"), root.join("bin"));
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&bin).unwrap();
    git(&root, &["init", "-q", "--bare", "-b", "main", remote.to_str().unwrap()]);
    git(&root, &["init", "-q", "-b", "main", seed.to_str().unwrap()]);
    git(&seed, &["commit", "-q", "--allow-empty", "-m", "init"]);
    git(&seed, &["push", "-q", remote.to_str().unwrap(), "main", "main:dev"]);
    git(&root, &["clone", "-q", remote.to_str().unwrap(), repo.to_str().unwrap()]);
    git(&repo, &["branch", "-q", "dev", "origin/dev"]);
    git(&seed, &["commit", "-q", "--allow-empty", "-m", "upstream ahead"]);
    git(&seed, &["push", "-q", remote.to_str().unwrap(), "HEAD:dev"]);
    fs::create_dir_all(repo.join(".genie")).unwrap();
    let conn = rusqlite::Connection::open(repo.join(".genie/genie.db")).unwrap();
    conn.execute_batch("PRAGMA journal_mode = WAL; CREATE TABLE meta (key TEXT); PRAGMA user_version = 1;").unwrap();
    symlink(git_path(), bin.join("git")).unwrap();
    let fake = Path::new(env!("CARGO_MANIFEST_DIR")).join("../genie-forge/tests/fixtures/fake-forge");
    fs::copy(&fake, bin.join("gh")).unwrap();
    fs::set_permissions(bin.join("gh"), fs::Permissions::from_mode(0o755)).unwrap();
    Fx { remote, repo, home, bin }
}

fn pr(n: u64, branch: &str, state: &str) -> Value {
    let at = "2026-11-01T10:05:00Z";
    json!({
        "number": n, "html_url": format!("https://github.com/o/r/pull/{n}"), "title": "fix: hand opened",
        "state": if state == "open" { "open" } else { "closed" },
        "head": {"ref": branch, "sha": format!("head-{n}")}, "merge_commit_sha": format!("merge-{n}"),
        "created_at": "2026-11-01T10:00:00Z", "updated_at": at,
        "merged_at": if state == "merged" { json!(at) } else { Value::Null },
        "closed_at": if state == "open" { Value::Null } else { json!(at) },
    })
}

fn code(out: &Output) -> i32 {
    out.status.code().expect("exited, not signalled")
}

fn stderr(out: &Output) -> String {
    String::from_utf8_lossy(&out.stderr).into_owned()
}

impl Fx {
    fn run_in(&self, dir: &Path, args: &[&str]) -> Output {
        Command::new(BIN)
            .args(args)
            .current_dir(dir)
            .env("GENIE_HOME", &self.home)
            .env("PATH", &self.bin)
            .output()
            .unwrap()
    }

    fn run(&self, args: &[&str]) -> Output {
        self.run_in(&self.repo, args)
    }

    fn worktrees(&self) -> PathBuf {
        self.repo.with_file_name("repo.worktrees")
    }

    fn rows(&self) -> usize {
        fs::read_to_string(self.home.join("tasks.jsonl")).map_or(0, |t| t.lines().count())
    }

    fn forge_calls(&self) -> usize {
        fs::read_to_string(self.bin.join("calls.log")).map_or(0, |t| t.lines().count())
    }

    fn events(&self) -> i64 {
        let conn = rusqlite::Connection::open(self.repo.join(".genie/genie.db")).unwrap();
        conn.query_row("SELECT count(*) FROM v7_task_events", [], |r| r.get(0)).unwrap()
    }

    /// forge-sync records `prs` with a github origin; then origin points at `fetch_url`.
    fn forge_sync(&self, prs: &[Value], fetch_url: &Path) {
        git(&self.repo, &["remote", "set-url", "origin", GITHUB]);
        fs::write(self.bin.join("list.json"), Value::Array(prs.to_vec()).to_string()).unwrap();
        let out = self.run(&["forge-sync"]);
        assert_eq!(code(&out), 0, "{}", stderr(&out));
        git(&self.repo, &["remote", "set-url", "origin", fetch_url.to_str().unwrap()]);
    }

    /// Exit 2 before any fetch or forge call, leaving nothing behind.
    fn assert_refused_untouched(&self, args: &[&str], why: &str) {
        let (events, rows, calls) = (self.events(), self.rows(), self.forge_calls());
        let out = self.run(args);
        assert_eq!(code(&out), 2, "{}", stderr(&out));
        assert!(stderr(&out).contains(why), "{}", stderr(&out));
        assert!(out.stdout.is_empty());
        assert_eq!((self.events(), self.rows(), self.forge_calls()), (events, rows, calls));
        assert_eq!(git(&self.repo, &["for-each-ref", "refs/genie/"]), "");
        assert!(!self.worktrees().exists());
        assert!(!self.repo.join(".git/FETCH_HEAD").exists());
        let conn = rusqlite::Connection::open(self.repo.join(".genie/genie.db")).unwrap();
        let reserved: i64 = conn.query_row("SELECT count(*) FROM v7_task_ids", [], |r| r.get(0)).unwrap();
        assert_eq!(reserved, 0);
    }
}

#[test]
fn start_exits_0_with_its_json_and_push_reaches_only_the_task_branch() {
    let fx = fixture("ok");
    let upstream = git(&fx.remote, &["rev-parse", "refs/heads/dev"]);
    let out = fx.run(&["start", "--title", "sync hangs", "--lead", "b-x"]);
    assert_eq!(code(&out), 0, "{}", stderr(&out));
    assert!(stderr(&out).contains("extensions.worktreeConfig=true"), "{}", stderr(&out));
    let started: Value = serde_json::from_slice(&out.stdout).unwrap();
    let wt = fx.worktrees().join("gn-1-sync-hangs");
    assert_eq!(
        started,
        json!({"task": "gn-1", "branch": "fix/gn-1-sync-hangs", "worktree": wt.to_str().unwrap(), "lead": "b-x",
               "base_sha": upstream})
    );
    assert_eq!((fx.events(), fx.rows()), (1, 1));

    git(&wt, &["commit", "-q", "--allow-empty", "-m", "fix: the work"]);
    assert_ne!(code(&git_out(&wt, &["push"])), 0, "a plain git push fails");
    assert_ne!(code(&git_out(&wt, &["push", "origin", "HEAD"])), 0, "so does a named one");
    let pushed = fx.run_in(&wt, &["push", "--json"]);
    assert_eq!(code(&pushed), 0, "{}", stderr(&pushed));
    let pushed: Value = serde_json::from_slice(&pushed.stdout).unwrap();
    assert_eq!(pushed["branch"], "fix/gn-1-sync-hangs");
    assert_eq!(git(&fx.remote, &["rev-parse", "refs/heads/fix/gn-1-sync-hangs"]), git(&wt, &["rev-parse", "HEAD"]));
    for other in ["fix/gn-2-other", "dev", "main", "master"] {
        let out = fx.run_in(&wt, &["push", other]);
        assert_eq!(code(&out), 2, "{other}: {}", stderr(&out));
    }
    let outside = fx.run(&["push"]);
    assert_eq!(code(&outside), 2, "{}", stderr(&outside));
    assert!(stderr(&outside).contains("not a task worktree"));
    assert_eq!(git(&fx.remote, &["rev-parse", "refs/heads/dev"]), upstream, "dev never moved");
    git(&fx.repo, &["push", "-q", "origin", "HEAD:refs/heads/from-main"]);
}

#[test]
fn a_failed_fetch_exits_1_and_leaves_nothing() {
    let fx = fixture("nofetch");
    git(&fx.repo, &["remote", "set-url", "origin", fx.remote.with_file_name("gone.git").to_str().unwrap()]);
    let out = fx.run(&["start", "--title", "sync hangs", "--lead", "b-x"]);
    assert_eq!(code(&out), 1, "{}", stderr(&out));
    assert!(out.stdout.is_empty());
    assert!(!fx.worktrees().exists());
    assert_eq!(
        git(&fx.repo, &["for-each-ref", "--format=%(refname)", "refs/heads/"]),
        "refs/heads/dev\nrefs/heads/main"
    );
    assert_eq!((fx.events(), fx.rows()), (0, 0));
}

#[test]
fn an_opened_or_merged_task_exits_2_before_any_fetch_or_forge_call() {
    let gone = |fx: &Fx| fx.remote.with_file_name("gone.git");
    let opened = fixture("opened");
    opened.forge_sync(&[pr(5, "fix/gh-5-hand-opened", "open")], &gone(&opened));
    opened.assert_refused_untouched(&["start", "gh-5", "--title", "sync hangs", "--lead", "b-x"], "gh-5 is opened");

    let merged = fixture("merged");
    merged.forge_sync(&[pr(5, "fix/gh-5-hand-opened", "merged")], &gone(&merged));
    merged.assert_refused_untouched(&["start", "gh-5", "--lead", "b-x"], "gh-5 is merged");
}

#[test]
fn a_task_whose_pr_closed_without_merging_starts_with_exit_0() {
    let fx = fixture("closed");
    fx.forge_sync(&[pr(6, "fix/gh-6-flaky", "closed")], &fx.remote);
    let out = fx.run(&["start", "gh-6", "--title", "flaky test", "--lead", "b-x", "--type", "test"]);
    assert_eq!(code(&out), 0, "{}", stderr(&out));
    let started: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(started["branch"], "test/gh-6-flaky-test");
    let status: Value = serde_json::from_slice(&fx.run(&["status", "gh-6", "--json"]).stdout).unwrap();
    assert_eq!((status["state"].as_str(), status["lane"].as_str()), (Some("created"), Some("Working")));
    let events: Vec<&str> = status["events"].as_array().unwrap().iter().map(|e| e["event"].as_str().unwrap()).collect();
    assert_eq!(events, ["opened", "closed", "created"]);
}

#[test]
fn start_usage_errors_exit_2() {
    let fx = fixture("usage");
    for (args, why) in [
        (&["start", "--title", "x"][..], "--lead"),
        (&["start", "--lead", "b-x"][..], "--title"),
        (&["start", "gh-1", "gh-2", "--lead", "b-x"][..], "unexpected argument"),
        (&["start", "--title"][..], "needs a value"),
        (&["start", "--bogus", "--lead", "b-x"][..], "unknown option"),
        (&["push", "a", "b"][..], "unexpected argument"),
    ] {
        let out = fx.run(args);
        assert_eq!(code(&out), 2, "{args:?}: {}", stderr(&out));
        assert!(stderr(&out).contains(why), "{args:?}: {}", stderr(&out));
    }
    assert!(!fx.worktrees().exists());
}

#[test]
fn thirty_two_parallel_start_processes_each_exit_0_with_their_own_id() {
    let fx = fixture("parallel");
    let children: Vec<_> = (0..32)
        .map(|i| {
            Command::new(BIN)
                .args(["start", "--title", &format!("job {i}"), "--lead", "b-x"])
                .current_dir(&fx.repo)
                .env("GENIE_HOME", &fx.home)
                .env("PATH", &fx.bin)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .unwrap()
        })
        .collect();
    let mut ids: Vec<u32> = children
        .into_iter()
        .map(|c| {
            let out = c.wait_with_output().unwrap();
            assert_eq!(code(&out), 0, "{}", stderr(&out));
            let v: Value = serde_json::from_slice(&out.stdout).unwrap();
            v["task"].as_str().unwrap()[3..].parse().unwrap()
        })
        .collect();
    ids.sort_unstable();
    assert_eq!(ids, (1..=32).collect::<Vec<_>>());
    assert_eq!(fs::read_dir(fx.worktrees()).unwrap().count(), 32);
    assert_eq!((fx.events(), fx.rows()), (32, 32));
}

/// Replace the fixture's git with a wrapper that logs each call as `<role> <args>` and, for the
/// process whose `GENIE_TEST_ROLE` is `GENIE_TEST_PAUSE_ROLE`, holds the first call carrying the
/// argument `GENIE_TEST_PAUSE_ON` until `<dir>/release` exists, after touching `<dir>/waiting`.
/// The real git then runs every command; the wrapper only delays one.
fn pausing_git(fx: &Fx) -> PathBuf {
    let dir = fx.home.with_file_name("pause");
    fs::create_dir_all(&dir).unwrap();
    let script = format!(
        "#!/bin/sh\nprintf '%s %s\\n' \"$GENIE_TEST_ROLE\" \"$*\" >>\"{dir}/calls\"\n\
         if [ \"$GENIE_TEST_ROLE\" = \"$GENIE_TEST_PAUSE_ROLE\" ] && [ ! -f \"{dir}/paused\" ]; then\n\
           for a in \"$@\"; do\n\
             if [ \"$a\" = \"$GENIE_TEST_PAUSE_ON\" ]; then\n\
               : >\"{dir}/paused\"; : >\"{dir}/waiting\"\n\
               while [ ! -f \"{dir}/release\" ]; do sleep 0.05; done\n\
               break\n\
             fi\n\
           done\n\
         fi\n\
         exec \"{git}\" \"$@\"\n",
        dir = dir.display(),
        git = git_path().display()
    );
    fs::remove_file(fx.bin.join("git")).unwrap();
    fs::write(fx.bin.join("git"), script).unwrap();
    fs::set_permissions(fx.bin.join("git"), fs::Permissions::from_mode(0o755)).unwrap();
    dir
}

fn spawn_start(fx: &Fx, role: &str, pause_on: &str, args: &[&str]) -> std::process::Child {
    Command::new(BIN)
        .args(args)
        .current_dir(&fx.repo)
        .env("GENIE_HOME", &fx.home)
        .env("PATH", &fx.bin)
        .env("GENIE_TEST_ROLE", role)
        .env("GENIE_TEST_PAUSE_ROLE", "paused")
        .env("GENIE_TEST_PAUSE_ON", pause_on)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap()
}

fn wait_for(path: &Path) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    while !path.exists() {
        assert!(std::time::Instant::now() < deadline, "timed out waiting for {}", path.display());
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

const SAME: [&str; 6] = ["start", "gh-8", "--title", "same task", "--lead", "b-x"];

/// What a successful `start gh-8 --title "same task"` leaves, plus an uncommitted file in it.
fn assert_winner_intact(fx: &Fx, scratch: Option<&Path>) {
    let wt = fx.worktrees().join("gh-8-same-task");
    assert!(wt.join(".git").exists(), "the winner's worktree survives");
    assert_eq!(git(&wt, &["symbolic-ref", "--short", "HEAD"]), "fix/gh-8-same-task");
    assert!(git_out(&fx.repo, &["rev-parse", "--verify", "refs/heads/fix/gh-8-same-task"]).status.success());
    if let Some(scratch) = scratch {
        assert_eq!(fs::read_to_string(scratch).unwrap(), "uncommitted work\n", "uncommitted contents survive");
    }
    assert_eq!((fx.events(), fx.rows()), (1, 1), "one created event and one export row");
}

#[test]
fn a_same_id_start_that_loses_the_race_never_removes_the_winners_worktree() {
    // The loser is held at its fetch, so it reaches the worktree step only after the winner finished
    // and the winner's worktree holds uncommitted work.
    let fx = fixture("race-after");
    let pause = pausing_git(&fx);
    let loser = spawn_start(&fx, "paused", "fetch", &SAME);
    wait_for(&pause.join("waiting"));
    let winner = spawn_start(&fx, "winner", "", &SAME).wait_with_output().unwrap();
    assert_eq!(code(&winner), 0, "{}", stderr(&winner));
    let scratch = fx.worktrees().join("gh-8-same-task/scratch.txt");
    fs::write(&scratch, "uncommitted work\n").unwrap();
    fs::write(pause.join("release"), "").unwrap();
    let loser = loser.wait_with_output().unwrap();
    assert_eq!(code(&loser), 1, "{}", stderr(&loser));
    assert!(stderr(&loser).contains("already exists"), "{}", stderr(&loser));
    assert_winner_intact(&fx, Some(&scratch));
}

#[test]
fn a_same_id_start_waits_for_the_one_creating_its_worktree() {
    // The reviewer's interleaving: the first start is held inside its worktree add, after every check.
    // Without the start lock the second ran to completion here and the first then removed its work.
    let fx = fixture("race-inside");
    let pause = pausing_git(&fx);
    let first = spawn_start(&fx, "paused", "worktree", &SAME);
    wait_for(&pause.join("waiting"));
    let mut second = spawn_start(&fx, "second", "", &SAME);
    let calls = pause.join("calls");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    while !fs::read_to_string(&calls)
        .unwrap_or_default()
        .lines()
        .any(|l| l.starts_with("second ") && l.contains("update-ref -d"))
    {
        assert!(std::time::Instant::now() < deadline, "the second start never fetched");
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    std::thread::sleep(std::time::Duration::from_millis(500));
    assert!(second.try_wait().unwrap().is_none(), "the second start waits on the start lock");
    fs::write(pause.join("release"), "").unwrap();
    let first = first.wait_with_output().unwrap();
    let second = second.wait_with_output().unwrap();
    assert_eq!(code(&first), 0, "{}", stderr(&first));
    assert_eq!(code(&second), 1, "{}", stderr(&second));
    assert_winner_intact(&fx, None);
}

#[test]
fn a_task_started_closed_and_started_again_at_the_same_base_gets_a_second_lifecycle() {
    let fx = fixture("restart");
    let args = ["start", "gh-6", "--title", "flaky test", "--lead", "b-x"];
    let first = fx.run(&args);
    assert_eq!(code(&first), 0, "{}", stderr(&first));
    let first: Value = serde_json::from_slice(&first.stdout).unwrap();
    let wt = first["worktree"].as_str().unwrap();
    git(&fx.repo, &["worktree", "remove", "--force", wt]);
    git(&fx.repo, &["branch", "-D", "fix/gh-6-flaky-test"]);
    fx.forge_sync(&[pr(6, "fix/gh-6-flaky-test", "closed")], &fx.remote);

    let second = fx.run(&args);
    assert_eq!(code(&second), 0, "{}", stderr(&second));
    let second: Value = serde_json::from_slice(&second.stdout).unwrap();
    assert_eq!(
        (&second["base_sha"], &second["worktree"]),
        (&first["base_sha"], &first["worktree"]),
        "same base and title"
    );
    let status: Value = serde_json::from_slice(&fx.run(&["status", "gh-6", "--json"]).stdout).unwrap();
    assert_eq!((status["state"].as_str(), status["lane"].as_str()), (Some("created"), Some("Working")));
    let events: Vec<&str> = status["events"].as_array().unwrap().iter().map(|e| e["event"].as_str().unwrap()).collect();
    assert_eq!(events, ["created", "opened", "closed", "created"]);
    let rows: Vec<Value> = fs::read_to_string(fx.home.join("tasks.jsonl"))
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .filter(|r: &Value| r["event"] == "created")
        .collect();
    assert_eq!(rows.len(), 2, "two created export rows");
    assert_ne!(rows[0]["dedupe_key"], rows[1]["dedupe_key"]);

    // A retry of the same start inside this lifecycle appends nothing.
    let retry = fx.run(&args);
    assert_eq!(code(&retry), 1, "{}", stderr(&retry));
    assert_eq!((fx.events(), fx.rows()), (4, 4));
}
