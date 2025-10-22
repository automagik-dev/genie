/**
 * Token Usage Tracker
 *
 * Aggregates token usage metrics from execution process logs
 * Parses JSONL events to extract input/output/total tokens
 */

// @ts-ignore - compiled client shipped at project root
import { ForgeClient } from '../../../../forge.js';
import WebSocket from 'ws';

export interface TokenMetrics {
  input: number;
  output: number;
  cached: number;
  total: number;
  costUsd: number;
  processCount: number;
}

export interface ExecutorBreakdown {
  [executor: string]: TokenMetrics;
}

/**
 * Parse token events from JSONL logs
 */
function parseTokensFromLogs(logs: string): TokenMetrics {
  const metrics: TokenMetrics = {
    input: 0,
    output: 0,
    cached: 0,
    total: 0,
    costUsd: 0,
    processCount: 0
  };

  if (!logs || typeof logs !== 'string') {
    return metrics;
  }

  const lines = logs.split('\n').filter(line => line.trim());

  for (const line of lines) {
    try {
      const event = JSON.parse(line);

      // Handle different event formats
      const envelope = event && typeof event === 'object' ? event : {};
      const actualEvent = envelope.payload || envelope;
      const payload = actualEvent.msg || actualEvent;
      const type = payload?.type || event?.type;

      // stream_event with message_start (Claude Code executor via WebSocket)
      if (type === 'stream_event' && event.event?.type === 'message_start') {
        const usage = event.event.message?.usage;
        if (usage) {
          metrics.input += usage.input_tokens || 0;
          metrics.output += usage.output_tokens || 0;
          metrics.cached += (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
        }
      }

      // Result events (Claude executor)
      if (type === 'result' && event.success !== false) {
        if (event.tokens) {
          metrics.input += event.tokens.input || 0;
          metrics.output += event.tokens.output || 0;
        }
        if (event.cost_usd) {
          metrics.costUsd += event.cost_usd;
        }
        if (event.usage) {
          metrics.input += event.usage.input_tokens || 0;
          metrics.output += event.usage.output_tokens || 0;
        }
      }

      // token_count events (Codex executor)
      if (type === 'token_count') {
        const info = envelope.info || payload.info;
        if (info?.total_token_usage) {
          metrics.input += info.total_token_usage.input_tokens || 0;
          metrics.output += info.total_token_usage.output_tokens || 0;
          metrics.cached += info.total_token_usage.cached_input_tokens || 0;
        }
      }

      // token.usage events
      if (type === 'token.usage') {
        metrics.input += payload.input_tokens || 0;
        metrics.output += payload.output_tokens || 0;
        metrics.total += payload.total_tokens || 0;
      }

      // response.usage events
      if (type === 'response.usage') {
        const usage = envelope.usage || payload.usage || payload;
        if (usage) {
          metrics.input += usage.input_tokens || usage.prompt_tokens || 0;
          metrics.output += usage.output_tokens || usage.completion_tokens || 0;
          metrics.cached += usage.cached_input_tokens || 0;
        }
      }
    } catch {
      // Skip invalid JSON lines
      continue;
    }
  }

  // Calculate total if not explicitly set
  if (metrics.total === 0) {
    metrics.total = metrics.input + metrics.output;
  }

  metrics.processCount = 1;
  return metrics;
}

/**
 * Fetch logs from execution process via WebSocket
 * Uses Forge's raw-logs WebSocket endpoint which reads from database
 * Extracts STDOUT content from JsonPatch operations and parses JSONL events
 */
async function fetchLogsViaWebSocket(
  baseUrl: string,
  processId: string,
  timeoutMs: number = 2000
): Promise<string> {
  return new Promise((resolve) => {
    const wsUrl = baseUrl.replace(/^http/, 'ws') + `/api/execution-processes/${processId}/raw-logs/ws`;
    let logs = '';
    let ws: WebSocket | null = null;
    let resolved = false;

    const cleanup = () => {
      if (ws && ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
        ws.terminate(); // Force close
      }
    };

    const safeResolve = (result: string) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(result);
    };

    const timeout = setTimeout(() => {
      safeResolve(logs); // Return whatever we collected
    }, timeoutMs);

    try {
      ws = new WebSocket(wsUrl);

      ws.on('open', () => {
        // Connection opened - reset timeout for data collection
      });

      ws.on('message', (data: WebSocket.Data) => {
        try {
          const msg = JSON.parse(data.toString());

          // Finished signal indicates end of stream
          if (msg.type === 'finished') {
            clearTimeout(timeout);
            safeResolve(logs);
            return;
          }

          // Extract STDOUT content from JsonPatch operations
          if (msg.JsonPatch && Array.isArray(msg.JsonPatch)) {
            for (const patch of msg.JsonPatch) {
              if (patch.value?.type === 'STDOUT' && patch.value?.content) {
                // STDOUT content contains newline-delimited JSON events
                logs += patch.value.content;
              }
            }
          }
        } catch {
          // Skip invalid messages
        }
      });

      ws.on('error', () => {
        clearTimeout(timeout);
        safeResolve(logs); // Return whatever we collected before error
      });

      ws.on('close', () => {
        clearTimeout(timeout);
        safeResolve(logs);
      });
    } catch {
      clearTimeout(timeout);
      safeResolve(''); // Connection failed
    }
  });
}

/**
 * Collect token metrics for a single task attempt
 */
export async function collectTokensForAttempt(
  client: any,
  attemptId: string
): Promise<TokenMetrics> {
  const aggregated: TokenMetrics = {
    input: 0,
    output: 0,
    cached: 0,
    total: 0,
    costUsd: 0,
    processCount: 0
  };

  try {
    const processes = await client.listExecutionProcesses(attemptId, false);

    if (!processes || processes.length === 0) {
      return aggregated;
    }

    const baseUrl = client.baseUrl || 'http://localhost:8887';

    for (const process of processes) {
      try {
        // Fetch logs via WebSocket (reads from database for completed processes)
        const logs = await fetchLogsViaWebSocket(baseUrl, process.id);

        if (logs) {
          const processMetrics = parseTokensFromLogs(logs);
          aggregated.input += processMetrics.input;
          aggregated.output += processMetrics.output;
          aggregated.cached += processMetrics.cached;
          aggregated.total += processMetrics.total;
          aggregated.costUsd += processMetrics.costUsd;
          aggregated.processCount++;
        }
      } catch {
        // Skip process if we can't fetch its logs
        continue;
      }
    }
  } catch {
    // Failed to fetch processes
  }

  return aggregated;
}

/**
 * Collect token metrics across all task attempts
 */
export async function collectAllTokenMetrics(
  baseUrl: string = 'http://localhost:8887'
): Promise<TokenMetrics> {
  const aggregated: TokenMetrics = {
    input: 0,
    output: 0,
    cached: 0,
    total: 0,
    costUsd: 0,
    processCount: 0
  };

  try {
    const client = new ForgeClient(baseUrl, process.env.FORGE_TOKEN);

    // Get all task attempts
    const attempts = await client.listTaskAttempts();

    if (!attempts || attempts.length === 0) {
      return aggregated;
    }

    // Limit to recent attempts for performance
    const recentAttempts = attempts.slice(0, 5);

    for (const attempt of recentAttempts) {
      const attemptMetrics = await collectTokensForAttempt(client, attempt.id);
      aggregated.input += attemptMetrics.input;
      aggregated.output += attemptMetrics.output;
      aggregated.cached += attemptMetrics.cached;
      aggregated.total += attemptMetrics.total;
      aggregated.costUsd += attemptMetrics.costUsd;
      aggregated.processCount += attemptMetrics.processCount;
    }
  } catch {
    // Failed to collect metrics
  }

  return aggregated;
}

/**
 * Format token metrics for display
 */
export function formatTokenMetrics(metrics: TokenMetrics, compact: boolean = false): string {
  if (metrics.total === 0) {
    return compact ? 'No usage yet' : '   No token usage yet';
  }

  const indent = compact ? '' : '   ';
  const lines: string[] = [];

  if (compact) {
    // Compact format for real-time dashboard
    lines.push(`${(metrics.total / 1000).toFixed(1)}k tokens`);
    if (metrics.costUsd > 0) {
      lines.push(`($${metrics.costUsd.toFixed(3)})`);
    }
  } else {
    // Detailed format for goodbye report
    lines.push(`${indent}Input:   ${metrics.input.toLocaleString()} tokens`);
    lines.push(`${indent}Output:  ${metrics.output.toLocaleString()} tokens`);
    if (metrics.cached > 0) {
      lines.push(`${indent}Cached:  ${metrics.cached.toLocaleString()} tokens`);
    }
    lines.push(`${indent}Total:   ${metrics.total.toLocaleString()} tokens`);
    if (metrics.costUsd > 0) {
      lines.push(`${indent}Cost:    $${metrics.costUsd.toFixed(4)} USD`);
    }
  }

  return lines.join(compact ? ' ' : '\n');
}
