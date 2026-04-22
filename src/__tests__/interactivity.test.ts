import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import * as workspace from '../lib/workspace.js';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockConfirm = mock<(options: { message: string; default?: boolean }) => Promise<boolean>>(async () => true);

mock.module('@inquirer/prompts', () => ({
  confirm: (options: { message: string; default?: boolean }) => mockConfirm(options),
}));

const { isInteractive, ensureWorkspace, commandRequiresWorkspace, installWorkspaceCheck } = await import(
  '../lib/interactivity.js'
);

// ─── Helpers ─────────────────────────────────────────────────────────────────

let testDir: string;
let originalArgv: string[];
let originalCI: string | undefined;
let findWorkspaceSpy: ReturnType<typeof spyOn>;
let ttyDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  testDir = join(tmpdir(), `genie-interactivity-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });

  originalArgv = process.argv;
  originalCI = process.env.CI;
  ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

  findWorkspaceSpy = spyOn(workspace, 'findWorkspace').mockReturnValue(null);
  mockConfirm.mockReset();
  mockConfirm.mockResolvedValue(true);
});

afterEach(() => {
  findWorkspaceSpy.mockRestore();
  process.argv = originalArgv;
  if (originalCI === undefined) {
    // biome-ignore lint/performance/noDelete: process.env requires delete — assignment sets the string "undefined"
    delete process.env.CI;
  } else {
    process.env.CI = originalCI;
  }
  if (ttyDescriptor) {
    Object.defineProperty(process.stdout, 'isTTY', ttyDescriptor);
  } else {
    Object.defineProperty(process.stdout, 'isTTY', { value: undefined, writable: true, configurable: true });
  }
  rmSync(testDir, { recursive: true, force: true });
});

// ─── isInteractive() ────────────────────────────────────────────────────────

describe('isInteractive()', () => {
  test('returns true when stdout is a TTY, CI is not set, and --no-interactive is absent', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    // biome-ignore lint/performance/noDelete: process.env requires delete — assignment sets the string "undefined"
    delete process.env.CI;
    process.argv = ['node', 'genie', 'serve'];

    expect(isInteractive()).toBe(true);
  });

  test('returns false when stdout is not a TTY', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    // biome-ignore lint/performance/noDelete: process.env requires delete — assignment sets the string "undefined"
    delete process.env.CI;
    process.argv = ['node', 'genie', 'serve'];

    expect(isInteractive()).toBe(false);
  });

  test('returns false when stdout.isTTY is undefined (pipe)', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
    // biome-ignore lint/performance/noDelete: process.env requires delete — assignment sets the string "undefined"
    delete process.env.CI;
    process.argv = ['node', 'genie', 'serve'];

    expect(isInteractive()).toBe(false);
  });

  test('returns false when CI=true', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    process.env.CI = 'true';
    process.argv = ['node', 'genie', 'serve'];

    expect(isInteractive()).toBe(false);
  });

  test('returns false when CI=1', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    process.env.CI = '1';
    process.argv = ['node', 'genie', 'serve'];

    expect(isInteractive()).toBe(false);
  });

  test('returns false when --no-interactive is present', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    // biome-ignore lint/performance/noDelete: process.env requires delete — assignment sets the string "undefined"
    delete process.env.CI;
    process.argv = ['node', 'genie', 'serve', '--no-interactive'];

    expect(isInteractive()).toBe(false);
  });

  test('returns false when both CI and --no-interactive are set', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    process.env.CI = 'true';
    process.argv = ['node', 'genie', 'serve', '--no-interactive'];

    expect(isInteractive()).toBe(false);
  });
});

// ─── commandRequiresWorkspace() ──────────────────────────────────────────────

describe('commandRequiresWorkspace()', () => {
  test('returns false for init command', () => {
    const program = new Command();
    const init = program.command('init');
    expect(commandRequiresWorkspace(init)).toBe(false);
  });

  test('returns false for setup command', () => {
    const program = new Command();
    const setup = program.command('setup');
    expect(commandRequiresWorkspace(setup)).toBe(false);
  });

  test('returns false for doctor command', () => {
    const program = new Command();
    const doctor = program.command('doctor');
    expect(commandRequiresWorkspace(doctor)).toBe(false);
  });

  test('returns false for update command', () => {
    const program = new Command();
    const update = program.command('update');
    expect(commandRequiresWorkspace(update)).toBe(false);
  });

  test('returns false for uninstall command', () => {
    const program = new Command();
    const uninstall = program.command('uninstall');
    expect(commandRequiresWorkspace(uninstall)).toBe(false);
  });

  test('returns false for shortcuts command', () => {
    const program = new Command();
    const shortcuts = program.command('shortcuts');
    expect(commandRequiresWorkspace(shortcuts)).toBe(false);
  });

  test('returns false for init agent subcommand', () => {
    const program = new Command();
    const init = program.command('init');
    const agent = init.command('agent');
    expect(commandRequiresWorkspace(agent)).toBe(false);
  });

  test('returns true for serve command', () => {
    const program = new Command();
    const serve = program.command('serve');
    expect(commandRequiresWorkspace(serve)).toBe(true);
  });

  test('returns true for spawn command', () => {
    const program = new Command();
    const spawn = program.command('spawn');
    expect(commandRequiresWorkspace(spawn)).toBe(true);
  });

  test('returns true for ls command', () => {
    const program = new Command();
    const ls = program.command('ls');
    expect(commandRequiresWorkspace(ls)).toBe(true);
  });

  test('returns false for team create subcommand (team is workspace-exempt)', () => {
    const program = new Command();
    const team = program.command('team');
    const create = team.command('create');
    expect(commandRequiresWorkspace(create)).toBe(false);
  });

  test('#1295 — returns false for hook namespace (root command)', () => {
    // Regression guard: CC calls `genie hook dispatch` on every PreToolUse /
    // Stop / UserPromptSubmit event, from any cwd the editor happens to be
    // in. A non-zero exit here blocks every tool call on the host.
    const program = new Command();
    const hook = program.command('hook');
    expect(commandRequiresWorkspace(hook)).toBe(false);
  });

  test('#1295 — returns false for hook dispatch subcommand', () => {
    // The actual invocation shape Claude Code uses — `hook dispatch` must
    // bypass the workspace guard so a missing `.genie/` never bubbles up as
    // exit 2.
    const program = new Command();
    const hook = program.command('hook');
    const dispatch = hook.command('dispatch');
    expect(commandRequiresWorkspace(dispatch)).toBe(false);
  });
});

// ─── ensureWorkspace() ──────────────────────────────────────────────────────

describe('ensureWorkspace()', () => {
  test('returns immediately when workspace exists', async () => {
    findWorkspaceSpy.mockReturnValue({ root: testDir });

    await ensureWorkspace();

    expect(mockConfirm).not.toHaveBeenCalled();
  });

  test('creates workspace when user confirms in interactive mode', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    // biome-ignore lint/performance/noDelete: process.env requires delete — assignment sets the string "undefined"
    delete process.env.CI;
    process.argv = ['node', 'genie', 'serve'];

    const cwdSpy = spyOn(process, 'cwd').mockReturnValue(testDir);
    mockConfirm.mockResolvedValue(true);

    await ensureWorkspace();

    expect(mockConfirm).toHaveBeenCalledTimes(1);
    const wsPath = join(testDir, '.genie', 'workspace.json');
    const { existsSync, readFileSync } = await import('node:fs');
    expect(existsSync(wsPath)).toBe(true);

    const config = JSON.parse(readFileSync(wsPath, 'utf-8'));
    expect(config.name).toBeDefined();
    expect(config.agents).toEqual({ defaults: {} });

    cwdSpy.mockRestore();
  });

  test('exits with code 2 when non-interactive (CI=true)', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    process.env.CI = 'true';
    process.argv = ['node', 'genie', 'serve'];

    const exitSpy = spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });

    try {
      await ensureWorkspace();
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as Error).message).toBe('process.exit');
    }

    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(mockConfirm).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  test('exits with code 2 when non-interactive (--no-interactive flag)', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    // biome-ignore lint/performance/noDelete: process.env requires delete — assignment sets the string "undefined"
    delete process.env.CI;
    process.argv = ['node', 'genie', 'serve', '--no-interactive'];

    const exitSpy = spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });

    try {
      await ensureWorkspace();
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as Error).message).toBe('process.exit');
    }

    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(mockConfirm).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  test('exits with code 2 when non-interactive (not a TTY)', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    // biome-ignore lint/performance/noDelete: process.env requires delete — assignment sets the string "undefined"
    delete process.env.CI;
    process.argv = ['node', 'genie', 'serve'];

    const exitSpy = spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });

    try {
      await ensureWorkspace();
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as Error).message).toBe('process.exit');
    }

    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(mockConfirm).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  test('exits with code 2 when user declines init prompt', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    // biome-ignore lint/performance/noDelete: process.env requires delete — assignment sets the string "undefined"
    delete process.env.CI;
    process.argv = ['node', 'genie', 'serve'];
    mockConfirm.mockResolvedValue(false);

    const exitSpy = spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });

    try {
      await ensureWorkspace();
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as Error).message).toBe('process.exit');
    }

    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    exitSpy.mockRestore();
  });
});

// ─── installWorkspaceCheck() integration ────────────────────────────────────

describe('installWorkspaceCheck()', () => {
  test('skips workspace check for init command', async () => {
    findWorkspaceSpy.mockReturnValue(null);
    const actionFn = mock(async () => {});

    const program = new Command();
    program.command('init').action(actionFn);
    installWorkspaceCheck(program);

    await program.parseAsync(['node', 'genie', 'init']);

    expect(actionFn).toHaveBeenCalledTimes(1);
    // No prompt because init is exempt
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  test('runs workspace check for serve command when workspace exists', async () => {
    findWorkspaceSpy.mockReturnValue({ root: testDir });
    const actionFn = mock(async () => {});

    const program = new Command();
    program.command('serve').action(actionFn);
    installWorkspaceCheck(program);

    await program.parseAsync(['node', 'genie', 'serve']);

    expect(actionFn).toHaveBeenCalledTimes(1);
    // No prompt because workspace exists
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  test('#1295 — hook dispatch runs to completion even when no workspace exists', async () => {
    // Fleet-breaking regression in 4.260421.30: `genie hook dispatch` exited
    // with code 2 whenever cwd lacked `.genie/`, because the pre-fix
    // WORKSPACE_EXEMPT set didn't include `hook` and stdin was piped
    // (non-interactive → exit 2 path). CC treated the non-zero as a blocking
    // deny and every Bash/Read/Edit/etc. tool call died on the host.
    //
    // This test drives the real preAction hook with a null workspace and
    // asserts the hook action runs without triggering the init prompt and
    // without calling process.exit. If someone removes `'hook'` from the
    // exempt set, this test fails the same way the live fleet did.
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    // biome-ignore lint/performance/noDelete: process.env requires delete
    delete process.env.CI;
    process.argv = ['node', 'genie', 'hook', 'dispatch'];
    findWorkspaceSpy.mockReturnValue(null);

    const actionFn = mock(async () => {});
    const exitSpy = spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit should not be called for hook dispatch');
    });

    try {
      const program = new Command();
      const hook = program.command('hook');
      hook.command('dispatch').action(actionFn);
      installWorkspaceCheck(program);

      await program.parseAsync(['node', 'genie', 'hook', 'dispatch']);

      expect(actionFn).toHaveBeenCalledTimes(1);
      expect(mockConfirm).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });
});
