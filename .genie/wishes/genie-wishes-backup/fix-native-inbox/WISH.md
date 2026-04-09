# Wish: Fix genie send → Claude Code native inbox delivery

| Field | Value |
|-------|-------|
| **Status** | SHIPPED |
| **Slug** | `fix-native-inbox` |
| **Date** | 2026-03-24 |
| **Issues** | #727 |

## Summary

`genie send` writes to PG mailbox and attempts to bridge to Claude Code's native team inbox (`~/.claude/teams/{team}/inboxes/{agent}.json`), but messages don't reliably reach the receiving agent. PR #728 added the bridge code (`writeNativeInbox` in `claude-native-teams.ts`), but edge cases remain: team name discovery fails when sender isn't in the same tmux session, recipient name doesn't match the native team member name, and the inbox file format may not match what Claude Code expects.

## Scope

### IN
- Fix team name discovery in `genie send` — use `GENIE_TEAM` env, team config, or worker registry as fallbacks
- Fix recipient name mapping — native team members use different names than genie worker IDs
- Verify inbox file format matches Claude Code's expected schema
- Add error logging when bridge fails (currently silent)
- Add tests for native inbox write path

### OUT
- No changes to PG mailbox system (keep as durable store)
- No changes to Claude Code's inbox reading logic
- No new messaging protocol
- No changes to tmux pane injection (keep as supplementary delivery)

## Decisions

| Decision | Rationale |
|----------|-----------|
| Fix bridge, don't replace | PG mailbox is durable store. Native inbox is real-time delivery. Both needed. |
| Multiple team discovery fallbacks | Different contexts (tmux, env var, worker registry) provide team info differently |
| Log errors, don't throw | Message send is best-effort for native bridge. PG delivery is the reliable path. |

## Success Criteria

- [ ] `genie send 'msg' --to engineer` delivers to Claude Code agent's native inbox
- [ ] Agent receives message in real-time (not just in PG mailbox)
- [ ] Bridge failures are logged with reason (not silent)
- [ ] Works when sender is outside tmux (e.g., from CLI)
- [ ] `bun run check` passes

## Execution Strategy

### Wave 1
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Fix native inbox bridge in msg.ts + claude-native-teams.ts |

## Execution Groups

### Group 1: Fix native inbox delivery bridge

**Goal:** Messages sent via `genie send` reliably reach Claude Code agent inboxes.

**Deliverables:**
1. In `src/term-commands/msg.ts` (around line 403-443):
   - Fix team name discovery chain: `GENIE_TEAM` env → `discoverTeamName()` → worker registry lookup → fail with log
   - Fix recipient name mapping: resolve genie worker ID to native team member name using team config's `members` array
   - Add `console.warn()` on bridge failure with the specific reason
2. In `src/lib/claude-native-teams.ts`:
   - Verify `writeNativeInbox()` writes the correct JSON schema that Claude Code reads
   - Add function `resolveNativeMemberName(team, genieWorkerId)` that maps worker IDs to native member names
   - Handle case where native team config doesn't exist (team not using native teams)
3. Tests:
   - Test team discovery fallback chain
   - Test recipient name mapping
   - Test inbox file format validation

**Acceptance Criteria:**
- [ ] Team discovered via env var, tmux, or registry
- [ ] Worker ID mapped to native member name
- [ ] Inbox file written in correct Claude Code format
- [ ] Bridge failure logged with reason

**Validation:**
```bash
bun test src/term-commands/msg.test.ts && bun test src/lib/claude-native-teams.ts && bun run typecheck
```

**depends-on:** none

---

## Files to Create/Modify

```
src/term-commands/msg.ts           — fix bridge delivery chain
src/term-commands/msg.test.ts      — bridge delivery tests
src/lib/claude-native-teams.ts     — name mapping + inbox format verification
```
