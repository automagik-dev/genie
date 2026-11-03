//! T5: forge-sync against a fake `gh`/`glab` (`tests/fixtures/fake-forge`) on the forge CLI's PATH,
//! serving canned PRs/MRs from one case table rendered in each forge's reply shape. The cache clock
//! is injected, so a test expires the 60 s cache without sleeping.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::task::{Context, Poll, Waker};

use genie_forge::{Forge, ForgeSyncPart, Report, SyncOptions, classify, parse_remote, parse_time, sync, task_id};
use genie_part::{Effect, Part};
use genie_tasks::{StoredEvent, TaskState, open_store_at};
use serde_json::{Value, json};

static N: AtomicUsize = AtomicUsize::new(0);
const T0: &str = "2026-11-01T10:00:00Z";

fn t0() -> i64 {
    parse_time(T0).unwrap()
}

fn at(offset: i64) -> String {
    genie_forge::client::rfc3339(t0() + offset)
}

/// One canned PR/MR. `state` is open, merged or closed; times are seconds after `T0`.
#[derive(Clone)]
struct Case {
    n: u64,
    branch: &'static str,
    title: &'static str,
    state: &'static str,
    head: &'static str,
    updated: i64,
}

fn case(n: u64, branch: &'static str, title: &'static str, state: &'static str, head: &'static str) -> Case {
    Case { n, branch, title, state, head, updated: 600 }
}

struct Fx {
    repo: PathBuf,
    home: PathBuf,
    bin: PathBuf,
    forge: Forge,
}

fn fixture(tag: &str, forge: Forge) -> Fx {
    let root = std::env::temp_dir().join(format!(
        "genie-forge-{tag}-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = fs::remove_dir_all(&root);
    let (repo, home, bin) = (root.join("repo"), root.join("home"), root.join("bin"));
    for dir in [&repo, &home, &bin] {
        fs::create_dir_all(dir).unwrap();
    }
    let git = |args: &[&str]| assert!(Command::new("git").args(args).current_dir(&repo).status().unwrap().success());
    git(&["init", "-q", "-b", "main"]);
    let origin = match forge {
        Forge::Github => "https://github.com/o/r.git",
        Forge::Gitlab => "git@gitlab.example.com:grp/sub/proj.git",
    };
    git(&["remote", "add", "origin", origin]);
    fs::create_dir_all(repo.join(".genie")).unwrap();
    let db = rusqlite::Connection::open(repo.join(".genie/genie.db")).unwrap();
    db.execute_batch(
        "PRAGMA journal_mode = WAL; CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); PRAGMA user_version = 1;",
    )
    .unwrap();
    let fake = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-forge");
    for name in ["gh", "glab"] {
        fs::copy(&fake, bin.join(name)).unwrap();
        fs::set_permissions(bin.join(name), fs::Permissions::from_mode(0o755)).unwrap();
    }
    Fx { repo: fs::canonicalize(repo).unwrap(), home, bin, forge }
}

impl Fx {
    fn url(&self, n: u64) -> String {
        match self.forge {
            Forge::Github => format!("https://github.com/o/r/pull/{n}"),
            Forge::Gitlab => format!("https://gitlab.example.com/grp/sub/proj/-/merge_requests/{n}"),
        }
    }

    fn render(&self, c: &Case) -> Value {
        let created = at(c.n as i64);
        let done = (c.state != "open").then(|| at(c.updated));
        let merged = (c.state == "merged").then(|| at(c.updated));
        let merge_sha = format!("merge-{}", c.n);
        match self.forge {
            Forge::Github => json!({
                "number": c.n, "html_url": self.url(c.n), "title": c.title,
                "state": if c.state == "open" { "open" } else { "closed" },
                "head": {"ref": c.branch, "sha": c.head}, "merge_commit_sha": merge_sha,
                "created_at": created, "updated_at": at(c.updated), "merged_at": merged, "closed_at": done,
            }),
            Forge::Gitlab => json!({
                "iid": c.n, "web_url": self.url(c.n), "title": c.title,
                "state": if c.state == "open" { "opened" } else { c.state },
                "source_branch": c.branch, "sha": c.head,
                "merge_commit_sha": merged.as_ref().map(|_| merge_sha), "squash_commit_sha": null,
                "created_at": created, "updated_at": at(c.updated), "merged_at": merged, "closed_at": done,
            }),
        }
    }

    fn serve(&self, cases: &[Case]) {
        self.serve_values(cases.iter().map(|c| self.render(c)).collect());
    }

    fn serve_values(&self, mut items: Vec<Value>) {
        items.reverse(); // newest first, as the forge sorts
        fs::write(self.bin.join("list.json"), Value::Array(items).to_string()).unwrap();
    }

    /// The commits reply for PR `n`; `None` dates are commits the forge gives no date for.
    fn commits(&self, n: u64, dates: &[Option<String>]) {
        let items: Vec<Value> = dates
            .iter()
            .map(|d| match self.forge {
                Forge::Github => json!({"sha": "c", "commit": {"committer": {"date": d}}}),
                Forge::Gitlab => json!({"id": "c", "committed_date": d}),
            })
            .collect();
        fs::write(self.bin.join(format!("commits-{n}.json")), Value::Array(items).to_string()).unwrap();
    }

    fn sync(&self, now: i64) -> Result<Report, genie_forge::Error> {
        sync(&SyncOptions {
            project: self.repo.clone(),
            genie_home: self.home.clone(),
            path: Some(self.bin.clone().into_os_string()),
            now: Some(now),
        })
    }

    fn calls(&self) -> Vec<String> {
        fs::read_to_string(self.bin.join("calls.log")).unwrap_or_default().lines().map(String::from).collect()
    }

    fn events(&self) -> Vec<StoredEvent> {
        open_store_at(&self.repo, &self.home).unwrap().events().unwrap()
    }

    fn of(&self, n: u64) -> Vec<StoredEvent> {
        self.events().into_iter().filter(|e| e.url == self.url(n)).collect()
    }

    fn export(&self) -> Vec<Value> {
        let text = fs::read_to_string(self.home.join("tasks.jsonl")).unwrap_or_default();
        text.lines().map(|l| serde_json::from_str(l).unwrap()).collect()
    }
}

fn first_run(forge: Forge) {
    let fx = fixture("first", forge);
    fx.serve(&[
        case(1, "feat/gh-11-add-sync", "feat(forge): add sync", "open", "head-1"),
        case(2, "fix/gh-12-sync-hangs", "fix: sync hangs", "merged", "head-2"),
        case(3, "docs/gh-13-memory-note", "docs(memory): note the rule", "closed", "head-3"),
        case(4, "chore/bump", "chore(version): bump to 6.1 [auto-version]", "merged", "head-4"),
        case(5, "release/v6.2", "release: v6.2", "open", "head-5"),
    ]);
    fx.commits(1, &[Some(at(-30))]);
    fx.commits(2, &[Some(at(-60)), Some(at(60)), Some(at(120))]);
    fx.commits(4, &[None]);

    let report = fx.sync(t0() + 1_000).unwrap();
    assert_eq!((report.appended, report.duplicates, report.skipped.len(), report.cached), (5, 0, 0, false));
    let one = |n: u64| {
        let rows = fx.of(n);
        assert_eq!(rows.len(), 1, "PR {n} yields exactly one row: {rows:?}");
        rows.into_iter().next().unwrap()
    };
    let (e1, e2, e3, e4, e5) = (one(1), one(2), one(3), one(4), one(5));
    fn shape(e: &StoredEvent) -> (&str, &str, &str, bool, &str) {
        (e.event.as_str(), &e.task, &e.kind, e.counted, &e.exclude_reason)
    }
    assert_eq!(shape(&e1), ("opened", "gh-11", "feat", true, ""));
    assert_eq!(shape(&e2), ("merged", "gh-12", "fix", true, ""), "a merged PR the forge marks closed is merged only");
    assert_eq!(shape(&e3), ("closed", "gh-13", "docs", false, "docs-memory"));
    assert_eq!(shape(&e4), ("merged", "", "chore", false, "version-bump"));
    assert_eq!(shape(&e5), ("opened", "", "release", false, "release"));
    assert_eq!((e1.commit.as_str(), e2.commit.as_str(), e3.commit.as_str()), ("head-1", "merge-2", "head-3"));
    assert_eq!(
        [e1.pushed_after_open, e2.pushed_after_open, e3.pushed_after_open, e4.pushed_after_open],
        [Some(0), Some(2), Some(0), None],
        "0 and 2 counted; a commit the forge gives no date for is unknown, never 0"
    );
    assert_eq!(e4.task_key, format!("pr:{}:{}", forge.as_str(), fx.url(4)), "an untracked branch is keyed by its url");
    assert!(fx.events().iter().all(|e| e.forge == forge.as_str()));

    let rows = fx.export();
    assert_eq!(rows.len(), 5);
    let row4 = rows.iter().find(|r| r["url"] == fx.url(4)).unwrap();
    assert!(row4["task"].is_null(), "M3: an untracked PR's export row carries task: null, not ''");
    assert_eq!(rows.iter().find(|r| r["url"] == fx.url(1)).unwrap()["task"], "gh-11");

    // Within 60 s: the cached reply, no forge call at all.
    let calls = fx.calls().len();
    let again = fx.sync(t0() + 1_030).unwrap();
    assert!(again.cached);
    assert_eq!(fx.calls().len(), calls, "a run within 60 s makes no forge call");
    assert_eq!((again.appended, again.duplicates), (0, 0));

    // Cache expired, same reply: the cursor holds every PR, so nothing is planned or appended.
    let expired = fx.sync(t0() + 1_100).unwrap();
    assert!(!expired.cached && fx.calls().len() > calls);
    assert_eq!((expired.appended, expired.duplicates, expired.skipped.len()), (0, 0, 0));

    // Cache and cursor gone: the same reply replans, and the store dedupes every repeat.
    fs::remove_dir_all(fx.home.join("cache")).unwrap();
    let replanned = fx.sync(t0() + 1_200).unwrap();
    assert_eq!((replanned.appended, replanned.duplicates, replanned.skipped.len()), (0, 3, 0));
    assert_eq!(
        (fx.events().len(), fx.export().len()),
        (5, 5),
        "a second run, the untracked PRs included, appends nothing"
    );

    if forge == Forge::Gitlab {
        let calls = fx.calls();
        assert!(calls.iter().any(|c| c == "auth status --hostname gitlab.example.com"), "{calls:?}");
        assert!(calls.iter().filter(|c| c.starts_with("api ")).all(|c| c.ends_with("--hostname gitlab.example.com")));
        assert!(calls.iter().any(|c| c.contains("projects/grp%2Fsub%2Fproj/merge_requests?")), "{calls:?}");
    }
}

#[test]
fn first_run_records_opened_merged_and_closed_and_repeats_append_nothing() {
    first_run(Forge::Github);
}

#[test]
fn a_fake_glab_on_a_non_github_host_gives_the_same_results() {
    first_run(Forge::Gitlab);
}

#[test]
fn two_untracked_prs_in_a_row_and_a_pr_first_seen_merged() {
    let fx = fixture("untracked", Forge::Github);
    let a = |state, updated| Case { updated, ..case(1, "misc-a", "fix: a", state, "head-a") };
    let b = |state, updated| Case { updated, ..case(2, "misc-b", "fix: b", state, "head-b") };
    let c = Case { updated: 700, ..case(3, "fix/gh-40-quick", "fix: quick", "merged", "head-c") };
    let passes = [
        vec![a("open", 100)],
        vec![a("merged", 700), c.clone()],
        vec![a("merged", 700), c.clone(), b("open", 800)],
        vec![a("merged", 700), c, b("merged", 900)],
    ];
    for (i, cases) in passes.iter().enumerate() {
        fx.serve(cases);
        let report = fx.sync(t0() + 1_000 + 61 * i as i64).unwrap();
        assert!(report.skipped.is_empty(), "pass {i}: {:?}", report.skipped);
    }
    let kinds = |n| fx.of(n).iter().map(|e| e.event.as_str()).collect::<Vec<_>>();
    assert_eq!((kinds(1), kinds(2)), (vec!["opened", "merged"], vec!["opened", "merged"]), "four rows for A and B");
    assert_eq!(kinds(3), vec!["merged"], "opened and merged between two syncs: one merged row");
    let tasks = open_store_at(&fx.repo, &fx.home).unwrap().tasks().unwrap();
    let untracked: Vec<_> = tasks.iter().filter(|t| t.task.is_empty()).collect();
    assert_eq!(untracked.len(), 2, "two v7_tasks rows, one per url");
    assert!(untracked.iter().all(|t| t.state == TaskState::Merged));
}

#[test]
fn a_head_that_moves_between_syncs_yields_one_opened_with_the_first_head() {
    let fx = fixture("m4", Forge::Github);
    let pr = |state, head, updated| Case { updated, ..case(20, "feat/gh-20-move", "feat: move", state, head) };
    for (i, cases) in [pr("open", "head-first", 100), pr("open", "head-second", 200), pr("merged", "head-second", 300)]
        .into_iter()
        .enumerate()
    {
        fx.serve(&[cases]);
        assert!(fx.sync(t0() + 1_000 + 61 * i as i64).unwrap().skipped.is_empty());
    }
    let rows: Vec<_> = fx.of(20).iter().map(|e| (e.event.as_str().to_string(), e.commit.clone())).collect();
    assert_eq!(
        rows,
        [("opened".to_string(), "head-first".to_string()), ("merged".to_string(), "merge-20".to_string())]
    );
}

#[test]
fn a_reopened_pr_merged_after_its_close_is_skipped_reported_and_the_rest_commits() {
    let fx = fixture("reopen", Forge::Github);
    let closed = Case { updated: 100, ..case(30, "fix/gh-30-flaky", "fix: flaky", "closed", "head-30") };
    fx.serve(&[closed]);
    fx.sync(t0() + 1_000).unwrap();
    let merged = Case { updated: 200, ..case(30, "fix/gh-30-flaky", "fix: flaky", "merged", "head-30") };
    let other = Case { updated: 150, ..case(31, "feat/gh-31-next", "feat: next", "open", "head-31") };
    fx.serve(&[other, merged]);

    let report = fx.sync(t0() + 1_061).expect("a refused forge event is not fatal");
    assert_eq!(report.skipped.len(), 1, "{:?}", report.skipped);
    let skip = &report.skipped[0];
    assert_eq!((skip.task.as_str(), skip.event), ("gh-30", "merged"));
    let line = skip.to_string();
    assert!(line.contains("gh-30") && line.contains("refused closed -> merged"), "{line}");
    assert_eq!(report.appended, 1, "the other PR of the same pass is committed");
    assert_eq!(fx.of(30).len(), 1, "nothing is written for the refused event");
    assert_eq!(fx.of(31).len(), 1);

    let next = fx.sync(t0() + 1_122).unwrap();
    assert!(next.skipped.is_empty(), "the cursor advanced, so the next run does not re-report it");
    assert_eq!(next.appended, 0);
}

#[test]
fn a_nul_in_the_url_or_head_commit_exits_1_and_writes_nothing() {
    for (field, tag) in [("html_url", "nul-url"), ("head", "nul-head")] {
        let fx = fixture(tag, Forge::Github);
        let good = fx.render(&case(1, "feat/gh-1-ok", "feat: ok", "open", "head-1"));
        let mut bad = fx.render(&case(2, "feat/gh-2-bad", "feat: bad", "merged", "head-2"));
        if field == "head" {
            bad["head"]["sha"] = json!("head\u{0}2");
        } else {
            bad[field] = json!("https://github.com/o/r/pull/2\u{0}x");
        }
        fx.serve_values(vec![good, bad]);
        let err = fx.sync(t0() + 1_000).unwrap_err();
        assert_eq!(err.exit_code(), 1, "{err}");
        assert!(err.to_string().contains("NUL"), "{err}");
        assert!(fx.events().is_empty() && !fx.home.join("tasks.jsonl").exists(), "{field}: nothing written");
    }
}

#[test]
fn a_missing_gh_exits_1_and_writes_nothing() {
    let fx = fixture("no-gh", Forge::Github);
    fx.serve(&[case(1, "feat/gh-1-ok", "feat: ok", "open", "head-1")]);
    fs::remove_file(fx.bin.join("gh")).unwrap();
    let err = fx.sync(t0() + 1_000).unwrap_err();
    assert_eq!(err.exit_code(), 1);
    assert!(err.to_string().contains("gh auth login"), "{err}");
    assert!(fx.events().is_empty() && !fx.home.join("tasks.jsonl").exists());
}

#[test]
fn a_missing_genie_db_refuses_with_2_before_any_forge_call() {
    let fx = fixture("no-db", Forge::Github);
    fs::remove_file(fx.repo.join(".genie/genie.db")).unwrap();
    let err = fx.sync(t0() + 1_000).unwrap_err();
    assert_eq!(err.exit_code(), 2, "{err}");
    assert!(err.to_string().contains("genie task list"), "{err}");
    assert!(fx.calls().is_empty() && !fx.repo.join(".genie/genie.db").exists());
}

#[test]
fn task_ids_types_exclusions_remotes_and_timestamps() {
    assert_eq!(task_id("fix/gh-12-sync-hangs"), Some("gh-12"));
    assert_eq!(task_id("feat/gn-3-x"), Some("gn-3"));
    assert_eq!(task_id("fix/gl-7-y"), Some("gl-7"));
    for untracked in ["fix/gh-12", "Fix/gh-1-x", "fix/gh--x", "gh-1-x", "fix/xx-1-y", "/gh-1-x"] {
        assert_eq!(task_id(untracked), None, "{untracked}");
    }
    assert_eq!(classify("feat(forge)!: x"), ("feat".to_string(), None));
    assert_eq!(classify("Merge branch dev"), (String::new(), None));
    assert_eq!(classify("chore(release): cut 6.2").1, Some("release"));
    assert_eq!(classify("chore: bump version to 6.2").1, Some("version-bump"));
    for (url, host, path) in [
        ("https://github.com/o/r.git", "github.com", "o/r"),
        ("git@github.com:o/r.git", "github.com", "o/r"),
        ("ssh://git@GitLab.example.com:2222/grp/sub/proj.git", "gitlab.example.com", "grp/sub/proj"),
    ] {
        let remote = parse_remote(url).unwrap();
        assert_eq!((remote.host.as_str(), remote.path.as_str()), (host, path));
    }
    assert!(parse_remote("/srv/git/repo").is_none());
    assert_eq!(parse_time("2026-11-03T04:20:05Z"), parse_time("2026-11-03T06:20:05.123+02:00"));
    assert_eq!(genie_forge::client::rfc3339(parse_time("2024-02-29T23:59:59Z").unwrap()), "2024-02-29T23:59:59Z");
    assert_eq!(parse_time("2026-13-01T00:00:00Z"), None);
}

#[test]
fn the_part_declares_forge_sync_reversible_and_reports_a_refusal_as_an_error_output() {
    let fx = fixture("part", Forge::Github);
    fs::remove_file(fx.repo.join(".genie/genie.db")).unwrap();
    let part = ForgeSyncPart::new(fx.home.clone());
    let tool = &part.manifest().tools[0];
    assert_eq!((tool.name.as_str(), tool.effect), ("forge_sync", Effect::Reversible));
    assert_eq!(part.digest().len(), 64);
    assert!(part.schema("forge_sync").is_some() && part.schema("other").is_none());
    let mut args = serde_json::Map::new();
    args.insert("project".into(), json!(fx.repo));
    let mut call = part.call("forge_sync", args);
    let Poll::Ready(out) = call.as_mut().poll(&mut Context::from_waker(Waker::noop())) else {
        panic!("forge_sync runs to completion in one poll");
    };
    let out = out.unwrap();
    assert!(out.is_error && out.text.contains("genie task list"), "{}", out.text);
    assert!(fx.calls().is_empty());
}
