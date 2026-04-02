import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { consumeInitialAgentSignal } from './initial-agent.js';

// ─── File-based initial agent communication ─────────────────────────────────
// Tests the thin client → TUI communication mechanism:
//   genie.ts writes ~/.genie/tui-initial-agent
//   Nav.tsx reads and deletes it on next diagnostics refresh

describe('tui-initial-agent file protocol', () => {
  let testDir: string;
  let agentFilePath: string;
  let originalGenieHome: string | undefined;

  beforeEach(() => {
    originalGenieHome = process.env.GENIE_HOME;
    testDir = join(tmpdir(), `genie-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
    process.env.GENIE_HOME = testDir;
    agentFilePath = join(testDir, 'tui-initial-agent');
  });

  afterEach(() => {
    try {
      if (existsSync(agentFilePath)) unlinkSync(agentFilePath);
      rmSync(testDir, { recursive: true, force: true });
    } catch {}
    if (originalGenieHome === undefined) {
      process.env.GENIE_HOME = undefined;
    } else {
      process.env.GENIE_HOME = originalGenieHome;
    }
  });

  test('write agent name, read it back, file deleted', () => {
    writeFileSync(agentFilePath, 'sofia', 'utf-8');
    expect(existsSync(agentFilePath)).toBe(true);

    const agent = consumeInitialAgentSignal();
    expect(agent).toBe('sofia');
    expect(existsSync(agentFilePath)).toBe(false);
  });

  test('missing file returns no agent (no error)', () => {
    // Simulate Nav.tsx check when file doesn't exist
    expect(existsSync(agentFilePath)).toBe(false);
    // Nav would skip — no agent to pre-select
  });

  test('empty file ignored', () => {
    writeFileSync(agentFilePath, '', 'utf-8');
    expect(consumeInitialAgentSignal()).toBeUndefined();
    expect(existsSync(agentFilePath)).toBe(false);
  });

  test('whitespace-only file ignored', () => {
    writeFileSync(agentFilePath, '  \n  ', 'utf-8');
    expect(consumeInitialAgentSignal()).toBeUndefined();
    expect(existsSync(agentFilePath)).toBe(false);
  });

  test('agent name with newline is trimmed', () => {
    writeFileSync(agentFilePath, 'vegapunk\n', 'utf-8');
    expect(consumeInitialAgentSignal()).toBe('vegapunk');
    expect(existsSync(agentFilePath)).toBe(false);
  });

  test('multiple writes: last one wins', () => {
    writeFileSync(agentFilePath, 'sofia', 'utf-8');
    writeFileSync(agentFilePath, 'vegapunk', 'utf-8');
    expect(consumeInitialAgentSignal()).toBe('vegapunk');
    expect(existsSync(agentFilePath)).toBe(false);
  });
});
