import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as projectMcp from './codex-project-mcp.js';
import {
  type RouteLayerInput,
  classifyRouteLayers,
  inspectRetiredJsonMcpEntry,
  isRetiredGenieMcpServer,
  projectTrustState,
  retireJsonMcpGenieEntry,
  retireProjectMcpConfigs,
} from './codex-project-mcp.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'genie-project-mcp-retirement-'));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('retireProjectMcpConfigs', () => {
  test('exports no registration or revival API', () => {
    for (const name of [
      'genieMcpEntry',
      'mergeCodexMcpFallback',
      'preflightCodexPluginMutation',
      'reconcileCodexProjectMcp',
      'registerProjectMcpConfigs',
    ]) {
      expect(Object.hasOwn(projectMcp, name), name).toBe(false);
    }
  });
  test('leaves an unparseable .mcp.json byte-for-byte alone and reports why', () => {
    const original = '{ definitely not json\n';
    writeFileSync(join(root, '.mcp.json'), original);
    expect(retireProjectMcpConfigs(root)[0]).toMatchObject({ action: 'skipped' });
    expect(retireProjectMcpConfigs(root)[0].detail).toContain('not valid JSON');
    expect(readFileSync(join(root, '.mcp.json'), 'utf8')).toBe(original);
  });

  test('retires the dead `genie mcp` entry from .mcp.json', () => {
    writeFileSync(
      join(root, '.mcp.json'),
      '{\n  "mcpServers": { "genie": { "command": "/old/genie", "args": ["mcp"] }, "keep": { "command": "k" } }\n}\n',
    );
    expect(retireProjectMcpConfigs(root)[0]).toMatchObject({ action: 'updated' });
    expect(readFileSync(join(root, '.mcp.json'), 'utf8')).toBe(
      '{\n  "mcpServers": { "keep": { "command": "k" } }\n}\n',
    );
  });

  test('reports the Codex outcome it actually produced, never a fixed retirement claim', () => {
    // No .codex/config.toml at all: nothing was retired, and the detail says so.
    expect(retireProjectMcpConfigs(root)[1]).toMatchObject({
      action: 'skipped',
      detail: 'no marker-owned project registration to retire',
    });
    mkdirSync(join(root, '.codex'), { recursive: true });
    writeFileSync(
      join(root, '.codex', 'config.toml'),
      '# BEGIN GENIE MCP FALLBACK\n[mcp_servers.genie]\ncommand = "/old"\n# END GENIE MCP FALLBACK\n',
    );
    expect(retireProjectMcpConfigs(root)[1]).toMatchObject({
      action: 'updated',
      detail: 'retired marker-owned project registration',
    });
  });

  test('removes exactly one complete owned marker pair and keeps unrelated TOML', () => {
    const config = join(root, '.codex', 'config.toml');
    mkdirSync(join(root, '.codex'), { recursive: true });
    writeFileSync(
      config,
      'model = "keep"\n# BEGIN GENIE MCP FALLBACK\n[mcp_servers.genie]\ncommand = "/old"\nargs = ["mcp"]\n# END GENIE MCP FALLBACK\n',
    );

    expect(retireProjectMcpConfigs(root)[1]).toMatchObject({ action: 'updated' });
    expect(readFileSync(config, 'utf8')).toBe('model = "keep"\n');
  });

  test('refuses duplicate or incomplete markers without mutation', () => {
    const config = join(root, '.codex', 'config.toml');
    mkdirSync(join(root, '.codex'), { recursive: true });
    const fixtures = [
      '# BEGIN GENIE MCP FALLBACK\n[mcp_servers.genie]\n',
      '# BEGIN GENIE MCP FALLBACK\n# END GENIE MCP FALLBACK\n# BEGIN GENIE MCP FALLBACK\n# END GENIE MCP FALLBACK\n',
    ];
    for (const original of fixtures) {
      writeFileSync(config, original);
      expect(() => retireProjectMcpConfigs(root)).toThrow();
      expect(readFileSync(config, 'utf8')).toBe(original);
    }
  });
});

describe('shipped plugin payload', () => {
  test('contains no Genie-owned MCP route, capability, launcher, or server', () => {
    const plugin = join(import.meta.dir, '..', '..', 'plugins', 'genie');
    // The Claude and Kimi manifests left with their payloads; the Orca manifest
    // and the compatibility metadata beside it are what still ships.
    const manifests = [join(plugin, 'orca-plugin.json'), join(plugin, 'plugin.json')];
    for (const path of manifests) {
      const text = readFileSync(path, 'utf8');
      expect(text).not.toContain('mcpServers');
      expect(text).not.toContain('mcp-launcher');
    }
    expect(existsSync(join(plugin, '.mcp.json'))).toBe(false);
    expect(existsSync(join(plugin, 'scripts', 'mcp-launcher.cjs'))).toBe(false);
  });
});

// ============================================================================
// The retired `genie mcp` registration in .mcp.json
// ============================================================================

/** The only entry shape init may remove. */
const RETIRED = { command: '/home/u/.genie/bin/genie', args: ['mcp'] };

describe('isRetiredGenieMcpServer', () => {
  test('matches only a genie binary invoked with exactly ["mcp"]', () => {
    expect(isRetiredGenieMcpServer(RETIRED)).toBe(true);
    expect(isRetiredGenieMcpServer({ command: 'genie', args: ['mcp'] })).toBe(true);
    expect(isRetiredGenieMcpServer({ command: 'C:\\tools\\genie.exe', args: ['mcp'] })).toBe(true);
  });

  test('never matches a user-owned entry that merely shares the `genie` key', () => {
    for (const entry of [
      { command: '/personal', args: ['mcp'] }, // a wrapper, not the genie binary
      { command: '/bin/genie-wrapper', args: ['mcp'] },
      { command: '/bin/genie', args: ['mcp', '--verbose'] }, // extra args
      { command: '/bin/genie', args: [] },
      { command: '/bin/genie', args: 'mcp' },
      { command: '/bin/genie' }, // no args at all
      { args: ['mcp'] },
      'genie mcp',
      null,
    ]) {
      expect(isRetiredGenieMcpServer(entry), JSON.stringify(entry)).toBe(false);
    }
  });
});

describe('inspectRetiredJsonMcpEntry', () => {
  test('reports every non-actionable state instead of throwing', () => {
    expect(inspectRetiredJsonMcpEntry(root).state).toBe('absent');

    writeFileSync(join(root, '.mcp.json'), '{"mcpServers":[]}');
    expect(inspectRetiredJsonMcpEntry(root).state).toBe('clean');

    writeFileSync(join(root, '.mcp.json'), '{"mcpServers":{"genie":{"command":"/personal","args":["mcp"]}}}');
    expect(inspectRetiredJsonMcpEntry(root).state).toBe('clean');

    writeFileSync(join(root, '.mcp.json'), 'nope');
    expect(inspectRetiredJsonMcpEntry(root).state).toBe('unreadable');
  });

  test('a symlinked .mcp.json is its own reported state — never followed, never an error', () => {
    writeFileSync(join(root, 'real.json'), JSON.stringify({ mcpServers: { genie: RETIRED } }));
    symlinkSync('real.json', join(root, '.mcp.json'));
    const finding = inspectRetiredJsonMcpEntry(root);
    expect(finding.state).toBe('symlink');
    expect(finding.detail).toContain('symlink');
  });

  test('finds the retired registration', () => {
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { genie: RETIRED } }));
    expect(inspectRetiredJsonMcpEntry(root).state).toBe('present');
  });
});

describe('retireJsonMcpGenieEntry', () => {
  const mcp = () => join(root, '.mcp.json');
  const backups = () => readdirSync(root).filter((name) => name.includes('.genie-backup-'));

  test('splices out ONLY the dead entry, leaving every other byte untouched', () => {
    const original = [
      '{',
      '  "mcpServers": {',
      '    "genie": { "command": "/home/u/.genie/bin/genie", "args": ["mcp"] },',
      '    "other": { "command": "node",   "args": ["srv.js"], "env": { "A": "b" } }',
      '  },',
      '  "somethingElse": true',
      '}',
      '',
    ].join('\n');
    writeFileSync(mcp(), original);

    expect(retireJsonMcpGenieEntry(root)).toMatchObject({ action: 'updated' });
    expect(readFileSync(mcp(), 'utf8')).toBe(
      [
        '{',
        '  "mcpServers": {',
        '    "other": { "command": "node",   "args": ["srv.js"], "env": { "A": "b" } }',
        '  },',
        '  "somethingElse": true',
        '}',
        '',
      ].join('\n'),
    );
  });

  test('removes a trailing dead entry without leaving a dangling comma', () => {
    writeFileSync(mcp(), '{"mcpServers":{"a":{"command":"y"},"genie":{"command":"/x/genie","args":["mcp"]}}}');
    expect(retireJsonMcpGenieEntry(root)).toMatchObject({ action: 'updated' });
    expect(readFileSync(mcp(), 'utf8')).toBe('{"mcpServers":{"a":{"command":"y"}}}');
  });

  test('backs the file up before touching it', () => {
    const original = JSON.stringify({ mcpServers: { genie: RETIRED, keep: { command: 'k' } } });
    writeFileSync(mcp(), original);
    const result = retireJsonMcpGenieEntry(root, new Date('2026-08-30T01:02:03.004Z'));
    expect(result.detail).toContain('.mcp.json.genie-backup-2026-08-30T01-02-03-004Z');
    expect(readFileSync(join(root, '.mcp.json.genie-backup-2026-08-30T01-02-03-004Z'), 'utf8')).toBe(original);
  });

  test('removes the file only when the dead entry was all it held', () => {
    writeFileSync(mcp(), '{"mcpServers":{"genie":{"command":"/x/genie","args":["mcp"]}}}');
    expect(retireJsonMcpGenieEntry(root)).toMatchObject({ action: 'updated' });
    expect(existsSync(mcp())).toBe(false);
    expect(backups()).toHaveLength(1);
  });

  test('keeps a file that still holds another top-level key', () => {
    writeFileSync(mcp(), '{"mcpServers":{"genie":{"command":"/x/genie","args":["mcp"]}},"keep":1}');
    expect(retireJsonMcpGenieEntry(root)).toMatchObject({ action: 'updated' });
    expect(readFileSync(mcp(), 'utf8')).toBe('{"mcpServers":{},"keep":1}');
  });

  test('preserves the file mode', () => {
    writeFileSync(mcp(), '{"mcpServers":{"genie":{"command":"/x/genie","args":["mcp"]},"k":{"command":"k"}}}', {
      mode: 0o644,
    });
    retireJsonMcpGenieEntry(root);
    expect(statSync(mcp()).mode & 0o777).toBe(0o644);
  });

  test('is a reported no-op on a symlink, an absent file, and a clean file — and writes no backup', () => {
    expect(retireJsonMcpGenieEntry(root)).toMatchObject({ action: 'skipped' });

    writeFileSync(join(root, 'real.json'), JSON.stringify({ mcpServers: { genie: RETIRED } }));
    symlinkSync('real.json', mcp());
    expect(retireJsonMcpGenieEntry(root)).toMatchObject({ action: 'skipped' });
    expect(readFileSync(join(root, 'real.json'), 'utf8')).toBe(JSON.stringify({ mcpServers: { genie: RETIRED } }));
    expect(backups()).toHaveLength(0);
  });

  test('is idempotent — the second run finds nothing to retire', () => {
    writeFileSync(mcp(), '{"mcpServers":{"genie":{"command":"/x/genie","args":["mcp"]},"k":{"command":"k"}}}');
    expect(retireJsonMcpGenieEntry(root)).toMatchObject({ action: 'updated' });
    const after = readFileSync(mcp(), 'utf8');
    expect(retireJsonMcpGenieEntry(root)).toMatchObject({ action: 'skipped' });
    expect(readFileSync(mcp(), 'utf8')).toBe(after);
  });
});

// Moved verbatim from the retired Codex lifecycle-truth test with the
// route-layer classifier itself.
describe('classifyRouteLayers (typed config-layer diagnostics)', () => {
  const root = resolve('/repo');
  function input(over: Partial<RouteLayerInput> = {}): RouteLayerInput {
    return {
      worktreeRoot: root,
      cwd: root,
      route: { route: 'fallback', detail: 'project fallback' },
      globalConfigPath: '/codex-home/config.toml',
      readFile: () => null,
      exists: () => false,
      ...over,
    };
  }
  const trustedGlobal = `[projects."${root}"]\ntrust_level = "trusted"\n`;

  test('an intact trusted route yields zero findings', () => {
    const findings = classifyRouteLayers(
      input({ readFile: (path) => (path === '/codex-home/config.toml' ? trustedGlobal : null) }),
    );
    expect(findings).toEqual([]);
  });

  test('plugin+project conflict is a route-collision', () => {
    const findings = classifyRouteLayers(
      input({
        route: { route: 'conflict', detail: 'both routes effective' },
        readFile: (path) => (path === '/codex-home/config.toml' ? trustedGlobal : null),
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'route-collision' });
    expect(findings[0]?.detail).toContain('both routes effective');
  });

  test('a user-owned same-key project route is a route-collision that names user resolution', () => {
    const findings = classifyRouteLayers(
      input({
        route: { route: 'unmanaged-fallback', detail: 'unmanaged [mcp_servers.genie]' },
        readFile: (path) => (path === '/codex-home/config.toml' ? trustedGlobal : null),
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'route-collision' });
    expect(findings[0]?.detail).toContain('user-owned');
    expect(findings[0]?.detail).toContain('user resolution');
  });

  test('a nested .codex/config.toml nearer to the CWD shadows the root marker (nearest owner reported)', () => {
    const nested = join(root, 'packages', 'web');
    const mid = join(root, 'packages');
    const shadowConfig = '[mcp_servers.genie]\ncommand = "other"\n';
    const files: Record<string, string> = {
      [join(nested, '.codex', 'config.toml')]: shadowConfig,
      [join(mid, '.codex', 'config.toml')]: shadowConfig,
      '/codex-home/config.toml': trustedGlobal,
    };
    const findings = classifyRouteLayers(
      input({
        cwd: nested,
        readFile: (path) => files[path] ?? null,
        exists: (path) => path in files,
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'route-shadowed', ownerPath: nested });
  });

  test('a nested config without a genie route does not shadow', () => {
    const nested = join(root, 'packages');
    const files: Record<string, string> = {
      [join(nested, '.codex', 'config.toml')]: '[mcp_servers.other]\ncommand = "x"\n',
      '/codex-home/config.toml': trustedGlobal,
    };
    const findings = classifyRouteLayers(
      input({ cwd: nested, readFile: (path) => files[path] ?? null, exists: (path) => path in files }),
    );
    expect(findings).toEqual([]);
  });

  test('a CWD outside the worktree root never walks the chain', () => {
    const findings = classifyRouteLayers(
      input({
        cwd: '/elsewhere',
        readFile: (path) => (path === '/codex-home/config.toml' ? trustedGlobal : null),
        exists: () => {
          throw new Error('chain walk must not run for an outside CWD');
        },
      }),
    );
    expect(findings).toEqual([]);
  });

  test('the dotted-key route spelling (the marker form) is detected in nested and global layers', () => {
    const nested = join(root, 'packages');
    const dottedConfig = 'mcp_servers.genie.command = "/elsewhere/genie"\nmcp_servers.genie.args = ["mcp"]\n';
    const files: Record<string, string> = {
      [join(nested, '.codex', 'config.toml')]: dottedConfig,
      '/codex-home/config.toml': `${dottedConfig}${trustedGlobal}`,
    };
    const findings = classifyRouteLayers(
      input({ cwd: nested, readFile: (path) => files[path] ?? null, exists: (path) => path in files }),
    );
    expect(findings.map((finding) => finding.kind).sort()).toEqual(['global-route-same-key', 'route-shadowed']);
  });

  test('a dotted-key inline-table route (mcp_servers.genie = {…}) is detected', () => {
    const findings = classifyRouteLayers(
      input({
        readFile: (path) =>
          path === '/codex-home/config.toml'
            ? `mcp_servers.genie = { command = "/old/genie", args = [] }\n${trustedGlobal}`
            : null,
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'global-route-same-key' });
  });

  test('a non-genie dotted key or unrelated assignment does not false-positive', () => {
    const findings = classifyRouteLayers(
      input({
        readFile: (path) =>
          path === '/codex-home/config.toml'
            ? `mcp_servers.other.command = "/x"\nsome_genie_note = "mcp_servers.genie"\n${trustedGlobal}`
            : null,
      }),
    );
    expect(findings).toEqual([]);
  });

  test('a global same-key route is reported and preserved', () => {
    const findings = classifyRouteLayers(
      input({
        readFile: (path) =>
          path === '/codex-home/config.toml' ? `[mcp_servers.genie]\ncommand = "old"\n${trustedGlobal}` : null,
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'global-route-same-key', path: '/codex-home/config.toml' });
  });

  test('an explicit non-trusted trust_level is untrusted-config', () => {
    const findings = classifyRouteLayers(
      input({
        readFile: (path) =>
          path === '/codex-home/config.toml' ? `[projects."${root}"]\ntrust_level = "untrusted"\n` : null,
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'untrusted-config' });
    expect(findings[0]?.detail).toContain("'untrusted'");
  });

  test('no trust entry at all is project-trust-required', () => {
    const findings = classifyRouteLayers(input());
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'project-trust-required' });
  });

  test('trust entry for a DIFFERENT project does not trust this one', () => {
    const findings = classifyRouteLayers(
      input({
        readFile: (path) =>
          path === '/codex-home/config.toml' ? `[projects."/other/repo"]\ntrust_level = "trusted"\n` : null,
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'project-trust-required' });
  });
});

describe('projectTrustState (bounded targeted parse)', () => {
  const root = resolve('/repo');

  test('trusted entry is trusted', () => {
    expect(projectTrustState(`[projects."${root}"]\ntrust_level = "trusted"\n`, root)).toEqual({ state: 'trusted' });
  });

  test('trust_level read stops at the next section header', () => {
    const config = `[projects."${root}"]\nother = 1\n[projects."/other"]\ntrust_level = "trusted"\n`;
    expect(projectTrustState(config, root)).toEqual({ state: 'unknown' });
  });

  test('null config (absent/unreadable/oversized) is unknown', () => {
    expect(projectTrustState(null, root)).toEqual({ state: 'unknown' });
  });
});
