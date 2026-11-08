//! Forge access: the `origin` remote, the operator's own `gh` or `glab` (read-only `api` calls; Genie
//! never reads or stores a token), and the normalized PR/MR records a sync plans from.

use std::ffi::OsString;
use std::path::Path;
use std::process::Command;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::Error;

/// The page size asked of the forge. A commit list that fills a page was not counted whole.
const PAGE: usize = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Forge {
    Github,
    Gitlab,
}

impl Forge {
    pub fn as_str(self) -> &'static str {
        match self {
            Forge::Github => "github",
            Forge::Gitlab => "gitlab",
        }
    }

    fn program(self) -> &'static str {
        match self {
            Forge::Github => "gh",
            Forge::Gitlab => "glab",
        }
    }
}

/// The `origin` remote's credential-free identity: host and repository path (`owner/repo`, or nested
/// GitLab groups). The URL itself is never kept: it may carry userinfo (a token), and Genie stores
/// no credential (Decision 7).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Remote {
    pub host: String,
    pub path: String,
}

impl Remote {
    /// `host/path`: what the cache records the origin as.
    pub fn id(&self) -> String {
        format!("{}/{}", self.host, self.path)
    }
}

/// `https://host/o/r(.git)`, `ssh://user@host:port/o/r`, or scp-like `user@host:o/r.git`. Userinfo,
/// port, query and fragment are dropped.
pub fn parse_remote(url: &str) -> Option<Remote> {
    let url = url.trim();
    let url = url.split(['?', '#']).next()?;
    let (host, path) = match url.split_once("://") {
        Some((_, rest)) => {
            let (authority, path) = rest.split_once('/')?;
            let host = authority.rsplit('@').next()?;
            (host.split(':').next()?, path)
        }
        None => {
            let (user_host, path) = url.split_once(':')?;
            (user_host.rsplit('@').next()?, path)
        }
    };
    let path = path.trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    if host.is_empty() || !path.contains('/') {
        return None;
    }
    Some(Remote { host: host.to_ascii_lowercase(), path: path.to_string() })
}

/// The project's `origin` remote. Runs git with the process PATH; never call it under a lock.
pub fn origin(project: &Path) -> Result<Remote, Error> {
    let out = Command::new("git").arg("-C").arg(project).args(["remote", "get-url", "origin"]).output()?;
    let url = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !out.status.success() || url.is_empty() {
        return Err(Error::Remote(format!(
            "no 'origin' remote in {}: forge-sync reads the forge from it",
            project.display()
        )));
    }
    // The message never echoes the URL: it may carry a token.
    parse_remote(&url).ok_or_else(|| {
        Error::Remote(format!("the 'origin' remote of {} names no forge host and repository", project.display()))
    })
}

/// A forge CLI bound to one remote. `path` replaces PATH for the CLI's process only.
pub struct Cli {
    pub forge: Forge,
    host: String,
    repo: String,
    path: Option<OsString>,
}

impl Cli {
    pub fn new(forge: Forge, remote: &Remote, path: Option<OsString>) -> Cli {
        Cli { forge, host: remote.host.clone(), repo: remote.path.clone(), path }
    }

    fn login(&self) -> String {
        match self.forge {
            Forge::Github => "gh auth login".to_string(),
            Forge::Gitlab => format!("glab auth login --hostname {}", self.host),
        }
    }

    fn run(&self, args: &[&str]) -> Result<std::process::Output, Error> {
        let mut cmd = Command::new(self.forge.program());
        cmd.args(args);
        if let Some(path) = &self.path {
            cmd.env("PATH", path);
        }
        cmd.output().map_err(|e| {
            Error::Cli(format!("{} could not be run ({e}): install it and run {}", self.forge.program(), self.login()))
        })
    }

    /// One `api` call's stdout. `flags` go before the endpoint (gh's `--paginate`, `--jq`).
    fn call(&self, flags: &[&str], endpoint: &str) -> Result<Vec<u8>, Error> {
        let mut args = vec!["api"];
        args.extend(flags);
        args.push(endpoint);
        if self.forge == Forge::Gitlab {
            args.extend(["--hostname", &self.host]);
        }
        let out = self.run(&args)?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            let why = stderr.lines().next().unwrap_or("").trim();
            return Err(Error::Cli(format!(
                "{} api {endpoint} failed ({}): {why}; if logged out, run {}",
                self.forge.program(),
                out.status,
                self.login()
            )));
        }
        Ok(out.stdout)
    }

    fn api(&self, endpoint: &str) -> Result<Value, Error> {
        serde_json::from_slice(&self.call(&[], endpoint)?)
            .map_err(|e| Error::Reply(format!("{} api {endpoint}: the reply is not JSON ({e})", self.forge.program())))
    }

    /// Every PR/MR updated at or after `since` (all of them without one), newest first.
    /// One page of PRs/MRs, newest-updated first (`PAGE` per page). GitLab is asked for those
    /// updated after `floor`; GitHub has no such filter, so [`last_page`] stops the paging instead.
    pub fn list_page(&self, page: usize, floor: Option<i64>) -> Result<Vec<Pr>, Error> {
        let endpoint = match self.forge {
            Forge::Github => {
                format!("repos/{}/pulls?state=all&sort=updated&direction=desc&per_page={PAGE}&page={page}", self.repo)
            }
            Forge::Gitlab => {
                let after = floor.map_or(String::new(), |s| format!("&updated_after={}", rfc3339(s)));
                format!(
                    "projects/{}/merge_requests?state=all&order_by=updated_at&sort=desc&per_page={PAGE}&page={page}{after}",
                    self.repo.replace('/', "%2F")
                )
            }
        };
        let reply = self.api(&endpoint)?;
        let items = reply.as_array().ok_or_else(|| Error::Reply(format!("{endpoint}: the reply is not a list")))?;
        items.iter().map(|item| Pr::from_reply(self.forge, item)).collect()
    }

    /// `pushed_after_open` for a merged PR/MR: the commits pushed to it after it opened, from the
    /// forge's own push record, never from commit dates (a commit made before the open and pushed after
    /// it keeps its old date). `None` whenever the forge cannot establish the count: never 0 for unknown.
    pub fn pushed_after_open(&self, pr: &Pr) -> Option<i64> {
        match self.forge {
            Forge::Github => self.github_pushed_after_open(pr),
            Forge::Gitlab => self.gitlab_pushed_after_open(pr),
        }
    }

    /// GitHub: every activity that moved the head ref between the open and the merge (`push`,
    /// `force_push`, and the `pr_merge` / `merge_queue_merge` of a PR merged into this head), each
    /// counted as `compare(before...after).ahead_by` (for a force push, the new commits not in the old
    /// head). `None` for a head in another repository (a fork's pushes are not in this repository's
    /// activity), for activity that does not reach back to the open, for an activity whose time ties
    /// the open or the merge (its order is unresolved), for any other or unknown activity type after the open (a
    /// ref recreated or deleted included), and for any call that fails or answers without the count.
    fn github_pushed_after_open(&self, pr: &Pr) -> Option<i64> {
        if !pr.head_repo.eq_ignore_ascii_case(&self.repo) {
            return None;
        }
        let (opened, merged) = (parse_span(&pr.created_at)?, parse_span(&pr.merged_at)?);
        let endpoint = format!(
            "repos/{}/activity?ref={}&per_page={PAGE}",
            self.repo,
            encode(&format!("refs/heads/{}", pr.branch))
        );
        let out = self.call(&["--paginate", "--jq", ".[]"], &endpoint).ok()?;
        let mut reaches_back = false;
        let mut pushed = 0;
        for line in String::from_utf8_lossy(&out).lines().filter(|l| !l.trim().is_empty()) {
            let activity: Value = serde_json::from_str(line).ok()?;
            let at = activity.get("timestamp").and_then(Value::as_str).and_then(parse_span)?;
            match order(at, opened) {
                Order::Before => {
                    reaches_back = true;
                    continue;
                }
                Order::Tie => return None,
                Order::After => {}
            }
            match order(at, merged) {
                Order::Before => {}
                Order::Tie => return None,
                Order::After => continue,
            }
            match activity.get("activity_type").and_then(Value::as_str)? {
                "push" | "force_push" | "pr_merge" | "merge_queue_merge" => {
                    let before = activity.get("before").and_then(Value::as_str)?;
                    let after = activity.get("after").and_then(Value::as_str)?;
                    if before.bytes().all(|b| b == b'0') {
                        return None;
                    }
                    let compare = self.api(&format!("repos/{}/compare/{before}...{after}", self.repo)).ok()?;
                    pushed += compare.get("ahead_by")?.as_i64()?;
                }
                _ => return None,
            }
        }
        reaches_back.then_some(pushed)
    }

    /// GitLab: the MR's diff versions. The oldest is the MR as opened; each later version adds the
    /// commits `compare(previous head, its head)` lists. `None` for no versions, a full page (the
    /// list may be truncated), or any call that fails or answers without the commits.
    fn gitlab_pushed_after_open(&self, pr: &Pr) -> Option<i64> {
        let project = self.repo.replace('/', "%2F");
        let reply =
            self.api(&format!("projects/{project}/merge_requests/{}/versions?per_page={PAGE}", pr.number)).ok()?;
        let items = reply.as_array()?;
        let mut versions = items
            .iter()
            .map(|v| Some((v.get("id")?.as_i64()?, v.get("head_commit_sha")?.as_str()?.to_string())))
            .collect::<Option<Vec<_>>>()?;
        if versions.is_empty() || versions.len() >= PAGE {
            return None;
        }
        versions.sort();
        let mut pushed = 0;
        for pair in versions.windows(2) {
            let endpoint = format!("projects/{project}/repository/compare?from={}&to={}", pair[0].1, pair[1].1);
            let commits = self.api(&endpoint).ok()?.get("commits")?.as_array()?.len();
            pushed += i64::try_from(commits).ok()?;
        }
        Some(pushed)
    }
}

/// Percent-encode a query value (RFC 3986 unreserved characters pass through).
fn encode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => char::from(b).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Pick the CLI for the remote: github.com is `gh`; any other host is `glab` when glab reports a
/// login for it. One local `glab auth status` call; no fallback.
pub fn detect(remote: &Remote, path: Option<OsString>) -> Result<Cli, Error> {
    if remote.host == "github.com" {
        return Ok(Cli::new(Forge::Github, remote, path));
    }
    let cli = Cli::new(Forge::Gitlab, remote, path);
    let out = cli.run(&["auth", "status", "--hostname", &remote.host])?;
    if !out.status.success() {
        return Err(Error::Cli(format!(
            "no logged-in forge CLI for {}: github.com uses gh; for this host run {}",
            remote.host,
            cli.login()
        )));
    }
    Ok(cli)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PrState {
    Open,
    Merged,
    Closed,
}

/// One PR/MR, normalized across forges. Absent text is `''`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pr {
    pub number: u64,
    pub url: String,
    pub title: String,
    pub branch: String,
    pub state: PrState,
    pub head: String,
    /// GitHub: the head branch's repository (`owner/repo`); another repository is a fork.
    #[serde(default)]
    pub head_repo: String,
    /// The merge commit of a merged PR (GitLab: the merge, else squash, else head sha).
    pub merge_commit: String,
    pub created_at: String,
    pub updated_at: String,
    pub merged_at: String,
    pub closed_at: String,
}

fn text(v: &Value, ptr: &str) -> String {
    v.pointer(ptr).and_then(Value::as_str).unwrap_or("").to_string()
}

impl Pr {
    fn from_reply(forge: Forge, v: &Value) -> Result<Pr, Error> {
        let (number, url, branch, head) = match forge {
            Forge::Github => ("/number", "/html_url", "/head/ref", "/head/sha"),
            Forge::Gitlab => ("/iid", "/web_url", "/source_branch", "/sha"),
        };
        let number = v.pointer(number).and_then(Value::as_u64);
        let merged_at = text(v, "/merged_at");
        let raw_state = text(v, "/state");
        let state = match (forge, raw_state.as_str()) {
            (Forge::Github, "open") | (Forge::Gitlab, "opened" | "locked") => Some(PrState::Open),
            (Forge::Github, "closed") if !merged_at.is_empty() => Some(PrState::Merged),
            (Forge::Gitlab, "merged") => Some(PrState::Merged),
            (_, "closed") => Some(PrState::Closed),
            _ => None,
        };
        let merge_commit = match forge {
            Forge::Github => text(v, "/merge_commit_sha"),
            Forge::Gitlab => ["/merge_commit_sha", "/squash_commit_sha", "/sha"]
                .iter()
                .map(|p| text(v, p))
                .find(|s| !s.is_empty())
                .unwrap_or_default(),
        };
        let pr = Pr {
            number: number.unwrap_or(0),
            url: text(v, url),
            title: text(v, "/title"),
            branch: text(v, branch),
            state: state.unwrap_or(PrState::Open),
            head: text(v, head),
            head_repo: text(v, "/head/repo/full_name"),
            merge_commit,
            created_at: text(v, "/created_at"),
            updated_at: text(v, "/updated_at"),
            merged_at,
            closed_at: text(v, "/closed_at"),
        };
        let readable = parse_time(&pr.created_at).is_some() && parse_time(&pr.updated_at).is_some();
        if number.is_none() || state.is_none() || pr.url.is_empty() || !readable {
            return Err(Error::Reply(format!(
                "a {} reply item lacks its number, url, state ({raw_state:?}) or dates",
                forge.as_str()
            )));
        }
        Ok(pr)
    }

    /// Unix seconds; checked readable when the reply was normalized.
    pub fn updated(&self) -> i64 {
        parse_time(&self.updated_at).unwrap_or(0)
    }

    pub fn created(&self) -> i64 {
        parse_time(&self.created_at).unwrap_or(0)
    }
}

/// Unix seconds as RFC 3339 UTC.
pub fn rfc3339(secs: i64) -> String {
    genie_tasks::state::rfc3339(u64::try_from(secs).unwrap_or(0))
}

/// Whether a listing stops after this page: a short page, or one whose last (oldest) PR was
/// updated before `floor`, so every later page is older still.
pub fn last_page(page: &[Pr], floor: Option<i64>) -> bool {
    page.len() < PAGE || floor.is_some_and(|f| page.last().is_some_and(|p| p.updated() < f))
}

/// How two timestamps order once each is read as the interval its precision allows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Order {
    Before,
    /// The intervals overlap: the forge's precision cannot say which came first.
    Tie,
    After,
}

fn order(a: (i128, i128), b: (i128, i128)) -> Order {
    if a.0 + a.1 <= b.0 {
        Order::Before
    } else if a.0 >= b.0 + b.1 {
        Order::After
    } else {
        Order::Tie
    }
}

/// An RFC 3339 timestamp as `(start, width)` in nanoseconds: the interval its precision allows.
/// `10:00:00Z` is the whole second `[10:00:00, 10:00:01)`; `10:00:00.200Z` is a tenth wide.
fn parse_span(s: &str) -> Option<(i128, i128)> {
    let secs = i128::from(parse_time(s)?);
    let fraction = s.get(19..).and_then(|rest| rest.strip_prefix('.')).unwrap_or("");
    let digits = fraction.bytes().take_while(u8::is_ascii_digit).count().min(9);
    let width = 10_i128.pow(9 - u32::try_from(digits).ok()?);
    let nanos = if digits == 0 { 0 } else { fraction[..digits].parse::<i128>().ok()? * width };
    Some((secs * 1_000_000_000 + nanos, width))
}

/// RFC 3339 (`2026-11-03T04:20:05Z`, `…05.123+02:00`) as Unix seconds; the inverse of `rfc3339`.
pub fn parse_time(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || !matches!(b[10], b'T' | b't') || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let num = |from: usize, to: usize| -> Option<i64> {
        let part = s.get(from..to)?;
        if part.bytes().all(|c| c.is_ascii_digit()) { part.parse().ok() } else { None }
    };
    let (y, mo, d, h, mi, se) = (num(0, 4)?, num(5, 7)?, num(8, 10)?, num(11, 13)?, num(14, 16)?, num(17, 19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || se > 60 {
        return None;
    }
    let mut rest = &s[19..];
    if let Some(frac) = rest.strip_prefix('.') {
        let digits = frac.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            return None;
        }
        rest = &frac[digits..];
    }
    let offset = match rest {
        "Z" | "z" => 0,
        _ => {
            let sign = match rest.as_bytes().first()? {
                b'+' => 1,
                b'-' => -1,
                _ => return None,
            };
            if rest.len() != 6 || rest.as_bytes()[3] != b':' {
                return None;
            }
            let (oh, om) = (rest[1..3].parse::<i64>().ok()?, rest[4..6].parse::<i64>().ok()?);
            sign * (oh * 3_600 + om * 60)
        }
    };
    // Howard Hinnant's days-from-civil.
    let y = if mo <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * ((mo + 9) % 12) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + h * 3_600 + mi * 60 + se - offset)
}
