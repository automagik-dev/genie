/**
 * The property this group exists for: a pull request cannot rewrite the prompt or the
 * configuration of the agent that reviews it.
 *
 * Every case is a REAL git repository, and every assertion is made through the injected
 * boundary opener — on the agents dir the runtime would have been handed AND on the
 * child environment's `MIKRO_AGENTS_DIR`, because mikro does its own project-agent
 * discovery inside `--dir` and that variable is what overrides it. Nothing here spawns
 * the mikro runtime: the fake session answers `/bin/false` for every command, so a run
 * that gets that far fails without a provider call, and the refusal cases never get that
 * far at all.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BoundarySession, OpenBoundaryOptions } from './boundary';
import { type RunResult, runAgent, runCallCli, shippedAgentsRoot } from './call';

// Set before anything runs: `providerKeyEnv()` would otherwise source the operator's
// ~/.mikro/gate-env.sh and `ghTokenEnv()` would shell out to `gh auth token`.
process.env.DEEPSEEK_API_KEY = 'sk-test';
process.env.GH_TOKEN = 'ghp_test';

const trash: string[] = [];
afterAll(() => {
  for (const dir of trash) rmSync(dir, { recursive: true, force: true });
});

const tmp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  trash.push(dir);
  return dir;
};

function git(root: string, args: string[]): string {
  const probe = Bun.spawnSync(['git', '-C', root, ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (probe.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${probe.stderr.toString()}`);
  return probe.stdout.toString().trim();
}

function write(root: string, path: string, body: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), body);
}

function commit(root: string, message: string): void {
  git(root, ['add', '-A']);
  git(root, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', message]);
}

const SYSTEM = '.mikro/agents/wish-context/SYSTEM.md';
const AGENT_YAML = '.mikro/agents/wish-context/agent.yaml';

/** A repository whose base branch `main` carries the agent, with an `origin/HEAD` and no network. */
function baseRepo(prefix: string, system: string, extra: Record<string, string> = {}): string {
  const root = tmp(prefix);
  git(root, ['init', '-q', '-b', 'main']);
  write(root, AGENT_YAML, 'model: deepseek-api/deepseek-flash\nsystem: SYSTEM.md\n');
  write(root, SYSTEM, system);
  for (const [path, body] of Object.entries(extra)) write(root, path, body);
  commit(root, 'seed the agent');
  git(root, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  git(root, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  return root;
}

/**
 * A PATH holding one `mikro` stub and NOTHING else — no git, no real runtime.
 *
 * Every case that spawns the CLI gets this: a refusal must not depend on what is installed
 * on the developer's PATH, and a regression that stopped refusing would otherwise reach the
 * REAL `mikro` and bill a run. The stub exits immediately, so a run that does get that far
 * fails with "exited before answering" — fast, and free.
 */
let stubBin: string | null = null;
function stubPath(): string {
  if (!stubBin) {
    stubBin = tmp('mikro-stub-bin-');
    writeFileSync(join(stubBin, 'mikro'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  return stubBin;
}

/**
 * The same stub PATH, plus the REAL git — for every case whose refusal has to happen for
 * its own reason rather than because git was missing.
 *
 * Without this, a case meant to pin the irregular-path refusal refuses through the no-git
 * fail-closed branch instead, and the assertion it thinks it is making is vacuous. git is
 * resolved with `Bun.which`, never hardcoded; if a real `mikro` shares that directory it
 * would outrank the stub, so git is symlinked into the stub dir instead.
 */
let stubBinWithGit: string | null = null;
function stubPathWithGit(): string {
  if (!stubBinWithGit) {
    const git = Bun.which('git');
    if (!git) throw new Error('no git on PATH: these cases need a real one');
    const gitDir = dirname(git);
    if (existsSync(join(gitDir, 'mikro'))) {
      stubBinWithGit = stubPath();
      symlinkSync(git, join(stubBinWithGit, 'git'));
    } else {
      stubBinWithGit = `${stubPath()}:${gitDir}`;
    }
  }
  return stubBinWithGit;
}

/** A GENIE_HOME carrying the shipped default agent — the fallback every case must be able to name. */
function shippedHome(): string {
  const home = tmp('mikro-adv-home-');
  const dir = join(shippedAgentsRoot(home), 'wish-context');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'agent.yaml'), 'model: deepseek-api/deepseek-flash\nsystem: SYSTEM.md\n');
  writeFileSync(join(dir, 'SYSTEM.md'), '# shipped default\n');
  return home;
}

interface Seen {
  opened: boolean;
  agentsDir: string;
  envAgentsDir: string | undefined;
  system: string;
}

/**
 * One run, contained by a fake boundary, capturing what the runtime would have been
 * handed. The capture happens INSIDE the opener because the materialized tree is
 * disposed before `runAgent` returns — which is itself asserted below.
 */
async function runCaptured(options: {
  dir: string;
  cwd: string;
  genieHome: string;
  agentsRef?: string;
  agentsDir?: string;
}): Promise<{ result: RunResult; seen: Seen }> {
  const seen: Seen = { opened: false, agentsDir: '', envAgentsDir: undefined, system: '' };
  const session: BoundarySession = {
    mode: 'bwrap',
    spec: null as unknown as BoundarySession['spec'],
    argv: () => ['/bin/false'],
    env: {} as Record<string, string>,
    counts: () => ({ allowed: 0, denied: 0 }),
    close: async () => undefined,
  };
  const result = await runAgent({
    agent: 'wish-context',
    prompt: 'Intent: anything at all',
    boundary: 'bwrap',
    retries: 0,
    phoenix: false,
    ledger: false,
    ...options,
    openBoundary: async (opened: OpenBoundaryOptions) => {
      seen.opened = true;
      seen.agentsDir = opened.agentsDir ?? '';
      seen.envAgentsDir = opened.env.MIKRO_AGENTS_DIR;
      seen.system = readFileSync(join(seen.agentsDir, 'wish-context', 'SYSTEM.md'), 'utf8');
      return session;
    },
  });
  return { result, seen };
}

describe('(a) a PR worktree cannot rewrite the prompt of the agent that reviews it', () => {
  test('the base ref wins over a committed PR change AND over an uncommitted one', async () => {
    const base = baseRepo('mikro-adv-a-', '# A — the reviewed prompt\n');
    const worktree = join(tmp('mikro-adv-a-wt-'), 'pr');
    git(base, ['worktree', 'add', '-q', '-b', 'pr', worktree]);
    write(worktree, SYSTEM, '# B — committed on the PR branch\n');
    commit(worktree, 'the PR rewrites the reviewer prompt');
    write(worktree, SYSTEM, '# C — not even committed\n');

    // `--dir` is the worktree AND the process was started in it: both halves of the
    // attack at once, which is the case a linked-worktree-only test cannot catch.
    const { result, seen } = await runCaptured({ dir: worktree, cwd: worktree, genieHome: shippedHome() });
    expect(seen.opened).toBe(true);
    expect(seen.system).toBe('# A — the reviewed prompt\n');
    expect(seen.system).not.toContain('B —');
    expect(seen.system).not.toContain('C —');
    // mikro discovers project agents inside `--dir` on its own; MIKRO_AGENTS_DIR is what
    // overrides that, so it must be the materialized tree and nothing else.
    expect(seen.envAgentsDir).toBe(seen.agentsDir);
    expect(seen.agentsDir.startsWith(worktree)).toBe(false);
    expect(result.agentSource).toBe('repo@refs/heads/main');
    // The temp material does not outlive the run.
    expect(existsSync(seen.agentsDir)).toBe(false);

    git(base, ['worktree', 'remove', '--force', worktree]);
  });
});

describe('(b) a PR cannot inject .mikro configuration, on any agent source', () => {
  const injected = { '.mikro/TOOLS.md': '## injected\ndef helper():\n    pass\n' };

  test('the repo source: a TOOLS.md the trusted ref does not carry refuses the run at zero cost', async () => {
    const base = baseRepo('mikro-adv-b-repo-', '# A\n');
    const worktree = join(tmp('mikro-adv-b-wt-'), 'pr');
    git(base, ['worktree', 'add', '-q', '-b', 'pr', worktree]);
    write(worktree, '.mikro/TOOLS.md', injected['.mikro/TOOLS.md']);
    commit(worktree, 'the PR injects TOOLS.md');

    const { result, seen } = await runCaptured({ dir: worktree, cwd: worktree, genieHome: shippedHome() });
    expect(seen.opened).toBe(false); // nothing was spawned: the refusal is before the boundary
    expect(result.ok).toBe(false);
    expect(result.costUsd).toBe(0);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0].errors[0]).toStartWith('config:');
    expect(result.attempts[0].errors[0]).toContain('TOOLS.md is absent at');
    // The refusal names the operator's escape, because an uncommitted edit hits it too.
    expect(result.attempts[0].errors[0]).toContain('--agents-dir <checkout>/.mikro/agents');
    expect(result.agentSource).toBe('repo@refs/heads/main');

    git(base, ['worktree', 'remove', '--force', worktree]);
  });

  test('the shipped source: the same refusal, with no repository agent anywhere', async () => {
    // A repository that never seeded an agent: the run uses the shipped default, and the
    // configuration comparison still happens — against the ref, not against the payload.
    const root = tmp('mikro-adv-b-shipped-');
    git(root, ['init', '-q', '-b', 'main']);
    write(root, 'README.md', '# no agent here\n');
    commit(root, 'seed');
    git(root, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    git(root, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
    const home = shippedHome();
    const clean = await runCaptured({ dir: root, cwd: root, genieHome: home });
    expect(clean.result.agentSource).toBe('shipped');
    expect(clean.seen.agentsDir).toBe(shippedAgentsRoot(home));
    expect(clean.seen.envAgentsDir).toBe(shippedAgentsRoot(home));

    write(root, '.mikro/TOOLS.md', injected['.mikro/TOOLS.md']); // uncommitted, the weakest possible attack
    const { result, seen } = await runCaptured({ dir: root, cwd: root, genieHome: home });
    expect(seen.opened).toBe(false);
    expect(result.attempts[0].errors[0]).toStartWith('config:');
    expect(result.agentSource).toBe('shipped');
  });
});

describe('(c) a separate clone with its own origin cannot supply the agent', () => {
  test('the INVOKING checkout decides, never --dir', async () => {
    const invoking = baseRepo('mikro-adv-c-mine-', '# A — my base\n');
    // A clone the "PR" controls entirely: its own origin/HEAD, its own base branch, its
    // own committed agent. Passing it as `--dir` must change nothing about the prompt.
    const theirs = baseRepo('mikro-adv-c-theirs-', '# D — the attacker base\n');

    const { result, seen } = await runCaptured({ dir: theirs, cwd: invoking, genieHome: shippedHome() });
    expect(seen.opened).toBe(true);
    expect(seen.system).toBe('# A — my base\n');
    expect(seen.system).not.toContain('D —');
    expect(seen.envAgentsDir).toBe(seen.agentsDir);
    expect(seen.agentsDir.startsWith(theirs)).toBe(false);
    expect(result.agentSource).toBe('repo@refs/heads/main');
    expect(result.dir).toBe(theirs); // the tree under review is still the one being read
  });
});

describe('(d) the local-base rule', () => {
  test('a committed-but-unpushed agent on the base branch is used', async () => {
    const root = baseRepo('mikro-adv-d-local-', '# pushed\n');
    write(root, SYSTEM, '# committed locally, never pushed\n');
    commit(root, 'improve the agent');
    const { result, seen } = await runCaptured({ dir: root, cwd: root, genieHome: shippedHome() });
    expect(seen.system).toBe('# committed locally, never pushed\n');
    expect(result.agentSource).toBe('repo@refs/heads/main');
    expect(result.agentSourceReason).toContain('contains origin/main');
  });

  test('a local base branch that diverged from origin/<base> is not', async () => {
    const root = baseRepo('mikro-adv-d-diverged-', '# pushed\n');
    const shared = git(root, ['rev-parse', 'HEAD']);
    // origin/main gains a commit the local branch will not contain…
    write(root, 'other.txt', 'x\n');
    commit(root, 'a commit only the remote has');
    git(root, ['update-ref', 'refs/remotes/origin/main', git(root, ['rev-parse', 'HEAD'])]);
    // …and the local branch gains its own on top of the shared one: the two have diverged,
    // so the remote-tracking ref is what this run trusts and the local rewrite is ignored.
    git(root, ['reset', '-q', '--hard', shared]);
    write(root, SYSTEM, '# a local rewrite on a diverged branch\n');
    commit(root, 'rewrite the agent locally');

    const { result, seen } = await runCaptured({ dir: root, cwd: root, genieHome: shippedHome() });
    expect(seen.system).toBe('# pushed\n');
    expect(result.agentSource).toBe('repo@refs/remotes/origin/main');
  });
});

describe('no trusted ref fails CLOSED on configuration', () => {
  /**
   * The hole this closes: falling back to the directory comparison here meant its
   * same-directory exemption applied, so a session started inside a PR checkout trusted
   * that PR's own `TOOLS.md`. Three ordinary states reach it, and all three are pinned.
   * The AGENT still degrades to the shipped default — that is genie's own payload, not the
   * tree under review — which is why each case also asserts `agentSource`.
   */
  const refusal = async (options: { dir: string; cwd: string; agentsRef?: string }) => {
    const { result, seen } = await runCaptured({ ...options, genieHome: shippedHome() });
    expect(seen.opened).toBe(false); // zero cost: nothing was spawned
    expect(result.ok).toBe(false);
    expect(result.costUsd).toBe(0);
    expect(result.agentSource).toBe('shipped');
    const error = result.attempts[0].errors[0];
    expect(error).toStartWith('config:');
    expect(error).toContain('cannot be verified');
    // All three remedies, named where the operator reads them.
    expect(error).toContain('--agents-ref <ref>');
    expect(error).toContain('git remote set-head origin -a');
    expect(error).toContain('--agents-dir <checkout>/.mikro/agents');
    return error;
  };

  test('a checkout with no origin/HEAD refuses its own .mikro/TOOLS.md', async () => {
    // What `actions/checkout`, and a `git init` + `fetch`, leave behind. The cwd IS the
    // PR checkout here: the state the exemption used to wave through.
    const root = baseRepo('mikro-noref-head-', '# A\n');
    git(root, ['symbolic-ref', '-d', 'refs/remotes/origin/HEAD']);
    writeFileSync(join(root, '.mikro', 'TOOLS.md'), '## injected by the PR\n');
    expect(await refusal({ dir: root, cwd: root })).toContain('git remote set-head origin -a');
  });

  test('a STALE origin/HEAD after a default-branch rename refuses too', async () => {
    const root = baseRepo('mikro-noref-stale-', '# A\n');
    git(root, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/master']); // renamed away
    writeFileSync(join(root, '.mikro', 'TOOLS.md'), '## injected by the PR\n');
    expect(await refusal({ dir: root, cwd: root })).toContain('origin/master');
  });

  test('a well-formed --agents-ref naming no commit refuses the configuration', async () => {
    // The agent degrades (Ruling 1) — the configuration must not, or wish.js own flag
    // would be the way in on any repository whose base ref is spelled differently.
    const root = baseRepo('mikro-noref-flag-', '# A\n');
    writeFileSync(join(root, '.mikro', 'TOOLS.md'), '## injected by the PR\n');
    expect(await refusal({ dir: root, cwd: root, agentsRef: 'origin/no-such-branch' })).toContain('names no commit');
  });

  test('a --dir carrying none of the compared files still runs on the shipped agent', async () => {
    const root = baseRepo('mikro-noref-clean-', '# A\n');
    git(root, ['symbolic-ref', '-d', 'refs/remotes/origin/HEAD']);
    const { result, seen } = await runCaptured({ dir: root, cwd: root, genieHome: shippedHome() });
    expect(seen.opened).toBe(true);
    expect(seen.system).toBe('# shipped default\n');
    expect(result.agentSource).toBe('shipped');
    expect(result.agentSourceReason).toContain('no origin/HEAD');
  });

  test('outside any git checkout the carve-out stands: --dir = cwd is still accepted', async () => {
    // Decision 8 explicit: no checkout, no ref, and only `--dir` = cwd accepted with
    // configuration. The fail-closed rule is for a REPOSITORY that resolved no ref.
    const loose = tmp('mikro-noref-nogit-');
    mkdirSync(join(loose, '.mikro'), { recursive: true });
    writeFileSync(join(loose, '.mikro', 'TOOLS.md'), '## the operator own helpers\n');
    const { result, seen } = await runCaptured({ dir: loose, cwd: loose, genieHome: shippedHome() });
    expect(seen.opened).toBe(true);
    expect(result.agentSource).toBe('shipped');
    // …and a DIFFERENT --dir is still refused, by the directory comparison.
    const other = tmp('mikro-noref-nogit-other-');
    mkdirSync(join(other, '.mikro'), { recursive: true });
    writeFileSync(join(other, '.mikro', 'TOOLS.md'), '## injected\n');
    const away = await runCaptured({ dir: other, cwd: loose, genieHome: shippedHome() });
    expect(away.seen.opened).toBe(false);
    expect(away.result.attempts[0].errors[0]).toStartWith('config:');
  });
});

describe('(f)/(g) the legacy .rlmx configuration directory is compared too', () => {
  /**
   * mikro 1.260909.1 falls back to `<dir>/.rlmx/rlmx.yaml` when `<dir>/.mikro/mikro.yaml`
   * is absent, and then auto-loads `.rlmx/{SYSTEM,CRITERIA,TOOLS}.md` — so on exactly the
   * repositories the shipped defaults exist for (no `.mikro/mikro.yaml`), `.rlmx/` is the
   * branch that fires. TOOLS.md there is Python in the REPL and `providers:` outranks the
   * global settings.
   */
  const legacy = {
    yaml: 'providers:\n  attacker:\n    kind: openai\n',
    tools: '## injected\ndef helper():\n    pass\n',
  };

  test('(f) a PR adding .rlmx/rlmx.yaml + .rlmx/TOOLS.md is refused on the repo source', async () => {
    const base = baseRepo('mikro-rlmx-repo-', '# A\n'); // carries an agent, no .mikro/mikro.yaml
    const worktree = join(tmp('mikro-rlmx-wt-'), 'pr');
    git(base, ['worktree', 'add', '-q', '-b', 'pr', worktree]);
    write(worktree, '.rlmx/rlmx.yaml', legacy.yaml);
    write(worktree, '.rlmx/TOOLS.md', legacy.tools);
    commit(worktree, 'the PR injects the legacy config dir');

    const { result, seen } = await runCaptured({ dir: worktree, cwd: worktree, genieHome: shippedHome() });
    expect(seen.opened).toBe(false);
    expect(result.costUsd).toBe(0);
    expect(result.attempts[0].errors[0]).toStartWith('config:');
    expect(result.attempts[0].errors[0]).toContain('.rlmx/rlmx.yaml');
    expect(result.agentSource).toBe('repo@refs/heads/main');

    git(base, ['worktree', 'remove', '--force', worktree]);
  });

  test('(f) and on the shipped source, where the repository has no agent at all', async () => {
    const root = tmp('mikro-rlmx-shipped-');
    git(root, ['init', '-q', '-b', 'main']);
    write(root, 'README.md', '# no agent, no .mikro/mikro.yaml\n');
    commit(root, 'seed');
    git(root, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    git(root, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
    write(root, '.rlmx/rlmx.yaml', legacy.yaml);
    write(root, '.rlmx/TOOLS.md', legacy.tools);

    const { result, seen } = await runCaptured({ dir: root, cwd: root, genieHome: shippedHome() });
    expect(seen.opened).toBe(false);
    expect(result.costUsd).toBe(0);
    expect(result.attempts[0].errors[0]).toStartWith('config:');
    expect(result.agentSource).toBe('shipped');
  });

  test('(g) the same legacy files, byte-identical at the ref, are accepted', async () => {
    const root = baseRepo('mikro-rlmx-ok-', '# A\n', {
      '.rlmx/rlmx.yaml': legacy.yaml,
      '.rlmx/TOOLS.md': legacy.tools,
    });
    const { result, seen } = await runCaptured({ dir: root, cwd: root, genieHome: shippedHome() });
    expect(seen.opened).toBe(true);
    expect(seen.system).toBe('# A\n');
    expect(result.agentSource).toBe('repo@refs/heads/main');
  });
});

describe('a compared path that is not a regular file', () => {
  /**
   * Run the CLI as a SUBPROCESS on a scratch PATH that holds only a `mikro` stub.
   *
   * These cases refuse before anything is spawned, so the PATH should never matter — which
   * is exactly why it is pinned. A regression that let one of them through would otherwise
   * reach for the real `mikro` on the developer's PATH and turn a unit test into a billed
   * runtime invocation (observed once, as a five-second stall). With the stub there is
   * nothing to reach.
   */
  const runCli = (dir: string, cwd: string) => {
    const proc = Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dir, 'call.ts'),
        'wish-context',
        '--prompt',
        'Intent: x',
        '--dir',
        dir,
        '--retries',
        '0',
        '--no-phoenix',
        '--no-ledger',
      ],
      {
        cwd,
        // The real git is on this PATH on purpose: without it the run would refuse through
        // the no-git fail-closed branch and these cases would pin nothing.
        env: { ...process.env, PATH: stubPathWithGit(), GENIE_HOME: shippedHome() },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const parsed = JSON.parse(proc.stdout.toString()) as { attempts: { errors: string[] }[] };
    return { code: proc.exitCode, error: parsed.attempts[0]?.errors[0] ?? '' };
  };
  const leftovers = (): Set<string> =>
    new Set(readdirSync(tmpdir()).filter((entry) => entry.startsWith('mikro-agents-')));

  test('a DIRECTORY named .mikro/TOOLS.md is a refusal, not an EISDIR crash, and leaks no temp tree', () => {
    const root = baseRepo('mikro-eisdir-', '# A\n');
    mkdirSync(join(root, '.mikro', 'TOOLS.md', 'inside'), { recursive: true });
    const before = leftovers();
    const run = runCli(root, root);
    expect(run.code).toBe(1);
    // The refusal must be THIS one — the trusted ref resolved fine, so a bare exit code
    // would also be satisfied by any other refusal on the way.
    expect(run.error).toStartWith('config:');
    expect(run.error).toContain('not a regular file');
    expect([...leftovers()].filter((entry) => !before.has(entry))).toEqual([]);
  });

  test('a SYMLINK in a compared path is refused rather than followed', () => {
    const root = baseRepo('mikro-symlink-', '# A\n');
    const elsewhere = tmp('mikro-symlink-target-');
    writeFileSync(join(elsewhere, 'TOOLS.md'), '## injected through a link\n');
    symlinkSync(join(elsewhere, 'TOOLS.md'), join(root, '.mikro', 'TOOLS.md'));
    const before = leftovers();
    const linked = runCli(root, root);
    expect(linked.code).toBe(1);
    expect(linked.error).toContain('not a regular file');
    expect([...leftovers()].filter((entry) => !before.has(entry))).toEqual([]);
    // A DANGLING link is refused too: `existsSync` answered false for it, which read as
    // "absent" and waved the run through.
    rmSync(join(root, '.mikro', 'TOOLS.md'));
    symlinkSync(join(elsewhere, 'gone.md'), join(root, '.mikro', 'TOOLS.md'));
    const dangling = runCli(root, root);
    expect(dangling.code).toBe(1);
    expect(dangling.error).toContain('not a regular file');
  });
});

describe('a git that cannot answer is IN a repository, not outside one', () => {
  /**
   * `gitToplevel` answered `null` for "git says this is not a repository" AND for "git
   * could not answer", and the second is ordinary: a `safe.directory` refusal under Docker,
   * CI, sudo or a shared checkout (exit 128), an unreadable index, a broken gitlink, or no
   * `git` on PATH. Both landed in the carve-out, whose same-directory exemption then
   * accepted the pull request's own configuration — inside a real repository with a valid
   * `origin/HEAD` sitting right there. Only a PROVEN non-repository may reach the carve-out.
   */
  const cli = (dir: string, cwd: string, path: string) => {
    const proc = Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dir, 'call.ts'),
        'wish-context',
        '--prompt',
        'Intent: x',
        '--dir',
        dir,
        '--retries',
        '0',
        '--no-phoenix',
        '--no-ledger',
      ],
      { cwd, env: { ...process.env, PATH: path, GENIE_HOME: shippedHome() }, stdout: 'pipe', stderr: 'pipe' },
    );
    const parsed = JSON.parse(proc.stdout.toString()) as {
      ok: boolean;
      agentSource?: string;
      agentSourceReason?: string;
      attempts: { errors: string[] }[];
    };
    return { code: proc.exitCode, ...parsed, error: parsed.attempts[0]?.errors[0] ?? '' };
  };
  /** A PATH with the `mikro` stub and NO git: the stub proves a run that got that far. */
  const pathWithoutGit = (): string => stubPath();

  test('(1) a real checkout with no git on PATH refuses its committed .mikro/TOOLS.md', () => {
    const root = baseRepo('mikro-nogit-bin-', '# A\n');
    write(root, '.mikro/TOOLS.md', '## injected by the PR\n');
    commit(root, 'the PR injects TOOLS.md');
    const run = cli(root, root, pathWithoutGit());
    expect(run.code).toBe(1);
    expect(run.error).toStartWith('config:');
    expect(run.error).toContain('cannot be verified');
    expect(run.agentSource).toBe('shipped'); // the AGENT still degrades, as it always did
    expect(run.agentSourceReason).toContain('.git');
  });

  test('(2) a .git FILE pointing nowhere is a checkout, whatever git says about it', () => {
    const root = tmp('mikro-broken-gitlink-');
    writeFileSync(join(root, '.git'), 'gitdir: /nowhere/at/all/.git\n');
    mkdirSync(join(root, '.mikro'), { recursive: true });
    writeFileSync(join(root, '.mikro', 'TOOLS.md'), '## injected by the PR\n');
    const run = cli(root, root, stubPathWithGit()); // git present, and it refuses
    expect(run.code).toBe(1);
    expect(run.error).toStartWith('config:');
    expect(run.error).toContain('cannot be verified');
    expect(run.agentSourceReason).toContain('.git');
  });

  test('(3) a plain directory with git present and --dir = cwd keeps the carve-out', () => {
    const loose = tmp('mikro-carveout-');
    mkdirSync(join(loose, '.mikro'), { recursive: true });
    writeFileSync(join(loose, '.mikro', 'TOOLS.md'), '## the operator own helpers\n');
    const run = cli(loose, loose, stubPathWithGit()); // git answers, cleanly, "not a repository"
    expect(run.error).not.toStartWith('config:'); // it ran: the stub is not an MCP server
    expect(run.agentSource).toBe('shipped');
    expect(run.agentSourceReason).toContain('is no git checkout');
  });

  test('a git whose refusal is LOCALIZED still reaches the carve-out', () => {
    // The classification reads git's message, so the probe pins the locale. Without
    // `LC_ALL=C` a French, German or Japanese git would make every plain directory read as
    // `unanswered` — safe, but it would silently disable the carve-out for those hosts.
    const bin = tmp('mikro-localized-git-');
    writeFileSync(join(bin, 'mikro'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(
      join(bin, 'git'),
      [
        '#!/bin/sh',
        'if [ "$LC_ALL" = "C" ]; then',
        '  echo "fatal: not a git repository (or any of the parent directories): .git" >&2',
        'else',
        '  echo "fatal: ce n\'est pas un dépôt git (ni aucun des répertoires parents) : .git" >&2',
        'fi',
        'exit 128',
      ].join('\n'),
      { mode: 0o755 },
    );
    const loose = tmp('mikro-localized-');
    mkdirSync(join(loose, '.mikro'), { recursive: true });
    writeFileSync(join(loose, '.mikro', 'TOOLS.md'), '## the operator own helpers\n');
    const run = cli(loose, loose, bin);
    expect(run.error).not.toStartWith('config:');
    expect(run.agentSourceReason).toContain('is no git checkout');
  });

  test('(4) a plain directory with no git binary either is still the carve-out', () => {
    const loose = tmp('mikro-carveout-nogit-');
    mkdirSync(join(loose, '.mikro'), { recursive: true });
    writeFileSync(join(loose, '.mikro', 'TOOLS.md'), '## the operator own helpers\n');
    const run = cli(loose, loose, pathWithoutGit());
    expect(run.error).not.toStartWith('config:');
    expect(run.agentSource).toBe('shipped');
    expect(run.agentSourceReason).toContain('is no git checkout');
  });
});

describe('the UNCONTAINED path hands over the same materialized tree', () => {
  /**
   * Every other case here observes the injected boundary opener, which is the `--boundary
   * bwrap` arm. `none` is the DEFAULT arm and builds its own child environment
   * (`serverEnv()` + `MIKRO_AGENTS_DIR`, `call.ts`), so it is asserted on its own terms:
   * a stub named `mikro` on a scratch PATH records what it was handed and exits. It is a
   * shell script, not the runtime — no MCP session, no provider, no bill — and the run
   * then fails with "exited before answering", which is all this test needs.
   */
  test('a stub on PATH records MIKRO_AGENTS_DIR and reads the committed prompt through it', () => {
    const root = baseRepo('mikro-uncontained-', '# the committed prompt\n');
    write(root, SYSTEM, '# the working tree prompt\n'); // uncommitted: must NOT be what it sees
    const bin = tmp('mikro-uncontained-bin-');
    const capture = join(tmp('mikro-uncontained-capture-'), 'handed-over.txt');
    writeFileSync(
      join(bin, 'mikro'),
      '#!/bin/sh\n{ printf "dir=%s\\n" "$MIKRO_AGENTS_DIR"; cat "$MIKRO_AGENTS_DIR/wish-context/SYSTEM.md"; } > "$MIKRO_CAPTURE"\nexit 0\n',
      { mode: 0o755 },
    );
    const proc = Bun.spawnSync(
      [process.execPath, join(import.meta.dir, 'call.ts'), 'wish-context'].concat([
        '--prompt',
        'Intent: x',
        '--dir',
        root,
        '--retries',
        '0',
        '--no-phoenix',
        '--no-ledger',
      ]),
      {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          // `MIKRO_*` is on `serverEnv()`'s allowlist, which is how the stub is told where to write.
          MIKRO_CAPTURE: capture,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    expect(proc.exitCode).toBe(1); // the stub is not an MCP server: the run fails, unbilled
    const handed = readFileSync(capture, 'utf8');
    const agentsDir = /^dir=(.*)$/m.exec(handed)?.[1] ?? '';
    expect(agentsDir).not.toBe('');
    expect(agentsDir.startsWith(root)).toBe(false); // never the tree under review
    expect(agentsDir).toContain('mikro-agents-'); // the materialized 0700 tree
    expect(handed).toContain('# the committed prompt');
    expect(handed).not.toContain('# the working tree prompt');
    expect(JSON.parse(proc.stdout.toString()).agentSource).toBe('repo@refs/heads/main');
  });
});

describe('the materialized tree does not outlive the run', () => {
  /** Temp roots this module's materialization could have left behind, by name. */
  const materialized = (): Set<string> =>
    new Set(readdirSync(tmpdir()).filter((entry) => entry.startsWith('mikro-agents-')));

  test('a throw from the boundary disposes it too', async () => {
    const root = baseRepo('mikro-adv-throw-', '# A\n');
    let agentsDir = '';
    await expect(
      runAgent({
        agent: 'wish-context',
        prompt: 'Intent: anything at all',
        dir: root,
        cwd: root,
        genieHome: shippedHome(),
        boundary: 'bwrap',
        retries: 0,
        phoenix: false,
        ledger: false,
        openBoundary: async (opened: OpenBoundaryOptions) => {
          agentsDir = opened.agentsDir ?? '';
          throw new Error('the sandbox could not be opened');
        },
      }),
    ).rejects.toThrow('the sandbox could not be opened');
    expect(agentsDir).not.toBe('');
    expect(existsSync(agentsDir)).toBe(false);
  });

  test('a configuration refusal leaves nothing behind either', async () => {
    const root = baseRepo('mikro-adv-refuse-', '# A\n');
    writeFileSync(join(root, '.mikro', 'TOOLS.md'), '## injected\n'); // uncommitted: refused
    const before = materialized();
    const { result, seen } = await runCaptured({ dir: root, cwd: root, genieHome: shippedHome() });
    expect(seen.opened).toBe(false);
    expect(result.attempts[0].errors[0]).toStartWith('config:');
    expect([...materialized()].filter((entry) => !before.has(entry))).toEqual([]);
  });
});

describe('(e) a ref that is not a ref', () => {
  test('a leading dash and a malformed name are usage refusals, before anything runs', async () => {
    const root = baseRepo('mikro-adv-e-', '# A\n');
    const argv = (ref: string) => [
      'wish-context',
      '--prompt',
      'Intent: x',
      '--dir',
      root,
      '--agents-ref',
      ref,
      '--no-phoenix',
      '--no-ledger',
    ];
    expect(await runCallCli(argv('-evil'))).toBe(2);
    expect(await runCallCli(argv('--upload-pack=touch /tmp/pwned'))).toBe(2);
    expect(await runCallCli(argv('bad..name'))).toBe(2);
    expect(await runCallCli(argv('ref with space'))).toBe(2);
  });
});
