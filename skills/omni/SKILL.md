---
name: omni
description: "Wire a Genie agent to an Omni channel in one canonical flow — register the agent, bind to an instance, verify the round-trip. Replaces the 5+ command legacy chain."
allowed-tools: Bash(omni *), Bash(genie *)
---

# /genie:omni — Canonical Genie ↔ Omni Wiring

Single-command wizard that takes an operator from "no agent yet" (or "an existing genie agent") to "agent answering messages on a channel". Wraps `genie agent register` + `omni connect` + verification into one conversational flow so operators don't have to remember two systems' command surfaces.

## When to Use

- Adding a new agent to a connected Omni channel.
- Wiring an existing genie agent dir to a fresh Omni instance.
- Verifying that an existing wire still works end-to-end.
- Operator types `/genie:omni` and expects the assistant to drive.

If the legacy multi-command chain (`omni providers create` + `omni agents create` + `omni instances update --agent` + `omni routes create`) is what you reach for first — stop and use this skill instead. The legacy chain still works for power users / CI but emits stderr deprecation nudges pointing here.

## Pre-conditions (verify before driving)

These checks are quick and tell you which Phase to start in. Always run them up front:

```bash
omni auth status      # Phase 1 needed if missing or invalid
genie serve status    # Phase 4 verification needs this green
omni instances list   # at least one connected instance needed for Phase 3
```

## Flow

### Phase 1 — Omni installed and authenticated?

**Entry:** Always (first thing to check).

**Steps:**

1. Run `omni auth status`. If it reports a valid connection, **skip to Phase 2**.
2. If not authenticated or omni is not installed:
   - Tell the operator that omni needs a one-time bootstrap and instruct them to run `omni install` **in a separate terminal** (do NOT nest two interactive flows from inside this skill — the omni installer is itself a wizard).
   - Wait for the operator to confirm `omni install` completed.
   - Re-run `omni auth status` to verify, then continue to Phase 2.

**Exit:** `omni auth status` succeeds.

### Phase 2 — Pick or scaffold the genie agent dir

**Entry:** Phase 1 passed.

**Steps:**

1. Ask the operator: *"Which genie agent are we wiring? Existing one, or do we scaffold a new dir?"*
2. If existing:
   - Ask for the agent name.
   - Run `genie dir ls <name>` to confirm it's already registered. If yes, skip to Phase 3.
   - If not registered, ask for the agent's home directory — the path that contains a real `AGENTS.md`. Validate up front:
     - The path must exist.
     - `<dir>/AGENTS.md` must be a real file, **not** a symlink. If it's a symlink, ask whether the operator wants to register the dir the symlink points to instead (almost always the right answer), or pass `--allow-symlink` (only if intentional template-sharing layout).
   - Run `genie agent register <name> --dir <validated-path>`. The default flow auto-registers the agent in Omni (creates the agent record). Do **NOT** pass `--skip-omni` here — Phase 3 uses `omni connect` which expects the agent record to exist.
3. If scaffolding new:
   - Direct the operator to `/genie:wizard` (which scaffolds an agent identity and AGENTS.md), then come back to this Phase 2 with the freshly-scaffolded dir.

**Exit:** `genie dir ls <name>` returns a clean entry with the correct `Dir:` field.

### Phase 3 — Bind to an Omni instance

**Entry:** Phase 2 passed.

**Steps:**

1. Run `omni instances list` and show the operator the connected instances (those with `ACTIVE=yes`). Highlight the channel and profile name so the operator picks the right one.
2. If there are no connected instances, point the operator at `/omni:omni-setup` (the omni plugin's connect-channel wizard) and pause this flow until an instance is connected.
3. Once the operator picks an instance:
   - Run `omni connect <instance-id> <agent-name>` — this is the canonical command. It:
     - reads `genie dir ls <name> --json` (so the agent must have been registered in Phase 2),
     - creates (or reuses) a `nats-genie` provider,
     - creates (or reuses) the omni agent record bound to that provider,
     - updates the instance with `agentId`, `agentProviderId`, `agentReplyFilter`, and `triggerMode`.
   - The operator can pass `--mode turn-based` (default, recommended for chat) or `--mode fire-and-forget` if they have a reason. Default `--reply-filter all` is fine for KHAL-V1-LAUNCH-style group bots.
4. Confirm the success summary printed by `omni connect` — note the agent ID, provider ID, and the NATS subjects (`omni.message.<inst>.*` inbound, `omni.reply.<inst>.*` outbound).

**Exit:** `omni connect` exits 0 with the configuration summary.

### Phase 4 — Verify the round-trip

**Entry:** Phase 3 passed.

**Steps:**

1. Confirm the bridge daemon is running:
   ```bash
   genie serve status
   ```
   If not running, start it:
   ```bash
   genie serve start --headless
   ```
2. Confirm the bridge is subscribed to the right NATS subjects:
   ```bash
   nats --server localhost:4222 server report connections | grep genie-omni-bridge
   ```
   Should show 7+ subscriptions with non-zero uptime.
3. Run a synthetic round-trip:
   - Tell the operator to send a real test message in the chat that's now wired (e.g. a WhatsApp group).
   - Watch the omni-api log: `tail -f ~/.pm2/logs/omni-api-out.log | grep <chat-id>` — expect `Received → Dispatching → Published to NATS → Agent response` within a few seconds.
   - On the genie side: `genie agent ls` should show a new per-chat agent (e.g. `<name>:<chat-id>` in `idle` state).
4. Print the final topology:

   ```
   📨  WhatsApp/Telegram
        │
        ▼
   🌐  Omni instance      <instance-id>     channel=<channel>
        │
        ▼
   🔌  nats-genie provider <provider-id>    agentName=<name>
        │
        ▼  NATS subject: omni.message.<inst>.*
        ▼
   🤖  genie-omni-bridge → spawns claude in <agent.dir> with --resume <session>
        │
        ▼
   📝  Claude (TUI)       responds via `omni say "..."`
   ```

**Exit:** A real test message gets a real reply in the chat. Done.

## Recovery

If any Phase fails, point the operator at `Runbooks/wire-new-omni-agent.md` (lives in their genie-configure brain) for the fallback two-command path:

```bash
genie agent register <name> --dir <validated-path>
omni connect <instance-id> <name>
```

…plus the troubleshooting table for common symptoms (wrong cwd, bridge not subscribing, multiple agents with same role).

## Rules

- **Never nest interactive flows.** If `omni install` or `/genie:wizard` is needed, hand off to the operator and pause this skill.
- **Never use `--skip-omni` in this flow.** It defeats Phase 3.
- **Always validate `--dir` is real (not a symlink).** As of v4.260429.14+, `genie agent register` rejects symlinked AGENTS.md by default; this skill should not pass `--allow-symlink` unless the operator explicitly says so.
- **Always run `omni connect`, not the legacy chain.** If the operator is mid-way through manually creating providers/agents/routes, ask them to stop and run `omni connect` instead — it's idempotent and reuses anything already created.
- **Never commit secrets.** The `omni_sk_…` API key in `~/.omni/config.json` is read by `genie agent register` automatically; never echo it back to the operator or include it in commit messages.

## See also

- Genie defect fixes that this skill relies on: namastexlabs/genie-configure#10 (brain map + ADR), automagik-dev/genie#1514 (symlink validation + `--skip-omni` warning).
- Omni-side cleanups: automagik-dev/omni#552 (drop stale `genie omni start` hint), automagik-dev/omni#553 (deprecation nudges scaffolding).
- Wish: `canonical-genie-omni-wiring` — `.genie/wishes/canonical-genie-omni-wiring/WISH.md`.
- Sibling omni-side skill: `/omni:omni-setup` (covers omni install + channel connect; this skill picks up where that one ends).
