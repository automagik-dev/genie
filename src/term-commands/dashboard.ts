/**
 * Dashboard command - Render worker status table with color coding
 *
 * Usage:
 *   term dashboard           - Show all active workers with current state
 *   term dashboard -v        - Verbose mode: show full tool parameters and event history
 *   term dashboard --json    - Output structured data as JSON
 *   term dashboard --watch   - Auto-refresh every 2s with change highlighting
 *
 * Data Sources:
 *   1. Event stream (via event-aggregator) - real-time tool calls, completions
 *   2. Worker registry (.genie/workers.json) - pane mappings (fallback)
 *   3. tmux - pane existence (fallback)
 */

import { createEventAggregator, type WorkerDashboardState } from '../lib/event-aggregator.js';
import { readEventsFromFile, listEventFiles, aggregateAllEvents, type NormalizedEvent } from './events.js';
import * as registry from '../lib/worker-registry.js';

// ============================================================================
// Types
// ============================================================================

export interface DashboardOptions {
  json?: boolean;
  verbose?: boolean;
  watch?: boolean;
}

export interface WatchModeOptions {
  /** Async function to fetch current dashboard data */
  fetchData: () => Promise<DashboardData>;
  /** Async function to fetch recent events across all workers */
  fetchEvents: () => Promise<NormalizedEvent[]>;
  /** Refresh interval in milliseconds (default: 2000) */
  intervalMs?: number;
}

export interface DashboardData {
  workers: WorkerDashboardState[];
  now: number;
}

interface StatusIndicatorResult {
  /** Plain text label (e.g., "Running") */
  text: string;
  /** ANSI-colored string for terminal output */
  ansi: string;
}

// ============================================================================
// Utility: Time-Ago Formatting
// ============================================================================

/**
 * Format a timestamp as a human-readable "time ago" string.
 *
 * Examples: "2s ago", "1m ago", "5m ago", "1h ago"
 *
 * @param timestamp - Epoch milliseconds of the event
 * @param now - Current epoch milliseconds (for testability)
 */
export function formatTimeAgo(timestamp: number, now: number): string {
  const diffMs = Math.max(0, now - timestamp);
  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ago`;
  } else if (minutes > 0) {
    return `${minutes}m ago`;
  } else {
    return `${seconds}s ago`;
  }
}

// ============================================================================
// Utility: Status Indicator with ANSI Colors
// ============================================================================

const ANSI_RESET = '\x1b[0m';
const ANSI_GREEN = '\x1b[32m';
const ANSI_YELLOW = '\x1b[33m';
const ANSI_RED = '\x1b[31m';
const ANSI_GRAY = '\x1b[90m';
const ANSI_BOLD = '\x1b[1m';

/**
 * Get a status indicator with ANSI color codes for terminal display.
 *
 * - running = green bullet
 * - waiting = yellow hourglass (warning indicator)
 * - idle = gray dash
 * - stopped = red cross
 */
export function statusIndicator(status: WorkerDashboardState['status']): StatusIndicatorResult {
  switch (status) {
    case 'running':
      return {
        text: 'Running',
        ansi: `${ANSI_GREEN}\u25CF Running${ANSI_RESET}`,
      };
    case 'waiting':
      return {
        text: 'Waiting',
        ansi: `${ANSI_YELLOW}\u23F3 Waiting${ANSI_RESET}`,
      };
    case 'idle':
      return {
        text: 'Idle',
        ansi: `${ANSI_GRAY}\u2500 Idle${ANSI_RESET}`,
      };
    case 'stopped':
      return {
        text: 'Stopped',
        ansi: `${ANSI_RED}\u2716 Stopped${ANSI_RESET}`,
      };
    default:
      return {
        text: 'Unknown',
        ansi: `${ANSI_GRAY}? Unknown${ANSI_RESET}`,
      };
  }
}

// ============================================================================
// Utility: String Truncation
// ============================================================================

/**
 * Truncate a string to fit within maxLen characters.
 * Adds "..." suffix if truncated (when maxLen >= 4).
 */
export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) {
    return str;
  }
  if (maxLen < 4) {
    return str.substring(0, maxLen);
  }
  return str.substring(0, maxLen - 3) + '...';
}

// ============================================================================
// Rendering: Table Layout
// ============================================================================

/**
 * Render the dashboard as a formatted table string with ANSI colors.
 *
 * Layout per row: wish-id | pane | status indicator | last tool | time-ago
 *
 * @returns The full table as a string (including newlines)
 */
export function renderDashboardTable(data: DashboardData): string {
  const { workers, now } = data;
  const lines: string[] = [];

  // Count active workers (non-stopped)
  const activeCount = workers.filter(w => w.status !== 'stopped').length;

  // Header
  const headerLabel = 'WORKERS';
  const headerRight = `${activeCount} active`;
  const headerWidth = 64;
  const headerPad = headerWidth - headerLabel.length - headerRight.length - 4;
  lines.push(`${ANSI_BOLD}${headerLabel}${ANSI_RESET}${' '.repeat(Math.max(1, headerPad))}${headerRight}`);
  lines.push('\u2500'.repeat(headerWidth));

  if (workers.length === 0) {
    lines.push(`${ANSI_GRAY}No active workers${ANSI_RESET}`);
    lines.push('');
    return lines.join('\n');
  }

  // Column headers
  const colWish = 'WISH'.padEnd(12);
  const colPane = 'PANE'.padEnd(6);
  const colStatus = 'STATUS'.padEnd(14);
  const colTool = 'LAST TOOL'.padEnd(20);
  const colTime = 'TIME';
  lines.push(`${ANSI_GRAY}${colWish}${colPane}${colStatus}${colTool}${colTime}${ANSI_RESET}`);

  // Worker rows
  for (const worker of workers) {
    const wishId = truncate(worker.wishId || '-', 11).padEnd(12);
    const pane = truncate(worker.paneId, 5).padEnd(6);
    const indicator = statusIndicator(worker.status);
    // Pad the ANSI status to take same visual width as plain text (14 chars)
    const statusPlainLen = indicator.text.length + 2; // icon + space + text
    const statusPad = ' '.repeat(Math.max(0, 14 - statusPlainLen));
    const statusCell = indicator.ansi + statusPad;
    const toolName = worker.lastEvent?.toolName
      ? truncate(worker.lastEvent.toolName, 19).padEnd(20)
      : '-'.padEnd(20);
    const timeAgo = formatTimeAgo(worker.lastActivityAt, now);

    lines.push(`${wishId}${pane}${statusCell}${toolName}${timeAgo}`);
  }

  lines.push('');
  return lines.join('\n');
}

// ============================================================================
// Rendering: JSON Output
// ============================================================================

/**
 * Render the dashboard as a JSON string.
 *
 * Includes a summary object with counts by status and a workers array
 * with normalized fields including timeAgo and lastTool.
 */
export function renderDashboardJson(data: DashboardData): string {
  const { workers, now } = data;

  const summary = {
    total: workers.length,
    running: workers.filter(w => w.status === 'running').length,
    waiting: workers.filter(w => w.status === 'waiting').length,
    idle: workers.filter(w => w.status === 'idle').length,
    stopped: workers.filter(w => w.status === 'stopped').length,
  };

  const workerEntries = workers.map(w => ({
    paneId: w.paneId,
    wishId: w.wishId || null,
    status: w.status,
    lastTool: w.lastEvent?.toolName || null,
    lastEventType: w.lastEvent?.type || null,
    timeAgo: formatTimeAgo(w.lastActivityAt, now),
    lastActivityAt: w.lastActivityAt,
    eventCount: w.eventCount,
  }));

  return JSON.stringify({ summary, workers: workerEntries }, null, 2);
}

// ============================================================================
// Rendering: Verbose Output
// ============================================================================

/**
 * Render the dashboard in verbose mode.
 *
 * Shows full event details per worker including event count,
 * event type, tool name, and last activity timestamp.
 */
export function renderDashboardVerbose(data: DashboardData): string {
  const { workers, now } = data;
  const lines: string[] = [];

  const activeCount = workers.filter(w => w.status !== 'stopped').length;

  // Header
  lines.push(`${ANSI_BOLD}WORKERS${ANSI_RESET} (verbose)  ${activeCount} active`);
  lines.push('\u2500'.repeat(72));

  if (workers.length === 0) {
    lines.push(`${ANSI_GRAY}No active workers${ANSI_RESET}`);
    lines.push('');
    return lines.join('\n');
  }

  for (const worker of workers) {
    const indicator = statusIndicator(worker.status);
    const wishLabel = worker.wishId || '-';
    const timeAgo = formatTimeAgo(worker.lastActivityAt, now);

    lines.push('');
    lines.push(`  ${ANSI_BOLD}${wishLabel}${ANSI_RESET}  ${worker.paneId}  ${indicator.ansi}  ${timeAgo}`);
    lines.push(`    ${worker.eventCount} events processed`);

    if (worker.lastEvent) {
      lines.push(`    Last event: ${worker.lastEvent.type}${worker.lastEvent.toolName ? ` (${worker.lastEvent.toolName})` : ''}`);
      const eventTime = new Date(worker.lastEvent.timestamp).toLocaleTimeString();
      lines.push(`    Event time: ${eventTime}`);
    } else {
      lines.push(`    ${ANSI_GRAY}No event data (fallback from registry/tmux)${ANSI_RESET}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

// ============================================================================
// Watch Mode: Change Detection
// ============================================================================

/**
 * Compare previous and current worker states to detect changes.
 *
 * Returns a Set of paneIds that have changed between renders.
 * Changes detected: status, lastActivityAt, eventCount, lastEvent toolName,
 * and workers added or removed.
 */
export function detectChanges(
  prev: WorkerDashboardState[],
  current: WorkerDashboardState[],
): Set<string> {
  const changed = new Set<string>();

  const prevMap = new Map<string, WorkerDashboardState>();
  for (const w of prev) {
    prevMap.set(w.paneId, w);
  }

  const currentMap = new Map<string, WorkerDashboardState>();
  for (const w of current) {
    currentMap.set(w.paneId, w);
  }

  // Check for new or changed workers
  for (const w of current) {
    const old = prevMap.get(w.paneId);
    if (!old) {
      // New worker
      changed.add(w.paneId);
      continue;
    }
    // Compare relevant fields
    if (
      old.status !== w.status ||
      old.lastActivityAt !== w.lastActivityAt ||
      old.eventCount !== w.eventCount ||
      (old.lastEvent?.toolName ?? null) !== (w.lastEvent?.toolName ?? null)
    ) {
      changed.add(w.paneId);
    }
  }

  // Check for removed workers
  for (const w of prev) {
    if (!currentMap.has(w.paneId)) {
      changed.add(w.paneId);
    }
  }

  return changed;
}

// ============================================================================
// Watch Mode: Header
// ============================================================================

/**
 * Render the watch mode header with "Dashboard (watching...)" and a timestamp.
 *
 * @param now - Epoch milliseconds for the current render
 */
export function renderWatchHeader(now: number): string {
  const time = new Date(now).toLocaleTimeString();
  return `${ANSI_BOLD}Dashboard${ANSI_RESET} (watching...)  ${ANSI_GRAY}${time}${ANSI_RESET}`;
}

// ============================================================================
// Watch Mode: Event Stream
// ============================================================================

/**
 * Render a compact event stream showing the last N events across all workers.
 *
 * @param events - All available NormalizedEvents (sorted by timestamp)
 * @param limit - Maximum number of events to display
 */
export function renderEventStream(events: NormalizedEvent[], limit: number): string {
  const lines: string[] = [];

  lines.push('');
  lines.push(`${ANSI_BOLD}EVENTS${ANSI_RESET}`);
  lines.push('\u2500'.repeat(64));

  if (events.length === 0) {
    lines.push(`${ANSI_GRAY}No recent events${ANSI_RESET}`);
    return lines.join('\n');
  }

  // Take only the last `limit` events
  const recent = events.slice(-limit);

  for (const event of recent) {
    const time = new Date(event.timestamp).toLocaleTimeString();
    const context = event.wishId ? `[${event.wishId}]` : event.paneId || '';

    let label: string;
    switch (event.type) {
      case 'tool_call':
        label = event.toolName || 'tool_call';
        break;
      case 'permission_request':
        label = `${ANSI_YELLOW}permission${ANSI_RESET} ${event.toolName || ''}`;
        break;
      case 'session_start':
        label = `${ANSI_GREEN}session_start${ANSI_RESET}`;
        break;
      case 'session_end':
        label = `${ANSI_RED}session_end${ANSI_RESET}`;
        break;
      default:
        label = event.type;
    }

    lines.push(`  ${ANSI_GRAY}${time}${ANSI_RESET} ${context} ${label}`);
  }

  return lines.join('\n');
}

// ============================================================================
// Watch Mode: Render with Highlights
// ============================================================================

/**
 * Render the dashboard table with changed rows highlighted in bold.
 */
function renderWatchTable(data: DashboardData, changedPaneIds: Set<string>): string {
  const { workers, now } = data;
  const lines: string[] = [];

  // Count active workers (non-stopped)
  const activeCount = workers.filter(w => w.status !== 'stopped').length;

  // Column headers
  const colWish = 'WISH'.padEnd(12);
  const colPane = 'PANE'.padEnd(6);
  const colStatus = 'STATUS'.padEnd(14);
  const colTool = 'LAST TOOL'.padEnd(20);
  const colTime = 'TIME';
  lines.push(`${ANSI_GRAY}${colWish}${colPane}${colStatus}${colTool}${colTime}${ANSI_RESET}`);

  if (workers.length === 0) {
    lines.push(`${ANSI_GRAY}No active workers${ANSI_RESET}`);
    return lines.join('\n');
  }

  // Worker rows
  for (const worker of workers) {
    const isChanged = changedPaneIds.has(worker.paneId);
    const boldStart = isChanged ? ANSI_BOLD : '';
    const boldEnd = isChanged ? ANSI_RESET : '';

    const wishId = truncate(worker.wishId || '-', 11).padEnd(12);
    const pane = truncate(worker.paneId, 5).padEnd(6);
    const indicator = statusIndicator(worker.status);
    const statusPlainLen = indicator.text.length + 2;
    const statusPad = ' '.repeat(Math.max(0, 14 - statusPlainLen));
    const statusCell = indicator.ansi + statusPad;
    const toolName = worker.lastEvent?.toolName
      ? truncate(worker.lastEvent.toolName, 19).padEnd(20)
      : '-'.padEnd(20);
    const timeAgo = formatTimeAgo(worker.lastActivityAt, now);

    lines.push(`${boldStart}${wishId}${pane}${statusCell}${toolName}${timeAgo}${boldEnd}`);
  }

  return lines.join('\n');
}

// ============================================================================
// Watch Mode: Main Loop
// ============================================================================

/**
 * Start watch mode with auto-refresh every intervalMs milliseconds.
 *
 * Returns a cleanup function that stops the interval when called.
 * This cleanup function is also registered as a SIGINT handler for Ctrl+C.
 */
export function startWatchMode(options: WatchModeOptions): () => void {
  const intervalMs = options.intervalMs ?? 2000;
  let previousWorkers: WorkerDashboardState[] = [];
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  async function render(): Promise<void> {
    if (stopped) return;

    try {
      const [data, events] = await Promise.all([
        options.fetchData(),
        options.fetchEvents(),
      ]);

      // Detect changes from previous render
      const changedIds = detectChanges(previousWorkers, data.workers);
      previousWorkers = data.workers.map(w => ({ ...w }));

      // Clear terminal
      process.stdout.write('\x1b[2J\x1b[H');

      // Watch header
      console.log(renderWatchHeader(data.now));
      console.log('');

      // Worker table with highlights
      console.log(renderWatchTable(data, changedIds));

      // Event stream at bottom
      console.log(renderEventStream(events, 5));
    } catch {
      // Silently skip render on error
    }
  }

  function cleanup(): void {
    stopped = true;
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  }

  // Register SIGINT handler for graceful Ctrl+C
  const sigintHandler = () => {
    cleanup();
    process.exit(0);
  };
  process.on('SIGINT', sigintHandler);

  // Initial render immediately
  render();

  // Set up interval for subsequent renders
  intervalId = setInterval(render, intervalMs);

  return () => {
    cleanup();
    process.removeListener('SIGINT', sigintHandler);
  };
}

// ============================================================================
// Main Command
// ============================================================================

/**
 * Fetch current dashboard data from event files and worker registry.
 * Shared helper used by both one-shot and watch modes.
 */
async function fetchDashboardData(): Promise<DashboardData> {
  const aggregator = createEventAggregator();
  const now = Date.now();

  // Try to load event files for all workers
  let hasEventData = false;
  try {
    const paneIds = await listEventFiles();
    for (const paneId of paneIds) {
      const events = await readEventsFromFile(paneId);
      for (const event of events) {
        aggregator.processEvent(event);
      }
      if (events.length > 0) {
        hasEventData = true;
      }
    }
  } catch {
    // Event stream unavailable, will fall back below
  }

  let workers: WorkerDashboardState[];

  if (hasEventData) {
    workers = aggregator.getWorkerStates();
  } else {
    // Graceful fallback: build state from worker registry
    try {
      const registryWorkers = await registry.list();
      workers = aggregator.buildFallbackStates(registryWorkers);
    } catch {
      workers = [];
    }
  }

  return { workers, now };
}

/**
 * Fetch recent events across all workers.
 * Used by watch mode for the event stream display.
 */
async function fetchAllEvents(): Promise<NormalizedEvent[]> {
  try {
    return await aggregateAllEvents();
  } catch {
    return [];
  }
}

export async function dashboardCommand(options: DashboardOptions = {}): Promise<void> {
  try {
    if (options.watch) {
      // Watch mode: continuous refresh
      startWatchMode({
        fetchData: fetchDashboardData,
        fetchEvents: fetchAllEvents,
      });
      // Keep the process alive until SIGINT
      await new Promise(() => {});
      return;
    }

    const data = await fetchDashboardData();

    if (options.json) {
      console.log(renderDashboardJson(data));
    } else if (options.verbose) {
      console.log(renderDashboardVerbose(data));
    } else {
      console.log(renderDashboardTable(data));
    }
  } catch (error: any) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}
