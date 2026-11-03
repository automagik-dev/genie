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

/// The `origin` remote, split into host and repository path (`owner/repo`, or nested GitLab groups).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Remote {
    pub url: String,
    pub host: String,
    pub path: String,
}

/// `https://host/o/r(.git)`, `ssh://user@host:port/o/r`, or scp-like `user@host:o/r.git`.
pub fn parse_remote(url: &str) -> Option<Remote> {
    let url = url.trim();
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
    Some(Remote { url: url.to_string(), host: host.to_ascii_lowercase(), path: path.to_string() })
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
    parse_remote(&url).ok_or_else(|| Error::Remote(format!("origin {url} names no forge host and repository")))
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

    fn api(&self, endpoint: &str) -> Result<Value, Error> {
        let mut args = vec!["api", endpoint];
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
        serde_json::from_slice(&out.stdout)
            .map_err(|e| Error::Reply(format!("{} api {endpoint}: the reply is not JSON ({e})", self.forge.program())))
    }

    /// Every PR/MR updated at or after `since` (all of them without one), newest first.
    pub fn list(&self, since: Option<i64>) -> Result<Vec<Pr>, Error> {
        let mut prs = Vec::new();
        for page in 1.. {
            let endpoint = match self.forge {
                Forge::Github => {
                    format!(
                        "repos/{}/pulls?state=all&sort=updated&direction=desc&per_page={PAGE}&page={page}",
                        self.repo
                    )
                }
                Forge::Gitlab => {
                    let after = since.map_or(String::new(), |s| format!("&updated_after={}", rfc3339(s)));
                    format!(
                        "projects/{}/merge_requests?state=all&order_by=updated_at&sort=desc&per_page={PAGE}&page={page}{after}",
                        self.repo.replace('/', "%2F")
                    )
                }
            };
            let reply = self.api(&endpoint)?;
            let items = reply.as_array().ok_or_else(|| Error::Reply(format!("{endpoint}: the reply is not a list")))?;
            for item in items {
                prs.push(Pr::from_reply(self.forge, item)?);
            }
            let older = since.is_some_and(|s| prs.last().is_some_and(|p| p.updated() < s));
            if items.len() < PAGE || older {
                break;
            }
        }
        Ok(prs)
    }

    /// `pushed_after_open`: the PR's commits whose committer date is after the PR was opened. `None`
    /// when the forge cannot say: a full page (the list may be truncated) or a commit with no
    /// readable date. A CLI failure is an error, never a guessed count.
    pub fn pushed_after_open(&self, pr: &Pr) -> Result<Option<i64>, Error> {
        let (endpoint, date) = match self.forge {
            Forge::Github => {
                (format!("repos/{}/pulls/{}/commits?per_page={PAGE}", self.repo, pr.number), "/commit/committer/date")
            }
            Forge::Gitlab => (
                format!(
                    "projects/{}/merge_requests/{}/commits?per_page={PAGE}",
                    self.repo.replace('/', "%2F"),
                    pr.number
                ),
                "/committed_date",
            ),
        };
        let reply = self.api(&endpoint)?;
        let commits = reply.as_array().ok_or_else(|| Error::Reply(format!("{endpoint}: the reply is not a list")))?;
        if commits.len() >= PAGE {
            return Ok(None);
        }
        let opened = pr.created();
        let mut after = 0;
        for commit in commits {
            match commit.pointer(date).and_then(Value::as_str).and_then(parse_time) {
                Some(t) if t > opened => after += 1,
                Some(_) => {}
                None => return Ok(None),
            }
        }
        Ok(Some(after))
    }
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
