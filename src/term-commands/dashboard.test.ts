/**
 * Dashboard rendering tests
 *
 * Tests the dashboard table layout, color coding, time-ago formatting,
 * truncation, JSON mode, verbose mode, and graceful fallback.
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn, test } from 'bun:test';
import type { WorkerDashboardState } from '../lib/event-aggregator.js';
import type { NormalizedEvent } from './events.js';

// ============================================================================
// Import the module under test (will be created in GREEN step)
// ============================================================================

import {
  formatTimeAgo,
  statusIndicator,
  truncate,
  renderDashboardTable,
  renderDashboardJson,
  renderDashboardVerbose,
  detectChanges,
  renderWatchHeader,
  renderEventStream,
  startWatchMode,
  type DashboardOptions,
  type DashboardData,
} from './dashboard.js';

// ============================================================================
// formatTimeAgo
// ============================================================================

describe('formatTimeAgo', () => {
  it('should format seconds ago', () => {
    const now = Date.now();
    expect(formatTimeAgo(now - 2000, now)).toBe('2s ago');
  });

  it('should format minutes ago', () => {
    const now = Date.now();
    expect(formatTimeAgo(now - 65000, now)).toBe('1m ago');
  });

  it('should format many minutes ago', () => {
    const now = Date.now();
    expect(formatTimeAgo(now - 300000, now)).toBe('5m ago');
  });

  it('should format hours ago', () => {
    const now = Date.now();
    expect(formatTimeAgo(now - 3600000, now)).toBe('1h ago');
  });

  it('should handle zero diff as just now', () => {
    const now = Date.now();
    expect(formatTimeAgo(now, now)).toBe('0s ago');
  });

  it('should handle future timestamps gracefully', () => {
    const now = Date.now();
    // Future timestamps should show 0s ago (clamp to zero)
    expect(formatTimeAgo(now + 5000, now)).toBe('0s ago');
  });
});

// ============================================================================
// statusIndicator
// ============================================================================

describe('statusIndicator', () => {
  it('should return green bullet for running', () => {
    const result = statusIndicator('running');
    expect(result.text).toContain('Running');
    // Should contain ANSI green escape code
    expect(result.ansi).toContain('\x1b[32m');
  });

  it('should return yellow hourglass for waiting', () => {
    const result = statusIndicator('waiting');
    expect(result.text).toContain('Waiting');
    // Should contain ANSI yellow escape code
    expect(result.ansi).toContain('\x1b[33m');
  });

  it('should return gray dash for idle', () => {
    const result = statusIndicator('idle');
    expect(result.text).toContain('Idle');
    // Should contain ANSI gray escape code
    expect(result.ansi).toContain('\x1b[90m');
  });

  it('should return red cross for stopped', () => {
    const result = statusIndicator('stopped');
    expect(result.text).toContain('Stopped');
    // Should contain ANSI red escape code
    expect(result.ansi).toContain('\x1b[31m');
  });
});

// ============================================================================
// truncate
// ============================================================================

describe('truncate', () => {
  it('should not truncate short strings', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('should truncate long strings with ellipsis', () => {
    expect(truncate('this is a very long string', 10)).toBe('this is...');
  });

  it('should handle exact length', () => {
    expect(truncate('hello', 5)).toBe('hello');
  });

  it('should handle empty string', () => {
    expect(truncate('', 10)).toBe('');
  });

  it('should handle maxLen smaller than 3', () => {
    // If maxLen is very small, just truncate without ellipsis
    expect(truncate('hello', 2)).toBe('he');
  });
});

// ============================================================================
// renderDashboardTable (string output, not console.log)
// ============================================================================

describe('renderDashboardTable', () => {
  const now = Date.now();

  const sampleStates: WorkerDashboardState[] = [
    {
      paneId: '%85',
      wishId: 'wish-21',
      status: 'running',
      lastEvent: { type: 'tool_call', toolName: 'Edit', timestamp: now - 2000 },
      lastActivityAt: now - 2000,
      eventCount: 15,
    },
    {
      paneId: '%86',
      wishId: 'wish-23',
      status: 'waiting',
      lastEvent: { type: 'permission_request', toolName: 'Bash', timestamp: now - 45000 },
      lastActivityAt: now - 45000,
      eventCount: 8,
    },
    {
      paneId: '%87',
      wishId: 'wish-24',
      status: 'running',
      lastEvent: { type: 'tool_call', toolName: 'Read', timestamp: now - 5000 },
      lastActivityAt: now - 5000,
      eventCount: 3,
    },
  ];

  it('should include header with active worker count', () => {
    const output = renderDashboardTable({ workers: sampleStates, now });
    expect(output).toContain('WORKERS');
    expect(output).toContain('3 active');
  });

  it('should show wish-id for each worker', () => {
    const output = renderDashboardTable({ workers: sampleStates, now });
    expect(output).toContain('wish-21');
    expect(output).toContain('wish-23');
    expect(output).toContain('wish-24');
  });

  it('should show pane ID for each worker', () => {
    const output = renderDashboardTable({ workers: sampleStates, now });
    expect(output).toContain('%85');
    expect(output).toContain('%86');
    expect(output).toContain('%87');
  });

  it('should show status indicator text', () => {
    const output = renderDashboardTable({ workers: sampleStates, now });
    expect(output).toContain('Running');
    expect(output).toContain('Waiting');
  });

  it('should show last tool name', () => {
    const output = renderDashboardTable({ workers: sampleStates, now });
    expect(output).toContain('Edit');
    expect(output).toContain('Bash');
    expect(output).toContain('Read');
  });

  it('should show time-ago for each worker', () => {
    const output = renderDashboardTable({ workers: sampleStates, now });
    expect(output).toContain('2s ago');
    expect(output).toContain('45s ago');
    expect(output).toContain('5s ago');
  });

  it('should handle empty workers list', () => {
    const output = renderDashboardTable({ workers: [], now });
    expect(output).toContain('WORKERS');
    expect(output).toContain('0 active');
    expect(output).toContain('No active workers');
  });

  it('should highlight waiting workers with warning indicator', () => {
    const waitingOnly: WorkerDashboardState[] = [
      {
        paneId: '%90',
        wishId: 'wish-10',
        status: 'waiting',
        lastEvent: { type: 'permission_request', toolName: 'Bash', timestamp: now - 10000 },
        lastActivityAt: now - 10000,
        eventCount: 5,
      },
    ];
    const output = renderDashboardTable({ workers: waitingOnly, now });
    // Yellow ANSI for waiting status
    expect(output).toContain('\x1b[33m');
    expect(output).toContain('Waiting');
  });

  it('should handle workers without wishId', () => {
    const noWish: WorkerDashboardState[] = [
      {
        paneId: '%95',
        status: 'running',
        lastActivityAt: now - 1000,
        eventCount: 2,
      },
    ];
    const output = renderDashboardTable({ workers: noWish, now });
    expect(output).toContain('%95');
    // Should show a dash or empty for missing wish
    expect(output).toContain('-');
  });

  it('should handle workers without lastEvent', () => {
    const noEvent: WorkerDashboardState[] = [
      {
        paneId: '%96',
        wishId: 'wish-5',
        status: 'idle',
        lastActivityAt: now - 60000,
        eventCount: 0,
      },
    ];
    const output = renderDashboardTable({ workers: noEvent, now });
    expect(output).toContain('wish-5');
    expect(output).toContain('%96');
  });
});

// ============================================================================
// renderDashboardJson
// ============================================================================

describe('renderDashboardJson', () => {
  const now = Date.now();

  it('should return valid JSON string', () => {
    const states: WorkerDashboardState[] = [
      {
        paneId: '%85',
        wishId: 'wish-21',
        status: 'running',
        lastEvent: { type: 'tool_call', toolName: 'Edit', timestamp: now - 2000 },
        lastActivityAt: now - 2000,
        eventCount: 15,
      },
    ];
    const output = renderDashboardJson({ workers: states, now });
    const parsed = JSON.parse(output);
    expect(parsed).toBeDefined();
    expect(Array.isArray(parsed.workers)).toBe(true);
    expect(parsed.workers.length).toBe(1);
  });

  it('should include all worker fields in JSON', () => {
    const states: WorkerDashboardState[] = [
      {
        paneId: '%85',
        wishId: 'wish-21',
        status: 'running',
        lastEvent: { type: 'tool_call', toolName: 'Edit', timestamp: now - 2000 },
        lastActivityAt: now - 2000,
        eventCount: 15,
      },
    ];
    const output = renderDashboardJson({ workers: states, now });
    const parsed = JSON.parse(output);
    const worker = parsed.workers[0];
    expect(worker.paneId).toBe('%85');
    expect(worker.wishId).toBe('wish-21');
    expect(worker.status).toBe('running');
    expect(worker.lastTool).toBe('Edit');
    expect(worker.timeAgo).toBe('2s ago');
    expect(worker.eventCount).toBe(15);
  });

  it('should include summary in JSON', () => {
    const states: WorkerDashboardState[] = [
      { paneId: '%85', status: 'running', lastActivityAt: now, eventCount: 1 },
      { paneId: '%86', status: 'waiting', lastActivityAt: now, eventCount: 1 },
      { paneId: '%87', status: 'idle', lastActivityAt: now, eventCount: 1 },
    ];
    const output = renderDashboardJson({ workers: states, now });
    const parsed = JSON.parse(output);
    expect(parsed.summary.total).toBe(3);
    expect(parsed.summary.running).toBe(1);
    expect(parsed.summary.waiting).toBe(1);
    expect(parsed.summary.idle).toBe(1);
  });
});

// ============================================================================
// renderDashboardVerbose
// ============================================================================

describe('renderDashboardVerbose', () => {
  const now = Date.now();

  it('should include event count per worker', () => {
    const states: WorkerDashboardState[] = [
      {
        paneId: '%85',
        wishId: 'wish-21',
        status: 'running',
        lastEvent: { type: 'tool_call', toolName: 'Edit', timestamp: now - 2000 },
        lastActivityAt: now - 2000,
        eventCount: 15,
      },
    ];
    const output = renderDashboardVerbose({ workers: states, now });
    expect(output).toContain('15');
    expect(output).toContain('events');
  });

  it('should show full event type for each worker', () => {
    const states: WorkerDashboardState[] = [
      {
        paneId: '%85',
        wishId: 'wish-21',
        status: 'running',
        lastEvent: { type: 'tool_call', toolName: 'Edit', timestamp: now - 2000 },
        lastActivityAt: now - 2000,
        eventCount: 15,
      },
    ];
    const output = renderDashboardVerbose({ workers: states, now });
    expect(output).toContain('tool_call');
    expect(output).toContain('Edit');
  });

  it('should handle empty workers', () => {
    const output = renderDashboardVerbose({ workers: [], now });
    expect(output).toContain('No active workers');
  });
});

// ============================================================================
// Graceful fallback (workers without event data)
// ============================================================================

describe('graceful fallback', () => {
  const now = Date.now();

  it('should render workers with no lastEvent (fallback from registry)', () => {
    const fallbackStates: WorkerDashboardState[] = [
      {
        paneId: '%50',
        wishId: 'wish-10',
        status: 'running',
        lastActivityAt: now - 120000,
        eventCount: 0,
      },
      {
        paneId: '%51',
        wishId: 'wish-11',
        status: 'idle',
        lastActivityAt: now - 300000,
        eventCount: 0,
      },
    ];

    const output = renderDashboardTable({ workers: fallbackStates, now });
    expect(output).toContain('wish-10');
    expect(output).toContain('wish-11');
    expect(output).toContain('%50');
    expect(output).toContain('%51');
    expect(output).toContain('2 active');
  });
});

// ============================================================================
// Group C: Watch mode - detectChanges
// ============================================================================

describe('detectChanges', () => {
  it('returns empty set when both arrays are empty', () => {
    const result = detectChanges([], []);
    expect(result.size).toBe(0);
  });

  it('returns all paneIds when previous is empty (all new)', () => {
    const current: WorkerDashboardState[] = [
      {
        paneId: '%1',
        status: 'running',
        lastActivityAt: 1000,
        eventCount: 1,
      },
      {
        paneId: '%2',
        status: 'idle',
        lastActivityAt: 2000,
        eventCount: 0,
      },
    ];
    const result = detectChanges([], current);
    expect(result.size).toBe(2);
    expect(result.has('%1')).toBe(true);
    expect(result.has('%2')).toBe(true);
  });

  it('detects status change', () => {
    const prev: WorkerDashboardState[] = [
      {
        paneId: '%1',
        status: 'running',
        lastActivityAt: 1000,
        eventCount: 1,
      },
    ];
    const current: WorkerDashboardState[] = [
      {
        paneId: '%1',
        status: 'waiting',
        lastActivityAt: 2000,
        eventCount: 2,
      },
    ];
    const result = detectChanges(prev, current);
    expect(result.has('%1')).toBe(true);
  });

  it('detects lastActivityAt change', () => {
    const prev: WorkerDashboardState[] = [
      {
        paneId: '%1',
        status: 'running',
        lastActivityAt: 1000,
        eventCount: 1,
      },
    ];
    const current: WorkerDashboardState[] = [
      {
        paneId: '%1',
        status: 'running',
        lastActivityAt: 2000,
        eventCount: 2,
      },
    ];
    const result = detectChanges(prev, current);
    expect(result.has('%1')).toBe(true);
  });

  it('detects eventCount change', () => {
    const prev: WorkerDashboardState[] = [
      {
        paneId: '%1',
        status: 'running',
        lastActivityAt: 1000,
        eventCount: 1,
      },
    ];
    const current: WorkerDashboardState[] = [
      {
        paneId: '%1',
        status: 'running',
        lastActivityAt: 1000,
        eventCount: 5,
      },
    ];
    const result = detectChanges(prev, current);
    expect(result.has('%1')).toBe(true);
  });

  it('returns empty set when nothing changed', () => {
    const prev: WorkerDashboardState[] = [
      {
        paneId: '%1',
        status: 'running',
        lastActivityAt: 1000,
        eventCount: 1,
        lastEvent: { type: 'tool_call', toolName: 'Read', timestamp: 1000 },
      },
    ];
    const current: WorkerDashboardState[] = [
      {
        paneId: '%1',
        status: 'running',
        lastActivityAt: 1000,
        eventCount: 1,
        lastEvent: { type: 'tool_call', toolName: 'Read', timestamp: 1000 },
      },
    ];
    const result = detectChanges(prev, current);
    expect(result.size).toBe(0);
  });

  it('detects worker removed (in prev but not in current)', () => {
    const prev: WorkerDashboardState[] = [
      {
        paneId: '%1',
        status: 'running',
        lastActivityAt: 1000,
        eventCount: 1,
      },
      {
        paneId: '%2',
        status: 'idle',
        lastActivityAt: 500,
        eventCount: 0,
      },
    ];
    const current: WorkerDashboardState[] = [
      {
        paneId: '%1',
        status: 'running',
        lastActivityAt: 1000,
        eventCount: 1,
      },
    ];
    const result = detectChanges(prev, current);
    expect(result.has('%2')).toBe(true);
  });

  it('detects lastEvent toolName change', () => {
    const prev: WorkerDashboardState[] = [
      {
        paneId: '%1',
        status: 'running',
        lastActivityAt: 1000,
        eventCount: 2,
        lastEvent: { type: 'tool_call', toolName: 'Read', timestamp: 1000 },
      },
    ];
    const current: WorkerDashboardState[] = [
      {
        paneId: '%1',
        status: 'running',
        lastActivityAt: 1000,
        eventCount: 2,
        lastEvent: { type: 'tool_call', toolName: 'Write', timestamp: 1000 },
      },
    ];
    const result = detectChanges(prev, current);
    expect(result.has('%1')).toBe(true);
  });
});

// ============================================================================
// Group C: Watch mode - renderWatchHeader
// ============================================================================

describe('renderWatchHeader', () => {
  it('includes "watching" text', () => {
    const result = renderWatchHeader(Date.now());
    expect(result).toContain('watching');
  });

  it('includes a timestamp with colons (HH:MM:SS)', () => {
    const now = new Date('2026-02-03T12:00:00Z').getTime();
    const result = renderWatchHeader(now);
    expect(result).toContain(':');
  });

  it('includes Dashboard label', () => {
    const result = renderWatchHeader(Date.now());
    expect(result.toLowerCase()).toContain('dashboard');
  });
});

// ============================================================================
// Group C: Watch mode - renderEventStream
// ============================================================================

describe('renderEventStream', () => {
  it('returns section header when no events', () => {
    const result = renderEventStream([], 5);
    expect(result).toContain('EVENTS');
    expect(result.toLowerCase()).toContain('no recent events');
  });

  it('limits events to specified count', () => {
    const events: NormalizedEvent[] = [];
    for (let i = 0; i < 10; i++) {
      events.push({
        type: 'tool_call',
        timestamp: new Date(1000 + i * 1000).toISOString(),
        sessionId: 'sess-1',
        cwd: '/tmp',
        paneId: '%1',
        toolName: `Tool${i}`,
      });
    }

    const result = renderEventStream(events, 3);
    // Should only show the last 3 events (Tool7, Tool8, Tool9)
    expect(result).toContain('Tool9');
    expect(result).toContain('Tool8');
    expect(result).toContain('Tool7');
    expect(result).not.toContain('Tool0');
    expect(result).not.toContain('Tool6');
  });

  it('shows event type and tool name', () => {
    const events: NormalizedEvent[] = [
      {
        type: 'tool_call',
        timestamp: new Date(5000).toISOString(),
        sessionId: 'sess-1',
        cwd: '/tmp',
        paneId: '%1',
        toolName: 'Bash',
      },
    ];

    const result = renderEventStream(events, 5);
    expect(result).toContain('Bash');
  });

  it('shows wish context if available', () => {
    const events: NormalizedEvent[] = [
      {
        type: 'tool_call',
        timestamp: new Date(5000).toISOString(),
        sessionId: 'sess-1',
        cwd: '/tmp',
        paneId: '%1',
        wishId: 'wish-21',
        toolName: 'Read',
      },
    ];

    const result = renderEventStream(events, 5);
    expect(result).toContain('wish-21');
  });

  it('handles permission_request events', () => {
    const events: NormalizedEvent[] = [
      {
        type: 'permission_request',
        timestamp: new Date(5000).toISOString(),
        sessionId: 'sess-1',
        cwd: '/tmp',
        paneId: '%1',
        toolName: 'Bash',
      },
    ];

    const result = renderEventStream(events, 5);
    expect(result.toLowerCase()).toContain('permission');
  });
});

// ============================================================================
// Group C: Watch mode - startWatchMode
// ============================================================================

describe('startWatchMode', () => {
  let originalConsoleLog: typeof console.log;
  let originalConsoleError: typeof console.error;
  let capturedOutput: string[];

  beforeEach(() => {
    capturedOutput = [];
    originalConsoleLog = console.log;
    originalConsoleError = console.error;
    console.log = (...args: any[]) => {
      capturedOutput.push(args.join(' '));
    };
    console.error = (...args: any[]) => {
      capturedOutput.push(args.join(' '));
    };
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  });

  it('returns a cleanup function', () => {
    const mockFetcher = async (): Promise<DashboardData> => ({
      workers: [],
      now: Date.now(),
    });
    const mockEventFetcher = async (): Promise<NormalizedEvent[]> => [];

    const cleanup = startWatchMode({
      fetchData: mockFetcher,
      fetchEvents: mockEventFetcher,
      intervalMs: 100000,
    });

    expect(typeof cleanup).toBe('function');
    cleanup();
  });

  it('renders initial output immediately', async () => {
    const mockFetcher = async (): Promise<DashboardData> => ({
      workers: [
        {
          paneId: '%1',
          wishId: 'wish-21',
          status: 'running',
          lastActivityAt: Date.now(),
          eventCount: 5,
          lastEvent: { type: 'tool_call', toolName: 'Read', timestamp: Date.now() },
        },
      ],
      now: Date.now(),
    });
    const mockEventFetcher = async (): Promise<NormalizedEvent[]> => [];

    const cleanup = startWatchMode({
      fetchData: mockFetcher,
      fetchEvents: mockEventFetcher,
      intervalMs: 100000,
    });

    // Wait a tick for async initial render
    await new Promise(resolve => setTimeout(resolve, 50));

    const output = capturedOutput.join('\n');
    expect(output).toContain('watching');
    expect(output).toContain('wish-21');

    cleanup();
  });

  it('refreshes on interval', async () => {
    let callCount = 0;
    const mockFetcher = async (): Promise<DashboardData> => {
      callCount++;
      return {
        workers: [
          {
            paneId: '%1',
            status: callCount === 1 ? 'running' : 'waiting',
            lastActivityAt: Date.now(),
            eventCount: callCount,
          },
        ],
        now: Date.now(),
      };
    };
    const mockEventFetcher = async (): Promise<NormalizedEvent[]> => [];

    const cleanup = startWatchMode({
      fetchData: mockFetcher,
      fetchEvents: mockEventFetcher,
      intervalMs: 80,
    });

    // Wait for initial + at least 1 interval
    await new Promise(resolve => setTimeout(resolve, 300));

    expect(callCount).toBeGreaterThanOrEqual(2);
    cleanup();
  });

  it('cleanup stops the interval', async () => {
    let callCount = 0;
    const mockFetcher = async (): Promise<DashboardData> => {
      callCount++;
      return { workers: [], now: Date.now() };
    };
    const mockEventFetcher = async (): Promise<NormalizedEvent[]> => [];

    const cleanup = startWatchMode({
      fetchData: mockFetcher,
      fetchEvents: mockEventFetcher,
      intervalMs: 50,
    });

    // Wait for a couple ticks
    await new Promise(resolve => setTimeout(resolve, 180));
    const countAtCleanup = callCount;
    cleanup();

    // Wait some more
    await new Promise(resolve => setTimeout(resolve, 200));

    // Should not have increased by much (at most 1 more if timer fired before cleanup)
    expect(callCount).toBeLessThanOrEqual(countAtCleanup + 1);
  });

  it('highlights changed rows with bold ANSI', async () => {
    let callCount = 0;
    const mockFetcher = async (): Promise<DashboardData> => {
      callCount++;
      return {
        workers: [
          {
            paneId: '%1',
            wishId: 'wish-21',
            status: callCount <= 1 ? 'running' : 'waiting',
            lastActivityAt: Date.now(),
            eventCount: callCount,
            lastEvent: { type: 'tool_call', toolName: 'Read', timestamp: Date.now() },
          },
        ],
        now: Date.now(),
      };
    };
    const mockEventFetcher = async (): Promise<NormalizedEvent[]> => [];

    const cleanup = startWatchMode({
      fetchData: mockFetcher,
      fetchEvents: mockEventFetcher,
      intervalMs: 80,
    });

    // Wait for at least 2 renders (initial + 1 refresh where state changes)
    await new Promise(resolve => setTimeout(resolve, 250));

    const fullOutput = capturedOutput.join('\n');
    // The bold code \x1b[1m should appear for the changed row
    expect(fullOutput).toContain('\x1b[1m');

    cleanup();
  });

  it('shows event stream at bottom', async () => {
    const mockFetcher = async (): Promise<DashboardData> => ({
      workers: [
        {
          paneId: '%1',
          wishId: 'wish-21',
          status: 'running',
          lastActivityAt: Date.now(),
          eventCount: 1,
        },
      ],
      now: Date.now(),
    });
    const mockEventFetcher = async (): Promise<NormalizedEvent[]> => [
      {
        type: 'tool_call',
        timestamp: new Date().toISOString(),
        sessionId: 'sess-1',
        cwd: '/tmp',
        paneId: '%1',
        wishId: 'wish-21',
        toolName: 'Read',
      },
    ];

    const cleanup = startWatchMode({
      fetchData: mockFetcher,
      fetchEvents: mockEventFetcher,
      intervalMs: 100000,
    });

    await new Promise(resolve => setTimeout(resolve, 50));

    const fullOutput = capturedOutput.join('\n');
    expect(fullOutput).toContain('EVENTS');
    expect(fullOutput).toContain('Read');

    cleanup();
  });
});

// ============================================================================
// Group C: DashboardOptions.watch flag
// ============================================================================

describe('DashboardOptions.watch', () => {
  it('accepts watch property', () => {
    const opts: DashboardOptions = { watch: true };
    expect(opts.watch).toBe(true);
  });
});
