# Wish: Restore inbox-driven session management

| Field | Value |
|-------|-------|
| **Status** | SHIPPED |
| **Slug** | `inbox-driven-sessions` |
| **Date** | 2026-03-24 |
| **Issues** | #574 |

## Summary

Restore the inbox watcher that was built in PR #645 (commit 040b667d) but lost in the big revert (ef31b152). The 143-line `inbox-watcher.ts` with DI, backoff, and tests was working — it just needs to be cherry-picked back, the missing `listTeamsWithUnreadInbox()` restored in `claude-native-teams.ts`, and wired into the daemon. Then add the session key resolution from the #574 design (routing header parsing → per-user/per-chat sessions).

## Scope

### IN
- Restore `src/lib/inbox-watcher.ts` from commit 040b667d (cherry-pick or re-apply)
- Restore `listTeamsWithUnreadInbox()` in `src/lib/claude-native-teams.ts` from same commit
- Restore `src/lib/inbox-watcher.test.ts` from same commit
- Wire inbox watcher into `genie daemon start` alongside scheduler
- Add routing header parser — extract `channel`, `instance`, `chat`, `thread`, `from`, `type` from bracket-delimited first line
- Add session key resolver — map routing header to session key per #574 design (DM → `{agent}-{sender}`, group → `{agent}-{chat}`, threaded → append `-{thread}`)
- Add `genie inbox watch` command for manual foreground mode (not just daemon)

### OUT
- No changes to Omni's inbox write format (keep existing contract)
- No changes to the routing header format (already defined in #574)
- No new daemon infrastructure (use existing scheduler daemon)
- No reply routing (Phase 4 — Omni simplification is separate)
- No idle timeout / max sessions (Phase 3 — future wish)

## Decisions

| Decision | Rationale |
|----------|-----------|
| Cherry-pick from 040b667d, not rewrite | Code was tested and working. Rewriting is waste. Adapt to current API if signatures changed. |
| Polling (30s) not webhooks | Simpler, works without external infra. Upgrade to fs.watch or webhook later if needed. |
| Wire into existing daemon | One daemon process, not two. Scheduler + inbox watcher run in same process. |
| Session key from routing header | Deterministic mapping. Same sender always hits same session. Thread isolation when needed. |
| `genie inbox watch` for foreground | Dev/debug convenience. Daemon is for production. |

## Success Criteria

- [ ] `inbox-watcher.ts` exists with same DI pattern as original
- [ ] `listTeamsWithUnreadInbox()` exists in `claude-native-teams.ts`
- [ ] Inbox watcher polls every 30s, spawns offline team-leads for teams with unread messages
- [ ] Backoff after 3 failed spawn attempts (same as original)
- [ ] Routing header parsed from message text first line
- [ ] Session key resolved: DM → `{agent}-{sender}`, group → `{agent}-{chat}`
- [ ] `genie daemon start` starts inbox watcher alongside scheduler
- [ ] `genie inbox watch` runs watcher in foreground
- [ ] All inbox-watcher tests pass
- [ ] `bun run check` passes

## Execution Strategy

### Wave 1 (parallel — different files)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Restore inbox-watcher.ts + listTeamsWithUnreadInbox from 040b667d |
| 2 | engineer | Add routing header parser + session key resolver |

### Wave 2 (after Wave 1)
| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer | Wire into daemon + add `genie inbox watch` CLI command |

### Wave 3 (after Wave 2)
| Group | Agent | Description |
|-------|-------|-------------|
| 4 | reviewer | Review all changes |

## Execution Groups

### Group 1: Restore inbox watcher from 040b667d

**Goal:** Get the inbox watcher code back on dev exactly as it was, adapted to current API.

**Deliverables:**
1. Cherry-pick or re-apply `src/lib/inbox-watcher.ts` (143 lines) from commit 040b667d
   - Verify imports still resolve (module paths may have changed)
   - Adapt to current `team-auto-spawn.ts` API if signatures changed
   - Keep the DI pattern (`InboxWatcherDeps` interface)
   - Keep the backoff logic (`MAX_SPAWN_FAILURES = 3`)
2. Restore `listTeamsWithUnreadInbox()` in `src/lib/claude-native-teams.ts`
   - Cherry-pick the function from 040b667d
   - It scans `~/.claude/teams/*/inboxes/*.json` for messages with `read: false`
   - Returns `{ teamName, workingDir }[]`
3. Restore `src/lib/inbox-watcher.test.ts` (184 lines) from 040b667d
   - Adapt to current test patterns if needed
   - All tests must pass

**Acceptance Criteria:**
- [ ] `inbox-watcher.ts` compiles and exports `startInboxWatcher`, `stopInboxWatcher`, `checkInboxes`
- [ ] `listTeamsWithUnreadInbox` returns teams with unread native inbox messages
- [ ] All restored tests pass
- [ ] Backoff prevents crash loops

**Validation:**
```bash
bun test src/lib/inbox-watcher.test.ts && bun run typecheck
```

**depends-on:** none

---

### Group 2: Routing header parser + session key resolver

**Goal:** Parse the `[key:value ...]` header from messages and resolve to deterministic session keys.

**Deliverables:**
1. Create `src/lib/routing-header.ts`:
   ```typescript
   export interface RoutingHeader {
     channel: string;      // telegram, whatsapp-baileys, discord, slack
     instance: string;     // source instance ID
     chat: string;         // chat/conversation ID
     thread?: string;      // thread/topic ID
     msg: string;          // message ID
     from: string;         // sender display name
     type: 'dm' | 'group'; // message type
     replyTo?: string;     // referenced message ID
   }

   export function parseRoutingHeader(text: string): RoutingHeader | null;
   export function resolveSessionKey(agentName: string, header: RoutingHeader): string;
   ```
2. `parseRoutingHeader`:
   - Match first line against `/^\[(.+)\]$/`
   - Split on whitespace, parse `key:value` pairs
   - Return null if no valid header found
3. `resolveSessionKey`:
   - DM (no thread): `{agent}-{senderId}` where senderId = hash of `{channel}-{instance}-{chat}`
   - DM (threaded): `{agent}-{senderId}-{threadId}`
   - Group (no thread): `{agent}-{chatId}` where chatId = hash of `{channel}-{instance}-{chat}`
   - Group (threaded): `{agent}-{chatId}-{threadId}`
   - Hash to 8 chars for readability
4. Tests in `src/lib/routing-header.test.ts`:
   - Parse Telegram DM header
   - Parse WhatsApp DM header
   - Parse threaded message header
   - Parse group message header
   - Null for non-header text
   - Session key determinism (same input → same key)
   - Session key isolation (different chats → different keys)

**Acceptance Criteria:**
- [ ] Parses all example headers from #574 correctly
- [ ] Session keys are deterministic and collision-resistant
- [ ] Null returned for messages without routing headers
- [ ] All tests pass

**Validation:**
```bash
bun test src/lib/routing-header.test.ts && bun run typecheck
```

**depends-on:** none

---

### Group 3: Wire into daemon + CLI command

**Goal:** Inbox watcher runs automatically with the daemon and manually via CLI.

**Deliverables:**
1. In `src/lib/scheduler-daemon.ts`:
   - Import `startInboxWatcher`, `stopInboxWatcher` from `inbox-watcher.ts`
   - On daemon start: `const inboxHandle = startInboxWatcher()`
   - On daemon stop: `stopInboxWatcher(inboxHandle)`
   - Respect `GENIE_INBOX_POLL_MS=0` to disable (existing env var from original code)
2. In `src/term-commands/daemon.ts`:
   - In the `status` command output, include inbox watcher state
3. Add `genie inbox watch` command in `src/genie.ts`:
   - Runs inbox watcher in foreground with visible logs
   - Ctrl+C stops it
   - Useful for debugging
4. Update inbox watcher to use routing header parser:
   - When a message has a routing header, resolve session key
   - Use session key as the tmux window name when spawning
   - Fall back to team name when no routing header present

**Acceptance Criteria:**
- [ ] `genie daemon start` starts inbox watcher
- [ ] `genie daemon stop` stops inbox watcher
- [ ] `genie inbox watch` runs in foreground
- [ ] `GENIE_INBOX_POLL_MS=0` disables inbox watching
- [ ] Routing header → session key used for spawn

**Validation:**
```bash
bun run typecheck && bun test src/lib/inbox-watcher.test.ts
```

**depends-on:** Group 1, Group 2

---

### Group 4: Review

**Goal:** Review all changes for correctness and integration.

**Deliverables:**
1. Verify restored code compiles and tests pass
2. Verify routing header parser handles all #574 examples
3. Verify daemon integration doesn't break scheduler
4. Verify `genie inbox watch` works standalone

**Acceptance Criteria:**
- [ ] All changes reviewed
- [ ] `bun run check` passes

**Validation:**
```bash
bun run check
```

**depends-on:** Group 1, Group 2, Group 3

---

## QA Criteria

- [ ] Inbox watcher detects unread messages in native team inboxes
- [ ] Offline team-leads auto-spawned when unread messages exist
- [ ] Routing headers parsed from Telegram, WhatsApp, Discord message formats
- [ ] Session keys are deterministic (same sender → same session)
- [ ] `genie daemon start` runs both scheduler and inbox watcher
- [ ] `genie inbox watch` provides visible foreground monitoring
- [ ] Backoff prevents crash loops on repeated spawn failures
- [ ] All tests pass, no regressions

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Cherry-picked code may not compile on current dev | Low | Adapt imports/types. Core logic is stable. |
| Polling 30s may be too slow for real-time chat | Medium | GENIE_INBOX_POLL_MS allows tuning. Upgrade to fs.watch in Phase 3. |
| Session key hash collisions | Very Low | 8-char hash = 4 billion namespace. Add length if needed. |
| Daemon process may not exist yet | Low | `genie inbox watch` provides standalone fallback. |

## Files to Create/Modify

```
src/lib/inbox-watcher.ts           — restore from 040b667d
src/lib/inbox-watcher.test.ts      — restore from 040b667d
src/lib/claude-native-teams.ts     — restore listTeamsWithUnreadInbox
src/lib/routing-header.ts          — NEW: parse routing headers + session keys
src/lib/routing-header.test.ts     — NEW: routing header tests
src/lib/scheduler-daemon.ts        — wire inbox watcher start/stop
src/term-commands/daemon.ts         — show inbox watcher status
src/genie.ts                       — add genie inbox watch command
```
