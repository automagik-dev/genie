# Design: Codex First-Class Integration — CLI-Native Channels

| Field | Value |
|-------|-------|
| **Slug** | `codex-first-class-integration` |
| **Date** | 2026-04-27 (revised) |
| **Status** | DESIGN (post-pivot, ready for /wish) |
| **WRS** | 100/100 |
| **Source** | `git clone https://github.com/openai/codex` survey + Anthropic Channels research, both 2026-04-27 |
| **Supersedes** | The 2026-04-27 morning version of this file (SDK-driven model). That framing was rejected by Felipe in favor of CLI-native primitives. |

## Problem

Genie integrates with codex by treating the CLI as a black box: pane scraping for state, OTel relay snapshots, manual `~/.codex/sessions/*.jsonl` parsing, and `tmux send-keys` for runtime delivery. Codex agents are second-class — `genie log` returns 0 events, `genie sessions` doesn't see codex sessions, `genie send` falls back to PG-only delivery, state detection is regex-on-pane-text.

A research pass on `openai/codex` revealed **codex has the same hook system claude has** — identical event taxonomy (`PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `SessionStart`, `Stop`, `PermissionRequest`), identical wire shape (JSON on stdin, `hookSpecificOutput.additionalContext` on stdout), and a TOML config surface (`~/.codex/config.toml`) that's a near-mirror of claude's `settings.json`. **Codex's hook bridge is the integration point.** It's already a one-way mirror of claude's `genie hook dispatch` shim.

Concurrently, Anthropic shipped Claude Code Channels — a structured envelope (`<channel source="X" meta_k=v>body</channel>`) plus an MCP-server transport that lets external systems inject messages into Claude turns. The envelope semantics are excellent. The transport is not for us.

## Constraints (Felipe-set, not negotiable)

1. **CLI-first.** Genie is a CLI tool. Claude Code MUST NOT load MCP servers as plugins. Anything we ship must be operable by humans typing genie commands and by agents calling genie commands; no third-party MCP transport.
2. **Use what we have.** `genie send`, `genie inbox list`, `genie history`, `genie events`, `~/.claude/teams/<team>/inboxes/<agent>.json`, the PG `mailbox` table — these are the canonical primitives. Don't invent parallel ones.
3. **No tmux send-keys for runtime delivery.** Spawn-time send-keys (terminal init, cd + launch, TUI keybindings) is fine. Mid-turn injection of user input via `tmux send-keys` is not.
4. **Channels SEMANTICS yes, Channels TRANSPORT no.** The envelope (`<channel source="X" meta_k=v>body</channel>`) is a clean way to attribute external sources (whatsapp, telegram, system, webhooks). Adopt the envelope. Don't adopt the MCP wire.
5. **Genie becomes the channel server externally.** External integrations (telegram, webhook, discord, future clients) live as genie subcommands or external processes that talk to genie's CLI. They write to the same native inbox file or PG mailbox that peer agents use. Claude Code never loads them as plugins.

## Approach

A single delivery substrate. Multiple sources attribute themselves via a structured envelope.

### The substrate (already built)

```
┌──────────────────────────────────────────────────────────────────┐
│ Sources (attribute themselves via `source` field)                │
│   peer agent     ── genie send                       (source=agent)
│   omni/whatsapp  ── omni→claude bridge               (source=whatsapp)
│   system nudge   ── injectNudge                      (source=system)
│   external (F+)  ── telegram/webhook/discord adapter (source=*)  │
└──────────────────────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────────────┐
│ Delivery layer (one of two paths, BOTH native)                    │
│                                                                   │
│   PATH 1 — claude recipients:                                     │
│     writeNativeInbox(team, agent, NativeInboxMessage)             │
│       → ~/.claude/teams/<team>/inboxes/<agent>.json               │
│       → Claude Code reads on next turn via SendMessage tool       │
│                                                                   │
│   PATH 2 — codex recipients:                                      │
│     mailbox.send(repo, from, to, body)                            │
│       → PG mailbox row                                            │
│       → codex's UserPromptSubmit hook (via genie hook dispatch)   │
│         reads pending mailbox rows for the recipient and returns  │
│         them as additionalContext on the next turn                │
└──────────────────────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────────────┐
│ Recipient consumes the envelope                                   │
│   <channel source="whatsapp" from="+5511..." chat_id="...">       │
│     hey can you pull the latest report                            │
│   </channel>                                                      │
│                                                                   │
│   The agent (claude or codex) sees the source and decides how to  │
│   route the response. Replies go back via genie send / mailbox    │
│   primitives — no tmux send-keys, no MCP.                         │
└──────────────────────────────────────────────────────────────────┘
```

### What's already shipped (validated 2026-04-27)

| Surface | Status |
|---------|--------|
| `genie send` peer-agent delivery via `writeNativeInbox` | ✅ Working |
| PG mailbox with NOTIFY-driven instant delivery | ✅ Working |
| Claude hook bridge (`genie hook dispatch`) writing to `runtime_events` | ✅ Working |
| Codex hook bridge (`~/.codex/config.toml` injection) — PR #1424 | ✅ Shipped 4.260427.9 |
| Empirical end-to-end round-trip via codex hooks | ✅ Validated (hookbridge-test) |
| Codex state detection via shared `detectCodexState` (Group 1) | ✅ Shipped 4.260427.7 |
| Native team registration for codex agents (Group 3) | ✅ Shipped 4.260427.7 |
| Codex prompt flag honored at spawn (Group 11) | ✅ Shipped 4.260427.7 |

### What's missing (the work this design captures)

| Gap | Resolution |
|-----|-----------|
| Mailbox messages have no source attribution — every peer/external/system message looks like an `agent` | **PR A**: extend `mailbox.send` and `NativeInboxMessage` with optional `source` + `meta`; default `source='agent'` for back-compat. |
| Codex hook is configured (PR #1424) but no handler reads pending mailbox messages on `UserPromptSubmit` | **PR B**: `src/hooks/handlers/codex-inbox-deliver.ts` — reads PG mailbox for the recipient codex agent and returns `additionalContext`. |
| Omni→claude turns arrive via `tmux send-keys` (`claude-code.ts:deliver`) | **PR C**: replace with `writeNativeInbox(..., {source: 'whatsapp', meta: {...}})`. |
| System nudges arrive via `tmux send-keys` (`claude-code.ts:injectNudge`) | **PR D**: replace with `writeNativeInbox(..., {source: 'system'})`. |
| `protocol-router.ts:injectToTmuxPane` fallback exists for "non-native-team" workers | **PR E**: remove entirely after metrics confirm zero traffic. |
| External integrations (telegram, webhook, discord) have no canonical entry point | **PR F+** (later): `genie channel <kind> ...` subcommand family that writes to native inbox / PG mailbox with the appropriate `source` envelope. |

## Decisions

| Decision | Rationale |
|----------|-----------|
| **Channel envelope** = `<channel source="X" from="Y" k="v">body</channel>` rendered into the message text on delivery | Captures provenance without schema churn for downstream consumers. Claude/codex agents see human-readable XML-ish text and can choose to react to specific sources. Round-trippable for debugging. |
| **`source` defaults to `'agent'`** when not supplied | Zero migration cost for existing callers. Today's `genie send` between two agents continues delivering plain bodies. |
| **Two columns on `mailbox`: `source TEXT NOT NULL DEFAULT 'agent'`, `meta JSONB NOT NULL DEFAULT '{}'`** | Source is high-cardinality enough for indexing if we ever need it; meta is loose key/value (chat IDs, phone numbers, webhook origins) that we don't want to schematize. |
| **Codex handler** is a single new file `src/hooks/handlers/codex-inbox-deliver.ts` invoked by `genie hook dispatch` when the event type is `UserPromptSubmit` AND the provider is codex | Keeps the dispatcher generic. The handler is opt-in by event-type matching, not gated by config. |
| **`additionalContext` payload** = newline-joined channel envelopes, oldest first, marked `read` after the hook responds successfully | Matches codex's contract (`hookSpecificOutput.additionalContext` is a string). Marking read after the hook returns prevents double-injection if the hook re-fires for the same turn. |
| **No SDK integration** in this wave | Felipe's directive: stateful CLI codex first. The SDK (`@openai/codex-sdk`) is captured as a future option for headless workers. The hook bridge gives us 90% of the value with zero SDK dependency. |
| **No new schema beyond `source`/`meta`** | Reuse `mailbox`, `runtime_events`, `executors`, `agents`. Schema work is the most expensive thing to undo; we earn that work later only if we hit a hard wall. |
| **`genie inbox list` rendering** prepends `[<source>]` for non-default sources | Operator gets visibility without losing the existing layout. JSON output exposes the raw `source` and `meta` for tools. |
| **`genie channel <kind>` subcommand** is OUT for v1 | F+ work. The substrate must exist (PRs A–E) before we add the first external adapter. We don't ship interfaces ahead of consumers. |

## Risks & assumptions

| Risk | Severity | Mitigation |
|------|----------|------------|
| Channel envelope breaks downstream parsers that assume plain text | Low | Source defaults to `'agent'` → plain body; envelope only wraps when source is set explicitly. Existing peer-agent traffic is untouched. |
| Codex hook can timeout if mailbox query is slow | Low | Hook timeout is 15s (PR #1424). PG queries on `mailbox WHERE to_worker = X AND read = false` are sub-millisecond. Still: budget the hook to ≤500ms; bail with empty additionalContext on timeout. |
| Two-source race — codex hook fires while `genie send` is mid-write | Low | PG mailbox is the authoritative ordering; the trigger fires `pg_notify` after row commit. Read-then-mark-read is transactional. |
| Operator confusion about which path serves which recipient (claude=file, codex=hook) | Medium | Document in `genie docs` and the wish QA section. The CLI surface stays uniform — operators always use `genie send`; the routing is internal. |
| External adapters (PR F+) re-introduce coupling we don't want | Medium | Adapters MUST write to the substrate (PG mailbox or native inbox) via the same primitives. They never bypass to tmux send-keys. CI lint can catch direct `executeTmux` calls in adapter packages. |
| Removing `injectToTmuxPane` (PR E) breaks an undocumented edge case | Medium | Stage with metric: log a counter on every `injectToTmuxPane` call. Run for one minor release. Remove only when counter is zero across production for that window. |
| Channel envelope conflicts with existing message body containing `<channel>` text | Very Low | Render only when `source !== 'agent'`. Agents that want to spoof a channel envelope can't via plain `genie send`. |

## Success criteria

- [ ] **PR A merged**: `mailbox.send` + `NativeInboxMessage` carry optional `source` + `meta`; PG migration adds the columns; `genie inbox list` renders the source tag; full unit test coverage; back-compat verified (existing callers untouched).
- [ ] **PR B merged**: codex agents receive pending mailbox messages on `UserPromptSubmit` via `genie hook dispatch`; round-trip works for two consecutive turns (mark-read prevents replay); empirical proof: `genie send 'X' --to <codex>` followed by codex's next turn shows X as additionalContext.
- [ ] **PR C merged**: omni→claude bridge writes via `writeNativeInbox` with `source='whatsapp'` and `meta={chat_id, sender_phone, ...}`; no `tmux send-keys` in the omni delivery path; existing whatsapp turns continue working with no operator-visible change.
- [ ] **PR D merged**: system nudges write via `writeNativeInbox` with `source='system'`; no `tmux send-keys` in the nudge path.
- [ ] **PR E merged**: `protocol-router.ts:injectToTmuxPane` removed; `executeTmux` send-keys callsites in `src/lib/protocol-router.ts` and `src/lib/providers/claude-code.ts` reduced to spawn-time only (terminal init, TUI keybindings).
- [ ] **Round-trip parity test**: `genie send '<channel source="whatsapp" chat_id="X">hi</channel>' --to <claude>` and `… --to <codex>` both deliver the structured envelope into the recipient's next turn, with the source visible in the agent's prompt.

## Wave plan (proposed for the wish)

### Wave 1 — Foundation (PR A)
| Group | Description |
|-------|-------------|
| A1 | PG migration `054_mailbox_source_meta.sql`: `source TEXT DEFAULT 'agent'` + `meta JSONB DEFAULT '{}'`. |
| A2 | `mailbox.send(..., opts?: {source, meta})` plumbing; `MailboxMessage`/`rowToMessage` carry the fields; `NativeInboxMessage` adds the same. |
| A3 | `src/lib/channel-envelope.ts` — `formatEnvelope` + `parseEnvelope` pure functions; tests. |
| A4 | `toNativeInboxMessage` adapter wraps non-default-source bodies with the envelope. |
| A5 | `genie inbox list` renders source tag; JSON output includes source/meta. |

### Wave 2 — Codex receive (PR B, depends on A)
| Group | Description |
|-------|-------------|
| B1 | `src/hooks/handlers/codex-inbox-deliver.ts` — invoked by dispatcher when event=UserPromptSubmit. |
| B2 | Resolves recipient codex agent → PG mailbox unread query. |
| B3 | Returns `additionalContext` = newline-joined channel envelopes; marks delivered messages `read`. |
| B4 | Test: end-to-end round-trip with a stub codex hook payload. |

### Wave 3 — tmux migrations (PRs C+D, depends on A; can ship in parallel)
| Group | Description |
|-------|-------------|
| C | Migrate `claude-code.ts:deliver` (omni→claude) from tmux send-keys to `writeNativeInbox({source:'whatsapp', meta:{chat_id, sender_phone}})`. |
| D | Migrate `claude-code.ts:injectNudge` from tmux send-keys to `writeNativeInbox({source:'system'})`. |

### Wave 4 — Cleanup (PR E, depends on A–D)
| Group | Description |
|-------|-------------|
| E1 | Add a counter metric to `injectToTmuxPane`. Ship for one release. Verify zero hits. |
| E2 | Remove `injectToTmuxPane` and its callsites in `protocol-router.ts`. |
| E3 | Update tests; update docs. |

### Wave 5 — External adapters (PR F+, optional, deferred)
| Group | Description |
|-------|-------------|
| F1 | `genie channel webhook start --port <p>` — HTTP endpoint that writes to PG mailbox with `source='webhook', meta={origin, headers}`. |
| F2 | `genie channel telegram start` — telegram bot listener using the same write primitive. |
| F3 | `genie channel discord start` — same pattern. |

## Migration path for in-flight codex agents

1. Today's codex agents (genie-8b0e, sec-install-guard-codex, hookbridge-test) work because PR #1424 already wired the hook bridge. PR B simply adds the missing handler.
2. PR A is back-compat by default (source defaults to 'agent') — no in-flight agent sees a change.
3. PRs C+D migrate sources transparently — operators see the same delivered text; they just observe the source tag in `genie inbox list`.
4. PR E is the only behavioral change for non-native-team workers, and only after the metric confirms safety.

## Files to create/modify

```
NEW:
  src/db/migrations/054_mailbox_source_meta.sql           # PR A
  src/lib/channel-envelope.ts                             # PR A
  src/lib/channel-envelope.test.ts                        # PR A
  src/hooks/handlers/codex-inbox-deliver.ts               # PR B
  src/hooks/handlers/codex-inbox-deliver.test.ts          # PR B

MODIFY:
  src/lib/mailbox.ts                                      # PR A (send signature + types)
  src/lib/mailbox.test.ts                                 # PR A
  src/lib/claude-native-teams.ts                          # PR A (NativeInboxMessage)
  src/lib/claude-native-teams.test.ts                     # PR A
  src/term-commands/agent/inbox.ts                        # PR A (source tag in render)
  src/term-commands/agent/inbox.test.ts                   # PR A
  src/hooks/dispatch.ts                                   # PR B (route UserPromptSubmit codex)
  src/lib/providers/claude-code.ts                        # PR C (omni delivery) + PR D (injectNudge)
  src/lib/providers/claude-code.test.ts                   # PRs C+D
  src/lib/protocol-router.ts                              # PR E (remove injectToTmuxPane)
  src/lib/protocol-router.test.ts                         # PR E
```

## Empirical proof of CLI-native delivery (validated 2026-04-27)

The `hookbridge-test` codex session proved the substrate works end-to-end with zero tmux and zero MCP:

```
genie@felipe (orchestrator):
  $ genie send "Reply with the single word: pong" --to hookbridge-test
  → PG mailbox msg #894

hookbridge-test (codex agent, fresh spawn):
  startup → genie inbox list hookbridge-test     # found pending message
  startup → genie send 'pong' --to genie         # replied via native CLI
  → PG mailbox msg #895
```

This is the substrate working with `source='agent'` (today's default). PR A adds source attribution; PR B closes the codex receive loop programmatically (no startup-script lookup required); PRs C/D/E migrate the remaining tmux runtime callsites; PR F+ adds the external adapters that motivated the channel envelope in the first place.

## What this design DOES NOT do

- Adopt `@openai/codex-sdk` — captured as a future option, not in scope.
- Adopt MCP transport for channel delivery — explicitly rejected.
- Reimplement `genie hook dispatch` — the dispatcher is the same shim claude and codex both call.
- Touch the agent identity / signing layer — codex's `agent_runtime_id` integration is a separate, larger design.
- Add new transport (UDS, gRPC, app-server) — PG NOTIFY + filesystem inbox is sufficient.

## Provenance

- **Codex source survey**: `/tmp/codex-research/codex/` (depth=1 clone of `openai/codex`).
  - `codex-rs/hooks/` — confirmed identical event taxonomy to claude.
  - `codex-rs/exec/src/exec_events.rs` — JSONL event protocol (kept for future SDK option).
  - `codex-rs/app-server-protocol/` — JSON-RPC daemon (blocked by missing `bubblewrap` on host; deferred).
- **Hook bridge proof**: `/tmp/codex-research/test-hook.sh` and `hook-events.log` — captured `UserPromptSubmit` payload from a real codex turn; verified `additionalContext` round-trips.
- **Channels research**: Anthropic's Claude Code Channels documentation (2026-04-27 release).
- **Save state**: `/home/genie/workspace/agents/genie/brain/save-state-2026-04-27-codex-channels.md` — captures session-level architectural decisions and live empirical validation.
- **Today's shipped versions**: `@automagik/genie@next` 4.260427.6 → 4.260427.9 (8 PRs, including #1424 codex hook config injection).
