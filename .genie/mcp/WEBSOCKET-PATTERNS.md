# WebSocket Tool Patterns from fast-mcp Package

## Executive Summary

The fast-mcp package (v3.18.0) provides comprehensive support for building real-time, streaming-enabled MCP tools. WebSocket integration is achieved through direct use of the `ws` library combined with FastMCP's streaming context methods (`streamContent`, `reportProgress`, and logging).

This document extracts key patterns used in the automagik-genie project for implementing real-time task monitoring (`forge_watch_task`).

---

## Part 1: FastMCP Core Capabilities

### 1.1 Streaming Output Support

FastMCP includes built-in streaming capabilities that enable incremental content delivery:

```typescript
// Enable streaming for a tool with streamingHint annotation
server.addTool({
  name: "generateText",
  description: "Generate text incrementally",
  parameters: z.object({
    prompt: z.string(),
  }),
  annotations: {
    streamingHint: true,  // Signals this tool uses streaming
    readOnlyHint: true,
  },
  execute: async (args, { streamContent }) => {
    // Send initial content immediately
    await streamContent({ type: "text", text: "Starting generation...\n" });

    // Simulate incremental content generation
    const words = "The quick brown fox jumps over the lazy dog.".split(" ");
    for (const word of words) {
      await streamContent({ type: "text", text: word + " " });
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    // Option 1: All content was streamed, return void
    return;

    // Option 2: Return final result
    // return "Generation complete!";
  },
});
```

**Key points:**
- `streamingHint: true` annotation signals the tool supports streaming
- `streamContent()` method sends incremental updates
- Can combine streaming with `reportProgress()` for progress tracking

### 1.2 Progress Notifications

Tools can report progress while executing:

```typescript
server.addTool({
  name: "processData",
  description: "Process data with streaming updates",
  parameters: z.object({
    datasetSize: z.number(),
  }),
  annotations: {
    streamingHint: true,
  },
  execute: async (args, { streamContent, reportProgress }) => {
    const total = args.datasetSize;

    for (let i = 0; i < total; i++) {
      // Report numeric progress
      await reportProgress({ progress: i, total });

      // Stream intermediate results
      if (i % 10 === 0) {
        await streamContent({
          type: "text",
          text: `Processed ${i} of ${total} items...\n`,
        });
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    return "Processing complete!";
  },
});
```

**Context object in execute():**
- `log` - Logger with `.info()`, `.debug()`, `.warn()`, `.error()`
- `streamContent()` - Stream partial results
- `reportProgress()` - Report numeric progress
- `session` - Session information
- `sessionId` - Unique session identifier
- `requestId` - Unique request identifier

### 1.3 Logging Within Tools

```typescript
execute: async (args, { log }) => {
  log.debug("Debug message", { data: "value" });
  log.info("Informational message");
  log.warn("Warning message");
  log.error("Error message");
  return "done";
}
```

---

## Part 2: WebSocket Manager Pattern (Custom Implementation)

The automagik-genie project implements a `WebSocketManager` class for persistent WebSocket subscriptions:

### 2.1 WebSocketManager Architecture

```typescript
/**
 * Connection pooling and auto-reconnection manager
 */
export class WebSocketManager {
  private subscriptions: Map<string, Subscription> = new Map();
  private connectionPool: Map<string, WebSocket> = new Map();
  
  /**
   * Subscribe to a WebSocket stream
   * 
   * @param streamUrl WebSocket URL
   * @param onMessage Callback for incoming messages
   * @param onError Optional error callback
   * @param maxReconnectAttempts Maximum reconnection attempts (default: 5)
   * @returns Subscription ID
   */
  subscribe(
    streamUrl: string,
    onMessage: (data: any) => void,
    onError?: (error: Error) => void,
    maxReconnectAttempts = 5
  ): string { ... }

  /**
   * Unsubscribe from a stream
   */
  unsubscribe(subscriptionId: string): void { ... }

  /**
   * Close all connections
   */
  close(): void { ... }
}
```

### 2.2 Connection Lifecycle

```typescript
// 1. Create subscription
const subscriptionId = wsManager.subscribe(
  "ws://localhost:8887/api/tasks/stream/ws?project_id=xxx",
  
  // 2. Handle incoming messages
  (data: any) => {
    console.log("Received:", data);
    // Process streaming task updates
  },
  
  // 3. Handle errors
  (error: Error) => {
    console.error("Stream error:", error.message);
  },
  
  // 4. Max reconnection attempts
  5
);

// 5. Later: Unsubscribe
wsManager.unsubscribe(subscriptionId);
```

### 2.3 Auto-Reconnection with Exponential Backoff

```typescript
private attemptReconnect(subscription: Subscription): void {
  if (subscription.reconnectAttempts >= subscription.maxReconnectAttempts) {
    // Max attempts reached, fail
    if (subscription.onError) {
      subscription.onError(
        new Error(`Failed to reconnect after ${subscription.maxReconnectAttempts} attempts`)
      );
    }
    subscription.closed = true;
    return;
  }

  subscription.reconnectAttempts++;

  // Exponential backoff: 1s, 2s, 4s, 8s, 16s, ...
  const delay = subscription.reconnectDelay * Math.pow(2, subscription.reconnectAttempts - 1);

  setTimeout(() => {
    if (subscription.closed) return;

    // Create new connection
    const ws = this.createConnection(subscription.url);
    subscription.ws = ws;
    this.connectionPool.set(subscription.url, ws);

    // Reattach event handlers
    this.setupEventHandlers(subscription);
  }, delay);
}
```

### 2.4 WebSocket Event Handling

```typescript
private setupEventHandlers(subscription: Subscription): void {
  const { ws, onMessage, onError } = subscription;

  ws.on('open', () => {
    // Reset reconnect attempts on successful connection
    subscription.reconnectAttempts = 0;
    subscription.reconnectDelay = 1000;
  });

  ws.on('message', (data: Buffer) => {
    if (subscription.closed) return;

    try {
      const parsed = JSON.parse(data.toString());
      onMessage(parsed);  // Call user callback with parsed JSON
    } catch (error) {
      onMessage(data.toString());  // Fall back to raw string
    }
  });

  ws.on('error', (error: Error) => {
    if (subscription.closed) return;
    if (onError) {
      onError(error);
    }
  });

  ws.on('close', (code: number, reason: Buffer) => {
    if (subscription.closed) return;
    // Attempt reconnection if not closed intentionally
    this.attemptReconnect(subscription);
  });
}
```

### 2.5 Connection Pooling

```typescript
subscribe(streamUrl: string, onMessage: (data: any) => void, ...): string {
  // Check if we already have a connection for this URL
  let ws = this.connectionPool.get(streamUrl);

  if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
    // Create new WebSocket connection
    ws = this.createConnection(streamUrl);
    this.connectionPool.set(streamUrl, ws);
  }

  // Multiple subscriptions can share same connection
  const subscription: Subscription = {
    id: subscriptionId,
    url: streamUrl,
    ws,
    onMessage,
    onError,
    reconnectAttempts: 0,
    maxReconnectAttempts,
    reconnectDelay: 1000,
    closed: false
  };

  this.subscriptions.set(subscriptionId, subscription);
  return subscriptionId;
}
```

**Pooling benefits:**
- Multiple subscriptions to same stream reuse one WebSocket
- Reduces server load and connection overhead
- Cleaner disconnect: only closes when no subscribers remain

---

## Part 3: Forge WebSocket Stream URLs

The Forge backend exposes three main WebSocket streams:

### 3.1 Task Diff Stream

**Purpose:** Real-time file changes during task execution

```typescript
// URL format
const wsUrl = forgeClient.getTaskDiffStreamUrl(attemptId, false);
// Generates: ws://host/api/tasks/{attemptId}/diff/ws

// Message format: JSON with file diffs
ws.on('message', (data: Buffer) => {
  const diff = JSON.parse(data.toString());
  console.log(diff);  // { file: "path/to/file", changes: [...] }
});
```

### 3.2 Raw Logs Stream

**Purpose:** Real-time agent output and process logs

```typescript
// URL format
const wsUrl = forgeClient.getRawLogsStreamUrl(processId);
// Generates: ws://host/api/processes/{processId}/logs/ws

// Message format: Plain text lines
ws.on('message', (data: Buffer) => {
  const logLine = data.toString();
  console.log(logLine);  // Raw log output
});
```

### 3.3 Tasks Stream

**Purpose:** Project-level task status updates

```typescript
// URL format
const protocol = FORGE_URL.startsWith('https') ? 'wss' : 'ws';
const host = new URL(FORGE_URL).host;
const wsUrl = `${protocol}://${host}/api/tasks/stream/ws?project_id=${projectId}`;

// Message format: JSON with task status
ws.on('message', (data: Buffer) => {
  const taskUpdate = JSON.parse(data.toString());
  console.log(taskUpdate);  // { task_id: "...", status: "in_progress", ... }
});
```

---

## Part 4: Integration with FastMCP Tools

### 4.1 Pattern: Polling + Progress Reporting

Used in Forge MCP server for long-running operations:

```typescript
server.addTool({
  name: "forge_create_task_attempt",
  description: "Create and start task execution",
  parameters: z.object({
    task_id: z.string(),
    executor: z.enum(['CLAUDE_CODE', 'CODEX', 'GEMINI']),
    base_branch: z.string(),
  }),
  execute: async (args, { log, reportProgress }) => {
    log.info(`Starting task attempt...`);
    await reportProgress({ progress: 1, total: 2 });

    const attempt = await client.createTaskAttempt({
      task_id: args.task_id,
      executor: args.executor,
      base_branch: args.base_branch,
    });

    await reportProgress({ progress: 2, total: 2 });
    log.info(`Task attempt started: ${attempt.id}`);

    return `Task attempt created:\n${JSON.stringify(attempt, null, 2)}`;
  },
});
```

### 4.2 Pattern: Dynamic Resources for Real-Time Data

Resources load data on-demand (polling approach):

```typescript
server.addResourceTemplate({
  uriTemplate: 'forge://logs/attempt/{attemptId}',
  name: 'Task Attempt Logs',
  mimeType: 'text/plain',
  arguments: [{
    name: 'attemptId',
    description: 'Task attempt UUID',
    required: true
  }],
  async load({ attemptId }) {
    // Fetch current logs from API
    const processes = await client.listExecutionProcesses(attemptId, false);

    let combinedLogs = `Task Attempt Logs (${processes.length} process(es)):\n\n`;

    for (const proc of processes) {
      combinedLogs += `=== Process ${proc.id} (${proc.status}) ===\n`;
      combinedLogs += proc.logs || proc.output || 'No logs\n';
      combinedLogs += '\n\n';
    }

    return { text: combinedLogs };
  }
});
```

---

## Part 5: Implementation Patterns for forge_watch_task

### 5.1 Hybrid Approach: WebSocket + FastMCP Streaming

```typescript
import { WebSocketManager } from './websocket-manager.js';
import { z } from 'zod';

const wsManager = new WebSocketManager();

server.addTool({
  name: 'forge_watch_task',
  description: 'Watch task execution in real-time via WebSocket streaming',
  parameters: z.object({
    attempt_id: z.string().describe('Task attempt UUID to watch'),
    duration_seconds: z.number().optional().default(300).describe('How long to watch (default: 5 minutes)'),
  }),
  annotations: {
    streamingHint: true,
    readOnlyHint: true,
  },
  execute: async (args, { streamContent, reportProgress, log }) => {
    log.info(`Starting to watch task attempt: ${args.attempt_id}`);
    await reportProgress({ progress: 0, total: 100 });

    return new Promise((resolve, reject) => {
      let messageCount = 0;
      const startTime = Date.now();
      const maxDuration = args.duration_seconds * 1000;

      // Subscribe to task diff stream
      const diffSubId = wsManager.subscribe(
        forgeClient.getTaskDiffStreamUrl(args.attempt_id, false),
        
        async (diff: any) => {
          messageCount++;
          
          // Stream diff updates
          await streamContent({
            type: 'text',
            text: `[Diff #${messageCount}] ${diff.file}: ${JSON.stringify(diff.changes).substring(0, 100)}...\n`
          });

          // Report progress based on message count
          const elapsed = Date.now() - startTime;
          const progress = Math.min(99, Math.floor((elapsed / maxDuration) * 100));
          await reportProgress({ progress, total: 100 });
        },
        
        (error: Error) => {
          log.error(`Stream error: ${error.message}`);
        }
      );

      // Timeout handler
      const timeoutId = setTimeout(() => {
        wsManager.unsubscribe(diffSubId);
        
        resolve(`Watch completed. Received ${messageCount} updates over ${args.duration_seconds}s`);
      }, maxDuration);

      // Graceful shutdown
      process.on('SIGINT', () => {
        clearTimeout(timeoutId);
        wsManager.unsubscribe(diffSubId);
        resolve(`Watch interrupted. Received ${messageCount} updates.`);
      });
    });
  },
});
```

### 5.2 Pure FastMCP Streaming with Polling

Alternative approach without WebSocket (simpler but less real-time):

```typescript
server.addTool({
  name: 'forge_watch_task_polling',
  description: 'Watch task execution via polling (simpler, less real-time)',
  parameters: z.object({
    attempt_id: z.string(),
    poll_interval_ms: z.number().optional().default(1000),
    max_duration_seconds: z.number().optional().default(300),
  }),
  annotations: {
    streamingHint: true,
    readOnlyHint: true,
  },
  execute: async (args, { streamContent, reportProgress, log }) => {
    log.info(`Watching task (polling every ${args.poll_interval_ms}ms)...`);

    const startTime = Date.now();
    const maxDuration = args.max_duration_seconds * 1000;
    let lastLogIndex = 0;
    let updateCount = 0;

    while (Date.now() - startTime < maxDuration) {
      const attempt = await client.getTaskAttempt(args.attempt_id);

      // Stream status update
      await streamContent({
        type: 'text',
        text: `[${new Date().toISOString()}] Status: ${attempt.status}\n`
      });

      // Get new logs
      const processes = await client.listExecutionProcesses(args.attempt_id, false);
      for (const proc of processes) {
        const logs = proc.logs || '';
        const newLogs = logs.substring(lastLogIndex);
        
        if (newLogs) {
          await streamContent({
            type: 'text',
            text: newLogs
          });
          lastLogIndex += newLogs.length;
        }
      }

      updateCount++;
      const elapsed = Date.now() - startTime;
      const progress = Math.min(99, Math.floor((elapsed / maxDuration) * 100));
      await reportProgress({ progress, total: 100 });

      // Stop if task complete
      if (attempt.status === 'completed' || attempt.status === 'failed') {
        break;
      }

      await new Promise(resolve => setTimeout(resolve, args.poll_interval_ms));
    }

    await reportProgress({ progress: 100, total: 100 });
    return `Watch completed. Received ${updateCount} updates.`;
  },
});
```

### 5.3 Subscription Manager Singleton

Create a shared instance for reuse:

```typescript
// websocket-manager.ts
export const wsManager = new WebSocketManager();

// In tool registration
import { wsManager } from '../websocket-manager.js';

// Tools can use wsManager directly
const subId = wsManager.subscribe(url, onMessage, onError);
```

---

## Part 6: Key Differences Between Approaches

| Aspect | WebSocket (Streaming) | Polling (Streaming) | Resources (On-Demand) |
|--------|----------------------|-------------------|----------------------|
| **Real-time** | ✅ True real-time | ❌ Delayed | ❌ On-demand only |
| **Server Load** | Low | Medium (polling) | Low |
| **Setup Complexity** | High | Low | Low |
| **Best For** | Live monitoring, diffs | Status checks | Static data reads |
| **Reconnection** | Automatic (manager) | N/A | N/A |
| **Latency** | < 100ms | 1s+ (configurable) | Immediate |

---

## Part 7: Error Handling Best Practices

### 7.1 In WebSocket Manager

```typescript
// Automatic reconnection
private attemptReconnect(subscription: Subscription): void {
  // Max attempts check
  if (subscription.reconnectAttempts >= subscription.maxReconnectAttempts) {
    if (subscription.onError) {
      subscription.onError(
        new Error(`Failed to reconnect after ${subscription.maxReconnectAttempts} attempts`)
      );
    }
    subscription.closed = true;
    return;
  }

  // Exponential backoff prevents thundering herd
  const delay = subscription.reconnectDelay * Math.pow(2, subscription.reconnectAttempts - 1);
  subscription.reconnectAttempts++;
  
  setTimeout(() => {
    // Reconnect logic...
  }, delay);
}
```

### 7.2 In FastMCP Tools

```typescript
import { UserError } from 'fastmcp';

execute: async (args, { log, streamContent }) => {
  try {
    const data = await fetchData(args.id);
    await streamContent({ type: 'text', text: data });
    return data;
  } catch (error) {
    // User-facing errors via UserError
    throw new UserError(`Failed to fetch data: ${error.message}`);
  }
}
```

---

## Part 8: Testing WebSocket Streams

The project includes a test script (`test-forge-websocket.ts`):

```typescript
// 1. Create WebSocket connection
const ws = new WebSocket(wsUrl, {
  headers: {
    'Origin': FORGE_URL,
    'User-Agent': 'Genie-MCP-Test/1.0'
  }
});

// 2. Handle lifecycle
ws.on('open', () => console.log('✅ Connected'));
ws.on('message', (data: Buffer) => console.log('📨', data));
ws.on('error', (error) => console.error('❌', error));
ws.on('close', (code, reason) => console.log('🔌 Closed'));

// 3. Handle unexpected responses
ws.on('unexpected-response', (req, res) => {
  console.error(`HTTP ${res.statusCode}: ${res.statusMessage}`);
  let body = '';
  res.on('data', chunk => { body += chunk.toString(); });
  res.on('end', () => console.error(body));
});

// 4. Timeout for safety
const timeout = setTimeout(() => ws.close(), 10000);
```

---

## Summary: forge_watch_task Implementation Strategy

### Recommended Hybrid Approach

**Combine FastMCP streaming with WebSocket subscriptions:**

1. **Use `streamingHint: true`** for FastMCP support
2. **Use WebSocketManager** for connection pooling and auto-reconnect
3. **Stream updates via `streamContent()`** from WebSocket callbacks
4. **Report progress via `reportProgress()`** to show status
5. **Log via `log.info()`** for debugging
6. **Handle timeouts and cleanup** gracefully

**Key URLs:**
- Diffs: `/api/tasks/{attemptId}/diff/ws`
- Logs: `/api/processes/{processId}/logs/ws`
- Tasks: `/api/tasks/stream/ws?project_id={projectId}`

**Client dependencies:**
- `fastmcp` - FastMCP server framework
- `ws` - WebSocket client library
- `zod` - Schema validation

---

## File References

**Key files in automagik-genie:**
- `/home/namastex/workspace/automagik-genie/.genie/mcp/src/websocket-manager.ts` - WebSocketManager class
- `/home/namastex/workspace/automagik-genie/.genie/mcp/test-forge-websocket.ts` - Test script
- `/home/namastex/workspace/automagik-genie/forge/mcp/src/server.ts` - FastMCP server setup
- `/home/namastex/workspace/automagik-genie/forge/mcp/src/tools/attempts.ts` - Tool examples
- `/home/namastex/workspace/automagik-genie/forge/mcp/README.md` - Complete documentation

