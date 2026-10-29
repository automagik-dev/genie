// The git a wish needs, run as argv (never through a shell) with no prompt: is git here,
// is the folder a repository with a commit, and a clone on a new branch for the wish.
import { execFile } from 'node:child_process';
import { redact } from './binding.js';

const TIMEOUT_MS = 30_000;

/**
 * One git (or other) command; never throws, so callers decide what a failure means. `env`
 * adds to the environment (binding.js hostGitEnv); GIT_TERMINAL_PROMPT=0 always holds.
 */
export function run(command, args, { cwd, env } = {}) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd,
        timeout: TIMEOUT_MS,
        env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: '0' },
        maxBuffer: 4 * 1024 * 1024,
      },
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

/**
 * A wish's git: `g(step, args, cwd)` runs one command with `options.env` (read at each call,
 * so the binding can set it once it is known) and, when `options.note` is given, hands it
 * `{ step, argv, code, ms }` with every http(s) URL in argv written without its userinfo.
 */
export function gitRunner(options = {}) {
  return async (step, args, cwd) => {
    const started = Date.now();
    const result = await run('git', args, { cwd, env: options.env });
    options.note?.({ step, argv: ['git', ...args].map(redact), code: result.code, ms: Date.now() - started });
    return result;
  };
}
const plainGit = gitRunner();

// A push URL no transport accepts: a wish's origin is the user's own checkout, which no wish
// pushes into, so `git push origin` fails in every wish's copy.
export const NO_PUSH_URL = '/dev/null/genie-wish-copies-push-nowhere';

/** The repository's top folder, or null when `dir` is not inside one. */
export async function topLevel(dir) {
  const result = await git(['rev-parse', '--show-toplevel'], dir);
  return result.ok && result.stdout !== '' ? result.stdout : null;
}

export async function currentBranch(dir, g = plainGit) {
  const result = await g('current-branch', ['rev-parse', '--abbrev-ref', 'HEAD'], dir);
  return result.ok ? result.stdout : null;
}

export async function branchExists(dir, branch, g = plainGit) {
  return (await g('branch-exists', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], dir)).ok;
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
 * A wish's own copy of the project at `dir`, on a new `branch` made from `base` (a commit).
 * A clone rather than a worktree: DSH's sandbox lets a session write only under its folder,
 * and a worktree's commits land in the project's own .git, outside it. `--local` copies the
 * project's objects, so a base fetched into it but on no branch there is in the copy too.
 * The clone gets the project's git identity, or Genie's when the machine has none.
 *
 * Its origin is the project folder, which no wish pushes into, so origin's push URL goes
 * nowhere. A plain wish (`plain`) also gets an empty credential helper: nothing the host
 * does in its copy needs credentials, so the default routes to a push are gone in code, not
 * only in the brief's words. A scoped follow-up keeps the user's helper for its `publish`.
 */
export async function cloneForWish(repo, dir, branch, base, { g = plainGit, plain = true } = {}) {
  const clone = await g('clone', ['clone', '--quiet', '--local', '--no-checkout', repo, dir]);
  if (!clone.ok) return { ok: false, error: redact(clone.stderr) || 'git clone failed' };
  const checkout = await g('checkout', ['checkout', '--quiet', '-b', branch, base], dir);
  if (!checkout.ok) return { ok: false, error: redact(checkout.stderr) || 'git checkout failed' };
  for (const [key, fallback] of [
    ['user.name', 'Genie'],
    ['user.email', 'genie@localhost'],
  ]) {
    // The project's own setting, else the machine's (a clone keeps neither of the project's).
    const own = await g('identity', ['config', key], repo);
    if (own.ok && own.stdout !== '') await g('identity', ['config', key, own.stdout], dir);
    else if (!(await g('identity', ['config', key], dir)).ok) await g('identity', ['config', key, fallback], dir);
  }
  const lockout = [['config', 'remote.origin.pushurl', NO_PUSH_URL]];
  if (plain) lockout.push(['config', 'credential.helper', '']);
  for (const args of lockout) {
    const set = await g('no-push', args, dir);
    if (!set.ok) return { ok: false, error: redact(set.stderr) || `git ${args.join(' ')} failed` };
  }
  return { ok: true };
}

/**
 * Brings a wish's branch from its clone into the project, never overwriting one there that
 * moved elsewhere. `code` is git's exit code, for the wish's evidence.
 */
export async function fetchWishBranch(repo, dir, branch, g = plainGit) {
  const result = await g('fetch-back', ['fetch', '--quiet', dir, `refs/heads/${branch}:refs/heads/${branch}`], repo);
  return result.ok
    ? { ok: true, code: 0 }
    : { ok: false, code: result.code, error: redact(result.stderr) || 'git fetch failed' };
}

/** The commit `ref` is on in `dir`, or null. */
export async function commitOf(dir, ref, g = plainGit, step = 'rev-parse') {
  const result = await g(step, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], dir);
  return result.ok && result.stdout !== '' ? result.stdout : null;
}

/** How many commits `dir` has on `tip` that `from` lacks, or null when git cannot say. */
export async function aheadOf(dir, from, tip, g = plainGit, step = 'ahead') {
  const result = await g(step, ['rev-list', '--count', `${from}..${tip}`], dir);
  const count = Number.parseInt(result.stdout, 10);
  return result.ok && Number.isFinite(count) ? count : null;
}

/**
 * Gives a wish's copy the named branches the project already has, as local branches it may
 * change. The clone's remote-tracking refs carry the project's branches already.
 */
export async function grantBranches(dir, branches, g = plainGit) {
  for (const branch of branches) {
    const made = await g('give-branch', ['branch', '--quiet', branch, `origin/${branch}`], dir);
    if (!made.ok) return { ok: false, error: redact(made.stderr) || `git branch ${branch} failed` };
  }
  return { ok: true };
}

/** In a wish's copy, the project's real remote as `publish`, so a scoped wish can push there. */
export async function addPublishRemote(dir, url, g = plainGit) {
  const added = await g('publish-remote', ['remote', 'add', 'publish', url], dir);
  return added.ok ? { ok: true } : { ok: false, error: redact(added.stderr) || 'git remote add failed' };
}
