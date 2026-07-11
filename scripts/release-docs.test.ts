import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');

function read(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), 'utf8');
}

interface ReviewerProfile {
  approval_policy?: unknown;
  default_permissions?: unknown;
  sandbox_mode?: unknown;
  sandbox_workspace_write?: unknown;
  permissions?: Record<string, { extends?: unknown; filesystem?: Record<string, unknown>; workspace_roots?: unknown }>;
}

function reviewerPermissionViolations(profile: ReviewerProfile): string[] {
  const violations: string[] = [];
  if (profile.approval_policy !== 'never') violations.push('approval policy must be never');
  if (profile.default_permissions !== 'genie-reviewer-temp') violations.push('named profile must be selected');
  if (profile.sandbox_mode !== undefined) violations.push('legacy sandbox mode must not override the named profile');
  if (profile.sandbox_workspace_write !== undefined) violations.push('legacy workspace-write grants are forbidden');
  const names = Object.keys(profile.permissions ?? {});
  if (names.length !== 1 || names[0] !== 'genie-reviewer-temp') violations.push('unexpected permission profile');
  const selected = profile.permissions?.['genie-reviewer-temp'];
  if (selected?.extends !== ':read-only') violations.push('profile must extend :read-only');
  if (selected?.workspace_roots !== undefined) violations.push('workspace roots are forbidden');
  const filesystem = selected?.filesystem ?? {};
  const entries = Object.entries(filesystem).sort(([left], [right]) => left.localeCompare(right));
  if (
    JSON.stringify(entries) !==
    JSON.stringify([
      [':slash_tmp', 'write'],
      [':tmpdir', 'write'],
    ])
  ) {
    violations.push('only :tmpdir and :slash_tmp may be writable');
  }
  return violations;
}

function buildHelperInputs(): string[] {
  const pending = [...read('scripts/build-binary.sh').matchAll(/scripts\/([a-z0-9-]+\.ts)/g)].map(
    (match) => `scripts/${match[1]}`,
  );
  const found = new Set<string>();
  while (pending.length > 0) {
    const relativePath = pending.shift();
    if (!relativePath || found.has(relativePath)) continue;
    found.add(relativePath);
    for (const match of read(relativePath).matchAll(/from ['"]\.\/([a-z0-9-]+\.ts)['"]/g)) {
      pending.push(`scripts/${match[1]}`);
    }
  }
  return [...found].sort();
}

describe('Group E release and documentation contracts', () => {
  test('Build Tarballs PR filter covers every release-payload input class', () => {
    const workflow = read('.github/workflows/build-tarballs.yml');
    for (const path of [
      "'src/**'",
      "'skills/**'",
      "'templates/**'",
      "'plugins/**'",
      "'package.json'",
      "'bun.lock'",
      "'tsconfig.json'",
      "'scripts/build-binary.sh'",
      "'scripts/sync-plugin-skills.ts'",
      "'scripts/fresh-install-smoke.ts'",
      "'scripts/skills-lint.ts'",
      "'scripts/release-payload-version.ts'",
      "'.agents/plugins/marketplace.json'",
      "'.claude-plugin/marketplace.json'",
      "'.github/workflows/build-tarballs.yml'",
    ]) {
      expect(workflow).toContain(`- ${path}`);
    }
    expect(workflow).toContain('skills/<name>/SKILL.md');
    expect(workflow).toContain('agents/openai.yaml');
    expect(buildHelperInputs()).toContain('scripts/skills-lint.ts');
    for (const helper of buildHelperInputs()) expect(workflow).toContain(`- '${helper}'`);
  });

  test('release create and promotion paths retain the one-time convergence caveat', () => {
    const workflow = read('.github/workflows/release-publish.yml');
    expect(workflow).toContain('genie-agent-sync-migration-v1');
    expect(workflow).toContain('append_migration_note');
    expect(workflow).toContain('gh release create');
    expect(workflow).toContain('gh release edit');
  });

  test('resurrected metrics bot and incompatible generated state stay retired', () => {
    expect(read('README.md')).not.toContain('<!-- METRICS:START -->');
    for (const file of ['AGENT.md', 'runs.jsonl', 'state.json']) {
      expect(existsSync(join(ROOT, '.genie/agents/metrics-updater', file))).toBe(false);
    }
  });

  test('reviewer permission profile grants writes only to Codex special temporary roots', () => {
    const profile = Bun.TOML.parse(read('plugins/genie/codex-agents/genie-reviewer.toml')) as ReviewerProfile;
    expect(reviewerPermissionViolations(profile)).toEqual([]);

    for (const forbiddenFilesystem of [{ ':workspace_roots': 'write' }, { '/repo': 'write' }, { '~/': 'write' }]) {
      const broadened = structuredClone(profile);
      Object.assign(broadened.permissions?.['genie-reviewer-temp']?.filesystem ?? {}, forbiddenFilesystem);
      expect(reviewerPermissionViolations(broadened)).toContain('only :tmpdir and :slash_tmp may be writable');
    }
    expect(reviewerPermissionViolations({ ...profile, sandbox_mode: 'workspace-write' })).toContain(
      'legacy sandbox mode must not override the named profile',
    );
    expect(
      reviewerPermissionViolations({ ...profile, sandbox_workspace_write: { writable_roots: ['/repo'] } }),
    ).toContain('legacy workspace-write grants are forbidden');
  });

  test('README and contributor command inventories match the 14-command source surface', () => {
    const expected = [
      'board',
      'doctor',
      'help',
      'hook',
      'init',
      'install',
      'launch',
      'mcp',
      'omni',
      'setup',
      'shortcuts',
      'task',
      'uninstall',
      'update',
    ];
    const readme = read('README.md');
    const contributor = read('CLAUDE.md');
    expect(readme).toContain('14 CLI commands');
    expect(contributor).toContain('Fourteen top-level commands');
    const readmeCommands = [...readme.matchAll(/^\| `genie ([a-z-]+)/gm)].map((match) => match[1]).sort();
    const contributorCommands = [...contributor.matchAll(/^\| `([a-z-]+)/gm)].map((match) => match[1]).sort();
    expect(readmeCommands).toEqual(expected);
    expect(contributorCommands).toEqual(expected);
  });

  test('operator docs distinguish product, role-agent, personal, MCP, and hook inventories', () => {
    const docs = `${read('README.md')}\n${read('plugins/genie/README.md')}`;
    for (const statement of [
      '23 physical',
      'Seven optional',
      '36 adapted skills',
      'mcp-launcher.cjs',
      'H3',
      'H4',
      'H6',
      '/hooks',
      'start a new task',
    ]) {
      expect(docs).toContain(statement);
    }
  });
});
