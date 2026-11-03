//! `push`: the one way out of a task worktree (DESIGN.md IN row 9). It pushes
//! `HEAD:refs/heads/<recorded task branch>` to each of the main checkout's real push URLs, passed as argv
//! and never stored, so the worktree's own `pushurl` lockout stays in place. It refuses (exit 2)
//! any branch but the recorded one, `dev`, `main`, `master` and the recorded base.

use std::fs;
use std::path::Path;

use crate::start::{BASE_KEY, NO_PUSH_URL, PROTECTED, REMOTE, VerbError, git, git_ok, git_read};
use crate::store::{open_store_at, project_root};

/// What `push` sent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pushed {
    pub task: String,
    pub branch: String,
    pub commit: String,
}

/// Push the task worktree containing `dir`. `branch`, when given, must name the recorded task
/// branch; the worktree's checked-out branch must too (a detached HEAD is pushed as is).
pub fn push(dir: &Path, genie_home: &Path, branch: Option<&str>) -> Result<Pushed, VerbError> {
    let top = git_read(dir, &["rev-parse", "--show-toplevel"])?
        .ok_or_else(|| VerbError::Refused(format!("{} is not inside a git worktree", dir.display())))?;
    let top = fs::canonicalize(&top)?;
    let root = project_root(&top)?;
    let store = open_store_at(&root, genie_home)?;
    let created = store.created_in(&top.to_string_lossy())?.ok_or_else(|| {
        VerbError::Refused(format!("{} is not a task worktree: create one with 'genie-rs start'", top.display()))
    })?;
    let recorded = created.branch;
    let base = git_read(&top, &["config", "--worktree", "--get", BASE_KEY])?;
    let current = git_read(&top, &["symbolic-ref", "--quiet", "--short", "HEAD"])?;
    for (what, name) in [("the requested branch", branch), ("the checked-out branch", current.as_deref())] {
        let Some(name) = name else { continue };
        if PROTECTED.contains(&name) || base.as_deref() == Some(name) {
            return Err(VerbError::Refused(format!("{what} {name} is protected: push only reaches {recorded}")));
        }
        if name != recorded {
            return Err(VerbError::Refused(format!("{what} {name} is not {}'s branch {recorded}", created.task)));
        }
    }
    // Every push URL the main checkout's own `git push origin` would use, in its order.
    let urls: Vec<String> = git_read(&root, &["remote", "get-url", "--push", "--all", REMOTE])?
        .unwrap_or_default()
        .lines()
        .filter(|u| !u.is_empty() && *u != NO_PUSH_URL)
        .map(str::to_string)
        .collect();
    if urls.is_empty() {
        return Err(VerbError::Failed(format!("{} has no push URL for {REMOTE}", root.display())));
    }
    let commit = git_ok(&top, &["rev-parse", "--verify", "HEAD^{commit}"], "git rev-parse HEAD")?;
    let refspec = format!("HEAD:refs/heads/{recorded}");
    for url in &urls {
        let out = git(&top, &["push", "--quiet", "--", url, &refspec])?;
        if !out.status.success() {
            return Err(VerbError::Failed(format!(
                "git push to {recorded} at {url} failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            )));
        }
    }
    Ok(Pushed { task: created.task, branch: recorded, commit })
}
