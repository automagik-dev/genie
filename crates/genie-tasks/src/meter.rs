//! Read-only `usagemeter query` (Contract 1, `meter.usage@1`) client, canonical `host/owner/repo`
//! remote normalization, and `D6` `--repo-alias` continuity across repository renames.

use std::ffi::OsStr;
use std::fmt;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Single authority for known previous repository names across renames (`D6`).
/// Passed as repeatable `--repo-alias <previous>` flags to `usagemeter` (`>= 3.129.2`).
pub const KNOWN_PREVIOUS_REPO_SLUGS: &[(&str, &[&str])] =
    &[("github.com/automagik-si/genie", &["github.com/automagik-dev/genie"])];

/// Maximum branches per `usagemeter query --branch` invocation (`envelope.schema.json` `maxItems: 500`).
pub const MAX_QUERY_BRANCHES: usize = 500;

/// The `usagemeter query --window` values Genie passes. `d90` (`REQUEST-6a`) needs `usagemeter >= 3.129.5`.
pub const QUERY_WINDOWS: &[&str] = &["d1", "d7", "d30", "d90"];

/// Maximum `usagemeter query` stdout payload accepted by Genie (`512 KiB = 524,288 bytes`).
/// Per `docs/rfcs/0018-meter-query-contract.md` §"The byte budget", the meter whole-envelope ceiling
/// on stdout is `448 KiB` (`458,752 bytes`), and Genie's documented stdout cap is `512 KiB`,
/// providing a `64 KiB` margin above the maximum valid envelope.
pub const MAX_METER_OUTPUT_BYTES: usize = 512 * 1024;

/// Hard wall-clock deadline per `usagemeter query` call: the `3 s` that
/// `docs/rfcs/0018-meter-query-contract.md` §"The caller's side (genie-rs)" proposes. It sits above the
/// meter's own `2 s` busy budget (exit `11` `locked`), so a busy store still answers `locked` itself;
/// past it a wedged binary is killed and reaped and never freezes `genie-rs list` / `status`.
pub const METER_CALL_TIMEOUT: Duration = Duration::from_secs(3);

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
/// Bounded by [`METER_CALL_TIMEOUT`] and a `4 KiB` stdout cap so a hung `git` child
/// never blocks `genie-rs`.
pub fn repo_slug_of_project(project: &Path) -> Option<String> {
    let (code, buf) =
        run_bounded_process(Path::new("git"), &["remote", "get-url", "origin"], Some(project), 4096).ok()?;
    if code != 0 {
        return None;
    }
    normalize_repo_slug(&String::from_utf8_lossy(&buf))
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

/// Pure helper for [`usagemeter_bin`]: resolves `env_override` (`USAGEMETER_BIN`), then
/// `<home>/.local/bin/usagemeter` when that file exists, then `"usagemeter"` on `PATH`.
pub fn resolve_usagemeter_bin(env_override: Option<&OsStr>, home: Option<&OsStr>) -> PathBuf {
    if let Some(bin) = env_override
        && !bin.is_empty()
    {
        return PathBuf::from(bin);
    }
    if let Some(home) = home
        && !home.is_empty()
    {
        let candidate = PathBuf::from(home).join(".local").join("bin").join("usagemeter");
        if candidate.is_file() {
            return candidate;
        }
    }
    PathBuf::from("usagemeter")
}

/// Resolves the `usagemeter` binary path: `USAGEMETER_BIN`, then `$HOME/.local/bin/usagemeter`, then `PATH`.
pub fn usagemeter_bin() -> PathBuf {
    resolve_usagemeter_bin(std::env::var_os("USAGEMETER_BIN").as_deref(), std::env::var_os("HOME").as_deref())
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

/// Union of Contract 1 row states across `meter/schema/query/v1/envelope.schema.json`:
/// - `$defs.taskRow` (`--by task`): `measured | stale | missing` (never `zero` or `unsupported`).
/// - `$defs.branchRow` (`--branch`): `measured | zero | missing | stale | unsupported`.
/// - `$defs.botRow` (`--by bot`): `measured | stale`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MeterRowState {
    Measured,
    Zero,
    Missing,
    Stale,
    Unsupported,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MeterCostState {
    Priced,
    Partial,
    Unpriced,
    Zero,
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

fn sanitize_cost(state: MeterRowState, cost: &mut Option<MeterCost>) {
    if let Some(c) = cost
        && (matches!(state, MeterRowState::Missing | MeterRowState::Stale | MeterRowState::Unsupported)
            || c.state == MeterCostState::Unpriced)
    {
        c.usd = None;
    }
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

fn kill_and_reap(child: &mut Child) {
    #[cfg(unix)]
    {
        let _ = Command::new("/bin/kill")
            .args(["-9", &format!("-{}", child.id())])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn run_bounded_process<S: AsRef<OsStr>>(
    bin: &Path,
    args: &[S],
    current_dir: Option<&Path>,
    max_bytes: usize,
) -> Result<(i32, Vec<u8>), MeterQueryError> {
    let mut cmd = Command::new(bin);
    cmd.args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(dir) = current_dir {
        cmd.current_dir(dir);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd.spawn().map_err(|_| MeterQueryError { reason: "usagemeter_unavailable".to_string() })?;
    let stdout = child.stdout.take().ok_or_else(|| {
        kill_and_reap(&mut child);
        MeterQueryError { reason: "usagemeter_unavailable".to_string() }
    })?;
    let start = Instant::now();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let res = stdout.take((max_bytes as u64) + 1).read_to_end(&mut buf).map(|_| buf);
        let _ = tx.send(res);
    });
    let buf = match rx.recv_timeout(METER_CALL_TIMEOUT) {
        Ok(Ok(buf)) => buf,
        Ok(Err(_)) | Err(RecvTimeoutError::Disconnected) => {
            kill_and_reap(&mut child);
            return Err(MeterQueryError { reason: "usagemeter_unavailable".to_string() });
        }
        Err(RecvTimeoutError::Timeout) => {
            kill_and_reap(&mut child);
            return Err(MeterQueryError { reason: "usagemeter_timeout".to_string() });
        }
    };
    if buf.len() > max_bytes {
        kill_and_reap(&mut child);
        return Err(MeterQueryError { reason: "output_too_large".to_string() });
    }
    let exit_status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if start.elapsed() >= METER_CALL_TIMEOUT {
                    kill_and_reap(&mut child);
                    return Err(MeterQueryError { reason: "usagemeter_timeout".to_string() });
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(_) => {
                kill_and_reap(&mut child);
                return Err(MeterQueryError { reason: "usagemeter_unavailable".to_string() });
            }
        }
    };
    Ok((exit_status.code().unwrap_or(1), buf))
}

fn classify_query_failure(code: i32, status: &str, error_code: Option<&str>) -> String {
    match code {
        1 => error_code.filter(|ec| !ec.is_empty()).unwrap_or("internal_error").to_string(),
        2 => "usage".to_string(),
        10 => "absent_store".to_string(),
        11 => "locked".to_string(),
        12 => "newer_schema".to_string(),
        13 => "outdated_store".to_string(),
        14 => "unsupported_contract".to_string(),
        15 => "too_large".to_string(),
        0 => match (status, error_code) {
            (_, Some(ec)) if !ec.is_empty() => ec.to_string(),
            (s, _) if s != "ok" => s.to_string(),
            _ => "error".to_string(),
        },
        _ => format!("exit_{code}"),
    }
}

/// The oldest `usagemeter` a call needs: `3.126.1`, `3.129.2` with `--repo-alias` (`D6`), `3.129.5` for
/// `--window d90` (`REQUEST-6a`). An older meter's answer is refused as `"needs usagemeter >= <floor>"`.
fn meter_floor(has_aliases: bool, window: &str) -> (u64, u64, u64) {
    match (has_aliases, window) {
        (_, "d90") => (3, 129, 5),
        (true, _) => (3, 129, 2),
        (false, _) => (3, 126, 1),
    }
}

fn run_query_rows(args: &[String], has_aliases: bool) -> Result<Value, MeterQueryError> {
    run_query_with(&usagemeter_bin(), args, meter_floor(has_aliases, "d30"))?
        .get_mut("rows")
        .map(Value::take)
        .ok_or_else(|| MeterQueryError { reason: "invalid_json".to_string() })
}

/// Runs one `usagemeter query` and returns its whole Contract 1 envelope once it is an `ok` answer from a
/// meter at or above `floor`; every other outcome is a [`MeterQueryError`] with its reason.
fn run_query_with(bin: &Path, args: &[String], floor: (u64, u64, u64)) -> Result<Value, MeterQueryError> {
    let (code, buf) = run_bounded_process(bin, args, None, MAX_METER_OUTPUT_BYTES)?;
    let needs = format!("needs usagemeter >= {}.{}.{}", floor.0, floor.1, floor.2);
    // RFC 0018 §"Exit codes": a meter older than v1 exits 2 with no envelope, so it is too old.
    let parsed: Value = serde_json::from_slice(&buf).map_err(|_| MeterQueryError {
        reason: match code {
            0 => "invalid_json".to_string(),
            2 => needs.clone(),
            _ => classify_query_failure(code, "error", None),
        },
    })?;
    if let Some(meter_version) = parsed.get("meter_version").and_then(Value::as_str)
        && !version_at_least(meter_version, floor)
    {
        return Err(MeterQueryError { reason: needs });
    }

    let status = parsed.get("status").and_then(Value::as_str).unwrap_or("error");
    if code != 0 || status != "ok" {
        let error_code = parsed.get("error").and_then(|e| e.get("code")).and_then(Value::as_str);
        return Err(MeterQueryError { reason: classify_query_failure(code, status, error_code) });
    }
    let contract_ok = parsed.get("contract").and_then(Value::as_str) == Some("usagemeter.query")
        && parsed.get("contract_version").and_then(Value::as_u64) == Some(1)
        && parsed.get("capability").and_then(Value::as_str) == Some("meter.usage@1");
    if !contract_ok {
        return Err(MeterQueryError { reason: "unsupported_contract".to_string() });
    }
    match parsed.get("rows") {
        Some(Value::Array(_)) => Ok(parsed),
        _ => Err(MeterQueryError { reason: "invalid_json".to_string() }),
    }
}

fn by_subject_args(slug: &str, by: &str, window: &str) -> (Vec<String>, bool) {
    let aliases = repo_aliases_for_query(slug);
    let mut args = Vec::with_capacity(9 + aliases.len() * 2);
    push_repo_and_aliases(&mut args, slug, aliases);
    for flag in ["--by", by, "--window", window, "--json"] {
        args.push(flag.to_string());
    }
    (args, !aliases.is_empty())
}

/// One `--by task` answer: the rows plus the envelope fields a report carries beside them, passed
/// through as the meter wrote them (`meter/schema/query/v1/envelope.schema.json`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MeterTaskAnswer {
    pub meter_version: String,
    pub window: Value,
    pub ingestion: Value,
    pub sources: Value,
    pub unattributed: Value,
    pub actor_unattributed: Value,
    pub pricing: Value,
    pub rows: Vec<MeterTaskRow>,
}

/// Queries `usagemeter query --repo <slug> [--repo-alias <previous> ...] --by task --window d30 --json`.
pub fn query_repo_by_task(slug: &str) -> Result<Vec<MeterTaskRow>, MeterQueryError> {
    query_repo_by_task_in(slug, "d30").map(|answer| answer.rows)
}

/// Queries `usagemeter query --repo <slug> [--repo-alias <previous> ...] --by task --window <window> --json`
/// (`window` in [`QUERY_WINDOWS`]) in one call and keeps the envelope fields beside the rows.
pub fn query_repo_by_task_in(slug: &str, window: &str) -> Result<MeterTaskAnswer, MeterQueryError> {
    query_repo_by_task_with_bin(slug, window, &usagemeter_bin())
}

fn query_repo_by_task_with_bin(slug: &str, window: &str, bin: &Path) -> Result<MeterTaskAnswer, MeterQueryError> {
    let (args, has_aliases) = by_subject_args(slug, "task", window);
    let mut envelope = run_query_with(bin, &args, meter_floor(has_aliases, window))?;
    let mut take = |key: &str| envelope.get_mut(key).map(Value::take).unwrap_or(Value::Null);
    let rows_val = take("rows");
    let mut rows: Vec<MeterTaskRow> =
        serde_json::from_value(rows_val).map_err(|_| MeterQueryError { reason: "invalid_json".to_string() })?;
    for r in &mut rows {
        r.reason = display_reason(r.reason.take(), &r.cost);
        sanitize_cost(r.state, &mut r.cost);
    }
    Ok(MeterTaskAnswer {
        meter_version: take("meter_version").as_str().unwrap_or_default().to_string(),
        window: take("window"),
        ingestion: take("ingestion"),
        sources: take("sources"),
        unattributed: take("unattributed"),
        actor_unattributed: take("actor_unattributed"),
        pricing: take("pricing"),
        rows,
    })
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
    args.extend(["--window".to_string(), "d30".to_string()]);
    for b in branches.iter().take(MAX_QUERY_BRANCHES) {
        args.extend(["--branch".to_string(), b.clone()]);
    }
    args.push("--json".to_string());
    let rows_val = run_query_rows(&args, !aliases.is_empty())?;
    let mut rows: Vec<BranchUsageSummary> =
        serde_json::from_value(rows_val).map_err(|_| MeterQueryError { reason: "invalid_json".to_string() })?;
    for r in &mut rows {
        r.activity_hours = r.activity_hours.or_else(|| r.activity.as_ref().map(|a| a.hours));
        r.reason = display_reason(r.reason.take(), &r.cost);
        sanitize_cost(r.state, &mut r.cost);
    }
    Ok(rows)
}

/// Queries `usagemeter query --repo <slug> [--repo-alias <previous> ...] --by bot --window d30 --json`.
pub fn query_repo_by_bot(slug: &str) -> Result<Vec<MeterBotRow>, MeterQueryError> {
    query_repo_by_bot_with_bin(slug, &usagemeter_bin())
}

fn query_repo_by_bot_with_bin(slug: &str, bin: &Path) -> Result<Vec<MeterBotRow>, MeterQueryError> {
    let (args, has_aliases) = by_subject_args(slug, "bot", "d30");
    let rows_val = run_query_with(bin, &args, meter_floor(has_aliases, "d30"))?
        .get_mut("rows")
        .map(Value::take)
        .unwrap_or(Value::Null);
    let mut rows: Vec<MeterBotRow> =
        serde_json::from_value(rows_val).map_err(|_| MeterQueryError { reason: "invalid_json".to_string() })?;
    for r in &mut rows {
        r.reason = display_reason(r.reason.take(), &r.cost);
        sanitize_cost(r.state, &mut r.cost);
    }
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    use serde_json::json;
    use sha2::{Digest, Sha256};

    use super::*;

    /// Vendored byte-for-byte from `meter/schema/query/v1/repo-normalization.json` at tag `v3.129.2`
    /// (`sha256: aaf81e35a06e7e92ebda021198fcdc550d016e9707e40398f27994c2505a4b5a`).
    const REPO_NORMALIZATION_FIXTURE: &str = include_str!("../tests/fixtures/repo-normalization.json");
    const REPO_NORMALIZATION_SHA256: &str = "aaf81e35a06e7e92ebda021198fcdc550d016e9707e40398f27994c2505a4b5a";

    #[derive(Deserialize)]
    struct RepoNormalizationCase {
        remote: String,
        repo: Option<String>,
    }

    #[derive(Deserialize)]
    struct RepoNormalizationFixture {
        cases: Vec<RepoNormalizationCase>,
    }

    #[test]
    fn normalize_repo_slug_matches_all_15_contract_vectors() {
        let digest = Sha256::digest(REPO_NORMALIZATION_FIXTURE.as_bytes());
        let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(hex, REPO_NORMALIZATION_SHA256);

        let fixture: RepoNormalizationFixture =
            serde_json::from_str(REPO_NORMALIZATION_FIXTURE).expect("valid repo-normalization.json fixture");
        assert_eq!(fixture.cases.len(), 15);
        for case in &fixture.cases {
            assert_eq!(normalize_repo_slug(&case.remote).as_deref(), case.repo.as_deref(), "remote: {:?}", case.remote);
        }
    }

    #[test]
    fn repo_aliases_for_query_and_version_floors() {
        assert_eq!(repo_aliases_for_query("github.com/automagik-si/genie"), &["github.com/automagik-dev/genie"]);
        assert!(repo_aliases_for_query("github.com/other/repo").is_empty());
        assert!(version_at_least("3.129.2", (3, 129, 2)) && version_at_least("3.130.0", (3, 129, 2)));
        assert!(!version_at_least("3.129.1", (3, 129, 2)) && !version_at_least("3.126.1", (3, 129, 2)));
        assert!(version_at_least("3.126.1", (3, 126, 1)) && !version_at_least("3.125.9", (3, 126, 1)));
        assert!(!version_at_least("invalid", (3, 126, 1)));
    }

    #[test]
    fn meter_floor_rises_with_the_alias_and_the_d90_window() {
        assert_eq!(meter_floor(false, "d30"), (3, 126, 1));
        assert_eq!(meter_floor(true, "d7"), (3, 129, 2));
        assert_eq!(meter_floor(false, "d90"), (3, 129, 5));
        assert_eq!(meter_floor(true, "d90"), (3, 129, 5));
        assert_eq!(QUERY_WINDOWS, ["d1", "d7", "d30", "d90"]);
    }

    #[test]
    fn bot_row_key_uses_full_6_field_identity_tuple() {
        let a = MeterBotRow {
            bot: "b-1".into(),
            kind: "worker".into(),
            role: Some("engineer".into()),
            squad: Some("genie".into()),
            unrecorded: vec![],
            harness: "codex".into(),
            state: MeterRowState::Measured,
            reason: None,
            tokens: None,
            cost: None,
            activity: None,
        };
        let mut b = a.clone();
        assert_eq!(a.key(), b.key());
        b.harness = "claude-code".into();
        assert_ne!(a.key(), b.key());
    }

    #[test]
    fn resolve_usagemeter_bin_follows_three_step_precedence() {
        let dir = std::env::temp_dir().join(format!("genie-meter-bin-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let home_meter = dir.join(".local/bin/usagemeter");
        fs::create_dir_all(home_meter.parent().unwrap()).unwrap();
        fs::write(&home_meter, "#!/bin/sh\n").unwrap();

        assert_eq!(
            resolve_usagemeter_bin(Some(OsStr::new("/custom/bin/usagemeter")), Some(dir.as_os_str())),
            PathBuf::from("/custom/bin/usagemeter")
        );
        assert_eq!(resolve_usagemeter_bin(None, Some(dir.as_os_str())), home_meter);
        assert_eq!(resolve_usagemeter_bin(Some(OsStr::new("")), Some(dir.as_os_str())), home_meter);
        fs::remove_file(&home_meter).unwrap();
        assert_eq!(resolve_usagemeter_bin(None, Some(dir.as_os_str())), PathBuf::from("usagemeter"));
        assert_eq!(resolve_usagemeter_bin(None, None), PathBuf::from("usagemeter"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn query_repo_by_bot_passes_repo_alias_normalizes_reasons_and_nulls_stale_usd() {
        let dir = std::env::temp_dir().join(format!("genie-meter-bot-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let (log_path, json_path, bin_path) = (dir.join("bot.log"), dir.join("bot.json"), dir.join("usagemeter"));
        // Shape copied from real `usagemeter query --by bot --json` output (3.129.x), names made synthetic.
        let tok = json!({"input": 80, "cache_read": 0, "cache_write_5m": 0, "cache_write_1h": 0, "output": 20, "reasoning": 10, "unsplit": 0, "total": 100});
        let actor = json!({"tokens_attributed": 100, "tokens_ambiguous": 0, "tokens_unlinked": 0, "tokens_before_evidence": 0, "tokens_by_basis": {"session": 100, "label": 0, "worktree": 0}, "tokens_by_branch_basis": {"log": 100, "ledger": 0, "none": 0}});
        let row = |bot: &str,
                   squad: Value,
                   unrecorded: Value,
                   harness: &str,
                   state: &str,
                   reason: Value,
                   cost: Value| {
            json!({"bot": bot, "kind": "worker", "role": "engineer", "squad": squad, "unrecorded": unrecorded, "harness": harness,
                "state": state, "reason": reason, "tokens": tok, "cost": cost,
                "models": [{"model": "claude-opus-5-5", "calls": 3, "tokens": tok, "cost_usd": cost["usd"]}], "models_omitted": 0,
                "token_precision": "exact", "attribution": {"precision": "actor_interval", "exclusive": false, "shared": false, "coverage": "complete", "actor": actor},
                "activity": {"first_hour": "2026-11-11T09:00:00Z", "last_hour": "2026-11-11T10:00:00Z", "hours": 2, "harnesses": [harness]}, "incomplete_sources": []})
        };
        let envelope = json!({
            "contract": "usagemeter.query", "contract_version": 1, "capability": "meter.usage@1",
            "meter_version": "3.129.2", "status": "ok", "error": Value::Null, "generated_at": "2026-11-11T15:00:00Z",
            "as_of": "2026-11-11T14:55:00Z", "machine": {"id": "0123456789abcdef0123456789abcdef", "scope": "local"},
            "store": {"schema_version": 3, "location": "current"},
            "ingestion": {"watermark": "2026-11-11T14:55:00Z", "counted_from": "2026-10-03T00:00:00Z", "evidence_from": "2026-11-07T00:00:00Z", "complete": true, "backlog": {"bytes": 0, "files": 0}, "stale": false, "stale_after_s": 7200},
            "window": {"name": "d30", "requested_start": "2026-10-12T15:00:00Z", "start": "2026-10-12T15:00:00Z", "end": "2026-11-11T15:00:00Z", "clipped": false},
            "sources": [{"harness": "claude-code", "status": "ok", "reason": null, "last_success": "2026-11-11T14:55:00Z", "stale": false}],
            "unattributed": {"tokens_total": 0, "harnesses": []},
            "actor_unattributed": {"tokens_total": 0, "tokens_ambiguous": 0, "tokens_unlinked": 0, "tokens_before_evidence": 0, "parts": [], "absent_bot_is_zero": false},
            "pricing": {"table": {"origin": "bundled", "date": "2026-10-06", "source": "usagemeter bundled list prices", "label": "list prices, an estimate", "sha256": null}, "reported_wins": true, "long_prompt_tiers": false},
            "query": {"repo": "github.com/automagik-si/genie", "repo_aliases": ["github.com/automagik-dev/genie"], "window": "d30", "by": "bot", "branch_count": 0, "branches": [], "branches_complete": true, "request_sha256": "0".repeat(64)},
            "rows": [
                row("b-worker-1", json!("genie"), json!([]), "claude-code", "measured", Value::Null, json!({"state": "unpriced", "usd": null, "usd_reported": null, "usd_estimated": null, "tokens_priced": 0, "tokens_reported": 0, "tokens_unpriced": 100, "unpriced_models": ["local-v1"], "unpriced_models_omitted": 0})),
                row("b-worker-2", Value::Null, json!(["squad"]), "codex", "stale", json!("ingestion_stale"), json!({"state": "priced", "usd": 9.99, "usd_reported": 0, "usd_estimated": 9.99, "tokens_priced": 100, "tokens_reported": 0, "tokens_unpriced": 0, "unpriced_models": [], "unpriced_models_omitted": 0}))
            ]
        });
        fs::write(&json_path, envelope.to_string()).unwrap();
        let script = format!(
            "#!/bin/sh\nprintf '%s\\n' \"$*\" > \"{}\"\nwhile IFS= read -r l || [ -n \"$l\" ]; do printf '%s\\n' \"$l\"; done < \"{}\"\n",
            log_path.display(),
            json_path.display()
        );
        fs::write(&bin_path, script).unwrap();
        fs::set_permissions(&bin_path, fs::Permissions::from_mode(0o755)).unwrap();

        let rows = query_repo_by_bot_with_bin("github.com/automagik-si/genie", &bin_path).unwrap();
        assert_eq!(
            fs::read_to_string(&log_path).unwrap().trim(),
            "query --repo github.com/automagik-si/genie --repo-alias github.com/automagik-dev/genie --by bot --window d30 --json"
        );
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].key().0, "b-worker-1");
        assert_eq!((rows[0].reason.as_deref(), rows[0].cost.as_ref().unwrap().usd), (Some("unpriced_models"), None));
        assert_eq!(
            (rows[1].state, rows[1].reason.as_deref(), rows[1].cost.as_ref().unwrap().usd),
            (MeterRowState::Stale, Some("ingestion_stale"), None)
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
