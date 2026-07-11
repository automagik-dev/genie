import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
const SCRIPT_PATH = join(ROOT, 'plugins', 'genie', 'scripts', 'smart-install.js');
const FIRST_RUN_PATH = join(ROOT, 'plugins', 'genie', 'scripts', 'first-run-check.cjs');
const MANIFEST_PATH = join(ROOT, 'plugins', 'genie', 'hooks', 'hooks.json');

interface CommandHook {
  command?: string;
  commandWindows?: string;
}

interface HookGroup {
  hooks?: CommandHook[];
}

let fixture: string;

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), 'genie-retired-smart-install-'));
});

afterEach(() => {
  rmSync(fixture, { recursive: true, force: true });
});

function run(args: string[] = [], scriptPath = SCRIPT_PATH) {
  const home = join(fixture, 'home');
  const genieHome = join(fixture, 'genie-home');
  const fakeBin = join(fixture, 'bin');
  const invoked = join(fixture, 'unexpected-genie-invocation');
  mkdirSync(home, { recursive: true });
  mkdirSync(genieHome, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  const fakeGenie = join(fakeBin, 'genie');
  writeFileSync(fakeGenie, `#!/bin/sh\nprintf invoked > "${invoked}"\n`, 'utf8');
  chmodSync(fakeGenie, 0o755);
  const result = Bun.spawnSync(['node', scriptPath, ...args], {
    env: {
      HOME: home,
      GENIE_HOME: genieHome,
      CLAUDE_PLUGIN_ROOT: join(fixture, 'plugin'),
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return { result, home, genieHome, invoked };
}

describe('retired SessionStart installer', () => {
  test('Claude SessionStart contains only the bounded diagnostic context hook', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as { hooks: { SessionStart: HookGroup[] } };
    const hooks = manifest.hooks.SessionStart.flatMap((group) => group.hooks ?? []);
    expect(hooks).toHaveLength(1);
    expect(hooks[0]?.command).toContain('/scripts/session-context.cjs');
    expect(hooks[0]?.commandWindows).toContain('\\scripts\\session-context.cjs');
    const commands = hooks.flatMap((hook) => [hook.command ?? '', hook.commandWindows ?? '']).join('\n');
    expect(commands).not.toMatch(/smart-install|first-run|\b(?:install|setup|update|sync)\b/i);
  });

  test('a stale cached invocation is silent and cannot execute or mutate anything', () => {
    for (const script of [SCRIPT_PATH, FIRST_RUN_PATH]) {
      const { result, home, genieHome, invoked } = run([], script);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toBe('');
      expect(result.stderr.toString()).toBe('');
      expect(existsSync(invoked)).toBe(false);
      expect(Array.from(new Bun.Glob('**/*').scanSync({ cwd: home, dot: true }))).toEqual([]);
      expect(Array.from(new Bun.Glob('**/*').scanSync({ cwd: genieHome, dot: true }))).toEqual([]);
    }
  });

  test('the compatibility diagnostic names only explicit operator paths', () => {
    const { result, invoked } = run(['--explain']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe('');
    expect(result.stderr.toString()).toContain('Automatic lifecycle installation is disabled');
    expect(result.stderr.toString()).toContain('`genie install`');
    expect(result.stderr.toString()).toContain('`genie setup`');
    expect(result.stderr.toString()).toContain('`genie update`');
    expect(existsSync(invoked)).toBe(false);

    const firstRun = run(['--explain'], FIRST_RUN_PATH);
    expect(firstRun.result.exitCode).toBe(0);
    expect(firstRun.result.stderr.toString()).toContain('`genie init` explicitly');
    expect(existsSync(firstRun.invoked)).toBe(false);
  });

  test('the shipped compatibility sources have no mutation or subprocess capability', () => {
    for (const script of [SCRIPT_PATH, FIRST_RUN_PATH]) {
      const source = readFileSync(script, 'utf8');
      expect(source).not.toMatch(/node:(?:child_process|fs)|require\(['"](?:child_process|fs)['"]\)/);
      expect(source).not.toMatch(/\b(?:spawn|exec|writeFile|mkdir|rename|copyFile|unlink|council-stamp)\b/);
      expect(source).not.toContain('update --sync-only');
    }
  });
});
