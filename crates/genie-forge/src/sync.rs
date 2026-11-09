//! One forge-sync pass: list the PRs/MRs updated since the cursor, page by page, fill missing opened
//! evidence and record terminal events, each in its own transaction, then advance
//! the cursor.
//!
//! - Normal admission starts at the cursor, or [`HORIZON_SECS`] on first run. Missing opens on
//!   exact recorded PRs of the current origin may widen the LISTING floor, never admission.
//!   Repair appends only opened evidence and processes at most [`REPAIR_PAGE_BUDGET`] pages
//!   after normal polling reaches its floor (including the boundary page), then resumes from
//!   its saved page on a later network pass. Unrelated older PRs require `--full`. Each page's
//!   normal events commit, newest first, and then the cursor's `seen` map
//!   saves with `since` unchanged, so a cut pass resumes from the newest page without repeating a
//!   count call. Only a completed pass sets `since`: the newest `updated_at` it LISTED, never below
//!   the previous `since` or the pass's floor (the horizon when there is none of those), so `since`
//!   never moves backward and `"since":null` means exactly "no completed pass".
//! - `--full` (hand-run only) lists the whole history once, ignoring the horizon and `since`, and
//!   saves its cursor only when it completes, so a killed `--full` leaves the cursor byte-identical.
//! - `opened` once per task and PR URL, at the forge's created_at, even when first seen finished;
//!   a later push never yields a second `opened` (Decision 5). `merged` or `closed` for a finished PR
//!   (a merged GitHub PR that the forge also marks closed is `merged` only). A repeat of a recorded
//!   event dedupes to a no-op, without repeating its count request.
//! - A transition `apply` refuses (a reopened PR merged after its `closed` was recorded) is skipped
//!   and reported; the rest of the pass still commits and the cursor still advances (Decision 12).
//! - Each page of the reply is checked for NUL bytes before any of its events is written: exit 1, and
//!   nothing of that page or a later one is written; earlier pages may have committed.
//! - Every forge call of a pass, the `pushed_after_open` calls for merged PRs included, is cached for
//!   60 s in `<GENIE_HOME>/cache/forge/<sha256(project)>.json`. A completed normal poll keeps
//!   that throttle even if optional repair cannot resolve a hole or its next page fails. The cursor
//!   lives beside it in `<sha256(project)>.cursor.json`, so it outlives every reply. Both record the origin only as `host/path`: a remote URL can carry a token, and
//!   Genie stores no credential.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::ffi::OsString;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use genie_tasks::{EventRow, Recorded, Store, StoredEvent, TaskEvent, TaskRow, open_store_at, record};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::Error;
use crate::client::{Cli, Forge, Pr, PrState, Remote, detect, last_page, origin, parse_time, rfc3339};

/// How long a forge reply is reused.
pub const CACHE_TTL_SECS: i64 = 60;

/// How far back a pass with no completed predecessor looks: 30 days (the usage feed's `d30`).
pub const HORIZON_SECS: i64 = 30 * 86_400;

/// Extra list pages per normal network pass for repairing recorded PRs only.
pub const REPAIR_PAGE_BUDGET: usize = 2;

pub struct SyncOptions {
    /// Any folder of the repository; rows are recorded under its main checkout.
    pub project: PathBuf,
    pub genie_home: PathBuf,
    /// PATH for the `gh`/`glab` process only (tests point it at a fake); `None` inherits.
    pub path: Option<OsString>,
    /// Unix seconds for the cache clock and the horizon; `None` reads the wall clock.
    pub now: Option<i64>,
    /// List the whole history once, ignoring the horizon and the cursor's `since`; the cursor is
    /// saved only when the pass completes.
    pub full: bool,
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

/// What a PR looked like when a pass last processed it. A PR is processed again whenever any of
/// these differ, so a change inside the same second, or inside a fractional timestamp, is never lost.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Seen {
    /// The forge's own string, at full precision.
    updated_at: String,
    state: PrState,
    head: String,
}

impl Seen {
    fn of(pr: &Pr) -> Seen {
        Seen { updated_at: pr.updated_at.clone(), state: pr.state, head: pr.head.clone() }
    }
}

/// Where the last completed pass stopped: the newest `updated_at` second it listed (the list is
/// fetched from there, inclusive; `None` when no pass has completed) and the last-processed shape of
/// each PR updated in or after that second, or processed by a pass that has not completed yet.
#[derive(Debug, Default, Serialize, Deserialize)]
struct Cursor {
    origin: String,
    since: Option<i64>,
    seen: BTreeMap<String, Seen>,
}

impl Cursor {
    /// A PR updated at or after `floor` whose shape this cursor has not seen.
    fn pending(&self, pr: &Pr, floor: Option<i64>) -> bool {
        floor.is_none_or(|f| pr.updated() >= f) && self.seen.get(&pr.url) != Some(&Seen::of(pr))
    }

    /// One page processed: its PRs join `seen`; `since` is unchanged until the pass completes.
    fn note(&mut self, processed: &[&Pr]) {
        for pr in processed {
            self.seen.insert(pr.url.clone(), Seen::of(pr));
        }
    }

    /// The pass completed: `since` becomes the newest `updated_at` it listed (never below the
    /// previous `since` or the pass's floor), or `horizon` when there is none of those.
    fn advance(&mut self, listed: Option<i64>, floor: Option<i64>, horizon: i64) {
        let since = [listed, self.since, floor].into_iter().flatten().max().unwrap_or(horizon);
        self.since = Some(since);
        self.seen.retain(|_, s| parse_time(&s.updated_at).is_some_and(|t| t >= since));
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct CacheFile {
    origin: String,
    forge: Option<Forge>,
    fetched_at: i64,
    prs: Vec<Pr>,
    /// `pushed_after_open` per `<url>@<head>` of a merged PR; null when the forge cannot say.
    counts: BTreeMap<String, Option<i64>>,
    /// Resume bounded repair scans after the cache expires. Zero from older caches means page 1.
    #[serde(default)]
    repair_page: usize,
}

fn state_path(genie_home: &Path, project: &str, suffix: &str) -> PathBuf {
    let digest: String = Sha256::digest(project.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
    genie_home.join("cache").join("forge").join(format!("{digest}{suffix}"))
}

fn load<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

fn save<T: Serialize>(path: &Path, value: &T) -> Result<(), Error> {
    let dir = path.parent().unwrap_or(Path::new("."));
    fs::create_dir_all(dir)?;
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let tmp = dir.join(format!(".{name}.{}.tmp", std::process::id()));
    fs::write(&tmp, serde_json::to_vec(value).map_err(|e| Error::Reply(e.to_string()))?)?;
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

/// Refuse a page with a NUL byte in any part that reaches a dedupe key (url, head, merge commit, and
/// the branch the task id comes from), before any of that page's events is written. Earlier pages of
/// the same pass may already have committed (each page commits on its own).
fn check_nul(prs: &[Pr]) -> Result<(), Error> {
    for pr in prs {
        for (name, part) in
            [("url", &pr.url), ("head commit", &pr.head), ("merge commit", &pr.merge_commit), ("branch", &pr.branch)]
        {
            if part.contains('\0') {
                return Err(Error::Reply(format!(
                    "the forge reply for #{} carries a NUL byte in its {name}; no events from this page were \
                     written; earlier pages may have committed",
                    pr.number
                )));
            }
        }
    }
    Ok(())
}

/// The event's metadata comes from the same list reply, including the PR's creation time.
fn plan(pr: &Pr, forge: Forge, event: TaskEvent) -> EventRow {
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
    row.at = Some(if parse_time(at).is_some() { at.clone() } else { rfc3339(pr.updated()) });
    row
}

/// Existing opens and completed PRs superseded by a restart, under their immutable task keys.
/// Head changes never make a second open; an older PR must not open a restarted task.
fn opened_or_restarted_prs(events: &[StoredEvent]) -> HashSet<(String, String)> {
    let mut created = HashMap::new();
    for e in events.iter().filter(|e| e.event == TaskEvent::Created) {
        created.entry(e.task_key.as_str()).and_modify(|seq: &mut i64| *seq = (*seq).max(e.seq)).or_insert(e.seq);
    }
    events
        .iter()
        .filter(|e| {
            e.event == TaskEvent::Opened
                || (matches!(e.event, TaskEvent::Merged | TaskEvent::Closed)
                    && created.get(e.task_key.as_str()).is_some_and(|seq| *seq > e.seq))
        })
        .map(|e| (e.task_key.clone(), e.url.clone()))
        .collect()
}

/// Only current-origin PR identities can extend the normal listing window for repair.
fn missing_opens(store: &Store, forge: Forge, remote: &Remote) -> Result<Vec<TaskRow>, Error> {
    let opened = opened_or_restarted_prs(&store.events()?);
    Ok(store
        .tasks()?
        .into_iter()
        .filter(|t| {
            t.forge == forge.as_str()
                && in_repository(&t.url, forge, remote)
                && !opened.contains(&(t.task_key.clone(), t.url.clone()))
        })
        .collect())
}

fn in_repository(url: &str, forge: Forge, remote: &Remote) -> bool {
    let Some(rest) = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://")) else { return false };
    let Some((host, path)) = rest.split_once('/') else { return false };
    let Some((prefix, number)) = path.rsplit_once('/') else { return false };
    let route = if forge == Forge::Github { "pull" } else { "-/merge_requests" };
    let expected = format!("{}/{route}", remote.path);
    host.eq_ignore_ascii_case(&remote.host)
        && if forge == Forge::Github { prefix.eq_ignore_ascii_case(&expected) } else { prefix == expected }
        && number.parse::<u64>().is_ok_and(|n| n > 0)
}

/// Below the normal floor, append only missing opens for exact recorded task/URL pairs.
/// No terminal events, cursor notes, or per-PR forge calls belong to repair.
fn repair_opens(store: &Store, cli: &Cli, remote: &Remote, prs: &[Pr], report: &mut Report) -> Result<(), Error> {
    let missing: HashSet<_> =
        missing_opens(store, cli.forge, remote)?.into_iter().map(|t| (t.task_key, t.url)).collect();
    let rows: Vec<_> = prs
        .iter()
        .map(|p| plan(p, cli.forge, TaskEvent::Opened))
        .filter(|r| r.task_key().is_ok_and(|key| missing.contains(&(key, r.url.clone()))))
        .collect();
    record_rows(store, &rows, report)
}

fn unix_now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| i64::try_from(d.as_secs()).unwrap_or(0))
}

/// Plan and record one page, newest first: the counts are fetched before any write, each event commits
/// in its own transaction, and the page's processed PRs join the cursor's `seen` map.
fn record_page(
    store: &Store,
    cli: &Cli,
    prs: &[Pr],
    floor: Option<i64>,
    cursor: &mut Cursor,
    counts: &mut BTreeMap<String, Option<i64>>,
    report: &mut Report,
) -> Result<(), Error> {
    let recorded = store.events()?;
    let mut opened = opened_or_restarted_prs(&recorded);
    let known: HashSet<_> = recorded.iter().map(|e| e.dedupe_key.as_str()).collect();
    let mut processed = Vec::new();
    let mut planned = Vec::new();
    for pr in prs.iter().filter(|p| floor.is_none_or(|f| p.updated() >= f)) {
        let task = task_id(&pr.branch).unwrap_or("");
        let key = genie_tasks::task_key(task, cli.forge.as_str(), &pr.url).unwrap_or_default();
        let missing_open = opened.insert((key, pr.url.clone()));
        let pending = cursor.pending(pr, floor);
        if !pending && !missing_open {
            continue;
        }
        processed.push(pr);
        if missing_open {
            planned.push(plan(pr, cli.forge, TaskEvent::Opened));
        }
        let event = match pr.state {
            PrState::Open => continue,
            PrState::Merged => TaskEvent::Merged,
            PrState::Closed => TaskEvent::Closed,
        };
        if !pending {
            continue;
        }
        let mut row = plan(pr, cli.forge, event);
        // The contract's count is a property of the merge; other events carry null.
        let dedupe =
            genie_tasks::dedupe_key(&report.project, &row.task, row.event, &row.url, &row.commit, &row.worktree);
        if row.event == TaskEvent::Merged && !known.contains(dedupe.as_str()) {
            let count_key = format!("{}@{}", pr.url, pr.head);
            row.pushed_after_open = match counts.get(&count_key) {
                Some(count) => *count,
                None => {
                    let count = cli.pushed_after_open(pr);
                    counts.insert(count_key, count);
                    count
                }
            };
        }
        planned.push(row);
    }
    record_rows(store, &planned, report)?;
    cursor.note(&processed);
    Ok(())
}

fn record_rows(store: &Store, rows: &[EventRow], report: &mut Report) -> Result<(), Error> {
    for row in rows {
        match record(store, &report.project, row) {
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
    Ok(())
}

struct Polled {
    listed: Option<i64>,
    repair_error: Option<Error>,
}

struct PollState<'a> {
    cache: &'a mut CacheFile,
    cursor: &'a mut Cursor,
    cursor_path: &'a Path,
}

/// Finish normal pagination before bounding optional history repair. A repair-only failure
/// returns the completed normal poll so its cursor and 60-second cache can still be saved.
fn poll_pages(
    store: &Store,
    cli: &Cli,
    remote: &Remote,
    floor: Option<i64>,
    state: PollState<'_>,
    report: &mut Report,
) -> Result<Polled, Error> {
    let PollState { cache, cursor, cursor_path } = state;
    let mut listed: Option<i64> = None;
    let mut repair_error = None;
    let missing_floor =
        missing_opens(store, cli.forge, remote)?.into_iter().filter_map(|t| parse_time(&t.updated_at)).min();
    let list_floor = floor.map(|f| missing_floor.map_or(f, |m| m.min(f)));
    let mut normal_complete = false;
    let mut repair_pages = 0;
    let mut page = 1;
    loop {
        let prs = match cli.list_page(page, list_floor).and_then(|prs| {
            check_nul(&prs)?;
            Ok(prs)
        }) {
            Ok(prs) => prs,
            Err(e) if normal_complete => {
                repair_error = Some(e);
                break;
            }
            Err(e) => return Err(e),
        };
        listed = listed.max(prs.iter().map(Pr::updated).max());
        record_page(store, cli, &prs, floor, cursor, &mut cache.counts, report)?;
        if floor.is_some() {
            repair_opens(store, cli, remote, &prs, report)?;
            save(cursor_path, cursor)?;
        }
        normal_complete |= last_page(&prs, floor);
        let done = last_page(&prs, list_floor);
        cache.prs.extend(prs);
        if done {
            cache.repair_page = 1;
            break;
        }
        if normal_complete {
            if missing_opens(store, cli.forge, remote)?.is_empty() {
                cache.repair_page = 1;
                break;
            }
            repair_pages += 1;
            if repair_pages >= REPAIR_PAGE_BUDGET {
                cache.repair_page = page + 1;
                break;
            }
            page = (page + 1).max(cache.repair_page);
        } else {
            page += 1;
        }
    }
    Ok(Polled { listed, repair_error })
}

/// One pass. A missing or uninitialized `genie.db` refuses before any forge call (exit 2).
pub fn sync(opts: &SyncOptions) -> Result<Report, Error> {
    let store = open_store_at(&opts.project, &opts.genie_home)?;
    let project = store.project().to_string();
    let remote = origin(Path::new(&project))?;
    let origin_id = remote.id();
    let now = opts.now.unwrap_or_else(unix_now);
    let (cache_path, cursor_path) =
        (state_path(&opts.genie_home, &project, ".json"), state_path(&opts.genie_home, &project, ".cursor.json"));
    let mut cache = load::<CacheFile>(&cache_path)
        .filter(|c| c.origin == origin_id)
        .unwrap_or_else(|| CacheFile { origin: origin_id.clone(), ..CacheFile::default() });
    let mut cursor = load::<Cursor>(&cursor_path)
        .filter(|c| c.origin == origin_id)
        .unwrap_or_else(|| Cursor { origin: origin_id.clone(), ..Cursor::default() });
    let horizon = now - HORIZON_SECS;
    // Repair never changes which PRs normal polling admits, or bypasses the cache throttle.
    let floor = if opts.full { None } else { Some(cursor.since.unwrap_or(horizon)) };
    let fresh = !opts.full && (0..CACHE_TTL_SECS).contains(&(now - cache.fetched_at));
    let mut report =
        Report { project: project.clone(), forge: "", cached: false, appended: 0, duplicates: 0, skipped: vec![] };
    let polled = match cache.forge {
        Some(forge) if fresh => {
            let cli = Cli::new(forge, &remote, opts.path.clone());
            report.forge = forge.as_str();
            report.cached = true;
            let prs = std::mem::take(&mut cache.prs);
            let listed = prs.iter().map(Pr::updated).max();
            record_page(&store, &cli, &prs, floor, &mut cursor, &mut cache.counts, &mut report)?;
            repair_opens(&store, &cli, &remote, &prs, &mut report)?;
            cache.prs = prs;
            Polled { listed, repair_error: None }
        }
        _ => {
            let cli = detect(&remote, opts.path.clone())?;
            report.forge = cli.forge.as_str();
            cache.forge = Some(cli.forge);
            cache.fetched_at = now;
            cache.prs.clear();
            cache.counts.clear();
            poll_pages(
                &store,
                &cli,
                &remote,
                floor,
                PollState { cache: &mut cache, cursor: &mut cursor, cursor_path: &cursor_path },
                &mut report,
            )?
        }
    };
    cursor.advance(polled.listed, floor, horizon);
    save(&cache_path, &cache)?;
    save(&cursor_path, &cursor)?;
    if let Some(error) = polled.repair_error {
        return Err(error);
    }
    Ok(report)
}
