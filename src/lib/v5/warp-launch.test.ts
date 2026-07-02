import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InvalidCwdError,
  type LaunchSpec,
  type PaneSpec,
  UnsafeSlugError,
  UnsupportedPlatformError,
  WarpLaunchError,
  buildLaunchConfig,
  buildLaunchConfigYaml,
  launchUri,
  resolveWarpConfigDir,
  writeLaunchConfig,
} from './warp-launch.js';

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

/** Build a spec of `n` panes with distinct absolute cwds and commands. */
function specWith(n: number, slug = 'my-wish'): LaunchSpec {
  const panes: PaneSpec[] = [];
  for (let i = 0; i < n; i++) {
    panes.push({ title: `pane ${i}`, cwd: `/work/tree/${i}`, command: `echo ${i}` });
  }
  return { slug, panes };
}

/** Round-trip through Bun.YAML: stringify owns quoting, parse proves fidelity. */
function roundTrip(spec: LaunchSpec): unknown {
  return Bun.YAML.parse(buildLaunchConfigYaml(spec));
}

/**
 * Flatten a layout tree into its leaf panes (nodes carrying a `cwd`), preserving
 * left-to-right order. Lets tests assert pane count/content without hard-coding
 * the split nesting.
 */
function leavesOf(layout: unknown): Array<Record<string, unknown>> {
  const node = layout as Record<string, unknown>;
  if (Array.isArray(node.panes)) {
    return (node.panes as unknown[]).flatMap(leavesOf);
  }
  return [node];
}

function tabsOf(config: unknown): Array<Record<string, unknown>> {
  const windows = (config as { windows: Array<{ tabs: Array<Record<string, unknown>> }> }).windows;
  return windows[0].tabs;
}

// ----------------------------------------------------------------------------
// buildLaunchConfig structure
// ----------------------------------------------------------------------------

describe('buildLaunchConfig — tab chunking', () => {
  test.each([
    [1, 1, [1]],
    [3, 1, [3]],
    [4, 1, [4]],
    [5, 2, [4, 1]],
    [9, 3, [4, 4, 1]],
  ])('%i panes → %i tab(s) with panes-per-tab %j', (paneCount, tabCount, perTab) => {
    const config = roundTrip(specWith(paneCount));
    const tabs = tabsOf(config);
    expect(tabs).toHaveLength(tabCount);
    expect(tabs.map((t) => leavesOf(t.layout).length)).toEqual(perTab);
  });

  test('overflow tab titles: bare slug, then "(2)", "(3)"', () => {
    const tabs = tabsOf(roundTrip(specWith(9)));
    expect(tabs.map((t) => t.title)).toEqual(['my-wish', 'my-wish (2)', 'my-wish (3)']);
  });

  test('tab colors cycle through the allowed ANSI set', () => {
    // 28 panes → 7 tabs, so the 6-color cycle wraps once (tab 7 reuses Red).
    const tabs = tabsOf(roundTrip(specWith(28)));
    expect(tabs.map((t) => t.color)).toEqual(['Red', 'Green', 'Yellow', 'Blue', 'Magenta', 'Cyan', 'Red']);
  });

  test('only the very first pane is focused', () => {
    const config = roundTrip(specWith(9));
    const focused: Array<Record<string, unknown>> = [];
    for (const tab of tabsOf(config)) {
      for (const leaf of leavesOf(tab.layout)) {
        if (leaf.is_focused === true) focused.push(leaf);
      }
    }
    expect(focused).toHaveLength(1);
    expect(focused[0].cwd).toBe('/work/tree/0');
    // The focus flag is omitted (not `false`) on every other pane.
    expect(tabsOf(config)[0].layout).toMatchObject({});
    const secondLeaf = leavesOf(tabsOf(config)[0].layout)[1];
    expect(secondLeaf).not.toHaveProperty('is_focused');
  });

  test('cwds, exec commands, and titles survive the round-trip in order', () => {
    const config = roundTrip(specWith(4));
    const leaves = leavesOf(tabsOf(config)[0].layout);
    expect(leaves.map((l) => l.cwd)).toEqual(['/work/tree/0', '/work/tree/1', '/work/tree/2', '/work/tree/3']);
    expect(leaves.map((l) => l.title)).toEqual(['pane 0', 'pane 1', 'pane 2', 'pane 3']);
    expect(leaves.map((l) => (l.commands as Array<{ exec: string }>)[0].exec)).toEqual([
      'echo 0',
      'echo 1',
      'echo 2',
      'echo 3',
    ]);
  });

  test('top name is the slug and active_tab_index is 0', () => {
    const config = roundTrip(specWith(5)) as {
      name: string;
      windows: Array<{ active_tab_index: number }>;
    };
    expect(config.name).toBe('my-wish');
    expect(config.windows[0].active_tab_index).toBe(0);
  });

  test('a pane without a command emits no commands key', () => {
    const config = roundTrip({ slug: 's', panes: [{ cwd: '/abs/path' }] });
    const leaf = leavesOf(tabsOf(config)[0].layout)[0];
    expect(leaf.cwd).toBe('/abs/path');
    expect(leaf).not.toHaveProperty('commands');
    expect(leaf).not.toHaveProperty('title');
  });
});

// ----------------------------------------------------------------------------
// Hostile-content fidelity
// ----------------------------------------------------------------------------

describe('buildLaunchConfig — hostile content round-trips', () => {
  const hostile: PaneSpec[] = [
    { title: 'quotes "double" and \'single\'', cwd: '/repo/a', command: 'echo "hi" && ls' },
    { title: 'shell $(whoami) `back`', cwd: '/repo/b', command: 'grep -r "$(pwd)" . && echo done' },
    { title: 'line one\nline two', cwd: '/repo/c', command: 'printf "a\\nb"\ntrue' },
    { title: 'colon: value #hash [bracket] {brace}', cwd: '/repo/d', command: "python -c 'print(1)' & wait" },
  ];

  test('titles and commands with quotes/shell/newlines survive stringify→parse', () => {
    const spec: LaunchSpec = { slug: 'danger', panes: hostile };
    const parsed = roundTrip(spec);
    const leaves = leavesOf(tabsOf(parsed)[0].layout);
    expect(leaves.map((l) => l.title)).toEqual(hostile.map((p) => p.title));
    expect(leaves.map((l) => (l.commands as Array<{ exec: string }>)[0].exec)).toEqual(
      hostile.map((p) => p.command as string),
    );
  });

  test('a slug with special characters is preserved as name and tab title', () => {
    const spec: LaunchSpec = {
      slug: 'weird: slug & "stuff"',
      panes: [{ cwd: '/x', command: 'true' }],
    };
    const parsed = roundTrip(spec) as { name: string };
    expect(parsed.name).toBe('weird: slug & "stuff"');
    expect(tabsOf(parsed)[0].title).toBe('weird: slug & "stuff"');
  });
});

// ----------------------------------------------------------------------------
// cwd validation
// ----------------------------------------------------------------------------

describe('buildLaunchConfig — cwd rejection', () => {
  test.each([['relative/path'], ['./here'], ['../up'], ['~'], ['~/nested'], ['']])(
    'rejects non-absolute cwd %j with InvalidCwdError',
    (bad) => {
      const spec: LaunchSpec = { slug: 's', panes: [{ cwd: bad }] };
      expect(() => buildLaunchConfig(spec)).toThrow(InvalidCwdError);
      try {
        buildLaunchConfig(spec);
      } catch (err) {
        expect(err).toBeInstanceOf(WarpLaunchError);
        expect((err as InvalidCwdError).cwd).toBe(bad);
      }
    },
  );

  test('rejects a bad cwd even when it is not the first pane', () => {
    const spec: LaunchSpec = {
      slug: 's',
      panes: [{ cwd: '/good' }, { cwd: 'bad/relative' }],
    };
    expect(() => buildLaunchConfig(spec)).toThrow(InvalidCwdError);
  });

  test('an empty pane list is rejected as a WarpLaunchError (not InvalidCwd)', () => {
    expect(() => buildLaunchConfig({ slug: 's', panes: [] })).toThrow(WarpLaunchError);
    expect(() => buildLaunchConfig({ slug: 's', panes: [] })).not.toThrow(InvalidCwdError);
  });
});

// ----------------------------------------------------------------------------
// resolveWarpConfigDir
// ----------------------------------------------------------------------------

describe('resolveWarpConfigDir', () => {
  test('darwin: ~/.warp/launch_configurations', () => {
    expect(resolveWarpConfigDir({ platform: 'darwin', homedir: '/Users/me', env: {} })).toBe(
      '/Users/me/.warp/launch_configurations',
    );
  });

  test('linux default: ~/.local/share/warp-terminal/launch_configurations', () => {
    expect(resolveWarpConfigDir({ platform: 'linux', homedir: '/home/me', env: {} })).toBe(
      '/home/me/.local/share/warp-terminal/launch_configurations',
    );
  });

  test('linux honors XDG_DATA_HOME override', () => {
    expect(resolveWarpConfigDir({ platform: 'linux', homedir: '/home/me', env: { XDG_DATA_HOME: '/xdg/data' } })).toBe(
      '/xdg/data/warp-terminal/launch_configurations',
    );
  });

  test('linux ignores an empty XDG_DATA_HOME and falls back to the default', () => {
    expect(resolveWarpConfigDir({ platform: 'linux', homedir: '/home/me', env: { XDG_DATA_HOME: '' } })).toBe(
      '/home/me/.local/share/warp-terminal/launch_configurations',
    );
  });

  test('unknown platform throws UnsupportedPlatformError', () => {
    expect(() => resolveWarpConfigDir({ platform: 'win32', homedir: 'C:\\Users\\me', env: {} })).toThrow(
      UnsupportedPlatformError,
    );
  });
});

// ----------------------------------------------------------------------------
// writeLaunchConfig + launchUri
// ----------------------------------------------------------------------------

describe('writeLaunchConfig', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'warp-launch-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('writes genie-<slug>.yaml into an injected dir and returns its abs path', () => {
    const target = join(dir, 'nested', 'launch_configurations');
    const path = writeLaunchConfig(specWith(3, 'feature-x'), { dir: target });
    expect(path).toBe(join(target, 'genie-feature-x.yaml'));

    const onDisk = Bun.YAML.parse(readFileSync(path, 'utf-8'));
    expect((onDisk as { name: string }).name).toBe('feature-x');
    expect(tabsOf(onDisk)).toHaveLength(1);
    expect(leavesOf(tabsOf(onDisk)[0].layout)).toHaveLength(3);
  });

  test('resolves the platform dir when no explicit dir is given', () => {
    const path = writeLaunchConfig(specWith(1, 'plat'), {
      platform: 'linux',
      homedir: dir,
      env: {},
    });
    expect(path).toBe(join(dir, '.local', 'share', 'warp-terminal', 'launch_configurations', 'genie-plat.yaml'));
    expect(readFileSync(path, 'utf-8').length).toBeGreaterThan(0);
  });

  test('an invalid cwd throws before any file is written', () => {
    const target = join(dir, 'should-stay-empty');
    expect(() => writeLaunchConfig({ slug: 's', panes: [{ cwd: 'nope' }] }, { dir: target })).toThrow(InvalidCwdError);
    expect(() => readFileSync(join(target, 'genie-s.yaml'), 'utf-8')).toThrow();
  });

  test.each([['a/b'], ['a\\b'], ['..'], ['../evil'], ['nested/../escape']])(
    'rejects slug %j containing a path fragment with UnsafeSlugError, creating nothing',
    (slug) => {
      const target = join(dir, 'should-stay-empty');
      expect(() => writeLaunchConfig({ slug, panes: [{ cwd: '/abs' }] }, { dir: target })).toThrow(UnsafeSlugError);
      // Guard fires before mkdirSync, so the target dir is never even created.
      expect(existsSync(target)).toBe(false);
    },
  );

  test('an unsafe slug is a WarpLaunchError (shared base for the emitter taxonomy)', () => {
    expect(() => writeLaunchConfig({ slug: '..', panes: [{ cwd: '/abs' }] }, { dir })).toThrow(WarpLaunchError);
  });
});

describe('launchUri', () => {
  test('prefixes the absolute path with warp://launch/', () => {
    expect(launchUri('/Users/me/.warp/launch_configurations/genie-x.yaml')).toBe(
      'warp://launch//Users/me/.warp/launch_configurations/genie-x.yaml',
    );
  });

  test('percent-encodes spaces while preserving path slashes', () => {
    expect(launchUri('/Users/me/My Repo/.warp/genie-x.yaml')).toBe(
      'warp://launch//Users/me/My%20Repo/.warp/genie-x.yaml',
    );
  });

  test('percent-encodes a "#" (which encodeURI would leave to truncate the path) per segment', () => {
    expect(launchUri('/Users/me/My#Repo/.warp/genie-x.yaml')).toBe(
      'warp://launch//Users/me/My%23Repo/.warp/genie-x.yaml',
    );
  });
});
