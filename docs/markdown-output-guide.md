# Markdown Output Formatting Guide

## Overview

This guide explains how to format and output markdown content in Genie CLI commands. It covers the transition from the deprecated `emitView()` function to the modern `formatTranscriptMarkdown()` function, which provides flexible output modes optimized for different use cases.

## Why the Change?

The `emitView()` function was originally designed as a simple wrapper for outputting markdown content. However, as the CLI evolved to support AI-to-AI orchestration, we needed more sophisticated output formatting with:

- **Multiple output modes** for different contexts (final reports, in-progress work, high-level overviews)
- **Token budget management** to prevent excessive output in orchestration scenarios
- **Rich metadata support** (session info, token metrics, tool usage)
- **Flexible formatting** for various message types and lengths

The new `formatTranscriptMarkdown()` function addresses all these needs while maintaining simplicity for basic use cases.

## Output Formatting Options

### When to Use Each Function

| Function | Use Case | Best For |
|----------|----------|----------|
| `formatTranscriptMarkdown()` | Session transcripts with metadata | AI orchestration, session monitoring, detailed reports |
| Direct `stream.write()` | Simple string output | Basic messages, raw content, custom formatting |
| `formatSessionList()` | Multiple session overview | Session dashboards, status pages |

### formatTranscriptMarkdown() Output Modes

The `formatTranscriptMarkdown()` function supports four output modes, each optimized for specific scenarios:

#### 1. **final** Mode (Default for Completed Tasks)
- **Token Budget:** ~500 tokens (2000 chars)
- **Content:** Last message only + mini-report format
- **Use Case:** Completed tasks, final status reports, summary views

**What's Included:**
- Session ID and agent name
- Final status
- Last message title and body
- Token metrics (if available)

**Example Output:**
```markdown
## Session: abc123-def456-ghi789
**Agent:** implementor
**Status:** completed
**Last message:** Implementation complete

All 3 modes implemented:
- final: last message only
- recent: last 5 messages
- overview: metadata + checkpoints

**Tokens:** 8000
```

#### 2. **recent** Mode (Default for In-Progress Work)
- **Token Budget:** ~300 tokens (1200 chars)
- **Content:** Latest 5 messages, compact format
- **Use Case:** In-progress work, recent context, active monitoring

**What's Included:**
- Session ID and agent name
- Current status
- Last 5 messages with titles and bodies (truncated if needed)

**Example Output:**
```markdown
## Session: abc123-def456-ghi789
**Agent:** implementor
**Status:** running

### Message 1: Starting implementation
Creating markdown-formatter.ts with 3 output modes...

### Message 2: Analyzing requirements
Need to support final, recent, and overview modes
Token budgets: 500, 300, 400

[... 3 more messages ...]
```

#### 3. **overview** Mode (High-Level Status)
- **Token Budget:** ~400 tokens (1600 chars)
- **Content:** Session metadata + key checkpoints
- **Use Case:** High-level status, orchestration dashboards, progress tracking

**What's Included:**
- Complete session metadata (agent, status, executor, model)
- Token metrics (input/output/total)
- Tool usage summary
- Message count
- Key checkpoints (first, every 5th, and last message)

**Example Output:**
```markdown
## Session: abc123-def456-ghi789
**Agent:** implementor
**Status:** running
**Executor:** claude
**Model:** sonnet-4
**Tokens:** 8000 (in: 5000, out: 3000)
**Tools:** Read:12, Write:5, Edit:8
**Messages:** 5

### Key Checkpoints

- **Starting implementation**: Creating markdown-formatter.ts with 3 output modes...
- **Implementation complete**: All 3 modes implemented: final, recent, overview
```

#### 4. **full** Mode (Complete Transcript)
- **Token Budget:** Unlimited (no truncation)
- **Content:** Complete transcript with all messages
- **Use Case:** Debugging, full context review, detailed analysis

**What's Included:**
- Complete session metadata
- All messages with full content (no truncation)
- Token metrics

**Example Output:**
```markdown
## Session: abc123-def456-ghi789
**Agent:** implementor
**Status:** completed
**Executor:** claude
**Model:** sonnet-4
**Messages:** 5

### Full Transcript

#### Message 1: Starting implementation
Creating markdown-formatter.ts with 3 output modes...

#### Message 2: Analyzing requirements
Need to support final, recent, and overview modes
Token budgets: 500, 300, 400

[... all remaining messages with full content ...]

**Tokens:** 8000 (in: 5000, out: 3000)
```

## Migration Guide from emitView()

### Understanding the Differences

| Aspect | emitView() | formatTranscriptMarkdown() |
|--------|------------|---------------------------|
| **Purpose** | Simple output wrapper | Rich transcript formatting |
| **Parameters** | `(content, options, opts)` | `(messages, meta, mode)` |
| **Input Type** | Plain string | Structured messages array |
| **Output Modes** | None (single format) | 4 modes (final/recent/overview/full) |
| **Metadata** | None | Rich session metadata |
| **Token Management** | None | Built-in budget enforcement |
| **Status** | Deprecated | Current standard |

### Migration Steps

#### Step 1: Assess Your Current Usage

**Before (emitView):**
```typescript
import { emitView } from './lib/view-helpers.js';

// Simple string output
await emitView('Task completed successfully', options);

// With JSON mode
await emitView(jsonData, options, { forceJson: true });
```

#### Step 2: Choose the Right Approach

**Option A: Simple String Output (No Migration Needed)**

If you're just outputting simple strings without structured data, use direct stream writing:

```typescript
// After (Direct output)
process.stdout.write('Task completed successfully\n');

// Or with JSON
process.stdout.write(JSON.stringify({ status: 'completed' }, null, 2) + '\n');
```

**Option B: Structured Transcript Output (Use formatTranscriptMarkdown)**

If you're outputting session data, transcripts, or structured messages:

```typescript
import { formatTranscriptMarkdown } from './lib/markdown-formatter.js';
import type { ChatMessage, SessionMeta } from './lib/markdown-formatter.js';

// Prepare your messages
const messages: ChatMessage[] = [
  {
    role: 'assistant',
    title: 'Task started',
    body: ['Analyzing requirements...']
  },
  {
    role: 'assistant',
    title: 'Task completed',
    body: ['Successfully implemented feature X', 'All tests passing']
  }
];

// Prepare metadata
const meta: SessionMeta = {
  sessionId: 'abc-123',
  agent: 'implementor',
  status: 'completed',
  executor: 'claude',
  tokens: { input: 1000, output: 500, total: 1500 }
};

// Format and output
const output = formatTranscriptMarkdown(messages, meta, 'final');
process.stdout.write(output + '\n');
```

### Complete Migration Examples

#### Example 1: Simple Status Message

**Before:**
```typescript
await emitView('✓ Migration completed', options);
```

**After:**
```typescript
process.stdout.write('✓ Migration completed\n');
```

#### Example 2: Task Completion Report

**Before:**
```typescript
const report = `
Task: ${taskName}
Status: Completed
Duration: ${duration}ms
`;
await emitView(report, options);
```

**After:**
```typescript
const messages: ChatMessage[] = [
  {
    role: 'assistant',
    title: 'Task completed',
    body: [
      `Task: ${taskName}`,
      `Status: Completed`,
      `Duration: ${duration}ms`
    ]
  }
];

const meta: SessionMeta = {
  sessionId: sessionId,
  agent: 'task-runner',
  status: 'completed'
};

const output = formatTranscriptMarkdown(messages, meta, 'final');
process.stdout.write(output + '\n');
```

#### Example 3: In-Progress Session Monitoring

**Before:**
```typescript
const status = `
Session: ${sessionId}
Status: Running
Last update: ${lastMessage}
`;
await emitView(status, options);
```

**After:**
```typescript
const messages: ChatMessage[] = [
  // ... your session messages ...
];

const meta: SessionMeta = {
  sessionId: sessionId,
  agent: 'monitor',
  status: 'running',
  executor: 'claude'
};

// Use 'recent' mode for in-progress work
const output = formatTranscriptMarkdown(messages, meta, 'recent');
process.stdout.write(output + '\n');
```

#### Example 4: JSON Output Mode

**Before:**
```typescript
await emitView(data, options, { forceJson: true });
```

**After:**
```typescript
process.stdout.write(JSON.stringify(data, null, 2) + '\n');
```

### Choosing the Right Output Mode

Use this decision tree to select the appropriate mode:

```
Is the task completed?
├─ Yes → Use 'final' mode (last message + summary)
└─ No → Is this for monitoring/debugging?
    ├─ Yes → Use 'recent' mode (last 5 messages)
    └─ No → Is this for a dashboard/overview?
        ├─ Yes → Use 'overview' mode (metadata + checkpoints)
        └─ No → Use 'full' mode (complete transcript)
```

## Common Migration Patterns

### Pattern 1: Command Output

**Before:**
```typescript
export async function myCommand(options: CLIOptions) {
  const result = await doWork();
  await emitView(`Work completed: ${result}`, options);
}
```

**After:**
```typescript
export async function myCommand(options: CLIOptions) {
  const result = await doWork();
  process.stdout.write(`Work completed: ${result}\n`);
}
```

### Pattern 2: Session Status

**Before:**
```typescript
const statusText = formatSessionStatus(session);
await emitView(statusText, options);
```

**After:**
```typescript
const messages = session.messages.map(msg => ({
  role: msg.role,
  title: msg.title,
  body: msg.content
}));

const meta: SessionMeta = {
  sessionId: session.id,
  agent: session.agent,
  status: session.status,
  executor: session.executor,
  tokens: session.tokenUsage
};

const output = formatTranscriptMarkdown(messages, meta, 'recent');
process.stdout.write(output + '\n');
```

### Pattern 3: Error Reporting

**Before:**
```typescript
await emitView(`Error: ${error.message}`, options);
```

**After:**
```typescript
// For simple errors, direct output is fine
process.stdout.write(`Error: ${error.message}\n`);

// For structured error reports
const messages: ChatMessage[] = [
  {
    role: 'assistant',
    title: 'Error occurred',
    body: [
      `Error: ${error.message}`,
      `Stack: ${error.stack}`,
      `Context: ${errorContext}`
    ]
  }
];

const meta: SessionMeta = {
  sessionId: sessionId,
  agent: 'error-handler',
  status: 'failed'
};

const output = formatTranscriptMarkdown(messages, meta, 'final');
process.stdout.write(output + '\n');
```

## Troubleshooting Common Migration Issues

### Issue 1: "Messages array is empty"

**Problem:** You're passing an empty messages array to `formatTranscriptMarkdown()`.

**Solution:** Ensure you have at least one message, or use direct output for simple cases:
```typescript
if (messages.length === 0) {
  process.stdout.write('No messages to display\n');
} else {
  const output = formatTranscriptMarkdown(messages, meta, mode);
  process.stdout.write(output + '\n');
}
```

### Issue 2: "Output is truncated"

**Problem:** Your output shows `[Output truncated to meet token budget]`.

**Solution:** Either:
- Use a mode with a larger budget (`overview` > `final` > `recent`)
- Use `full` mode for complete output (no truncation)
- Reduce message content length

```typescript
// If you need complete output
const output = formatTranscriptMarkdown(messages, meta, 'full');
```

### Issue 3: "Missing metadata fields"

**Problem:** TypeScript errors about missing required fields in `SessionMeta`.

**Solution:** Provide all required fields (sessionId, agent, status):
```typescript
const meta: SessionMeta = {
  sessionId: sessionId || 'unknown',
  agent: 'my-agent',
  status: 'running'
  // Optional fields: executor, tokens, toolCalls, model
};
```

### Issue 4: "Wrong message structure"

**Problem:** Your messages don't match the `ChatMessage` interface.

**Solution:** Ensure each message has the correct structure:
```typescript
const messages: ChatMessage[] = [
  {
    role: 'assistant',        // Optional: 'assistant' | 'user' | 'tool' | 'reasoning'
    title: 'Message title',   // Required: string
    body: ['Line 1', 'Line 2'] // Required: string[]
  }
];
```

### Issue 5: "Need JSON output"

**Problem:** You need JSON output but `formatTranscriptMarkdown()` only outputs markdown.

**Solution:** Use direct JSON serialization:
```typescript
// Instead of formatTranscriptMarkdown
const jsonOutput = JSON.stringify({
  sessionId: meta.sessionId,
  messages: messages,
  status: meta.status
}, null, 2);
process.stdout.write(jsonOutput + '\n');
```

## Best Practices

### 1. Choose the Right Tool for the Job

- **Simple strings:** Use `process.stdout.write()`
- **Structured transcripts:** Use `formatTranscriptMarkdown()`
- **Session lists:** Use `formatSessionList()`

### 2. Always Provide Complete Metadata

```typescript
// Good: Complete metadata
const meta: SessionMeta = {
  sessionId: session.id,
  agent: session.agent,
  status: session.status,
  executor: session.executor,
  tokens: session.tokenUsage,
  toolCalls: session.toolUsage,
  model: session.model
};

// Acceptable: Minimal metadata
const meta: SessionMeta = {
  sessionId: 'temp-123',
  agent: 'worker',
  status: 'running'
};
```

### 3. Use Appropriate Output Modes

```typescript
// Completed tasks
formatTranscriptMarkdown(messages, meta, 'final')

// Active monitoring
formatTranscriptMarkdown(messages, meta, 'recent')

// Dashboard views
formatTranscriptMarkdown(messages, meta, 'overview')

// Debugging/analysis
formatTranscriptMarkdown(messages, meta, 'full')
```

### 4. Handle Edge Cases

```typescript
// Check for empty messages
if (messages.length === 0) {
  process.stdout.write('No activity to report\n');
  return;
}

// Handle missing session ID
const meta: SessionMeta = {
  sessionId: sessionId || null, // Will display as "pending"
  agent: agent,
  status: status
};
```

### 5. Test Your Output

```typescript
// Verify output format
const output = formatTranscriptMarkdown(messages, meta, mode);
console.error(`Output length: ${output.length} chars`);
console.error(`Estimated tokens: ${Math.ceil(output.length / 4)}`);
process.stdout.write(output + '\n');
```

## Additional Resources

- **Source Code:** `src/cli/lib/markdown-formatter.ts`
- **Tests:** `src/cli/lib/__tests__/markdown-formatter.test.ts`
- **Type Definitions:** See `ChatMessage`, `SessionMeta`, `OutputMode` in markdown-formatter.ts
- **Examples:** Check existing CLI commands for real-world usage patterns

## Quick Reference

### formatTranscriptMarkdown() Signature

```typescript
function formatTranscriptMarkdown(
  messages: ChatMessage[],
  meta: SessionMeta,
  mode: OutputMode
): string

// Types
type OutputMode = 'final' | 'recent' | 'overview' | 'full';

interface ChatMessage {
  title: string;
  body: string[];
  role?: string;
}

interface SessionMeta {
  sessionId: string | null;
  agent: string;
  status: string | null;
  executor?: string;
  tokens?: { input: number; output: number; total: number };
  toolCalls?: Array<{ name: string; count: number }>;
  model?: string;
}
```

### Token Budgets

| Mode | Budget | Chars | Use Case |
|------|--------|-------|----------|
| final | ~500 tokens | ~2000 chars | Completed tasks |
| recent | ~300 tokens | ~1200 chars | In-progress work |
| overview | ~400 tokens | ~1600 chars | High-level status |
| full | Unlimited | No limit | Complete transcript |

### Migration Checklist

- [ ] Identify all `emitView()` calls in your code
- [ ] Determine if structured output is needed
- [ ] Choose appropriate replacement (direct write vs formatTranscriptMarkdown)
- [ ] Update imports
- [ ] Convert data to required format (ChatMessage[], SessionMeta)
- [ ] Select appropriate output mode
- [ ] Test output format and length
- [ ] Remove emitView() import
- [ ] Update tests if applicable

---

**Last Updated:** 2025-01-24  
**Related Issue:** [#209](https://github.com/namastexlabs/automagik-genie/issues/209)
