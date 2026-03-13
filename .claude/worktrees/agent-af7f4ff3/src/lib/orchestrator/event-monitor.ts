/**
 * Event monitor for Claude Code sessions
 *
 * Provides real-time monitoring of Claude Code sessions via polling,
 * emitting events for state changes, output, and silence detection.
 */

import { EventEmitter } from 'node:events';
import * as tmux from '../tmux.js';
import { type ClaudeState, detectCompletion, detectState } from './state-detector.js';

interface ClaudeEvent {
  type: 'state_change' | 'output' | 'silence' | 'activity' | 'permission' | 'question' | 'error' | 'complete';
  state?: ClaudeState;
  output?: string;
  silenceMs?: number;
  timestamp: number;
}

interface EventMonitorOptions {
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
  private lastOutput = '';
  private lastOutputTime: number = Date.now();
  private lastState: ClaudeState | null = null;
  private running = false;

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
      this.paneId = this.explicitPaneId.startsWith('%') ? this.explicitPaneId : `%${this.explicitPaneId}`;
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

      const activeWindow = windows.find((w) => w.active) || windows[0];

      const panes = await tmux.listPanes(activeWindow.id);
      if (!panes || panes.length === 0) {
        throw new Error(`No panes found in session "${this.sessionName}"`);
      }

      const activePane = panes.find((p) => p.active) || panes[0];
      this.paneId = activePane.id;
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
  private emitStateChangeEvents(newState: ClaudeState, now: number): void {
    this.emitEvent({ type: 'state_change', state: newState, timestamp: now });

    const eventType = ({ permission: 'permission', question: 'question', error: 'error' } as const)[
      newState.type as string
    ];
    if (eventType) {
      this.emitEvent({ type: eventType, state: newState, timestamp: now });
    }
  }

  private handleNewOutput(output: string, now: number): void {
    const newContent = this.getNewContent(this.lastOutput, output);
    if (newContent) {
      this.lastOutputTime = now;
      this.emitEvent({ type: 'output', output: newContent, timestamp: now });
      this.emitEvent({ type: 'activity', timestamp: now });
    }

    const newState = detectState(output);

    if (this.lastState && newState.type !== this.lastState.type) {
      this.emitStateChangeEvents(newState, now);

      const completion = detectCompletion(output, this.lastOutput);
      if (completion.complete && completion.confidence > 0.6) {
        this.emitEvent({ type: 'complete', state: newState, timestamp: now });
      }
    }

    this.lastState = newState;
    this.lastOutput = output;
  }

  private checkSilence(now: number): void {
    const silenceMs = now - this.lastOutputTime;
    if (
      silenceMs >= this.options.silenceThresholdMs &&
      silenceMs % this.options.silenceThresholdMs < this.options.pollIntervalMs
    ) {
      this.emitEvent({ type: 'silence', silenceMs, timestamp: now });
    }
  }

  private async poll(): Promise<void> {
    if (!this.paneId || !this.running) return;

    try {
      const output = await tmux.capturePaneContent(this.paneId, this.options.captureLines);
      const now = Date.now();

      if (output !== this.lastOutput) {
        this.handleNewOutput(output, now);
      } else {
        this.checkSilence(now);
      }
    } catch (error) {
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
