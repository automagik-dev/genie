// The git a wish needs, run as argv (never through a shell) with no prompt: is git here,
// is the folder a repository with a commit, and a worktree on a new branch for the wish.
import { execFile } from 'node:child_process';

const TIMEOUT_MS = 30_000;

/** One git (or other) command; never throws, so callers decide what a failure means. */
export function run(command, args, { cwd } = {}) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { cwd, timeout: TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          code: error ? (error.code ?? 1) : 0,
          stdout: String(stdout ?? '').trim(),
          stderr: String(stderr ?? '').trim(),
        });
      },
    );
  });
}

export const MISSING_TOOLS_MAC =
  'Genie needs git, and this Mac does not have it yet. Open Terminal and run this one line: xcode-select --install — then accept the install, and ask Genie again.';
export const MISSING_GIT =
  'Genie needs git, which is not installed on this computer. Install it (on Ubuntu or Debian: sudo apt install git), then ask Genie again.';

/**
 * Why git cannot run here, or null when it can. On a Mac without the Command Line Tools,
 * /usr/bin/git opens Apple's install dialog instead of failing, so xcode-select is asked
 * first and git is never started there.
 */
export async function gitProblem({ platform = process.platform, exec = run } = {}) {
  if (platform === 'darwin') {
    const tools = await exec('xcode-select', ['-p']);
    if (!tools.ok) return MISSING_TOOLS_MAC;
  }
  const git = await exec('git', ['--version']);
  if (git.ok) return null;
  return platform === 'darwin' ? MISSING_TOOLS_MAC : MISSING_GIT;
}

export const git = (args, cwd) => run('git', args, { cwd });

/** The repository's top folder, or null when `dir` is not inside one. */
export async function topLevel(dir) {
  const result = await git(['rev-parse', '--show-toplevel'], dir);
  return result.ok && result.stdout !== '' ? result.stdout : null;
}

export async function headCommit(dir) {
  const result = await git(['rev-parse', '--verify', 'HEAD'], dir);
  return result.ok ? result.stdout : null;
}

export async function currentBranch(dir) {
  const result = await git(['rev-parse', '--abbrev-ref', 'HEAD'], dir);
  return result.ok ? result.stdout : null;
}

export async function branchExists(dir, branch) {
  return (await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], dir)).ok;
}

/**
 * A new repository on `dev` with one empty commit, so a wish has something to branch from.
 * With no git identity on the machine, the repository gets Genie's own, locally.
 */
export async function initRepo(dir) {
  const init = await git(['init', '-b', 'dev'], dir);
  if (!init.ok) return { ok: false, error: init.stderr || 'git init failed' };
  const email = await git(['config', 'user.email'], dir);
  if (!email.ok || email.stdout === '') {
    await git(['config', 'user.name', 'Genie'], dir);
    await git(['config', 'user.email', 'genie@localhost'], dir);
  }
  const commit = await git(['commit', '--allow-empty', '-m', 'Genie starts here'], dir);
  if (!commit.ok) return { ok: false, error: commit.stderr || 'the first commit failed' };
  return { ok: true };
}

/**
 * A wish's own copy of the project at `dir`, on a new `branch` made from `base`. A clone
 * rather than a worktree: DSH's sandbox lets a session write only under its folder, and a
 * worktree's commits land in the project's own .git, outside it. The clone gets the
 * project's git identity, or Genie's when the machine has none.
 */
export async function cloneForWish(repo, dir, branch, base) {
  const clone = await git(['clone', '--quiet', '--local', '--no-checkout', repo, dir]);
  if (!clone.ok) return { ok: false, error: clone.stderr || 'git clone failed' };
  const checkout = await git(['checkout', '--quiet', '-b', branch, base], dir);
  if (!checkout.ok) return { ok: false, error: checkout.stderr || 'git checkout failed' };
  for (const [key, fallback] of [
    ['user.name', 'Genie'],
    ['user.email', 'genie@localhost'],
  ]) {
    // The project's own setting, else the machine's (a clone keeps neither of the project's).
    const own = await git(['config', key], repo);
    if (own.ok && own.stdout !== '') await git(['config', key, own.stdout], dir);
    else if (!(await git(['config', key], dir)).ok) await git(['config', key, fallback], dir);
  }
  return { ok: true };
}

/** Brings a wish's branch from its clone into the project, never overwriting one there. */
export async function fetchWishBranch(repo, dir, branch) {
  const result = await git(['fetch', '--quiet', dir, `refs/heads/${branch}:refs/heads/${branch}`], repo);
  return result.ok ? { ok: true } : { ok: false, error: result.stderr || 'git fetch failed' };
}

/**
 * The URL a wish publishes to: the project's `origin` when it has one, else its first remote,
 * or null when the project has no remote at all.
 */
export async function publishUrl(repo) {
  const names = await git(['remote'], repo);
  if (!names.ok) return null;
  const remotes = names.stdout.split('\n').filter((name) => name !== '');
  if (remotes.length === 0) return null;
  const url = await git(['remote', 'get-url', remotes.includes('origin') ? 'origin' : remotes[0]], repo);
  return url.ok && url.stdout !== '' ? url.stdout : null;
}

/**
 * Gives a wish's copy the named branches the project already has, as local branches it may
 * change. The clone's remote-tracking refs carry the project's branches already.
 */
export async function grantBranches(dir, branches) {
  for (const branch of branches) {
    const made = await git(['branch', '--quiet', branch, `origin/${branch}`], dir);
    if (!made.ok) return { ok: false, error: made.stderr || `git branch ${branch} failed` };
  }
  return { ok: true };
}

/** In a wish's copy, the project's real remote as `publish`, so a scoped wish can push there. */
export async function addPublishRemote(dir, url) {
  const added = await git(['remote', 'add', 'publish', url], dir);
  return added.ok ? { ok: true } : { ok: false, error: added.stderr || 'git remote add failed' };
}
