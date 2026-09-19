# Omni Runner Port — QA Record

Group 5 close-out. Covers the live-QA attempt, the automated-vs-manual coverage
split, and the known-open items handed forward.

Machine: Felipe's macOS host. Date: 2026-07-02. Branch: `wish/omni-runner-port`.

---

## 1. Live-WhatsApp QA — ATTEMPTED, BLOCKED (no Omni instance on this machine)

The real approval round-trip and inbound one-shot could **not** be exercised
here: this host has no Omni hub configured, no signing keys, and no reachable
NATS server. The runner refuses to start without config (correct fail-fast
behavior), so there was nothing to fake. Exact attempts and outputs below.

### What was attempted (real commands, real output)

```text
$ genie omni status
Omni approvals: disabled
  missing config: approvals.enabled, instance, approvalChat
  instance:      (unset)
  approvalChat:  (unset)
  natsUrl:       localhost:4222
Approvals queue:
  pending=0 approved=0 denied=0 expired=0
Inbox: total=0 unhandled=0

$ genie omni handshake
Error: Omni is not configured. Set OMNI_API_URL or `omni.apiUrl` in your genie config first.   # exit 1

$ genie omni serve
Error: Omni approvals are not enabled. Set omni.approvals.enabled=true and omni.instance +
       omni.approvalChat (or OMNI_APPROVALS_ENABLED=1 + OMNI_INSTANCE + OMNI_APPROVAL_CHAT).   # exit 1
```

### What blocked it (environment facts, verified)

| Precondition | State on this host |
|--------------|--------------------|
| `~/.genie/config.json` `omni` section | absent (no `omni` key) |
| `OMNI_API_URL` / `OMNI_API_KEY` env | unset |
| `OMNI_INSTANCE` / `OMNI_APPROVAL_CHAT` env | unset |
| NATS server on `localhost:4222` | closed / unreachable (`nc -z` fails) |
| Host signing keys `~/.genie/keys/` | do not exist |
| `claude` on PATH | present (`~/.local/bin/claude`) — the only precondition met |

No Omni hub + WhatsApp instance is reachable from this machine, so the live
round-trip is **deferred to Felipe** using the runbook below.

### Copy-paste runbook for Felipe to complete live QA himself

Run against your real Omni instance. Secrets stay in env or `~/.genie/config.json`;
do not paste them into git.

```bash
# --- 0. Point genie at your Omni hub (env form; or put these under `omni` in
#        ~/.genie/config.json). NATS_URL is where the Omni hub's NATS listens. ---
export OMNI_API_URL="https://<your-omni-hub>"      # trust/registration endpoint
export OMNI_API_KEY="<your-omni-api-key>"           # bearer for /api/v2/trust
export OMNI_NATS_URL="<host:4222>"                  # Omni hub's NATS (default localhost:4222)
export OMNI_INSTANCE="<whatsapp-instance-id>"       # the connected WhatsApp instance
export OMNI_APPROVAL_CHAT="<your-approval-chat-id>" # the chat that may approve/deny
export OMNI_APPROVALS_ENABLED=1

# --- 1. Register this host (writes ed25519 keypair to ~/.genie/keys, perms 0600).
#        MUST run from OUTSIDE any git working tree (it refuses inside one). ---
genie omni handshake
#   expect: "Genie host registered: <id>" + hostname + public key + key path

# --- 2. Sanity: config now resolves as ENABLED, queue empty. ---
genie omni status
#   expect: "Omni approvals: ENABLED", instance/approvalChat set, pending=0

# --- 3. Start the runner (foreground; it is the ONE resident process). ---
genie omni serve
#   expect: "[omni] serving — instance=... chat=... nats=..."
#   leave it running in this terminal; open a second terminal for step 4.

# --- 4a. APPROVAL ROUND-TRIP (second terminal): launch an approval-gated agent.
#         --permission-mode default is REQUIRED (see known-open #1). ---
claude --permission-mode default -p "Run: echo hello via a Bash tool call"
#   → the runner forwards an "Approval Required" card to OMNI_APPROVAL_CHAT on WhatsApp.
#   From your phone, reply `y` (or `sim`) → the Bash call is allowed and runs.
#   Repeat with `n` (or `nao`) on a fresh request → the call is denied.
#   Repeat and react 👍 / 👎 on the card instead of replying → same resolution.
#   Do nothing for the poll budget (~110s) → request times out to a safe `ask`.

# --- 4b. INBOUND ONE-SHOT: map a chat to a repo, then message it from WhatsApp. ---
#   Add to ~/.genie/config.json under "omni":
#     "routes": [ { "instance": "<instance>", "chat": "<some-chat-id>", "repo": "/abs/path/to/repo" } ]
#   Restart `genie omni serve`, then from that WhatsApp chat send: "list the files here"
#   → a bounded `claude -p` runs in <repo> and replies to the same chat.
#   Send a second message while the first is running → BUSY notice, message stored.
#   Message an UNMAPPED chat → stored only; read it with: genie omni inbox --unhandled

# --- 5. Record results below (approve ✅/❌, deny ✅/❌, reaction ✅/❌,
#        timeout→ask ✅/❌, inbound one-shot ✅/❌). ---
```

### Live QA results (Felipe to fill in)

- [ ] Approval via text (`y`/`sim`) resolves allow
- [ ] Deny via text (`n`/`nao`) resolves deny
- [ ] Approval/deny via reaction (👍/👎) resolves
- [ ] No response → timeout → `ask` fail-safe (under `--permission-mode default`)
- [ ] Inbound one-shot on a mapped chat replies from the mapped repo
- [ ] Second concurrent inbound → BUSY notice + stored; unmapped → stored only

---

## 2. Coverage — automated vs manual-only

### Covered by automated tests (no network, no real WhatsApp)

- **Runner round-trips** with an injectable fake NATS transport
  (`src/lib/omni-runner.test.ts`): token-approve, reaction-approve, deny,
  timeout→ask, inbound→one-shot→reply, busy-drop, unmapped store-only —
  outbound sends asserted on recorded `publish()` calls.
- **Approval hook gating** (`src/hooks/__tests__/omni-approval.test.ts`,
  `omni-dispatch.test.ts`): handler present when enabled, absent (byte-identical
  no-op) when disabled; enqueue + poll + resolve semantics.
- **Global queue** (`src/lib/v5/omni-queue.test.ts`): multi-process resolution
  race, expiry, inbox record/handled.
- **Config resolver + matching** (`omni-config`, `omni-matching`): env/precedence,
  token/reaction vocabulary, the `isOmniApprovalEnabled` gate.
- **Handshake** (`src/term-commands/omni.test.ts`): keypair generation, refuse-
  inside-git-repo guard, host.json persistence, rotate ordering (fake HTTP).
- **Zero-omni e2e guard** (`tests/e2e/v5-lifecycle.sh`, step 9b): `--help`,
  `task`, `board`, and `omni status` all work with **no omni config**, and the
  `natsConnectionCount()` marker stays 0 on module load (transport initializes
  only in `omni serve`). Backed by a static grep proving `nats` is a dynamic,
  not top-level, import.

### Manual-only (needs Felipe's eyes / a real Omni hub) — see the runbook above

- Real WhatsApp approve / deny / reaction from a phone.
- Real inbound WhatsApp → one-shot `claude -p` reply.
- Real ed25519-signed registration against a live `OMNI_API_URL`.
- Real NATS transport (the automated suite uses a fake; the real `nats` client
  and Omni subject/payload shapes are exercised only live).

---

## 3. Known-open items (handed forward)

1. **Auto-mode `ask`-resolution is unproven.** The timeout→ask fail-safe is
   verified only under `--permission-mode default`. Under `"defaultMode":"auto"`
   a passthrough `ask` may auto-resolve to *allow*, silently defeating the
   fail-safe. Until this is tested for real, approval-gated agents **must** run
   with `--permission-mode default`. (WISH Decision-14 / operational gotcha.)

2. **Reaction correlation resolves oldest-pending under concurrent approvals.**
   Outbound NATS publish is fire-and-forget; genie never learns Omni's real
   message id, so a WhatsApp *reaction* falls back to the oldest pending
   approval. Correct with one pending approval, wrong-row under concurrency.
   Fix needs Omni to publish a "sent" event carrying its message id so the
   reaction can be correlated to the exact request. (WISH Discovered Issues —
   LOW, follow-up.)

### Resolved during the wish (noted for completeness)

- The v5 hook-dispatch fall-open (daemon socket default) flagged in the WISH is
  resolved: `src/hooks/dispatch-command.ts` is now **in-process only and
  fail-closed** (empty/unparseable payload emits a deny envelope, never empty
  stdout). The omni-approval handler inherits this correct path.
