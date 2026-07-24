import { describe, expect, test } from 'bun:test';
import {
  type CliResult,
  assertEffectiveCodexProjectRoute,
  assertSingleCodexProjectRouteMarker,
  withIsolatedHome,
} from './codex-smoke-harness.ts';

const expectedCommand = '/isolated/.genie/bin/genie';

function result(value: unknown, exitCode = 0): CliResult {
  return {
    exitCode,
    stdout: typeof value === 'string' ? value : JSON.stringify(value),
    stderr: exitCode === 0 ? '' : 'forced failure',
  };
}

function route(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'genie',
    enabled: true,
    disabled_reason: null,
    transport: {
      type: 'stdio',
      command: expectedCommand,
      args: ['mcp'],
      cwd: null,
    },
    ...overrides,
  };
}

describe('assertEffectiveCodexProjectRoute', () => {
  test('accepts one enabled stdio route and canonicalizes get/list JSON', () => {
    const get = route();
    const list = [route()];
    const snapshot = assertEffectiveCodexProjectRoute(result(get), result(list), expectedCommand);
    expect(snapshot.route.transport).toEqual({
      type: 'stdio',
      command: expectedCommand,
      args: ['mcp'],
      cwd: null,
    });
    expect(snapshot.getJson).toContain(expectedCommand);
    expect(snapshot.listJson).toContain(expectedCommand);
  });

  test('accepts an absent cwd and list-only host metadata', () => {
    const transport = { type: 'stdio', command: expectedCommand, args: ['mcp'] };
    expect(() =>
      assertEffectiveCodexProjectRoute(
        result(route({ transport })),
        result([route({ transport, auth_status: 'unsupported' })]),
        expectedCommand,
      ),
    ).not.toThrow();
  });

  test('rejects a nonzero Codex command before parsing output', () => {
    expect(() => assertEffectiveCodexProjectRoute(result('', 7), result([route()]), expectedCommand)).toThrow(/exit 7/);
  });

  test('rejects malformed JSON', () => {
    expect(() => assertEffectiveCodexProjectRoute(result('{broken'), result([route()]), expectedCommand)).toThrow(
      /malformed JSON/,
    );
  });

  test.each([
    ['wrong command', { type: 'stdio', command: '/other/genie', args: ['mcp'], cwd: null }, /command is/],
    [
      'cache-root command',
      { type: 'stdio', command: '/x/.codex/plugins/cache/genie', args: ['mcp'], cwd: null },
      /plugin cache/,
    ],
    [
      'wrong args',
      { type: 'stdio', command: expectedCommand, args: ['mcp', '--extra'], cwd: null },
      /exactly \["mcp"\]/,
    ],
    ['effective cwd', { type: 'stdio', command: expectedCommand, args: ['mcp'], cwd: '/tmp/cache' }, /absent or null/],
  ])('rejects %s', (_label, transport, message) => {
    expect(() =>
      assertEffectiveCodexProjectRoute(result(route({ transport })), result([route({ transport })]), expectedCommand),
    ).toThrow(message);
  });

  test('rejects duplicate genie routes', () => {
    expect(() =>
      assertEffectiveCodexProjectRoute(result(route()), result([route(), route()]), expectedCommand),
    ).toThrow(/exactly one genie route, found 2/);
  });

  test.each([
    ['disabled', { enabled: false }, /must be enabled/],
    [
      'non-stdio',
      { transport: { type: 'http', command: expectedCommand, args: ['mcp'], cwd: null } },
      /type must be "stdio"/,
    ],
  ])('rejects a %s genie route', (_label, overrides, message) => {
    expect(() =>
      assertEffectiveCodexProjectRoute(result(route(overrides)), result([route(overrides)]), expectedCommand),
    ).toThrow(message);
  });
});

describe('assertSingleCodexProjectRouteMarker', () => {
  const block = '# BEGIN GENIE MCP FALLBACK\nmcp_servers.genie.command = "/g"\n# END GENIE MCP FALLBACK\n';

  test('accepts one intact marker pair', () => {
    expect(() => assertSingleCodexProjectRouteMarker(block)).not.toThrow();
  });

  test.each([
    ['missing end', '# BEGIN GENIE MCP FALLBACK\n'],
    ['end before begin', '# END GENIE MCP FALLBACK\n# BEGIN GENIE MCP FALLBACK\n'],
    ['duplicate pair', `${block}${block}`],
  ])('rejects %s', (_label, toml) => {
    expect(() => assertSingleCodexProjectRouteMarker(toml)).toThrow(/exactly one intact/);
  });
});

describe('isolated smoke environment', () => {
  test('rebases every writable config, cache, and temporary root under the fixture home', () => {
    withIsolatedHome((iso) => {
      for (const key of [
        'GENIE_HOME',
        'CODEX_HOME',
        'CLAUDE_CONFIG_DIR',
        'GENIE_AGENTS_SKILLS_DIR',
        'TMPDIR',
        'XDG_CONFIG_HOME',
        'XDG_CACHE_HOME',
        'XDG_DATA_HOME',
        'XDG_STATE_HOME',
        'BUN_INSTALL_CACHE_DIR',
        'NPM_CONFIG_CACHE',
        'GIT_CONFIG_GLOBAL',
      ]) {
        expect(iso.env[key]?.startsWith(`${iso.home}/`), key).toBe(true);
      }
      expect(iso.env.HOME).toBe(iso.home);
      expect(iso.env.GIT_CONFIG_NOSYSTEM).toBe('1');
    });
  });
});
