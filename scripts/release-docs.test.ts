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
  permissions?: Record<string, unknown>;
}

function reviewerPermissionViolations(profile: ReviewerProfile): string[] {
  const violations: string[] = [];
  if (profile.approval_policy !== 'never') violations.push('approval policy must be never');
  if (profile.default_permissions !== ':read-only') violations.push('built-in read-only permissions must be selected');
  if (profile.sandbox_mode !== undefined) violations.push('legacy sandbox mode must not override the named profile');
  if (profile.sandbox_workspace_write !== undefined) violations.push('legacy workspace-write grants are forbidden');
  if (Object.keys(profile.permissions ?? {}).length > 0)
    violations.push('custom writable permission profiles are forbidden');
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
      "'LICENSE'",
      "'bun.lock'",
      "'bunfig.toml'",
      "'tsconfig.json'",
      "'scripts/build-binary.sh'",
      "'scripts/build.js'",
      "'scripts/hook-bundle-parity.ts'",
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
    const helper = read('scripts/reconcile-release-note.sh');
    expect(workflow).toContain('bash scripts/reconcile-release-note.sh');
    expect(helper).toContain('genie-agent-sync-migration-v1');
    expect(helper).toContain('older than `5.260711.6`');
    expect(helper).toContain('create_args=(release create');
    expect(helper).toContain('gh release edit');
  });

  test('release packaging validates generated hooks and the extracted archive payload', () => {
    const build = read('scripts/build-binary.sh');
    expect(build).toContain('scripts/hook-bundle-parity.ts');
    const archive = build.indexOf('tar czf "${TARBALL}"');
    const extract = build.indexOf('tar -xzf "${TARBALL}"');
    const postExtractSmoke = build.lastIndexOf('scripts/fresh-install-smoke.ts');
    const postExtractVersion = build.lastIndexOf('scripts/release-payload-version.ts');
    expect(archive).toBeGreaterThan(-1);
    expect(extract).toBeGreaterThan(archive);
    expect(build).toContain('assert_release_tree_equal "${STAGE}" "${VERIFY_ROOT}"');
    expect(build).toContain('cmp -- "${expected_entry}" "${actual_entry}"');
    expect(build).toContain('cp "${REPO_ROOT}/LICENSE"');
    expect(build).toContain("-name '*.test.*'");
    expect(build).toContain('! -type f ! -type d');
    expect(build).toContain('find "${expected_root}" -mindepth 1');
    expect(postExtractSmoke).toBeGreaterThan(extract);
    expect(postExtractVersion).toBeGreaterThan(extract);

    const rootPackage = JSON.parse(read('package.json')) as { license?: unknown };
    const pluginPackage = JSON.parse(read('plugins/genie/package.json')) as { license?: unknown };
    expect(rootPackage.license).toBe('MIT');
    expect(pluginPackage.license).toBe('MIT');
  });

  test('committed CI reproduces the council and generated-hook parts of the local gate', () => {
    const workflow = read('.github/workflows/ci.yml');
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts.check).toContain('bun run lint:complexity-budget');
    expect(pkg.scripts['check:fast']).toContain('bun run lint:complexity-budget');
    expect(workflow).toContain('bun run lint:complexity-budget');
    expect(workflow).toContain('bun run lint:council-workflow');
    expect(workflow).toContain('bun run lint:hook-bundles');
  });

  test('resurrected metrics bot and incompatible generated state stay retired', () => {
    expect(read('README.md')).not.toContain('<!-- METRICS:START -->');
    for (const file of ['AGENT.md', 'runs.jsonl', 'state.json']) {
      expect(existsSync(join(ROOT, '.genie/agents/metrics-updater', file))).toBe(false);
    }
  });

  test('reviewer permission profile remains read-only even for temporary-hosted worktrees', () => {
    const profile = Bun.TOML.parse(read('plugins/genie/codex-agents/genie-reviewer.toml')) as ReviewerProfile;
    expect(reviewerPermissionViolations(profile)).toEqual([]);

    expect(reviewerPermissionViolations({ ...profile, permissions: { unsafe: {} } })).toContain(
      'custom writable permission profiles are forbidden',
    );
    expect(reviewerPermissionViolations({ ...profile, default_permissions: 'genie-reviewer-temp' })).toContain(
      'built-in read-only permissions must be selected',
    );
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

  test('plugin docs and cards use owner-qualified selectors with an explicit personal fallback', () => {
    const docs = `${read('README.md')}\n${read('plugins/genie/README.md')}\n${read('skills/README.md')}`;
    for (const skill of ['brainstorm', 'wish', 'review', 'work']) {
      expect(docs).toContain(`$genie:${skill}`);
    }
    expect(docs).toContain('separately installed personal');
    const manifest = read('plugins/genie/.codex-plugin/plugin.json');
    for (const skill of ['wish', 'work', 'review']) expect(manifest).toContain(`$genie:${skill}`);
  });

  test('lifecycle skills share persisted WISH state and keep reviewers read-only', () => {
    const lifecycle = read('skills/genie/reference/lifecycle.md');
    for (const status of ['`DRAFT`', '`FIX-FIRST`', '`APPROVED`', '`IN_PROGRESS`', '`BLOCKED`', '`SHIPPED`']) {
      expect(lifecycle).toContain(status);
    }
    const brainstorm = read('skills/brainstorm/SKILL.md');
    const review = read('skills/review/SKILL.md');
    const dream = read('skills/dream/SKILL.md');
    const wish = read('skills/wish/templates/wish-template.md');
    const pm = read('skills/pm/SKILL.md');
    expect(dream).toContain('Status field is exactly `APPROVED`');
    expect(brainstorm).toContain('Do not move it to Poured before a WISH.md exists');
    expect(brainstorm).toContain('single brainstorm/planning index is `.genie/INDEX.md`');
    expect(brainstorm).toContain('Legacy migration is idempotent');
    expect(review).toContain('### Design Review (after `brainstorm`)');
    expect(review).toContain('The reviewer is read-only');
    expect(wish).toContain('## Dependencies');
    expect(wish).toContain('**depends-on:** none');
    expect(dream).toContain('wish-level `**depends-on:**`');
    expect(dream).not.toContain('depends_on');
    expect(pm).toContain('Explicit task-scoped grant');
    expect(pm).toMatch(/Selecting Autopilot\s+does not itself authorize external repository writes/);
  });

  test('wizard discloses init MCP writes and owner-qualified lifecycle order', () => {
    const wizard = read('skills/wizard/SKILL.md');
    for (const path of ['.mcp.json', '.warp/.mcp.json', '.codex/config.toml']) expect(wizard).toContain(path);
    for (const skill of ['brainstorm', 'wish', 'review', 'work']) expect(wizard).toContain(`$genie:${skill}`);
    expect(wizard.indexOf('$genie:review')).toBeLessThan(wizard.indexOf('$genie:work'));
  });

  test('Omni and MCP operator instructions expose provider and fallback policy', () => {
    const omni = read('skills/omni/SKILL.md');
    expect(omni).toContain('{instance, chat, repo, agent, persona?}');
    expect(omni).toContain('"agent": "codex"');
    const readme = read('README.md');
    expect(readme).toContain('no installed, enabled, usable Genie plugin route');
    for (const path of ['.mcp.json', '.warp/.mcp.json', '.codex/config.toml']) expect(readme).toContain(path);
  });
});
