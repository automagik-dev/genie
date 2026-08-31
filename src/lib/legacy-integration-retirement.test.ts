/**
 * Tests for plugin-era integration retirement.
 *
 * Everything runs inside one tmpdir standing in for `$HOME`: every agent root is
 * injected, so the real home is never read or written. Real files, no mocks —
 * the managed assets are written in exactly the on-disk shape a plugin-era
 * Genie left behind (`computeDirDigest`/`computeFileDigest`-backed manifests,
 * the stamped-workflow sidecar, the v2 role-agent inventory), because a fixture
 * that fakes ownership metadata would prove nothing about the classifiers this
 * module delegates to. The writers that once produced them left with the plugin
 * subsystem, so the fixture builders below are the record of their format.
 *
 * Run with: bun test src/lib/legacy-integration-retirement.test.ts
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { computeDirDigest, computeFileDigest } from './atomic-fs';
import {
  LEGACY_INTEGRATION_SURFACES,
  type LegacyIntegrationEntry,
  type LegacyIntegrationHomes,
  type LegacyIntegrationState,
  type LegacyIntegrationSurface,
  classifyLegacyIntegrations,
  retireLegacyIntegrations,
  runLegacyIntegrationRetirement,
} from './legacy-integration-retirement';
import { inspectRuntimeIntegrationEvidence } from './runtime-integrations';

const MANIFEST_NAME = '.genie-sync.json';
const MANAGED_ROLE_TOML = '# Managed by Genie. Remove with `genie uninstall`.\nname = "genie_reviewer"\n';
const TEMPLATE_BODY = "export const meta = { name: 'council' };\nconst LENS_ROOT = '__GENIE_LENS_ROOT__';\n";
const FIXED_NOW = new Date('2026-08-30T12:00:00.000Z');

interface Fixture {
  home: string;
  genieHome: string;
  codexHome: string;
  claudeDir: string;
  hermesHome: string;
  piExtensionsDir: string;
  pluginRoot: string;
}

let fixtures: string[] = [];

afterEach(() => {
  for (const root of fixtures) rmSync(root, { recursive: true, force: true });
  fixtures = [];
});

function makeFixture(): Fixture {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'genie-retire-')));
  fixtures.push(home);
  const genieHome = join(home, '.genie');
  const fixture: Fixture = {
    home,
    genieHome,
    codexHome: join(home, '.codex'),
    claudeDir: join(home, '.claude'),
    hermesHome: join(home, '.hermes'),
    piExtensionsDir: join(home, '.pi', 'agent', 'extensions'),
    pluginRoot: join(genieHome, 'plugins', 'genie'),
  };
  mkdirSync(genieHome, { recursive: true });
  return fixture;
}

function homesOf(fixture: Fixture): LegacyIntegrationHomes {
  return {
    home: fixture.home,
    genieHome: fixture.genieHome,
    codexHome: fixture.codexHome,
    claudeDir: fixture.claudeDir,
    hermesHome: fixture.hermesHome,
    piExtensionsDir: fixture.piExtensionsDir,
  };
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function link(linkPath: string, target: string): void {
  mkdirSync(dirname(linkPath), { recursive: true });
  mkdirSync(target, { recursive: true });
  symlinkSync(target, linkPath);
}

/** A managed skill mirror exactly as `syncSkillDirsInto` leaves one behind. */
function writeManagedSkill(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) write(join(dir, rel), content);
  write(
    join(dir, MANIFEST_NAME),
    `${JSON.stringify(
      {
        managedBy: 'genie-agent-sync',
        version: '9.9.9',
        digest: computeDirDigest(dir),
        syncedAt: FIXED_NOW.toISOString(),
        identityVersion: 2,
      },
      null,
      2,
    )}\n`,
  );
}

/** The stamped council workflow plus its ownership sidecar, as the stamper left them. */
function writeManagedCouncilWorkflow(workflowsDir: string, body: string): void {
  const targetPath = join(workflowsDir, 'council.js');
  write(targetPath, body);
  chmodSync(targetPath, 0o644);
  const manifestPath = join(workflowsDir, 'council.js.genie-sync.json');
  write(
    manifestPath,
    `${JSON.stringify(
      {
        managedBy: 'genie-agent-sync',
        version: '9.9.9',
        digest: computeFileDigest(targetPath),
        syncedAt: FIXED_NOW.toISOString(),
        identityVersion: 2,
        targetMode: 0o644,
      },
      null,
      2,
    )}\n`,
  );
  chmodSync(manifestPath, 0o644);
}

/** Codex role agents plus the v2 ownership inventory, as the role writer left them. */
function writeManagedCodexRoleAgents(codexHome: string, files: Record<string, string>): void {
  const agentsDir = join(codexHome, 'agents');
  const inventory: Record<string, { identity: { kind: 'regular'; mode: number; digest: string } }> = {};
  for (const [name, content] of Object.entries(files)) {
    const path = join(agentsDir, name);
    write(path, content);
    chmodSync(path, 0o644);
    inventory[name] = { identity: { kind: 'regular', mode: 0o644, digest: computeFileDigest(path) } };
  }
  const inventoryPath = join(agentsDir, '.genie-role-agents.json');
  write(
    inventoryPath,
    `${JSON.stringify({ version: 2, managedBy: 'genie-codex-role-agents', files: inventory }, null, 2)}\n`,
  );
  chmodSync(inventoryPath, 0o600);
}

/** The shared per-file Claude role-agent manifest, as the flat-agent writer leaves it. */
function writeManagedClaudeAgents(agentsDir: string, files: Record<string, string>): void {
  const manifest: Record<string, { digest: string; version: string | null; syncedAt: string }> = {};
  for (const [name, content] of Object.entries(files)) {
    const path = join(agentsDir, name);
    write(path, content);
    manifest[name] = { digest: computeFileDigest(path), version: '9.9.9', syncedAt: FIXED_NOW.toISOString() };
  }
  write(
    join(agentsDir, MANIFEST_NAME),
    `${JSON.stringify({ managedBy: 'genie-agent-sync', files: manifest }, null, 2)}\n`,
  );
}

function stateOf(
  entries: LegacyIntegrationEntry[],
  surface: LegacyIntegrationSurface,
  path?: string,
): LegacyIntegrationState | undefined {
  return entries.find((entry) => entry.surface === surface && (path === undefined || entry.path === path))?.state;
}

function statesOf(entries: LegacyIntegrationEntry[], surface: LegacyIntegrationSurface): LegacyIntegrationState[] {
  return entries.filter((entry) => entry.surface === surface).map((entry) => entry.state);
}

/** Structural hash of a tree: names, kinds, symlink targets, and file bytes. */
function hashTree(root: string): string {
  const parts: string[] = [];
  const walk = (dir: string, rel: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const path = join(dir, entry.name);
      const next = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        parts.push(`L ${next} ${readlinkSync(path)}`);
        continue;
      }
      if (entry.isDirectory()) {
        parts.push(`D ${next}`);
        walk(path, next);
        continue;
      }
      parts.push(`F ${next} ${createHash('sha256').update(readFileSync(path)).digest('hex')}`);
    }
  };
  walk(root, '');
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

// ---------------------------------------------------------------------------
// Per-surface fixtures
// ---------------------------------------------------------------------------

/** Populate every surface in its `managed-clean` shape. */
function populateClean(fixture: Fixture): void {
  write(
    join(fixture.codexHome, 'config.toml'),
    '[otel]\nexporter = "keep"\n\n[plugins."genie@automagik"]\nenabled = true\n\n[hooks.state]\n"genie@automagik:session_start" = "approved"\n',
  );
  write(join(fixture.codexHome, 'plugins', 'cache', 'automagik', 'genie', '5.260830.19', 'plugin.json'), '{}\n');
  writeManagedCodexRoleAgents(fixture.codexHome, { 'genie-reviewer.toml': MANAGED_ROLE_TOML });
  writeManagedSkill(join(fixture.codexHome, 'skills', '.curated', 'legacy-curated'), { 'SKILL.md': '# curated\n' });

  write(
    join(fixture.claudeDir, 'plugins', 'installed_plugins.json'),
    `${JSON.stringify({ schema: 3, plugins: [{ id: 'genie@automagik', version: '1' }, { id: 'other@market' }] }, null, 2)}\n`,
  );
  write(join(fixture.claudeDir, 'plugins', 'cache', 'automagik', 'genie', '5.260830.19', 'plugin.json'), '{}\n');
  write(
    join(fixture.claudeDir, 'plugins', 'known_marketplaces.json'),
    `${JSON.stringify(
      {
        automagik: {
          source: { source: 'directory', path: fixture.genieHome },
          installLocation: fixture.genieHome,
        },
        'other-market': { source: { source: 'git', repo: 'someone/else' } },
      },
      null,
      2,
    )}\n`,
  );
  write(join(fixture.claudeDir, 'plugins', 'marketplaces', 'automagik', 'plugins', 'genie', 'plugin.json'), '{}\n');
  write(
    join(fixture.claudeDir, 'settings.json'),
    `${JSON.stringify({ model: 'opus', enabledPlugins: { 'genie@automagik': true, 'other@market': true } }, null, 2)}\n`,
  );
  write(join(fixture.pluginRoot, 'workflows', 'council.js'), TEMPLATE_BODY);
  writeManagedCouncilWorkflow(
    join(fixture.claudeDir, 'workflows'),
    TEMPLATE_BODY.replace('__GENIE_LENS_ROOT__', fixture.pluginRoot),
  );
  writeManagedClaudeAgents(join(fixture.claudeDir, 'agents'), { 'genie-reviewer.md': '# reviewer\n' });
  writeManagedSkill(join(fixture.claudeDir, 'skills', 'legacy-mirror'), { 'SKILL.md': '# legacy mirror\n' });

  link(join(fixture.hermesHome, 'plugins', 'genie'), join(fixture.genieHome, 'plugins', 'hermes-genie'));
  write(
    join(fixture.hermesHome, 'config.yaml'),
    [
      'mcp_servers:',
      '  other:',
      '    command: other',
      '# genie:managed:mcp_servers.genie — begin (managed by genie; edit via genie only)',
      '  genie:',
      '    command: genie',
      '# genie:managed:mcp_servers.genie — end',
      'skills:',
      '  external_dirs:',
      '    - /operator/own/skills',
      `    - ${join(fixture.genieHome, 'skills')}  # genie:managed:skills.external_dirs`,
      '',
    ].join('\n'),
  );
  link(join(fixture.piExtensionsDir, 'genie'), join(fixture.genieHome, 'plugins', 'pi-genie'));
}

// ---------------------------------------------------------------------------

describe('classifyLegacyIntegrations — every surface, every state', () => {
  test('a fully populated host classifies every surface managed-clean', () => {
    const fixture = makeFixture();
    populateClean(fixture);
    const { entries } = classifyLegacyIntegrations(homesOf(fixture));
    for (const surface of [
      'codex-plugin-registration',
      'codex-plugin-cache',
      'codex-role-agent',
      'codex-role-agent-inventory',
      'codex-legacy-curated-skill',
      'claude-plugin-registry',
      'claude-plugin-cache',
      'claude-marketplace-cache',
      'claude-workflow',
      'claude-agent',
      'claude-skill',
      'hermes-plugin-link',
      'hermes-mcp-server',
      'hermes-skills-external-dir',
      'pi-extension-link',
    ] as const) {
      expect([surface, statesOf(entries, surface)]).toEqual([surface, ['managed-clean']]);
    }
  });

  test('an untouched host classifies every surface absent — and retires nothing', () => {
    const fixture = makeFixture();
    const { entries } = classifyLegacyIntegrations(homesOf(fixture));
    expect(entries.every((entry) => entry.state === 'absent')).toBe(true);

    const lines: string[] = [];
    const result = runLegacyIntegrationRetirement({
      homes: homesOf(fixture),
      log: (line) => lines.push(line),
      now: FIXED_NOW,
    });
    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([]);
    expect(lines).toEqual(['nothing to retire']);
    // Backup roots are allocated lazily: a clean host writes nothing at all.
    expect(result.backupRootUsed).toBe(false);
    expect(existsSync(join(fixture.genieHome, 'state-backups'))).toBe(false);
  });

  test('user-modified genie assets classify managed-modified and are never candidates', () => {
    const fixture = makeFixture();
    populateClean(fixture);
    // Edit each managed asset in place; the digest/marker checks must all notice.
    write(join(fixture.claudeDir, 'agents', 'genie-reviewer.md'), '# reviewer, hand-edited\n');
    write(join(fixture.claudeDir, 'skills', 'legacy-mirror', 'SKILL.md'), '# hand-edited\n');
    write(join(fixture.claudeDir, 'workflows', 'council.js'), 'hand-edited\n');
    write(join(fixture.claudeDir, 'plugins', 'installed_plugins.json'), '{broken');
    write(
      join(fixture.codexHome, 'config.toml'),
      '[plugins."genie@automagik"]\nenabled = true\n\n[plugins."genie@automagik"]\nenabled = false\n',
    );
    write(join(fixture.codexHome, 'agents', 'genie-reviewer.toml'), `${MANAGED_ROLE_TOML}extra = true\n`);

    const { entries } = classifyLegacyIntegrations(homesOf(fixture));
    for (const surface of [
      'codex-plugin-registration',
      'codex-role-agent',
      'claude-plugin-registry',
      'claude-workflow',
      'claude-agent',
      'claude-skill',
    ] as const) {
      expect([surface, statesOf(entries, surface)]).toEqual([surface, ['managed-modified']]);
    }
  });

  test('objects that are provably not ours classify unmanaged', () => {
    const fixture = makeFixture();
    // A user's own skill dir carrying a foreign sync manifest.
    write(join(fixture.claudeDir, 'skills', 'mine', 'SKILL.md'), '# mine\n');
    write(join(fixture.claudeDir, 'skills', 'mine', MANIFEST_NAME), '{"managedBy":"someone-else"}\n');
    // A dev checkout symlinked where the plugin links live.
    const checkout = join(fixture.home, 'dev-checkout');
    link(join(fixture.piExtensionsDir, 'genie'), checkout);
    link(join(fixture.hermesHome, 'plugins', 'genie'), checkout);
    // A real directory (not a symlink) at the pi link path is equally not ours.
    write(join(fixture.codexHome, 'config.toml'), 'unrelated = true\n');
    symlinkSync(join(fixture.codexHome, 'config.toml'), join(fixture.hermesHome, 'config.yaml'));
    // A file where a plugin cache generation dir belongs.
    write(join(fixture.claudeDir, 'plugins', 'cache', 'automagik', 'genie', 'stray.txt'), 'not a generation\n');

    const { entries } = classifyLegacyIntegrations(homesOf(fixture));
    expect(stateOf(entries, 'claude-skill')).toBe('unmanaged');
    expect(stateOf(entries, 'pi-extension-link')).toBe('unmanaged');
    expect(stateOf(entries, 'hermes-plugin-link')).toBe('unmanaged');
    expect(stateOf(entries, 'hermes-mcp-server')).toBe('unmanaged');
    expect(stateOf(entries, 'hermes-skills-external-dir')).toBe('unmanaged');
    expect(stateOf(entries, 'claude-plugin-cache')).toBe('unmanaged');
    // A config with no genie rows at all is absent, not unmanaged.
    expect(stateOf(entries, 'codex-plugin-registration')).toBe('absent');
  });

  test('a skills.sh copy is not a mirror candidate at all — it produces no entry', () => {
    const fixture = makeFixture();
    // Plain skill dirs with no sync manifest: the skills.sh channel's own output.
    write(join(fixture.claudeDir, 'skills', 'wish', 'SKILL.md'), '# wish\n');
    write(join(fixture.claudeDir, 'skills', 'review', 'SKILL.md'), '# review\n');
    const { entries } = classifyLegacyIntegrations(homesOf(fixture));
    expect(statesOf(entries, 'claude-skill')).toEqual(['absent']);
    expect(entries.filter((entry) => entry.path.includes(`${'skills'}/wish`))).toEqual([]);
  });
});

describe('retireLegacyIntegrations — removes only clean assets, backup-first', () => {
  test('every clean surface is removed, backed up, and reported once', () => {
    const fixture = makeFixture();
    populateClean(fixture);
    const lines: string[] = [];
    const result = runLegacyIntegrationRetirement({
      homes: homesOf(fixture),
      log: (line) => lines.push(line),
      now: FIXED_NOW,
    });

    expect(result.failures).toEqual([]);
    expect(result.kept).toEqual([]);
    expect(result.removed).toHaveLength(17);
    expect(result.backupRootUsed).toBe(true);
    for (const removal of result.removed) {
      expect([removal.surface, existsSync(removal.backupPath)]).toEqual([removal.surface, true]);
    }

    // Gone from the host.
    expect(readFileSync(join(fixture.codexHome, 'config.toml'), 'utf8')).toBe(
      '[otel]\nexporter = "keep"\n\n[hooks.state]\n',
    );
    expect(existsSync(join(fixture.codexHome, 'plugins', 'cache', 'automagik', 'genie', '5.260830.19'))).toBe(false);
    expect(existsSync(join(fixture.codexHome, 'agents', 'genie-reviewer.toml'))).toBe(false);
    expect(existsSync(join(fixture.codexHome, 'skills', '.curated'))).toBe(false);
    expect(existsSync(join(fixture.claudeDir, 'plugins', 'cache', 'automagik', 'genie', '5.260830.19'))).toBe(false);
    // The now-childless cache family dirs go with the last generation…
    for (const agentHome of [fixture.codexHome, fixture.claudeDir]) {
      expect(existsSync(join(agentHome, 'plugins', 'cache', 'automagik'))).toBe(false);
      expect(existsSync(join(agentHome, 'plugins', 'cache'))).toBe(true);
    }
    // …and the two user-owned Claude registries keep everything but genie's key.
    expect(JSON.parse(readFileSync(join(fixture.claudeDir, 'plugins', 'known_marketplaces.json'), 'utf8'))).toEqual({
      'other-market': { source: { source: 'git', repo: 'someone/else' } },
    });
    expect(JSON.parse(readFileSync(join(fixture.claudeDir, 'settings.json'), 'utf8'))).toEqual({
      model: 'opus',
      enabledPlugins: { 'other@market': true },
    });
    expect(existsSync(join(fixture.claudeDir, 'workflows', 'council.js'))).toBe(false);
    expect(existsSync(join(fixture.claudeDir, 'workflows', 'council.js.genie-sync.json'))).toBe(false);
    expect(existsSync(join(fixture.claudeDir, 'agents', 'genie-reviewer.md'))).toBe(false);
    expect(existsSync(join(fixture.claudeDir, 'skills', 'legacy-mirror'))).toBe(false);
    expect(existsSync(join(fixture.hermesHome, 'plugins', 'genie'))).toBe(false);
    expect(existsSync(join(fixture.piExtensionsDir, 'genie'))).toBe(false);

    // `$GENIE_HOME/plugins/*` is genie-owned payload: only the references went.
    expect(existsSync(join(fixture.genieHome, 'plugins', 'hermes-genie'))).toBe(true);
    expect(existsSync(join(fixture.genieHome, 'plugins', 'pi-genie'))).toBe(true);

    expect(lines.filter((line) => line.startsWith('retired '))).toHaveLength(17);
    expect(lines).toContain(`retired claude-workflow: ${join(fixture.claudeDir, 'workflows', 'council.js')}`);
    expect(lines.at(-1)).toBe(`retirement backups: ${result.backupRoot}`);
    expect(lines).not.toContain('nothing to retire');
  });

  test('modified and unmanaged assets are kept, named, and left byte-identical', () => {
    const fixture = makeFixture();
    populateClean(fixture);
    write(join(fixture.claudeDir, 'skills', 'legacy-mirror', 'SKILL.md'), '# hand-edited\n');
    const checkout = join(fixture.home, 'dev-checkout');
    rmSync(join(fixture.piExtensionsDir, 'genie'));
    link(join(fixture.piExtensionsDir, 'genie'), checkout);

    const lines: string[] = [];
    const result = runLegacyIntegrationRetirement({
      homes: homesOf(fixture),
      log: (line) => lines.push(line),
      now: FIXED_NOW,
    });

    expect(result.kept.map((entry) => [entry.surface, entry.state])).toEqual([
      ['claude-skill', 'managed-modified'],
      ['pi-extension-link', 'unmanaged'],
    ]);
    expect(
      lines.some((line) =>
        line.startsWith(`kept (modified) claude-skill: ${join(fixture.claudeDir, 'skills', 'legacy-mirror')}`),
      ),
    ).toBe(true);
    expect(
      lines.some((line) =>
        line.startsWith(`kept (unmanaged) pi-extension-link: ${join(fixture.piExtensionsDir, 'genie')}`),
      ),
    ).toBe(true);
    expect(readFileSync(join(fixture.claudeDir, 'skills', 'legacy-mirror', 'SKILL.md'), 'utf8')).toBe(
      '# hand-edited\n',
    );
    expect(readlinkSync(join(fixture.piExtensionsDir, 'genie'))).toBe(checkout);
  });

  test('a per-surface failure keeps its asset and never aborts the other surfaces', () => {
    const fixture = makeFixture();
    populateClean(fixture);
    const report = classifyLegacyIntegrations(homesOf(fixture));
    // Point one clean entry at a path that no longer exists, so its removal throws.
    const target = report.entries.find((entry) => entry.surface === 'claude-agent');
    if (target === undefined) throw new Error('fixture did not produce a claude-agent entry');
    rmSync(target.path);

    const result = retireLegacyIntegrations(report, {
      backupRoot: join(fixture.genieHome, 'state-backups', 'run'),
      now: FIXED_NOW,
    });
    expect(result.failures.map((failure) => failure.surface)).toEqual(['claude-agent']);
    expect(result.kept.map((entry) => entry.surface)).toEqual(['claude-agent']);
    expect(result.removed).toHaveLength(16);
  });
});

describe('content-preserving edits', () => {
  test('the Claude plugin registry keeps every unknown key and every other plugin', () => {
    const fixture = makeFixture();
    const path = join(fixture.claudeDir, 'plugins', 'installed_plugins.json');
    write(
      path,
      `${JSON.stringify(
        {
          schemaVersion: 7,
          somethingGenieDoesNotKnow: { nested: [1, 2, 3] },
          plugins: [
            { id: 'genie@automagik', version: '1' },
            { id: 'other@market', trusted: true },
          ],
          enabledPlugins: { 'genie@automagik': true, 'other@market': false },
          repositories: ['genie@automagik', 'other@market'],
        },
        null,
        2,
      )}\n`,
    );
    runLegacyIntegrationRetirement({ homes: homesOf(fixture), log: () => undefined, now: FIXED_NOW });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      schemaVersion: 7,
      somethingGenieDoesNotKnow: { nested: [1, 2, 3] },
      plugins: [{ id: 'other@market', trusted: true }],
      enabledPlugins: { 'other@market': false },
      repositories: ['other@market'],
    });
  });

  test('the Hermes config keeps operator entries and drops the now-childless external_dirs key', () => {
    const fixture = makeFixture();
    populateClean(fixture);
    runLegacyIntegrationRetirement({ homes: homesOf(fixture), log: () => undefined, now: FIXED_NOW });
    const text = readFileSync(join(fixture.hermesHome, 'config.yaml'), 'utf8');
    expect(text).toContain('  other:\n    command: other');
    expect(text).toContain('    - /operator/own/skills');
    expect(text).toContain('  external_dirs:');
    expect(text).not.toContain('genie:managed');
    expect(text).not.toContain(join(fixture.genieHome, 'skills'));
    expect(text).not.toMatch(/^ +genie:$/m);
  });

  test('the only managed entry taking the external_dirs key with it leaves valid YAML', () => {
    const fixture = makeFixture();
    write(
      join(fixture.hermesHome, 'config.yaml'),
      [
        'models:',
        '  default: gpt-5',
        'skills:',
        '  external_dirs:',
        '    - /x  # genie:managed:skills.external_dirs',
        '',
      ].join('\n'),
    );
    runLegacyIntegrationRetirement({ homes: homesOf(fixture), log: () => undefined, now: FIXED_NOW });
    const text = readFileSync(join(fixture.hermesHome, 'config.yaml'), 'utf8');
    expect(text).toBe('models:\n  default: gpt-5\nskills:\n');
    expect(Bun.YAML.parse(text)).toEqual({ models: { default: 'gpt-5' }, skills: null });
  });

  test('the mcp marker literal restated here still exists in the module that writes it', () => {
    // `hermes-mcp-config.ts` survives wish `skills-everywhere-b` and still owns
    // its begin/end pair privately, so this stays the drift guard between that
    // writer and this classifier. The skills half is gone on purpose: Group 5
    // deletes `hermes-skills-config.ts`, and pinning a literal to a file that
    // will not exist is a guard that fails on the deletion rather than on
    // drift. `HERMES_SKILLS_MARKER` in the retirement module is now the single
    // source of truth for that marker.
    expect(readFileSync(join(import.meta.dir, 'hermes-mcp-config.ts'), 'utf8')).toContain(
      '# genie:managed:mcp_servers.genie',
    );
  });
});

describe('a clean classification whose remover owns nothing', () => {
  /**
   * The classifier and the remover do not read the same shapes: the classifier
   * matches a `genie@automagik:` row ANYWHERE, the remover only drops one under
   * `[hooks.state]`. Such an entry is clean, unremovable, and must be reported
   * as kept — reporting it as `retired` made every future update re-"retire" it
   * and allocate a fresh backup root forever.
   */
  test('a genie hook row outside [hooks.state] is kept, and no backup root is allocated', () => {
    const fixture = makeFixture();
    const configPath = join(fixture.codexHome, 'config.toml');
    const original = '[otel]\nexporter = "keep"\n"genie@automagik:session_start" = "approved"\n';
    write(configPath, original);

    const lines: string[] = [];
    const result = runLegacyIntegrationRetirement({
      homes: homesOf(fixture),
      log: (line) => lines.push(line),
      now: FIXED_NOW,
    });

    expect(result.removed).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(result.kept.map((entry) => [entry.surface, entry.state])).toEqual([
      ['codex-plugin-registration', 'managed-modified'],
    ]);
    expect(lines).toContain('nothing to retire');
    expect(lines.some((line) => line.startsWith('retired '))).toBe(false);
    expect(result.backupRootUsed).toBe(false);
    expect(existsSync(join(fixture.genieHome, 'state-backups'))).toBe(false);
    expect(readFileSync(configPath, 'utf8')).toBe(original);

    // …and a second run, on a different clock, is the same no-op.
    const second = runLegacyIntegrationRetirement({
      homes: homesOf(fixture),
      log: () => undefined,
      now: new Date('2026-09-01T00:00:00.000Z'),
    });
    expect(second.removed).toEqual([]);
    expect(existsSync(join(fixture.genieHome, 'state-backups'))).toBe(false);
    expect(readFileSync(configPath, 'utf8')).toBe(original);
  });

  /** The Hermes twin: the classifier counts marker OCCURRENCES, the remover needs a `- ` item. */
  test('a skills marker on a comment line is kept, and no backup root is allocated', () => {
    const fixture = makeFixture();
    const configPath = join(fixture.hermesHome, 'config.yaml');
    const original = [
      'skills:',
      '  external_dirs:',
      '    - /operator/own/skills',
      '# genie:managed:skills.external_dirs',
      '',
    ].join('\n');
    write(configPath, original);

    const lines: string[] = [];
    const result = runLegacyIntegrationRetirement({
      homes: homesOf(fixture),
      log: (line) => lines.push(line),
      now: FIXED_NOW,
    });

    expect(result.removed).toEqual([]);
    expect(result.kept.map((entry) => [entry.surface, entry.state])).toEqual([
      ['hermes-skills-external-dir', 'managed-modified'],
    ]);
    expect(lines).toContain('nothing to retire');
    expect(result.backupRootUsed).toBe(false);
    expect(existsSync(join(fixture.genieHome, 'state-backups'))).toBe(false);
    expect(readFileSync(configPath, 'utf8')).toBe(original);
  });
});

describe('failures', () => {
  test('a failed removal reports incomplete, never "nothing to retire"', () => {
    const fixture = makeFixture();
    const configPath = join(fixture.hermesHome, 'config.yaml');
    // Clean by marker count, but the post-removal document would not parse, so
    // `removeMarkedExternalDir` refuses (corruption is never acceptable).
    const original = [
      'skills:',
      '  external_dirs:',
      '    - /x  # genie:managed:skills.external_dirs',
      '  broken: [1, 2',
      '',
    ].join('\n');
    write(configPath, original);

    const lines: string[] = [];
    const result = runLegacyIntegrationRetirement({
      homes: homesOf(fixture),
      log: (line) => lines.push(line),
      now: FIXED_NOW,
    });

    expect(result.removed).toEqual([]);
    expect(result.failures.map((failure) => failure.surface)).toEqual(['hermes-skills-external-dir']);
    expect(lines).toContain('retirement incomplete: 1 failure(s)');
    expect(lines).not.toContain('nothing to retire');
    // The refused asset is untouched, and its backup is the recovery material.
    expect(readFileSync(configPath, 'utf8')).toBe(original);
    expect(result.backupRootUsed).toBe(true);
    expect(readFileSync(join(result.backupRoot, '.hermes', 'config.yaml'), 'utf8')).toBe(original);
  });

  test('the backup is complete on disk before the removal runs', () => {
    const fixture = makeFixture();
    populateClean(fixture);
    const report = classifyLegacyIntegrations(homesOf(fixture));
    const backupRoot = join(fixture.genieHome, 'state-backups', 'run');
    const agentPath = join(fixture.claudeDir, 'agents', 'genie-reviewer.md');

    const result = retireLegacyIntegrations(report, {
      backupRoot,
      now: FIXED_NOW,
      // Stand in for a crash between the backup and the mutation.
      onBeforeRemove: (entry) => {
        if (entry.path === agentPath) throw new Error('crashed before removal');
      },
    });

    expect(result.failures.map((failure) => [failure.surface, failure.reason])).toEqual([
      ['claude-agent', 'crashed before removal'],
    ]);
    // Source intact AND fully backed up: the recovery material exists either way.
    expect(readFileSync(agentPath, 'utf8')).toBe('# reviewer\n');
    expect(readFileSync(join(backupRoot, '.claude', 'agents', 'genie-reviewer.md'), 'utf8')).toBe('# reviewer\n');
  });
});

describe('the user-owned Claude registries', () => {
  test('only the automagik marketplace key goes; unknown keys round-trip', () => {
    const fixture = makeFixture();
    const path = join(fixture.claudeDir, 'plugins', 'known_marketplaces.json');
    const document = {
      schemaVersion: 4,
      somethingGenieDoesNotKnow: { nested: [1, 2, 3] },
      automagik: { source: { source: 'directory', path: fixture.genieHome }, installLocation: fixture.genieHome },
      'other-market': { source: { source: 'git', repo: 'someone/else' }, trusted: true },
    };
    write(path, `${JSON.stringify(document, null, 2)}\n`);

    const result = runLegacyIntegrationRetirement({ homes: homesOf(fixture), log: () => undefined, now: FIXED_NOW });
    expect(result.removed.map((entry) => entry.surface)).toEqual(['claude-marketplace-registration']);
    const { automagik: _dropped, ...rest } = document;
    expect(readFileSync(path, 'utf8')).toBe(`${JSON.stringify(rest, null, 2)}\n`);
  });

  test('an automagik marketplace pointed somewhere else is unmanaged and untouched', () => {
    const fixture = makeFixture();
    const path = join(fixture.claudeDir, 'plugins', 'known_marketplaces.json');
    const checkout = join(fixture.home, 'dev-checkout');
    const original = `${JSON.stringify({ automagik: { source: { source: 'directory', path: checkout } } }, null, 2)}\n`;
    write(path, original);

    const result = runLegacyIntegrationRetirement({ homes: homesOf(fixture), log: () => undefined, now: FIXED_NOW });
    expect(result.removed).toEqual([]);
    expect(result.kept.map((entry) => [entry.surface, entry.state])).toEqual([
      ['claude-marketplace-registration', 'unmanaged'],
    ]);
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  test('only the genie@automagik enabledPlugins key goes; the rest of settings round-trips', () => {
    const fixture = makeFixture();
    const path = join(fixture.claudeDir, 'settings.json');
    const document = {
      model: 'opus',
      hooks: { SessionStart: [{ command: 'user-own' }] },
      enabledPlugins: { 'other@market': true, 'genie@automagik': false, 'third@market': false },
      permissions: { allow: ['Bash(ls:*)'] },
    };
    write(path, `${JSON.stringify(document, null, 2)}\n`);

    const result = runLegacyIntegrationRetirement({ homes: homesOf(fixture), log: () => undefined, now: FIXED_NOW });
    // `false` proves an owned registration exactly as `true` does.
    expect(result.removed.map((entry) => entry.surface)).toEqual(['claude-enabled-plugin']);
    expect(readFileSync(path, 'utf8')).toBe(
      `${JSON.stringify({ ...document, enabledPlugins: { 'other@market': true, 'third@market': false } }, null, 2)}\n`,
    );
  });

  test('settings without the genie key are absent, not touched', () => {
    const fixture = makeFixture();
    const path = join(fixture.claudeDir, 'settings.json');
    const original = `${JSON.stringify({ enabledPlugins: { 'other@market': true } }, null, 2)}\n`;
    write(path, original);

    const result = runLegacyIntegrationRetirement({ homes: homesOf(fixture), log: () => undefined, now: FIXED_NOW });
    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([]);
    expect(readFileSync(path, 'utf8')).toBe(original);
  });
});

describe('idempotence', () => {
  test('a second retirement removes nothing and changes no byte under the home', () => {
    const fixture = makeFixture();
    populateClean(fixture);
    runLegacyIntegrationRetirement({ homes: homesOf(fixture), log: () => undefined, now: FIXED_NOW });
    const afterFirst = hashTree(fixture.home);

    const lines: string[] = [];
    const second = runLegacyIntegrationRetirement({
      homes: homesOf(fixture),
      log: (line) => lines.push(line),
      // A DIFFERENT clock: a second run must not allocate a fresh backup root.
      now: new Date('2026-09-01T00:00:00.000Z'),
    });
    expect(second.removed).toEqual([]);
    expect(second.backupRootUsed).toBe(false);
    expect(lines).toEqual(['nothing to retire']);
    expect(hashTree(fixture.home)).toBe(afterFirst);
  });

  test('no skill name survives twice across the codex, claude, and plugin-cache tiers', () => {
    const fixture = makeFixture();
    populateClean(fixture);
    // The skills.sh channel's own copies, under the names the plugin era mirrored.
    for (const agentSkills of [join(fixture.codexHome, 'skills'), join(fixture.claudeDir, 'skills')]) {
      for (const name of ['wish', 'review', 'legacy-mirror', 'legacy-curated']) {
        write(join(agentSkills, name, 'SKILL.md'), `# ${name}\n`);
      }
    }
    runLegacyIntegrationRetirement({ homes: homesOf(fixture), log: () => undefined, now: FIXED_NOW });

    for (const agentSkills of [join(fixture.codexHome, 'skills'), join(fixture.claudeDir, 'skills')]) {
      const names = readdirSync(agentSkills).sort();
      expect(names).toEqual(['legacy-curated', 'legacy-mirror', 'review', 'wish']);
      expect(new Set(names).size).toBe(names.length);
    }
    // Both plugin caches are gone — dirs and all — so no name is served twice.
    for (const cache of [
      join(fixture.codexHome, 'plugins', 'cache', 'automagik'),
      join(fixture.claudeDir, 'plugins', 'cache', 'automagik'),
    ]) {
      expect(existsSync(cache)).toBe(false);
    }
  });
});

describe('backups', () => {
  test('a removed file lands home-relative under the run root; a cache lands as a manifest', () => {
    const fixture = makeFixture();
    populateClean(fixture);
    const result = runLegacyIntegrationRetirement({ homes: homesOf(fixture), log: () => undefined, now: FIXED_NOW });
    expect(result.backupRoot).toBe(
      join(fixture.genieHome, 'state-backups', 'integration-retirement-2026-08-30T12-00-00-000Z'),
    );

    const agentBackup = join(result.backupRoot, '.claude', 'agents', 'genie-reviewer.md');
    expect(readFileSync(agentBackup, 'utf8')).toBe('# reviewer\n');
    const configBackup = readFileSync(join(result.backupRoot, '.codex', 'config.toml'), 'utf8');
    expect(configBackup).toContain('[plugins."genie@automagik"]');

    // Re-downloadable plugin payload: a listing, not the bytes. Three now: the
    // two plugin-cache generations plus the automagik marketplace bundle cache.
    const manifests = readdirSync(join(result.backupRoot, 'cache-manifests'));
    expect(manifests).toHaveLength(3);
    expect(readFileSync(join(result.backupRoot, 'cache-manifests', manifests[0]), 'utf8')).toContain('plugin.json');

    // A symlink's recovery material is its target.
    expect(readFileSync(`${join(result.backupRoot, '.pi', 'agent', 'extensions', 'genie')}.symlink`, 'utf8')).toBe(
      `${join(fixture.genieHome, 'plugins', 'pi-genie')}\n`,
    );
  });

  test('the pristine bytes win when two surfaces share one file', () => {
    const fixture = makeFixture();
    populateClean(fixture);
    const original = readFileSync(join(fixture.hermesHome, 'config.yaml'), 'utf8');
    const result = runLegacyIntegrationRetirement({ homes: homesOf(fixture), log: () => undefined, now: FIXED_NOW });
    // The MCP leg and the skills leg both retire from config.yaml; the backup
    // must hold the file as it was BEFORE either one ran.
    expect(readFileSync(join(result.backupRoot, '.hermes', 'config.yaml'), 'utf8')).toBe(original);
  });

  test('an agent home outside $HOME still backs up without climbing out of the run root', () => {
    const fixture = makeFixture();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'genie-retire-outside-')));
    fixtures.push(outside);
    write(join(outside, 'config.toml'), '[plugins."genie@automagik"]\nenabled = true\n');

    const result = runLegacyIntegrationRetirement({
      homes: { ...homesOf(fixture), codexHome: outside },
      log: () => undefined,
      now: FIXED_NOW,
    });
    const backup = result.removed.find((entry) => entry.surface === 'codex-plugin-registration')?.backupPath;
    expect(backup).toBe(join(result.backupRoot, 'absolute', join(outside, 'config.toml').replace(/^\//, '')));
    expect(readFileSync(backup as string, 'utf8')).toContain('genie@automagik');
    expect(lstatSync(join(outside, 'config.toml')).isFile()).toBe(true);
    expect(readFileSync(join(outside, 'config.toml'), 'utf8')).toBe('');
  });
});

// ---------------------------------------------------------------------------

describe('codex-role-agent-inventory — the sidecar the role-agent surface never saw', () => {
  const inventoryPathOf = (fixture: Fixture): string => join(fixture.codexHome, 'agents', '.genie-role-agents.json');

  test('a genie-owned inventory is managed-clean and is removed with its transaction debris', () => {
    const fixture = makeFixture();
    write(
      inventoryPathOf(fixture),
      `${JSON.stringify({ version: 2, managedBy: 'genie-codex-role-agents', files: {} })}\n`,
    );
    for (const debris of [
      '.genie-role-agents.txn-abc',
      '.genie-role-agents.committed-cleanup-abc',
      '.genie-role-agents.prepare-abc',
      '.genie-role-agents.conflict-abc',
    ]) {
      write(join(fixture.codexHome, 'agents', debris, 'marker'), 'x\n');
    }
    // A user's own file in the same dir must be untouched.
    write(join(fixture.codexHome, 'agents', 'mine.toml'), 'name = "mine"\n');

    const { entries } = classifyLegacyIntegrations(homesOf(fixture));
    expect(statesOf(entries, 'codex-role-agent-inventory')).toEqual([
      'managed-clean',
      'managed-clean',
      'managed-clean',
      'managed-clean',
      'managed-clean',
    ]);

    const result = runLegacyIntegrationRetirement({ homes: homesOf(fixture), log: () => undefined, now: FIXED_NOW });
    expect(result.removed.filter((entry) => entry.surface === 'codex-role-agent-inventory')).toHaveLength(5);
    expect(existsSync(inventoryPathOf(fixture))).toBe(false);
    expect(existsSync(join(fixture.codexHome, 'agents', '.genie-role-agents.txn-abc'))).toBe(false);
    expect(readFileSync(join(fixture.codexHome, 'agents', 'mine.toml'), 'utf8')).toBe('name = "mine"\n');
  });

  test('an inventory that cannot prove clean genie ownership is managed-modified and kept', () => {
    const fixture = makeFixture();
    write(inventoryPathOf(fixture), '{ "version": 2 }\n');
    expect(statesOf(classifyLegacyIntegrations(homesOf(fixture)).entries, 'codex-role-agent-inventory')).toEqual([
      'managed-modified',
    ]);
    runLegacyIntegrationRetirement({ homes: homesOf(fixture), log: () => undefined, now: FIXED_NOW });
    expect(existsSync(inventoryPathOf(fixture))).toBe(true);
  });

  test("someone else's file at the same name is unmanaged and kept", () => {
    const fixture = makeFixture();
    write(inventoryPathOf(fixture), `${JSON.stringify({ managedBy: 'someone-else' })}\n`);
    expect(statesOf(classifyLegacyIntegrations(homesOf(fixture)).entries, 'codex-role-agent-inventory')).toEqual([
      'unmanaged',
    ]);
    runLegacyIntegrationRetirement({ homes: homesOf(fixture), log: () => undefined, now: FIXED_NOW });
    expect(existsSync(inventoryPathOf(fixture))).toBe(true);
  });

  test('a host that never had one classifies absent', () => {
    const fixture = makeFixture();
    expect(statesOf(classifyLegacyIntegrations(homesOf(fixture)).entries, 'codex-role-agent-inventory')).toEqual([
      'absent',
    ]);
  });
});

describe('claude-marketplace-cache — the bundle tree the evidence probe kept reading', () => {
  const cacheOf = (fixture: Fixture): string => join(fixture.claudeDir, 'plugins', 'marketplaces', 'automagik');

  test('a bundle carrying plugins/genie is managed-clean, removed, and prunes its empty parent', () => {
    const fixture = makeFixture();
    write(join(cacheOf(fixture), 'plugins', 'genie', 'plugin.json'), '{}\n');
    expect(statesOf(classifyLegacyIntegrations(homesOf(fixture)).entries, 'claude-marketplace-cache')).toEqual([
      'managed-clean',
    ]);
    const result = runLegacyIntegrationRetirement({ homes: homesOf(fixture), log: () => undefined, now: FIXED_NOW });
    expect(result.removed.map((entry) => entry.surface)).toContain('claude-marketplace-cache');
    expect(existsSync(cacheOf(fixture))).toBe(false);
  });

  test('a marketplace dir without the genie bundle is managed-modified and kept', () => {
    const fixture = makeFixture();
    write(join(cacheOf(fixture), 'README.md'), '# not ours\n');
    expect(statesOf(classifyLegacyIntegrations(homesOf(fixture)).entries, 'claude-marketplace-cache')).toEqual([
      'managed-modified',
    ]);
    runLegacyIntegrationRetirement({ homes: homesOf(fixture), log: () => undefined, now: FIXED_NOW });
    expect(existsSync(join(cacheOf(fixture), 'README.md'))).toBe(true);
  });

  test('a symlink at the marketplace path is unmanaged and kept', () => {
    const fixture = makeFixture();
    const checkout = join(fixture.home, 'dev-checkout');
    mkdirSync(checkout, { recursive: true });
    link(cacheOf(fixture), checkout);
    expect(statesOf(classifyLegacyIntegrations(homesOf(fixture)).entries, 'claude-marketplace-cache')).toEqual([
      'unmanaged',
    ]);
    runLegacyIntegrationRetirement({ homes: homesOf(fixture), log: () => undefined, now: FIXED_NOW });
    expect(readlinkSync(cacheOf(fixture))).toBe(checkout);
  });

  test('a host that never had one classifies absent', () => {
    const fixture = makeFixture();
    expect(statesOf(classifyLegacyIntegrations(homesOf(fixture)).entries, 'claude-marketplace-cache')).toEqual([
      'absent',
    ]);
  });
});

describe('the full plugin-era surface is retired in one run and never re-retired', () => {
  test('evidence flips to {codex:false, claude:false} and the second run allocates no backup root', () => {
    const fixture = makeFixture();
    populateClean(fixture);
    write(join(fixture.codexHome, 'agents', '.genie-role-agents.txn-stale', 'marker'), 'x\n');
    const evidenceHomes = { codexHome: fixture.codexHome, claudeHome: fixture.claudeDir };
    expect(inspectRuntimeIntegrationEvidence(evidenceHomes)).toMatchObject({ codex: true, claude: true });

    runLegacyIntegrationRetirement({ homes: homesOf(fixture), log: () => undefined, now: FIXED_NOW });
    expect(inspectRuntimeIntegrationEvidence(evidenceHomes)).toMatchObject({ codex: false, claude: false });

    const backupRootsAfterFirst = readdirSync(join(fixture.genieHome, 'state-backups'));
    const lines: string[] = [];
    const second = runLegacyIntegrationRetirement({
      homes: homesOf(fixture),
      log: (line) => lines.push(line),
      now: new Date('2026-08-30T13:00:00.000Z'),
    });
    expect(second.removed).toEqual([]);
    expect(second.backupRootUsed).toBe(false);
    expect(lines).toContain('nothing to retire');
    expect(readdirSync(join(fixture.genieHome, 'state-backups'))).toEqual(backupRootsAfterFirst);
  });
});

describe('sidecar-less skill directories', () => {
  test('a curated-lane dir with no sidecar is reported by path as kept and never removed', () => {
    const fixture = makeFixture();
    const orphan = join(fixture.codexHome, 'skills', '.curated', 'sidecar-less');
    write(join(orphan, 'SKILL.md'), '# orphan\n');

    const { entries } = classifyLegacyIntegrations(homesOf(fixture));
    expect(entries.filter((entry) => entry.surface === 'codex-legacy-curated-skill')).toEqual([
      {
        surface: 'codex-legacy-curated-skill',
        path: orphan,
        state: 'unmanaged',
        detail: 'no .genie-sync.json sidecar — ownership unprovable, left in place',
      },
    ]);

    const lines: string[] = [];
    runLegacyIntegrationRetirement({ homes: homesOf(fixture), log: (line) => lines.push(line), now: FIXED_NOW });
    expect(lines).toContain(
      `kept (unmanaged) codex-legacy-curated-skill: ${orphan} — no .genie-sync.json sidecar — ownership unprovable, left in place`,
    );
    expect(readFileSync(join(orphan, 'SKILL.md'), 'utf8')).toBe('# orphan\n');
  });
});

describe('writeJsonDocument durability', () => {
  // A 0o500 parent is the portable way to make the staged write fail; root
  // ignores the mode bits, so the fault cannot be induced there.
  test.skipIf(process.getuid?.() === 0)(
    'a failed rewrite leaves the original bytes byte-identical and no staging residue',
    () => {
      const fixture = makeFixture();
      const settingsPath = join(fixture.claudeDir, 'settings.json');
      const original = `${JSON.stringify({ model: 'opus', enabledPlugins: { 'genie@automagik': true } }, null, 2)}\n`;
      write(settingsPath, original);
      // The write is staged in the target's own directory, so a read-only parent
      // is the one fault that reaches production identically: ENOSPC, EIO and a
      // kill all land in the same catch.
      chmodSync(fixture.claudeDir, 0o500);
      let result: ReturnType<typeof runLegacyIntegrationRetirement>;
      try {
        result = runLegacyIntegrationRetirement({ homes: homesOf(fixture), log: () => undefined, now: FIXED_NOW });
      } finally {
        chmodSync(fixture.claudeDir, 0o700);
      }

      expect(result.failures.map((failure) => failure.surface)).toEqual(['claude-enabled-plugin']);
      expect(readFileSync(settingsPath, 'utf8')).toBe(original);
      expect(readdirSync(fixture.claudeDir).filter((name) => name.includes('genie-staging'))).toEqual([]);
    },
  );

  test('a successful rewrite commits by rename and leaves no staging sibling', () => {
    const fixture = makeFixture();
    const settingsPath = join(fixture.claudeDir, 'settings.json');
    write(settingsPath, `${JSON.stringify({ model: 'opus', enabledPlugins: { 'genie@automagik': true } }, null, 2)}\n`);
    chmodSync(settingsPath, 0o640);
    runLegacyIntegrationRetirement({ homes: homesOf(fixture), log: () => undefined, now: FIXED_NOW });
    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({ model: 'opus', enabledPlugins: {} });
    // The user's own mode survives the republish.
    expect(lstatSync(settingsPath).mode & 0o777).toBe(0o640);
    expect(readdirSync(fixture.claudeDir).filter((name) => name.includes('genie-staging'))).toEqual([]);
  });
});

describe('the surface roster', () => {
  test('every declared surface is classified, and the roster is the seventeen this module owns', () => {
    // The list is the contract `classifyLegacyIntegrations` fills in with an
    // `absent` entry for anything it did not otherwise emit, so a surface added
    // to the union but not to the array would silently never be reported.
    expect(LEGACY_INTEGRATION_SURFACES).toEqual([
      'codex-plugin-registration',
      'codex-plugin-cache',
      'codex-role-agent',
      'codex-role-agent-inventory',
      'codex-legacy-curated-skill',
      'claude-plugin-registry',
      'claude-plugin-cache',
      'claude-marketplace-registration',
      'claude-marketplace-cache',
      'claude-enabled-plugin',
      'claude-workflow',
      'claude-agent',
      'claude-skill',
      'hermes-plugin-link',
      'hermes-mcp-server',
      'hermes-skills-external-dir',
      'pi-extension-link',
    ]);
    expect(LEGACY_INTEGRATION_SURFACES).toHaveLength(17);

    const fixture = makeFixture();
    const { entries } = classifyLegacyIntegrations(homesOf(fixture));
    expect([...new Set(entries.map((entry) => entry.surface))].sort()).toEqual([...LEGACY_INTEGRATION_SURFACES].sort());
  });
});
