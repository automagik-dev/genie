# Wish: Omni Turn-Based DX — Zero-Config Agent Sandbox

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `omni-turn-based-dx` |
| **Date** | 2026-04-06 |
| **Repo** | `automagik-dev/omni` (primary), `automagik-dev/genie` (bridge-side) |
| **Learnings** | [QA session 2026-04-05](../../brainstorms/omni-turn-based-dx/SESSION-LEARNINGS.md) |

## Summary

Connecting a genie agent to a WhatsApp number via Omni required 12 manual steps and three debug cycles. This wish makes it one command: `omni connect Sofia genie` — the agent spawns sandboxed inside the chat with full context, replies via `omni say`, reads history via `omni history`, and closes turns via `omni done`. No `omni use`/`omni open` needed, no manual `agentId` FK, no restart required.

## What It Does (User Perspective)

```bash
# Step 1: Connect (one command, zero config)
omni connect Sofia genie
# ✓ Connected Sofia → genie (turn-based)
#   agentId: 9b50822b, replyFilter: all, provider: nats-genie
#   Bridge: genie omni start --executor sdk

# Step 2: Start bridge
genie omni start --executor sdk

# Step 3: Send WhatsApp message to Sofia's number
# → Agent spawns sandboxed in the chat
# → Agent sees: "You're in a WhatsApp DM with Felipe Rosa. Use omni say/speak/imagine to reply."
# → Agent runs: omni history --limit 5 (sees recent messages with IDs)
# → Agent runs: omni say "Hey Felipe!" (just works — context pre-set via env)
# → Agent runs: omni react "👍" --message <id> (from history)
# → Agent runs: omni done (closes turn, ready for next message)
```

The agent is **sandboxed** — it can't `omni open` a different chat or `omni use` a different instance. All verb commands read context from `OMNI_INSTANCE` + `OMNI_CHAT` + `OMNI_MESSAGE` env vars set by the bridge.

## Scope

### IN

1. **Fix `omni connect`** — set `agentId` (FK), `agentReplyFilter: all`, start reply subscription, no restart needed
2. **`omni history` verb** — read conversation messages with IDs, sender, type, content (incl. transcription + filepath for media), limit + pagination
3. **Agent sandbox prompt injection** — bridge injects turn-based system prompt telling the agent how to use omni verbs, what chat it's in, and that it must call `done`
4. **Fix `react` verb context** — `react` should resolve `OMNI_INSTANCE`/`OMNI_CHAT` from env vars like `say` does (bug: context lost between verb calls)
5. **Genie omni rules update** — update `~/.claude/rules/omni-messaging.md` and `~/.claude/rules/agent-superpowers.md` to teach verb workflow (`say`/`speak`/`history`/`done`) instead of low-level `send --instance --to`

### OUT

- NATS reply path changes (shipped in PR #1079, works, agents use CLI verbs)
- MCP `done` tool approach (abandoned — agents use `omni done` CLI via Bash)
- `film` verb fix (upstream Gemini API limitation)
- Multi-agent per-instance routing (separate wish)
- Changes to the tmux executor (this wish is SDK executor only)
- Omni server API changes (all changes are CLI + bridge side)

## Decisions

| Decision | Rationale |
|----------|-----------|
| Agents use `omni` CLI verbs via Bash, not MCP tools | CLI is full-featured (say, speak, imagine, see, listen, react, done), already works, no new protocol needed. MCP `done` tool required agent to know a special protocol — CLI verbs are natural. |
| Sandbox via env vars, not filesystem isolation | `OMNI_INSTANCE` + `OMNI_CHAT` + `OMNI_MESSAGE` already recognized by all verb commands. Bridge sets them on spawn. Agent can't escape because env vars are process-scoped. |
| System prompt injection for turn-based awareness | The agent needs to know: (1) it's in a WhatsApp chat, (2) use `omni say` to reply, (3) use `omni history` to see messages, (4) call `omni done` when finished. This is a ~10 line prompt prepended by the bridge. |
| `omni history` as a new verb, not extending `chats` | `chats list` is for listing conversations. `history` is for reading messages in the current chat — different UX. SDK already has `client.chats.getMessages()`. |
| `connect` sets everything in one call | Today it sets `agentProviderId` but not `agentId`, doesn't set `replyFilter`, and requires restart. Fix: set all three + emit NATS reconnect signal. |
| Keep `omni use`/`omni open` for humans | These are useful for manual CLI usage. But agents in turn-based mode never need them — env vars handle context. |

## Success Criteria

- [ ] `omni connect Sofia genie` sets `agentId` FK, `agentReplyFilter: {mode: 'all'}`, and starts reply subscription — no restart needed
- [ ] `omni connect` output shows all configured values (agentId, replyFilter, provider, NATS topics)
- [ ] `omni history` shows last N messages in current chat with: external ID, timestamp, sender name, message type, content text (or transcription for audio), media file path
- [ ] `omni history --limit 20 --before <msg-id>` paginates correctly
- [ ] `omni history` works with `OMNI_INSTANCE` + `OMNI_CHAT` env vars (no `omni use`/`omni open` needed)
- [ ] `omni react "👍" --message <id>` works with `OMNI_INSTANCE` + `OMNI_CHAT` env vars
- [ ] Bridge injects turn-based system prompt when spawning SDK executor
- [ ] Agent spawned via bridge can `omni say "hello"` and message arrives on WhatsApp
- [ ] Agent spawned via bridge can `omni history` and see the conversation
- [ ] Agent spawned via bridge calls `omni done` and turn closes
- [ ] Full round-trip: WhatsApp → Omni → NATS → Bridge → SDK agent → `omni say` → WhatsApp reply
- [ ] Genie omni skill documents the verb workflow
- [ ] `bun run check` passes in both repos

## Execution Strategy

### Wave 1 (parallel — no dependencies)

| Group | Agent | Repo | Description |
|-------|-------|------|-------------|
| 1 | engineer | omni | Fix `omni connect` — set agentId FK + replyFilter + verify reply subscription |
| 2 | engineer | omni | New `omni history` verb command |
| 3 | engineer | omni | Fix `react` verb context resolution from env vars |

### Wave 2 (after Wave 1)

| Group | Agent | Repo | Description |
|-------|-------|------|-------------|
| 4 | engineer | genie | Agent sandbox: bridge injects turn-based system prompt with verb instructions |
| 5 | engineer | genie | Update genie omni skill to teach verb workflow |

### Wave 3 (integration)

| Group | Agent | Description |
|-------|-------|-------------|
| 6 | qa | End-to-end QA: `omni connect` → bridge start → WhatsApp message → agent replies via verbs → done |
| review | reviewer | Review all groups against success criteria |

## Execution Groups

### Group 1: Fix `omni connect` — Zero-Config Setup

**Goal:** `omni connect <instance> <agent>` fully configures the instance for turn-based agent routing with no manual steps.

**Deliverables:**
1. In `packages/cli/src/commands/connect.ts`:
   - After creating agent record, call `client.instances.update(instanceId, { agentId })` (not just `agentProviderId`)
   - Set `agentReplyFilter: { mode: 'all', conditions: {} }` on the instance
   - Verify the NATS genie provider has reply subscription started
   - Add `--mode <turn-based|fire-and-forget>` option (default: `turn-based`)
   - When `turn-based`: also set `triggerMode: 'round-trip'`
   - Print summary: agentId, replyFilter, provider, NATS topics, next step
2. Add `--reply-filter <all|filtered>` option to override default
3. Test: `connect.test.ts` — verify agentId and replyFilter are set

**Acceptance Criteria:**
- [ ] `omni connect <inst> <agent>` sets `agentId` FK on instance (not null)
- [ ] `omni connect <inst> <agent>` sets `agentReplyFilter: {mode: 'all'}` by default
- [ ] Output shows all configured values
- [ ] No restart needed — agent assignment takes effect immediately
- [ ] Re-running `omni connect` is idempotent (finds existing provider/agent)

**Validation:**
```bash
cd omni && bun test packages/cli/src/__tests__/connect.test.ts
omni connect <test-instance> genie && omni instances get <test-instance> | grep agentId
```

**depends-on:** none

---

### Group 2: `omni history` Verb Command

**Goal:** Agents (and humans) can read conversation messages with all metadata needed for reactions, replies, and context.

**Deliverables:**
1. New file `packages/cli/src/commands/history.ts`:
   - Uses context resolution (env vars > PG context > config) for instance + chat
   - Calls `client.chats.getMessages(chatId, { limit, before })` 
   - Formats output as table: `ID | TIME | SENDER | TYPE | CONTENT`
   - For media messages: show transcription (if available) + file path
   - `--limit <n>` (default 10)
   - `--before <msg-id>` for pagination
   - `--json` for machine-readable output
   - `--full` to show complete content (default truncates to 80 chars)
2. Register in `packages/cli/src/index.ts` as verb command
3. Test with mock client

**Acceptance Criteria:**
- [ ] `omni history` shows last 10 messages in active chat
- [ ] Each row has: external message ID, timestamp, sender display name, type (text/image/audio/video/document), content preview
- [ ] Audio messages show transcription text
- [ ] Media messages show file path
- [ ] `--limit 20` works
- [ ] `--before <id>` paginates (shows messages before that ID)
- [ ] `--json` outputs array of message objects
- [ ] Works with `OMNI_INSTANCE` + `OMNI_CHAT` env vars (no `omni use`/`omni open` needed)

**Validation:**
```bash
cd omni && bun test packages/cli/src/__tests__/history.test.ts
OMNI_INSTANCE=<id> OMNI_CHAT=<id> omni history --limit 5
```

**depends-on:** none

---

### Group 3: Fix `react` Verb Context Resolution

**Goal:** `omni react` resolves instance/chat from env vars like all other verb commands.

**Deliverables:**
1. In `packages/cli/src/commands/react.ts`:
   - Debug why `resolveContext()` returns null for instance when env vars are set but `omni use` was called in a different process
   - The bug is likely that `resolveContext` checks PG stored context first and finds stale/different data, or env var names don't match
   - Ensure `OMNI_INSTANCE` and `OMNI_CHAT` env vars take priority over PG stored context
2. Verify all verb commands (`say`, `speak`, `imagine`, `see`, `listen`, `react`, `done`) use the same context resolution order: CLI flags > env vars > PG context > config
3. Test: set env vars, run `omni react` without `omni use`/`omni open`

**Acceptance Criteria:**
- [ ] `OMNI_INSTANCE=<id> OMNI_CHAT=<id> omni react "👍" --message <id>` works
- [ ] Context resolution order is consistent across all verb commands
- [ ] No regression in PG stored context path (humans using `omni use`/`omni open`)

**Validation:**
```bash
cd omni && bun test packages/cli/src/__tests__/react.test.ts
OMNI_INSTANCE=<id> OMNI_CHAT=<id> OMNI_MESSAGE=<id> omni react "✅"
```

**depends-on:** none

---

### Group 4: Agent Sandbox — Turn-Based System Prompt Injection

**Goal:** SDK executor spawns agents with a system prompt that teaches turn-based WhatsApp behavior.

**Deliverables:**
1. In genie's `src/services/executors/claude-sdk.ts`, in `_processDelivery()`:
   - Before calling `state.provider.runQuery()`, prepend a turn-based prompt to the system prompt
   - The prompt includes:
     - "You are in a WhatsApp conversation with {sender name}"
     - "Your instance: {OMNI_INSTANCE}, your chat: {OMNI_CHAT}"
     - "Available commands: `omni say 'text'`, `omni speak 'text'`, `omni imagine 'prompt'`, `omni react 'emoji' --message <id>`, `omni history`, `omni done`"
     - "ALWAYS call `omni done` when you're finished responding"
     - "NEVER use `omni use` or `omni open` — you're already in the right context"
   - The prompt is only injected on the first message (first turn, no `claudeSessionId` yet) or when system prompt is being sent
2. Store the turn-based prompt template in a separate file: `src/services/executors/turn-based-prompt.ts`
3. Fixed template — no config needed; override by editing the template file directly

**Acceptance Criteria:**
- [ ] Agent spawned via bridge receives turn-based system prompt
- [ ] Prompt includes sender name, available commands, `done` requirement
- [ ] Agent can successfully call `omni say` from within the session
- [ ] Agent calls `omni done` to close the turn
- [ ] Prompt is only injected once (not repeated on resume)

**Validation:**
```bash
cd genie && bun test src/services/executors/__tests__/claude-sdk.test.ts
# Manual: start bridge, send WhatsApp message, verify agent calls omni say + done
```

**depends-on:** Groups 1-3 (agent needs working verbs to use them)

---

### Group 5: Update Genie Omni Rules

**Goal:** Global agent rules teach the verb-based workflow instead of low-level `send --instance --to`.

**Deliverables:**
1. Update `~/.claude/rules/omni-messaging.md`:
   - Replace `omni send --instance <id> --to <jid> --text "<message>"` with verb workflow
   - Document: `omni say`, `omni speak`, `omni imagine`, `omni react`, `omni history`, `omni done`
   - Document turn-based sandbox: env vars pre-set, no `omni use`/`omni open` needed in agent context
   - Document `omni connect` as zero-config setup
   - Add common patterns: react to a message, reply with voice, describe an image
2. Update `~/.claude/rules/agent-superpowers.md`:
   - Add `omni history` to the tool table
   - Update the communication section with verb commands
3. Add turn-based agent lifecycle: receive → `omni history` → reply via verbs → `omni done`

**Acceptance Criteria:**
- [ ] `omni-messaging.md` documents verb workflow with examples
- [ ] `agent-superpowers.md` includes `omni history` in tool table
- [ ] No references to manual `--instance`/`--to` for turn-based context
- [ ] Turn-based agent lifecycle documented: receive → history → reply → done

**Validation:**
```bash
grep -c "omni say\|omni speak\|omni history\|omni done" ~/.claude/rules/omni-messaging.md
# Expected: > 0
```

**depends-on:** Groups 1-3

---

### Group 6: End-to-End QA

**Goal:** Prove the full turn-based flow works from `omni connect` to WhatsApp reply.

**Deliverables:**
1. QA test plan at `.genie/wishes/omni-turn-based-dx/QA-PLAN.md`
2. Execute:
   - Clean slate: remove all routes/agents from test instance
   - `omni connect <instance> genie` — verify agentId, replyFilter set
   - `genie omni start --executor sdk` — bridge starts
   - Send WhatsApp message — agent spawns with turn-based prompt
   - Agent calls `omni history` — sees conversation
   - Agent calls `omni say "reply"` — message arrives on WhatsApp
   - Agent calls `omni react "👍"` — reaction appears
   - Agent calls `omni done` — turn closes
   - Send another message — lazy resume works, agent remembers context
3. Evidence captured in QA-PLAN.md

**Acceptance Criteria:**
- [ ] All steps pass
- [ ] WhatsApp messages received by human
- [ ] `genie sessions list --source omni` shows the session
- [ ] `genie events list` shows audit trail

**Validation:**
```bash
cat .genie/wishes/omni-turn-based-dx/QA-PLAN.md | grep -c "PASS"
```

**depends-on:** Groups 1-5

---

## Dependencies

```
Wave 1 (parallel, omni repo)
  Group 1 (fix connect)      ──┐
  Group 2 (history verb)      ─┤
  Group 3 (fix react context)  ┤
                                │
Wave 2 (genie repo)             │
  Group 4 (sandbox prompt) ←───┘
  Group 5 (skill update) ←─────┘

Wave 3 (integration)
  Group 6 (e2e QA) ←── Groups 1-5
  Review ←── all
```

## QA Criteria

### Functional
- [ ] `omni connect <inst> <agent>` is one-command setup (no manual FK, no restart)
- [ ] `omni history` shows messages with IDs, content, media paths
- [ ] `omni react` works with env vars
- [ ] Agent spawned via bridge replies via `omni say` and message arrives on WhatsApp
- [ ] Agent calls `omni done` and turn closes

### Integration
- [ ] Full round-trip: WhatsApp → Omni → NATS → Bridge → SDK → `omni say` → WhatsApp
- [ ] `genie sessions list --source omni` tracks the session
- [ ] `genie events timeline <executor-id>` shows audit trail
- [ ] Lazy resume works across bridge restarts

### Regression
- [ ] `omni connect` still works for existing providers (idempotent)
- [ ] `omni use`/`omni open` still work for human CLI usage
- [ ] All existing verb commands unchanged for non-turn-based usage
- [ ] `bun run check` passes in both repos

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| `client.chats.getMessages()` may not return transcriptions | Medium | Check API response shape; if missing, add transcription field to messages API |
| Agent may not call `omni done` reliably | Medium | System prompt explicitly requires it; add timeout fallback in bridge |
| `omni connect` restart-free requires hot-reload of NATS provider | Medium | May need a NATS reconnect signal or provider reload endpoint |
| Agent sandbox can be escaped via `omni use` | Low | Document as unsupported; true isolation would need CLI flag `--sandboxed` that rejects `use`/`open` |

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
# Omni repo (automagik-dev/omni)
packages/cli/src/commands/connect.ts        (modify — fix agentId + replyFilter)
packages/cli/src/commands/history.ts        (new — history verb)
packages/cli/src/commands/react.ts          (modify — fix context resolution)
packages/cli/src/index.ts                   (modify — register history command)
packages/cli/src/__tests__/connect.test.ts  (modify — test agentId setting)
packages/cli/src/__tests__/history.test.ts  (new — history tests)
packages/cli/src/__tests__/react.test.ts    (modify — env var context test)

# Genie repo (automagik-dev/genie)
src/services/executors/claude-sdk.ts              (modify — inject turn-based prompt)
src/services/executors/turn-based-prompt.ts       (new — prompt template)
src/services/executors/__tests__/claude-sdk.test.ts (modify — test prompt injection)

# Global agent rules
~/.claude/rules/omni-messaging.md                  (modify — verb workflow)
~/.claude/rules/agent-superpowers.md               (modify — add history verb)

# This workspace (planning artifacts)
.genie/wishes/omni-turn-based-dx/WISH.md          (this file)
.genie/wishes/omni-turn-based-dx/QA-PLAN.md       (Group 6 output)
```
