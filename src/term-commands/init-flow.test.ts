import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';

const mockConfirm = mock<(options: { message: string; default?: boolean }) => Promise<boolean>>(async () => false);
const mockIsSetupComplete = mock<() => boolean>(() => true);
const mockSetupCommand = mock(async () => {});

mock.module('@inquirer/prompts', () => ({
  confirm: (options: { message: string; default?: boolean }) => mockConfirm(options),
}));

mock.module('../lib/genie-config.js', () => ({
  isSetupComplete: () => mockIsSetupComplete(),
}));

mock.module('../genie-commands/setup.js', () => ({
  setupCommand: () => mockSetupCommand(),
}));

// Prevent workspace walk-up from detecting the host genie workspace
mock.module('../lib/workspace.js', () => ({
  findWorkspace: () => null,
  scanAgents: () => [],
}));

const { registerInitCommands } = await import('./init.js');

let originalCwd: string;
let testDir: string;

describe('genie init setup gating', () => {
  beforeEach(() => {
    originalCwd = process.cwd();
    testDir = join(tmpdir(), `genie-init-flow-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
    process.chdir(testDir);

    mockConfirm.mockReset();
    mockIsSetupComplete.mockReset();
    mockSetupCommand.mockReset();

    mockConfirm.mockResolvedValue(false);
    mockIsSetupComplete.mockReturnValue(true);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(testDir, { recursive: true, force: true });
  });

  test('runs setup flow before init when setup is incomplete', async () => {
    mockIsSetupComplete.mockReturnValue(false);

    const program = new Command();
    registerInitCommands(program);

    await program.parseAsync(['node', 'genie', 'init']);

    expect(mockSetupCommand).toHaveBeenCalledTimes(1);
    expect(existsSync(join(testDir, '.genie', 'workspace.json'))).toBe(true);
  });

  test('skips setup flow when setup is already complete', async () => {
    const program = new Command();
    registerInitCommands(program);

    await program.parseAsync(['node', 'genie', 'init']);

    expect(mockSetupCommand).not.toHaveBeenCalled();
    expect(existsSync(join(testDir, '.genie', 'workspace.json'))).toBe(true);
  });
});
