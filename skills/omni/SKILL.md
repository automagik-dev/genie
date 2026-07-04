---
name: omni
description: "Wire a Genie agent to an Omni channel in one canonical flow — register the host, bind the instance, route chats to a repo, verify the round-trip."
allowed-tools: Bash(omni *), Bash(genie *)
---

# /genie:omni — Canonical Genie ↔ Omni Wiring

Take an operator from "channel connected in Omni" to "messages in that channel reach a Genie agent and get replies". This skill owns the wiring flow; everything else is delegated to the omni plugin's skills:

- Omni install, auth, channel connection (QR, instance creation) → `/omni:omni-setup`
- Messaging verbs (say, react, listen, ...) → `/omni:omni-agent`
- Platform admin (instances, providers, automations, routes) → `/omni:omni-ops`

## v5 model

Genie is zero-daemon; the one optional foreground process is `genie omni serve` — a NATS bridge that (a) sends tool-approval requests to a phone chat and resolves replies/reactions, and (b) routes inbound messages from mapped chats into one-shot agent runs in a target repo. Wiring is four short phases; every phase is idempotent, so re-running the flow is safe.

## Pre-checks

```bash
omni auth status          # Omni CLI authenticated? If not → /omni:omni-setup
omni instances list       # need at least one connected instance
genie omni status         # genie-side config sanity + queue counts (no network)
```

## Phase 1 — Host trust

```bash
genie omni handshake      # idempotent; --rotate reissues, --hostname overrides
```

Registers this machine with the Omni server via an ed25519 keypair stored under `$GENIE_HOME/keys/` (default `~/.genie/keys/`; the command refuses to write keys inside any git working tree). Requires `OMNI_API_URL` + `OMNI_API_KEY` (or `omni.apiUrl` / `omni.apiKey` in `~/.genie/config.json`).

## Phase 2 — Bind the instance

```bash
omni connect <instance-id> <agent-name>   # idempotent
```

Creates or reuses a `nats-genie` provider and agent record on the Omni side and points the instance at them. Options: `--mode turn-based` (default, chat round-trips) or `--mode fire-and-forget`; `--reply-filter all|filtered`. Pick the instance id from `omni instances list`; if none is connected yet, hand off to `/omni:omni-setup` and pause this flow.

## Phase 3 — Route chats and enable approvals (genie side)

Configuration lives in the `omni` section of `~/.genie/config.json`; env vars override:

| Key | Env override | Meaning |
|-----|--------------|---------|
| `omni.apiUrl` / `omni.apiKey` | `OMNI_API_URL` / `OMNI_API_KEY` | Omni server + credentials |
| `omni.natsUrl` | `OMNI_NATS_URL` | NATS server (default `localhost:4222`) |
| `omni.instance` | `OMNI_INSTANCE` | Instance carrying approval traffic |
| `omni.approvalChat` | `OMNI_APPROVAL_CHAT` | Chat that receives approval requests |
| `omni.approvals.enabled` | `OMNI_APPROVALS_ENABLED=1` | Feature gate (also needs instance + approvalChat) |
| `omni.routes[]` | — | Inbound one-shot routes: `{instance, chat, repo, persona?}` |

A route maps an `(instance, chat)` pair to an absolute repo path; the run's persona defaults to `<repo>/AGENTS.md` when `persona` is omitted. Unrouted chats are store-only — they land in the inbox with no agent run.

## Phase 4 — Run and verify

```bash
genie omni serve                    # foreground resident runner — its own pane/service
genie omni status --json            # approvals queue counts + config sanity
genie omni test-approval            # one approval round-trip, fake transport
genie omni test-approval --live     # ONE real approval to the configured chat (deliberate)
genie omni inbox --unhandled        # inbound messages awaiting handling
```

Finish with a real round-trip: the operator sends a message in the wired chat and confirms the agent's reply arrives. Report the verified topology — instance id, chat, repo, persona source — with the evidence for each, not intentions.

## Rules

- Never nest interactive flows: if `/omni:omni-setup` or an installer is needed, hand off to the operator and pause this skill.
- One canonical path: handshake → connect → routes → serve. If the operator started manually creating providers/agents, stop and run `omni connect` instead — it reuses whatever already exists.
- Secrets stay put: keys under `$GENIE_HOME/keys/` and `omni.apiKey` never appear in output, commits, or messages.
