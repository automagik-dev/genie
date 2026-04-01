import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';

const mockConfirm = mock<(options: { message: string; default?: boolean }) => Promise<boolean>>(async () => true);
const mockIsSetupComplete = mock(() => true);

mock.module('@inquirer/prompts', () => ({
  confirm: (options: { message: string; default?: boolean }) => mockConfirm(options),
}));

mock.module('../lib/genie-config.js', () => ({
  isSetupComplete: () => mockIsSetupComplete(),
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
  mockConfirm.mockResolvedValue(true);
  mockIsSetupComplete.mockReturnValue(true);
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

  // SKIP: This test passes in isolation but fails in the full suite due to bun's
  // module caching. When init.js is imported by another test file first, the cached
  // module binds the real @inquirer/prompts and workspace.js — mock.module only
  // applies to future imports, not cached ones. Needs bun test isolation fix.
  test.skip('does not prompt when an agent already exists', async () => {
    const existingAgentDir = join(testDir, 'agents', 'atlas');
    mkdirSync(existingAgentDir, { recursive: true });
    writeFileSync(join(existingAgentDir, 'AGENTS.md'), '---\nname: atlas\n---\n');

    const program = new Command();
    registerInitCommands(program);

    await program.parseAsync(['node', 'genie', 'init']);

    expect(mockConfirm).not.toHaveBeenCalled();
  });
});
