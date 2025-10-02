# Transcript Utilities

Shared utilities for parsing conversations, extracting metrics, and slicing message arrays across both Codex and Claude log viewers.

## Overview

This module provides common functionality to support the view command's dual-executor architecture. Both `codex-log-viewer.ts` and `claude-log-viewer.ts` use these utilities to:

1. **Slice messages** for different display modes (default, full, live)
2. **Extract and summarize metrics** for header display
3. **Standardize message formatting** across executors

## Message Slicing Functions

### `sliceForLatest(messages: ChatMessage[]): ChatMessage[]`

Returns only the latest assistant message plus any immediately preceding reasoning messages.

**Used for:** `--live` mode

**Behavior:**
- Finds the last assistant message
- Includes all reasoning messages that immediately precede it
- Stops at the first non-reasoning message when looking backwards
- Returns empty array if no assistant messages exist

**Example:**
```typescript
const messages = [
  { role: 'assistant', title: 'Message 1', body: ['First'] },
  { role: 'tool', title: 'Tool Call', body: ['...'] },
  { role: 'reasoning', title: 'Thinking', body: ['...'] },
  { role: 'reasoning', title: 'Analyzing', body: ['...'] },
  { role: 'assistant', title: 'Message 2', body: ['Second'] }
];

const result = sliceForLatest(messages);
// Returns: [reasoning: 'Thinking', reasoning: 'Analyzing', assistant: 'Message 2']
```

---

### `sliceForRecent(messages: ChatMessage[], count: number = 5): ChatMessage[]`

Returns the last N messages (default: 5).

**Used for:** Default mode (no flags)

**Behavior:**
- Returns last N messages in temporal order
- No filtering by message type (includes reasoning, tool, assistant, user, action, etc.)
- Returns all messages if fewer than N exist

**Example:**
```typescript
const messages = [...10 messages...];
const result = sliceForRecent(messages); // Last 5 messages
const custom = sliceForRecent(messages, 3); // Last 3 messages
```

---

## Metrics Extraction Functions

### `summarizeCodexMetrics(metrics: CodexMetrics): MetricItem[]`

Converts raw Codex metrics into header-friendly meta items.

**Input:** `CodexMetrics` object containing:
- `tokens`: Input/output/total token counts
- `mcpCalls`: Array of MCP server/tool/duration calls
- `patches`: Counts of add/update/move/delete operations
- `execs`: Array of executed commands with exit codes
- `rateLimits`: Rate limit usage percentage and reset time

**Output:** Array of `MetricItem` objects with:
- `label`: Metric name
- `value`: Concise single-line summary (<100 chars)
- `tone`: Optional tone for visual emphasis (warning, danger, etc.)

**Summarization Rules:**
- **Tokens:** `in:{input} out:{output} total:{total}`
- **MCP Calls:** Aggregate by server, show top 2, "+N more" if >2
- **Patches:** `add:{n} update:{n} move:{n} delete:{n}`
- **Execs:** `{total} commands ({ok} ok, {err} err)` - warning tone if errors
- **Rate Limits:** `{percent}% used, resets in {sec}s` - warning if >80%

**Example:**
```typescript
const metrics: CodexMetrics = {
  tokens: { input: 1234, output: 567, total: 1801 },
  mcpCalls: [
    { server: 'forge', tool: 'create', secs: 1 },
    { server: 'forge', tool: 'list', secs: 0.5 },
    { server: 'gh', tool: 'pr', secs: 2 }
  ],
  patches: { add: 2, update: 3, move: 0, delete: 1 },
  execs: [
    { cmd: 'ls', exit: 0 },
    { cmd: 'cat missing.txt', exit: 1 }
  ],
  rateLimits: { used_percent: 45, resets_in_seconds: 120 }
};

const result = summarizeCodexMetrics(metrics);
// Returns:
// [
//   { label: 'Tokens', value: 'in:1234 out:567 total:1801' },
//   { label: 'MCP Calls', value: '3 calls (forge:2 gh:1)' },
//   { label: 'Patches', value: 'add:2 update:3 move:0 delete:1' },
//   { label: 'Execs', value: '2 commands (1 ok, 1 err)', tone: 'warning' },
//   { label: 'Rate Limit', value: '45% used, resets in 120s' }
// ]
```

---

### `summarizeClaudeMetrics(metrics: ClaudeMetrics): MetricItem[]`

Converts raw Claude metrics into header-friendly meta items.

**Input:** `ClaudeMetrics` object containing:
- `tokens`: Input/output/total token counts
- `toolCalls`: Array of tool names with counts
- `model`: Model identifier string

**Output:** Array of `MetricItem` objects (same format as Codex)

**Summarization Rules:**
- **Tokens:** Same format as Codex
- **Tool Calls:** Show total count, top 2 tools, "+N more" if >2
- **Model:** Display as-is

**Example:**
```typescript
const metrics: ClaudeMetrics = {
  tokens: { input: 890, output: 234, total: 1124 },
  toolCalls: [
    { name: 'Read', count: 5 },
    { name: 'Bash', count: 3 },
    { name: 'Edit', count: 2 }
  ],
  model: 'claude-sonnet-4'
};

const result = summarizeClaudeMetrics(metrics);
// Returns:
// [
//   { label: 'Tokens', value: 'in:890 out:234 total:1124' },
//   { label: 'Tool Calls', value: '10 calls (Read:5 Bash:3 +1 more)' },
//   { label: 'Model', value: 'claude-sonnet-4' }
// ]
```

---

### `aggregateToolCalls(toolCalls: Array<{ name: string }>): Array<{ name: string; count: number }>`

Helper function to count tool calls by name.

**Used internally by:** `summarizeClaudeMetrics`

**Example:**
```typescript
const toolCalls = [
  { name: 'Read' },
  { name: 'Bash' },
  { name: 'Read' },
  { name: 'Edit' },
  { name: 'Read' }
];

const result = aggregateToolCalls(toolCalls);
// Returns: [
//   { name: 'Read', count: 3 },
//   { name: 'Bash', count: 1 },
//   { name: 'Edit', count: 1 }
// ]
```

---

## TypeScript Types

```typescript
// Metric item for header display
export interface MetricItem {
  label: string;
  value: string;
  tone?: Tone; // 'success' | 'warning' | 'danger' | 'info' | 'muted'
}

// Codex metrics structure
export interface CodexMetrics {
  tokens: { input: number; output: number; total: number } | null;
  mcpCalls: Array<{ server: string; tool: string; secs: number }>;
  patches: { add: number; update: number; move: number; delete: number };
  execs: Array<{ cmd: string; exit: number | null; dur?: { secs: number; nanos?: number } }>;
  rateLimits: { used_percent?: number; resets_in_seconds?: number } | null;
}

// Claude metrics structure
export interface ClaudeMetrics {
  tokens: { input: number; output: number; total: number } | null;
  toolCalls: Array<{ name: string; count: number }>;
  model: string | null;
}
```

---

## Usage in Log Viewers

### Codex Log Viewer Example

```typescript
import { sliceForLatest, sliceForRecent, summarizeCodexMetrics, CodexMetrics } from './transcript-utils';
import { buildChatView } from '../views/chat';

export function buildJsonlView(ctx: JsonlViewContext): ViewEnvelope {
  const { render, parsed } = ctx;
  const { jsonl } = render;

  // 1. Parse conversation from JSONL
  const messages = parseConversation(jsonl);

  // 2. Extract metrics
  const metrics: CodexMetrics = extractMetrics(jsonl);

  // 3. Slice messages based on mode
  let slicedMessages;
  if (parsed.options.full) {
    slicedMessages = messages; // All messages
  } else if (parsed.options.live) {
    slicedMessages = sliceForLatest(messages); // Latest assistant + reasoning
  } else {
    slicedMessages = sliceForRecent(messages); // Last 5 messages
  }

  // 4. Summarize metrics for header
  const meta = summarizeCodexMetrics(metrics);

  // 5. Build chat view with metrics in header
  return buildChatView({
    agent: entry.agent,
    sessionId: entry.sessionId,
    messages: slicedMessages,
    meta, // Metrics appear in header
    showFull: parsed.options.full
  });
}
```

### Claude Log Viewer Example

```typescript
import { sliceForLatest, sliceForRecent, summarizeClaudeMetrics, ClaudeMetrics, aggregateToolCalls } from './transcript-utils';
import { buildChatView } from '../views/chat';

export function buildJsonlView(ctx: JsonlViewContext): ViewEnvelope {
  // Similar structure to Codex, but:
  // 1. Parse Claude-specific event formats
  // 2. Extract Claude metrics
  // 3. Use summarizeClaudeMetrics instead
  // 4. Same slicing and view building logic
}
```

---

## Design Principles

1. **Single Responsibility:** Each function does one thing well
2. **Executor Agnostic:** Message slicing works for any executor
3. **Metrics Isolation:** Each executor has its own metrics structure
4. **Concise Summaries:** All values <100 chars for header display
5. **No Side Effects:** Pure functions, no mutations
6. **Type Safety:** Full TypeScript coverage

---

## Integration Notes

- **Wish Document:** `.genie/wishes/view-command-dual-executor-fix-wish.md`
- **Group A:** Codex log viewer will use these utilities
- **Group B:** Claude log viewer will use these utilities
- **Group C:** Fallback logic in `genie.ts` may use slicing functions
- **Metrics Format:** Follows specification in wish document §Metrics Summarization Specification

---

## Next Steps

**For Group A (Codex):**
1. Import utilities: `import { sliceForLatest, sliceForRecent, summarizeCodexMetrics } from './transcript-utils'`
2. Create `parseConversation(jsonl)` to extract `ChatMessage[]` from Codex events
3. Create `extractMetrics(jsonl)` to build `CodexMetrics` object
4. Replace `buildJsonlView()` implementation with conversation-focused logic
5. Check `parsed.options.full` and `parsed.options.live` for slicing mode
6. Pass `meta` to `buildChatView()` for header display

**For Group B (Claude):**
1. Same structure as Group A
2. Parse Claude-specific event formats (`assistant`, `user`, `system`, `result`)
3. Use `summarizeClaudeMetrics` instead
4. Use `aggregateToolCalls` helper for tool call aggregation

**For Group C (Fallback):**
1. Consider using `sliceForRecent` for consistent default behavior
2. Fix role mapping bug (user → action, not reasoning)
3. Update slice count from 20 to 5

---

## Validation

**Compilation:** ✅ TypeScript compiles without errors
**Location:** `.genie/cli/src/executors/transcript-utils.ts`
**Dependencies:** Only imports from `../views/chat` and `../view`
**Coverage:** All functions documented with examples
**Standards:** Follows project coding conventions