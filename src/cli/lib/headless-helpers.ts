/**
 * Headless Execution Helpers
 *
 * Utilities for running agents in headless mode (JSON/raw output)
 */

import { getForgeConfig, getMcpConfig } from './service-config.js';
import { isForgeRunning, startForgeInBackground, waitForForgeReady } from './forge-manager';
import { ForgeExecutor } from './forge-executor';
import path from 'path';

export interface RunResult {
  agent: string;
  status: 'completed' | 'failed' | 'timeout';
  output: string;
  error?: string;
  duration_ms: number;
  executor: string;
  model?: string;
  task_id: string;
  attempt_id: string;
  forge_url: string;
  timestamp: string;
}

/**
 * Ensure Forge is running, start if needed
 * Silent or with minimal output based on quiet flag
 */
export async function ensureForgeRunning(quiet: boolean = false): Promise<void> {
  const baseUrl = process.env.FORGE_BASE_URL || getForgeConfig().baseUrl;
  const logDir = path.join(process.cwd(), '.genie', 'state');

  const running = await isForgeRunning(baseUrl);
  if (running) return;

  // Start Forge
  if (!quiet) {
    process.stderr.write('Starting Forge... ');
  }

  const startTime = Date.now();
  const result = startForgeInBackground({ baseUrl, logDir });

  if (!result.ok) {
    const error = 'error' in result ? result.error : new Error('Unknown error');
    throw new Error(`Failed to start Forge: ${error.message}`);
  }

  const ready = await waitForForgeReady(baseUrl, 60000, 500, false);
  if (!ready) {
    throw new Error('Forge did not start in time (60s)');
  }

  if (!quiet) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    process.stderr.write(`ready (${elapsed}s)\n\n`);
  }
}

/**
 * Wait for task completion by polling Forge API
 */
export async function waitForTaskCompletion(
  attemptId: string,
  executor: ForgeExecutor,
  maxWaitMs: number = 300000 // 5 minutes default
): Promise<{ status: 'completed' | 'failed' | 'timeout'; output: string; error?: string }> {
  const pollInterval = 1000; // 1s
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    try {
      const status = await executor.getSessionStatus(attemptId);

      if (status.status === 'completed' || status.status === 'success') {
        // Task completed successfully
        const logs = await executor.fetchLatestLogs(attemptId);
        const output = extractFinalOutput(logs);
        return { status: 'completed', output };
      }

      if (status.status === 'failed' || status.status === 'error') {
        // Task failed
        const logs = await executor.fetchLatestLogs(attemptId);
        const output = extractFinalOutput(logs);
        return {
          status: 'failed',
          output,
          error: 'Task execution failed'
        };
      }

      // Still running or pending, wait and retry
      await sleep(pollInterval);
    } catch (error) {
      // If we can't fetch status, wait and retry
      await sleep(pollInterval);
    }
  }

  // Timeout
  return {
    status: 'timeout',
    output: '',
    error: 'Task did not complete within timeout'
  };
}

/**
 * Extract final output from executor logs
 * Attempts to find the agent's final answer/response
 */
export function extractFinalOutput(logs: string | null): string {
  if (!logs) return '(no output)';

  // Try to extract meaningful output
  // This is a simple heuristic - can be improved based on executor output format

  const lines = logs.trim().split('\n').filter(l => l.trim());

  // Look for common patterns indicating final output
  // - Last assistant message
  // - Output after completion markers
  // - Last non-empty line

  if (lines.length === 0) return '(no output)';

  // Return last non-empty line as fallback
  return lines[lines.length - 1] || '(no output)';
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
