# Session Learnings — 2026-04-05 Genie-Omni QA

## What We Did
1. Loaded unified-executor-layer wish, reviewed implementation (PR #1063 merged)
2. Council review identified 4 gaps — fixed 2 critical ones (NATS reply path + migration numbering) → PR #1079
3. Attempted live QA with Sofia WhatsApp instance
4. Discovered the integration worked inbound (message → agent) but not outbound (agent → reply)
5. Root cause: agent didn't know to call `omni done` / didn't know verb commands existed
6. Proved CLI verbs work perfectly: say, speak, imagine, see, listen, react, done — all functional

## Pain Points (12 manual steps to get a reply)

| # | Step | Should have been automatic |
|---|------|---------------------------|
| 1 | `omni connect Sofia genie` | Didn't set `agentId` FK (only set `agentProviderId`) |
| 2 | Manual `--agent-fk-id` fix | `connect` should set this |
| 3 | Manual `--reply-filter-mode all` | `connect` should default to `all` for turn-based |
| 4 | `pm2 restart omni-api` (×3) | Config changes should take effect without restart |
| 5 | `genie omni start --executor sdk` | This step is correct |
| 6 | Agent spawned but no turn-based awareness | Needs system prompt injection |
| 7 | Agent responded but didn't call `done` | Needs turn-based instructions |
| 8 | Tried MCP tool approach — wrong path | CLI verbs are the right approach |
| 9 | `omni react` lost context between calls | Bug in context resolution |
| 10 | No way to see chat history with message IDs | Need `omni history` verb |
| 11 | Had to grep for message IDs to react | `history` would solve this |
| 12 | Skills didn't teach verb workflow | Taught `send --instance --to` instead |

## What Works
- **CLI verbs**: `say`, `speak`, `imagine`, `see`, `listen`, `react`, `done` — all functional
- **Env var context**: `OMNI_INSTANCE` + `OMNI_CHAT` + `OMNI_MESSAGE` recognized by context resolver
- **SDK executor**: spawns, registers in World A, captures session content, audit events
- **Lazy resume**: `findLatestByMetadata` + `claudeSessionId` reuse works
- **PG degraded mode**: bridge starts without PG
- **safePgCall**: wraps all PG calls with fallback

## Bug Found: `connect.ts` line 137
```typescript
// Current (broken):
await client.instances.update(instanceId, { agentProviderId: providerId });
// Missing: { agentId: agentId } ← the FK that triggers agent routing
// Missing: agentReplyFilter setting
```

## Bug Found: `react.ts` context resolution
- `react` verb can't find instance/chat from env vars in some cases
- `say` works fine with the same env vars
- Likely a PG stored context vs env var priority issue

## Key Insight: CLI > MCP for Agent Communication
The `done` MCP tool approach was wrong. Agents should use `omni` CLI verbs via Bash — they're full-featured, natural, and already work. The bridge just needs to:
1. Set env vars (`OMNI_INSTANCE`, `OMNI_CHAT`, `OMNI_MESSAGE`)
2. Inject a system prompt teaching verb commands
3. Let the agent use Bash to call `omni say/speak/imagine/react/history/done`
