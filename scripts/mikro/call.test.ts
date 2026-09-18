import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyResolutions,
  extractJson,
  parseFooter,
  serverEnv,
  stripFooter,
  untrustedConfig,
  verifyCitations,
} from './call';
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
  test('a deleted file in review-prep is not a failed citation', () => {
    const cites = verifyCitations({ files: [{ path: 'gone.ts', change: 'deleted' }] }, dir);
    expect(cites[0].ok).toBe(true);
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
