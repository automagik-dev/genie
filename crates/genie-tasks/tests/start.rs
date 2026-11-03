//! T7 (WISH.md Group 2): `start` and `push` against fixture repositories with a bare remote in a
//! temp dir, never a real remote. Every fixture is a fresh clone whose upstream `dev` is one commit
//! ahead of its local `dev`, with a TS-shaped `genie.db` at `user_version = 1`. The binary's exit
//! codes for the same cases are asserted in `crates/genie-rs/tests/start_push.rs` (review LOW-3).

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use genie_tasks::start::{NO_PUSH_URL, START_REFS};
use genie_tasks::{
    EventRow, Recorded, StartOptions, Started, TaskEvent, TaskState, VerbError, dedupe_key, lifecycle_dedupe_key,
    open_store_at, push, record, start,
};

static N: AtomicUsize = AtomicUsize::new(0);

struct Fx {
    remote: PathBuf,
    repo: PathBuf,
    home: PathBuf,
    seed: PathBuf,
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
    assert!(out.status.success(), "git {args:?} in {}: {}", dir.display(), String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// A bare remote with `main` and `dev`, a clone whose local `dev` is one commit behind the
/// remote's, and a TS-initialized `genie.db` in the clone.
fn fixture(tag: &str) -> Fx {
    let root = std::env::temp_dir().join(format!(
        "genie-start-{tag}-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    let root = fs::canonicalize(root).unwrap();
    let (remote, seed, repo, home) = (root.join("remote.git"), root.join("seed"), root.join("repo"), root.join("home"));
    fs::create_dir_all(&home).unwrap();
    git(&root, &["init", "-q", "--bare", "-b", "main", remote.to_str().unwrap()]);
    git(&root, &["init", "-q", "-b", "main", seed.to_str().unwrap()]);
    git(&seed, &["commit", "-q", "--allow-empty", "-m", "init"]);
    git(&seed, &["remote", "add", "origin", remote.to_str().unwrap()]);
    git(&seed, &["push", "-q", "origin", "main", "main:dev"]);
    git(&root, &["clone", "-q", remote.to_str().unwrap(), repo.to_str().unwrap()]);
    git(&repo, &["branch", "-q", "dev", "origin/dev"]);
    git(&seed, &["commit", "-q", "--allow-empty", "-m", "upstream ahead"]);
    git(&seed, &["push", "-q", "origin", "HEAD:dev"]);
    fs::create_dir_all(repo.join(".genie")).unwrap();
    let conn = rusqlite::Connection::open(repo.join(".genie/genie.db")).unwrap();
    conn.execute_batch("PRAGMA journal_mode = WAL; CREATE TABLE meta (key TEXT); PRAGMA user_version = 1;").unwrap();
    Fx { remote, repo, home, seed }
}

fn opts(id: Option<&str>, title: Option<&str>) -> StartOptions {
    StartOptions {
        id: id.map(str::to_string),
        title: title.map(str::to_string),
        lead: "b-x".into(),
        kind: String::new(),
    }
}

impl Fx {
    fn start(&self, o: &StartOptions) -> Result<Started, VerbError> {
        self.start_noted(o).0
    }

    fn start_noted(&self, o: &StartOptions) -> (Result<Started, VerbError>, String) {
        let mut notes = Vec::new();
        let r = start(&self.repo, &self.home, o, &mut notes);
        (r, String::from_utf8(notes).unwrap())
    }

    fn worktrees(&self) -> PathBuf {
        self.repo.with_file_name("repo.worktrees")
    }

    fn upstream_dev(&self) -> String {
        git(&self.remote, &["rev-parse", "refs/heads/dev"])
    }

    fn events(&self) -> Vec<genie_tasks::StoredEvent> {
        open_store_at(&self.repo, &self.home).unwrap().events().unwrap()
    }

    fn export_rows(&self) -> Vec<serde_json::Value> {
        fs::read_to_string(self.home.join("tasks.jsonl"))
            .unwrap_or_default()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    fn start_refs(&self) -> String {
        git(&self.repo, &["for-each-ref", "--format=%(refname)", START_REFS])
    }

    fn reservations(&self) -> Vec<(String, i64)> {
        let conn = rusqlite::Connection::open(self.repo.join(".genie/genie.db")).unwrap();
        let mut stmt = conn.prepare("SELECT task, abandoned FROM v7_task_ids ORDER BY seq").unwrap();
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().map(Result::unwrap).collect()
    }

    fn branches(&self) -> String {
        git(&self.repo, &["for-each-ref", "--format=%(refname:short)", "refs/heads/"])
    }

    /// The event forge-sync writes for a PR on `fix/<id>-...`.
    fn forge_event(&self, id: &str, event: TaskEvent, title: &str) {
        let store = open_store_at(&self.repo, &self.home).unwrap();
        let mut row = EventRow::new(event);
        row.task = id.into();
        row.forge = "github".into();
        row.url = format!("https://github.com/o/r/pull/{}", &id[3..]);
        row.branch = format!("fix/{id}-hand-opened");
        row.commit = "a".repeat(40);
        row.title = title.into();
        record(&store, store.project(), &row).unwrap();
    }

    /// Nothing at all for a start that was refused or failed before its worktree.
    fn assert_untouched(&self, events: usize, rows: usize) {
        assert_eq!(self.start_refs(), "", "no refs/genie/start/* ref");
        assert!(self.reservations().is_empty(), "no v7_task_ids reservation");
        assert!(!self.worktrees().exists(), "no worktree");
        assert_eq!(self.branches(), "dev\nmain", "no branch");
        assert_eq!(self.events().len(), events, "no event");
        assert_eq!(self.export_rows().len(), rows, "no export row");
        assert!(!self.repo.join(".git/FETCH_HEAD").exists(), "no FETCH_HEAD");
    }
}

#[test]
fn a_title_start_cuts_its_worktree_from_the_fetched_upstream_tip() {
    let fx = fixture("fresh");
    let upstream = fx.upstream_dev();
    assert_ne!(git(&fx.repo, &["rev-parse", "refs/heads/dev"]), upstream, "local dev is one commit behind");
    let tracking = git(&fx.repo, &["rev-parse", "refs/remotes/origin/dev"]);

    let (started, notes) = fx.start_noted(&opts(None, Some("sync hangs")));
    let started = started.unwrap();
    let wt = fx.worktrees().join("gn-1-sync-hangs");
    assert_eq!(
        started,
        Started {
            task: "gn-1".into(),
            branch: "fix/gn-1-sync-hangs".into(),
            worktree: wt.to_string_lossy().into_owned(),
            lead: "b-x".into(),
            base_sha: upstream.clone(),
        }
    );
    assert_eq!(git(&wt, &["rev-parse", "HEAD"]), upstream);
    assert_eq!(git(&wt, &["symbolic-ref", "--short", "HEAD"]), "fix/gn-1-sync-hangs");
    assert!(!git_out(&wt, &["rev-parse", "--abbrev-ref", "@{upstream}"]).status.success(), "no upstream");
    assert!(!git_out(&fx.repo, &["config", "--get", "branch.fix/gn-1-sync-hangs.remote"]).status.success());
    // One created event (commit = the base sha, Decision 5) and one export row.
    let events = fx.events();
    assert_eq!(events.len(), 1);
    let e = &events[0];
    assert_eq!((e.task.as_str(), e.event, e.commit.as_str()), ("gn-1", TaskEvent::Created, upstream.as_str()));
    assert_eq!(
        (e.worktree.as_str(), e.lead.as_str(), e.title.as_str()),
        (started.worktree.as_str(), "b-x", "sync hangs")
    );
    assert_eq!((e.branch.as_str(), e.kind.as_str()), ("fix/gn-1-sync-hangs", "fix"));
    let rows = fx.export_rows();
    assert_eq!(rows.len(), 1);
    assert_eq!((rows[0]["task"].as_str(), rows[0]["event"].as_str()), (Some("gn-1"), Some("created")));
    // No FETCH_HEAD, no leftover start ref, and no opportunistic remote-tracking update.
    assert!(!fx.repo.join(".git/FETCH_HEAD").exists());
    assert_eq!(fx.start_refs(), "");
    assert_eq!(git(&fx.repo, &["rev-parse", "refs/remotes/origin/dev"]), tracking);
    assert_eq!(fx.reservations(), vec![("gn-1".into(), 0)]);
    // extensions.worktreeConfig is named on stderr the first time only.
    assert!(notes.contains("extensions.worktreeConfig=true"), "{notes}");
    let (second, notes) = fx.start_noted(&opts(None, Some("Second: thing!")));
    assert_eq!(second.unwrap().branch, "fix/gn-2-second-thing");
    assert_eq!(notes, "");
}

#[test]
fn the_next_start_sweeps_start_refs_older_than_ten_minutes() {
    let fx = fixture("sweep");
    let sha = git(&fx.repo, &["rev-parse", "HEAD"]);
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
    let stale = format!("{START_REFS}{}-1-0", now - 3_600);
    let fresh = format!("{START_REFS}{now}-1-1");
    git(&fx.repo, &["update-ref", &stale, &sha]);
    git(&fx.repo, &["update-ref", &fresh, &sha]);
    fx.start(&opts(None, Some("sweep"))).unwrap();
    assert_eq!(fx.start_refs(), fresh, "the stale leftover is swept, a start still in flight is not");
}

#[test]
fn thirty_two_parallel_starts_mint_thirty_two_ids_and_worktrees() {
    let fx = fixture("parallel");
    let results: Vec<Result<Started, VerbError>> = std::thread::scope(|s| {
        let handles: Vec<_> = (0..32)
            .map(|i| {
                let fx = &fx;
                s.spawn(move || fx.start(&opts(None, Some(&format!("job {i}")))))
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });
    let started: Vec<Started> = results.into_iter().map(|r| r.unwrap()).collect();
    let mut ids: Vec<String> = started.iter().map(|s| s.task.clone()).collect();
    ids.sort_by_key(|id| id[3..].parse::<u32>().unwrap());
    assert_eq!(ids, (1..=32).map(|n| format!("gn-{n}")).collect::<Vec<_>>());
    for s in &started {
        assert!(Path::new(&s.worktree).join(".git").exists(), "{}", s.worktree);
        assert_eq!(git(Path::new(&s.worktree), &["config", "--get", "remote.origin.pushurl"]), NO_PUSH_URL);
    }
    assert_eq!(fs::read_dir(fx.worktrees()).unwrap().count(), 32);
    assert_eq!(fx.events().len(), 32);
    assert_eq!(fx.export_rows().len(), 32);
    assert_eq!(fx.start_refs(), "");
}

#[test]
fn only_genie_push_leaves_a_task_worktree_and_only_to_its_branch() {
    let fx = fixture("push");
    let s = fx.start(&opts(None, Some("sync hangs"))).unwrap();
    let wt = PathBuf::from(&s.worktree);
    git(&wt, &["commit", "-q", "--allow-empty", "-m", "fix: the work"]);
    let head = git(&wt, &["rev-parse", "HEAD"]);
    // A plain push fails: no upstream, and the per-worktree pushurl has no transport.
    assert!(!git_out(&wt, &["push"]).status.success());
    let named = git_out(&wt, &["push", "origin", "HEAD:refs/heads/fix/gn-1-sync-hangs"]);
    assert!(!named.status.success());
    assert!(
        String::from_utf8_lossy(&named.stderr).contains("genie-no-push"),
        "{}",
        String::from_utf8_lossy(&named.stderr)
    );
    assert!(!git_out(&fx.remote, &["rev-parse", "--verify", "refs/heads/fix/gn-1-sync-hangs"]).status.success());
    // genie push reaches the bare remote, on the recorded branch only.
    let pushed = push(&wt, &fx.home, None).unwrap();
    assert_eq!(
        (pushed.task.as_str(), pushed.branch.as_str(), pushed.commit.as_str()),
        ("gn-1", "fix/gn-1-sync-hangs", head.as_str())
    );
    assert_eq!(git(&fx.remote, &["rev-parse", "refs/heads/fix/gn-1-sync-hangs"]), head);
    assert!(push(&wt, &fx.home, Some("fix/gn-1-sync-hangs")).is_ok());
    for other in ["fix/gn-2-other", "dev", "main", "master"] {
        let e = push(&wt, &fx.home, Some(other)).unwrap_err();
        assert_eq!(e.exit_code(), 2, "{other}: {e}");
    }
    // The checked-out branch must be the task's too, even with no branch named.
    git(&wt, &["checkout", "-q", "-b", "side"]);
    assert_eq!(push(&wt, &fx.home, None).unwrap_err().exit_code(), 2);
    git(&wt, &["symbolic-ref", "HEAD", "refs/heads/dev"]);
    assert_eq!(push(&wt, &fx.home, None).unwrap_err().exit_code(), 2);
    git(&wt, &["checkout", "-q", "fix/gn-1-sync-hangs"]);
    assert_eq!(git(&fx.remote, &["rev-parse", "refs/heads/dev"]), fx.upstream_dev(), "dev never moved");
    // Outside a task worktree push refuses; the main checkout still pushes with plain git.
    assert_eq!(push(&fx.repo, &fx.home, None).unwrap_err().exit_code(), 2);
    assert!(!git_out(&fx.repo, &["config", "--get", "remote.origin.pushurl"]).status.success());
    git(&fx.repo, &["commit", "-q", "--allow-empty", "-m", "main checkout"]);
    git(&fx.repo, &["push", "-q", "origin", "HEAD:refs/heads/from-main"]);
    assert_eq!(git(&fx.remote, &["rev-parse", "refs/heads/from-main"]), git(&fx.repo, &["rev-parse", "HEAD"]));
    let _ = &fx.seed;
}

#[test]
fn a_failed_fetch_fails_and_leaves_no_worktree_branch_or_event() {
    let fx = fixture("nofetch");
    let gone = fx.remote.with_file_name("gone.git");
    git(&fx.repo, &["remote", "set-url", "origin", gone.to_str().unwrap()]);
    let e = fx.start(&opts(None, Some("sync hangs"))).unwrap_err();
    assert_eq!(e.exit_code(), 1, "{e}");
    assert!(e.to_string().contains("git fetch origin dev failed"), "{e}");
    fx.assert_untouched(0, 0);
}

#[test]
fn an_opened_task_is_refused_before_any_fetch() {
    let fx = fixture("opened");
    fx.forge_event("gh-5", TaskEvent::Opened, "hand opened");
    // An unreachable remote: a fetch would fail with 1, so 2 proves none ran.
    let gone = fx.remote.with_file_name("gone.git");
    git(&fx.repo, &["remote", "set-url", "origin", gone.to_str().unwrap()]);
    let e = fx.start(&opts(Some("gh-5"), Some("sync hangs"))).unwrap_err();
    assert_eq!(e.exit_code(), 2, "{e}");
    assert!(e.to_string().contains("gh-5 is opened"), "{e}");
    fx.assert_untouched(1, 1);
}

#[test]
fn a_merged_task_is_refused_before_any_fetch() {
    let fx = fixture("merged");
    fx.forge_event("gh-5", TaskEvent::Opened, "hand opened");
    fx.forge_event("gh-5", TaskEvent::Merged, "hand opened");
    let gone = fx.remote.with_file_name("gone.git");
    git(&fx.repo, &["remote", "set-url", "origin", gone.to_str().unwrap()]);
    let e = fx.start(&opts(Some("gh-5"), None)).unwrap_err();
    assert_eq!(e.exit_code(), 2, "{e}");
    assert!(e.to_string().contains("gh-5 is merged"), "{e}");
    fx.assert_untouched(2, 2);
}

#[test]
fn a_task_whose_pr_closed_without_merging_starts_again() {
    let fx = fixture("closed");
    fx.forge_event("gh-6", TaskEvent::Opened, "Flaky test");
    fx.forge_event("gh-6", TaskEvent::Closed, "Flaky test");
    // No --title: the branch is named after the recorded title.
    let s = fx.start(&opts(Some("gh-6"), None)).unwrap();
    assert_eq!((s.task.as_str(), s.branch.as_str()), ("gh-6", "fix/gh-6-flaky-test"));
    let events: Vec<TaskEvent> = fx.events().iter().map(|e| e.event).collect();
    assert_eq!(events, vec![TaskEvent::Opened, TaskEvent::Closed, TaskEvent::Created]);
    let store = open_store_at(&fx.repo, &fx.home).unwrap();
    assert_eq!(store.task("gh-6").unwrap().unwrap().state, TaskState::Created);
    assert!(fx.reservations().is_empty(), "a forge id reserves no gn sequence");
}

#[test]
fn a_task_already_at_created_fails_at_the_worktree_or_the_record() {
    let fx = fixture("again");
    let first = fx.start(&opts(Some("gh-7"), Some("one"))).unwrap();
    // The same title: its worktree is there, so step (c) fails and touches nothing of the first.
    assert_eq!(fx.start(&opts(Some("gh-7"), Some("one"))).unwrap_err().exit_code(), 1);
    // Another title: (c) succeeds, apply refuses created -> created at (e), and the new worktree
    // and branch are removed again.
    let e = fx.start(&opts(Some("gh-7"), Some("two"))).unwrap_err();
    assert_eq!(e.exit_code(), 2, "{e}");
    assert!(!fx.worktrees().join("gh-7-two").exists());
    assert_eq!(fx.branches(), "dev\nfix/gh-7-one\nmain");
    assert!(Path::new(&first.worktree).join(".git").exists());
    assert_eq!(fx.events().len(), 1);
}

#[test]
fn a_failure_after_the_reservation_abandons_the_id_and_leaves_a_gap() {
    let fx = fixture("gap");
    fs::create_dir_all(fx.worktrees().join("gn-1-blocked")).unwrap();
    assert_eq!(fx.start(&opts(None, Some("blocked"))).unwrap_err().exit_code(), 1);
    assert_eq!(fx.reservations(), vec![("gn-1".into(), 1)]);
    assert!(fx.events().is_empty());
    assert_eq!(fx.start(&opts(None, Some("next"))).unwrap().task, "gn-2");
}

#[test]
fn a_shared_core_worktree_is_refused_before_the_fetch() {
    let fx = fixture("coreworktree");
    git(&fx.repo, &["config", "core.worktree", fx.repo.to_str().unwrap()]);
    let e = fx.start(&opts(None, Some("sync hangs"))).unwrap_err();
    assert_eq!(e.exit_code(), 2, "{e}");
    assert!(e.to_string().contains("config.worktree"), "{e}");
    fx.assert_untouched(0, 0);
}

#[test]
fn usage_refusals_change_nothing() {
    let fx = fixture("usage");
    for (o, why) in [
        (opts(None, None), "needs an issue id"),
        (opts(Some("gh-9"), None), "pass --title"),
        (opts(Some("gn-3"), Some("x")), "not a forge issue id"),
        (opts(None, Some("!!!")), "no letters or digits"),
        (StartOptions { kind: "Feat".into(), ..opts(None, Some("x")) }, "lowercase"),
        (StartOptions { lead: String::new(), ..opts(None, Some("x")) }, "--lead"),
    ] {
        let e = fx.start(&o).unwrap_err();
        assert_eq!(e.exit_code(), 2, "{e}");
        assert!(e.to_string().contains(why), "{e}");
    }
    fx.assert_untouched(0, 0);
    assert_eq!(fx.start(&StartOptions { kind: "feat".into(), ..opts(None, Some("x")) }).unwrap().branch, "feat/gn-1-x");
}

/// Every ref of a bare remote, for before/after comparisons.
fn refs_of(remote: &Path) -> String {
    git(remote, &["for-each-ref", "--format=%(objectname) %(refname)"])
}

#[test]
fn a_shared_pushurl_and_a_second_remote_are_locked_out_too() {
    // Review H2: `remote.<r>.pushurl` is multivalued, so a worktree sentinel appended after a shared
    // pushurl still let git push to the real URL first. The remote refs must not move at all.
    let fx = fixture("pushurl");
    let mirror = fx.remote.with_file_name("mirror.git");
    git(&fx.repo, &["init", "-q", "--bare", mirror.to_str().unwrap()]);
    git(&fx.repo, &["config", "remote.origin.pushurl", fx.remote.to_str().unwrap()]);
    git(&fx.repo, &["config", "push.default", "current"]);
    git(&fx.repo, &["remote", "add", "upstream", mirror.to_str().unwrap()]);
    let s = fx.start(&opts(None, Some("pushurl"))).unwrap();
    let wt = PathBuf::from(&s.worktree);
    git(&wt, &["commit", "-q", "--allow-empty", "-m", "fix: the work"]);
    for remote in ["origin", "upstream"] {
        assert_eq!(git(&wt, &["remote", "get-url", "--push", "--all", remote]), NO_PUSH_URL, "{remote}");
    }
    let (origin_before, mirror_before) = (refs_of(&fx.remote), refs_of(&mirror));
    for args in
        [&["push"][..], &["push", "origin", "HEAD"], &["push", "upstream", "HEAD"], &["push", "--all", "origin"]]
    {
        assert!(!git_out(&wt, args).status.success(), "{args:?} must fail");
        assert_eq!(refs_of(&fx.remote), origin_before, "{args:?} moved no ref of origin");
        assert_eq!(refs_of(&mirror), mirror_before, "{args:?} moved no ref of upstream");
    }
    // The main checkout keeps its own config and still pushes through its shared pushurl.
    assert_eq!(git(&fx.repo, &["remote", "get-url", "--push", "--all", "origin"]), fx.remote.to_str().unwrap());
    git(&fx.repo, &["push", "-q", "origin", "HEAD:refs/heads/from-main"]);
    assert!(git_out(&fx.remote, &["rev-parse", "--verify", "refs/heads/from-main"]).status.success());
    // genie push reaches the shared pushurl destination, on the task branch only.
    let pushed = push(&wt, &fx.home, None).unwrap();
    assert_eq!(git(&fx.remote, &["rev-parse", &format!("refs/heads/{}", pushed.branch)]), pushed.commit);
    assert_eq!(refs_of(&mirror), mirror_before);
}

#[test]
fn a_restart_after_close_gets_a_new_lifecycle_key_and_a_retry_keeps_it() {
    // R1-32: a created event's key gains the lifecycle generation (closed events before it) as a
    // seventh NUL-framed part, only when it is above 0.
    let fx = fixture("generation");
    let store = open_store_at(&fx.repo, &fx.home).unwrap();
    let mut created = EventRow::new(TaskEvent::Created);
    created.task = "gh-6".into();
    created.commit = "b".repeat(40);
    created.worktree = "/w/gh-6-flaky".into();
    let project = store.project().to_string();
    let key = |generation| {
        lifecycle_dedupe_key(&project, "gh-6", TaskEvent::Created, "", &"b".repeat(40), "/w/gh-6-flaky", generation)
    };
    assert_eq!(key(0), dedupe_key(&project, "gh-6", TaskEvent::Created, "", &"b".repeat(40), "/w/gh-6-flaky"));
    let first = record(&store, &project, &created).unwrap();
    assert!(matches!(&first, Recorded::Appended { dedupe_key, .. } if *dedupe_key == key(0)), "{first:?}");
    // Inside the first lifecycle the same created is a duplicate, and a different one is refused.
    assert!(
        matches!(record(&store, &project, &created).unwrap(), Recorded::Duplicate { dedupe_key } if dedupe_key == key(0))
    );
    let mut other = created.clone();
    other.worktree = "/w/gh-6-other".into();
    assert!(matches!(record(&store, &project, &other), Err(genie_tasks::Error::Refused(_))));
    fx.forge_event("gh-6", TaskEvent::Closed, "Flaky test");
    let second = record(&store, &project, &created).unwrap();
    assert!(
        matches!(&second, Recorded::Appended { dedupe_key, state: TaskState::Created, .. } if *dedupe_key == key(1)),
        "{second:?}"
    );
    assert_ne!(key(1), key(0));
    assert!(
        matches!(record(&store, &project, &created).unwrap(), Recorded::Duplicate { dedupe_key } if dedupe_key == key(1))
    );
    assert_eq!(fx.export_rows().len(), 3, "created, closed, created: a retry adds no row");
}
