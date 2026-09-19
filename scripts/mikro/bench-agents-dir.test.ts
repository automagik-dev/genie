/**
 * The measuring tools read the WORKING TREE, and that is a choice with consequences.
 *
 * `genie mikro call` reads its agent from a git ref because it reviews untrusted content.
 * `bench` and `coach` are the other half: a refinement round exists to measure the
 * `SYSTEM.md` the operator just edited, and the coach's printed diff has to describe the
 * same prompt its BEFORE bench measured. This file proves the default is the working tree,
 * that the bench RECORD still carries no `agentsDir` key, and that the `.mikro/`
 * configuration comparison is skipped BECAUSE the synthesized trusted root equals `--dir` —
 * asserted rather than assumed, so the exemption reads as chosen.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { benchAgentsDir, parseBenchOptions } from './bench-options';
import type { BoundarySession, OpenBoundaryOptions } from './boundary';
import { resolveAgentsDir, runAgent, untrustedConfig } from './call';

process.env.DEEPSEEK_API_KEY = 'sk-test';
process.env.GH_TOKEN = 'ghp_test';

const trash: string[] = [];
afterAll(() => {
  for (const dir of trash) rmSync(dir, { recursive: true, force: true });
});

function git(root: string, args: string[]): void {
  const probe = Bun.spawnSync(['git', '-C', root, ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (probe.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${probe.stderr.toString()}`);
}

function write(root: string, path: string, body: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), body);
}

/**
 * A command that EXISTS on this host and exits non-zero: the stand-in for a
 * runtime that RAN and failed. Never the literal `/bin/false` — macOS ships
 * `false` in /usr/bin only, so that path named a MISSING binary there, the spawn
 * failed ENOENT, and `runAgent` classified the whole run as "the mikro runtime
 * is not runnable on this host" and broke out of the retry loop under test
 * (#2926).
 */
const FAILING_RUNTIME = Bun.which('false') ?? '/usr/bin/false';

describe('benchAgentsDir', () => {
  test('no flag means the working tree under --dir; a flag is passed through untouched', () => {
    expect(benchAgentsDir({ dir: '/repo' })).toBe(join('/repo', '.mikro', 'agents'));
    expect(benchAgentsDir({ dir: '/repo', agentsDir: '/tmp/copy/.mikro/agents' })).toBe('/tmp/copy/.mikro/agents');
    // The parsed options are unchanged by this: the record is built from THEM, and a
    // no-flag record must stay byte-identical to every round before the flag existed.
    expect('agentsDir' in parseBenchOptions(['wish-context', '--dir', '/repo'], '/cwd')).toBe(false);
  });
});

describe('the no-flag bench measures the working tree', () => {
  test('a repository whose working-tree SYSTEM.md differs from the committed one', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mikro-bench-tree-'));
    trash.push(root);
    git(root, ['init', '-q', '-b', 'main']);
    write(root, '.mikro/agents/wish-context/agent.yaml', 'model: deepseek-api/deepseek-flash\nsystem: SYSTEM.md\n');
    write(root, '.mikro/agents/wish-context/SYSTEM.md', '# committed\n');
    // A `.mikro/` configuration file too: the flag path skips comparing it, and this test
    // says so out loud rather than leaving the reader to infer it from a passing run.
    write(root, '.mikro/TOOLS.md', '## the operator own helpers\n');
    git(root, ['add', '-A']);
    git(root, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'seed']);
    git(root, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    git(root, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
    // The edit a refinement round is about: uncommitted, and the only thing worth measuring.
    write(root, '.mikro/agents/wish-context/SYSTEM.md', '# the prompt under refinement\n');
    write(root, '.mikro/TOOLS.md', '## the operator own helpers, edited too\n');

    const options = parseBenchOptions(['wish-context', '--dir', root], root);
    const agentsDir = benchAgentsDir(options);
    expect(agentsDir).toBe(join(root, '.mikro', 'agents'));

    // Why the run is not refused: the flag path derives the trusted root two levels above
    // the agents dir, which IS `--dir`, so `untrustedConfig` returns on its same-directory
    // exemption without comparing anything — including the TOOLS.md edited above.
    const resolved = resolveAgentsDir({
      agentsDir,
      cwd: root,
      genieHome: join(root, 'nowhere'),
      agent: 'wish-context',
    });
    expect(resolved?.source).toBe('flag');
    expect(resolved?.trustedRoot).toBe(resolve(options.dir));
    expect(untrustedConfig(options.dir, resolved?.trustedRoot ?? '')).toBeNull();

    // And what the runtime is handed is the working-tree prompt, not the committed one.
    let seen = '';
    let envAgentsDir: string | undefined;
    const session: BoundarySession = {
      mode: 'bwrap',
      spec: null as unknown as BoundarySession['spec'],
      argv: () => [FAILING_RUNTIME],
      env: {} as Record<string, string>,
      counts: () => ({ allowed: 0, denied: 0 }),
      close: async () => undefined,
    };
    const result = await runAgent({
      agent: 'wish-context',
      prompt: 'Intent: anything at all',
      dir: options.dir,
      cwd: root,
      agentsDir,
      boundary: 'bwrap',
      retries: 0,
      phoenix: false,
      ledger: false,
      openBoundary: async (opened: OpenBoundaryOptions) => {
        envAgentsDir = opened.env.MIKRO_AGENTS_DIR;
        seen = readFileSync(join(opened.agentsDir ?? '', 'wish-context', 'SYSTEM.md'), 'utf8');
        return session;
      },
    });
    expect(seen).toBe('# the prompt under refinement\n');
    expect(envAgentsDir).toBe(agentsDir);
    expect(result.agentSource).toBe('flag');
    // Nothing was materialized, so nothing had to be disposed: the tree is still there.
    expect(existsSync(join(agentsDir, 'wish-context', 'SYSTEM.md'))).toBe(true);
  });
});
