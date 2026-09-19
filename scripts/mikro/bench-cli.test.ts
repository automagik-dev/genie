/**
 * `runBenchCli` as `genie mikro bench` invokes it: the exit code, the stream each
 * message lands on, and the two refusals that cost nothing.
 *
 * Nothing here spawns the `mikro` runtime or calls a provider: every case is refused
 * before a job exists, or has zero jobs by construction (`--only` filtering the set to
 * nothing), which is also why the agents-dir check is gated on there being a job at all.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runBenchCli } from './bench';
import { resolveFixturesPath } from './bench-options';
import type { RunOptions, RunResult, runAgent } from './call';
import { runFixturesCli } from './fixtures-from-commits';

const trash: string[] = [];
afterEach(() => {
  for (const dir of trash.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  trash.push(dir);
  return dir;
}

function write(root: string, path: string, body: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), body);
}

/** One round, with both streams captured rather than printed into the test transcript. */
async function bench(argv: string[], run?: typeof runAgent): Promise<{ code: number; out: string; err: string }> {
  const captured = { out: '', err: '' };
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  process.stdout.write = ((chunk: string) => {
    captured.out += chunk;
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => {
    captured.err += chunk;
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = run ? await runBenchCli(argv, run) : await runBenchCli(argv);
    return { code, ...captured };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}

describe('resolveFixturesPath (Decision 12)', () => {
  const exists = (present: string[]) => (path: string) => present.includes(path);

  test('the repository-local set wins over genie legacy location, and an explicit path over both', () => {
    const repoLocal = join('/repo', '.mikro', 'fixtures', 'wish-context.json');
    const legacy = join('/repo', 'scripts', 'mikro', 'fixtures', 'wish-context.json');
    expect(resolveFixturesPath({ dir: '/repo', agent: 'wish-context' }, exists([repoLocal]))).toBe(repoLocal);
    expect(resolveFixturesPath({ dir: '/repo', agent: 'wish-context' }, exists([]))).toBe(legacy);
    expect(resolveFixturesPath({ dir: '/repo', agent: 'wish-context', explicit: '/f.json' }, exists([repoLocal]))).toBe(
      '/f.json',
    );
  });

  test("genie's own no-flag resolution is unchanged: this checkout has no .mikro/fixtures", () => {
    const root = join(import.meta.dir, '..', '..');
    expect(resolveFixturesPath({ dir: root, agent: 'wish-context' })).toBe(
      join(root, 'scripts', 'mikro', 'fixtures', 'wish-context.json'),
    );
  });
});

describe('the round is refused upfront, at zero cost', () => {
  test('a fixture set that is not on disk names all three locations and the builder', async () => {
    const dir = tmp('mikro-bench-nofix-');
    const { code, err, out } = await bench(['wish-context', '--dir', dir, '--no-phoenix']);
    expect(code).toBe(2);
    expect(err).toContain(join(dir, 'scripts', 'mikro', 'fixtures', 'wish-context.json'));
    expect(err).toContain('genie mikro fixtures --from-commits');
    expect(out).toBe('');
    // Nothing was written: a refusal leaves the repository as it found it.
    expect(readdirSync(dir)).toEqual([]);
  });

  test('an agents dir with no <agent>/agent.yaml names genie mikro init (Group 4 advisory A1)', async () => {
    const dir = tmp('mikro-bench-noagent-');
    write(
      dir,
      '.mikro/fixtures/wish-context.json',
      JSON.stringify({ fixtures: [{ id: 'a', prompt: 'x', truth: {} }] }),
    );
    const { code, err } = await bench(['wish-context', '--dir', dir, '--no-phoenix']);
    expect(code).toBe(2);
    expect(err).toContain(join(dir, '.mikro', 'agents'));
    expect(err).toContain(`genie mikro init --dir ${dir}`);
    // …and it is the WORKING TREE that was looked at, which is the whole point of the bench.
    expect(err).toContain('never a git ref');
  });

  test('an unregistered agent name is a usage refusal from the registry, not a missing file', async () => {
    const { code, err } = await bench(['mikro-scribe', '--dir', tmp('mikro-bench-name-')]);
    expect(code).toBe(2);
    expect(err).toContain('usage: genie mikro bench');
    expect(err).not.toContain('genie mikro init');
  });
});

describe('a whole round over another repository, against an injected runner', () => {
  test('commit-built fixtures in repo A bench repo B: one row each, its agents dir, its ledger', async () => {
    // A: the repository whose history states the ground truth.
    const a = tmp('mikro-bench-src-');
    const git = (root: string, args: string[]) =>
      Bun.spawnSync(['git', '-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
    git(a, ['init', '-q', '-b', 'main']);
    for (const n of [1, 2]) {
      write(a, `src/mod${n}.ts`, `export const v${n} = ${n};\n`);
      git(a, ['add', '-A']);
      git(a, ['commit', '-qm', `feat: add mod${n}`]);
    }
    const built = join(a, '.mikro', 'fixtures', 'wish-context.json');
    expect(runFixturesCli(['--from-commits', 'HEAD', '--agent', 'wish-context', '--dir', a])).toBe(0);

    // B: a different repository, with its own agents — the tree actually measured.
    const b = tmp('mikro-bench-target-');
    write(b, '.mikro/agents/wish-context/agent.yaml', 'model: deepseek-api/deepseek-flash\nsystem: SYSTEM.md\n');
    write(b, '.mikro/agents/wish-context/SYSTEM.md', '# the prompt under measurement\n');

    const seen: { prompt: string; dir?: string; agentsDir?: string }[] = [];
    const stub = (async (options: RunOptions): Promise<RunResult> => {
      seen.push({ prompt: options.prompt, dir: options.dir, agentsDir: options.agentsDir });
      return {
        ok: true,
        agent: options.agent,
        runId: `stub-${seen.length}`,
        traceId: options.traceId ?? 'stub',
        dir: options.dir ?? '',
        // The answer a perfect agent would give: the file the intent names. Scoring is
        // therefore exercised for real — recall, precision and the bars that read them.
        answer: { plan: { files: [{ path: `src/${/mod\d/.exec(options.prompt)?.[0]}.ts` }] } },
        attempts: [],
        elapsedMs: 1,
        costUsd: 0.001,
        tags: options.tags ?? {},
        boundary: 'none',
        egress: null,
        agentSource: 'flag',
      };
    }) as typeof runAgent;

    const { code, out } = await bench(['wish-context', '--dir', b, '--fixtures', built, '--no-phoenix'], stub);

    // One run per fixture, each carrying the commit subject as its prompt…
    expect(seen).toHaveLength(2);
    expect(seen.map((s) => s.prompt).sort()).toEqual(['Intent: feat: add mod1', 'Intent: feat: add mod2']);
    // …measuring B's WORKING TREE and reading B as the tree under test, never A.
    for (const call of seen) {
      expect(call.agentsDir).toBe(join(b, '.mikro', 'agents'));
      expect(call.dir).toBe(b);
    }
    // The table carries one row per fixture and the bars were computed over them.
    expect(out).toContain('runs 2 · yield 1.00');
    expect(code).toBe(0);
    // The record lands in B's ledger, not A's, and carries both rows.
    const records = readdirSync(join(b, '.mikro', 'runs')).filter((f) => f.startsWith('bench-'));
    expect(records).toHaveLength(1);
    const record = JSON.parse(readFileSync(join(b, '.mikro', 'runs', records[0]), 'utf8')) as {
      rows: { id: string }[];
      agentsDir?: string;
    };
    expect(record.rows).toHaveLength(2);
    // No `--agents-dir` was typed, so the record still carries no such key.
    expect('agentsDir' in record).toBe(false);
    expect(existsSync(join(a, '.mikro', 'runs'))).toBe(false);
  });
});

describe('a round with no job', () => {
  test('runs and records without an agents dir — there is no prompt to resolve', async () => {
    const dir = tmp('mikro-bench-empty-');
    write(
      dir,
      '.mikro/fixtures/wish-context.json',
      JSON.stringify({ fixtures: [{ id: 'a', prompt: 'x', truth: {} }] }),
    );
    const { code, out } = await bench([
      'wish-context',
      '--dir',
      dir,
      '--only',
      'no-such-fixture',
      '--no-phoenix',
      '--tag',
      'note=zero-jobs',
    ]);
    // 1, not 2: the round RAN and the empty yield bar failed, which is the pre-existing
    // behaviour of a zero-row round. What matters here is that it was not REFUSED.
    expect(code).toBe(1);
    expect(out).toContain('runs 0 · yield 0.00');
    expect(readdirSync(join(dir, '.mikro', 'runs')).filter((f) => f.startsWith('bench-'))).toHaveLength(1);
  });
});
