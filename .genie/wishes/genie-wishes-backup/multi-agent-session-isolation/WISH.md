# Multi-Agent Session Isolation — WhatsApp Multi-Agent Routing

**Status:** SHIPPED

## Summary
Enable clean multi-agent coexistence on a single WhatsApp number. When Omni routes different chats to different agents (Sofia vs Claudia), each agent's genie session must spawn in the correct tmux session. Currently all windows land in the wrong session because `genie spawn` ignores the `sessionName` from the provider config.

## Scope

### IN
- Genie #723: Add `--session` flag to `genie spawn` for tmux session targeting
- Omni #251: Pass `sessionName` from provider schema_config as `--session` to genie spawn
- Create proper routes for Claudia (Felipe DM, Cezar DM, Claudia's groups)
- End-to-end validation: same instance, different chats → different agents → different tmux sessions

### OUT
- No changes to route resolution logic (already works)
- No changes to agent_providers or agents tables (already configured)
- No new WhatsApp instances
- No changes to access rules

## GitHub Issues
- https://github.com/automagik-dev/genie/issues/723
- https://github.com/automagik-dev/omni/issues/251

## Success Criteria
- [ ] `genie spawn engineer --session sofia` creates window in `sofia` tmux session
- [ ] `genie spawn engineer --session claudia-whatsapp` creates window in `claudia-whatsapp` tmux session
- [ ] `genie spawn engineer --session nonexistent` creates the session, then the window
- [ ] `genie spawn engineer` (no --session) works as before (backwards compatible)
- [ ] Omni genie-client passes `sessionName` from provider config as `--session` flag
- [ ] Message to Leadership group → spawns in `sofia` session
- [ ] Message from Felipe DM (with Claudia route) → spawns in `claudia-whatsapp` session

## Execution Strategy

### Wave 1 (sequential — Genie first, Omni depends on it)
| Group | Agent | Repo | Description |
|-------|-------|------|-------------|
| 1 | engineer | genie | Add --session flag to genie spawn |
| 2 | engineer | omni | Pass sessionName as --session in genie-client |

### Wave 2
| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer | Create Claudia routes + end-to-end validation |

## Execution Groups

### Group 1: genie-spawn-session-flag
**Issue:** Genie #723
**Repo:** automagik-dev/genie
**Priority:** HIGH — blocks everything else
**Files:**
- `src/lib/tmux.ts` — `ensureTeamWindow()` needs to accept explicit session name
- `src/lib/team-auto-spawn.ts` — spawn logic, accept `--session` option
- `src/genie.ts` or `src/term-commands/agents.ts` — CLI argument parsing for `genie spawn`
- `src/lib/team-lead-command.ts` — pass session through to spawn

**Task:**
1. Add `--session <name>` option to `genie spawn` CLI command
2. When `--session` is provided, pass it to `ensureTeamWindow()` instead of using `getCurrentSessionName()`
3. If the specified session doesn't exist, create it with `tmux new-session -d -s <name>`
4. When `--session` is NOT provided, behavior is unchanged (backwards compatible)
5. The session name should flow: CLI arg → spawn options → ensureTeamWindow → tmux

**Acceptance Criteria:**
- [ ] `genie spawn team-lead --session sofia --team test` → window in `sofia` tmux session
- [ ] `genie spawn team-lead --team test` → works as before (getCurrentSessionName fallback)
- [ ] Session auto-created if missing

**Validation:**
```bash
bun test && bun run typecheck
```

---

### Group 2: omni-genie-client-session-passthrough
**Issue:** Omni #251
**Repo:** automagik-dev/omni
**Priority:** HIGH — completes the chain
**Files:**
- `packages/api/src/plugins/agent-dispatcher.ts` — `createGenieProviderInstance()` at ~L2645 and `createGenieClient()` call at L2663

**Task:**
In `createGenieProviderInstance()`, the `sessionName` is already extracted from `schemaConfig` (L2662):
```typescript
const sessionName = typeof schemaConfig.sessionName === 'string' ? schemaConfig.sessionName : undefined;
```

But it's only passed to `createGenieClient()` which uses it internally. The fix: ensure the genie-client's `spawn` command includes `--session <sessionName>` when calling `genie spawn`.

Look at the `GenieAgentProvider` or `createGenieClient` implementation — find where `genie spawn` is exec'd and add `--session ${sessionName}` to the args array.

Search for the genie-client implementation:
- `packages/api/src/providers/genie-client.ts` or similar
- Look for where `genie spawn` command is built

**Acceptance Criteria:**
- [ ] `genie spawn` command includes `--session sofia-whatsapp` when provider has `sessionName: "sofia-whatsapp"`
- [ ] `genie spawn` command includes `--session claudia-whatsapp` when provider has `sessionName: "claudia-whatsapp"`
- [ ] No `--session` flag when `sessionName` is not in schema_config

**Validation:**
```bash
cd packages/api && bun test
```

---

### Group 3: create-routes-and-validate
**Priority:** MEDIUM — operational setup after code fix
**Repo:** N/A (CLI commands only)

**Task:**
After Groups 1+2 are merged and deployed:

1. Create routes for Claudia:
```bash
# Felipe DM → Claudia
omni routes create --instance 4d1054ba --scope chat --chat febc95ba-28a4-40ed-9845-d00f4d9b128f --agent e2192be4-8b4c-4475-b6a2-f4af2e481bb1 --label "Felipe DM → Claudia" --priority 10

# Cezar DM → Claudia
omni routes create --instance 4d1054ba --scope chat --chat a477586a-0402-44b3-a6ed-ccb8d2f2c33b --agent e2192be4-8b4c-4475-b6a2-f4af2e481bb1 --label "Cezar DM → Claudia" --priority 10
```

2. Test route resolution:
```bash
omni routes test --instance 4d1054ba --chat febc95ba  # Should show claudia-pm
omni routes test --instance 4d1054ba --chat a477586a  # Should show claudia-pm
omni routes test --instance 4d1054ba --chat 274c8254  # Should show sofia-pm
```

3. End-to-end validation:
- Felipe sends DM → window spawns in `claudia-whatsapp` session
- Felipe sends in Leadership group → window spawns in `sofia` session
- Verify no cross-contamination

**Acceptance Criteria:**
- [ ] Routes created for Felipe DM and Cezar DM → Claudia
- [ ] Route test resolves correctly for all 3 chats
- [ ] End-to-end: different chats → different tmux sessions

**Validation:**
```bash
omni routes list --instance 4d1054ba
tmux list-windows -t sofia && tmux list-windows -t claudia-whatsapp
```

---

## Assumptions / Risks
| Risk | Severity | Mitigation |
|------|----------|------------|
| genie spawn --session changes break existing teams | Medium | Backwards compatible — no --session = old behavior |
| Omni genie-client spawn path is different from expected | Low | Trace from PM2 logs to find exact spawn command |
| Concurrent spawns in same session race | Low | tmux operations are serialized per-session |
