/**
 * Completion detection methods for Claude Code sessions
 *
 * Provides multiple strategies for detecting when Claude Code
 * has finished a task, with metrics for evaluating effectiveness.
 */

import { EventMonitor, waitForSilence, waitForCompletion } from './event-monitor.js';
import { ClaudeState, detectState } from './state-detector.js';
import * as tmux from '../tmux.js';

export interface CompletionResult {
  complete: boolean;
  state?: ClaudeState;
  reason: string;
  latencyMs: number;
  method: string;
}

export interface CompletionMethodMetrics {
  name: string;
  totalRuns: number;
  avgLatencyMs: number;
  minLatencyMs: number;
  maxLatencyMs: number;
  falsePositives: number;
  falseNegatives: number;
  successRate: number;
}

export interface CompletionMethod {
  name: string;
  description: string;
  detect(monitor: EventMonitor, timeoutMs?: number): Promise<CompletionResult>;
  metrics: CompletionMethodMetrics;
  recordResult(latencyMs: number, correct: boolean, falsePositive: boolean): void;
}

/**
 * Create a completion method based on silence timeout
 */
export function silenceTimeoutMethod(silenceMs: number): CompletionMethod {
  const metrics: CompletionMethodMetrics = {
    name: `silence-${silenceMs}ms`,
    totalRuns: 0,
    avgLatencyMs: 0,
    minLatencyMs: Infinity,
    maxLatencyMs: 0,
    falsePositives: 0,
    falseNegatives: 0,
    successRate: 1,
  };

  return {
    name: `silence-${silenceMs}ms`,
    description: `Detect completion when no output for ${silenceMs}ms`,
    metrics,

    async detect(monitor: EventMonitor, timeoutMs = 120000): Promise<CompletionResult> {
      const startTime = Date.now();

      try {
        await waitForSilence(monitor, silenceMs, timeoutMs);
        const latencyMs = Date.now() - startTime;
        const state = monitor.getCurrentState();

        return {
          complete: true,
          state: state || undefined,
          reason: `silence for ${silenceMs}ms`,
          latencyMs,
          method: this.name,
        };
      } catch (error) {
        return {
          complete: false,
          reason: error instanceof Error ? error.message : 'unknown error',
          latencyMs: Date.now() - startTime,
          method: this.name,
        };
      }
    },

    recordResult(latencyMs: number, correct: boolean, falsePositive: boolean): void {
      metrics.totalRuns++;
      metrics.avgLatencyMs =
        (metrics.avgLatencyMs * (metrics.totalRuns - 1) + latencyMs) / metrics.totalRuns;
      metrics.minLatencyMs = Math.min(metrics.minLatencyMs, latencyMs);
      metrics.maxLatencyMs = Math.max(metrics.maxLatencyMs, latencyMs);

      if (!correct) {
        if (falsePositive) {
          metrics.falsePositives++;
        } else {
          metrics.falseNegatives++;
        }
      }

      metrics.successRate =
        (metrics.totalRuns - metrics.falsePositives - metrics.falseNegatives) /
        metrics.totalRuns;
    },
  };
}

/**
 * Create a completion method based on state detection (idle state)
 */
export function stateDetectionMethod(): CompletionMethod {
  const metrics: CompletionMethodMetrics = {
    name: 'state-detection',
    totalRuns: 0,
    avgLatencyMs: 0,
    minLatencyMs: Infinity,
    maxLatencyMs: 0,
    falsePositives: 0,
    falseNegatives: 0,
    successRate: 1,
  };

  return {
    name: 'state-detection',
    description: 'Detect completion when idle state is detected',
    metrics,

    async detect(monitor: EventMonitor, timeoutMs = 120000): Promise<CompletionResult> {
      const startTime = Date.now();

      try {
        const result = await waitForCompletion(monitor, {
          timeoutMs,
          requireIdle: true,
          silenceMs: 2000,
        });

        const latencyMs = Date.now() - startTime;

        return {
          complete: true,
          state: result.state,
          reason: result.reason,
          latencyMs,
          method: this.name,
        };
      } catch (error) {
        return {
          complete: false,
          reason: error instanceof Error ? error.message : 'unknown error',
          latencyMs: Date.now() - startTime,
          method: this.name,
        };
      }
    },

    recordResult(latencyMs: number, correct: boolean, falsePositive: boolean): void {
      metrics.totalRuns++;
      metrics.avgLatencyMs =
        (metrics.avgLatencyMs * (metrics.totalRuns - 1) + latencyMs) / metrics.totalRuns;
      metrics.minLatencyMs = Math.min(metrics.minLatencyMs, latencyMs);
      metrics.maxLatencyMs = Math.max(metrics.maxLatencyMs, latencyMs);

      if (!correct) {
        if (falsePositive) {
          metrics.falsePositives++;
        } else {
          metrics.falseNegatives++;
        }
      }

      metrics.successRate =
        (metrics.totalRuns - metrics.falsePositives - metrics.falseNegatives) /
        metrics.totalRuns;
    },
  };
}

/**
 * Create a completion method using tmux wait-for channel
 */
export function waitForChannelMethod(channel: string): CompletionMethod {
  const metrics: CompletionMethodMetrics = {
    name: `wait-for-${channel}`,
    totalRuns: 0,
    avgLatencyMs: 0,
    minLatencyMs: Infinity,
    maxLatencyMs: 0,
    falsePositives: 0,
    falseNegatives: 0,
    successRate: 1,
  };

  return {
    name: `wait-for-${channel}`,
    description: `Wait for tmux wait-for signal on channel "${channel}"`,
    metrics,

    async detect(_monitor: EventMonitor, timeoutMs = 120000): Promise<CompletionResult> {
      const startTime = Date.now();

      try {
        await Promise.race([
          tmux.executeTmux(`wait-for ${channel}`),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Timeout')), timeoutMs)
          ),
        ]);

        const latencyMs = Date.now() - startTime;

        return {
          complete: true,
          reason: `signal received on channel "${channel}"`,
          latencyMs,
          method: this.name,
        };
      } catch (error) {
        return {
          complete: false,
          reason: error instanceof Error ? error.message : 'unknown error',
          latencyMs: Date.now() - startTime,
          method: this.name,
        };
      }
    },

    recordResult(latencyMs: number, correct: boolean, falsePositive: boolean): void {
      metrics.totalRuns++;
      metrics.avgLatencyMs =
        (metrics.avgLatencyMs * (metrics.totalRuns - 1) + latencyMs) / metrics.totalRuns;
      metrics.minLatencyMs = Math.min(metrics.minLatencyMs, latencyMs);
      metrics.maxLatencyMs = Math.max(metrics.maxLatencyMs, latencyMs);

      if (!correct) {
        if (falsePositive) {
          metrics.falsePositives++;
        } else {
          metrics.falseNegatives++;
        }
      }

      metrics.successRate =
        (metrics.totalRuns - metrics.falsePositives - metrics.falseNegatives) /
        metrics.totalRuns;
    },
  };
}

/**
 * Create a hybrid completion method that uses multiple strategies
 */
export function hybridMethod(
  primaryMethod: CompletionMethod,
  fallbackMethod: CompletionMethod,
  options: {
    primaryTimeoutMs?: number;
    fallbackTimeoutMs?: number;
  } = {}
): CompletionMethod {
  const { primaryTimeoutMs = 30000, fallbackTimeoutMs = 90000 } = options;

  const metrics: CompletionMethodMetrics = {
    name: `hybrid(${primaryMethod.name},${fallbackMethod.name})`,
    totalRuns: 0,
    avgLatencyMs: 0,
    minLatencyMs: Infinity,
    maxLatencyMs: 0,
    falsePositives: 0,
    falseNegatives: 0,
    successRate: 1,
  };

  return {
    name: metrics.name,
    description: `Try ${primaryMethod.name} first, fall back to ${fallbackMethod.name}`,
    metrics,

    async detect(monitor: EventMonitor, timeoutMs = 120000): Promise<CompletionResult> {
      const startTime = Date.now();

      // Try primary method first
      const primaryResult = await primaryMethod.detect(
        monitor,
        Math.min(primaryTimeoutMs, timeoutMs)
      );

      if (primaryResult.complete) {
        return {
          ...primaryResult,
          method: this.name,
          reason: `primary(${primaryResult.reason})`,
        };
      }

      // Fall back to secondary method
      const remainingTime = timeoutMs - (Date.now() - startTime);
      if (remainingTime <= 0) {
        return {
          complete: false,
          reason: 'timeout after primary method',
          latencyMs: Date.now() - startTime,
          method: this.name,
        };
      }

      const fallbackResult = await fallbackMethod.detect(
        monitor,
        Math.min(fallbackTimeoutMs, remainingTime)
      );

      return {
        ...fallbackResult,
        method: this.name,
        reason: `fallback(${fallbackResult.reason})`,
        latencyMs: Date.now() - startTime,
      };
    },

    recordResult(latencyMs: number, correct: boolean, falsePositive: boolean): void {
      metrics.totalRuns++;
      metrics.avgLatencyMs =
        (metrics.avgLatencyMs * (metrics.totalRuns - 1) + latencyMs) / metrics.totalRuns;
      metrics.minLatencyMs = Math.min(metrics.minLatencyMs, latencyMs);
      metrics.maxLatencyMs = Math.max(metrics.maxLatencyMs, latencyMs);

      if (!correct) {
        if (falsePositive) {
          metrics.falsePositives++;
        } else {
          metrics.falseNegatives++;
        }
      }

      metrics.successRate =
        (metrics.totalRuns - metrics.falsePositives - metrics.falseNegatives) /
        metrics.totalRuns;
    },
  };
}

/**
 * Get the default completion method (hybrid of state detection + silence)
 */
export function getDefaultMethod(): CompletionMethod {
  return hybridMethod(stateDetectionMethod(), silenceTimeoutMethod(5000), {
    primaryTimeoutMs: 30000,
    fallbackTimeoutMs: 90000,
  });
}

/**
 * Available preset methods
 */
export const presetMethods = {
  'silence-3s': () => silenceTimeoutMethod(3000),
  'silence-5s': () => silenceTimeoutMethod(5000),
  'silence-10s': () => silenceTimeoutMethod(10000),
  'state-detection': () => stateDetectionMethod(),
  hybrid: () => getDefaultMethod(),
  'aggressive-hybrid': () =>
    hybridMethod(stateDetectionMethod(), silenceTimeoutMethod(2000), {
      primaryTimeoutMs: 10000,
      fallbackTimeoutMs: 30000,
    }),
  'conservative-hybrid': () =>
    hybridMethod(stateDetectionMethod(), silenceTimeoutMethod(10000), {
      primaryTimeoutMs: 60000,
      fallbackTimeoutMs: 120000,
    }),
} as const;

export type PresetMethodName = keyof typeof presetMethods;

/**
 * Get a completion method by name
 */
export function getMethod(name: string): CompletionMethod {
  if (name in presetMethods) {
    return presetMethods[name as PresetMethodName]();
  }

  // Parse custom silence timeout: "silence-Xms" or "silence-Xs"
  const silenceMatch = name.match(/^silence-(\d+)(ms|s)?$/);
  if (silenceMatch) {
    const value = parseInt(silenceMatch[1], 10);
    const unit = silenceMatch[2] || 'ms';
    const ms = unit === 's' ? value * 1000 : value;
    return silenceTimeoutMethod(ms);
  }

  // Default to hybrid
  return getDefaultMethod();
}
