# WebSocket Implementation Guide for Group E

**Context:** This guide documents the 100% WebSocket architecture for #424 Group E implementation, based on real Forge WebSocket capture.

---

## Critical Discovery: Correct WebSocket Endpoint

### The Real Endpoint
```
ws://localhost:8887/api/execution-processes/{process_id}/normalized-logs/ws
```

**NOT** `/logs` - it's `/normalized-logs/ws`!

---

## Real Message Structure (From Actual Forge Capture)

```json
{
  "JsonPatch": [{
    "op": "add|replace",
    "path": "/entries/N",
    "value": {
      "type": "NORMALIZED_ENTRY",
      "content": {
        "timestamp": null,
        "entry_type": {
          "type": "assistant_message"
        },
        "content": "Done! I've added the comment...",
        "metadata": {
          "type": "text",
          "text": "Done! I've added the comment..."
        }
      }
    }
  }]
}
```

---

## Entry Types (From Real Task Execution)

### 1. System Message
```json
{
  "entry_type": { "type": "system_message" },
  "content": "System initialized with model: claude-sonnet-4-5-20250929"
}
```

### 2. Assistant Message (Streaming)
```json
{
  "entry_type": { "type": "assistant_message" },
  "content": "Done! I've added the comment `<!-- Automagik Forge Project -->` at the very top of the README.md file."
}
```

### 3. Tool Use
```json
{
  "entry_type": {
    "type": "tool_use",
    "tool_name": "Read",
    "action_type": {
      "action": "file_read",
      "path": "README.md"
    },
    "status": { "status": "created" }
  },
  "content": "`README.md`",
  "metadata": {
    "type": "tool_use",
    "id": "toolu_01HZEm3QU9BezhAuTQzzi4ui",
    "name": "Read",
    "input": {
      "file_path": "/var/tmp/automagik-forge/worktrees/0e81-add-comment-to-r/README.md"
    }
  }
}
```

### 4. Completion Signal
```json
{
  "finished": true
}
```

---

## Streaming Pattern

Messages arrive progressively:

1. **Initial:** `"op": "add"` with "I"
2. **Updates:** `"op": "replace"` with "I'll add the..."
3. **More updates:** `"op": "replace"` with "I'll add the comment to..."
4. **Final:** `"op": "replace"` with complete message
5. **End:** `{"finished": true}`

---

## Implementation for src/mcp/server.ts

### Helper: Extract Final Message

```typescript
/**
 * Extract final assistant message from WebSocket messages
 * @param messages Array of captured WebSocket messages
 * @returns Final assistant message text or null
 */
function extractFinalAssistantMessage(messages: any[]): string | null {
  // Iterate backwards to find last assistant message (before {"finished": true})
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];

    // Skip the {"finished": true} message
    if (msg.finished === true) continue;

    // Check if this is a JsonPatch message
    if (msg.JsonPatch && Array.isArray(msg.JsonPatch)) {
      for (const patch of msg.JsonPatch) {
        const value = patch.value;

        // Check if this is a NORMALIZED_ENTRY with assistant_message
        if (value?.type === 'NORMALIZED_ENTRY' &&
            value?.content?.entry_type?.type === 'assistant_message') {
          return value.content.content;
        }
      }
    }
  }

  return null;
}
```

### Update viewSession Function

```typescript
async function viewSession(taskId: string): Promise<{status: string; transcript: string | null; error?: string}> {
  try {
    // Get task attempt and process IDs
    const { ForgeClient } = require('../../src/lib/forge-client.js');
    const forge = new ForgeClient('http://localhost:8887');

    const attempts = await forge.listTaskAttempts(taskId);
    if (!attempts || attempts.length === 0) {
      return { status: 'error', transcript: null, error: 'No attempts found' };
    }

    const attemptId = attempts[0].id;
    const processes = await forge.listExecutionProcesses(attemptId);
    if (!processes || processes.length === 0) {
      return { status: 'error', transcript: null, error: 'No execution processes found' };
    }

    const processId = processes[0].id;
    const status = processes[0].status;

    // Subscribe to normalized-logs WebSocket
    if (status === 'running' || status === 'completed') {
      return new Promise((resolve) => {
        const WebSocket = require('ws');
        const wsUrl = `ws://localhost:8887/api/execution-processes/${processId}/normalized-logs/ws`;
        const ws = new WebSocket(wsUrl);

        const messages: any[] = [];

        ws.on('message', (data: Buffer) => {
          const msg = JSON.parse(data.toString());
          messages.push(msg);

          if (msg.finished === true) {
            const finalMessage = extractFinalAssistantMessage(messages);
            ws.close();
            resolve({ status, transcript: finalMessage });
          }
        });

        ws.on('error', (error: Error) => {
          console.error(`WebSocket error: ${error.message}`);
          ws.close();
          resolve({ status: 'error', transcript: null, error: error.message });
        });

        ws.on('close', () => {
          const finalMessage = extractFinalAssistantMessage(messages);
          resolve({ status, transcript: finalMessage });
        });

        setTimeout(() => ws.close(), 30000); // 30s timeout
      });
    }

    return { status, transcript: null };
  } catch (error: any) {
    return { status: 'error', transcript: null, error: error.message };
  }
}
```

### Update run Tool (Real-Time Streaming)

```typescript
server.tool('run', '...', {
  agent: z.string(),
  prompt: z.string(),
  watch: z.boolean().optional().default(true)
}, async (args, extra) => {
  try {
    // 1. CLI creates task
    const { stdout } = await runCliCommand(WORKSPACE_ROOT, ['run', args.agent, args.prompt]);
    const taskIdMatch = stdout.match(/Session ID: ([a-f0-9-]+)/);
    if (!taskIdMatch) {
      return { content: [{ type: 'text', text: 'Failed to create task' }] };
    }
    const taskId = taskIdMatch[1];

    if (!args.watch) {
      return { content: [{ type: 'text', text: `Task started: ${taskId}` }] };
    }

    // 2. Get process ID
    const { ForgeClient } = require('../../src/lib/forge-client.js');
    const forge = new ForgeClient('http://localhost:8887');
    const attempts = await forge.listTaskAttempts(taskId);
    const attemptId = attempts[0].id;
    const processes = await forge.listExecutionProcesses(attemptId);
    const processId = processes[0].id;

    // 3. Subscribe to normalized-logs WebSocket
    return new Promise((resolve) => {
      const WebSocket = require('ws');
      const wsUrl = `ws://localhost:8887/api/execution-processes/${processId}/normalized-logs/ws`;
      const ws = new WebSocket(wsUrl);

      const messages: any[] = [];
      let lastStreamedEntry = -1;

      ws.on('message', async (data: Buffer) => {
        const msg = JSON.parse(data.toString());
        messages.push(msg);

        // Stream assistant messages in real-time
        if (msg.JsonPatch && Array.isArray(msg.JsonPatch)) {
          for (const patch of msg.JsonPatch) {
            const value = patch.value;

            if (value?.type === 'NORMALIZED_ENTRY' &&
                value?.content?.entry_type?.type === 'assistant_message') {

              const entryIndex = parseInt(patch.path.split('/').pop() || '0');
              if (entryIndex > lastStreamedEntry) {
                lastStreamedEntry = entryIndex;

                // Stream via MCP logging notification
                await server.sendLoggingMessage({
                  level: "info",
                  data: value.content.content
                }, extra.sessionId);
              }
            }
          }
        }

        // Check if finished
        if (msg.finished === true) {
          const finalMessage = extractFinalAssistantMessage(messages);

          // Send completion notification
          await server.sendLoggingMessage({
            level: "info",
            data: JSON.stringify({
              type: 'task_completion',
              task_id: taskId,
              status: 'completed',
              result: finalMessage,
              timestamp: new Date().toISOString()
            })
          }, extra.sessionId);

          ws.close();

          resolve({
            content: [{
              type: 'text',
              text: `Task completed: ${taskId}\n\n${finalMessage || '(No result)'}`
            }]
          });
        }
      });

      ws.on('error', (error: Error) => {
        console.error(`WebSocket error: ${error.message}`);
        resolve({
          content: [{ type: 'text', text: `WebSocket error: ${error.message}` }]
        });
      });

      setTimeout(() => {
        ws.close();
        const finalMessage = extractFinalAssistantMessage(messages);
        resolve({
          content: [{
            type: 'text',
            text: `Task monitoring timeout: ${taskId}\n\n${finalMessage || '(Incomplete)'}`
          }]
        });
      }, 600000); // 10 minutes
    });
  } catch (error: any) {
    return {
      content: [{ type: 'text', text: `Error: ${error.message}` }]
    };
  }
});
```

---

## Key Implementation Notes

### 1. Message Path Parsing
```typescript
const entryIndex = parseInt(patch.path.split('/').pop() || '0');
// "/entries/1" → 1
// "/entries/4" → 4
```

### 2. Avoid Duplicate Streaming
```typescript
let lastStreamedEntry = -1;
if (entryIndex > lastStreamedEntry) {
  // Stream this entry
  lastStreamedEntry = entryIndex;
}
```

### 3. Nested Data Access
```typescript
const content = msg.JsonPatch[0].value.content.content;
//                    ↑          ↑       ↑       ↑
//                 patch      value   content  actual text
```

---

## Success Criteria for Group E

✅ Zero HTTP API calls for logs/output retrieval
✅ 100% WebSocket for real-time monitoring
✅ Real-time assistant messages forwarded via `sendLoggingMessage()`
✅ Completion detected via `{"finished": true}` message
✅ Final result extracted from last `assistant_message` entry
✅ No polling loops
✅ Proper handling of streaming updates (avoid duplicates)
✅ forge/mcp/ deleted (obsolete fastmcp code)
✅ Zero fastmcp references in src/
✅ Official SDK (@modelcontextprotocol/sdk) confirmed

---

## Evidence Source

**Real task capture:** `/home/namastex/workspace/automagik-forge/docs/REAL_TASK_CAPTURE_EXAMPLE.md`

**Test execution:** Task ID `41add84e-4f19-4bb6-9823-0da4ceaa660d`
- 23 WebSocket messages captured
- Complete JsonPatch format documented
- Final message: "Done! I've added the comment `<!-- Automagik Forge Project -->` at the very top of the README.md file."

---

**Status:** Implementation guide validated with real data ✅
