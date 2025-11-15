/**
 * Task Monitor - WebSocket-based task completion monitoring
 *
 * Provides event-driven task monitoring using Forge's normalized-logs WebSocket endpoint.
 * Replaces polling-based approach with real-time status updates.
 */

import WebSocket from 'ws';
// @ts-ignore - legacy JS Forge client does not ship TypeScript typings
import { ForgeClient } from '../../../src/lib/forge-client.js';

export interface TaskMonitorOptions {
  attemptId: string;
  baseUrl: string;
  onLog?: (log: string) => void;
  onStatus?: (status: string) => void;
  timeout?: number;
  token?: string;
  taskUrl?: string;
}

export interface TaskResult {
  status: 'completed' | 'failed' | 'timeout';
  output: string;
  error?: string;
  duration_ms: number;
  task_url: string;
}

/**
 * Monitor task completion using WebSocket connection
 *
 * Connects to Forge's normalized-logs WebSocket endpoint and listens for
 * task completion events. More efficient than polling.
 *
 * @param options Task monitoring configuration
 * @returns Promise resolving to task result
 */
export async function monitorTaskCompletion(
  options: TaskMonitorOptions
): Promise<TaskResult> {
  const {
    attemptId,
    baseUrl,
    onLog,
    onStatus,
    timeout = 300000,
    token,
    taskUrl: providedTaskUrl
  } = options;

  const startTime = Date.now();
  const authToken = token ?? process.env.FORGE_TOKEN;
  const client = new ForgeClient(baseUrl, authToken);
  const attemptMeta = await getTaskAttemptSafe(client, attemptId);
  const taskUrl = providedTaskUrl || deriveTaskUrl(baseUrl, attemptMeta, attemptId);
  const processId = await waitForLatestProcessId(client, attemptId);

  if (!processId) {
    return {
      status: 'failed',
      output: '',
      error: 'No execution process found for task attempt (executor did not start in time)',
      duration_ms: Date.now() - startTime,
      task_url: taskUrl
    };
  }

  const wsUrl = client.getNormalizedLogsStreamUrl(processId);

  return new Promise((resolve, reject) => {
    let ws: WebSocket | null = null;
    let timeoutId: NodeJS.Timeout | null = null;
    let outputBuffer: string[] = [];
    let lastStatus = 'running';
    let settled = false;

    // Cleanup function
    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = null;
      if (ws) {
        ws.removeAllListeners();
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
      }
    };

    const resolveOnce = (result: TaskResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    // Timeout handler
    timeoutId = setTimeout(() => {
      resolveOnce({
        status: 'timeout',
        output: outputBuffer.join('\n'),
        error: 'Task did not complete within timeout',
        duration_ms: Date.now() - startTime,
        task_url: taskUrl
      });
    }, timeout);

    // Create WebSocket connection
    try {
      ws = new WebSocket(wsUrl, {
        headers: {
          'User-Agent': 'Genie-TaskMonitor/1.0',
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {})
        }
      });
    } catch (error) {
      cleanup();
      reject(new Error(`Failed to create WebSocket: ${error}`));
      return;
    }

    // Connection opened
    ws.on('open', () => {
      // Connection established, waiting for messages
    });

    // Message received
    ws.on('message', (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());

        // Handle different message types
        if (message.type === 'log' && message.content) {
          const logLine = message.content;
          outputBuffer.push(logLine);
          if (onLog) onLog(logLine);
        }

        if (message.type === 'status' && message.status) {
          lastStatus = message.status;
          if (onStatus) onStatus(message.status);

          // Check for completion
          if (message.status === 'completed' || message.status === 'success') {
            resolveOnce({
              status: 'completed',
              output: outputBuffer.join('\n') || '(no output)',
              duration_ms: Date.now() - startTime,
              task_url: taskUrl
            });
          } else if (message.status === 'failed' || message.status === 'error') {
            resolveOnce({
              status: 'failed',
              output: outputBuffer.join('\n') || '(no output)',
              error: message.error || 'Task execution failed',
              duration_ms: Date.now() - startTime,
              task_url: taskUrl
            });
          }
        }

        // Handle raw log messages (fallback)
        if (typeof message === 'string') {
          outputBuffer.push(message);
          if (onLog) onLog(message);
        }
      } catch (error) {
        // If parsing fails, treat as plain text
        const textMessage = data.toString();
        outputBuffer.push(textMessage);
        if (onLog) onLog(textMessage);
      }
    });

    // Error handler
    ws.on('error', (error: Error) => {
      resolveOnce({
        status: 'failed',
        output: outputBuffer.join('\n'),
        error: `WebSocket error: ${error.message}`,
        duration_ms: Date.now() - startTime,
        task_url: taskUrl
      });
    });

    // Connection closed
    ws.on('close', (code: number, reason: Buffer) => {
      const closedStatus = lastStatus === 'completed' || lastStatus === 'success'
        ? 'completed'
        : lastStatus === 'failed' || lastStatus === 'error'
        ? 'failed'
        : 'failed';

      const errorMessage =
        closedStatus === 'failed' && (!lastStatus || lastStatus === 'running')
          ? `Connection closed (code ${code}) before receiving final status${reason?.length ? `: ${reason.toString()}` : ''}`
          : undefined;

      resolveOnce({
        status: closedStatus as 'completed' | 'failed',
        output: outputBuffer.join('\n') || '(no output)',
        error: errorMessage,
        duration_ms: Date.now() - startTime,
        task_url: taskUrl
      });
    });
  });
}

async function getTaskAttemptSafe(client: ForgeClient, attemptId: string): Promise<any | null> {
  try {
    return await client.getTaskAttempt(attemptId);
  } catch {
    return null;
  }
}

function deriveTaskUrl(baseUrl: string, attempt: any | null, attemptId: string): string {
  if (attempt) {
    const projectId = attempt.project_id || attempt.projectId;
    const taskId = attempt.task_id || attempt.taskId;
    if (projectId && taskId) {
      const cleanBase = baseUrl.replace(/\/$/, '');
      return `${cleanBase}/projects/${projectId}/tasks/${taskId}/attempts/${attemptId}?view=diffs`;
    }
  }
  return `${baseUrl.replace(/\/$/, '')}/tasks/${attemptId}`;
}

async function waitForLatestProcessId(
  client: ForgeClient,
  attemptId: string,
  timeoutMs = 45000,
  pollIntervalMs = 1000
): Promise<string | null> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const processes = await client.listExecutionProcesses(attemptId);
      if (Array.isArray(processes) && processes.length > 0) {
        const latest = processes[processes.length - 1];
        if (latest?.id) {
          return latest.id;
        }
      }
    } catch {
      // Ignore temporary errors – Forge may still be booting the executor
    }
    await sleep(pollIntervalMs);
  }

  return null;
}

function sleep(durationMs: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, durationMs));
}
