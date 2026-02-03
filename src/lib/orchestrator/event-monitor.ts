/**
 * Event monitor for Claude Code sessions
 *
 * Provides real-time monitoring of Claude Code sessions via polling,
 * emitting events for state changes, output, and silence detection.
 */

import { EventEmitter } from 'events';
import * as tmux from '../tmux.js';
import { ClaudeState, detectState, detectCompletion } from './state-detector.js';

export interface ClaudeEvent {
  type:
    | 'state_change'
    | 'output'
    | 'silence'
    | 'activity'
    | 'permission'
    | 'question'
    | 'error'
    | 'complete';
  state?: ClaudeState;
  output?: string;
  silenceMs?: number;
  timestamp: number;
}

export interface EventMonitorOptions {
  /** Polling interval in milliseconds (default: 500) */
  pollIntervalMs?: number;
  /** Number of lines to capture (default: 30) */
  captureLines?: number;
  /** Silence threshold for completion detection (default: 3000) */
  silenceThresholdMs?: number;
  /** Specific pane ID to monitor (default: first pane of first window) */
  paneId?: string;
}

export class EventMonitor extends EventEmitter {
  private sessionName: string;
  private paneId: string | null = null;
  private explicitPaneId: string | null = null;
  private options: Required<Omit<EventMonitorOptions, 'paneId'>>;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastOutput: string = '';
  private lastOutputTime: number = Date.now();
  private lastState: ClaudeState | null = null;
  private running: boolean = false;

  constructor(sessionName: string, options: EventMonitorOptions = {}) {
    super();
    this.sessionName = sessionName;
    this.explicitPaneId = options.paneId || null;
    this.options = {
      pollIntervalMs: options.pollIntervalMs ?? 500,
      captureLines: options.captureLines ?? 30,
      silenceThresholdMs: options.silenceThresholdMs ?? 3000,
    };
  }

  /**
   * Start monitoring the session
   */
  async start(): Promise<void> {
    if (this.running) return;

    // Use explicit pane ID if provided
    if (this.explicitPaneId) {
      this.paneId = this.explicitPaneId.startsWith('%')
        ? this.explicitPaneId
        : `%${this.explicitPaneId}`;
    } else {
      // Find session and get pane ID
      const session = await tmux.findSessionByName(this.sessionName);
      if (!session) {
        throw new Error(`Session "${this.sessionName}" not found`);
      }

      const windows = await tmux.listWindows(session.id);
      if (!windows || windows.length === 0) {
        throw new Error(`No windows found in session "${this.sessionName}"`);
      }

      const panes = await tmux.listPanes(windows[0].id);
      if (!panes || panes.length === 0) {
        throw new Error(`No panes found in session "${this.sessionName}"`);
      }

      this.paneId = panes[0].id;
    }

    this.running = true;
    this.lastOutputTime = Date.now();

    // Initial capture
    await this.poll();

    // Start polling
    // Use unref() so the timer doesn't prevent process exit
    this.pollTimer = setInterval(() => this.poll(), this.options.pollIntervalMs);
    this.pollTimer.unref();

    this.emit('started', { sessionName: this.sessionName, paneId: this.paneId });
  }

  /**
   * Stop monitoring
   */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.running = false;
    this.emit('stopped');
  }

  /**
   * Check if monitor is running
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get current state
   */
  getCurrentState(): ClaudeState | null {
    return this.lastState;
  }

  /**
   * Get time since last output change
   */
  getSilenceMs(): number {
    return Date.now() - this.lastOutputTime;
  }

  /**
   * Poll for changes
   */
  private async poll(): Promise<void> {
    if (!this.paneId || !this.running) return;

    try {
      const output = await tmux.capturePaneContent(
        this.paneId,
        this.options.captureLines
      );
      const now = Date.now();

      // Check for new output
      if (output !== this.lastOutput) {
        const newContent = this.getNewContent(this.lastOutput, output);

        if (newContent) {
          this.lastOutputTime = now;
          this.emitEvent({
            type: 'output',
            output: newContent,
            timestamp: now,
          });

          this.emitEvent({
            type: 'activity',
            timestamp: now,
          });
        }

        // Detect state from new output
        const newState = detectState(output);

        // Check for state changes
        if (this.lastState && newState.type !== this.lastState.type) {
          this.emitEvent({
            type: 'state_change',
            state: newState,
            timestamp: now,
          });

          // Emit specific events for important state changes
          if (newState.type === 'permission') {
            this.emitEvent({
              type: 'permission',
              state: newState,
              timestamp: now,
            });
          } else if (newState.type === 'question') {
            this.emitEvent({
              type: 'question',
              state: newState,
              timestamp: now,
            });
          } else if (newState.type === 'error') {
            this.emitEvent({
              type: 'error',
              state: newState,
              timestamp: now,
            });
          }

          // Check for completion
          const completion = detectCompletion(output, this.lastOutput);
          if (completion.complete && completion.confidence > 0.6) {
            this.emitEvent({
              type: 'complete',
              state: newState,
              timestamp: now,
            });
          }
        }

        this.lastState = newState;
        this.lastOutput = output;
      } else {
        // No change - check silence threshold
        const silenceMs = now - this.lastOutputTime;

        // Emit silence events at threshold intervals
        if (
          silenceMs >= this.options.silenceThresholdMs &&
          silenceMs % this.options.silenceThresholdMs < this.options.pollIntervalMs
        ) {
          this.emitEvent({
            type: 'silence',
            silenceMs,
            timestamp: now,
          });
        }
      }
    } catch (error) {
      // Emit error but continue polling
      this.emit('poll_error', error);
    }
  }

  /**
   * Get new content since last poll
   */
  private getNewContent(oldOutput: string, newOutput: string): string | null {
    if (oldOutput === newOutput) return null;

    // If old output is empty, return all new output
    if (!oldOutput) return newOutput;

    // Find where old output ends in new output
    const oldLines = oldOutput.split('\n');
    const newLines = newOutput.split('\n');

    // Simple approach: find the last line of old output in new output
    const lastOldLine = oldLines[oldLines.length - 1];
    const lastOldLineIndex = newLines.lastIndexOf(lastOldLine);

    if (lastOldLineIndex >= 0 && lastOldLineIndex < newLines.length - 1) {
      return newLines.slice(lastOldLineIndex + 1).join('\n');
    }

    // If we can't find exact match, return the diff
    // (this happens when lines scroll out of the capture buffer)
    const oldSet = new Set(oldLines);
    const newContent = newLines.filter((line) => !oldSet.has(line));

    return newContent.length > 0 ? newContent.join('\n') : null;
  }

  /**
   * Emit a Claude event
   */
  private emitEvent(event: ClaudeEvent): void {
    this.emit(event.type, event);
    this.emit('event', event);
  }
}

/**
 * Wait for a specific state or condition
 */
export async function waitForState(
  monitor: EventMonitor,
  predicate: (state: ClaudeState) => boolean,
  timeoutMs: number = 60000
): Promise<ClaudeState> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timeout waiting for state'));
    }, timeoutMs);

    const handler = (event: ClaudeEvent) => {
      if (event.state && predicate(event.state)) {
        cleanup();
        resolve(event.state);
      }
    };

    const cleanup = () => {
      clearTimeout(timeout);
      monitor.off('state_change', handler);
    };

    // Check current state first
    const current = monitor.getCurrentState();
    if (current && predicate(current)) {
      cleanup();
      resolve(current);
      return;
    }

    monitor.on('state_change', handler);
  });
}

/**
 * Wait for silence (no output) for a duration
 */
export async function waitForSilence(
  monitor: EventMonitor,
  silenceMs: number,
  timeoutMs: number = 120000
): Promise<void> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    let lastActivityTime = startTime;

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timeout waiting for silence'));
    }, timeoutMs);

    const activityHandler = () => {
      lastActivityTime = Date.now();
    };

    const checkSilence = setInterval(() => {
      const silenceDuration = Date.now() - lastActivityTime;
      if (silenceDuration >= silenceMs) {
        cleanup();
        resolve();
      }
    }, 100);

    const cleanup = () => {
      clearTimeout(timeout);
      clearInterval(checkSilence);
      monitor.off('activity', activityHandler);
    };

    monitor.on('activity', activityHandler);
  });
}

/**
 * Wait for completion (idle state after activity)
 */
export async function waitForCompletion(
  monitor: EventMonitor,
  options: {
    silenceMs?: number;
    timeoutMs?: number;
    requireIdle?: boolean;
  } = {}
): Promise<{ state: ClaudeState; reason: string }> {
  const { silenceMs = 3000, timeoutMs = 120000, requireIdle = true } = options;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timeout waiting for completion'));
    }, timeoutMs);

    let lastActivityTime = Date.now();
    let silenceCheckInterval: ReturnType<typeof setInterval> | null = null;

    const completeHandler = (event: ClaudeEvent) => {
      if (event.state) {
        cleanup();
        resolve({ state: event.state, reason: 'complete event' });
      }
    };

    const activityHandler = () => {
      lastActivityTime = Date.now();
    };

    const stateHandler = (event: ClaudeEvent) => {
      // If we get a permission or question, we're not complete
      if (event.state?.type === 'permission' || event.state?.type === 'question') {
        return;
      }

      // If idle and requireIdle, resolve
      if (requireIdle && event.state?.type === 'idle') {
        cleanup();
        resolve({ state: event.state, reason: 'idle state' });
      }

      // If error, resolve (task failed but is "complete")
      if (event.state?.type === 'error') {
        cleanup();
        resolve({ state: event.state, reason: 'error' });
      }
    };

    const cleanup = () => {
      clearTimeout(timeout);
      if (silenceCheckInterval) clearInterval(silenceCheckInterval);
      monitor.off('complete', completeHandler);
      monitor.off('activity', activityHandler);
      monitor.off('state_change', stateHandler);
    };

    // Check silence periodically
    silenceCheckInterval = setInterval(() => {
      const silenceDuration = Date.now() - lastActivityTime;
      const currentState = monitor.getCurrentState();

      if (silenceDuration >= silenceMs) {
        // Check if current state indicates completion
        if (
          currentState &&
          (currentState.type === 'idle' ||
            currentState.type === 'complete' ||
            currentState.type === 'error')
        ) {
          cleanup();
          resolve({
            state: currentState,
            reason: `silence (${silenceDuration}ms)`,
          });
        } else if (!requireIdle) {
          cleanup();
          resolve({
            state: currentState || { type: 'unknown', timestamp: Date.now(), rawOutput: '', confidence: 0 },
            reason: `silence (${silenceDuration}ms) - non-idle`,
          });
        }
      }
    }, 500);

    monitor.on('complete', completeHandler);
    monitor.on('activity', activityHandler);
    monitor.on('state_change', stateHandler);
  });
}
