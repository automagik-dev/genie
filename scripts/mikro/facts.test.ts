import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FACTS_HEADER,
  FACTS_MAX_BYTES,
  type Facts,
  type FactsRunner,
  buildFacts,
  enforceBudget,
  extractKeywords,
  hostFactsRunner,
  inferFactsMode,
  renderFacts,
} from './facts';

/**
 * Real git repositories in a tmpdir, never mocks: every fact this script
 * computes comes out of `git ls-files`, `git grep`, `git log` and `git diff`,
 * so a mocked git would test nothing but the mock.
 */
const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(dir: string, ...args: string[]): void {
  const p = Bun.spawnSync(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${p.stderr.toString()}`);
}

function write(dir: string, path: string, body: string): void {
  const abs = join(dir, path);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, body);
}

/**
 * A miniature genie: a source file and a sibling that share a distinctive
 * symbol, the pinning test that names one of them, a CLAUDE.md rule, an
 * INDEX.md entry, an untracked file and a wish document.
 */
function seedRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mikro-facts-'));
  made.push(dir);
  git(dir, 'init', '-q');
  write(dir, 'src/lib/widget-forge.ts', 'export const forgeWidget = () => "sprocketize";\n// sprocketize twice\n');
  write(dir, 'src/lib/widget-store.ts', 'import { forgeWidget } from "./widget-forge";\n// sprocketize here too\n');
  write(dir, 'src/lib/unrelated.ts', 'export const nothing = 1;\n');
  write(dir, 'src/lib/widget-forge.test.ts', 'import "./widget-forge";\ntest("forgeWidget", () => {});\n');
  write(dir, 'scripts/forge-parity.test.ts', 'const p = "widget-forge";\n');
  write(
    dir,
    'CLAUDE.md',
    '# rules\n\n- the forge is load-bearing\n- **src/lib/widget-forge.ts owns sprocketize** — never inline it\n',
  );
  write(dir, 'AGENTS.md', '# shared\n\n- widget-store.ts is a reader, never a writer\n');
  write(
    dir,
    '.genie/INDEX.md',
    '## Raw\n\n- [widget-forge](brainstorms/widget-forge/DRAFT.md) — sprocketize lives in widget-store.ts\n',
  );
  write(dir, '.genie/wishes/sprocketize-forge/WISH.md', '# WISH: sprocketize-forge\n\nThe forge wish.\n');
  write(dir, '.genie/brainstorms/widget-forge/DESIGN.md', '# DESIGN: widget-forge\n\nsprocketize decided here.\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'seed the forge');
  write(dir, 'src/lib/local-only.ts', '// sprocketize but untracked\n');
  return dir;
}

describe('extractKeywords', () => {
  test('keeps locators, drops stopwords and short words, and is stable', () => {
    const kw = extractKeywords('Make sure the existingNames guard in workfly.js never rests on the reader');
    expect(kw).toContain('existingNames');
    expect(kw).toContain('workfly.js');
    expect(kw).not.toContain('sure');
    expect(kw).not.toContain('the');
    expect(kw).not.toContain('never');
    expect(kw.indexOf('existingNames')).toBeLessThan(kw.indexOf('reader'));
    expect(extractKeywords('Make sure the existingNames guard in workfly.js never rests on the reader')).toEqual(kw);
  });
  test('honours the cap', () => {
    expect(extractKeywords('alpha bravo charlie delta echo foxtrot golf hotel india', 3)).toHaveLength(3);
  });
});

describe('inferFactsMode', () => {
  test('reads the three modes a microagent prompt can imply', () => {
    expect(inferFactsMode('Triage issue #2941')).toEqual({ issue: 2941 });
    expect(inferFactsMode('Intent: narrow the denylist so it never matches a test')).toEqual({
      intent: 'narrow the denylist so it never matches a test',
    });
    expect(inferFactsMode('Prepare the review of commit a1b2c3d4 against origin/dev')).toEqual({
      range: 'origin/dev..a1b2c3d4',
    });
  });
  test('a range wins over the issue number it mentions, and an intent over a bare number', () => {
    expect(inferFactsMode('Review of issue #12 fix: commit deadbeef1 against main')).toEqual({
      range: 'main..deadbeef1',
    });
    expect(inferFactsMode('Intent: fix issue #2921 — the guard')).toEqual({ intent: 'fix issue #2921 — the guard' });
  });
  test('a PR prompt names no base, so it implies no mode rather than a guessed one', () => {
    expect(inferFactsMode('Prepare the review of PR #2932')).toBeNull();
    expect(inferFactsMode('something else entirely')).toBeNull();
  });
});

describe('buildFacts — candidates', () => {
  test('ranks by keyword coverage, records why, and never lists a test or a planning document', () => {
    const dir = seedRepo();
    const facts = buildFacts({ dir, intent: 'sprocketize in widget-forge.ts needs a second forgeWidget', gh: false });
    const paths = facts.candidates.map((c) => c.path);
    expect(paths[0]).toBe('src/lib/widget-forge.ts');
    expect(paths).toContain('src/lib/widget-store.ts');
    expect(paths).not.toContain('src/lib/unrelated.ts');
    expect(paths.some((p) => p.endsWith('.test.ts'))).toBe(false);
    expect(paths.some((p) => p.startsWith('.genie/'))).toBe(false);
    const forge = facts.candidates[0];
    expect(forge.why).toContain('keyword');
    expect(forge.hits).toBeGreaterThan(0);
    expect(forge.matched).toContain('sprocketize');
  });
  test('an untracked file is never a candidate — it could never be cited either', () => {
    const dir = seedRepo();
    const facts = buildFacts({ dir, intent: 'the sprocketize path', gh: false });
    expect(facts.candidates.map((c) => c.path)).not.toContain('src/lib/local-only.ts');
  });
  test('every path in the output is tracked at basis.sha', () => {
    const dir = seedRepo();
    const facts = buildFacts({ dir, intent: 'sprocketize the widget-forge reader', gh: false });
    const tracked = new Set(
      Bun.spawnSync(['git', 'ls-files'], { cwd: dir }).stdout.toString().split('\n').filter(Boolean),
    );
    const every = [
      ...facts.candidates.map((c) => c.path),
      ...Object.keys(facts.tests),
      ...Object.values(facts.tests).flat(),
      ...facts.gotchas.map((g) => g.path),
      ...facts.recent.flatMap((c) => c.files),
      ...facts.related.wishes,
      ...facts.related.brainstorms,
    ];
    expect(every.length).toBeGreaterThan(0);
    for (const path of every) expect(tracked.has(path)).toBe(true);
    expect(facts.basis.sha).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('buildFacts — the rest of the record', () => {
  test('pinning tests are the tests that name a candidate, listed under it and not as candidates', () => {
    const dir = seedRepo();
    const facts = buildFacts({ dir, intent: 'sprocketize in widget-forge.ts', gh: false });
    expect(facts.tests['src/lib/widget-forge.ts']).toEqual([
      'scripts/forge-parity.test.ts',
      'src/lib/widget-forge.test.ts',
    ]);
    expect(facts.candidates.find((c) => c.path === 'src/lib/widget-forge.ts')?.why).toContain('test-names');
  });
  test('gotchas are the CLAUDE.md / AGENTS.md lines that name a candidate, with citable line numbers', () => {
    const dir = seedRepo();
    const facts = buildFacts({ dir, intent: 'sprocketize in widget-forge.ts and widget-store.ts', gh: false });
    const forge = facts.gotchas.find((g) => g.path === 'src/lib/widget-forge.ts' && g.source === 'CLAUDE.md');
    expect(forge?.line).toBe(4);
    expect(forge?.text).toContain('owns sprocketize');
    expect(facts.gotchas.find((g) => g.source === 'AGENTS.md')?.path).toBe('src/lib/widget-store.ts');
    expect(facts.gotchas.every((g) => g.path !== 'CLAUDE.md' && g.path !== 'AGENTS.md')).toBe(true);
  });
  test('a tracked .claude/rules/*.md is a gotcha source; an untracked one never loads', () => {
    // Before any rule exists this is a no-op: only the two contract files load.
    const dir = seedRepo();
    const before = buildFacts({ dir, intent: 'sprocketize in widget-forge.ts', gh: false });
    expect(before.gotchas.every((g) => g.source === 'CLAUDE.md' || g.source === 'AGENTS.md')).toBe(true);
    write(
      dir,
      '.claude/rules/widget-forge.md',
      '---\npaths:\n  - src/lib/widget-forge.ts\n---\n\n- **widget-forge.ts never inlines sprocketize** — scoped rule\n',
    );
    write(dir, '.claude/rules/local-note.md', '- local note naming src/lib/widget-forge.ts\n');
    git(dir, 'add', '.claude/rules/widget-forge.md');
    git(dir, 'commit', '-qm', 'add a scoped rule');
    const facts = buildFacts({ dir, intent: 'sprocketize in widget-forge.ts', gh: false });
    // The citation lands on rule text, past the frontmatter whose `paths:` glob
    // also names the candidate (line 3), and the untracked sibling never loads.
    const scoped = facts.gotchas.find(
      (g) => g.path === 'src/lib/widget-forge.ts' && g.source === '.claude/rules/widget-forge.md',
    );
    expect(scoped?.line).toBe(6);
    expect(scoped?.text).toContain('never inlines sprocketize');
    expect(facts.gotchas.some((g) => g.source === '.claude/rules/local-note.md')).toBe(false);
    expect(facts.gotchas.some((g) => g.source === 'CLAUDE.md')).toBe(true); // the floor still loads beside it
  });
  test('recent commits, related prior work and an INDEX line are all recorded', () => {
    const dir = seedRepo();
    const facts = buildFacts({ dir, intent: 'sprocketize the forge', gh: false });
    expect(facts.recent[0].subject).toBe('seed the forge');
    expect(facts.recent[0].files.length).toBeGreaterThan(0);
    expect(facts.related.wishes).toContain('.genie/wishes/sprocketize-forge/WISH.md');
    expect(facts.related.brainstorms).toContain('.genie/brainstorms/widget-forge/DESIGN.md');
    expect(facts.related.prs).toEqual([]); // gh is off: skipped cleanly, never invented
    // `.genie/INDEX.md` names widget-store.ts on a line that carries the keyword.
    expect(facts.candidates.find((c) => c.path === 'src/lib/widget-store.ts')?.why).toContain('index-link');
  });
  test('range mode seeds from the diff and marks what changed', () => {
    const dir = seedRepo();
    write(dir, 'src/lib/widget-forge.ts', 'export const forgeWidget = () => "sprocketize2";\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'reforge');
    const facts = buildFacts({ dir, range: 'HEAD~1..HEAD', gh: false });
    expect(facts.basis.mode).toBe('range');
    const forge = facts.candidates.find((c) => c.path === 'src/lib/widget-forge.ts');
    expect(forge?.why).toContain('changed');
    expect(facts.keywords.some((k) => k.includes('widget-forge'))).toBe(true);
  });
  test('issue mode without gh still locates by the issue number itself', () => {
    const dir = seedRepo();
    write(dir, '.genie/INDEX.md', '## Raw\n\n- [forge](brainstorms/widget-forge/DESIGN.md) — #2927 sprocketize\n');
    write(dir, 'src/lib/widget-forge.ts', '// see #2927 for the sprocketize contract\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'reference the issue');
    const facts = buildFacts({ dir, issue: 2927, gh: false });
    expect(facts.basis.mode).toBe('issue');
    expect(facts.keywords).toContain('#2927');
    expect(facts.candidates.map((c) => c.path)).toContain('src/lib/widget-forge.ts');
  });
});

describe('determinism and bounds', () => {
  test('two runs over the same tree are byte-identical apart from generatedAt', () => {
    const dir = seedRepo();
    const options = { dir, intent: 'sprocketize the widget-forge reader and its store', gh: false };
    const a = buildFacts(options);
    const b = buildFacts(options);
    expect(a.basis.generatedAt).not.toBe('');
    expect(JSON.stringify({ ...a, basis: { ...a.basis, generatedAt: '' } })).toBe(
      JSON.stringify({ ...b, basis: { ...b.basis, generatedAt: '' } }),
    );
  });
  test('the real record stays inside the 64 KB bound', () => {
    const dir = seedRepo();
    const facts = buildFacts({ dir, intent: 'sprocketize the widget-forge reader', gh: false });
    expect(Buffer.byteLength(JSON.stringify(facts), 'utf8')).toBeLessThanOrEqual(FACTS_MAX_BYTES);
    expect(facts.truncated).toEqual({});
  });
  test('an oversized record is truncated from the least load-bearing end and says so', () => {
    const big = (n: number, size: number) => 'x'.repeat(size).repeat(1).slice(0, size) + n;
    const facts: Facts = {
      basis: { sha: 'a'.repeat(40), generatedAt: 'now', mode: 'intent' },
      keywords: ['forge'],
      candidates: Array.from({ length: 40 }, (_, i) => ({
        path: `src/lib/${big(i, 400)}.ts`,
        why: ['keyword'],
        hits: 40 - i,
        matched: ['forge'],
      })),
      tests: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`src/lib/${big(i, 600)}.ts`, [big(i, 600)]])),
      gotchas: Array.from({ length: 20 }, (_, i) => ({
        path: `src/lib/${big(i, 200)}.ts`,
        source: 'CLAUDE.md' as const,
        line: i + 1,
        text: big(i, 320),
      })),
      recent: Array.from({ length: 15 }, (_, i) => ({
        sha: `${i}`.repeat(7),
        subject: big(i, 160),
        files: [big(i, 400)],
      })),
      related: { prs: [], wishes: [], brainstorms: [] },
      truncated: {},
    };
    expect(Buffer.byteLength(JSON.stringify(facts), 'utf8')).toBeGreaterThan(FACTS_MAX_BYTES);
    const bounded = enforceBudget(facts);
    expect(Buffer.byteLength(JSON.stringify(bounded), 'utf8')).toBeLessThanOrEqual(FACTS_MAX_BYTES);
    expect(bounded.truncated.recent).toBeGreaterThan(0); // history goes first
    expect(bounded.candidates.length).toBeGreaterThan(0); // the ranking is never emptied
  });
  test('a tiny ceiling still leaves one candidate and counts every drop', () => {
    const facts: Facts = {
      basis: { sha: 'b'.repeat(40), generatedAt: 'now', mode: 'issue' },
      keywords: [],
      candidates: [
        { path: 'a.ts', why: ['keyword'], hits: 2, matched: ['x'] },
        { path: 'b.ts', why: ['keyword'], hits: 1, matched: ['x'] },
      ],
      tests: { 'a.ts': ['a.test.ts'] },
      gotchas: [{ path: 'a.ts', source: 'CLAUDE.md', line: 1, text: 'rule' }],
      recent: [{ sha: 'abc1234', subject: 's', files: ['a.ts'] }],
      related: { prs: [], wishes: [], brainstorms: [] },
      truncated: {},
    };
    const bounded = enforceBudget(facts, 300);
    expect(bounded.candidates).toHaveLength(1);
    expect(bounded.recent).toHaveLength(0);
    expect(bounded.truncated).toMatchObject({ recent: 1, candidates: 1 });
  });
});

describe('the injected runner', () => {
  /** Records every argv it is asked to run, then answers exactly as the host runner would. */
  function recording(canRunGh: boolean): FactsRunner & { argvs: string[][] } {
    const argvs: string[][] = [];
    return {
      argvs,
      canRunGh,
      run(argv, dir) {
        argvs.push(argv);
        return hostFactsRunner.run(argv, dir);
      },
    };
  }

  test('a runner that cannot reach GitHub never issues a gh argv, and the record says why', () => {
    const dir = seedRepo();
    // Issue mode is the one that would call `gh` twice — the issue body and the related
    // PRs. Under `--boundary bwrap` that would be the HOST's gh, with the host's
    // credential, outside the sandbox and outside the egress ledger.
    const runner = recording(false);
    const facts = buildFacts({ dir, issue: 2927, runner });
    expect(runner.argvs.length).toBeGreaterThan(0);
    expect(runner.argvs.some((argv) => argv[0] === 'gh')).toBe(false);
    expect(runner.argvs.every((argv) => argv[0] === 'git')).toBe(true);
    expect(facts.basis.gh).toBe('skipped-boundary');
    expect(facts.related.prs).toEqual([]); // skipped, never invented
  });

  test('the contained record differs from the `--no-gh` host record in nothing but basis.gh', () => {
    const dir = seedRepo();
    const options = { dir, intent: 'sprocketize the widget-forge reader', now: 'fixed' };
    const contained = buildFacts({ ...options, runner: recording(false) });
    const hostNoGh = buildFacts({ ...options, gh: false });
    expect(hostNoGh.basis.gh).toBe('off');
    expect(JSON.stringify({ ...contained, basis: { ...contained.basis, gh: 'x' } })).toBe(
      JSON.stringify({ ...hostNoGh, basis: { ...hostNoGh.basis, gh: 'x' } }),
    );
  });

  test('the default runner is the host spawn, and its gh half is named `host`', () => {
    const dir = seedRepo();
    // `gh` in a tmpdir repo has no remote to resolve, so it fails and contributes
    // nothing — the source is still `host`, because that is where it was tried.
    expect(buildFacts({ dir, intent: 'the sprocketize forge' }).basis.gh).toBe('host');
    expect(buildFacts({ dir, intent: 'the sprocketize forge', gh: false }).basis.gh).toBe('off');
  });

  test('a runner that can run nothing at all yields an empty record, never a throw', () => {
    const dir = seedRepo();
    const dead: FactsRunner = { canRunGh: true, run: () => ({ ok: false, out: '' }) };
    const facts = buildFacts({ dir, intent: 'sprocketize the forge', runner: dead });
    expect(facts.basis.sha).toBe('unknown');
    expect(facts.candidates).toEqual([]);
  });
});

describe('renderFacts', () => {
  test('frames the JSON as data, header first', () => {
    const dir = seedRepo();
    const text = renderFacts(buildFacts({ dir, intent: 'the sprocketize forge', gh: false }));
    expect(text.split('\n')[0]).toBe(FACTS_HEADER);
    expect(text).toContain('```json');
    const body = text.slice(text.indexOf('```json') + 8, text.lastIndexOf('```'));
    expect(JSON.parse(body).basis.mode).toBe('intent');
  });
});
