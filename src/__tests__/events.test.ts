/**
 * Tests for event types and parsing.
 *
 * File-based event operations (writeEventToFile, readEventsFromFile, cleanupEventFile)
 * have been replaced by audit_events PG table. These tests validate the remaining
 * event parsing and type definitions.
 */

import { describe, expect, it } from 'bun:test';
import type { ClaudeLogEntry } from '../lib/claude-logs.js';
import { type NormalizedEvent, parseLogEntryToEvent } from '../term-commands/events.js';

describe('NormalizedEvent type', () => {
  it('should allow constructing a valid NormalizedEvent', () => {
    const event: NormalizedEvent = {
      type: 'tool_call',
      timestamp: '2026-02-03T12:00:00.000Z',
      sessionId: 'test-session',
      cwd: '/tmp/test',
      paneId: '%42',
      toolName: 'Read',
    };
    expect(event.type).toBe('tool_call');
    expect(event.toolName).toBe('Read');
  });
});

describe('parseLogEntryToEvent', () => {
  it('should parse a user entry as session_start', () => {
    const entry: ClaudeLogEntry = {
      type: 'user',
      timestamp: '2026-02-03T12:00:00.000Z',
      sessionId: 'test-session',
      uuid: 'uuid-1',
      parentUuid: null,
      cwd: '/tmp/test',
      raw: {},
    };
    const result = parseLogEntryToEvent(entry);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('session_start');
  });

  it('should return null for follow-up user entries', () => {
    const entry: ClaudeLogEntry = {
      type: 'user',
      timestamp: '2026-02-03T12:00:00.000Z',
      sessionId: 'test-session',
      uuid: 'uuid-2',
      parentUuid: 'uuid-1',
      cwd: '/tmp/test',
      raw: {},
    };
    const result = parseLogEntryToEvent(entry);
    expect(result).toBeNull();
  });
});
