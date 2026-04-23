import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
// Import the real workspace + genie-config modules so we can spyOn individual
// exports. Using spyOn instead of mock.module avoids leaking an incomplete
// mock to other test files (bun 1.3.x leaks mock.module across parallel
// workers — see https://github.com/oven-sh/bun/issues bun-test-mock-leak).
import * as genieConfig from '../lib/genie-config.js';
import * as workspace from '../lib/workspace.js';

const mockConfirm = mock<(options: { message: string; default?: boolean }) => Promise<boolean>>(async () => false);
const mockSetupCommand = mock(async () => {});

mock.module('@inquirer/prompts', () => ({
  confirm: (options: { message: string; default?: boolean }) => mockConfirm(options),
}));

mock.module('../genie-commands/setup.js', () => ({
  setupCommand: () => mockSetupCommand(),
}));

const { registerInitCommands } = await import('./init.js');

let originalCwd: string;
let testDir: string;
let findWorkspaceSpy: ReturnType<typeof spyOn>;
let scanAgentsSpy: ReturnType<typeof spyOn>;
let isSetupCompleteSpy: ReturnType<typeof spyOn>;

describe('genie init setup gating', () => {
  beforeEach(() => {
    originalCwd = process.cwd();
    testDir = join(tmpdir(), `genie-init-flow-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
    process.chdir(testDir);

    // Spy on workspace functions to prevent host workspace detection
    findWorkspaceSpy = spyOn(workspace, 'findWorkspace').mockReturnValue(null);
    scanAgentsSpy = spyOn(workspace, 'scanAgents').mockReturnValue([]);

    // Spy on genie-config.isSetupComplete (avoids mock.module cross-file leak)
    isSetupCompleteSpy = spyOn(genieConfig, 'isSetupComplete').mockReturnValue(true);

    mockConfirm.mockReset();
    mockSetupCommand.mockReset();

    mockConfirm.mockResolvedValue(false);
  });

  afterEach(() => {
    findWorkspaceSpy.mockRestore();
    scanAgentsSpy.mockRestore();
    isSetupCompleteSpy.mockRestore();
    process.chdir(originalCwd);
    rmSync(testDir, { recursive: true, force: true });
  });

  test('runs setup flow before init when setup is incomplete', async () => {
    isSetupCompleteSpy.mockReturnValue(false);

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
