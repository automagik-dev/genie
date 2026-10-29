// The foundations a wish stands on (DESIGN genie-v7-foundations, T1–T7), with real git: a bare
// `upstream.git` in a temporary folder is the remote, a clone of it is the user's checkout,
// and the plugin runs against the stand-in team (test/team.js).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import {
  baseFromFetchHead,
  fetchBase,
  fetchHeadUrl,
  hostGitEnv,
  parseFetchHeadLine,
  remoteDisplay,
  repoSlugOf,
  resolveBinding,
} from '../src/host/binding.js';
import { GENIE_KIND } from '../src/host/genie.js';
import { NO_PUSH_URL, gitRunner } from '../src/host/git.js';
import { publishAllowed } from '../src/host/wishes.js';
import { compose, fakeTeam, gitIn, grant, savedWishes, until } from './team.js';

const GENIE_CLI = join(import.meta.dirname, '..', '..', '..', 'src', 'genie.ts');

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genie-dsh-foundations-'));
  process.env.GENIE_WISHES_DIR = join(dir, 'wishes');
});
afterEach(() => {
  Reflect.deleteProperty(process.env, 'GENIE_WISHES_DIR');
  rmSync(dir, { recursive: true, force: true });
});

const commit = (cwd, message, file = 'f.txt') => {
  writeFileSync(join(cwd, file), message);
  gitIn(cwd, 'add', '-A');
  gitIn(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', message);
  return gitIn(cwd, 'rev-parse', 'HEAD');
};

// A bare upstream.git whose HEAD names `head`, holding `branches` at one first commit, and the
// working copy (`seed`) that pushes to it.
function upstream({ head = 'dev', branches = ['dev'] } = {}) {
  const bare = join(dir, 'upstream.git');
  gitIn(dir, 'init', '-q', '--bare', bare);
  const seed = join(dir, 'seed');
  gitIn(dir, 'init', '-q', '-b', branches[0], seed);
  commit(seed, 'first');
  for (const branch of branches.slice(1)) gitIn(seed, 'branch', branch);
  for (const branch of branches) gitIn(seed, 'push', '-q', bare, branch);
  gitIn(bare, 'symbolic-ref', 'HEAD', `refs/heads/${head}`);
  return { bare, seed };
}
const cloneOf = (bare, name, ...args) => {
  const path = join(dir, name);
  gitIn(dir, 'clone', '-q', ...args, bare, path);
  return path;
};
// The seed moves `branch` upstream by one commit; its new tip.
const advance = ({ seed, bare }, branch = 'dev') => {
  gitIn(seed, 'switch', '-q', branch);
  const tip = commit(seed, `upstream moved ${branch}`, 'up.txt');
  gitIn(seed, 'push', '-q', bare, branch);
  return tip;
};
const localRepo = (name = 'app', branch = 'main') => {
  const path = join(dir, name);
  mkdirSync(path);
  gitIn(path, 'init', '-q', '-b', branch);
  commit(path, 'first');
  return path;
};
const genieIn = (repo, options = {}) =>
  fakeTeam(dir, { bots: { g: { id: 'g', name: 'Genie', kind: GENIE_KIND, workDir: repo } }, ...options });
const wishFolder = (repo, slug) => join(dir, 'wishes', basename(repo), slug);
const settled = (team, slug) =>
  until(
    () => savedWishes(team).find((wish) => wish.slug === slug && wish.state !== undefined && wish.state !== 'working'),
    `${slug} to settle`,
  );
const stepsOf = (wish, step) => wish.evidence.commands.filter((command) => command.step === step);
const hasBranch = (repo, branch) => gitIn(repo, 'branch', '--list', branch) !== '';
const failsIn = (cwd, ...args) => {
  try {
    execFileSync('git', args, { cwd, stdio: 'pipe' });
    return false;
  } catch {
    return true;
  }
};

// ---- T1 fresh base ----

test('T1: the wish starts from the upstream tip, not the stale local dev, and the checkout is untouched', async () => {
  const up = upstream();
  const repo = cloneOf(up.bare, 'app');
  const stale = gitIn(repo, 'rev-parse', 'dev');
  const tip = advance(up);
  assert.notEqual(tip, stale);
  // The user's own work in progress: a staged file and an unstaged edit.
  writeFileSync(join(repo, 'staged.txt'), 'staged');
  gitIn(repo, 'add', 'staged.txt');
  writeFileSync(join(repo, 'f.txt'), 'unstaged edit');
  const before = {
    branch: gitIn(repo, 'symbolic-ref', 'HEAD'),
    head: gitIn(repo, 'rev-parse', 'HEAD'),
    index: gitIn(repo, 'ls-files', '--stage'),
    status: gitIn(repo, 'status', '--porcelain=v1'),
    file: readFileSync(join(repo, 'f.txt'), 'utf8'),
    localDev: gitIn(repo, 'rev-parse', 'refs/heads/dev'),
  };

  const team = genieIn(repo);
  const { rt, tools } = compose(team);
  await rt.genieReady;
  assert.match(await grant(tools, 'g', { title: 'Fresh', wish: 'w' }), /granted/);
  const folder = wishFolder(repo, 'fresh');
  assert.equal(gitIn(folder, 'rev-parse', 'HEAD'), tip);
  const [wish] = savedWishes(team);
  assert.equal(wish.v, 2);
  assert.equal(wish.baseSha, tip);
  assert.equal(wish.evidence.baseSha, tip);
  assert.deepEqual(wish.binding, {
    repo: realpathSync(repo),
    remote: 'origin',
    remoteDisplay: gitIn(repo, 'remote', 'get-url', 'origin'),
    repoSlug: null,
    base: 'dev',
    baseSource: 'dev',
  });
  assert.equal(stepsOf(wish, 'fetch-base')[0].code, 0);
  assert.deepEqual(stepsOf(wish, 'fetch-base')[0].argv.slice(1, 5), [
    'fetch',
    '--quiet',
    '--no-tags',
    '--recurse-submodules=no',
  ]);
  assert.match(team.record.tasks[0].text, new RegExp(`made from ${tip.slice(0, 12)}`));
  // The checkout: branch, HEAD, index and working tree as they were; local dev not moved.
  assert.deepEqual(
    {
      branch: gitIn(repo, 'symbolic-ref', 'HEAD'),
      head: gitIn(repo, 'rev-parse', 'HEAD'),
      index: gitIn(repo, 'ls-files', '--stage'),
      status: gitIn(repo, 'status', '--porcelain=v1'),
      file: readFileSync(join(repo, 'f.txt'), 'utf8'),
      localDev: gitIn(repo, 'rev-parse', 'refs/heads/dev'),
    },
    before,
  );
});

test('T1: a single-branch clone whose refspec does not cover dev still starts from the upstream tip', async () => {
  const up = upstream({ branches: ['dev', 'feature'] });
  const repo = cloneOf(up.bare, 'narrow', '--single-branch', '--branch', 'feature');
  gitIn(repo, 'switch', '-q', '-c', 'dev');
  const tip = advance(up);
  assert.equal(
    gitIn(repo, 'config', '--get-all', 'remote.origin.fetch'),
    '+refs/heads/feature:refs/remotes/origin/feature',
  );
  const team = genieIn(repo);
  const { rt, tools } = compose(team);
  await rt.genieReady;
  assert.match(await grant(tools, 'g', { title: 'Narrow', wish: 'w' }), /granted/);
  assert.equal(gitIn(wishFolder(repo, 'narrow'), 'rev-parse', 'HEAD'), tip);
  assert.equal(savedWishes(team)[0].baseSha, tip);
  // The remote-tracking ref was never the source: there is none for dev.
  assert.ok(failsIn(repo, 'rev-parse', '--verify', '--quiet', 'refs/remotes/origin/dev'));
});

test('T1: a FETCH_HEAD another fetch overwrote, or one for another branch, refuses the wish', async () => {
  const up = upstream({ branches: ['dev', 'feature'] });
  const repo = cloneOf(up.bare, 'app');
  const plain = gitRunner();
  const bound = await resolveBinding(repo, plain);
  // A concurrent fetch lands between Genie's fetch and its read of FETCH_HEAD.
  const racing = async (step, args, cwd) => {
    const result = await plain(step, args, cwd);
    if (step === 'fetch-base') gitIn(repo, 'fetch', '-q', 'origin', 'refs/heads/feature');
    return result;
  };
  const raced = await fetchBase(bound, racing);
  assert.match(raced.error, /Another fetch in .* wrote FETCH_HEAD/);
  assert.match(raced.error, /branch feature, not branch dev/);
  // Two at once (`git fetch origin dev feature` writes two lines).
  const both = async (step, args, cwd) => {
    const result = await plain(step, args, cwd);
    if (step === 'fetch-base') gitIn(repo, 'fetch', '-q', 'origin', 'refs/heads/dev', 'refs/heads/feature');
    return result;
  };
  assert.match((await fetchBase(bound, both)).error, /2 lines/);
  // Untouched, the same fetch gives the tip.
  assert.equal((await fetchBase(bound, plain)).sha, gitIn(up.bare, 'rev-parse', 'dev'));

  // A URL written with a trailing slash: FETCH_HEAD drops it and the .git, and the grant
  // still compares equal, end to end.
  gitIn(repo, 'config', 'remote.origin.url', `${up.bare}/`);
  const tip = advance(up);
  const team = genieIn(repo);
  const { rt, tools } = compose(team);
  await rt.genieReady;
  assert.match(await grant(tools, 'g', { title: 'Slash', wish: 'w' }), /granted/);
  assert.equal(savedWishes(team)[0].baseSha, tip);
});

test('T1/NEW-M1: FETCH_HEAD lines parse, and URLs compare in the form git writes them', () => {
  const sha = 'b'.repeat(40);
  for (const [url, written] of [
    ['https://user:secret@github.com/o/r.git', 'https://github.com/o/r'],
    ['https://secret@github.com/o/r.git/', 'https://github.com/o/r'],
    ['ssh://git@github.com/o/r.git', 'ssh://github.com/o/r'],
    ['git@github.com:o/r.git', 'github.com:o/r'],
    ['/tmp/x/upstream.git', '/tmp/x/upstream'],
    ['/tmp/x/upstream.git/', '/tmp/x/upstream'],
    ['../up@stream.git', '../up@stream'],
  ]) {
    assert.equal(fetchHeadUrl(url), written, url);
    assert.equal(fetchHeadUrl(written), written, `${url}: applying it twice changes nothing`);
    const line = `${sha}\t\tbranch 'dev' of ${written}`;
    assert.deepEqual(parseFetchHeadLine(line), { sha, forMerge: true, kind: 'branch', name: 'dev', url: written });
    assert.deepEqual(baseFromFetchHead(`${line}\n`, { base: 'dev', url }), { sha }, url);
  }
  assert.deepEqual(parseFetchHeadLine(`${sha}\tnot-for-merge\ttag 'v1' of host:o/r`), {
    sha,
    forMerge: false,
    kind: 'tag',
    name: 'v1',
    url: 'host:o/r',
  });
  assert.equal(parseFetchHeadLine('not a line'), null);
  assert.match(baseFromFetchHead('', { base: 'dev', url: '/x' }).error, /0 lines/);
  assert.match(
    baseFromFetchHead(`${sha}\t\tbranch 'dev' of /elsewhere`, { base: 'dev', url: '/x/upstream.git' }).error,
    /not the remote/,
  );
});

test('T1/NEW-M1: the real FETCH_HEAD of a fetch from upstream.git names it without .git', async () => {
  const up = upstream();
  const repo = cloneOf(up.bare, 'app');
  const bound = await resolveBinding(repo, gitRunner());
  assert.equal((await fetchBase(bound, gitRunner())).sha, gitIn(up.bare, 'rev-parse', 'dev'));
  const written = readFileSync(join(repo, '.git', 'FETCH_HEAD'), 'utf8').trim();
  assert.equal(parseFetchHeadLine(written).url, up.bare.slice(0, -'.git'.length));
});

// ---- T2 remotes and credentials ----

test('T2: http(s) userinfo is dropped, ssh and scp users are kept, and all name o/r', () => {
  assert.equal(remoteDisplay('https://user:token@host/o/r.git'), 'https://host/o/r.git');
  assert.equal(remoteDisplay('https://token@host/o/r.git'), 'https://host/o/r.git');
  assert.equal(remoteDisplay('ssh://git@host/o/r.git'), 'ssh://git@host/o/r.git');
  assert.equal(remoteDisplay('git@host:o/r.git'), 'git@host:o/r.git');
  for (const url of [
    'https://user:token@host/o/r.git',
    'ssh://git@host/o/r.git',
    'git@host:o/r.git',
    'https://host/o/r',
  ])
    assert.equal(repoSlugOf(url), 'o/r', url);
  assert.equal(repoSlugOf('ssh://git@host:2222/o/r.git'), 'o/r');
  assert.equal(repoSlugOf('/tmp/x/upstream.git'), null);
});

test('T2: the remote configuration is byte-identical after a wish, and no secret reaches genie.json or the model', async () => {
  const up = upstream();
  const repo = cloneOf(up.bare, 'app');
  // The user's remote carries a credential in its URL; git reaches the fixture through insteadOf.
  const secretUrl = 'https://user:ghp_FAKEtoken@example.invalid/o/r.git';
  gitIn(repo, 'remote', 'set-url', 'origin', secretUrl);
  gitIn(repo, 'config', `url.${up.bare}.insteadOf`, secretUrl);
  const config = readFileSync(join(repo, '.git', 'config'));
  const tip = advance(up);
  const team = genieIn(repo);
  const { rt, tools, turnEnd } = compose(team);
  await rt.genieReady;
  const answer = await grant(tools, 'g', { title: 'Secret', wish: 'w' });
  assert.match(answer, /granted/);
  const folder = wishFolder(repo, 'secret');
  assert.equal(gitIn(folder, 'rev-parse', 'HEAD'), tip);
  commit(folder, 'work');
  turnEnd('session-1');
  await settled(team, 'secret');
  assert.deepEqual(readFileSync(join(repo, '.git', 'config')), config);
  for (const text of [
    answer,
    team.record.tasks[0].text,
    readFileSync(join(team.home, 'genie.json'), 'utf8'),
    readFileSync(join(folder, '.git', 'config'), 'utf8'),
  ]) {
    assert.ok(!text.includes('ghp_FAKE'), text);
    assert.ok(!text.includes('token'), text);
  }
});

test('T2: a failing fetch from a URL with a credential is refused without the credential in any word', async () => {
  for (const url of ['https://user:ghp_FAKEtoken@127.0.0.1:1/o/r.git', 'https://ghp_FAKEtoken@127.0.0.1:1/o/r.git']) {
    rmSync(join(dir, 'app'), { recursive: true, force: true });
    const repo = localRepo('app', 'dev');
    gitIn(repo, 'remote', 'add', 'origin', url);
    const team = genieIn(repo);
    const { rt, tools } = compose(team);
    await rt.genieReady;
    const answer = await grant(tools, 'g', { title: 'Offline', wish: 'w' });
    assert.match(
      answer,
      /^The wish did not start: Genie could not fetch dev from origin \(https:\/\/127\.0\.0\.1:1\/o\/r\.git\)/,
    );
    assert.match(answer, /Run git fetch origin dev in .*, then ask again\./);
    assert.ok(!answer.includes('ghp_FAKE') && !answer.includes('token'), answer);
    const saved = existsSync(join(team.home, 'genie.json')) ? readFileSync(join(team.home, 'genie.json'), 'utf8') : '';
    assert.ok(!saved.includes('ghp_FAKE') && !saved.includes('token'));
    assert.equal(team.record.tasks.length, 0);
  }
});

// ---- T3 branch policy ----

const cliBranch = (repo) =>
  JSON.parse(
    execFileSync('bun', [GENIE_CLI, 'context', '--plan'], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, GENIE_HOME: join(dir, 'genie-home') },
    }),
  ).branch;

test('T3: local dev, else the remote default branch, else local — and the CLI agrees where it can', async () => {
  const up = upstream({ head: 'main', branches: ['main', 'dev'] });
  const withDev = cloneOf(up.bare, 'with-dev');
  gitIn(withDev, 'switch', '-q', 'dev');
  const viaHead = cloneOf(up.bare, 'via-head');
  assert.ok(failsIn(viaHead, 'show-ref', '--verify', '--quiet', 'refs/heads/dev'));
  const alone = localRepo('alone', 'trunk');

  const a = (await resolveBinding(withDev, gitRunner())).binding;
  assert.deepEqual([a.base, a.baseSource, a.remote], ['dev', 'dev', 'origin']);
  assert.equal(cliBranch(withDev), a.base);
  const b = (await resolveBinding(viaHead, gitRunner())).binding;
  assert.deepEqual([b.base, b.baseSource, b.remote], ['main', 'remote-head', 'origin']);
  assert.equal(cliBranch(viaHead), b.base);
  const c = await resolveBinding(alone, gitRunner());
  assert.deepEqual([c.binding.base, c.binding.baseSource, c.binding.remote], ['trunk', 'local', null]);
  assert.equal(c.sha, gitIn(alone, 'rev-parse', 'HEAD'));
});

test('T3/NEW-L3: the remote is branch.<base>.remote, else origin, else the only one; no default branch is refused', async () => {
  const up = upstream();
  const repo = cloneOf(up.bare, 'app');
  gitIn(repo, 'remote', 'add', 'fork', up.bare);
  gitIn(repo, 'config', 'branch.dev.remote', 'fork');
  assert.equal((await resolveBinding(repo, gitRunner())).binding.remote, 'fork');
  gitIn(repo, 'config', '--unset', 'branch.dev.remote');
  assert.equal((await resolveBinding(repo, gitRunner())).binding.remote, 'origin');
  gitIn(repo, 'remote', 'rename', 'origin', 'upstream');
  assert.match(
    (await resolveBinding(repo, gitRunner())).error,
    /none is origin.*git config branch\.dev\.remote <remote>/,
  );
  gitIn(repo, 'remote', 'remove', 'fork');
  assert.equal((await resolveBinding(repo, gitRunner())).binding.remote, 'upstream');

  // A remote that names no default branch, and no local dev.
  const bare = localRepo('bare-ish', 'main');
  gitIn(bare, 'remote', 'add', 'origin', up.bare);
  const refused = await resolveBinding(bare, gitRunner());
  assert.match(refused.error, /has no dev branch, and Genie does not know the default branch of its remote origin/);
  assert.match(refused.error, /git remote set-head origin --auto/);
  const team = genieIn(bare);
  const { rt, tools } = compose(team);
  await rt.genieReady;
  assert.match(await grant(tools, 'g', { title: 'x', wish: 'y' }), /git remote set-head origin --auto/);
  assert.equal(team.record.tasks.length, 0);
});

test('T3: the user’s own ssh setup wins, and a base the remote lacks is refused with its fix', async () => {
  const saved = { GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND, GIT_SSH: process.env.GIT_SSH };
  Reflect.deleteProperty(process.env, 'GIT_SSH_COMMAND');
  Reflect.deleteProperty(process.env, 'GIT_SSH');
  try {
    assert.deepEqual(hostGitEnv({}), { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes', GCM_INTERACTIVE: 'never' });
    assert.deepEqual(hostGitEnv({}, { sshCommandSet: true }), { GCM_INTERACTIVE: 'never' });
    assert.deepEqual(hostGitEnv({ GIT_SSH: 'plink', GCM_INTERACTIVE: 'always' }), {});
    assert.deepEqual(hostGitEnv({ GIT_SSH_COMMAND: 'ssh -i k' }), { GCM_INTERACTIVE: 'never' });

    const up = upstream({ head: 'main', branches: ['main'] });
    const repo = cloneOf(up.bare, 'app');
    assert.equal((await resolveBinding(repo, gitRunner())).env.GIT_SSH_COMMAND, 'ssh -o BatchMode=yes');
    gitIn(repo, 'config', 'core.sshCommand', 'ssh -i my-own-key');
    assert.equal((await resolveBinding(repo, gitRunner())).env.GIT_SSH_COMMAND, undefined);
    assert.equal(gitIn(repo, 'config', 'core.sshCommand'), 'ssh -i my-own-key');

    // A local dev the remote does not have.
    gitIn(repo, 'branch', 'dev');
    const team = genieIn(repo);
    const { rt, tools } = compose(team);
    await rt.genieReady;
    const answer = await grant(tools, 'g', { title: 'x', wish: 'y' });
    assert.match(
      answer,
      /The remote origin \(.*\) has no branch dev, which wishes start from\. Push it there \(git push origin dev\)/,
    );
    assert.equal(team.record.tasks.length, 0);
  } finally {
    for (const [key, value] of Object.entries(saved)) if (value !== undefined) process.env[key] = value;
  }
});

// ---- T4 local mode ----

test('T4: a repository with no remote runs from local HEAD, never past local-only, and cannot publish', async () => {
  const repo = localRepo('app', 'main');
  const head = gitIn(repo, 'rev-parse', 'HEAD');
  const team = genieIn(repo);
  const { rt, tools, turnEnd } = compose(team);
  await rt.genieReady;
  await grant(tools, 'g', { title: 'Local', wish: 'w' });
  const [wish] = savedWishes(team);
  assert.equal(wish.binding.baseSource, 'local');
  assert.equal(wish.baseSha, head);
  assert.equal(stepsOf(wish, 'fetch-base').length, 0, 'nothing is fetched');
  commit(wishFolder(repo, 'local'), 'work');
  turnEnd('session-1');
  assert.equal((await settled(team, 'local')).state, 'local-only');
  const refusal = publishAllowed({ repoSlug: 'o/r', base: 'main' }, wish.binding);
  assert.equal(refusal.ok, false);
  assert.match(refusal.reason, /no remote.*git remote add origin <url>/);
});

// ---- T5 reconciliation ----

// A granted plain wish on a remote-bound repository, with one commit in its copy, saved as working.
async function workingWish({ commits = 1 } = {}) {
  const up = upstream();
  const repo = cloneOf(up.bare, 'app');
  const first = genieIn(repo);
  const { rt, tools } = compose(first);
  await rt.genieReady;
  await grant(tools, 'g', { title: 'Work', wish: 'w' });
  const folder = wishFolder(repo, 'work');
  for (let i = 0; i < commits; i++) commit(folder, `work ${i}`);
  assert.equal(savedWishes(first)[0].state, 'working');
  return { up, repo, folder };
}
const done = (status = 'done') => ({ 'session-1': { status } });
const resumed = () => Promise.resolve({ resumed: [], resent: [] });
const restart = (repo, options) => {
  const team = genieIn(repo, options);
  return { team, ...compose(team) };
};

test('T5: a working wish whose task is done at startup transitions exactly once across two loads', async () => {
  const { repo } = await workingWish();
  const one = restart(repo, { tasks: done(), resumesDone: resumed() });
  await one.rt.genieReconciled;
  const after = savedWishes(one.team)[0];
  assert.equal(after.state, 'local-only');
  assert.equal(stepsOf(after, 'wish-head').length, 1);
  assert.ok(hasBranch(repo, 'wish/work'));
  const text = readFileSync(join(one.team.home, 'genie.json'), 'utf8');
  const two = restart(repo, { tasks: done(), resumesDone: resumed() });
  await two.rt.genieReconciled;
  assert.equal(readFileSync(join(two.team.home, 'genie.json'), 'utf8'), text, 'the second load changes nothing');
});

test('T5: a working task stays working, and a missing one is lost only on a writable host that read its tasks', async () => {
  const { repo, folder } = await workingWish();
  const text = () => readFileSync(join(dir, 'home', 'genie.json'), 'utf8');
  const before = text();
  for (const options of [
    { tasks: done('working'), resumesDone: resumed() },
    { tasks: {}, resumesDone: resumed(), readOnly: 'open in another dsh' },
    { tasks: {}, resumesDone: Promise.resolve({ readOnly: 'held', resumed: [], resent: [] }) },
    { tasks: {}, resumesDone: Promise.resolve({ failed: 'disk gone', resumed: [], resent: [] }) },
    { resumesDone: resumed() },
    { tasks: {} },
  ]) {
    const again = restart(repo, options);
    await again.rt.genieReconciled;
    assert.equal(text(), before, JSON.stringify(options));
  }
  const lost = restart(repo, { tasks: {}, resumesDone: resumed() });
  await lost.rt.genieReconciled;
  const wish = savedWishes(lost.team)[0];
  assert.equal(wish.state, 'lost');
  // Lost keeps the branch and the evidence; the work was fetched back, since it is ahead.
  assert.ok(existsSync(folder));
  assert.equal(wish.evidence.ahead, 1);
  assert.ok(hasBranch(repo, 'wish/work'));
  // A task trimmed from the team's records can still be running: its live end settles it.
  lost.turnEnd('session-1');
  assert.equal(
    (await until(() => savedWishes(lost.team).find((w) => w.state !== 'lost'), 'lost to settle')).state,
    'local-only',
  );
});

test('T5: a live turn end that races the startup pass transitions once', async () => {
  const { repo } = await workingWish();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const raced = restart(repo, { tasks: done(), resumesDone: gate });
  raced.turnEnd('session-1');
  release({ resumed: [], resent: [] });
  await raced.rt.genieReconciled;
  const wish = await settled(raced.team, 'work');
  assert.equal(wish.state, 'local-only');
  assert.equal(stepsOf(wish, 'wish-head').length, 1);
  assert.equal(stepsOf(wish, 'fetch-back').length, 1);
});

test('T5: a turn end a restart cut changes nothing', async () => {
  const { repo } = await workingWish();
  const before = readFileSync(join(dir, 'home', 'genie.json'), 'utf8');
  const team = genieIn(repo);
  team.cutByRestart = (reason) => reason?.kind === 'interrupted';
  const { rt, turnEnd } = compose(team);
  await rt.genieReady;
  turnEnd('session-1', { kind: 'interrupted' });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(readFileSync(join(dir, 'home', 'genie.json'), 'utf8'), before);
  assert.equal(hasBranch(repo, 'wish/work'), false);
});

test('T5: a task whose first turn ended before the entry was saved is settled right after the save', async () => {
  const repo = localRepo('app', 'main');
  // The team's record says done as the task starts: no turn end will reach this plugin.
  const team = genieIn(repo, {
    tasks: {},
    onTask: (sessionId, state) => {
      state.tasks[sessionId] = { status: 'done' };
    },
  });
  const { rt, tools } = compose(team);
  await rt.genieReady;
  await grant(tools, 'g', { title: 'Quick', wish: 'w' });
  assert.equal((await settled(team, 'quick')).state, 'no-change');
});

// ---- T6 honest outcomes ----

test('T6: done with commits is a local branch, fetched back; done with none is no change, and nothing is fetched', async () => {
  const repo = localRepo('app', 'main');
  const team = genieIn(repo);
  const { rt, tools, turnEnd } = compose(team);
  await rt.genieReady;
  await grant(tools, 'g', { title: 'Some', wish: 'w' });
  await grant(tools, 'g', { title: 'None', wish: 'w' });
  commit(wishFolder(repo, 'some'), 'work');
  turnEnd('session-1');
  turnEnd('session-2');
  const some = await settled(team, 'some');
  const none = await settled(team, 'none');
  assert.equal(some.state, 'local-only');
  assert.equal(some.evidence.ahead, 1);
  assert.equal(some.evidence.headSha, gitIn(repo, 'rev-parse', 'wish/some'));
  assert.equal(none.state, 'no-change');
  assert.equal(none.evidence.ahead, 0);
  assert.equal(stepsOf(none, 'fetch-back').length, 0);
  assert.equal(hasBranch(repo, 'wish/none'), false);
  // The view carries the state, which the row shows instead of the task status.
  assert.deepEqual(
    team.record.views[0]().genie.wishes.map((wish) => [wish.slug, wish.state]),
    [
      ['none', 'no-change'],
      ['some', 'local-only'],
    ],
  );
});

test('T6: stopped or failed keep their word and their commits are fetched back; a blocked end is no end', async () => {
  const repo = localRepo('app', 'main');
  const team = genieIn(repo);
  const { rt, tools, turnEnd } = compose(team);
  await rt.genieReady;
  for (const title of ['Stop', 'Fail', 'Block']) {
    await grant(tools, 'g', { title, wish: 'w' });
    commit(wishFolder(repo, title.toLowerCase()), 'work');
  }
  turnEnd('session-1', { kind: 'aborted' });
  turnEnd('session-2', { kind: 'error', error: { message: 'boom' } });
  turnEnd('session-3', { kind: 'blocked' });
  assert.equal((await settled(team, 'stop')).state, 'stopped');
  assert.equal((await settled(team, 'fail')).state, 'failed');
  assert.ok(hasBranch(repo, 'wish/stop') && hasBranch(repo, 'wish/fail'));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(savedWishes(team).find((wish) => wish.slug === 'block').state, 'working');
  assert.equal(hasBranch(repo, 'wish/block'), false);
});

// A repository with a remote and an earlier wish's branch, for scoped follow-ups.
function scopedRepo() {
  const up = upstream();
  const repo = cloneOf(up.bare, 'app');
  gitIn(repo, 'branch', 'wish/earlier');
  return { up, repo };
}

test('T6/NEW-L1: a scoped follow-up with no change still fetches its given branch back, and says so in evidence', async () => {
  const { repo } = scopedRepo();
  const team = genieIn(repo);
  const { rt, tools, turnEnd } = compose(team);
  await rt.genieReady;
  await grant(tools, 'g', { title: 'Look', wish: 'w', branches: ['wish/earlier'] });
  const [granted] = savedWishes(team);
  assert.deepEqual(granted.starts, { 'wish/earlier': gitIn(repo, 'rev-parse', 'wish/earlier') });
  turnEnd('session-1');
  const wish = await settled(team, 'look');
  assert.equal(wish.state, 'no-change', 'no branch moved');
  const fetched = stepsOf(wish, 'fetch-back');
  assert.equal(fetched.length, 1, 'the given branch was fetched back');
  assert.equal(fetched[0].code, 0);
  assert.equal(wish.evidence.given['wish/earlier'].moved, false);
  assert.equal(wish.evidence.given['wish/earlier'].fetch, 0);
});

test('T6/NEW-L4: a v1 entry still running at upgrade is settled from its recorded base; its given branch moved when the fetch moved it', async () => {
  const { repo } = scopedRepo();
  const base = gitIn(repo, 'rev-parse', 'HEAD');
  // A copy as a v1 grant made it: no starts, no state, no evidence.
  const folder = wishFolder(repo, 'old');
  mkdirSync(join(dir, 'wishes', 'app'), { recursive: true });
  gitIn(dir, 'clone', '-q', '--local', repo, folder);
  gitIn(folder, 'switch', '-q', '-c', 'wish/old');
  gitIn(folder, 'branch', 'wish/earlier', 'origin/wish/earlier');
  gitIn(folder, 'switch', '-q', 'wish/earlier');
  commit(folder, 'repair');
  gitIn(folder, 'switch', '-q', 'wish/old');
  const v1 = {
    slug: 'old',
    title: 'Old',
    branch: 'wish/old',
    branches: ['wish/earlier'],
    folder,
    repo,
    base,
    sessionId: 'session-old',
    botId: 'g',
    at: 1,
  };
  const team = genieIn(repo);
  writeFileSync(join(team.home, 'genie.json'), JSON.stringify({ genieCreated: true, wishes: [v1] }));
  const { rt, turnEnd } = compose(team);
  await rt.genieReady;
  turnEnd('session-old');
  const wish = await settled(team, 'old');
  assert.equal(wish.state, 'local-only');
  assert.equal(wish.evidence.baseSha, base);
  assert.equal(wish.evidence.ahead, 0);
  assert.equal(wish.evidence.given['wish/earlier'].moved, true);
  assert.equal(gitIn(repo, 'log', '-1', '--format=%s', 'wish/earlier'), 'repair');
  assert.equal(hasBranch(repo, 'wish/old'), false, 'the wish branch is not ahead, so it stays in the copy');
});

// ---- T7 publication boundary ----

test('T7: a plain wish’s copy has no push route by default, though a hand-spelled path still pushes', async () => {
  const up = upstream();
  const repo = cloneOf(up.bare, 'app');
  const team = genieIn(repo);
  const { rt, tools } = compose(team);
  await rt.genieReady;
  await grant(tools, 'g', { title: 'Plain', wish: 'w' });
  const folder = wishFolder(repo, 'plain');
  commit(folder, 'work');
  assert.ok(failsIn(folder, 'push', 'origin', 'wish/plain'));
  assert.equal(hasBranch(repo, 'wish/plain'), false);
  assert.equal(gitIn(folder, 'config', '--local', 'remote.origin.pushurl'), NO_PUSH_URL);
  assert.equal(gitIn(folder, 'config', '--local', '--get-all', 'credential.helper'), '');
  assert.ok(!gitIn(folder, 'remote').split('\n').includes('publish'));
  // The lockout removes the default routes; DSH's sandbox, not this, stops a spelled-out URL.
  gitIn(folder, 'push', '-q', up.bare, 'wish/plain');
  assert.equal(gitIn(up.bare, 'log', '-1', '--format=%s', 'wish/plain'), 'work');
});

test('T7: a scoped follow-up keeps publish and its #3184 brief; credentials in its URL or the base branch refuse it', async () => {
  const { up, repo } = scopedRepo();
  const team = genieIn(repo);
  const { rt, tools } = compose(team);
  await rt.genieReady;
  await grant(tools, 'g', { title: 'Scoped', wish: 'w', branches: ['wish/earlier'] });
  const folder = wishFolder(repo, 'scoped');
  assert.equal(gitIn(folder, 'remote', 'get-url', 'publish'), up.bare);
  assert.match(team.record.tasks[0].text, /git push publish <branch>/);
  assert.equal(gitIn(folder, 'config', '--local', 'remote.origin.pushurl'), NO_PUSH_URL);
  assert.ok(failsIn(folder, 'config', '--local', '--get-all', 'credential.helper'), "the user's helper is kept");

  // The branch wishes start from is never given, even when the checkout is elsewhere.
  gitIn(repo, 'switch', '-q', 'wish/earlier');
  assert.match(
    await grant(tools, 'g', { title: 'Base', wish: 'w', branches: ['dev'] }),
    /dev is the branch wishes start from/,
  );
  gitIn(repo, 'switch', '-q', 'dev');

  for (const url of ['https://user:ghp_FAKEtoken@127.0.0.1:1/o/r.git', 'https://ghp_FAKEtoken@127.0.0.1:1/o/r.git']) {
    gitIn(repo, 'remote', 'set-url', 'origin', url);
    const answer = await grant(tools, 'g', { title: 'Leaky', wish: 'w', branches: ['wish/earlier'] });
    assert.match(answer, /has a user name or password written into it/);
    assert.match(answer, /git remote set-url origin https:\/\/127\.0\.0\.1:1\/o\/r\.git/);
    assert.match(answer, /credential helper/);
    assert.ok(!answer.includes('ghp_FAKE'));
    assert.equal(existsSync(wishFolder(repo, 'leaky')), false, 'no copy, so no config to leak into');
    assert.ok(!readFileSync(join(team.home, 'genie.json'), 'utf8').includes('ghp_FAKE'));
  }
  assert.equal(team.record.tasks.length, 1);
  for (const name of readdirSync(join(dir, 'wishes', 'app')))
    assert.ok(!readFileSync(join(dir, 'wishes', 'app', name, '.git', 'config'), 'utf8').includes('ghp_FAKE'));
});

test('T7: publishAllowed refuses an absent grant, another repository or base, and a local binding, naming what to do', () => {
  const binding = {
    repo: '/x',
    remote: 'origin',
    remoteDisplay: 'https://host/o/r.git',
    repoSlug: 'o/r',
    base: 'dev',
    baseSource: 'dev',
  };
  assert.deepEqual(publishAllowed({ repoSlug: 'o/r', base: 'dev' }, binding), { ok: true });
  for (const [grantGiven, why] of [
    [undefined, /Publishing is not granted\. Grant publishing to o\/r into dev first\./],
    [null, /Publishing is not granted/],
    [{ repoSlug: 'o/other', base: 'dev' }, /for o\/other, not o\/r\. Grant publishing to o\/r into dev\./],
    [{ repoSlug: 'o/r', base: 'main' }, /into main, not dev\. Grant publishing to o\/r into dev\./],
  ]) {
    const answer = publishAllowed(grantGiven, binding);
    assert.equal(answer.ok, false);
    assert.match(answer.reason, why);
  }
  const local = { ...binding, remote: null, remoteDisplay: null, repoSlug: null, baseSource: 'local' };
  assert.match(publishAllowed({ repoSlug: 'o/r', base: 'dev' }, local).reason, /git remote add origin <url>/);
  assert.match(
    publishAllowed({ repoSlug: null, base: 'dev' }, { ...binding, repoSlug: null }).reason,
    /git remote set-url origin <url>/,
  );
});

test('T7: grant_wish exposes no argument that reaches a grant', async () => {
  const team = genieIn(localRepo());
  const { rt, tools } = compose(team);
  await rt.genieReady;
  assert.deepEqual(Object.keys(tools.get('grant_wish').parameters.properties), ['title', 'wish', 'branches']);
});
