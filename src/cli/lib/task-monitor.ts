/**
 * Task Monitor - WebSocket-based task completion monitoring
 *
 * Provides event-driven task monitoring using Forge's normalized-logs WebSocket endpoint.
 * Replaces polling-based approach with real-time status updates.
 */

import WebSocket from 'ws';
import { ForgeClient } from '../../../src/lib/forge-client.js';

export interface TaskMonitorOptions {
  attemptId: string;
  baseUrl: string;
  onLog?: (log: string) => void;
  onStatus?: (status: string) => void;
  timeout?: number;
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
    timeout = 300000
  } = options;

  const startTime = Date.now();
  const taskUrl = `${baseUrl}/tasks/${attemptId}`;

  const client = new ForgeClient(baseUrl, process.env.FORGE_TOKEN);
  
  let processId: string;
  try {
    const processes = await client.listExecutionProcesses(attemptId);
    if (!processes || processes.length === 0) {
      return {
        status: 'failed',
        output: '',
        error: 'No execution process found for task attempt',
        duration_ms: Date.now() - startTime,
        task_url: taskUrl
      };
    }
    processId = processes[processes.length - 1].id;
  } catch (error) {
    return {
      status: 'failed',
      output: '',
      error: `Failed to fetch execution process: ${error}`,
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

    // Cleanup function
    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      if (ws) {
        ws.removeAllListeners();
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
      }
    };

    // Timeout handler
    timeoutId = setTimeout(() => {
      cleanup();
      resolve({
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
          'User-Agent': 'Genie-TaskMonitor/1.0'
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
            cleanup();
            resolve({
              status: 'completed',
              output: outputBuffer.join('\n') || '(no output)',
              duration_ms: Date.now() - startTime,
              task_url: taskUrl
            });
          } else if (message.status === 'failed' || message.status === 'error') {
            cleanup();
            resolve({
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
      cleanup();
      resolve({
        status: 'failed',
        output: outputBuffer.join('\n'),
        error: `WebSocket error: ${error.message}`,
        duration_ms: Date.now() - startTime,
        task_url: taskUrl
      });
    });

    // Connection closed
    ws.on('close', (code: number, reason: Buffer) => {
      cleanup();

      // If we haven't resolved yet, treat close as completion
      if (timeoutId) {
        const finalStatus = lastStatus === 'completed' || lastStatus === 'success'
          ? 'completed'
          : lastStatus === 'failed' || lastStatus === 'error'
          ? 'failed'
          : 'completed'; // Default to completed if connection closed gracefully

        resolve({
          status: finalStatus as 'completed' | 'failed',
          output: outputBuffer.join('\n') || '(no output)',
          duration_ms: Date.now() - startTime,
          task_url: taskUrl
        });
      }
    });
  });
}
