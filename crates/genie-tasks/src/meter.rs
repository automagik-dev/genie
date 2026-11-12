//! Read-only `usagemeter query` (Contract 1, `meter.usage@1`) client, canonical `host/owner/repo`
//! remote normalization, and `D6` `--repo-alias` continuity across repository renames.

use std::fmt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Single authority for known previous repository names across renames (`D6`).
/// Passed as repeatable `--repo-alias <previous>` flags to `usagemeter` (`>= 3.129.2`).
pub const KNOWN_PREVIOUS_REPO_SLUGS: &[(&str, &[&str])] =
    &[("github.com/automagik-si/genie", &["github.com/automagik-dev/genie"])];

/// Maximum branches per `usagemeter query --branch` invocation (`envelope.schema.json` `maxItems: 500`).
pub const MAX_QUERY_BRANCHES: usize = 500;

/// Normalizes a git remote URL to `host/owner/repo` per `meter/schema/query/v1/repo-normalization.json`.
/// Credentials, port, query, fragment, trailing slashes, and `.git` are stripped; `host` is
/// lower-cased while `owner/repo` path case is preserved. Local paths and `file://` return `None`.
pub fn normalize_repo_slug(remote: &str) -> Option<String> {
    let url = remote.trim();
    if url.is_empty() {
        return None;
    }
    let (host, path) = if let Some(pos) = url.find("://") {
        let scheme = url[..pos].to_ascii_lowercase();
        if scheme == "file" {
            return None;
        }
        let rest = &url[pos + 3..];
        let rest = rest.split(['?', '#']).next().unwrap_or("");
        let (authority, path) = rest.split_once('/').unwrap_or((rest, ""));
        let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
        (strip_port(host), path)
    } else {
        if url.starts_with('/') || url.starts_with('.') {
            return None;
        }
        let head_end = url.find('/').unwrap_or(url.len());
        let rest = match url[..head_end].rfind('@') {
            Some(at) => &url[at + 1..],
            None => url,
        };
        let colon = rest.find(':')?;
        if rest[..colon].contains('/') {
            return None;
        }
        let path = rest[colon + 1..].split(['?', '#']).next().unwrap_or("");
        (&rest[..colon], path)
    };
    let host = host.trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase();
    if host.is_empty() || host.contains(char::is_whitespace) {
        return None;
    }
    let mut path = path.trim_matches('/');
    if let Some(p) = path.strip_suffix(".git") {
        path = p;
    }
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty() && *s != "." && *s != "..").collect();
    if segments.is_empty() || segments.iter().any(|s| s.contains(char::is_whitespace)) {
        return None;
    }
    let out = format!("{host}/{}", segments.join("/"));
    (out.len() <= 512).then_some(out)
}

fn strip_port(host: &str) -> &str {
    if host.starts_with('[') {
        return host.split_once(']').map_or(host, |(h, _)| &h[1..]);
    }
    match host.rsplit_once(':') {
        Some((h, port)) if !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()) => h,
        _ => host,
    }
}

/// Resolves `project`'s `origin` remote URL and normalizes it to `host/owner/repo`.
pub fn repo_slug_of_project(project: &Path) -> Option<String> {
    let out = Command::new("git")
        .args(["remote", "get-url", "origin"])
        .current_dir(project)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    normalize_repo_slug(&String::from_utf8_lossy(&out.stdout))
}

/// Returns the slice of known previous repository slugs (`--repo-alias` values) for `slug`
/// from [`KNOWN_PREVIOUS_REPO_SLUGS`], or `&[]` when `slug` has no previous name.
pub fn repo_aliases_for_query(slug: &str) -> &'static [&'static str] {
    for &(current, aliases) in KNOWN_PREVIOUS_REPO_SLUGS {
        if current == slug {
            return aliases;
        }
    }
    &[]
}

/// Resolves the `usagemeter` binary path: `USAGEMETER_BIN`, then `$HOME/.local/bin/usagemeter`, then `PATH`.
pub fn usagemeter_bin() -> PathBuf {
    if let Some(bin) = std::env::var_os("USAGEMETER_BIN")
        && !bin.is_empty()
    {
        return PathBuf::from(bin);
    }
    if let Some(home) = std::env::var_os("HOME")
        && !home.is_empty()
    {
        let candidate = PathBuf::from(home).join(".local").join("bin").join("usagemeter");
        if candidate.is_file() {
            return candidate;
        }
    }
    PathBuf::from("usagemeter")
}

/// Checks whether a `major.minor.patch` version string is at least `min`.
pub fn version_at_least(v: &str, min: (u64, u64, u64)) -> bool {
    let mut parts = v.trim().trim_start_matches('v').split('.');
    let Some(maj) = parts.next().and_then(|s| s.parse::<u64>().ok()) else {
        return false;
    };
    let Some(minor) = parts.next().and_then(|s| s.parse::<u64>().ok()) else {
        return false;
    };
    let Some(patch_raw) = parts.next() else {
        return false;
    };
    let patch_digits = patch_raw.split(['-', '+']).next().unwrap_or("");
    let Ok(patch) = patch_digits.parse::<u64>() else {
        return false;
    };
    (maj, minor, patch) >= min
}

/// Top-level `usagemeter query` failure (spawn error, non-zero exit, invalid JSON, or `status != "ok"`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MeterQueryError {
    pub reason: String,
}

impl fmt::Display for MeterQueryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "usagemeter query failed: {}", self.reason)
    }
}

impl std::error::Error for MeterQueryError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MeterRowState {
    Measured,
    Zero,
    Missing,
    Stale,
    Unsupported,
}

impl MeterRowState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Measured => "measured",
            Self::Zero => "zero",
            Self::Missing => "missing",
            Self::Stale => "stale",
            Self::Unsupported => "unsupported",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MeterCostState {
    Priced,
    Partial,
    Unpriced,
    Zero,
}

impl MeterCostState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Priced => "priced",
            Self::Partial => "partial",
            Self::Unpriced => "unpriced",
            Self::Zero => "zero",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MeterTokens {
    pub input: u64,
    pub cache_read: u64,
    pub cache_write_5m: u64,
    pub cache_write_1h: u64,
    pub output: u64,
    pub reasoning: Option<u64>,
    pub unsplit: u64,
    pub total: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MeterCost {
    pub state: MeterCostState,
    pub usd: Option<f64>,
    pub usd_reported: Option<f64>,
    pub usd_estimated: Option<f64>,
    pub tokens_priced: u64,
    pub tokens_reported: u64,
    pub tokens_unpriced: u64,
    #[serde(default)]
    pub unpriced_models: Vec<String>,
    #[serde(default)]
    pub unpriced_models_omitted: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MeterActivity {
    pub first_hour: Option<String>,
    pub last_hour: Option<String>,
    pub hours: u64,
    #[serde(default)]
    pub harnesses: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MeterTaskActor {
    pub bot: String,
    pub kind: String,
    pub role: Option<String>,
    pub squad: Option<String>,
    #[serde(default)]
    pub unrecorded: Vec<String>,
    pub harness: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MeterTaskRow {
    pub task: String,
    #[serde(default)]
    pub actors: Vec<MeterTaskActor>,
    #[serde(default)]
    pub actors_omitted: u64,
    pub state: MeterRowState,
    pub reason: Option<String>,
    pub tokens: Option<MeterTokens>,
    pub cost: Option<MeterCost>,
    pub activity: Option<MeterActivity>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BranchUsageSummary {
    pub branch: String,
    pub state: MeterRowState,
    pub reason: Option<String>,
    pub tokens: Option<MeterTokens>,
    pub cost: Option<MeterCost>,
    #[serde(default, skip_serializing)]
    pub activity: Option<MeterActivity>,
    #[serde(default)]
    pub activity_hours: Option<u64>,
}

pub type MeterBranchRow = BranchUsageSummary;

/// The 6-field `$defs.botRow` identity key `(bot, kind, role, squad, unrecorded, harness)`.
pub type MeterBotKey = (String, String, Option<String>, Option<String>, Vec<String>, String);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MeterBotRow {
    pub bot: String,
    pub kind: String,
    pub role: Option<String>,
    pub squad: Option<String>,
    #[serde(default)]
    pub unrecorded: Vec<String>,
    pub harness: String,
    pub state: MeterRowState,
    pub reason: Option<String>,
    pub tokens: Option<MeterTokens>,
    pub cost: Option<MeterCost>,
    pub activity: Option<MeterActivity>,
}

impl MeterBotRow {
    pub fn key(&self) -> MeterBotKey {
        (
            self.bot.clone(),
            self.kind.clone(),
            self.role.clone(),
            self.squad.clone(),
            self.unrecorded.clone(),
            self.harness.clone(),
        )
    }
}

fn display_reason(reason: Option<String>, cost: &Option<MeterCost>) -> Option<String> {
    reason.or_else(|| {
        if cost.as_ref().is_some_and(|c| c.state == MeterCostState::Unpriced) {
            Some("unpriced_models".to_string())
        } else {
            None
        }
    })
}

fn push_repo_and_aliases(args: &mut Vec<String>, slug: &str, aliases: &[&str]) {
    args.push("query".to_string());
    args.push("--repo".to_string());
    args.push(slug.to_string());
    for &alias in aliases {
        args.push("--repo-alias".to_string());
        args.push(alias.to_string());
    }
}

fn run_query_rows(args: &[String], has_aliases: bool) -> Result<Value, MeterQueryError> {
    let bin = usagemeter_bin();
    let out = Command::new(&bin)
        .args(args)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map_err(|_| MeterQueryError { reason: "usagemeter_unavailable".to_string() })?;
    let code = out.status.code().unwrap_or(1);
    let parsed: Value = serde_json::from_slice(&out.stdout).map_err(|_| MeterQueryError {
        reason: if code == 0 { "invalid_json".to_string() } else { format!("exit_{code}") },
    })?;
    let contract_ok = parsed.get("contract").and_then(Value::as_str) == Some("usagemeter.query")
        && parsed.get("contract_version").and_then(Value::as_u64) == Some(1)
        && parsed.get("capability").and_then(Value::as_str) == Some("meter.usage@1");
    if !contract_ok {
        return Err(MeterQueryError { reason: "unsupported_contract".to_string() });
    }
    let meter_version = parsed.get("meter_version").and_then(Value::as_str).unwrap_or("");
    if has_aliases && !version_at_least(meter_version, (3, 129, 2)) {
        return Err(MeterQueryError { reason: "needs usagemeter >= 3.129.2".to_string() });
    }
    if !has_aliases && !version_at_least(meter_version, (3, 126, 1)) {
        return Err(MeterQueryError { reason: "needs usagemeter >= 3.126.1".to_string() });
    }

    let status = parsed.get("status").and_then(Value::as_str).unwrap_or("error");
    if code != 0 || status != "ok" {
        let reason = if status != "ok" && status != "error" {
            status.to_string()
        } else {
            parsed
                .get("error")
                .and_then(|e| e.get("code"))
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| if status != "ok" { status.to_string() } else { format!("exit_{code}") })
        };
        return Err(MeterQueryError { reason });
    }
    parsed.get("rows").cloned().ok_or_else(|| MeterQueryError { reason: "invalid_json".to_string() })
}

/// Queries `usagemeter query --repo <slug> [--repo-alias <previous> ...] --by task --window d30 --json`.
pub fn query_repo_by_task(slug: &str) -> Result<Vec<MeterTaskRow>, MeterQueryError> {
    let aliases = repo_aliases_for_query(slug);
    let mut args = Vec::with_capacity(9 + aliases.len() * 2);
    push_repo_and_aliases(&mut args, slug, aliases);
    args.extend([
        "--by".to_string(),
        "task".to_string(),
        "--window".to_string(),
        "d30".to_string(),
        "--json".to_string(),
    ]);
    let rows_val = run_query_rows(&args, !aliases.is_empty())?;
    let mut rows: Vec<MeterTaskRow> =
        serde_json::from_value(rows_val).map_err(|_| MeterQueryError { reason: "invalid_json".to_string() })?;
    for r in &mut rows {
        r.reason = display_reason(r.reason.take(), &r.cost);
    }
    Ok(rows)
}

/// Queries `usagemeter query --repo <slug> [--repo-alias <previous> ...] --window d30 --branch <b1> ... --json`
/// in a single batched invocation (`maxItems: 500`).
pub fn query_repo_by_branches(slug: &str, branches: &[String]) -> Result<Vec<BranchUsageSummary>, MeterQueryError> {
    if branches.is_empty() {
        return Ok(Vec::new());
    }
    let aliases = repo_aliases_for_query(slug);
    let mut args = Vec::with_capacity(6 + aliases.len() * 2 + branches.len().min(MAX_QUERY_BRANCHES) * 2);
    push_repo_and_aliases(&mut args, slug, aliases);
    args.push("--window".to_string());
    args.push("d30".to_string());
    for b in branches.iter().take(MAX_QUERY_BRANCHES) {
        args.push("--branch".to_string());
        args.push(b.clone());
    }
    args.push("--json".to_string());
    let rows_val = run_query_rows(&args, !aliases.is_empty())?;
    let mut rows: Vec<BranchUsageSummary> =
        serde_json::from_value(rows_val).map_err(|_| MeterQueryError { reason: "invalid_json".to_string() })?;
    for r in &mut rows {
        r.activity_hours = r.activity_hours.or_else(|| r.activity.as_ref().map(|a| a.hours));
        r.reason = display_reason(r.reason.take(), &r.cost);
    }
    Ok(rows)
}

/// Queries `usagemeter query --repo <slug> [--repo-alias <previous> ...] --by bot --window d30 --json`.
pub fn query_repo_by_bot(slug: &str) -> Result<Vec<MeterBotRow>, MeterQueryError> {
    let aliases = repo_aliases_for_query(slug);
    let mut args = Vec::with_capacity(9 + aliases.len() * 2);
    push_repo_and_aliases(&mut args, slug, aliases);
    args.extend([
        "--by".to_string(),
        "bot".to_string(),
        "--window".to_string(),
        "d30".to_string(),
        "--json".to_string(),
    ]);
    let rows_val = run_query_rows(&args, !aliases.is_empty())?;
    let mut rows: Vec<MeterBotRow> =
        serde_json::from_value(rows_val).map_err(|_| MeterQueryError { reason: "invalid_json".to_string() })?;
    for r in &mut rows {
        r.reason = display_reason(r.reason.take(), &r.cost);
    }
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_repo_slug_matches_all_15_contract_vectors() {
        let cases: &[(&str, Option<&str>)] = &[
            ("https://github.com/Org/Repo.git", Some("github.com/Org/Repo")),
            ("https://github.com/Org/Repo", Some("github.com/Org/Repo")),
            ("https://github.com/Org/Repo/", Some("github.com/Org/Repo")),
            ("https://github.com/Org/Repo.git/", Some("github.com/Org/Repo")),
            ("git@github.com:Org/Repo.git", Some("github.com/Org/Repo")),
            ("git@github.com:Org/Repo", Some("github.com/Org/Repo")),
            ("ssh://git@github.com/Org/Repo.git", Some("github.com/Org/Repo")),
            ("ssh://git@github.com:2222/Org/Repo.git", Some("github.com/Org/Repo")),
            ("https://token@github.com/Org/Repo.git", Some("github.com/Org/Repo")),
            ("https://user:pass@gitlab.example.com:8443/Group/Sub/Repo.git", Some("gitlab.example.com/Group/Sub/Repo")),
            ("https://EXAMPLE.com/Acme/Widgets", Some("example.com/Acme/Widgets")),
            ("file:///tmp/local-repo", None),
            ("/srv/git/local-repo.git", None),
            ("../relative/repo", None),
            ("", None),
        ];
        for &(input, expected) in cases {
            assert_eq!(normalize_repo_slug(input).as_deref(), expected, "failed for input: {input:?}");
        }
    }

    #[test]
    fn repo_aliases_for_query_returns_previous_name_only_for_renamed_repo() {
        assert_eq!(repo_aliases_for_query("github.com/automagik-si/genie"), &["github.com/automagik-dev/genie"]);
        assert!(repo_aliases_for_query("github.com/other/repo").is_empty());
    }

    #[test]
    fn version_at_least_checks_meter_floors() {
        assert!(version_at_least("3.129.2", (3, 129, 2)));
        assert!(version_at_least("3.130.0", (3, 129, 2)));
        assert!(!version_at_least("3.129.1", (3, 129, 2)));
        assert!(!version_at_least("3.126.1", (3, 129, 2)));
        assert!(version_at_least("3.126.1", (3, 126, 1)));
        assert!(!version_at_least("3.125.9", (3, 126, 1)));
        assert!(!version_at_least("invalid", (3, 126, 1)));
    }

    #[test]
    fn bot_row_key_uses_full_6_field_identity_tuple() {
        let a = MeterBotRow {
            bot: "b-1".to_string(),
            kind: "worker".to_string(),
            role: Some("engineer".to_string()),
            squad: Some("genie".to_string()),
            unrecorded: vec![],
            harness: "codex".to_string(),
            state: MeterRowState::Measured,
            reason: None,
            tokens: None,
            cost: None,
            activity: None,
        };
        let mut b = a.clone();
        assert_eq!(a.key(), b.key());
        b.harness = "claude-code".to_string();
        assert_ne!(a.key(), b.key());
    }
}
