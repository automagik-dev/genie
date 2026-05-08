import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lintFindOrCreateAgent } from './lint-find-or-create-agent.ts';

describe('lint-find-or-create-agent guard', () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'lint-foc-agent-'));
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  test('synthetic fixture with a 3-arg legacy caller fails the guard', async () => {
    await writeFile(
      join(workdir, 'bad.ts'),
      `
import * as registry from './foo';
export async function bad() {
  await registry.findOrCreateAgent('quickie', 'genie', 'engineer');
}
`,
    );

    const findings = lintFindOrCreateAgent(workdir);
    expect(findings.length).toBe(1);
    expect(findings[0].path).toBe('bad.ts');
    expect(findings[0].snippet).toContain('findOrCreateAgent');
  });

  test('fixture passes once reportsTo is added', async () => {
    await writeFile(
      join(workdir, 'good.ts'),
      `
import * as registry from './foo';
export async function good() {
  await registry.findOrCreateAgent('quickie', 'genie', {
    role: 'engineer',
    reportsTo: registry.resolveSpawnOwner() ?? undefined,
  });
}
`,
    );

    const findings = lintFindOrCreateAgent(workdir);
    expect(findings.length).toBe(0);
  });

  test('test files are exempt', async () => {
    await writeFile(
      join(workdir, 'something.test.ts'),
      `
import * as registry from './foo';
test('legacy', async () => {
  await registry.findOrCreateAgent('quickie', 'genie', 'engineer');
});
`,
    );

    const findings = lintFindOrCreateAgent(workdir);
    expect(findings.length).toBe(0);
  });

  test('function definition itself does not trip the guard', async () => {
    await writeFile(
      join(workdir, 'agent-registry.ts'),
      `
export async function findOrCreateAgent(name: string, team: string, role?: string) {
  return { name, team, role };
}
`,
    );

    const findings = lintFindOrCreateAgent(workdir);
    expect(findings.length).toBe(0);
  });

  test('type re-export and deps wiring do not trip the guard', async () => {
    await writeFile(
      join(workdir, 'session.ts'),
      `
import * as registry from './foo';
export const _deps = {
  findOrCreateAgent: registry.findOrCreateAgent as typeof registry.findOrCreateAgent,
};
`,
    );

    const findings = lintFindOrCreateAgent(workdir);
    expect(findings.length).toBe(0);
  });

  test('comment mentions are ignored', async () => {
    await writeFile(
      join(workdir, 'doc.ts'),
      `
// The spawn pipeline calls findOrCreateAgent(name, team, role) on every spawn.
// Without reportsTo, kind defaults to 'permanent'.
export const x = 1;
`,
    );

    const findings = lintFindOrCreateAgent(workdir);
    expect(findings.length).toBe(0);
  });

  test('live src/ tree passes the guard', () => {
    const srcRoot = new URL('../src', import.meta.url).pathname;
    const findings = lintFindOrCreateAgent(srcRoot);
    if (findings.length > 0) {
      const detail = findings.map((f) => `  ${f.path}:${f.line}: ${f.snippet}`).join('\n');
      throw new Error(`Live src tree has ${findings.length} unguarded findOrCreateAgent caller(s):\n${detail}`);
    }
    expect(findings.length).toBe(0);
  });
});
