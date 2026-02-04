/**
 * Tests for term events command
 *
 * Run with: bun test src/term-commands/events.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'path';
import { mkdir, rm, writeFile } from 'fs/promises';
import {
  parseLogEntryToEvent,
  type NormalizedEvent,
} from './events.js';

// ============================================================================
// Test Setup
// ============================================================================

const TEST_DIR = '/tmp/events-test';
const CLAUDE_DIR = join(TEST_DIR, '.claude');
const PROJECTS_DIR = join(CLAUDE_DIR, 'projects');

// Sample log entries matching Claude Code format
const sampleLogEntries = {
  user: {
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
  assistant: {
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
  progress: {
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
};

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
  const logContent = Object.values(sampleLogEntries).map(e => JSON.stringify(e)).join('\n') + '\n';
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
// Event Parsing Tests
// ============================================================================

describe('parseLogEntryToEvent', () => {
  beforeAll(async () => {
    await setupTestStructure();
  });

  afterAll(async () => {
    await cleanupTestStructure();
  });

  test('should parse user message as session_start event', () => {
    const entry = {
      type: 'user',
      sessionId: 'test-session-123',
      uuid: 'msg-1',
      parentUuid: null,
      timestamp: '2026-02-03T12:00:00.000Z',
      cwd: '/home/genie/workspace/guga',
      raw: sampleLogEntries.user,
    };

    const event = parseLogEntryToEvent(entry);

    expect(event).not.toBeNull();
    expect(event?.type).toBe('session_start');
    expect(event?.sessionId).toBe('test-session-123');
    expect(event?.timestamp).toBe('2026-02-03T12:00:00.000Z');
    expect(event?.cwd).toBe('/home/genie/workspace/guga');
  });

  test('should parse assistant tool_use as tool_call event', () => {
    const entry = {
      type: 'assistant',
      sessionId: 'test-session-123',
      uuid: 'msg-2',
      parentUuid: 'msg-1',
      timestamp: '2026-02-03T12:00:05.000Z',
      cwd: '/home/genie/workspace/guga',
      toolCalls: [
        { id: 'toolu_123', name: 'Read', input: { file_path: '/test/file.txt' } },
      ],
      raw: sampleLogEntries.assistant,
    };

    const event = parseLogEntryToEvent(entry);

    expect(event).not.toBeNull();
    expect(event?.type).toBe('tool_call');
    expect(event?.toolName).toBe('Read');
    expect(event?.toolInput).toEqual({ file_path: '/test/file.txt' });
  });

  test('should detect permission_request from tool name patterns', () => {
    const entry = {
      type: 'assistant',
      sessionId: 'test-session-123',
      uuid: 'msg-3',
      parentUuid: 'msg-2',
      timestamp: '2026-02-03T12:00:07.000Z',
      cwd: '/home/genie/workspace/guga',
      toolCalls: [
        { id: 'toolu_456', name: 'Bash', input: { command: 'rm -rf /' } },
      ],
      raw: {},
    };

    const event = parseLogEntryToEvent(entry);

    // Bash commands may require permission
    expect(event).not.toBeNull();
    expect(event?.type).toBe('tool_call');
    expect(event?.toolName).toBe('Bash');
  });

  test('should return null for entries with no relevant events', () => {
    const entry = {
      type: 'file-history-snapshot',
      sessionId: 'test-session-123',
      uuid: 'snap-1',
      parentUuid: null,
      timestamp: '2026-02-03T12:00:00.000Z',
      cwd: '/home/genie/workspace/guga',
      raw: {},
    };

    const event = parseLogEntryToEvent(entry);
    expect(event).toBeNull();
  });
});

// ============================================================================
// Event Enrichment Tests
// ============================================================================

describe('Event enrichment with wish-id', () => {
  test('should add wish-id when worker context is provided', () => {
    const entry = {
      type: 'user',
      sessionId: 'test-session-123',
      uuid: 'msg-1',
      parentUuid: null,
      timestamp: '2026-02-03T12:00:00.000Z',
      cwd: '/home/genie/workspace/guga',
      raw: sampleLogEntries.user,
    };

    const workerContext = {
      paneId: '%42',
      wishSlug: 'wish-21',
      taskId: 'bd-123',
    };

    const event = parseLogEntryToEvent(entry, workerContext);

    expect(event).not.toBeNull();
    expect(event?.paneId).toBe('%42');
    expect(event?.wishId).toBe('wish-21');
    expect(event?.taskId).toBe('bd-123');
  });
});
