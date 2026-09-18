import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoundaryError, type BoundarySession, type OpenBoundaryOptions } from './boundary';
import {
  PRICE_BASIS,
  RAW_CAP_BYTES,
  RAW_TRUNCATION_MARKER,
  applyResolutions,
  boundaryFactsRunner,
  containedEnv,
  extractJson,
  factsContextPath,
  parseBoundaryFlag,
  parseFooter,
  persistFailedRaw,
  prepareFacts,
  runAgent,
  serverEnv,
  stripFooter,
  untrustedConfig,
  verifyCitations,
} from './call';
import { FACTS_HEADER } from './facts';
import { buildRunSpan } from './phoenix';
import { IssueTriage, SCHEMAS } from './schemas';

const FOOTER =
  'mikro · issue-triage · deepseek-api/deepseek-flash · 7 iterations · 12,345 in / 1,234 out · $0.0031 · 84.2s · session 3f2a-b1';

describe('parseFooter', () => {
  test('parses the seven fields and the session id', () => {
    const f = parseFooter(`answer\n${FOOTER}`);
    expect(f).toEqual({
      label: 'issue-triage',
      model: 'deepseek-api/deepseek-flash',
      iterations: 7,
      tokensIn: 12345,
      tokensOut: 1234,
      cost: 0.0031,
      seconds: 84.2,
      budgetHit: null,
      validationFailed: false,
      sessionId: '3f2a-b1',
    });
  });
  test('reads budget hit and validation_failed, singular iteration', () => {
    const f = parseFooter(
      'x\nmikro · q · m/m · 1 iteration · 1 in / 2 out · $0.00 · 1.0s · budget hit: max_iterations · validation_failed: true · session s',
    );
    expect(f?.iterations).toBe(1);
    expect(f?.budgetHit).toBe('max_iterations');
    expect(f?.validationFailed).toBe(true);
  });
  test('returns null without a footer and stripFooter leaves the answer', () => {
    expect(parseFooter('no footer here')).toBeNull();
    expect(stripFooter(`the answer\n${FOOTER}`)).toBe('the answer');
  });
});

describe('extractJson', () => {
  test('takes the last json fence that parses', () => {
    const text = 'prose ```json\n{"a":1}\n``` more ```json\n{"b":2}\n```';
    expect(extractJson(text).value).toEqual({ b: 2 });
  });
  test('falls back to the outermost braces', () => {
    expect(extractJson('FINAL: {"ok": true} trailing').value).toEqual({ ok: true });
  });
  test('names the failure when nothing parses', () => {
    expect(extractJson('nothing').error).toMatch(/no JSON object/);
    expect(extractJson('{ not json }').error).toMatch(/no parseable/);
  });
});

describe('verifyCitations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mikro-cite-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.ts'), 'l1\nl2\nl3\n');
  test('accepts existing path:line, rejects past-end, missing and traversal', () => {
    const parsed = {
      facts: [
        { claim: 'x', evidence: 'src/a.ts:2' },
        { claim: 'y', evidence: 'src/a.ts:99' },
        { claim: 'z', evidence: 'src/missing.ts:1' },
      ],
      candidate_files: [
        { path: 'src/a.ts', why: 'w' },
        { path: '../etc/passwd', why: 'w' },
      ],
    };
    const cites = verifyCitations(parsed, dir);
    const byKey = Object.fromEntries(cites.map((c) => [`${c.path}:${c.line ?? ''}`, c]));
    expect(byKey['src/a.ts:2'].ok).toBe(true);
    expect(byKey['src/a.ts:99'].ok).toBe(false);
    expect(byKey['src/missing.ts:1'].ok).toBe(false);
    expect(byKey['src/a.ts:'].ok).toBe(true);
    expect(byKey['../etc/passwd:'].ok).toBe(false);
  });
  test('a bare basename that exists elsewhere gets a did-you-mean hint', () => {
    const repo = mkdtempSync(join(tmpdir(), 'mikro-hint-'));
    mkdirSync(join(repo, 'deep', 'dir'), { recursive: true });
    writeFileSync(join(repo, 'deep', 'dir', 'DESIGN.md'), 'a\nb\n');
    mkdirSync(join(repo, 'other'), { recursive: true });
    writeFileSync(join(repo, 'other', 'DESIGN.md'), 'a\nb\n'); // two candidates: ambiguous, so a hint, not a resolution
    Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
    Bun.spawnSync(['git', 'add', '.'], { cwd: repo });
    const [c] = verifyCitations({ facts: [{ evidence: 'DESIGN.md:2' }] }, repo);
    expect(c.ok).toBe(false);
    expect(c.reason).toContain('did you mean');
    expect(c.reason).toContain('deep/dir/DESIGN.md');
  });
  test('a bare name that resolves to exactly one tracked file is accepted and rewritten', () => {
    const repo = mkdtempSync(join(tmpdir(), 'mikro-resolve-'));
    mkdirSync(join(repo, 'scripts'), { recursive: true });
    writeFileSync(join(repo, 'scripts', 'build-binary.sh'), 'a\nb\nc\n');
    Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
    Bun.spawnSync(['git', 'add', '.'], { cwd: repo });
    const value = { facts: [{ evidence: 'build-binary.sh:2' }, { evidence: 'build-binary.sh:9' }] };
    const cites = verifyCitations(value, repo);
    expect(cites.find((c) => c.line === 2)?.resolvedTo).toBe('scripts/build-binary.sh');
    expect(cites.find((c) => c.line === 9)?.ok).toBe(false);
    expect(applyResolutions(value, cites).facts[0].evidence).toBe('scripts/build-binary.sh:2');
  });
  test('a plan may name a file that does not exist yet, and only a plan', () => {
    const repo = mkdtempSync(join(tmpdir(), 'mikro-new-'));
    mkdirSync(join(repo, 'scripts', 'mikro'), { recursive: true });
    writeFileSync(join(repo, 'scripts', 'mikro', 'call.ts'), 'a\nb\n');
    mkdirSync(join(repo, 'scratch'), { recursive: true }); // on disk, holds nothing tracked
    Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
    Bun.spawnSync(['git', 'add', 'scripts'], { cwd: repo });
    const file = (path: string, reason: string) => verifyCitations({ plan: { files: [{ path, reason }] } }, repo)[0];
    // The shape every planning intent returned on 2026-09-18 and the gate refused: the
    // prompt allows it, so the answer was right and the run was billed twice for nothing.
    const planned = file('scripts/mikro/triage.ts', 'NEW: the triage scout; parent scripts/mikro/ is tracked');
    expect(planned.ok).toBe(true);
    expect(planned.reason).toBe('new file (declared NEW: under a tracked directory)');
    // Without the marker a missing file is still a failed citation.
    expect(file('scripts/mikro/triage.ts', 'the triage scout').ok).toBe(false);
    // A directory that does not exist, or holds nothing tracked, anchors nothing.
    expect(file('scripts/nowhere/triage.ts', 'NEW: invented parent').ok).toBe(false);
    expect(file('scratch/triage.ts', 'NEW: untracked parent').ok).toBe(false);
    // NEW: is a plan marker, never evidence: the same path cited with a line still fails.
    const cited = verifyCitations(
      {
        facts: [{ evidence: 'scripts/mikro/triage.ts:12' }],
        plan: { files: [{ path: 'scripts/mikro/triage.ts', reason: 'NEW: x' }] },
      },
      repo,
    );
    expect(cited.find((c) => c.line === 12)?.ok).toBe(false);
    // The marker belongs to `plan.files` alone: the same record anywhere else is prose.
    const elsewhere = verifyCitations({ files: [{ path: 'scripts/mikro/triage.ts', reason: 'NEW: x' }] }, repo);
    expect(elsewhere[0].ok).toBe(false);
    // The repository root is a tracked directory like any other.
    expect(file('TRIAGE.md', 'NEW: a root-level note').ok).toBe(true);
    // An existing file gains nothing from the marker: it is checked as any other path.
    expect(file('scripts/mikro/call.ts', 'NEW: not new at all').reason).toBeUndefined();
  });
  test('a deleted file in review-prep is not a failed citation', () => {
    const cites = verifyCitations({ files: [{ path: 'gone.ts', change: 'deleted' }] }, dir);
    expect(cites[0].ok).toBe(true); // no git history here at all: nothing can disprove the claim
  });
  test('git decides which deletion claims are real', () => {
    const repo = mkdtempSync(join(tmpdir(), 'mikro-deleted-'));
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'gone.ts'), 'a\nb\n');
    Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
    Bun.spawnSync(['git', 'add', '.'], { cwd: repo });
    Bun.spawnSync(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'seed'], { cwd: repo });
    Bun.spawnSync(['git', 'rm', '-q', 'src/gone.ts'], { cwd: repo });
    // The file was really there and is really gone: the citation stands.
    const real = verifyCitations({ files: [{ path: 'src/gone.ts', change: 'deleted' }] }, repo);
    expect(real[0].ok).toBe(true);
    expect(real[0].reason).toBe('absent (deleted)');
    // A glob is not a path: git reads the argument after `--` as a PATHSPEC, so without
    // --literal-pathspecs `src/*.ts` proves the history of src/gone.ts and every shape
    // below passes as the deletion of a file that never existed.
    for (const glob of ['src/*.ts', '*.ts', 'src/?one.ts', 'src/[gh]one.ts', 'src/g*.ts']) {
      const cited = verifyCitations({ files: [{ path: glob, change: 'deleted' }] }, repo);
      expect(cited[0]?.ok).toBe(false);
    }
    // A path git never recorded cannot have been deleted, whatever the answer says.
    // Without this, any fabricated path passes as evidence by declaring itself deleted.
    const invented = verifyCitations({ files: [{ path: 'src/never-existed.ts', change: 'deleted' }] }, repo);
    expect(invented[0].ok).toBe(false);
    expect(invented[0].reason).toContain('git has no record of this path');
  });
});

describe('schemas', () => {
  test('every agent schema rejects an empty object and accepts its own minimal record', () => {
    for (const schema of Object.values(SCHEMAS)) expect(schema.safeParse({}).success).toBe(false);
    const ok = IssueTriage.safeParse({
      issue: 1,
      title: 't',
      type: 'bug',
      area: ['a'],
      summary: 's',
      repro: { present: false },
      candidate_files: [{ path: 'src/x.ts', why: 'w' }],
      lane: 'patch',
      first_question: null,
    });
    expect(ok.success).toBe(true);
  });
});

describe('facts handoff', () => {
  /**
   * A real repository, because every fact is a git read. `gh` is not stubbed —
   * a tmpdir repo has no GitHub remote to resolve, so it fails immediately and
   * contributes nothing, which is exactly the "skip cleanly" path.
   */
  function repo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mikro-facts-call-'));
    mkdirSync(join(dir, 'src', 'lib'), { recursive: true });
    writeFileSync(join(dir, 'src', 'lib', 'sprocket-gate.ts'), 'export const sprocketGate = () => true;\n');
    writeFileSync(join(dir, 'CLAUDE.md'), '- **src/lib/sprocket-gate.ts is the gate** — never bypass it\n');
    Bun.spawnSync(['git', 'init', '-q'], { cwd: dir });
    Bun.spawnSync(['git', 'add', '.'], { cwd: dir });
    Bun.spawnSync(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'seed'], { cwd: dir });
    return dir;
  }

  test('auto infers the mode from the prompt and writes both artifacts beside the ledger', () => {
    const dir = repo();
    const runs = join(dir, '.mikro', 'runs');
    const handoff = prepareFacts('auto', 'Intent: harden the sprocketGate in sprocket-gate.ts', dir, runs, 'run-1');
    expect(handoff?.path).toBe(join(runs, 'facts-run-1.json'));
    expect(handoff?.contextPath).toBe(join(runs, 'facts-run-1.md'));
    expect(handoff?.candidates).toBeGreaterThan(0);
    expect(handoff?.ms).toBeGreaterThanOrEqual(0);
    const json = JSON.parse(readFileSync(handoff?.path ?? '', 'utf8'));
    expect(json.basis.mode).toBe('intent');
    expect(json.candidates.map((c: { path: string }) => c.path)).toContain('src/lib/sprocket-gate.ts');
    // The context file is what mikro loads, and its first line is the data frame
    // the metadata preview shows the model.
    const md = readFileSync(handoff?.contextPath ?? '', 'utf8');
    expect(md.split('\n')[0]).toBe(FACTS_HEADER);
    expect(md).toContain('src/lib/sprocket-gate.ts');
  });

  test('a prompt that implies no mode produces no facts rather than a guess', () => {
    const dir = repo();
    expect(
      prepareFacts('auto', 'Prepare the review of PR #2932', dir, join(dir, '.mikro', 'runs'), 'run-2'),
    ).toBeNull();
  });

  test('an explicit path is handed over as-is, and a missing one is skipped', () => {
    const dir = repo();
    const path = join(dir, 'given-facts.json');
    writeFileSync(path, JSON.stringify({ candidates: [{ path: 'a.ts' }, { path: 'b.ts' }] }));
    const handoff = prepareFacts(path, 'anything at all', dir, join(dir, '.mikro', 'runs'), 'run-3');
    expect(handoff?.contextPath).toBe(path);
    expect(handoff?.candidates).toBe(2);
    expect(prepareFacts(join(dir, 'nope.json'), 'x', dir, join(dir, '.mikro', 'runs'), 'run-4')).toBeNull();
  });

  test('the span carries the candidate count only when facts were handed over', () => {
    const base = {
      agent: 'wish-context',
      runId: 'r',
      traceId: 't',
      attempt: 0,
      startMs: 0,
      endMs: 1,
      model: 'deepseek-api/deepseek-flash',
      iterations: 1,
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0,
      ok: true,
      errors: [],
      tags: {},
      prompt: 'p',
      answer: 'a',
    };
    expect(buildRunSpan({ ...base, factsCandidates: 27 }).attributes['metadata.facts_candidates']).toBe(27);
    expect('metadata.facts_candidates' in buildRunSpan(base).attributes).toBe(false);
  });
});

describe('retained raw', () => {
  const runs = () => join(mkdtempSync(join(tmpdir(), 'mikro-raw-')), '.mikro', 'runs');

  test('a failed attempt keeps the exact bytes, and the row verifies them', () => {
    const dir = runs();
    const raw = 'I could not produce JSON.\nmikro · q · m/m · 1 iteration · 1 in / 2 out · $0.00 · 1.0s · session s';
    const row = persistFailedRaw(dir, 'run-9', 1, raw);
    expect(row?.path).toBe(join(dir, 'raw-run-9-1.txt'));
    expect(row?.truncated).toBe(false);
    expect(row?.bytes).toBe(Buffer.byteLength(raw));
    expect(readFileSync(row?.path ?? '', 'utf8')).toBe(raw);
    expect(row?.sha256).toBe(
      createHash('sha256')
        .update(readFileSync(row?.path ?? ''))
        .digest('hex'),
    );
  });

  test('an empty answer writes nothing', () => {
    expect(persistFailedRaw(runs(), 'run-9', 0, '')).toBeUndefined();
  });

  test('a very long answer is capped, marked, and says so in the row', () => {
    const row = persistFailedRaw(runs(), 'run-9', 0, 'x'.repeat(RAW_CAP_BYTES + 5000));
    expect(row?.truncated).toBe(true);
    expect(row?.bytes).toBe(RAW_CAP_BYTES);
    const text = readFileSync(row?.path ?? '', 'utf8');
    expect(text.endsWith(RAW_TRUNCATION_MARKER)).toBe(true);
    expect(text.startsWith('xxx')).toBe(true);
  });

  test('a write that cannot land is reported, not thrown — the run is never gated on it', () => {
    const blocked = join(mkdtempSync(join(tmpdir(), 'mikro-raw-fail-')), 'runs');
    writeFileSync(blocked, 'not a directory\n');
    expect(persistFailedRaw(blocked, 'run-9', 0, 'something worth keeping')).toBeUndefined();
  });
});

describe('hardening', () => {
  test('the MCP server gets an allowlisted environment, never the whole one', () => {
    process.env.SSH_AUTH_SOCK = '/tmp/sock';
    process.env.GH_TOKEN = 'ghp_secret';
    process.env.MIKRO_TEST_FLAG = '1';
    const env = serverEnv();
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.MIKRO_TEST_FLAG).toBe('1');
    expect(env.PATH).toBeDefined();
    process.env.DEEPSEEK_API_KEY = 'sk-test';
    expect(serverEnv().DEEPSEEK_API_KEY).toBe('sk-test'); // the provider key the caller holds must reach the server
  });
  test('a --dir whose .mikro config differs from the invoking checkout is refused', () => {
    const trusted = mkdtempSync(join(tmpdir(), 'mikro-trusted-'));
    const other = mkdtempSync(join(tmpdir(), 'mikro-other-'));
    mkdirSync(join(trusted, '.mikro'), { recursive: true });
    mkdirSync(join(other, '.mikro'), { recursive: true });
    writeFileSync(join(trusted, '.mikro', 'mikro.yaml'), 'model: a\n');
    writeFileSync(join(other, '.mikro', 'mikro.yaml'), 'model: a\n');
    expect(untrustedConfig(other, trusted)).toBeNull();
    writeFileSync(join(other, '.mikro', 'TOOLS.md'), '## evil\n');
    expect(untrustedConfig(other, trusted)).toMatch(/TOOLS.md differs/);
    expect(untrustedConfig(trusted, trusted)).toBeNull();
  });
  test('an untracked file is never a verified citation', () => {
    const repo = mkdtempSync(join(tmpdir(), 'mikro-untracked-'));
    writeFileSync(join(repo, 'tracked.ts'), 'a\n');
    writeFileSync(join(repo, 'local.ts'), 'a\n');
    Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
    Bun.spawnSync(['git', 'add', 'tracked.ts'], { cwd: repo });
    const cites = verifyCitations({ facts: [{ evidence: 'tracked.ts:1' }, { evidence: 'local.ts:1' }] }, repo);
    expect(cites.find((x) => x.path === 'tracked.ts')?.ok).toBe(true);
    expect(cites.find((x) => x.path === 'local.ts')?.reason).toMatch(/not a tracked file/);
  });
});

describe('containedEnv', () => {
  test('carries the provider key the caller exported, and nothing of the host that the sandbox renames', () => {
    process.env.DEEPSEEK_API_KEY = 'sk-test';
    process.env.SSH_AUTH_SOCK = '/tmp/sock';
    const env = containedEnv({ timeoutMs: 1000, agentsDir: '/repo/.mikro/agents' });
    // providerKeyEnv() answers {} when the caller already holds the key: reading only that
    // source here would have handed the sandbox no key at all for those callers.
    expect(env.DEEPSEEK_API_KEY).toBe('sk-test');
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
    expect(env.PATH).toBeUndefined();
    expect(env.HOME).toBeUndefined();
    expect(env.MIKRO_AGENTS_DIR).toBe('/repo/.mikro/agents');
    expect(env.MIKRO_MCP_RUN_TIMEOUT_MS).toBe('1000');
  });
});

describe('--boundary', () => {
  test('defaults to none: the uncontained path stays the default and the control arm', () => {
    expect(parseBoundaryFlag(['issue-triage', '--prompt', 'x'])).toBe('none');
  });

  test('selects the sandbox when asked for it', () => {
    expect(parseBoundaryFlag(['issue-triage', '--boundary', 'bwrap', '--dir', '.'])).toBe('bwrap');
    expect(parseBoundaryFlag(['--boundary', 'none'])).toBe('none');
  });

  test('a typo is refused, never treated as off — a boundary that reports itself on must be on', () => {
    for (const bad of [['--boundary', 'bwarp'], ['--boundary', 'docker'], ['--boundary']]) {
      expect(() => parseBoundaryFlag(bad)).toThrow(BoundaryError);
      try {
        parseBoundaryFlag(bad);
      } catch (error) {
        expect((error as BoundaryError).failure).toBe('bad-spec');
      }
    }
  });
});

describe('facts inside the boundary', () => {
  /**
   * A boundary that records what it was asked to run and answers with a command that
   * fails immediately. No bwrap, no provider key, no network: what is under test is
   * the ORDER — the boundary opens first, and every facts command is handed to it.
   */
  function fakeBoundary(): BoundarySession & { commands: string[][]; closed: boolean } {
    const session = {
      mode: 'bwrap' as const,
      spec: null as unknown as BoundarySession['spec'],
      commands: [] as string[][],
      closed: false,
      argv(command: string[]) {
        session.commands.push(command);
        return ['/bin/false'];
      },
      env: {} as Record<string, string>,
      counts: () => ({ allowed: 0, denied: 0 }),
      close: async () => {
        session.closed = true;
      },
    };
    return session;
  }

  function trustedRepo(): { root: string; agentsDir: string } {
    const root = mkdtempSync(join(tmpdir(), 'mikro-order-'));
    const agentsDir = join(root, '.mikro', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    return { root, agentsDir };
  }

  test('the boundary opens BEFORE the facts, and every facts command runs inside it', async () => {
    // Both are already cached by the suites above; set them so this test can never
    // reach the host's gate-env.sh or `gh auth token` on its own.
    process.env.DEEPSEEK_API_KEY = 'sk-test';
    process.env.GH_TOKEN = 'ghp_test';
    const { root, agentsDir } = trustedRepo();
    const session = fakeBoundary();
    let opened: OpenBoundaryOptions | null = null;
    const result = await runAgent({
      agent: 'issue-triage',
      // Issue mode: the one that would otherwise put a credentialed host `gh` call
      // and a host `git` over the tree under `--dir` outside the sandbox.
      prompt: 'Triage issue #2942',
      dir: root,
      agentsDir,
      facts: 'auto',
      boundary: 'bwrap',
      retries: 1,
      phoenix: false,
      ledger: false,
      openBoundary: async (options) => {
        opened = options;
        return session;
      },
    });

    const first = session.commands.findIndex((c) => c[0] === 'mikro');
    expect(first).toBeGreaterThan(0); // something ran inside the boundary before the runtime did
    expect(session.commands[0][0]).toBe('git'); // and the first of those was the facts scan
    expect(session.commands.slice(0, first).every((c) => c[0] === 'git')).toBe(true);
    expect(session.commands.some((c) => c[0] === 'gh')).toBe(false);
    // Facts are computed ONCE: after the first attempt, nothing but the runtime runs again.
    expect(session.commands.slice(first).every((c) => c[0] === 'mikro')).toBe(true);
    expect(session.commands.filter((c) => c[0] === 'mikro')).toHaveLength(2); // retries: 1
    // The context file lives under the trusted root and is bound read-only from the start.
    expect((opened as unknown as OpenBoundaryOptions).readable).toEqual([
      join(root, '.mikro', 'runs', `facts-${result.runId}.md`),
    ]);
    expect(existsSync(join(root, '.mikro', 'runs', `facts-${result.runId}.md`))).toBe(true);
    expect(JSON.parse(readFileSync(join(root, '.mikro', 'runs', `facts-${result.runId}.json`), 'utf8')).basis.gh).toBe(
      'skipped-boundary',
    );
    // The runtime was /bin/false, so the run failed — and the boundary still closed.
    expect(result.ok).toBe(false);
    expect(result.boundary).toBe('bwrap');
    expect(session.closed).toBe(true);
  });

  test('with no facts option the boundary binds nothing extra', async () => {
    const { root, agentsDir } = trustedRepo();
    const session = fakeBoundary();
    let opened: OpenBoundaryOptions | null = null;
    await runAgent({
      agent: 'issue-triage',
      prompt: 'Triage issue #2942',
      dir: root,
      agentsDir,
      boundary: 'bwrap',
      retries: 0,
      phoenix: false,
      ledger: false,
      openBoundary: async (options) => {
        opened = options;
        return session;
      },
    });
    expect((opened as unknown as OpenBoundaryOptions).readable).toEqual([]);
    expect(session.commands.every((c) => c[0] === 'mikro')).toBe(true);
  });

  test('the contained runner wraps every argv in the session and refuses gh', () => {
    const session = fakeBoundary();
    const runner = boundaryFactsRunner(session);
    expect(runner.canRunGh).toBe(false);
    const ran = runner.run(['git', 'ls-files'], '/anywhere');
    expect(session.commands).toEqual([['git', 'ls-files']]);
    expect(ran).toEqual({ ok: false, out: '' }); // /bin/false: no output, not ok
  });

  test('the context path a boundary binds is the path prepareFacts writes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mikro-ctx-'));
    const runs = join(dir, '.mikro', 'runs');
    Bun.spawnSync(['git', 'init', '-q'], { cwd: dir });
    const planned = factsContextPath('auto', runs, 'run-9');
    expect(prepareFacts('auto', 'Intent: anything at all', dir, runs, 'run-9')?.contextPath).toBe(planned);
    // A caller-supplied file is bound at the path it already has.
    const given = join(dir, 'given.json');
    writeFileSync(given, '{}');
    expect(factsContextPath(given, runs, 'run-9')).toBe(given);
    expect(prepareFacts(given, 'x', dir, runs, 'run-9')?.contextPath).toBe(given);
  });
});

describe('prices', () => {
  const yaml = readFileSync(join(import.meta.dir, '..', '..', '.mikro', 'mikro.yaml'), 'utf8');
  const COST = /^ {8}cost: \{ input: ([0-9.]+), output: ([0-9.]+) \}$/m;
  const declaredCost = (model: string): { input: number; output: number } | null => {
    const at = yaml.indexOf(`\n      ${model}:\n`);
    const m = at === -1 ? null : COST.exec(yaml.slice(at));
    return m ? { input: Number(m[1]), output: Number(m[2]) } : null;
  };

  test('the basis stamped on every ledger row and Phoenix span names the priced list', () => {
    expect(PRICE_BASIS).toBe('deepseek-list-2026-09-18-peak');
  });

  test("mikro.yaml declares DeepSeek's peak cache-miss list price per million", () => {
    expect(declaredCost('deepseek-flash')).toEqual({ input: 0.3, output: 1.2 });
    expect(declaredCost('deepseek-v4-pro')).toEqual({ input: 1.32, output: 3.96 });
  });
});
