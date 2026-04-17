import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
// Import the real workspace + genie-config modules so we can spyOn individual
// exports. Using spyOn instead of mock.module avoids leaking an incomplete
// mock to other test files (bun 1.3.x leaks mock.module across parallel
// workers — see https://github.com/oven-sh/bun/issues bun-test-mock-leak).
import * as genieConfig from '../lib/genie-config.js';
import * as workspace from '../lib/workspace.js';

const mockConfirm = mock<(options: { message: string; default?: boolean }) => Promise<boolean>>(async () => true);

mock.module('@inquirer/prompts', () => ({
  confirm: (options: { message: string; default?: boolean }) => mockConfirm(options),
}));

const { registerInitCommands } = await import('./init.js');

let originalCwd: string;
let testDir: string;
let cwdSpy: ReturnType<typeof spyOn>;
let findWorkspaceSpy: ReturnType<typeof spyOn>;
let scanAgentsSpy: ReturnType<typeof spyOn>;
let isSetupCompleteSpy: ReturnType<typeof spyOn>;
let loadGenieConfigSyncSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  originalCwd = process.cwd();
  testDir = join(tmpdir(), `genie-init-bootstrap-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  process.chdir(testDir);

  // Pin process.cwd() to testDir to prevent race conditions with parallel
  // test files that also call process.chdir() in the same bun process.
  cwdSpy = spyOn(process, 'cwd').mockReturnValue(testDir);

  // Spy on workspace functions — prevents findWorkspace from discovering the
  // host machine's workspace, and lets tests control scanAgents results.
  findWorkspaceSpy = spyOn(workspace, 'findWorkspace').mockReturnValue(null);
  scanAgentsSpy = spyOn(workspace, 'scanAgents').mockReturnValue([]);

  // Spy on genie-config exports (avoids mock.module cross-file leak).
  isSetupCompleteSpy = spyOn(genieConfig, 'isSetupComplete').mockReturnValue(true);
  loadGenieConfigSyncSpy = spyOn(genieConfig, 'loadGenieConfigSync').mockReturnValue({
    promptMode: 'append',
  } as ReturnType<typeof genieConfig.loadGenieConfigSync>);

  mockConfirm.mockReset();
  mockConfirm.mockResolvedValue(true);
});

afterEach(() => {
  findWorkspaceSpy.mockRestore();
  scanAgentsSpy.mockRestore();
  cwdSpy.mockRestore();
  isSetupCompleteSpy.mockRestore();
  loadGenieConfigSyncSpy.mockRestore();
  process.chdir(originalCwd);
  rmSync(testDir, { recursive: true, force: true });
});

describe('genie init default agent bootstrap', () => {
  test('scaffolds the default genie agent when the user confirms', async () => {
    const program = new Command();
    registerInitCommands(program);

    await program.parseAsync(['node', 'genie', 'init']);

    const agentRoot = join(testDir, 'agents', 'genie');
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(existsSync(join(testDir, '.genie', 'workspace.json'))).toBe(true);
    expect(existsSync(join(agentRoot, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(agentRoot, 'SOUL.md'))).toBe(true);
    expect(existsSync(join(agentRoot, 'HEARTBEAT.md'))).toBe(true);
    expect(existsSync(join(agentRoot, '.claude', 'settings.local.json'))).toBe(true);

    const settings = readFileSync(join(agentRoot, '.claude', 'settings.local.json'), 'utf-8');
    expect(settings).toContain('"agentName": "genie"');
  });

  test('does not scaffold the default agent when the user declines', async () => {
    mockConfirm.mockResolvedValue(false);

    const program = new Command();
    registerInitCommands(program);

    await program.parseAsync(['node', 'genie', 'init']);

    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(existsSync(join(testDir, '.genie', 'workspace.json'))).toBe(true);
    expect(existsSync(join(testDir, 'agents', 'genie', 'AGENTS.md'))).toBe(false);
  });

  test('does not prompt when an agent already exists', async () => {
    scanAgentsSpy.mockReturnValue(['atlas']);

    const program = new Command();
    registerInitCommands(program);

    await program.parseAsync(['node', 'genie', 'init']);

    expect(mockConfirm).not.toHaveBeenCalled();
  });
});
