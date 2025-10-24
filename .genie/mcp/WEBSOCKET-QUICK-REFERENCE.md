# WebSocket Tool Patterns - Quick Reference Guide

## One-Minute Summary

**FastMCP** provides built-in streaming support via `streamContent()` and `reportProgress()`. **WebSocket** integration requires:
1. Importing `ws` library
2. Creating connections with `.on()` event handlers
3. Parsing JSON or raw messages
4. Handling reconnection gracefully

The project already has a **WebSocketManager** that handles pooling and auto-reconnect - just use it!

---

## Core Pattern: Streaming Tool with WebSocket

```typescript
import { z } from 'zod';
import { wsManager } from '../websocket-manager.js';

server.addTool({
  name: 'my_watch_tool',
  description: 'Watch real-time updates',
  parameters: z.object({
    stream_id: z.string(),
  }),
  annotations: { streamingHint: true },
  execute: async (args, { streamContent, reportProgress, log }) => {
    log.info('Starting watch...');
    
    return new Promise((resolve) => {
      let count = 0;
      
      const subId = wsManager.subscribe(
        `ws://localhost:8887/api/stream/${args.stream_id}`,
        
        // onMessage callback
        async (data) => {
          count++;
          await streamContent({
            type: 'text',
            text: `Update #${count}: ${JSON.stringify(data).substring(0, 100)}\n`
          });
          await reportProgress({ progress: count, total: 100 });
        },
        
        // onError callback
        (error) => {
          log.error(`Stream error: ${error.message}`);
        }
      );

      // Auto-cleanup after timeout
      setTimeout(() => {
        wsManager.unsubscribe(subId);
        resolve(`Watched ${count} updates`);
      }, 30000);
    });
  },
});
```

---

## Key Context Methods (in execute)

| Method | Signature | Purpose |
|--------|-----------|---------|
| `log.info()` | `log.info(msg, data?)` | Log informational message |
| `log.debug()` | `log.debug(msg, data?)` | Log debug message |
| `log.warn()` | `log.warn(msg, data?)` | Log warning |
| `log.error()` | `log.error(msg, data?)` | Log error |
| `streamContent()` | `await streamContent(content)` | Send incremental result |
| `reportProgress()` | `await reportProgress({ progress, total })` | Report numeric progress |

---

## WebSocket Event Handlers

```typescript
ws.on('open', () => { ... })              // Connected
ws.on('message', (data: Buffer) => { ... })  // Received data
ws.on('error', (error: Error) => { ... })    // Connection error
ws.on('close', (code, reason) => { ... })    // Disconnected
```

---

## Forge Backend Stream URLs

Three main streams available:

| Stream | URL Pattern | Format | Purpose |
|--------|-------------|--------|---------|
| **Diffs** | `/api/tasks/{attemptId}/diff/ws` | JSON | File changes |
| **Logs** | `/api/processes/{processId}/logs/ws` | Plain text | Agent output |
| **Tasks** | `/api/tasks/stream/ws?project_id={id}` | JSON | Status updates |

---

## WebSocketManager API

```typescript
import { wsManager } from '../websocket-manager.js';

// Subscribe
const subId = wsManager.subscribe(
  url,                           // WebSocket URL
  (data) => { ... },            // onMessage callback
  (error) => { ... },           // onError callback (optional)
  5                             // max reconnect attempts (default: 5)
);

// Unsubscribe
wsManager.unsubscribe(subId);

// Close all
wsManager.close();
```

**Features:**
- Connection pooling (reuse per URL)
- Auto-reconnect with exponential backoff
- JSON parsing with fallback to raw string
- Graceful error handling

---

## Common Patterns

### Pattern 1: Watch for Duration

```typescript
execute: async (args, { streamContent, reportProgress, log }) => {
  const maxDuration = args.duration_seconds * 1000;
  const startTime = Date.now();

  return new Promise((resolve) => {
    let count = 0;

    const subId = wsManager.subscribe(wsUrl, async (data) => {
      count++;
      await streamContent({ type: 'text', text: `${data}\n` });

      const elapsed = Date.now() - startTime;
      const progress = Math.min(99, Math.floor((elapsed / maxDuration) * 100));
      await reportProgress({ progress, total: 100 });
    });

    const timeout = setTimeout(() => {
      wsManager.unsubscribe(subId);
      resolve(`Received ${count} messages`);
    }, maxDuration);
  });
}
```

### Pattern 2: Stop on Condition

```typescript
execute: async (args, { streamContent, log }) => {
  let finalStatus = null;

  return new Promise((resolve) => {
    const subId = wsManager.subscribe(wsUrl, async (data) => {
      await streamContent({ type: 'text', text: JSON.stringify(data) + '\n' });

      // Stop if completed
      if (data.status === 'completed' || data.status === 'failed') {
        finalStatus = data.status;
        wsManager.unsubscribe(subId);
        resolve(`Task ${finalStatus}`);
      }
    });
  });
}
```

### Pattern 3: Combine Multiple Streams

```typescript
execute: async (args, { streamContent }) => {
  const subs = [];

  return new Promise((resolve) => {
    // Subscribe to multiple streams
    subs.push(wsManager.subscribe(url1, (data) => {
      streamContent({ type: 'text', text: `[Stream1] ${data}\n` });
    }));

    subs.push(wsManager.subscribe(url2, (data) => {
      streamContent({ type: 'text', text: `[Stream2] ${data}\n` });
    }));

    // Cleanup after timeout
    setTimeout(() => {
      subs.forEach(id => wsManager.unsubscribe(id));
      resolve('Done');
    }, 30000);
  });
}
```

---

## Error Handling

```typescript
try {
  const data = await fetchData();
  await streamContent({ type: 'text', text: data });
  return data;
} catch (error) {
  throw new UserError(`Failed: ${error.message}`);
}
```

---

## Testing

```typescript
// Test if WebSocket works
const ws = new WebSocket('ws://localhost:8887/api/stream/test');

ws.on('open', () => console.log('✅ Connected'));
ws.on('message', (data) => console.log('📨', data));
ws.on('error', (err) => console.error('❌', err));
ws.on('close', () => console.log('🔌 Closed'));

setTimeout(() => ws.close(), 5000);  // Auto-close
```

---

## Annotations for Tools

```typescript
annotations: {
  streamingHint: true,      // Tool uses streaming
  readOnlyHint: true,       // No side effects
  openWorldHint: true,      // Interacts with external systems
}
```

---

## Dependencies

```json
{
  "dependencies": {
    "fastmcp": "^3.18.0",
    "ws": "^8.18.3",
    "zod": "^4.1.11"
  }
}
```

---

## File Locations

```
.genie/mcp/
├── src/
│   ├── websocket-manager.ts    ← Use this!
│   ├── server.ts               ← FastMCP setup
│   └── tools/
│       └── forge-tool.ts       ← Example tool
├── test-forge-websocket.ts     ← Test examples
└── WEBSOCKET-PATTERNS.md       ← Full guide
```

---

## What NOT to Do

- Don't forget `streamingHint: true` annotation
- Don't forget to unsubscribe (cleanup!)
- Don't ignore errors in WebSocket handlers
- Don't use blocking loops without await
- Don't forget context is async-first

---

## Complete Minimal Example

```typescript
import { z } from 'zod';
import { wsManager } from './websocket-manager.js';

server.addTool({
  name: 'watch_stream',
  description: 'Watch WebSocket stream',
  parameters: z.object({
    stream_id: z.string(),
  }),
  annotations: { streamingHint: true },
  execute: async (args, { streamContent, log }) => {
    log.info(`Watching stream: ${args.stream_id}`);

    return new Promise((resolve) => {
      let messages = 0;

      const subId = wsManager.subscribe(
        `ws://localhost:8887/api/stream/${args.stream_id}`,
        async (data) => {
          messages++;
          await streamContent({
            type: 'text',
            text: `[${messages}] ${JSON.stringify(data)}\n`
          });
        }
      );

      setTimeout(() => {
        wsManager.unsubscribe(subId);
        resolve(`Received ${messages} messages`);
      }, 10000);
    });
  },
});
```

That's it! 30 lines of actual tool code + boilerplate.

---

## Next Steps

1. Read the full guide: `WEBSOCKET-PATTERNS.md`
2. Look at existing tools: `forge/mcp/src/tools/attempts.ts`
3. Check test script: `.genie/mcp/test-forge-websocket.ts`
4. Build your tool! (copy minimal example above)
5. Test with: `npx fastmcp dev src/server.ts`

