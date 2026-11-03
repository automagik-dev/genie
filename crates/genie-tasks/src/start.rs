//! `start`: cut a task worktree from a freshly fetched base, with a short id and push lockout
//! (DESIGN.md IN row 9, WISH.md Group 2).
//!
//! Before step (a), an id whose task is `opened` or `merged` is refused at zero cost (Decision 6),
//! as are a repository whose shared config sets `core.bare = true` or `core.worktree`, and a
//! request with nothing to name the branch after, or a shared pushurl this git cannot override per
//! worktree. Then: (a) the base is fetched into a private `refs/genie/start/<nonce>` ref, peeled and
//! deleted, never through FETCH_HEAD; (b) an untracked task reserves `gn-<seq>` in one short
//! transaction; (c) under the per-repository start lock, the worktree directory and the branch are
//! claimed atomically and `git worktree add` fills them; (d) still under it, `extensions.worktreeConfig`
//! plus, for every remote, a per-worktree pushurl list holding only a URL no transport serves;
//! (e) the `created` event in a second short transaction; (f) the caller prints the result.
//! A failure after (b) abandons the reservation, after (c) it also removes what this start made,
//! and nothing else, and neither writes an event. No git command runs inside a transaction.

use std::fmt;
use std::fs;
use std::io::{self, Write};
use std::path::Path;
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread::sleep;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::state::{TaskEvent, TaskState};
use crate::store::{self, EventRow, Recorded, Store, open_store_at, project_root, record};

/// The one remote `start` fetches from and `push` pushes to.
pub const REMOTE: &str = "origin";
/// The per-worktree pushurl of every remote: no git transport serves it, so a plain push fails.
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

/// Every configured remote. The lockout covers each one, so no named push leaves a task worktree.
fn remotes(root: &Path) -> Result<Vec<String>, VerbError> {
    let list = git_read(root, &["remote"])?.unwrap_or_default();
    Ok(list.lines().filter(|r| !r.is_empty()).map(str::to_string).collect())
}

/// `remote.<r>.pushurl` is multivalued: a worktree value is appended to the inherited ones, and git
/// pushes to every one in turn. The lockout therefore resets the list with an empty value first,
/// which git honours from 2.46. A git that cannot reset a pushurl the shared config carries is
/// refused here, before any fetch, by asking git itself with the same two values on its command line.
fn refuse_unresettable_pushurls(root: &Path, remotes: &[String]) -> Result<(), VerbError> {
    for remote in remotes {
        let key = format!("remote.{remote}.pushurl");
        if git_read(root, &["config", "--get-all", &key])?.is_none() {
            continue;
        }
        let (reset, sentinel) = (format!("{key}="), format!("{key}={NO_PUSH_URL}"));
        let effective =
            git_read(root, &["-c", &reset, "-c", &sentinel, "remote", "get-url", "--push", "--all", remote])?;
        if effective.as_deref() != Some(NO_PUSH_URL) {
            return Err(VerbError::Refused(format!(
                "{} sets {key}, and this git cannot override it in a task worktree (an empty value resets the list from git 2.46): upgrade git, or move {key} out of the shared config",
                root.display()
            )));
        }
    }
    Ok(())
}

/// Step (d) in `worktree`: for every remote, reset the inherited pushurl list when there is one,
/// add the sentinel, and verify the worktree now pushes to the sentinel alone.
fn lock_out(
    root: &Path,
    worktree: &Path,
    base: &str,
    remotes: &[String],
    notes: &mut dyn Write,
) -> Result<(), VerbError> {
    enable_worktree_config(root, notes)?;
    for remote in remotes {
        let key = format!("remote.{remote}.pushurl");
        if git_read(worktree, &["config", "--get-all", &key])?.is_some() {
            git_ok(worktree, &["config", "--worktree", "--add", &key, ""], "git config --worktree pushurl reset")?;
        }
        git_ok(worktree, &["config", "--worktree", "--add", &key, NO_PUSH_URL], "git config --worktree pushurl")?;
        let effective = git_read(worktree, &["remote", "get-url", "--push", "--all", remote])?;
        if effective.as_deref() != Some(NO_PUSH_URL) {
            return Err(VerbError::Failed(format!(
                "the push lockout did not hold for {remote}: the worktree still pushes to {}",
                effective.unwrap_or_default().replace('\n', ", ")
            )));
        }
    }
    git_ok(worktree, &["config", "--worktree", BASE_KEY, base], "git config --worktree genie.base")?;
    Ok(())
}

/// One start at a time creates a worktree in a repository. Git has no lock around `worktree add`
/// (it reads every other worktree's admin files while they are being written), and the claims below
/// are what make a path and a branch this start's to remove. The lock spans git only: no SQLite
/// transaction and no network call, and the OS releases it if the process dies.
struct StartLock(#[allow(dead_code, reason = "held for its lock, released on drop")] fs::File);

impl StartLock {
    fn acquire(root: &Path) -> Result<StartLock, VerbError> {
        let common = git_ok(root, &["rev-parse", "--path-format=absolute", "--git-common-dir"], "git rev-parse")?;
        let file = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(Path::new(&common).join("genie-start.lock"))?;
        file.lock()?;
        Ok(StartLock(file))
    }
}

/// What this start created, and therefore all it may remove.
#[derive(Default)]
struct Made {
    dir: bool,
    branch: bool,
    worktree: bool,
}

/// Step (c) under the start lock. Each claim is atomic and fails when its target exists, so a
/// path or branch this start did not create is never recorded in `made`.
fn make(root: &Path, worktree: &Path, branch: &str, base_sha: &str, made: &mut Made) -> Result<(), VerbError> {
    match fs::create_dir(worktree) {
        Ok(()) => made.dir = true,
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
            return Err(VerbError::Failed(format!("{} already exists", worktree.display())));
        }
        Err(e) => return Err(e.into()),
    }
    let out = git(root, &["branch", "--no-track", branch, base_sha])?;
    if !out.status.success() {
        return Err(VerbError::Failed(format!(
            "git branch {branch} failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    made.branch = true;
    git_ok(root, &["worktree", "add", "--quiet", &worktree.to_string_lossy(), branch], "git worktree add")?;
    made.worktree = true;
    Ok(())
}

/// Remove exactly what `made` names, newest first; best effort, each step independent.
fn unmake(root: &Path, worktree: &Path, branch: &str, made: &Made) {
    if made.worktree {
        let _ = git(root, &["worktree", "remove", "--force", "--force", &worktree.to_string_lossy()]);
    }
    if made.dir && worktree.exists() {
        let _ = fs::remove_dir_all(worktree);
    }
    if made.branch {
        let _ = git(root, &["branch", "-D", branch]);
    }
}

/// The task a start settles on and where it goes.
struct Cut<'a> {
    task: &'a str,
    base: &'a str,
    base_sha: &'a str,
    slug: &'a str,
    title: &'a str,
    kind: &'a str,
    remotes: &'a [String],
}

/// Steps (c)–(e). (c) and (d) run under the start lock; (e) runs after it, and a failure there
/// takes the lock again to remove what (c) made.
fn cut(
    store: &Store,
    root: &Path,
    c: &Cut<'_>,
    opts: &StartOptions,
    notes: &mut dyn Write,
) -> Result<Started, VerbError> {
    let name = format!("{}-{}", c.task, c.slug);
    let branch = format!("{}/{name}", c.kind);
    let repo_name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let parent = root.with_file_name(format!("{repo_name}.worktrees"));
    fs::create_dir_all(&parent)?;
    let worktree = parent.join(&name);
    let path = worktree.to_string_lossy().into_owned();
    let mut made = Made::default();
    {
        let _lock = StartLock::acquire(root)?;
        let cut = make(root, &worktree, &branch, c.base_sha, &mut made)
            .and_then(|()| lock_out(root, &worktree, c.base, c.remotes, notes));
        if let Err(e) = cut {
            unmake(root, &worktree, &branch, &made);
            return Err(e);
        }
    }
    // (e)
    let mut row = EventRow::new(TaskEvent::Created);
    row.task = c.task.to_string();
    row.branch = branch.clone();
    row.commit = c.base_sha.to_string();
    row.worktree = path.clone();
    row.kind = c.kind.to_string();
    row.title = c.title.to_string();
    row.lead = opts.lead.clone();
    let recorded = match record(store, store.project(), &row) {
        Ok(Recorded::Appended { .. }) => Ok(()),
        Ok(Recorded::Duplicate { .. }) => {
            Err(VerbError::Refused(format!("{} already has this created event (base {}, {path})", c.task, c.base_sha)))
        }
        Err(e) => Err(e.into()),
    };
    match recorded {
        Ok(()) => Ok(Started {
            task: c.task.to_string(),
            branch,
            worktree: path,
            lead: opts.lead.clone(),
            base_sha: c.base_sha.to_string(),
        }),
        // The event committed and only its export row is missing: the task exists, so it stays.
        Err(VerbError::Store(e @ store::Error::Export { .. })) => Err(VerbError::Store(e)),
        Err(e) => {
            let _lock = StartLock::acquire(root).ok();
            unmake(root, &worktree, &branch, &made);
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
    let remotes = remotes(&root)?;
    refuse_unresettable_pushurls(&root, &remotes)?;
    let base = integration_branch(&root)?;
    // (a)
    sweep(&root)?;
    let base_sha = fetch_base(&root, &base)?;
    // (b)
    let (task, reserved) = match &opts.id {
        Some(id) => (id.clone(), false),
        None => (store.reserve_gn()?, true),
    };
    let plan =
        Cut { task: &task, base: &base, base_sha: &base_sha, slug: &slug, title: &title, kind, remotes: &remotes };
    let started = cut(&store, &root, &plan, opts, notes);
    // A committed event whose export row failed keeps its id; every other failure abandons it.
    if reserved && matches!(&started, Err(e) if !matches!(e, VerbError::Store(store::Error::Export { .. }))) {
        let _ = store.abandon_gn(&task);
    }
    started
}
