/**
 * The dialect against the repository's own catalog.
 *
 * `.claude/workflows/` is the fixture: if someone lands a script using a hook the
 * engine cannot honour, these tests fail here rather than in a run that has
 * already spent agents.
 *
 * The removal counts are cross-checked data, not guesses: an independent
 * TypeScript-AST transform (wish `dsh-workflow-fork`, Group 0, 2026-09-19) removed
 * the same 35 `effort` options from the same nine files. Byte equality with that
 * transform is deliberately NOT asserted — the two removers consume a different
 * adjacent comma, which is semantically identical. `evidence-gate` (2026-09-22) is
 * the tenth file and adds 3 more, taking the catalog total to 38; its count was
 * read from this transform's own report rather than from the AST cross-check, which
 * predates that file.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DialectError, compiles, scanUnsupported, splitMeta, stripDeferredOptions } from './dialect';

const CATALOG = join(import.meta.dir, '..', '..', '..', '.claude', 'workflows');

/** `effort` options removed per catalog file, from the AST cross-check. */
const EXPECTED_REMOVALS: Record<string, number> = {
  council: 0,
  'observability-review': 0,
  'pm-ledger-verify': 1,
  'docs-audit': 3,
  'research-sweep': 4,
  'skill-audit-sweep': 4,
  'skill-intake': 5,
  'evidence-gate': 3,
  wish: 9,
  workfly: 9,
};

const catalogFiles = readdirSync(CATALOG)
  .filter((file) => file.endsWith('.js'))
  .sort();

describe('the catalog', () => {
  test('is the fixture this suite expects', () => {
    expect(catalogFiles.length).toBe(Object.keys(EXPECTED_REMOVALS).length);
    expect(catalogFiles.map((file) => file.slice(0, -3)).sort()).toEqual(Object.keys(EXPECTED_REMOVALS).sort());
  });

  for (const file of catalogFiles) {
    const stem = file.slice(0, -3);
    const text = readFileSync(join(CATALOG, file), 'utf8');

    test(`${stem}: meta splits off, body transforms and compiles`, () => {
      const { meta, body } = splitMeta(text);
      expect(meta.name).toBe(stem);
      expect(typeof meta.description).toBe('string');
      const stripped = stripDeferredOptions(body);
      expect(stripped).toBeDefined();
      expect(stripped?.removed.length).toBe(EXPECTED_REMOVALS[stem]);
      expect(compiles(stripped?.script ?? '')).toBe(true);
      expect(() => scanUnsupported(stripped?.script ?? '')).not.toThrow();
    });
  }

  test('a schema field named `effort` survives the transform', () => {
    // workfly defines `effort: enumOf([...])` and `effort: str` as schema fields;
    // docs-audit carries `effort` on each SURFACES entry. Those are data.
    for (const [stem, needle] of [
      ['workfly', 'effort: enumOf'],
      ['docs-audit', "effort: 'medium'"],
    ] as const) {
      const { body } = splitMeta(readFileSync(join(CATALOG, `${stem}.js`), 'utf8'));
      expect(stripDeferredOptions(body)?.script).toContain(needle);
    }
  });
});

describe('splitMeta', () => {
  test('reads a pure literal without evaluating it', () => {
    const { meta, body } = splitMeta(
      `export const meta = { name: 'x', description: 'y', phases: [{ title: 'A' }] }\nreturn 1`,
    );
    expect(meta).toEqual({ name: 'x', description: 'y', phases: [{ title: 'A' }] });
    expect(body.trim()).toBe('return 1');
  });

  test('refuses a computed meta instead of running it', () => {
    expect(() => splitMeta(`export const meta = { name: nameOf(), description: 'y' }\nreturn 1`)).toThrow(DialectError);
  });

  test('refuses a file with no meta block', () => {
    expect(() => splitMeta('return 1')).toThrow(/no `export const meta/);
  });

  test('refuses a meta without a description', () => {
    expect(() => splitMeta(`export const meta = { name: 'x' }\nreturn 1`)).toThrow(/name.*description/);
  });
});

describe('stripDeferredOptions', () => {
  const cases: Array<[string, string, number]> = [
    ['the only option', `const r = await agent('go', { effort: 'high' })\nreturn r`, 1],
    ['after another option', `const r = await agent('go', { label: 'a', effort: 'high' })\nreturn r`, 1],
    ['before another option', `const r = await agent('go', { effort: 'high', label: 'a' })\nreturn r`, 1],
    ['with a trailing comma', `const r = await agent('go', { label: 'a', effort: 'high', })\nreturn r`, 1],
    [
      'after a spread',
      `const r = await agent('go', { label: 'a', ...(M ? { model: M } : {}), effort: 'low' })\nreturn r`,
      1,
    ],
    [
      'in several calls',
      `const a = await agent('one', { effort: 'low' })\nconst b = await agent('two', { effort: 'high' })\nreturn { a, b }`,
      2,
    ],
    ['when there is nothing to remove', `const r = await agent('go', { label: 'a' })\nreturn r`, 0],
    [
      'when a schema field is named effort',
      `const S = { effort: enumOf(['low']) }\nconst r = await agent('go', { label: 'a', schema: S })\nreturn r`,
      0,
    ],
    [
      'inside a template-heavy body',
      'const q = `a ${fn(1)} b`\nconst r = await agent(q, { effort: "low" })\nreturn r',
      1,
    ],
    [
      'beside a regex literal',
      `const re = /^[a-z]+$/\nconst r = await agent('go', { label: 'a', effort: 'low' })\nreturn r`,
      1,
    ],
  ];

  for (const [label, body, expected] of cases) {
    test(`removes ${expected} when the option is ${label}`, () => {
      const result = stripDeferredOptions(body);
      expect(result).toBeDefined();
      expect(result?.removed.length).toBe(expected);
      expect(compiles(result?.script ?? '')).toBe(true);
    });
  }

  test('ignores `agent(` in a prompt, a comment and a string', () => {
    const body = [
      '// call agent(prompt, { effort: "high" }) to delegate',
      "const prompt = 'pass effort: 1 to agent(x, { effort: 'high' })?'",
      'const r = await agent(prompt, { label: "a" })',
      'return r',
    ].join('\n');
    const result = stripDeferredOptions(body);
    expect(result?.removed.length).toBe(0);
  });

  test('refuses an option this engine does not accept, naming it', () => {
    const diagnostics: string[] = [];
    expect(stripDeferredOptions(`await agent('go', { isolation: 'worktree' })`, diagnostics)).toBeUndefined();
    expect(diagnostics.join(' ')).toContain('isolation');
  });

  test('refuses a body that stops compiling', () => {
    expect(stripDeferredOptions(`await agent('go', { effort: 'high'`)).toBeUndefined();
  });

  test('reports why it refused', () => {
    const diagnostics: string[] = [];
    stripDeferredOptions(`await agent('go', { isolation: 'worktree' })`, diagnostics);
    expect(diagnostics.length).toBe(1);
    expect(diagnostics[0]).toMatch(/line 1/);
  });
});

describe('scanUnsupported', () => {
  for (const hook of ['budget', 'workflow', 'isolation', 'agentType'] as const) {
    test(`refuses ${hook}() and says where`, () => {
      expect(() => scanUnsupported(`const x = 1\nconst b = ${hook}({ a: 1 })\nreturn b`)).toThrow(DialectError);
      expect(() => scanUnsupported(`const x = 1\nconst b = ${hook}({ a: 1 })\nreturn b`)).toThrow(/line 2/);
    });
  }

  test('does not fire on prose or a similar identifier', () => {
    expect(() =>
      scanUnsupported('// call budget(x) only on Claude Code\nconst budgetable = 1\nreturn budgetable'),
    ).not.toThrow();
  });
});
