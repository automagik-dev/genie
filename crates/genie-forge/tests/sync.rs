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
use sha2::{Digest, Sha256};

static N: AtomicUsize = AtomicUsize::new(0);
const T0: &str = "2026-11-01T10:00:00Z";

fn t0() -> i64 {
    parse_time(T0).unwrap()
}

fn at(offset: i64) -> String {
    genie_forge::client::rfc3339(t0() + offset)
}

/// `at(offset)` with a fractional-second suffix such as `.200` (GitLab's timestamps carry one).
fn at_frac(offset: i64, frac: &str) -> String {
    let whole = at(offset);
    format!("{}{frac}Z", &whole[..whole.len() - 1])
}

/// A credential that must never reach a file genie-forge writes or a line it prints.
const FAKE_TOKEN: &str = "FAKE_TOKEN_9f3c";

/// One canned PR/MR. `state` is open, merged or closed; times are seconds after `T0`.
#[derive(Clone)]
struct Case {
    n: u64,
    branch: &'static str,
    title: &'static str,
    state: &'static str,
    head: &'static str,
    updated: i64,
    /// A fractional-second suffix for `updated_at` (`.200`), or `''`.
    frac: &'static str,
}

fn case(n: u64, branch: &'static str, title: &'static str, state: &'static str, head: &'static str) -> Case {
    Case { n, branch, title, state, head, updated: 600, frac: "" }
}

/// One push to a PR's head after it opened: (`push` or `force_push`, seconds after `T0`, commits it
/// adds; `None` makes the forge fail the count call).
type Push = (&'static str, i64, Option<u64>);

struct Fx {
    repo: PathBuf,
    home: PathBuf,
    bin: PathBuf,
    forge: Forge,
}

fn fixture(tag: &str, forge: Forge) -> Fx {
    let origin = match forge {
        Forge::Github => "https://github.com/o/r.git",
        Forge::Gitlab => "git@gitlab.example.com:grp/sub/proj.git",
    };
    fixture_at(tag, forge, origin)
}

fn fixture_at(tag: &str, forge: Forge, origin: &str) -> Fx {
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
        let updated = at_frac(c.updated, c.frac);
        let done = (c.state != "open").then(|| at(c.updated));
        let merged = (c.state == "merged").then(|| at(c.updated));
        let merge_sha = format!("merge-{}", c.n);
        match self.forge {
            Forge::Github => json!({
                "number": c.n, "html_url": self.url(c.n), "title": c.title,
                "state": if c.state == "open" { "open" } else { "closed" },
                "head": {"ref": c.branch, "sha": c.head, "repo": {"full_name": "o/r"}}, "merge_commit_sha": merge_sha,
                "created_at": created, "updated_at": updated, "merged_at": merged, "closed_at": done,
            }),
            Forge::Gitlab => json!({
                "iid": c.n, "web_url": self.url(c.n), "title": c.title,
                "state": if c.state == "open" { "opened" } else { c.state },
                "source_branch": c.branch, "sha": c.head,
                "merge_commit_sha": merged.as_ref().map(|_| merge_sha), "squash_commit_sha": null,
                "created_at": created, "updated_at": updated, "merged_at": merged, "closed_at": done,
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

    /// The forge's push record for PR `c`. GitHub: head-ref activity (a `branch_creation` before the
    /// open when `reaches_back`) plus one compare per push. GitLab: diff versions (none when not
    /// `reaches_back`) plus one compare per later version.
    fn pushes(&self, c: &Case, pushes: &[Push], reaches_back: bool) {
        let write = |name: String, body: String| fs::write(self.bin.join(name), body).unwrap();
        let compare = |n: Option<u64>, ok: Value| n.map_or("!fail".to_string(), |_| ok.to_string());
        match self.forge {
            Forge::Github => {
                let mut lines = Vec::new();
                if reaches_back {
                    let created = json!({"activity_type": "branch_creation", "timestamp": at(c.n as i64 - 5),
                        "before": "0000000000000000000000000000000000000000", "after": "start"});
                    lines.push(created.to_string());
                }
                for (i, (kind, offset, n)) in pushes.iter().enumerate() {
                    let (before, after) = (format!("b{}-{i}", c.n), format!("a{}-{i}", c.n));
                    let item =
                        json!({"activity_type": kind, "timestamp": at(*offset), "before": before, "after": after});
                    lines.push(item.to_string());
                    write(format!("compare-{before}...{after}.json"), compare(*n, json!({"ahead_by": n})));
                }
                lines.reverse();
                write(format!("activity-refs%2Fheads%2F{}.json", c.branch.replace('/', "%2F")), lines.join("\n"));
            }
            Forge::Gitlab => {
                if !reaches_back {
                    return;
                }
                let head = |i: usize| format!("v{}-{i}", c.n);
                let versions: Vec<Value> =
                    (0..=pushes.len()).map(|i| json!({"id": i + 1, "head_commit_sha": head(i)})).rev().collect();
                write(format!("versions-{}.json", c.n), Value::Array(versions).to_string());
                for (i, (_, _, n)) in pushes.iter().enumerate() {
                    let commits: Vec<Value> = (0..n.unwrap_or(0)).map(|k| json!({"id": format!("c{k}")})).collect();
                    write(
                        format!("compare-{}...{}.json", head(i), head(i + 1)),
                        compare(*n, json!({"commits": commits})),
                    );
                }
            }
        }
    }

    /// Every file under `<GENIE_HOME>`, as bytes.
    fn home_files(&self) -> Vec<(PathBuf, Vec<u8>)> {
        let mut out = Vec::new();
        let mut dirs = vec![self.home.clone()];
        while let Some(dir) = dirs.pop() {
            for entry in fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() { dirs.push(path) } else { out.push((path.clone(), fs::read(path).unwrap())) }
            }
        }
        out
    }

    fn sync(&self, now: i64) -> Result<Report, genie_forge::Error> {
        self.sync_mode(now, false)
    }

    /// One pass, `--full` when `full`.
    fn sync_mode(&self, now: i64, full: bool) -> Result<Report, genie_forge::Error> {
        sync(&SyncOptions {
            project: self.repo.clone(),
            genie_home: self.home.clone(),
            path: Some(self.bin.clone().into_os_string()),
            now: Some(now),
            full,
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

    /// Serve `pages` as `list-<N>.json`, each page newest first as given, and drop `list.json` so no
    /// later page falls back to it.
    fn serve_pages(&self, pages: &[&[Case]]) {
        let _ = fs::remove_file(self.bin.join("list.json"));
        for (i, page) in pages.iter().enumerate() {
            let items: Vec<Value> = page.iter().map(|c| self.render(c)).collect();
            fs::write(self.bin.join(format!("list-{}.json", i + 1)), Value::Array(items).to_string()).unwrap();
        }
    }

    /// Make page `n` of the list fail.
    fn fail_page(&self, n: usize) {
        fs::write(self.bin.join(format!("list-{n}.json")), "!fail\n").unwrap();
    }

    /// The list calls that asked for page `n`.
    fn page_calls(&self, n: usize) -> usize {
        let tail = format!("&page={n}");
        self.calls().iter().filter(|c| c.contains("/pulls?") && c.ends_with(&tail)).count()
    }

    /// The cursor file, named by a sha256 of the project computed here, independently of `sync.rs`.
    fn cursor_path(&self) -> PathBuf {
        let digest: String =
            Sha256::digest(self.repo.to_str().unwrap().as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
        self.home.join("cache/forge").join(format!("{digest}.cursor.json"))
    }

    fn cursor(&self) -> Value {
        serde_json::from_slice(&fs::read(self.cursor_path()).unwrap()).unwrap()
    }

    fn recorded_urls(&self) -> std::collections::BTreeSet<String> {
        self.events().into_iter().map(|e| e.url).collect()
    }
}

fn first_run(forge: Forge) {
    let fx = fixture("first", forge);
    let (c2, c4) = (
        case(2, "fix/gh-12-sync-hangs", "fix: sync hangs", "merged", "head-2"),
        case(4, "chore/bump", "chore(version): bump to 6.1 [auto-version]", "merged", "head-4"),
    );
    fx.serve(&[
        case(1, "feat/gh-11-add-sync", "feat(forge): add sync", "open", "head-1"),
        c2.clone(),
        case(3, "docs/gh-13-memory-note", "docs(memory): note the rule", "closed", "head-3"),
        c4.clone(),
        case(5, "release/v6.2", "release: v6.2", "open", "head-5"),
    ]);
    fx.pushes(&c2, &[("push", 60, Some(2))], true);
    fx.pushes(&c4, &[("push", 60, Some(1))], false);

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
        [None, Some(2), None, None],
        "only a merge carries the count; a history that does not reach back to the open is unknown, never 0"
    );
    assert_eq!(e4.task_key, format!("pr:{}:{}", forge.as_str(), fx.url(4)), "an untracked branch is keyed by its url");
    assert!(fx.events().iter().all(|e| e.forge == forge.as_str()));

    let rows = fx.export();
    assert_eq!(rows.len(), 5);
    let row4 = rows.iter().find(|r| r["url"] == fx.url(4)).unwrap();
    assert_eq!(row4.get("task"), Some(&Value::Null), "M3: an untracked PR's export row carries task: null, not ''");
    assert_eq!(row4.get("pushed_after_open"), Some(&Value::Null), "unknown exports null, never 0");
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

    let forge_dir = fx.home.join("cache/forge");
    let names: Vec<String> =
        fs::read_dir(&forge_dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    assert!(names.iter().any(|n| n.ends_with(".cursor.json")), "the cursor has its own file: {names:?}");
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
    assert_eq!(classify("Release v6.2").1, Some("release"));
    for counted in ["fix: release notes typo", "fix: don't bump version twice", "Releases page fix"] {
        assert_eq!(classify(counted).1, None, "{counted}");
    }
    for (url, host, path) in [
        ("https://github.com/o/r.git", "github.com", "o/r"),
        ("git@github.com:o/r.git", "github.com", "o/r"),
        ("ssh://git@GitLab.example.com:2222/grp/sub/proj.git", "gitlab.example.com", "grp/sub/proj"),
    ] {
        let remote = parse_remote(url).unwrap();
        assert_eq!((remote.host.as_str(), remote.path.as_str()), (host, path));
    }
    assert!(parse_remote("/srv/git/repo").is_none());
    let tokened = parse_remote(&format!("https://ci-user:{FAKE_TOKEN}@github.com/o/r.git?x=1")).unwrap();
    assert_eq!(tokened.id(), "github.com/o/r", "the identity drops userinfo and query");
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

fn pushed(fx: &Fx, n: u64) -> Option<i64> {
    let rows = fx.of(n);
    assert_eq!(rows.len(), 1, "{rows:?}");
    rows[0].pushed_after_open
}

#[test]
fn pushed_after_open_counts_pushes_from_the_forge_record_never_commit_dates() {
    let fx = fixture("pushes", Forge::Github);
    let merged = |n, branch| Case { updated: 900, ..case(n, branch, "fix: x", "merged", "head") };
    let (later, forced, fork, failed, unknown) = (
        merged(7, "fix/gh-7-old-commit"),
        merged(8, "fix/gh-8-forced"),
        merged(9, "fix/gh-9-fork"),
        merged(10, "fix/gh-10-gone"),
        merged(11, "fix/gh-11-old"),
    );
    // A commit created before the open and pushed after it: the push record counts it, whatever its date.
    fx.pushes(&later, &[("push", 300, Some(1)), ("push", 1_000, Some(4))], true);
    fx.pushes(&forced, &[("force_push", 300, Some(2)), ("push", 400, Some(1))], true);
    fx.pushes(&fork, &[("push", 300, Some(1))], true);
    fx.pushes(&failed, &[("force_push", 300, None)], true);
    fx.pushes(&unknown, &[("push", 300, Some(1))], false);
    let mut items: Vec<Value> = [&later, &forced, &fork, &failed, &unknown].iter().map(|c| fx.render(c)).collect();
    items[2]["head"]["repo"]["full_name"] = json!("someone/r");
    fx.serve_values(items);

    let report = fx.sync(t0() + 1_000).unwrap();
    assert_eq!(report.appended, 5);
    assert_eq!(pushed(&fx, 7), Some(1), "one push after the open, the push after the merge ignored");
    assert_eq!(pushed(&fx, 8), Some(3), "a force push counts the commits it adds");
    assert_eq!(pushed(&fx, 9), None, "a fork's pushes are not in this repository's record");
    assert_eq!(pushed(&fx, 10), None, "a force push whose new commits cannot be computed is unknown");
    assert_eq!(pushed(&fx, 11), None, "a record that does not reach back to the open is unknown");
    let rows = fx.export();
    let row = |n: u64| rows.iter().find(|r| r["url"] == fx.url(n)).unwrap().clone();
    assert_eq!(
        (row(8).get("pushed_after_open"), row(11).get("pushed_after_open")),
        (Some(&json!(3)), Some(&Value::Null))
    );
    assert!(!fx.calls().iter().any(|c| c.contains("/commits")), "commit lists and their dates are never read");
}

#[test]
fn a_gitlab_force_push_counts_the_commits_its_version_adds() {
    let fx = fixture("versions", Forge::Gitlab);
    let mr = Case { updated: 900, ..case(12, "fix/gl-12-forced", "fix: x", "merged", "head") };
    fx.pushes(&mr, &[("force_push", 300, Some(2)), ("push", 400, Some(1))], true);
    fx.serve(&[mr]);
    fx.sync(t0() + 1_000).unwrap();
    assert_eq!(pushed(&fx, 12), Some(3));
}

#[test]
fn a_state_change_inside_the_same_second_is_never_lost() {
    let fx = fixture("same-second", Forge::Github);
    let pr = |n, state| Case { updated: 100, ..case(n, "fix/gh-50-race", "fix: race", state, "head-50") };
    let other = |n, state| Case { updated: 100, ..case(n, "fix/gh-51-race", "fix: race", state, "head-51") };
    fx.serve(&[pr(50, "open"), other(51, "open")]);
    assert_eq!(fx.sync(t0() + 1_000).unwrap().appended, 2);
    // Both finish in the second the first sync already saw: same updated_at, new state.
    fx.serve(&[pr(50, "merged"), other(51, "closed")]);
    let report = fx.sync(t0() + 1_061).unwrap();
    assert_eq!((report.appended, report.skipped.len()), (2, 0));
    let kinds = |n| fx.of(n).iter().map(|e| e.event.as_str()).collect::<Vec<_>>();
    assert_eq!((kinds(50), kinds(51)), (vec!["opened", "merged"], vec!["opened", "closed"]));
    let again = fx.sync(t0() + 1_122).unwrap();
    assert_eq!((again.appended, again.duplicates, again.skipped.len()), (0, 0, 0), "unchanged PRs are not reprocessed");
}

#[test]
fn a_change_inside_a_fractional_second_is_never_lost() {
    let fx = fixture("fraction", Forge::Gitlab);
    let mr = |state, frac| Case { updated: 100, frac, ..case(60, "fix/gl-60-frac", "fix: frac", state, "head-60") };
    fx.serve(&[mr("open", ".200")]);
    fx.sync(t0() + 1_000).unwrap();
    fx.serve(&[mr("merged", ".700")]);
    assert_eq!(fx.sync(t0() + 1_061).unwrap().appended, 1);
    assert_eq!(fx.of(60).iter().map(|e| e.event.as_str()).collect::<Vec<_>>(), ["opened", "merged"]);
}

#[test]
fn a_token_in_the_origin_url_is_never_stored_or_printed() {
    let fx = fixture_at("token", Forge::Github, &format!("https://ci-user:{FAKE_TOKEN}@github.com/o/r.git"));
    let pr = Case { updated: 900, ..case(1, "fix/gh-1-x", "fix: x", "merged", "head") };
    fx.pushes(&pr, &[("push", 300, Some(1))], true);
    fx.serve(&[pr]);
    fx.sync(t0() + 1_000).unwrap();
    let files = fx.home_files();
    assert!(files.iter().any(|(p, _)| p.to_string_lossy().ends_with(".cursor.json")), "{files:?}");
    for (path, bytes) in &files {
        let text = String::from_utf8_lossy(bytes);
        assert!(!text.contains(FAKE_TOKEN) && !text.contains("ci-user"), "{} carries the credential", path.display());
    }
    let bad = fixture_at("token-bad", Forge::Github, &format!("https://ci-user:{FAKE_TOKEN}@github.com"));
    let err = bad.sync(t0() + 1_000).unwrap_err();
    assert!(!err.to_string().contains(FAKE_TOKEN), "{err}");
}

#[test]
fn an_activity_tied_with_the_open_is_unknown_and_merge_activity_counts_like_a_push() {
    let fx = fixture("ties", Forge::Github);
    // Each PR opens at `at(n)` (second precision) and merges at `at(900)`.
    let merged = |n, branch| Case { updated: 900, ..case(n, branch, "fix: x", "merged", "head") };
    let activity = |c: &Case, items: &[(&str, String, Option<u64>)]| {
        let created = json!({"activity_type": "branch_creation", "timestamp": at(c.n as i64 - 60),
            "before": "0000000000000000000000000000000000000000", "after": "start"});
        let mut lines = vec![created.to_string()];
        for (i, (kind, timestamp, n)) in items.iter().enumerate() {
            let (before, after) = (format!("b{}-{i}", c.n), format!("a{}-{i}", c.n));
            lines.push(
                json!({"activity_type": kind, "timestamp": timestamp, "before": before, "after": after}).to_string(),
            );
            let body = n.map_or("!fail".to_string(), |n| json!({"ahead_by": n}).to_string());
            fs::write(fx.bin.join(format!("compare-{before}...{after}.json")), body).unwrap();
        }
        let name = format!("activity-refs%2Fheads%2F{}.json", c.branch.replace('/', "%2F"));
        fs::write(fx.bin.join(name), lines.join("\n")).unwrap();
    };
    let cases = [
        merged(20, "fix/gh-20-tie"),
        merged(21, "fix/gh-21-zero"),
        merged(22, "fix/gh-22-frac-tie"),
        merged(23, "fix/gh-23-frac-after"),
        merged(24, "fix/gh-24-pr-merge"),
        merged(25, "fix/gh-25-queue"),
        merged(26, "fix/gh-26-unknown"),
        merged(27, "fix/gh-27-merge-tie"),
        merged(28, "fix/gh-28-after-merge"),
    ];
    activity(&cases[0], &[("push", at(20), Some(1))]); // the same second as the open
    // Known zero: a push a fraction before the open, one after the merge, nothing in between.
    activity(&cases[1], &[("push", at_frac(20, ".999"), Some(1)), ("push", at(901), Some(1))]);
    activity(&cases[2], &[("push", at_frac(22, ".500"), Some(1))]); // inside the open's second
    activity(&cases[3], &[("push", at_frac(23, ".700"), Some(1))]); // after an open at .200
    activity(&cases[4], &[("pr_merge", at(300), Some(1))]);
    activity(&cases[5], &[("merge_queue_merge", at(300), Some(2)), ("push", at(400), Some(1))]);
    activity(&cases[6], &[("push", at(300), Some(1)), ("branch_rename", at(400), Some(1))]);
    activity(&cases[7], &[("push", at(300), Some(1)), ("push", at(900), Some(1))]); // the merge's second
    activity(&cases[8], &[("push", at(300), Some(1)), ("push", at_frac(901, ".000"), Some(5))]);
    let mut items: Vec<Value> = cases.iter().map(|c| fx.render(c)).collect();
    items[3]["created_at"] = json!(at_frac(23, ".200"));
    fx.serve_values(items);

    assert_eq!(fx.sync(t0() + 1_000).unwrap().appended, 9);
    assert_eq!(pushed(&fx, 20), None, "a push tied with the open is unresolved, never assumed pre-open");
    assert_eq!(pushed(&fx, 21), Some(0), "the known-zero control stays 0");
    assert_eq!(pushed(&fx, 22), None, "a fractional time inside the open's second is still a tie");
    assert_eq!(pushed(&fx, 23), Some(1), "fractional precision resolves the order when it can");
    assert_eq!(pushed(&fx, 24), Some(1), "a pr_merge into the head counts like a push");
    assert_eq!(pushed(&fx, 25), Some(3), "a merge_queue_merge counts like a push");
    assert_eq!(pushed(&fx, 26), None, "an unknown activity type after the open makes the count unknown");
    assert_eq!(pushed(&fx, 27), None, "a push tied with the merge is unresolved, never credited or dropped");
    assert_eq!(pushed(&fx, 28), Some(1), "a push resolvably after the merge is excluded, the one before counted");
}

const DAY: i64 = 86_400;

/// The clock of the paging tests: 90 days after `T0`.
fn now90() -> i64 {
    t0() + 90 * DAY
}

/// An open PR on an untracked branch, updated `age` seconds before `now90()`.
fn aged(n: u64, age: i64) -> Case {
    Case { updated: 90 * DAY - age, ..case(n, "chore/paged", "chore: paged", "open", "head-p") }
}

/// Page `k` (1-based) of a 90-day history: 100 PRs, newest first. Page 1 spans ages 0.2-20 days,
/// page 2 20.2-40 days (the 30-day horizon is its 50th row), page 3 40.5-90 days.
fn history_page(k: u64) -> Vec<Case> {
    (1..=100_i64)
        .map(|j| {
            let age = match k {
                1 => j * DAY / 5,
                2 => 20 * DAY + j * DAY / 5,
                _ => 40 * DAY + j * DAY / 2,
            };
            aged((k - 1) * 100 + j as u64, age)
        })
        .collect()
}

fn urls(fx: &Fx, ns: impl IntoIterator<Item = u64>) -> std::collections::BTreeSet<String> {
    ns.into_iter().map(|n| fx.url(n)).collect()
}

#[test]
fn t1c_a_first_pass_stops_at_the_30_day_horizon_and_records_nothing_older() {
    let fx = fixture("horizon", Forge::Github);
    let (p1, p2, p3) = (history_page(1), history_page(2), history_page(3));
    fx.serve_pages(&[&p1, &p2, &p3]);
    let report = fx.sync(now90()).unwrap();
    assert_eq!((fx.page_calls(1), fx.page_calls(2), fx.page_calls(3)), (1, 1, 0), "{:?}", fx.calls());
    assert_eq!(report.appended, 150, "page 1 and the 50 rows of page 2 inside the horizon");
    assert_eq!(fx.recorded_urls(), urls(&fx, 1..=150), "no PR older than 30 days is recorded");
    assert_eq!(fx.cursor()["since"], json!(now90() - DAY / 5), "a completed pass: page 1's newest updated_at");
}

#[test]
fn t1c_a_cut_first_pass_keeps_page_1_and_since_null_and_its_rerun_repeats_no_count_call() {
    let fx = fixture("resume", Forge::Github);
    let mut p1 = history_page(1);
    let merged = Case { updated: 90 * DAY - DAY, ..case(5, "fix/gh-5-merged", "fix: merged", "merged", "head-5") };
    p1[4] = merged.clone();
    fx.pushes(&merged, &[("push", 60, Some(2))], true);
    fx.serve_pages(&[&p1]);
    fx.fail_page(2);

    assert!(fx.sync(now90()).is_err(), "page 2 fails");
    assert_eq!((fx.page_calls(1), fx.page_calls(2)), (1, 1), "page 2 is only asked after a full page 1");
    assert_eq!(fx.recorded_urls(), urls(&fx, 1..=100), "page 1's events committed");
    let cursor = fx.cursor();
    assert_eq!(cursor["since"], Value::Null, "a cut pass completes nothing");
    let seen: Vec<&String> = cursor["seen"].as_object().unwrap().keys().collect();
    assert_eq!(seen.len(), 100, "page 1's PRs are seen");
    assert!(String::from_utf8(fs::read(fx.cursor_path()).unwrap()).unwrap().contains("\"since\":null"));
    let cache = fx.cursor_path().to_string_lossy().replace(".cursor.json", ".json");
    assert!(!Path::new(&cache).exists(), "the reply cache is written only when a pass completes");
    let counts = |fx: &Fx| fx.calls().iter().filter(|c| c.contains("/activity?ref=refs%2Fheads%2Ffix%2Fgh-5")).count();
    assert_eq!(counts(&fx), 1);

    fx.serve_pages(&[&p1, &history_page(2)]);
    let rerun = fx.sync(now90()).unwrap(); // the same clock: the horizon row stays inside
    assert_eq!((fx.page_calls(1), fx.page_calls(2)), (2, 2), "the rerun re-lists from the newest page");
    assert_eq!(counts(&fx), 1, "no pushed_after_open call repeats");
    assert_eq!((rerun.appended, rerun.duplicates), (50, 0), "page 1's seen PRs are skipped");
    assert_eq!(fx.of(5)[0].pushed_after_open, Some(2));
    assert_eq!(
        fx.cursor()["since"],
        json!(now90() - DAY / 5),
        "since is what page 1 LISTED, though its PRs were all seen and none processed"
    );
}

#[test]
fn t1c_an_incremental_pass_cut_on_page_2_keeps_its_since_and_adds_page_1_to_seen() {
    let fx = fixture("incremental", Forge::Github);
    fx.serve_values(vec![fx.render(&aged(900, 11 * DAY)), fx.render(&aged(901, 10 * DAY))]);
    fx.sync(now90()).unwrap();
    let since = now90() - 10 * DAY;
    assert_eq!(fx.cursor()["since"], json!(since));

    let p1: Vec<Case> = (1..=100_i64).map(|j| aged(j as u64, j * DAY / 20)).collect();
    fx.serve_pages(&[&p1]);
    fx.fail_page(2);
    assert!(fx.sync(now90() + 100).is_err());
    assert_eq!((fx.page_calls(1), fx.page_calls(2)), (2, 1), "page 1 again, then page 2");
    let cursor = fx.cursor();
    assert_eq!(cursor["since"], json!(since), "a cut incremental pass leaves since = N, never null");
    let seen = cursor["seen"].as_object().unwrap();
    assert!((1..=100).all(|n| seen.contains_key(&fx.url(n))), "page 1's new seen entries are added");
}

#[test]
fn t1c_a_first_pass_that_lists_nothing_writes_the_horizon() {
    let fx = fixture("empty", Forge::Github);
    fx.sync(now90()).unwrap();
    assert_eq!(fx.cursor()["since"], json!(now90() - 30 * DAY));
}

#[test]
fn full_records_a_merge_older_than_the_horizon_even_within_the_cache_window() {
    let fx = fixture("full", Forge::Github);
    let old = Case { updated: 90 * DAY - 60 * DAY, ..case(7, "fix/gh-7-old", "fix: old", "merged", "head-7") };
    fx.pushes(&old, &[("push", 60, Some(1))], true);
    fx.serve(&[old]);
    assert_eq!(fx.sync(now90()).unwrap().appended, 0, "older than the horizon: not recorded");
    let full = fx.sync_mode(now90() + 10, true).unwrap();
    assert!(!full.cached, "--full lists the whole history, never the cached window");
    assert_eq!(full.appended, 1);
    assert_eq!(fx.of(7)[0].event.as_str(), "merged");
}

#[test]
fn full_cut_on_page_2_leaves_the_cursor_byte_identical_and_full_completion_writes_the_newest_listed() {
    let fx = fixture("full-cut", Forge::Github);
    fx.serve_values(vec![fx.render(&aged(900, 6 * DAY)), fx.render(&aged(901, 5 * DAY))]);
    fx.sync(now90()).unwrap();
    let before = fs::read(fx.cursor_path()).unwrap();
    assert_eq!(fx.cursor()["since"], json!(now90() - 5 * DAY), "a completed cursor");

    let p1: Vec<Case> = (1..=100_i64).map(|j| aged(j as u64, j * DAY / 2)).collect();
    fx.serve_pages(&[&p1]);
    fx.fail_page(2);
    assert!(fx.sync_mode(now90() + 100, true).is_err());
    assert_eq!((fx.page_calls(1), fx.page_calls(2)), (2, 1), "the --full run listed page 1 in full");
    assert_eq!(fs::read(fx.cursor_path()).unwrap(), before, "a killed --full leaves the cursor byte-identical");

    let p2: Vec<Case> = (101..=105_u64).map(|n| aged(n, 51 * DAY + n as i64)).collect();
    fx.serve_pages(&[&p1, &p2]);
    fx.sync_mode(now90() + 200, true).unwrap();
    assert_eq!(fx.cursor()["since"], json!(now90() - DAY / 2), "a completed --full: the newest updated_at it listed");
    assert!(fx.recorded_urls().is_superset(&urls(&fx, 1..=105)), "--full ignores the horizon");
}

#[test]
fn the_cursor_file_is_named_by_the_sha256_of_the_project() {
    let fx = fixture("cursor-name", Forge::Github);
    fx.serve(&[case(1, "feat/gh-1-x", "feat: x", "open", "head-1")]);
    fx.sync(t0() + 1_000).unwrap();
    let names: Vec<String> = fs::read_dir(fx.home.join("cache/forge"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".cursor.json"))
        .collect();
    let expected = fx.cursor_path().file_name().unwrap().to_string_lossy().into_owned();
    assert_eq!(names, [expected], "<lowercase hex sha256(store.project())>.cursor.json");
    assert_eq!(fx.repo.to_str().unwrap(), open_store_at(&fx.repo, &fx.home).unwrap().project());
    let text = String::from_utf8(fs::read(fx.cursor_path()).unwrap()).unwrap();
    assert!(text.contains("\"since\":1"), "compact JSON the never-synced probe greps: {text}");
}
