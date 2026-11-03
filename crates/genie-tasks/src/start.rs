//! `start`: cut a task worktree from a freshly fetched base, with a short id and push lockout
//! (DESIGN.md IN row 9, WISH.md Group 2).
//!
//! Before step (a), an id whose task is `opened` or `merged` is refused at zero cost (Decision 6),
//! as are a repository whose shared config sets `core.bare = true` or `core.worktree`, and a
//! request with nothing to name the branch after. Then: (a) the base is fetched into a private
//! `refs/genie/start/<nonce>` ref, peeled and deleted, never through FETCH_HEAD; (b) an untracked
//! task reserves `gn-<seq>` in one short transaction; (c) `git worktree add --no-track -b`;
//! (d) `extensions.worktreeConfig` plus a per-worktree `pushurl` that no transport serves;
//! (e) the `created` event in a second short transaction; (f) the caller prints the result.
//! A failure after (b) abandons the reservation, after (c) it also removes the worktree and
//! branch, and neither writes an event. No git command runs inside a transaction.

use std::fmt;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread::sleep;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::state::{TaskEvent, TaskState};
use crate::store::{self, EventRow, Recorded, Store, open_store_at, project_root, record};

/// The one remote `start` fetches from and `push` pushes to.
pub const REMOTE: &str = "origin";
/// The per-worktree `remote.origin.pushurl`: no git transport serves it, so a plain push fails.
pub const NO_PUSH_URL: &str = "genie-no-push://use-genie-rs-push";
/// The private namespace each start fetches its base into.
pub const START_REFS: &str = "refs/genie/start/";
/// A start ref older than this is a leftover the next start sweeps.
pub const SWEEP_AFTER_SECS: u64 = 600;
/// Branches `push` never targets, besides the recorded base.
pub const PROTECTED: [&str; 3] = ["dev", "main", "master"];
/// The per-worktree config key that records the base branch a task was cut from.
pub const BASE_KEY: &str = "genie.base";
const SLUG_MAX: usize = 40;

/// A `start` or `push` that did not complete. Decision 4: `Refused` is exit 2 and changed nothing,
/// `Failed` is exit 1 (a failed fetch, a git error), and a store error keeps its own code.
#[derive(Debug)]
pub enum VerbError {
    Refused(String),
    Failed(String),
    Store(store::Error),
}

impl VerbError {
    pub fn exit_code(&self) -> i32 {
        match self {
            VerbError::Refused(_) => 2,
            VerbError::Failed(_) => 1,
            VerbError::Store(e) => e.exit_code(),
        }
    }
}

impl fmt::Display for VerbError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            VerbError::Refused(why) | VerbError::Failed(why) => write!(f, "{why}"),
            VerbError::Store(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for VerbError {}

impl From<store::Error> for VerbError {
    fn from(e: store::Error) -> Self {
        VerbError::Store(e)
    }
}

impl From<io::Error> for VerbError {
    fn from(e: io::Error) -> Self {
        VerbError::Failed(e.to_string())
    }
}

/// What to start: a forge issue id (`gh-N`, `gl-N`) or, with none, a new `gn-<seq>` task.
#[derive(Debug, Clone, Default)]
pub struct StartOptions {
    pub id: Option<String>,
    /// Names the branch. Optional with an id whose task already has a recorded title.
    pub title: Option<String>,
    pub lead: String,
    /// The conventional-commit type, the branch prefix; `fix` when empty.
    pub kind: String,
}

/// Step (f)'s output, for `automagik-herdr worker --task <id> --worktree <dir> --lead <bot>`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Started {
    pub task: String,
    pub branch: String,
    pub worktree: String,
    pub lead: String,
    pub base_sha: String,
}

/// Run git in `dir` once, never prompting; an unspawnable git is a failure.
fn git_once(dir: &Path, args: &[&str]) -> Result<Output, VerbError> {
    Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .output()
        .map_err(|e| VerbError::Failed(format!("git could not run: {e}")))
}

/// Trimmed stdout when git succeeds, `None` when it exits non-zero.
pub(crate) fn git_read(dir: &Path, args: &[&str]) -> Result<Option<String>, VerbError> {
    let out = git(dir, args)?;
    Ok(out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string()))
}

/// Run git and fail with its stderr when it exits non-zero.
pub(crate) fn git_ok(dir: &Path, args: &[&str], what: &str) -> Result<String, VerbError> {
    let out = git(dir, args)?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(VerbError::Failed(format!("{what} failed: {}", String::from_utf8_lossy(&out.stderr).trim())))
    }
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// `gh-N` or `gl-N`, N a positive integer with no leading zero.
fn forge_id(id: &str) -> bool {
    let digits = id.strip_prefix("gh-").or_else(|| id.strip_prefix("gl-")).unwrap_or("");
    !digits.is_empty() && !digits.starts_with('0') && digits.bytes().all(|b| b.is_ascii_digit())
}

/// Lowercase ASCII letters and digits, every other run as one `-`, at most 40 characters.
pub fn slug(title: &str) -> String {
    let mut out = String::new();
    for c in title.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    out.truncate(SLUG_MAX);
    out.trim_end_matches('-').to_string()
}

/// `src/lib/v5/base-state.ts` `resolveIntegration`: a local `dev`, else `origin/HEAD`'s branch.
fn integration_branch(root: &Path) -> Result<String, VerbError> {
    if git(root, &["show-ref", "--verify", "--quiet", "refs/heads/dev"])?.status.success() {
        return Ok("dev".into());
    }
    let head = git_read(root, &["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])?.unwrap_or_default();
    match head.strip_prefix("refs/remotes/origin/") {
        Some(branch) if !branch.is_empty() => Ok(branch.to_string()),
        _ => Err(VerbError::Refused(format!(
            "no integration branch in {}: no local dev and no refs/remotes/origin/HEAD (run 'git remote set-head origin --auto')",
            root.display()
        ))),
    }
}

/// Git's `init_worktree_config` moves these two out of the shared config before it enables
/// `extensions.worktreeConfig`; `start` refuses instead of editing them.
fn refuse_shared_worktree_keys(root: &Path) -> Result<(), VerbError> {
    let bare = git_read(root, &["config", "--local", "--type=bool", "--get", "core.bare"])?;
    let worktree = git_read(root, &["config", "--local", "--get", "core.worktree"])?;
    if bare.as_deref() == Some("true") || worktree.is_some() {
        return Err(VerbError::Refused(format!(
            "{} sets core.bare or core.worktree in its shared config: move them to the main worktree's config.worktree (git help config, extensions.worktreeConfig), then run start again",
            root.display()
        )));
    }
    Ok(())
}

/// Delete the start refs older than `SWEEP_AFTER_SECS`; the nonce's first field is its unix time.
fn sweep(root: &Path) -> Result<(), VerbError> {
    let refs = git_read(root, &["for-each-ref", "--format=%(refname)", START_REFS])?.unwrap_or_default();
    let now = now_secs();
    for name in refs.lines() {
        let born = name.strip_prefix(START_REFS).and_then(|n| n.split('-').next()).and_then(|s| s.parse::<u64>().ok());
        if born.is_some_and(|born| now.saturating_sub(born) > SWEEP_AFTER_SECS) {
            let _ = git(root, &["update-ref", "-d", name]);
        }
    }
    Ok(())
}

/// Parallel starts can trip git over each other's work in flight: a fetch's connectivity check
/// reads another start's private ref, and git commands that list worktrees read another start's
/// half-written `.git/worktrees/<name>/commondir`. A failure whose stderr names one of those is retried a few times; any
/// other failure is final.
fn raced(out: &Output) -> bool {
    let stderr = String::from_utf8_lossy(&out.stderr);
    !out.status.success()
        && (stderr.contains(START_REFS) || stderr.contains("/commondir") || stderr.contains("/gitdir"))
}

const RACE_ATTEMPTS: u64 = 6;

/// Run git in `dir`, never prompting, retried while the failure is a race with another start
/// (`raced`); an unspawnable git is a failure.
pub(crate) fn git(dir: &Path, args: &[&str]) -> Result<Output, VerbError> {
    let mut attempt = 1;
    loop {
        let out = git_once(dir, args)?;
        if attempt == RACE_ATTEMPTS || !raced(&out) {
            return Ok(out);
        }
        sleep(Duration::from_millis(20 * attempt + u64::from(std::process::id() % 17)));
        attempt += 1;
    }
}

/// Step (a): fetch `<base>` into a private ref, peel it, delete it. FETCH_HEAD is neither read
/// nor written, and a failed fetch never falls back to a local ref.
fn fetch_base(root: &Path, base: &str) -> Result<String, VerbError> {
    static NONCE: AtomicU64 = AtomicU64::new(0);
    let private = format!("{START_REFS}{}-{}-{}", now_secs(), std::process::id(), NONCE.fetch_add(1, Ordering::SeqCst));
    let refspec = format!("+refs/heads/{base}:{private}");
    let fetched = git(
        root,
        &[
            "-c",
            "gc.auto=0",
            "-c",
            "maintenance.auto=false",
            "fetch",
            "--quiet",
            "--no-tags",
            "--no-write-fetch-head",
            "--no-recurse-submodules",
            // An empty refmap: no opportunistic refs/remotes/origin/<base> update for parallel starts to race on.
            "--refmap=",
            REMOTE,
            &refspec,
        ],
    )?;
    let peeled = if fetched.status.success() {
        git_read(root, &["rev-parse", "--verify", "--quiet", &format!("{private}^{{commit}}")])?
    } else {
        None
    };
    // A delete that loses a packed-refs.lock race is retried once, then left for the next sweep.
    if !git(root, &["update-ref", "-d", &private])?.status.success() {
        let _ = git(root, &["update-ref", "-d", &private]);
    }
    if !fetched.status.success() {
        return Err(VerbError::Failed(format!(
            "git fetch {REMOTE} {base} failed: {}",
            String::from_utf8_lossy(&fetched.stderr).trim()
        )));
    }
    peeled.ok_or_else(|| VerbError::Failed(format!("{REMOTE}/{base} did not peel to a commit")))
}

/// Set `extensions.worktreeConfig=true` once per repository, naming it on `notes` when this call
/// is the one that set it. Parallel starts contend on the config lock, so a failed write re-reads.
fn enable_worktree_config(root: &Path, notes: &mut dyn Write) -> Result<(), VerbError> {
    let mut last = String::new();
    for attempt in 0..40u64 {
        let on = git_read(root, &["config", "--local", "--type=bool", "--get", "extensions.worktreeConfig"])?;
        if on.as_deref() == Some("true") {
            return Ok(());
        }
        let out = git(root, &["config", "--local", "extensions.worktreeConfig", "true"])?;
        if out.status.success() {
            writeln!(
                notes,
                "genie-rs: set extensions.worktreeConfig=true in {} (once per repository) so task worktrees carry their own push lockout",
                root.display()
            )?;
            return Ok(());
        }
        last = String::from_utf8_lossy(&out.stderr).trim().to_string();
        sleep(Duration::from_millis(10 + 5 * attempt));
    }
    Err(VerbError::Failed(format!("could not set extensions.worktreeConfig: {last}")))
}

/// Remove a worktree and branch this start created; best effort, each step independent.
fn remove_worktree(root: &Path, worktree: &Path, branch: &str) {
    let path = worktree.to_string_lossy();
    let _ = git(root, &["worktree", "remove", "--force", "--force", &path]);
    if worktree.exists() {
        let _ = fs::remove_dir_all(worktree);
        let _ = git(root, &["worktree", "prune"]);
    }
    let _ = git(root, &["branch", "-D", branch]);
}

/// Steps (c)–(e) for a task whose id is settled. Any failure after (c) removes what (c) made.
#[allow(clippy::too_many_arguments)]
fn cut(
    store: &Store,
    root: &Path,
    task: &str,
    base: &str,
    base_sha: &str,
    slug: &str,
    opts: &StartOptions,
    title: &str,
    kind: &str,
    notes: &mut dyn Write,
) -> Result<Started, VerbError> {
    let name = format!("{task}-{slug}");
    let branch = format!("{kind}/{name}");
    let repo_name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let worktree: PathBuf = root.with_file_name(format!("{repo_name}.worktrees")).join(&name);
    let path = worktree.to_string_lossy().into_owned();
    if worktree.exists() {
        return Err(VerbError::Failed(format!("{path} already exists")));
    }
    // (c) A branch already there is never ours to remove, so it fails here, before the add.
    if git(root, &["show-ref", "--verify", "--quiet", &format!("refs/heads/{branch}")])?.status.success() {
        return Err(VerbError::Failed(format!("branch {branch} already exists")));
    }
    let mut attempt = 1;
    loop {
        // Once per attempt: a retry needs the cleanup below first, or `-b` finds its own branch.
        let out = git_once(root, &["worktree", "add", "--quiet", "--no-track", "-b", &branch, &path, base_sha])?;
        if out.status.success() {
            break;
        }
        // Neither the branch nor the path existed before the add, so whatever it left is its own.
        remove_worktree(root, &worktree, &branch);
        if attempt == RACE_ATTEMPTS || !raced(&out) {
            return Err(VerbError::Failed(format!(
                "git worktree add failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            )));
        }
        sleep(Duration::from_millis(20 * attempt + u64::from(std::process::id() % 17)));
        attempt += 1;
    }
    let mut finish = || -> Result<(), VerbError> {
        // (d)
        enable_worktree_config(root, notes)?;
        let pushurl = format!("remote.{REMOTE}.pushurl");
        git_ok(&worktree, &["config", "--worktree", &pushurl, NO_PUSH_URL], "git config --worktree pushurl")?;
        git_ok(&worktree, &["config", "--worktree", BASE_KEY, base], "git config --worktree genie.base")?;
        // (e)
        let mut row = EventRow::new(TaskEvent::Created);
        row.task = task.to_string();
        row.branch = branch.clone();
        row.commit = base_sha.to_string();
        row.worktree = path.clone();
        row.kind = kind.to_string();
        row.title = title.to_string();
        row.lead = opts.lead.clone();
        match record(store, store.project(), &row) {
            Ok(Recorded::Appended { .. }) => Ok(()),
            Ok(Recorded::Duplicate { .. }) => {
                Err(VerbError::Refused(format!("{task} already has a created event at {base_sha} in {path}")))
            }
            Err(e) => Err(e.into()),
        }
    };
    match finish() {
        Ok(()) => Ok(Started {
            task: task.to_string(),
            branch,
            worktree: path,
            lead: opts.lead.clone(),
            base_sha: base_sha.to_string(),
        }),
        // The event committed and only its export row is missing: the task exists, so it stays.
        Err(VerbError::Store(e @ store::Error::Export { .. })) => Err(VerbError::Store(e)),
        Err(e) => {
            remove_worktree(root, &worktree, &branch);
            Err(e)
        }
    }
}

/// Start a task in `repo` (any checkout of it), exporting to `genie_home`. `notes` receives the
/// one-time `extensions.worktreeConfig` line. Never defaults to the current directory.
pub fn start(repo: &Path, genie_home: &Path, opts: &StartOptions, notes: &mut dyn Write) -> Result<Started, VerbError> {
    let kind = if opts.kind.is_empty() { "fix" } else { opts.kind.as_str() };
    if !kind.bytes().all(|b| b.is_ascii_lowercase()) {
        return Err(VerbError::Refused(format!("--type '{kind}' must be lowercase letters (fix, feat, docs, ...)")));
    }
    if opts.lead.trim().is_empty() {
        return Err(VerbError::Refused("start needs --lead <bot id>".into()));
    }
    if let Some(id) = &opts.id
        && !forge_id(id)
    {
        return Err(VerbError::Refused(format!(
            "'{id}' is not a forge issue id (gh-N or gl-N); omit it to mint a gn id"
        )));
    }
    let root = project_root(repo)?;
    let store = open_store_at(&root, genie_home)?;
    // Decision 6: an opened or merged task is refused before any fetch, ref, reservation or worktree.
    let existing = match &opts.id {
        Some(id) => store.task(id)?,
        None => None,
    };
    if let Some(t) = &existing
        && matches!(t.state, TaskState::Opened | TaskState::Merged)
    {
        return Err(VerbError::Refused(format!(
            "{} is {}: its PR is {}, so it cannot be started again",
            t.task_key,
            t.state.as_str(),
            if t.state == TaskState::Opened { "open" } else { "merged" }
        )));
    }
    let title = match (&opts.title, &existing) {
        (Some(t), _) => t.clone(),
        (None, Some(t)) if !t.title.is_empty() => t.title.clone(),
        (None, _) => {
            return Err(VerbError::Refused(match &opts.id {
                Some(id) => format!("{id} has no recorded title: pass --title <t> to name its branch"),
                None => "start needs an issue id (gh-N, gl-N) or --title <t>".into(),
            }));
        }
    };
    let slug = slug(&title);
    if slug.is_empty() {
        return Err(VerbError::Refused(format!("the title '{title}' has no letters or digits to name a branch")));
    }
    refuse_shared_worktree_keys(&root)?;
    let base = integration_branch(&root)?;
    // (a)
    sweep(&root)?;
    let base_sha = fetch_base(&root, &base)?;
    // (b)
    let (task, reserved) = match &opts.id {
        Some(id) => (id.clone(), false),
        None => (store.reserve_gn()?, true),
    };
    let started = cut(&store, &root, &task, &base, &base_sha, &slug, opts, &title, kind, notes);
    // A committed event whose export row failed keeps its id; every other failure abandons it.
    if reserved && matches!(&started, Err(e) if !matches!(e, VerbError::Store(store::Error::Export { .. }))) {
        let _ = store.abandon_gn(&task);
    }
    started
}
