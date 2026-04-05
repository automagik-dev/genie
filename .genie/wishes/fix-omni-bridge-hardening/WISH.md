# Wish: Fix Omni Bridge & ClaudeCode Executor Hardening

| Field | Value |
|-------|-------|
| **Status** | SHIPPED |
| **Slug** | `fix-omni-bridge-hardening` |
| **Date** | 2026-04-04 |
| **Priority** | P1 |
| **Repo** | `automagik-dev/genie` |
| **Issues** | #1036, #1035 |
| **depends-on** | `fix-sdk-executor-correctness` (P0) |

## Summary

The ClaudeCode Omni executor has chat ID collisions, broken JSON escaping, and weak liveness checks. The OmniBridge silently drops messages when buffer is full, leaks executor processes on shutdown, and allows concurrency bursts during spawn. These are production reliability issues for the Omni→agent pipeline.

## Deliverables

### Group 1: Fix ClaudeCode executor — chat ID collision + JSON escaping + liveness (#1036)

**File:** `src/services/executors/claude-code.ts`

**Bug 1 — Chat ID collision (line 23-25):**
`sanitizeWindowName` strips non-alphanumeric chars and truncates to 40. Different JIDs like `5511999999999@s.whatsapp.net` and `5511888888888@s.whatsapp.net` can collide after stripping.

**Fix:** Use a hash-based approach:
```typescript
function sanitizeWindowName(chatId: string): string {
  const hash = createHash('md5').update(chatId).digest('hex').slice(0, 12);
  const prefix = chatId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
  return `${prefix}-${hash}` || 'chat';
}
```

**Bug 2 — JSON escaping (line 210-214):**
Only `sed 's/"/\\"/g'` is used. Backslashes, tabs, carriage returns produce malformed JSON.

**Fix:** Use `JSON.stringify()` in the Node layer before passing to bash, or use a proper escaping function that handles all JSON-special characters (`\`, `\n`, `\t`, `\r`, control chars).

**Bug 3 — Liveness check:**
`isPaneAlive` at `src/lib/tmux.ts:548-555` only checks `pane_dead` flag, not whether Claude process runs inside.

**Fix:** Add process check: `tmux list-panes -t <pane> -F '#{pane_pid}'` then verify the process tree contains `claude` or the expected process.

**Acceptance:** Different chat IDs always map to different tmux windows. Messages with special characters produce valid JSON. Liveness detects crashed Claude processes in alive panes.

### Group 2: Fix OmniBridge session lifecycle (#1035)

**File:** `src/services/omni-bridge.ts`

**Bug 1 — Silent message drop (line 265-268):**
When `entry.buffer.length >= MAX_BUFFER_PER_CHAT` (50), messages silently dropped.

**Fix:** Log a warning, emit a runtime event, and reply to the sender with an error message (e.g., "Queue full, please retry").

**Bug 2 — Resource leak on stop() (line 158-193):**
`stop()` clears timers and drains NATS but never calls `executor.shutdown()` on live sessions.

**Fix:** Iterate `this.sessions` and call `executor.shutdown()` for each active session before clearing:
```typescript
for (const [key, entry] of this.sessions) {
  try { await entry.executor?.shutdown(); } catch (e) { /* log */ }
}
this.sessions.clear();
```

**Bug 3 — Concurrency burst (line 294-295):**
Spawning entries excluded from concurrency count, allowing oversubscription.

**Fix:** Count spawning entries in the active count:
```typescript
const activeCount = Array.from(this.sessions.values()).filter(e => !e.idle).length;
```

**Bug 4 — Buffered messages lost on spawn failure (line 337-340):**
When spawn fails, `this.sessions.delete(key)` removes placeholder including all buffered messages.

**Fix:** Before deleting, attempt to re-queue buffered messages or log them for recovery.

**Acceptance:** No silent message drops — all failures logged and visible. `stop()` cleans up all executor processes. Concurrency limit respected during spawn bursts.

## Validation

```bash
cd /home/genie/workspace/repos/genie
bun run build && bun test --filter "omni|bridge|executor|claude-code"
```
