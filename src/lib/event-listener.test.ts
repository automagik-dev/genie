/**
 * Tests for Event Listener - Permission Request Subscription
 * Run with: bun test src/lib/event-listener.test.ts
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { join } from 'path';
import { mkdir, rm, writeFile, appendFile } from 'fs/promises';
import {
  type PermissionRequest,
  type EventSubscription,
  extractPermissionRequest,
  createPermissionRequestQueue,
  subscribeToPermissionRequests,
  getBashCommand,
  isBashRequest,
} from './event-listener.js';
import type { NormalizedEvent } from '../term-commands/events.js';

// ============================================================================
// Test Setup
// ============================================================================

const TEST_DIR = '/tmp/event-listener-test';
const TEST_EVENTS_DIR = join(TEST_DIR, '.genie', 'events');

async function setupTestDir(): Promise<void> {
  await cleanupTestDir();
  await mkdir(TEST_EVENTS_DIR, { recursive: true });
}

async function cleanupTestDir(): Promise<void> {
  try {
    await rm(TEST_DIR, { recursive: true, force: true });
  } catch {
    // Ignore
  }
}

// ============================================================================
// Permission Request Extraction Tests
// ============================================================================

describe('extractPermissionRequest', () => {
  test('should extract permission request from tool_call event', () => {
    const event: NormalizedEvent = {
      type: 'tool_call',
      timestamp: '2026-02-03T12:00:00.000Z',
      sessionId: 'session-123',
      cwd: '/home/genie/workspace/guga',
      paneId: '%42',
      wishId: 'wish-23',
      toolName: 'Write',
      toolInput: { file_path: '/test/file.txt', content: 'test content' },
      toolCallId: 'toolu_123',
    };

    const request = extractPermissionRequest(event);

    expect(request).not.toBeNull();
    expect(request?.toolName).toBe('Write');
    expect(request?.toolInput).toEqual({ file_path: '/test/file.txt', content: 'test content' });
    expect(request?.paneId).toBe('%42');
    expect(request?.wishId).toBe('wish-23');
    expect(request?.sessionId).toBe('session-123');
    expect(request?.cwd).toBe('/home/genie/workspace/guga');
  });

  test('should extract permission request from permission_request event', () => {
    const event: NormalizedEvent = {
      type: 'permission_request',
      timestamp: '2026-02-03T12:00:00.000Z',
      sessionId: 'session-456',
      cwd: '/home/genie/workspace/guga',
      paneId: '%99',
      wishId: 'wish-21',
      toolName: 'Bash',
    };

    const request = extractPermissionRequest(event);

    expect(request).not.toBeNull();
    expect(request?.toolName).toBe('Bash');
    expect(request?.paneId).toBe('%99');
    expect(request?.wishId).toBe('wish-21');
  });

  test('should return null for session_start events', () => {
    const event: NormalizedEvent = {
      type: 'session_start',
      timestamp: '2026-02-03T12:00:00.000Z',
      sessionId: 'session-123',
      cwd: '/home/genie/workspace/guga',
    };

    const request = extractPermissionRequest(event);
    expect(request).toBeNull();
  });

  test('should return null for session_end events', () => {
    const event: NormalizedEvent = {
      type: 'session_end',
      timestamp: '2026-02-03T12:00:00.000Z',
      sessionId: 'session-123',
      cwd: '/home/genie/workspace/guga',
      exitReason: 'completed',
    };

    const request = extractPermissionRequest(event);
    expect(request).toBeNull();
  });

  test('should include timestamp in extracted request', () => {
    const event: NormalizedEvent = {
      type: 'tool_call',
      timestamp: '2026-02-03T14:30:00.000Z',
      sessionId: 'session-123',
      cwd: '/home/genie/workspace/guga',
      paneId: '%42',
      toolName: 'Read',
      toolInput: { file_path: '/test/file.txt' },
    };

    const request = extractPermissionRequest(event);
    expect(request?.timestamp).toBe('2026-02-03T14:30:00.000Z');
  });
});

// ============================================================================
// Bash Command Helper Tests
// ============================================================================

describe('getBashCommand', () => {
  test('should extract command from Bash request', () => {
    const request: PermissionRequest = {
      id: 'req-1',
      toolName: 'Bash',
      toolInput: { command: 'bun test' },
      paneId: '%42',
      sessionId: 'session-123',
      cwd: '/home/genie/workspace/guga',
      timestamp: '2026-02-03T12:00:00.000Z',
    };

    expect(getBashCommand(request)).toBe('bun test');
  });

  test('should return null for non-Bash tools', () => {
    const request: PermissionRequest = {
      id: 'req-1',
      toolName: 'Write',
      toolInput: { file_path: '/test/file.txt', content: 'test' },
      paneId: '%42',
      sessionId: 'session-123',
      cwd: '/home/genie/workspace/guga',
      timestamp: '2026-02-03T12:00:00.000Z',
    };

    expect(getBashCommand(request)).toBeNull();
  });

  test('should return null if no toolInput', () => {
    const request: PermissionRequest = {
      id: 'req-1',
      toolName: 'Bash',
      paneId: '%42',
      sessionId: 'session-123',
      cwd: '/home/genie/workspace/guga',
      timestamp: '2026-02-03T12:00:00.000Z',
    };

    expect(getBashCommand(request)).toBeNull();
  });

  test('should return null if command is not a string', () => {
    const request: PermissionRequest = {
      id: 'req-1',
      toolName: 'Bash',
      toolInput: { command: 123 },
      paneId: '%42',
      sessionId: 'session-123',
      cwd: '/home/genie/workspace/guga',
      timestamp: '2026-02-03T12:00:00.000Z',
    };

    expect(getBashCommand(request)).toBeNull();
  });
});

describe('isBashRequest', () => {
  test('should return true for Bash requests', () => {
    const request: PermissionRequest = {
      id: 'req-1',
      toolName: 'Bash',
      paneId: '%42',
      sessionId: 'session-123',
      cwd: '/home/genie/workspace/guga',
      timestamp: '2026-02-03T12:00:00.000Z',
    };

    expect(isBashRequest(request)).toBe(true);
  });

  test('should return false for non-Bash requests', () => {
    const request: PermissionRequest = {
      id: 'req-1',
      toolName: 'Write',
      paneId: '%42',
      sessionId: 'session-123',
      cwd: '/home/genie/workspace/guga',
      timestamp: '2026-02-03T12:00:00.000Z',
    };

    expect(isBashRequest(request)).toBe(false);
  });
});

// ============================================================================
// Permission Request Queue Tests
// ============================================================================

describe('createPermissionRequestQueue', () => {
  test('should create an empty queue', () => {
    const queue = createPermissionRequestQueue();
    expect(queue.size()).toBe(0);
    expect(queue.getAll()).toEqual([]);
  });

  test('should add requests to queue', () => {
    const queue = createPermissionRequestQueue();
    const request: PermissionRequest = {
      id: 'req-1',
      toolName: 'Write',
      toolInput: { file_path: '/test/file.txt' },
      paneId: '%42',
      sessionId: 'session-123',
      cwd: '/home/genie/workspace/guga',
      timestamp: '2026-02-03T12:00:00.000Z',
    };

    queue.add(request);

    expect(queue.size()).toBe(1);
    expect(queue.getAll()[0]).toEqual(request);
  });

  test('should retrieve next request from queue (FIFO)', () => {
    const queue = createPermissionRequestQueue();

    const request1: PermissionRequest = {
      id: 'req-1',
      toolName: 'Write',
      paneId: '%42',
      sessionId: 'session-123',
      cwd: '/home/genie/workspace/guga',
      timestamp: '2026-02-03T12:00:00.000Z',
    };

    const request2: PermissionRequest = {
      id: 'req-2',
      toolName: 'Bash',
      paneId: '%42',
      sessionId: 'session-123',
      cwd: '/home/genie/workspace/guga',
      timestamp: '2026-02-03T12:00:01.000Z',
    };

    queue.add(request1);
    queue.add(request2);

    const next = queue.next();
    expect(next?.id).toBe('req-1');
    expect(queue.size()).toBe(1);
  });

  test('should return null when queue is empty', () => {
    const queue = createPermissionRequestQueue();
    expect(queue.next()).toBeNull();
  });

  test('should get request by id without removing it', () => {
    const queue = createPermissionRequestQueue();

    const request: PermissionRequest = {
      id: 'req-1',
      toolName: 'Write',
      paneId: '%42',
      sessionId: 'session-123',
      cwd: '/home/genie/workspace/guga',
      timestamp: '2026-02-03T12:00:00.000Z',
    };

    queue.add(request);

    const found = queue.get('req-1');
    expect(found).not.toBeNull();
    expect(found?.id).toBe('req-1');
    // Should still be in queue
    expect(queue.size()).toBe(1);

    // Non-existent ID should return null
    expect(queue.get('req-999')).toBeNull();
  });

  test('should remove request by id', () => {
    const queue = createPermissionRequestQueue();

    const request1: PermissionRequest = {
      id: 'req-1',
      toolName: 'Write',
      paneId: '%42',
      sessionId: 'session-123',
      cwd: '/home/genie/workspace/guga',
      timestamp: '2026-02-03T12:00:00.000Z',
    };

    const request2: PermissionRequest = {
      id: 'req-2',
      toolName: 'Bash',
      paneId: '%42',
      sessionId: 'session-123',
      cwd: '/home/genie/workspace/guga',
      timestamp: '2026-02-03T12:00:01.000Z',
    };

    queue.add(request1);
    queue.add(request2);
    queue.remove('req-1');

    expect(queue.size()).toBe(1);
    expect(queue.getAll()[0].id).toBe('req-2');
  });

  test('should get pending requests by pane id', () => {
    const queue = createPermissionRequestQueue();

    const request1: PermissionRequest = {
      id: 'req-1',
      toolName: 'Write',
      paneId: '%42',
      sessionId: 'session-123',
      cwd: '/home/genie/workspace/guga',
      timestamp: '2026-02-03T12:00:00.000Z',
    };

    const request2: PermissionRequest = {
      id: 'req-2',
      toolName: 'Bash',
      paneId: '%99',
      sessionId: 'session-456',
      cwd: '/home/genie/workspace/guga',
      timestamp: '2026-02-03T12:00:01.000Z',
    };

    queue.add(request1);
    queue.add(request2);

    const pane42Requests = queue.getByPane('%42');
    expect(pane42Requests.length).toBe(1);
    expect(pane42Requests[0].id).toBe('req-1');
  });

  test('should clear all requests', () => {
    const queue = createPermissionRequestQueue();

    queue.add({
      id: 'req-1',
      toolName: 'Write',
      paneId: '%42',
      sessionId: 'session-123',
      cwd: '/home/genie/workspace/guga',
      timestamp: '2026-02-03T12:00:00.000Z',
    });

    queue.add({
      id: 'req-2',
      toolName: 'Bash',
      paneId: '%42',
      sessionId: 'session-123',
      cwd: '/home/genie/workspace/guga',
      timestamp: '2026-02-03T12:00:01.000Z',
    });

    queue.clear();
    expect(queue.size()).toBe(0);
  });
});

// ============================================================================
// Event Subscription Tests
// ============================================================================

describe('subscribeToPermissionRequests', () => {
  beforeEach(async () => {
    await setupTestDir();
  });

  afterEach(async () => {
    await cleanupTestDir();
  });

  test('should create subscription with callback', async () => {
    const receivedRequests: PermissionRequest[] = [];
    const callback = (request: PermissionRequest) => {
      receivedRequests.push(request);
    };

    const subscription = subscribeToPermissionRequests(callback);

    expect(subscription).toBeDefined();
    expect(typeof subscription.unsubscribe).toBe('function');
    expect(typeof subscription.processEvent).toBe('function');

    subscription.unsubscribe();
  });

  test('should process tool_call events and invoke callback', async () => {
    const receivedRequests: PermissionRequest[] = [];
    const callback = (request: PermissionRequest) => {
      receivedRequests.push(request);
    };

    const subscription = subscribeToPermissionRequests(callback);

    const event: NormalizedEvent = {
      type: 'tool_call',
      timestamp: '2026-02-03T12:00:00.000Z',
      sessionId: 'session-123',
      cwd: '/home/genie/workspace/guga',
      paneId: '%42',
      wishId: 'wish-23',
      toolName: 'Write',
      toolInput: { file_path: '/test/file.txt' },
      toolCallId: 'toolu_123',
    };

    subscription.processEvent(event);

    expect(receivedRequests.length).toBe(1);
    expect(receivedRequests[0].toolName).toBe('Write');
    expect(receivedRequests[0].paneId).toBe('%42');

    subscription.unsubscribe();
  });

  test('should process permission_request events and invoke callback', async () => {
    const receivedRequests: PermissionRequest[] = [];
    const callback = (request: PermissionRequest) => {
      receivedRequests.push(request);
    };

    const subscription = subscribeToPermissionRequests(callback);

    const event: NormalizedEvent = {
      type: 'permission_request',
      timestamp: '2026-02-03T12:00:00.000Z',
      sessionId: 'session-123',
      cwd: '/home/genie/workspace/guga',
      paneId: '%42',
      toolName: 'Bash',
    };

    subscription.processEvent(event);

    expect(receivedRequests.length).toBe(1);
    expect(receivedRequests[0].toolName).toBe('Bash');

    subscription.unsubscribe();
  });

  test('should not invoke callback for non-permission events', async () => {
    const receivedRequests: PermissionRequest[] = [];
    const callback = (request: PermissionRequest) => {
      receivedRequests.push(request);
    };

    const subscription = subscribeToPermissionRequests(callback);

    const sessionStartEvent: NormalizedEvent = {
      type: 'session_start',
      timestamp: '2026-02-03T12:00:00.000Z',
      sessionId: 'session-123',
      cwd: '/home/genie/workspace/guga',
    };

    const sessionEndEvent: NormalizedEvent = {
      type: 'session_end',
      timestamp: '2026-02-03T12:01:00.000Z',
      sessionId: 'session-123',
      cwd: '/home/genie/workspace/guga',
    };

    subscription.processEvent(sessionStartEvent);
    subscription.processEvent(sessionEndEvent);

    expect(receivedRequests.length).toBe(0);

    subscription.unsubscribe();
  });

  test('should generate unique request IDs', async () => {
    const receivedRequests: PermissionRequest[] = [];
    const callback = (request: PermissionRequest) => {
      receivedRequests.push(request);
    };

    const subscription = subscribeToPermissionRequests(callback);

    const event1: NormalizedEvent = {
      type: 'tool_call',
      timestamp: '2026-02-03T12:00:00.000Z',
      sessionId: 'session-123',
      cwd: '/home/genie/workspace/guga',
      paneId: '%42',
      toolName: 'Write',
      toolCallId: 'toolu_1',
    };

    const event2: NormalizedEvent = {
      type: 'tool_call',
      timestamp: '2026-02-03T12:00:01.000Z',
      sessionId: 'session-123',
      cwd: '/home/genie/workspace/guga',
      paneId: '%42',
      toolName: 'Write',
      toolCallId: 'toolu_2',
    };

    subscription.processEvent(event1);
    subscription.processEvent(event2);

    expect(receivedRequests.length).toBe(2);
    expect(receivedRequests[0].id).not.toBe(receivedRequests[1].id);

    subscription.unsubscribe();
  });

  test('should not invoke callback after unsubscribe', async () => {
    const receivedRequests: PermissionRequest[] = [];
    const callback = (request: PermissionRequest) => {
      receivedRequests.push(request);
    };

    const subscription = subscribeToPermissionRequests(callback);

    const event: NormalizedEvent = {
      type: 'tool_call',
      timestamp: '2026-02-03T12:00:00.000Z',
      sessionId: 'session-123',
      cwd: '/home/genie/workspace/guga',
      paneId: '%42',
      toolName: 'Write',
    };

    subscription.processEvent(event);
    expect(receivedRequests.length).toBe(1);

    subscription.unsubscribe();

    subscription.processEvent(event);
    // Should not add another request after unsubscribe
    expect(receivedRequests.length).toBe(1);
  });
});

// ============================================================================
// Integration Tests with Queue
// ============================================================================

describe('Event Subscription with Queue Integration', () => {
  test('should add requests to queue via subscription callback', () => {
    const queue = createPermissionRequestQueue();

    const subscription = subscribeToPermissionRequests((request) => {
      queue.add(request);
    });

    const event: NormalizedEvent = {
      type: 'tool_call',
      timestamp: '2026-02-03T12:00:00.000Z',
      sessionId: 'session-123',
      cwd: '/home/genie/workspace/guga',
      paneId: '%42',
      wishId: 'wish-23',
      toolName: 'Write',
      toolInput: { file_path: '/test/file.txt' },
    };

    subscription.processEvent(event);

    expect(queue.size()).toBe(1);
    const queued = queue.getAll()[0];
    expect(queued.toolName).toBe('Write');
    expect(queued.paneId).toBe('%42');
    expect(queued.wishId).toBe('wish-23');

    subscription.unsubscribe();
  });
});
