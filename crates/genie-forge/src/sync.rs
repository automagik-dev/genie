//! One forge-sync pass: list the PRs/MRs updated since the cursor, plan at most one event per PR from
//! the task's recorded state, record each event in its own transaction, then advance the cursor.
//!
//! - `opened` only for a task with no row or at `created`, so a later push never yields a second
//!   `opened` (Decision 5); `merged` or `closed` for a finished PR (a merged GitHub PR that the forge
//!   also marks closed is `merged` only). A repeat of a recorded event dedupes to a no-op.
//! - A transition `apply` refuses (a reopened PR merged after its `closed` was recorded) is skipped
//!   and reported; the rest of the pass still commits and the cursor still advances (Decision 12).
//! - The whole reply is checked for NUL bytes before anything is written: exit 1, nothing written.
//! - Every forge call of a pass, the per-PR commit counts included, is cached for 60 s in
//!   `<GENIE_HOME>/cache/forge/<sha256(project)>.json`, which also holds the cursor.

use std::collections::{BTreeMap, HashMap};
use std::ffi::OsString;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use genie_tasks::{EventRow, Recorded, TaskEvent, TaskState, open_store_at, record};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::Error;
use crate::client::{Cli, Forge, Pr, PrState, detect, origin, parse_time, rfc3339};

/// How long a forge reply is reused.
pub const CACHE_TTL_SECS: i64 = 60;

pub struct SyncOptions {
    /// Any folder of the repository; rows are recorded under its main checkout.
    pub project: PathBuf,
    pub genie_home: PathBuf,
    /// PATH for the `gh`/`glab` process only (tests point it at a fake); `None` inherits.
    pub path: Option<OsString>,
    /// Unix seconds for the cache clock; `None` reads the wall clock.
    pub now: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Report {
    pub project: String,
    pub forge: &'static str,
    /// The forge reply came from the cache: no forge call was made.
    pub cached: bool,
    pub appended: usize,
    pub duplicates: usize,
    pub skipped: Vec<Skip>,
}

/// An event `apply` refused; nothing was written for it.
#[derive(Debug, Clone, Serialize)]
pub struct Skip {
    pub task: String,
    pub event: &'static str,
    pub url: String,
    pub refusal: String,
}

impl fmt::Display for Skip {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "forge-sync: skipped {} for {} ({}): {}", self.event, self.task, self.url, self.refusal)
    }
}

/// Where the last pass stopped: the newest `updated_at` it processed and the PRs seen at that second.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
struct Cursor {
    updated_at: i64,
    seen: Vec<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct CacheFile {
    origin: String,
    forge: Option<Forge>,
    fetched_at: i64,
    prs: Vec<Pr>,
    /// `pushed_after_open` per `<url>@<head>`; null when the forge cannot say.
    counts: BTreeMap<String, Option<i64>>,
    cursor: Option<Cursor>,
}

fn cache_path(genie_home: &Path, project: &str) -> PathBuf {
    let digest: String = Sha256::digest(project.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
    genie_home.join("cache").join("forge").join(format!("{digest}.json"))
}

fn save(path: &Path, cache: &CacheFile) -> Result<(), Error> {
    let dir = path.parent().unwrap_or(Path::new("."));
    fs::create_dir_all(dir)?;
    let tmp =
        dir.join(format!(".{}.{}.tmp", path.file_name().unwrap_or_default().to_string_lossy(), std::process::id()));
    fs::write(&tmp, serde_json::to_vec(cache).map_err(|e| Error::Reply(e.to_string()))?)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

/// The task id a branch carries (`^[a-z]+/((?:gh|gl|gn)-\d+)-`).
pub fn task_id(branch: &str) -> Option<&str> {
    let (prefix, rest) = branch.split_once('/')?;
    if prefix.is_empty() || !prefix.bytes().all(|b| b.is_ascii_lowercase()) {
        return None;
    }
    let tag = ["gh-", "gl-", "gn-"].iter().find(|t| rest.starts_with(**t))?.len();
    let digits = rest[tag..].bytes().take_while(u8::is_ascii_digit).count();
    (digits > 0 && rest.as_bytes().get(tag + digits) == Some(&b'-')).then(|| &rest[..tag + digits])
}

/// The conventional-commit type of a title (`''` when it has none) and its exclusion reason:
/// `docs-memory` for `docs(memory)`; `version-bump` for a `(version)` scope, `[auto-version]`, or a
/// subject starting "bump version"; `release` for a `release` type, `chore(release)`, or a
/// non-conventional title that is "release" or starts "release ". A conventional title of any other
/// type that merely mentions a release or a bump stays counted.
pub fn classify(title: &str) -> (String, Option<&'static str>) {
    let conventional = title.split_once(':').and_then(|(head, _)| {
        let head = head.strip_suffix('!').unwrap_or(head);
        let (kind, scope) = match head.split_once('(') {
            Some((kind, scope)) => (kind, scope.strip_suffix(')')?),
            None => (head, ""),
        };
        let word = !kind.is_empty() && kind.bytes().all(|b| b.is_ascii_alphabetic());
        word.then(|| (kind.to_ascii_lowercase(), scope.to_ascii_lowercase()))
    });
    let lower = title.to_ascii_lowercase();
    let subject = match &conventional {
        Some(_) => lower.split_once(':').map_or("", |(_, s)| s.trim()),
        None => lower.trim(),
    };
    let bare = conventional.is_none() && (subject == "release" || subject.starts_with("release "));
    let (kind, scope) = conventional.unwrap_or_default();
    let reason = if kind == "docs" && scope == "memory" {
        Some("docs-memory")
    } else if scope == "version" || lower.contains("[auto-version]") || subject.starts_with("bump version") {
        Some("version-bump")
    } else if kind == "release" || (kind == "chore" && scope == "release") || bare {
        Some("release")
    } else {
        None
    };
    (kind, reason)
}

/// Refuse a reply with a NUL byte in any part that reaches a dedupe key (url, head, merge commit,
/// and the branch the task id comes from), before anything is written.
fn check_nul(prs: &[Pr]) -> Result<(), Error> {
    for pr in prs {
        for (name, part) in
            [("url", &pr.url), ("head commit", &pr.head), ("merge commit", &pr.merge_commit), ("branch", &pr.branch)]
        {
            if part.contains('\0') {
                return Err(Error::Reply(format!(
                    "the forge reply for #{} carries a NUL byte in its {name}; nothing was written",
                    pr.number
                )));
            }
        }
    }
    Ok(())
}

fn after_cursor(pr: &Pr, cursor: Option<&Cursor>) -> bool {
    cursor.is_none_or(|c| pr.updated() > c.updated_at || (pr.updated() == c.updated_at && !c.seen.contains(&pr.url)))
}

fn advance(old: Option<Cursor>, processed: &[&Pr]) -> Option<Cursor> {
    let Some(newest) = processed.iter().map(|p| p.updated()).max() else {
        return old;
    };
    let mut seen: Vec<String> = processed.iter().filter(|p| p.updated() == newest).map(|p| p.url.clone()).collect();
    if let Some(old) = old {
        if old.updated_at > newest {
            return Some(old);
        }
        if old.updated_at == newest {
            seen.extend(old.seen.into_iter().filter(|u| !seen.contains(u)).collect::<Vec<_>>());
        }
    }
    Some(Cursor { updated_at: newest, seen })
}

/// The one event a PR yields given its task's recorded state, or `None`.
fn plan(pr: &Pr, forge: Forge, state: Option<TaskState>) -> Option<EventRow> {
    let event = match (pr.state, state) {
        (PrState::Open, None | Some(TaskState::Created)) => TaskEvent::Opened,
        (PrState::Open, Some(_)) => return None,
        (PrState::Merged, _) => TaskEvent::Merged,
        (PrState::Closed, _) => TaskEvent::Closed,
    };
    let mut row = EventRow::new(event);
    let (kind, reason) = classify(&pr.title);
    row.task = task_id(&pr.branch).unwrap_or("").to_string();
    row.forge = forge.as_str().to_string();
    row.url = pr.url.clone();
    row.branch = pr.branch.clone();
    row.title = pr.title.clone();
    row.kind = kind;
    row.counted = reason.is_none();
    row.exclude_reason = reason.unwrap_or("").to_string();
    let (commit, at) = match event {
        TaskEvent::Merged if !pr.merge_commit.is_empty() => (&pr.merge_commit, &pr.merged_at),
        TaskEvent::Merged => (&pr.head, &pr.merged_at),
        TaskEvent::Closed => (&pr.head, &pr.closed_at),
        _ => (&pr.head, &pr.created_at),
    };
    row.commit = commit.clone();
    row.at = Some(rfc3339(parse_time(at).unwrap_or_else(|| pr.updated())));
    Some(row)
}

fn unix_now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| i64::try_from(d.as_secs()).unwrap_or(0))
}

/// One pass. A missing or uninitialized `genie.db` refuses before any forge call (exit 2).
pub fn sync(opts: &SyncOptions) -> Result<Report, Error> {
    let store = open_store_at(&opts.project, &opts.genie_home)?;
    let project = store.project().to_string();
    let remote = origin(Path::new(&project))?;
    let now = opts.now.unwrap_or_else(unix_now);
    let path = cache_path(&opts.genie_home, &project);
    let mut cache = fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<CacheFile>(&bytes).ok())
        .filter(|c| c.origin == remote.url)
        .unwrap_or_else(|| CacheFile { origin: remote.url.clone(), ..CacheFile::default() });
    let fresh = (0..CACHE_TTL_SECS).contains(&(now - cache.fetched_at));
    let (cli, cached) = match cache.forge {
        Some(forge) if fresh => (Cli::new(forge, &remote, opts.path.clone()), true),
        _ => {
            let cli = detect(&remote, opts.path.clone())?;
            let prs = cli.list(cache.cursor.as_ref().map(|c| c.updated_at))?;
            check_nul(&prs)?;
            cache.forge = Some(cli.forge);
            cache.fetched_at = now;
            cache.prs = prs;
            cache.counts.clear();
            (cli, false)
        }
    };

    let states: HashMap<String, TaskState> = store.tasks()?.into_iter().map(|t| (t.task_key, t.state)).collect();
    let processed: Vec<&Pr> = cache.prs.iter().filter(|p| after_cursor(p, cache.cursor.as_ref())).collect();
    let mut planned = Vec::new();
    for pr in processed.iter().rev() {
        let task = task_id(&pr.branch).unwrap_or("");
        let key = genie_tasks::task_key(task, cli.forge.as_str(), &pr.url).unwrap_or_default();
        if let Some(mut row) = plan(pr, cli.forge, states.get(&key).copied()) {
            let count_key = format!("{}@{}", pr.url, pr.head);
            row.pushed_after_open = match cache.counts.get(&count_key) {
                Some(count) => *count,
                None => {
                    let count = cli.pushed_after_open(pr)?;
                    cache.counts.insert(count_key, count);
                    count
                }
            };
            planned.push(row);
        }
    }

    let mut report = Report {
        project: project.clone(),
        forge: cli.forge.as_str(),
        cached,
        appended: 0,
        duplicates: 0,
        skipped: vec![],
    };
    for row in &planned {
        match record(&store, &project, row) {
            Ok(Recorded::Appended { .. }) => report.appended += 1,
            Ok(Recorded::Duplicate { .. }) => report.duplicates += 1,
            Err(genie_tasks::Error::Refused(refusal)) => report.skipped.push(Skip {
                task: row.task_key()?,
                event: row.event.as_str(),
                url: row.url.clone(),
                refusal: refusal.to_string(),
            }),
            Err(e) => return Err(e.into()),
        }
    }
    cache.cursor = advance(cache.cursor.take(), &processed);
    save(&path, &cache)?;
    Ok(report)
}
