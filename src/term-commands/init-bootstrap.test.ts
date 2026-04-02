import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';

const mockConfirm = mock<(options: { message: string; default?: boolean }) => Promise<boolean>>(async () => true);
const mockIsSetupComplete = mock(() => true);
const mockScanAgents = mock<(root: string) => string[]>(() => []);

mock.module('@inquirer/prompts', () => ({
  confirm: (options: { message: string; default?: boolean }) => mockConfirm(options),
}));

mock.module('../lib/genie-config.js', () => ({
  isSetupComplete: () => mockIsSetupComplete(),
  loadGenieConfigSync: () => ({ promptMode: 'append' }),
}));

// Stub findWorkspace to prevent it from discovering the host machine's workspace
// via its global fallback. scanAgents is also mocked so tests can control whether
// agents "exist" without relying on the real filesystem.
mock.module('../lib/workspace.js', () => ({
  findWorkspace: () => null,
  scanAgents: (root: string) => mockScanAgents(root),
  getWorkspaceConfig: () => ({ agents: [] }),
}));

const { registerInitCommands } = await import('./init.js');

let originalCwd: string;
let testDir: string;
let cwdSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  originalCwd = process.cwd();
  testDir = join(tmpdir(), `genie-init-bootstrap-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  process.chdir(testDir);

  // Pin process.cwd() to testDir to prevent race conditions with parallel
  // test files that also call process.chdir() in the same bun process.
  cwdSpy = spyOn(process, 'cwd').mockReturnValue(testDir);

  mockConfirm.mockReset();
  mockIsSetupComplete.mockReset();
  mockScanAgents.mockReset();
  mockConfirm.mockResolvedValue(true);
  mockIsSetupComplete.mockReturnValue(true);
  mockScanAgents.mockReturnValue([]);
});

afterEach(() => {
  cwdSpy.mockRestore();
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
    mockScanAgents.mockReturnValue(['atlas']);

    const program = new Command();
    registerInitCommands(program);

    await program.parseAsync(['node', 'genie', 'init']);

    expect(mockConfirm).not.toHaveBeenCalled();
  });
});
