// The repository a wish is bound to, resolved fresh at every grant: which remote it comes
// from, which branch it starts from, and the commit that branch has upstream right now.
// The branch policy is `genie context`'s (src/lib/v5/base-state.ts in the genie CLI): a
// local `dev`, else the remote's default branch, and with no remote at all, local HEAD
// (`local` mode, which the CLI has no form for). The remote's identity lives here, never in
// the wish's copy, and nothing here rewrites a URL git uses: the fetch runs in the user's
// own repository, with the user's own configuration and credentials.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const HTTP = /^https?:\/\//i;

/**
 * A remote URL as Genie writes it down: an http(s) URL loses ALL its userinfo (a token is
 * often the user name there), while ssh:// and scp-style URLs keep theirs as written, since
 * their user is a login name, not a secret.
 */
export function remoteDisplay(url) {
  if (typeof url !== 'string') return null;
  if (!HTTP.test(url)) return url;
  const scheme = url.indexOf('://') + 3;
  const slash = url.indexOf('/', scheme);
  const authority = slash === -1 ? url.slice(scheme) : url.slice(scheme, slash);
  const at = authority.lastIndexOf('@');
  return at === -1 ? url : url.slice(0, scheme) + url.slice(scheme + at + 1);
}

/** Whether an http(s) URL carries any userinfo: a password, or a token used as the user name. */
export const hasHttpUserinfo = (url) => typeof url === 'string' && remoteDisplay(url) !== url;

/** Any text with every http(s) URL in it written as remoteDisplay: git's errors, recorded argv. */
export const redact = (text) => String(text ?? '').replace(/\bhttps?:\/\/[^\s'"]+/gi, (url) => remoteDisplay(url));

/**
 * The `owner/name` a remote URL names, or null: https://host/o/r(.git), ssh://user@host[:port]/o/r(.git)
 * and scp-style user@host:o/r(.git). A local path names no hosted repository.
 */
export function repoSlugOf(url) {
  if (typeof url !== 'string') return null;
  let path;
  const scheme = /^(?:https?|ssh|git):\/\/[^/]+\/(.+)$/i.exec(url);
  if (scheme !== null) path = scheme[1];
  else {
    // scp-style: [user@]host:path, where the host part holds no slash.
    const scp = /^(?:[^@/:]+@)?[^/:]+:(?!\/\/)(.+)$/.exec(url);
    if (scp === null) return null;
    path = scp[1];
  }
  const parts = path
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .split('/')
    .filter((part) => part !== '');
  return parts.length >= 2 ? `${parts.at(-2)}/${parts.at(-1)}` : null;
}

/**
 * The URL as git writes it into FETCH_HEAD (transport_anonymize_url, then fetch.c's
 * store_updated_refs): the userinfo of any URL that is not a local path dropped, then the
 * trailing slashes, then a trailing `.git`. Applying it twice changes nothing, so both
 * sides of a comparison can go through it.
 */
export function fetchHeadUrl(url) {
  let out = String(url);
  const colon = out.indexOf(':');
  const slash = out.indexOf('/');
  const local = colon === -1 || (slash !== -1 && slash < colon);
  const at = out.indexOf('@');
  if (!local && at !== -1) {
    const scheme = out.indexOf('://');
    if (scheme === -1) {
      if (out.indexOf(':', at + 1) !== -1) out = out.slice(at + 1);
    } else if (/^[a-z0-9+.-]+$/i.test(out.slice(0, scheme))) {
      const firstSlash = out.indexOf('/', scheme + 3);
      if (firstSlash === -1 || firstSlash > at) out = out.slice(0, scheme + 3) + out.slice(at + 1);
    }
  }
  out = out.replace(/\/+$/, '');
  return out.length > 5 && out.endsWith('.git') ? out.slice(0, -4) : out;
}

/**
 * One FETCH_HEAD line: `<sha> TAB [not-for-merge] TAB <what> of <url>`, where `what` is
 * `branch '<name>'`, `tag '<name>'`, `'<ref>'` or nothing (a remote's HEAD). Null when the
 * line is not in that form.
 */
export function parseFetchHeadLine(line) {
  const match = /^([0-9a-f]{40}|[0-9a-f]{64})\t(not-for-merge)?\t(.*)$/.exec(line);
  if (match === null) return null;
  const [, sha, notForMerge, description] = match;
  const named = /^(?:(branch|tag) )?'(.+?)' of (.+)$/.exec(description);
  if (named !== null)
    return { sha, forMerge: notForMerge === undefined, kind: named[1] ?? 'ref', name: named[2], url: named[3] };
  return { sha, forMerge: notForMerge === undefined, kind: 'head', name: 'HEAD', url: description };
}

/**
 * The commit a just-made `git fetch <remote> refs/heads/<base>` brought, from FETCH_HEAD's
 * text: it must hold exactly one line, naming `branch '<base>' of` the remote's URL.
 * Anything else means another fetch wrote FETCH_HEAD in between, and the grant refuses
 * rather than start from a commit it cannot vouch for.
 */
export function baseFromFetchHead(text, { base, url }) {
  const lines = String(text ?? '')
    .split('\n')
    .filter((line) => line !== '');
  if (lines.length !== 1) return { error: `FETCH_HEAD holds ${lines.length} lines, not the one this fetch wrote` };
  const line = parseFetchHeadLine(lines[0]);
  if (line === null) return { error: 'FETCH_HEAD is not in the form git writes' };
  if (line.kind !== 'branch' || line.name !== base)
    return { error: `FETCH_HEAD names ${line.kind} ${line.name}, not branch ${base}` };
  if (fetchHeadUrl(line.url) !== fetchHeadUrl(url))
    return { error: `FETCH_HEAD names ${redact(line.url)}, not the remote ${remoteDisplay(url)}` };
  return { sha: line.sha };
}

/**
 * What the host adds to git's environment besides GIT_TERMINAL_PROMPT=0, so no command waits
 * on a prompt: ssh in batch mode only when neither the environment (GIT_SSH_COMMAND, GIT_SSH)
 * nor git's configuration (core.sshCommand) says how to run ssh, so the user's own setup
 * always wins; and Git Credential Manager never interactive, unless the environment says.
 */
export function hostGitEnv(env = process.env, { sshCommandSet = false } = {}) {
  const extra = {};
  if (env.GIT_SSH_COMMAND === undefined && env.GIT_SSH === undefined && !sshCommandSet)
    extra.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes';
  if (env.GCM_INTERACTIVE === undefined) extra.GCM_INTERACTIVE = 'never';
  return extra;
}

const lines = (text) => text.split('\n').filter((line) => line !== '');

// The remote the base comes from: the one its branch names (branch.<base>.remote), else
// origin, else the only remote. Several remotes and none of those is a question for the user.
function pickRemote(remotes, configured) {
  if (configured !== undefined && remotes.includes(configured)) return configured;
  if (remotes.includes('origin')) return 'origin';
  return remotes.length === 1 ? remotes[0] : undefined;
}

/**
 * The binding of `repo`: `{ binding, url, env }`, or `{ error }` naming the one-line fix.
 * `binding` is what is written down, `{ repo, remote, remoteDisplay, repoSlug, base,
 * baseSource }` with baseSource `dev`, `remote-head` or `local`; `url` is the remote's URL as
 * git uses it, kept in memory only; `env` is what every later command of the wish adds to
 * git's environment. In `local` mode `sha` is the commit local HEAD is on.
 * `g(step, args, cwd)` runs one git command (git.js gitRunner).
 */
export async function resolveBinding(repo, g) {
  const listed = await g('remotes', ['remote'], repo);
  if (!listed.ok) return { error: `Genie could not read the remotes of ${repo}: ${redact(listed.stderr)}` };
  const remotes = lines(listed.stdout);
  if (remotes.length === 0) {
    const head = await g('local-head', ['rev-parse', '--verify', 'HEAD'], repo);
    if (!head.ok)
      return { error: `The repository ${repo} has no commit yet. Make a first commit there, then ask again.` };
    const branch = await g('local-branch', ['rev-parse', '--abbrev-ref', 'HEAD'], repo);
    const base = branch.ok && branch.stdout !== '' ? branch.stdout : 'HEAD';
    const binding = { repo, remote: null, remoteDisplay: null, repoSlug: null, base, baseSource: 'local' };
    return { binding, url: null, env: {}, sha: head.stdout };
  }

  let base;
  let baseSource;
  let remote;
  if ((await g('has-dev', ['show-ref', '--verify', '--quiet', 'refs/heads/dev'], repo)).ok) {
    base = 'dev';
    baseSource = 'dev';
    const configured = await g('dev-remote', ['config', '--get', 'branch.dev.remote'], repo);
    remote = pickRemote(remotes, configured.ok ? configured.stdout : undefined);
    if (remote === undefined)
      return {
        error: `The repository ${repo} has several remotes (${remotes.join(', ')}) and none is origin, so Genie cannot tell which one dev comes from. Run git config branch.dev.remote <remote> there, then ask again.`,
      };
  } else {
    remote = pickRemote(remotes, undefined);
    if (remote === undefined)
      return {
        error: `The repository ${repo} has several remotes (${remotes.join(', ')}), none is origin, and it has no dev branch. Run git remote rename <remote> origin for the one wishes start from, then ask again.`,
      };
    const head = await g('remote-head', ['symbolic-ref', '--quiet', `refs/remotes/${remote}/HEAD`], repo);
    const prefix = `refs/remotes/${remote}/`;
    if (!head.ok || !head.stdout.startsWith(prefix))
      return {
        error: `The repository ${repo} has no dev branch, and Genie does not know the default branch of its remote ${remote}. Run git remote set-head ${remote} --auto there, then ask again.`,
      };
    base = head.stdout.slice(prefix.length);
    baseSource = 'remote-head';
  }

  const got = await g('remote-url', ['remote', 'get-url', remote], repo);
  if (!got.ok || got.stdout === '')
    return {
      error: `The remote ${remote} of ${repo} has no URL. Run git remote set-url ${remote} <url> there, then ask again.`,
    };
  const url = got.stdout;
  const ssh = await g('ssh-command', ['config', '--get', 'core.sshCommand'], repo);
  const env = hostGitEnv(process.env, { sshCommandSet: ssh.ok && ssh.stdout !== '' });
  const binding = { repo, remote, remoteDisplay: remoteDisplay(url), repoSlug: repoSlugOf(url), base, baseSource };
  return { binding, url, env };
}

/**
 * The commit the binding's base has upstream right now: `{ sha }` or `{ error }`. One fetch in
 * the user's repository, then one read of FETCH_HEAD; the remote-tracking ref is never read,
 * so a single-branch or narrow-refspec repository cannot hand back a stale or missing tip.
 * A failed fetch refuses the wish; it never falls back to local HEAD.
 */
export async function fetchBase({ binding, url }, g) {
  const { repo, remote, base } = binding;
  const where = `${remote} (${binding.remoteDisplay})`;
  const fetched = await g(
    'fetch-base',
    ['fetch', '--quiet', '--no-tags', '--recurse-submodules=no', remote, `refs/heads/${base}`],
    repo,
  );
  if (!fetched.ok) {
    if (/couldn't find remote ref/i.test(fetched.stderr))
      return {
        error: `The remote ${where} has no branch ${base}, which wishes start from. Push it there (git push ${remote} ${base}), then ask again.`,
      };
    const said = redact(fetched.stderr).split('\n')[0] || `git fetch exited ${fetched.code}`;
    return {
      error: `Genie could not fetch ${base} from ${where}: ${said}. Run git fetch ${remote} ${base} in ${repo}, then ask again.`,
    };
  }
  const path = await g('fetch-head-path', ['rev-parse', '--git-path', 'FETCH_HEAD'], repo);
  let text = '';
  try {
    text = readFileSync(resolve(repo, path.stdout), 'utf8');
  } catch {
    /* an unreadable FETCH_HEAD holds no line, and refuses below */
  }
  const line = baseFromFetchHead(text, { base, url });
  if (line.error !== undefined)
    return {
      error: `Another fetch in ${repo} wrote FETCH_HEAD while Genie read the fresh ${base} (${line.error}), so the wish did not start from a commit Genie could not vouch for. Ask again.`,
    };
  const peeled = await g('peel-base', ['rev-parse', '--verify', '--quiet', `${line.sha}^{commit}`], repo);
  if (!peeled.ok)
    return { error: `The fetched ${base} (${line.sha.slice(0, 12)}) is not a commit in ${repo}. Ask again.` };
  return { sha: peeled.stdout };
}
