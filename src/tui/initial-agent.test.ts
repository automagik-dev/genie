import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ─── File-based initial agent communication ─────────────────────────────────
// Tests the thin client → TUI communication mechanism:
//   genie.ts writes ~/.genie/tui-initial-agent
//   Nav.tsx reads and deletes it on next diagnostics refresh

describe('tui-initial-agent file protocol', () => {
  let testDir: string;
  let agentFilePath: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `genie-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
    agentFilePath = join(testDir, 'tui-initial-agent');
  });

  afterEach(() => {
    try {
      if (existsSync(agentFilePath)) unlinkSync(agentFilePath);
      rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  test('write agent name, read it back, file deleted', () => {
    // Simulate genie.ts thin client writing the file
    writeFileSync(agentFilePath, 'sofia', 'utf-8');
    expect(existsSync(agentFilePath)).toBe(true);

    // Simulate Nav.tsx reading the file
    const agent = readFileSync(agentFilePath, 'utf-8').trim();
    expect(agent).toBe('sofia');

    // Simulate Nav.tsx deleting after read
    unlinkSync(agentFilePath);
    expect(existsSync(agentFilePath)).toBe(false);
  });

  test('missing file returns no agent (no error)', () => {
    // Simulate Nav.tsx check when file doesn't exist
    expect(existsSync(agentFilePath)).toBe(false);
    // Nav would skip — no agent to pre-select
  });

  test('empty file ignored', () => {
    writeFileSync(agentFilePath, '', 'utf-8');
    const agent = readFileSync(agentFilePath, 'utf-8').trim();
    expect(agent).toBe('');
    // Nav checks `if (agent)` — empty string is falsy, skipped
    unlinkSync(agentFilePath);
  });

  test('whitespace-only file ignored', () => {
    writeFileSync(agentFilePath, '  \n  ', 'utf-8');
    const agent = readFileSync(agentFilePath, 'utf-8').trim();
    expect(agent).toBe('');
    unlinkSync(agentFilePath);
  });

  test('agent name with newline is trimmed', () => {
    writeFileSync(agentFilePath, 'vegapunk\n', 'utf-8');
    const agent = readFileSync(agentFilePath, 'utf-8').trim();
    expect(agent).toBe('vegapunk');
    unlinkSync(agentFilePath);
  });

  test('multiple writes: last one wins', () => {
    writeFileSync(agentFilePath, 'sofia', 'utf-8');
    writeFileSync(agentFilePath, 'vegapunk', 'utf-8');
    const agent = readFileSync(agentFilePath, 'utf-8').trim();
    expect(agent).toBe('vegapunk');
    unlinkSync(agentFilePath);
  });
});
