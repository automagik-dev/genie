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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
