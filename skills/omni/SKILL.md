---
name: omni
description: "Wire a Genie agent to an Omni channel in one canonical flow — register the host, bind the instance, route chats to a repo, verify the round-trip."
---

# Omni

Take an operator from "channel connected in Omni" to "messages in that channel reach a Genie agent and get replies". Omni installation, authentication, QR connection, instance creation, platform administration and outbound messaging are separate authority domains; a wiring request does not imply them. When a required capability is missing, hand off to the operator and pause rather than nesting an interactive flow.

Genie is zero-daemon; the one optional foreground process is `genie omni serve`, a NATS bridge that sends tool-approval requests to a phone chat and routes inbound messages from mapped chats into one-shot agent runs in a target repo. The four phases are idempotent, so re-running the flow is safe.

## Pre-checks

```bash
omni auth status          # Omni CLI authenticated? Otherwise report the missing setup capability
omni instances list       # at least one connected instance
genie omni status         # genie-side config sanity + queue counts (no network)
```

## 1. Host trust

```bash
genie omni handshake      # idempotent; --rotate reissues, --hostname overrides
```

Registers this machine with the Omni server via an ed25519 keypair under `$GENIE_HOME/keys/` (default `~/.genie/keys/`; refuses to write keys inside a git working tree). Needs `OMNI_API_URL` + `OMNI_API_KEY`, or `omni.apiUrl` / `omni.apiKey` in `~/.genie/config.json`.

## 2. Bind the instance

```bash
omni connect <instance-id> <agent-name>   # idempotent
```

Creates or reuses a `nats-genie` provider and agent record on the Omni side and points the instance at them. `--mode turn-based` (default) or `--mode fire-and-forget`; `--reply-filter all|filtered`. If an operator started creating providers by hand, stop and run `omni connect`; it reuses what exists.

## 3. Route chats and enable approvals

Configuration lives in the `omni` section of `~/.genie/config.json`; environment variables override:

| Key | Env override | Meaning |
|-----|--------------|---------|
| `omni.apiUrl` / `omni.apiKey` | `OMNI_API_URL` / `OMNI_API_KEY` | Omni server + credentials |
| `omni.natsUrl` | `OMNI_NATS_URL` | NATS server (default `localhost:4222`) |
| `omni.instance` | `OMNI_INSTANCE` | Instance carrying approval traffic |
| `omni.approvalChat` | `OMNI_APPROVAL_CHAT` | Chat that receives approval requests |
| `omni.approvals.enabled` | `OMNI_APPROVALS_ENABLED=1` | Feature gate (also needs instance + approvalChat) |
| `omni.routes[]` | — | Inbound one-shot routes: `{instance, chat, repo, agent, persona?}` where `agent` is `claude` or `codex` |

A route maps an `(instance, chat)` pair to an absolute repo path and an explicit provider. Always set `agent`: the compatibility default is `claude`, which silently routes to the wrong client when Codex was intended. `persona` defaults to `<repo>/AGENTS.md`. Unrouted chats are store-only: they land in the inbox with no agent run.

```json
{
  "omni": {
    "routes": [
      {
        "instance": "<instance-id>",
        "chat": "<chat-id>",
        "repo": "/absolute/path/to/repo",
        "agent": "codex"
      }
    ]
  }
}
```

## 4. Run and verify

```bash
genie omni serve                    # foreground resident runner — its own pane or service
genie omni status --json            # approval-queue counts + config sanity
genie omni test-approval            # one approval round-trip, fake transport
genie omni test-approval --live     # ONE real approval to the configured chat
genie omni inbox --unhandled        # inbound messages awaiting handling
```

Finish with a real round-trip: the operator sends a message in the wired chat and confirms the selected provider's reply arrives. Report the verified topology (instance id, chat, repo, `agent`, persisted provider/thread key, persona source) with the evidence for each.

## Boundaries

- Key rotation, instance binding, route mutation, starting the resident service, a live test approval and any external message are each a distinct authority: confirm before the first of each unless the request already authorized it. Read-only status checks need no confirmation.
- One canonical path: handshake → connect → routes → serve.
- Secrets stay put: keys under `$GENIE_HOME/keys/` and `omni.apiKey` never appear in output, commits or messages.
