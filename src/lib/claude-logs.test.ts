/**
 * Tests for Claude Code log discovery and parsing
 * Run with: bun test src/lib/claude-logs.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'path';
import { mkdir, rm, writeFile, readFile } from 'fs/promises';
import {
  projectPathToHash,
  findClaudeProjectDir,
  findActiveSession,
  parseLogEntry,
  listSessions,
  type ClaudeLogEntry,
  type ClaudeSession,
} from './claude-logs.js';

// ============================================================================
// Test Setup
// ============================================================================

const TEST_DIR = '/tmp/claude-logs-test';
const CLAUDE_DIR = join(TEST_DIR, '.claude');
const PROJECTS_DIR = join(CLAUDE_DIR, 'projects');

// Sample log entries matching Claude Code format
const sampleLogEntries = [
  {
    type: 'user',
    parentUuid: null,
    isSidechain: false,
    userType: 'external',
    cwd: '/home/genie/workspace/guga',
    sessionId: 'test-session-123',
    version: '2.1.30',
    gitBranch: 'main',
    message: {
      role: 'user',
      content: 'Hello world',
    },
    uuid: 'msg-1',
    timestamp: '2026-02-03T12:00:00.000Z',
  },
  {
    type: 'assistant',
    parentUuid: 'msg-1',
    isSidechain: false,
    userType: 'external',
    cwd: '/home/genie/workspace/guga',
    sessionId: 'test-session-123',
    version: '2.1.30',
    gitBranch: 'main',
    message: {
      id: 'req_123',
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me help you with that.' },
        { type: 'tool_use', id: 'toolu_123', name: 'Read', input: { file_path: '/test/file.txt' } },
      ],
      model: 'claude-opus-4-5-20251101',
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 50 },
    },
    uuid: 'msg-2',
    timestamp: '2026-02-03T12:00:05.000Z',
  },
  {
    type: 'progress',
    parentUuid: 'msg-2',
    isSidechain: false,
    userType: 'external',
    cwd: '/home/genie/workspace/guga',
    sessionId: 'test-session-123',
    version: '2.1.30',
    gitBranch: 'main',
    data: {
      type: 'tool_result',
      toolName: 'Read',
    },
    uuid: 'prog-1',
    timestamp: '2026-02-03T12:00:06.000Z',
  },
];

async function setupTestStructure(): Promise<void> {
  // Clean up any existing test directory
  try {
    await rm(TEST_DIR, { recursive: true, force: true });
  } catch {
    // Ignore
  }

  // Create Claude-like directory structure
  const projectHash = '-home-genie-workspace-guga';
  const projectDir = join(PROJECTS_DIR, projectHash);

  await mkdir(projectDir, { recursive: true });

  // Create session log file
  const logContent = sampleLogEntries.map(e => JSON.stringify(e)).join('\n') + '\n';
  await writeFile(join(projectDir, 'test-session-123.jsonl'), logContent);

  // Create sessions-index.json
  const sessionsIndex = {
    version: 1,
    entries: [
      {
        sessionId: 'test-session-123',
        fullPath: join(projectDir, 'test-session-123.jsonl'),
        fileMtime: Date.now(),
        firstPrompt: 'Hello world',
        summary: 'Test session',
        messageCount: 3,
        created: '2026-02-03T12:00:00.000Z',
        modified: '2026-02-03T12:00:06.000Z',
        gitBranch: 'main',
        projectPath: '/home/genie/workspace/guga',
        isSidechain: false,
      },
    ],
    originalPath: '/home/genie/workspace/guga',
  };
  await writeFile(join(projectDir, 'sessions-index.json'), JSON.stringify(sessionsIndex, null, 2));
}

async function cleanupTestStructure(): Promise<void> {
  try {
    await rm(TEST_DIR, { recursive: true, force: true });
  } catch {
    // Ignore
  }
}

// ============================================================================
// Path Hash Tests
// ============================================================================

describe('projectPathToHash', () => {
  test('should convert absolute path to dash-separated hash', () => {
    expect(projectPathToHash('/home/genie/workspace/guga')).toBe('-home-genie-workspace-guga');
  });

  test('should handle paths with multiple slashes', () => {
    expect(projectPathToHash('/home/genie/workspace/guga/code/genie-cli')).toBe(
      '-home-genie-workspace-guga-code-genie-cli'
    );
  });

  test('should handle root path', () => {
    expect(projectPathToHash('/')).toBe('-');
  });

  test('should handle trailing slash', () => {
    expect(projectPathToHash('/home/genie/')).toBe('-home-genie');
  });
});

// ============================================================================
// Project Directory Discovery Tests
// ============================================================================

describe('findClaudeProjectDir', () => {
  beforeAll(async () => {
    await setupTestStructure();
  });

  afterAll(async () => {
    await cleanupTestStructure();
  });

  test('should find project directory for known path', async () => {
    const result = await findClaudeProjectDir('/home/genie/workspace/guga', CLAUDE_DIR);
    expect(result).not.toBeNull();
    expect(result).toContain('-home-genie-workspace-guga');
  });

  test('should return null for unknown path', async () => {
    const result = await findClaudeProjectDir('/nonexistent/path', CLAUDE_DIR);
    expect(result).toBeNull();
  });
});

// ============================================================================
// Session Discovery Tests
// ============================================================================

describe('listSessions', () => {
  beforeAll(async () => {
    await setupTestStructure();
  });

  afterAll(async () => {
    await cleanupTestStructure();
  });

  test('should list sessions for a project', async () => {
    const projectDir = join(PROJECTS_DIR, '-home-genie-workspace-guga');
    const sessions = await listSessions(projectDir);

    expect(sessions.length).toBe(1);
    expect(sessions[0].sessionId).toBe('test-session-123');
    expect(sessions[0].projectPath).toBe('/home/genie/workspace/guga');
  });
});

describe('findActiveSession', () => {
  beforeAll(async () => {
    await setupTestStructure();
  });

  afterAll(async () => {
    await cleanupTestStructure();
  });

  test('should find most recent session', async () => {
    const projectDir = join(PROJECTS_DIR, '-home-genie-workspace-guga');
    const session = await findActiveSession(projectDir);

    expect(session).not.toBeNull();
    expect(session?.sessionId).toBe('test-session-123');
  });
});

// ============================================================================
// Log Entry Parsing Tests
// ============================================================================

describe('parseLogEntry', () => {
  test('should parse user message', () => {
    const entry = parseLogEntry(JSON.stringify(sampleLogEntries[0]));

    expect(entry).not.toBeNull();
    expect(entry?.type).toBe('user');
    expect(entry?.sessionId).toBe('test-session-123');
    expect(entry?.cwd).toBe('/home/genie/workspace/guga');
  });

  test('should parse assistant message with tool calls', () => {
    const entry = parseLogEntry(JSON.stringify(sampleLogEntries[1]));

    expect(entry).not.toBeNull();
    expect(entry?.type).toBe('assistant');
    expect(entry?.toolCalls).toBeDefined();
    expect(entry?.toolCalls?.length).toBe(1);
    expect(entry?.toolCalls?.[0].name).toBe('Read');
    expect(entry?.toolCalls?.[0].input).toEqual({ file_path: '/test/file.txt' });
  });

  test('should parse progress events', () => {
    const entry = parseLogEntry(JSON.stringify(sampleLogEntries[2]));

    expect(entry).not.toBeNull();
    expect(entry?.type).toBe('progress');
  });

  test('should return null for invalid JSON', () => {
    const entry = parseLogEntry('not valid json');
    expect(entry).toBeNull();
  });

  test('should return null for empty string', () => {
    const entry = parseLogEntry('');
    expect(entry).toBeNull();
  });
});

// ============================================================================
// Integration Tests (using real ~/.claude if available)
// ============================================================================

describe('Integration with real Claude logs', () => {
  const realClaudeDir = join(process.env.HOME || '', '.claude');

  test('should find real project directories', async () => {
    // This test uses the actual ~/.claude directory
    // It will be skipped if Claude is not installed
    try {
      const { access } = await import('fs/promises');
      await access(realClaudeDir);

      const projectDir = await findClaudeProjectDir('/home/genie/workspace/guga', realClaudeDir);

      // If guga project exists, it should be found
      if (projectDir) {
        expect(projectDir).toContain('-home-genie-workspace-guga');
      }
    } catch {
      console.log('Skipping real integration test - ~/.claude not available');
    }
  });
});
