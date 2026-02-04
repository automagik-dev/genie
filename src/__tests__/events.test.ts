/**
 * Tests for event emission and aggregation
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, readFile, writeFile, access } from 'fs/promises';
import { join } from 'path';
import {
  getEventsDir,
  getEventFilePath,
  writeEventToFile,
  readEventsFromFile,
  aggregateAllEvents,
  cleanupEventFile,
  type NormalizedEvent,
} from '../term-commands/events.js';

const TEST_DIR = '/tmp/genie-events-test';
const TEST_GENIE_DIR = join(TEST_DIR, '.genie');
const TEST_EVENTS_DIR = join(TEST_GENIE_DIR, 'events');

describe('Event file operations', () => {
  beforeEach(async () => {
    // Create test directory structure
    await mkdir(TEST_EVENTS_DIR, { recursive: true });
  });

  afterEach(async () => {
    // Cleanup test directory
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  describe('getEventsDir', () => {
    it('should return the events directory path', () => {
      const dir = getEventsDir(TEST_GENIE_DIR);
      expect(dir).toBe(TEST_EVENTS_DIR);
    });
  });

  describe('getEventFilePath', () => {
    it('should generate correct path for pane ID with prefix', () => {
      const path = getEventFilePath('%42', TEST_GENIE_DIR);
      expect(path).toBe(join(TEST_EVENTS_DIR, '%42.jsonl'));
    });

    it('should generate correct path for pane ID without prefix', () => {
      const path = getEventFilePath('42', TEST_GENIE_DIR);
      expect(path).toBe(join(TEST_EVENTS_DIR, '%42.jsonl'));
    });
  });

  describe('writeEventToFile', () => {
    it('should write event to JSONL file', async () => {
      const event: NormalizedEvent = {
        type: 'tool_call',
        timestamp: '2026-02-03T12:00:00.000Z',
        sessionId: 'test-session',
        cwd: '/tmp/test',
        paneId: '%42',
        toolName: 'Read',
      };

      await writeEventToFile(event, '%42', TEST_GENIE_DIR);

      const content = await readFile(join(TEST_EVENTS_DIR, '%42.jsonl'), 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines.length).toBe(1);

      const parsed = JSON.parse(lines[0]);
      expect(parsed.type).toBe('tool_call');
      expect(parsed.toolName).toBe('Read');
    });

    it('should append multiple events to the same file', async () => {
      const event1: NormalizedEvent = {
        type: 'session_start',
        timestamp: '2026-02-03T12:00:00.000Z',
        sessionId: 'test-session',
        cwd: '/tmp/test',
        paneId: '%42',
      };
      const event2: NormalizedEvent = {
        type: 'tool_call',
        timestamp: '2026-02-03T12:01:00.000Z',
        sessionId: 'test-session',
        cwd: '/tmp/test',
        paneId: '%42',
        toolName: 'Write',
      };

      await writeEventToFile(event1, '%42', TEST_GENIE_DIR);
      await writeEventToFile(event2, '%42', TEST_GENIE_DIR);

      const content = await readFile(join(TEST_EVENTS_DIR, '%42.jsonl'), 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines.length).toBe(2);
    });
  });

  describe('readEventsFromFile', () => {
    it('should read all events from JSONL file', async () => {
      const events = [
        { type: 'session_start', timestamp: '2026-02-03T12:00:00.000Z', sessionId: 's1', cwd: '/tmp' },
        { type: 'tool_call', timestamp: '2026-02-03T12:01:00.000Z', sessionId: 's1', cwd: '/tmp', toolName: 'Read' },
      ];

      const content = events.map(e => JSON.stringify(e)).join('\n') + '\n';
      await writeFile(join(TEST_EVENTS_DIR, '%42.jsonl'), content);

      const result = await readEventsFromFile('%42', TEST_GENIE_DIR);
      expect(result.length).toBe(2);
      expect(result[0].type).toBe('session_start');
      expect(result[1].type).toBe('tool_call');
    });

    it('should return empty array for non-existent file', async () => {
      const result = await readEventsFromFile('%99', TEST_GENIE_DIR);
      expect(result).toEqual([]);
    });
  });

  describe('aggregateAllEvents', () => {
    it('should aggregate events from multiple pane files', async () => {
      // Write events for pane %42
      const events42 = [
        { type: 'session_start', timestamp: '2026-02-03T12:00:00.000Z', sessionId: 's1', cwd: '/tmp', paneId: '%42' },
      ];
      await writeFile(
        join(TEST_EVENTS_DIR, '%42.jsonl'),
        events42.map(e => JSON.stringify(e)).join('\n') + '\n'
      );

      // Write events for pane %43
      const events43 = [
        { type: 'tool_call', timestamp: '2026-02-03T12:01:00.000Z', sessionId: 's2', cwd: '/tmp', paneId: '%43', toolName: 'Bash' },
      ];
      await writeFile(
        join(TEST_EVENTS_DIR, '%43.jsonl'),
        events43.map(e => JSON.stringify(e)).join('\n') + '\n'
      );

      const result = await aggregateAllEvents(TEST_GENIE_DIR);
      expect(result.length).toBe(2);

      // Events should be sorted by timestamp
      expect(result[0].paneId).toBe('%42');
      expect(result[1].paneId).toBe('%43');
    });

    it('should return empty array when no event files exist', async () => {
      const result = await aggregateAllEvents(TEST_GENIE_DIR);
      expect(result).toEqual([]);
    });
  });

  describe('cleanupEventFile', () => {
    it('should remove event file for terminated worker', async () => {
      // Create event file
      await writeFile(join(TEST_EVENTS_DIR, '%42.jsonl'), '{}');

      // Verify it exists (access resolves without throwing if file exists)
      let fileExists = false;
      try {
        await access(join(TEST_EVENTS_DIR, '%42.jsonl'));
        fileExists = true;
      } catch {
        fileExists = false;
      }
      expect(fileExists).toBe(true);

      // Cleanup
      await cleanupEventFile('%42', TEST_GENIE_DIR);

      // Verify it's gone
      let fileStillExists = true;
      try {
        await access(join(TEST_EVENTS_DIR, '%42.jsonl'));
        fileStillExists = true;
      } catch {
        fileStillExists = false;
      }
      expect(fileStillExists).toBe(false);
    });

    it('should not throw for non-existent file', async () => {
      // Should not throw
      await cleanupEventFile('%99', TEST_GENIE_DIR);
    });
  });
});
