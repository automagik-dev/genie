# Wish: Omni Runner Port — Approvals + Inbound on the Lightweight Body

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `omni-runner-port` |
| **Date** | 2026-07-02 |
| **Author** | Felipe + Genie |
| **Appetite** | ~1 week |
| **Branch** | `wish/omni-runner-port` (from `dev`; PR back to `dev`) |
| **Design** | [DESIGN.md](../../brainstorms/genie-v5-lightweight-body/DESIGN.md) — umbrella Group 5 (D3, D8) |
| **Depends on** | wishes `v5-foundation`, `v5-demolition`, `warp-integration` (all merged to dev) |

## Summary

Exit the omni-dark window: rebuild the WhatsApp/channel integration from the `origin/v4` reference code onto the lightweight body — one optional resident runner, an approval queue in the global `~/.genie/genie.db`, NATS loaded only when omni is enabled. v1 slice (user-confirmed): full v4 parity — remote approve/deny of agent permission requests (reply tokens + emoji reactions) AND inbound channel messages reaching an agent. The wish opens with the feasibility spike the whole umbrella flagged as its hardest unknown, now with a promising new angle: Claude Code's `PermissionRequest` hook event (which returns `permissionDecision: allow|deny|ask`) did not exist when v4 was forced onto the SDK-only path.

## Scope

### IN
- **Spike (gates everything downstream):** prove stock-Claude-Code approval capture end-to-end locally — a PreToolUse handler (per the spike; NOT PermissionRequest) in genie's hook registry that enqueues an approval, blocks polling for resolution (bounded by the hook timeout), and returns `allow`/`deny` when another process resolves the row; `ask` passthrough on timeout (fail-safe: never auto-allow). Written verdict GO / NO-GO with evidence. NO-GO → the named fallback (approvals only for SDK-launched agents) or rescope — escalated, not silently absorbed.
- **Global state DB:** `~/.genie/genie.db` (bun:sqlite, WAL, same engine/patterns as the per-repo DB — busy-retry, typed errors, `PRAGMA user_version`) with a minimal omni schema: `approvals` (id, repo, session hint, tool + input summary, status pending→approved|denied|expired, `omni_message_id` nullable, requested_by/resolved_by, timestamps) and `inbound_messages` (id, instance, chat, sender, body, received_at, handled_at nullable). Typed queue API: enqueue/resolve/listPending/expireStale — multi-process safe.
- **The runner** — `genie omni serve`: the ONE resident process (design D3). Ports from `origin/v4` — full reference set: `src/lib/omni-approval-handler.ts` (inbound matching), `src/lib/providers/claude-sdk-remote-approval.ts` (queue semantics, waitForResolution/poll, sendApprovalToOmni), `src/services/omni-queue.ts` + `src/services/omni-bridge.ts` (send/reply paths), `src/lib/omni-registration.ts` + `omni-signature.ts` (signed HTTP registration), migrations `032/033/034_approvals*.sql` (queue shape) — port semantics, don't import. NATS subscriptions `omni.message.{instance}.>` + `omni.event.>`, approve/deny token matching (y/yes/approve/sim, n/no/deny/nao, configurable) + reaction matching (👍✅👌 / 👎❌🚫) correlated via `omni_message_id`. **Outbound sends (approval requests, replies) go via NATS publish, mirroring v4's omni-bridge reply path — NOT an invented signed-HTTP send endpoint (v4 has none; its only signed HTTP is registration).** ed25519-signed registration against `OMNI_API_URL`; `genie omni handshake` ports the keypair provisioner from `origin/v4:src/term-commands/omni/handshake.ts` (signing needs `~/.genie/keys/*`). `genie omni status` (runner liveness + queue counts) and `genie omni inbox` round out the namespace.
- **Inbound → agent (v1 minimal, honest):** configured mapping instance/chat → repo directory; the runner stores every inbound message, and for mapped chats spawns a bounded one-shot `claude -p "<message>"` in that repo dir, replying with the (truncated) result via NATS publish (Decision 9). No resident agent state, no session resumption in v1.
- **Approval end-to-end wiring — including dispatcher-layer changes:** the current dispatch pipeline drops/omits the PreToolUse permission-decision envelope on the omni path (PreToolUse deny ALREADY emits the correct permissionDecision envelope (`buildDenyResponse`); the real gap is that `executeBlockingChain` has NO path to emit a handler-driven ALLOW or ASK — G3 must add allow/ask emission + propagation. `{decision:"block"}` is only the non-PreToolUse branch.). Group 3 therefore includes: PreToolUse permission-decision response builders (proper `hookSpecificOutput.permissionDecision` envelope for allow AND deny), chain propagation of the decision, dispatcher tests — plus the omni handler itself, registered ONLY when omni is enabled via a config-gated registry build at dispatch boot (`setRegistry` on the existing frozen-registry structure — the literal cannot be edited conditionally). Zero behavior change when omni is off: handler absent from the registry entirely. Hook timeout guidance documented.
- **NATS dependency returns, scoped:** `nats` re-added to package.json (pin v4's major: 2.29.x), dynamic-imported ONLY inside the runner module. NOTE: bun bundles the dep into dist regardless — the testable claim is runtime INITIALIZATION, not module absence: a transport-module marker/spy test asserts `genie --help`/`task`/`board` complete without initializing the transport, and README words it as "nats initializes only when the omni runner starts" (count 3 → 4).
- **Command surface:** `omni` namespace registers top-level (12 commands total); README table + count updated; `omni` added to WORKSPACE_EXEMPT (global-scope command, no repo workspace needed — the launch lesson applied proactively).
- **Tests:** queue lib unit tests (multi-process resolution race, expiry); runner integration tests with an injectable transport (fake NATS) + fake Omni HTTP endpoint — full round-trips: enqueue→outbound-send→simulated reply→resolve→hook returns allow; reaction path; deny path; timeout→ask path; inbound→store→(mocked) claude -p→reply. Real-WhatsApp manual QA recorded in qa.md with a needs-Felipe's-eyes checklist.

### OUT
- Rewriting `skills/omni/SKILL.md` (stays lint-ignored; its port is a follow-up once the runner API settles).
- Session resumption / multi-turn conversations from inbound messages (v1 is one-shot `claude -p`); channel providers beyond what the Omni hub speaks; group-chat policy logic beyond the v4 token/reaction contract.
- Runner supervision/auto-start (pm2 died with v4; the runner is foreground or user-managed in v1 — supervision belongs to the distribution wish if ever).
- Approval UI beyond WhatsApp text/reactions; claude.ai/mobile push paths.
- Any per-repo genie.db schema change (the global DB is separate; per-repo stays at user_version 1).
- Version scheme, CDN, Codex/Hermes emit (later umbrella groups).

## Spike Outcome (Group 1 — GO, 2026-07-02)

The approval-capture spike returned **GO**, proven live against Claude Code 2.1.198 (allow/deny/timeout→ask all obeyed). It corrected the wish's central hypothesis — Group 3 MUST follow the spike contract, not the pre-spike guesses below:

- **Intercept on `PreToolUse`, NOT `PermissionRequest`.** The `hookSpecificOutput.permissionDecision: allow|deny|ask` envelope belongs to PreToolUse, which fires in BOTH headless `claude -p` (omni inbound, Group 4) and interactive panes. PermissionRequest uses a different shape (`decision.behavior`, no `ask`) and does NOT fire under headless `-p` — unusable for v5's dual-mode agents. Timeout fallback = `ask` (never `defer`; defer is print-mode-only).
- **Operational gotcha (flag in G3 + G5), mechanism corrected by Wave-1 review:** PreToolUse hooks DO still fire under `"defaultMode":"auto"` (verified: this machine's RTK PreToolUse hook fires every session under auto). The real risk is that an `ask`/passthrough decision may auto-RESOLVE to allow under auto mode, silently breaking the timeout→ask fail-safe. Approval-gated agents MUST be launched with `--permission-mode default` (fail-safe proven live only there); G3 must TEST whether `ask`-under-auto refuses or auto-allows before relying on the fail-safe outside default mode.
- **Timing budget:** pure polling (sqlite has no LISTEN/NOTIFY); resolution→decision ≤ one poll interval. Poll interval 250–500ms; hook `timeout` sized to the phone-answer SLA (~120s; field is SECONDS); poll budget STRICTLY < timeout (~110s) so CC doesn't kill the hook mid-poll; expire the pending row on self-timeout.
- Full input-payload fields + literal envelopes are in SPIKE.md — the Group-3 contract.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Spike first; groups 3+ are gated on its written GO verdict | The D1↔approval tension is the umbrella's hardest unknown; the PermissionRequest hook (returns allow/deny/ask per the current Claude Code settings schema) is a genuinely new interception point vs v4's SDK-only era — promising but unproven for long-poll waits |
| 2 | Timeout resolves to `ask`, never `allow` | Fail-safe: an unreachable phone must degrade to the normal local prompt, not an auto-approval |
| 3 | Global `~/.genie/genie.db` is a SEPARATE database from per-repo state, same engine + patterns | Design D2/D3: approvals span repos and belong to the machine; reusing the bun:sqlite patterns (WAL, busy-retry, typed errors) avoids a second storage idiom |
| 4 | `nats` returns as a dependency, dynamically imported by the runner only | The Omni hub speaks NATS; pretending otherwise means reimplementing a client. Scoped loading keeps every non-omni command NATS-free; README count updated honestly |
| 5 | Port from `origin/v4` reference code — faithful semantics, new storage | "The integration works fine, we should keep it" (user, 2026-07-01); token/reaction matching and ed25519 signing are proven — only the queue backend (PG → sqlite) and the capture point (SDK → hook) change |
| 6 | Inbound v1 = store + mapped one-shot `claude -p` + reply | Reaches an agent with zero resident agent state — honest lightweight-body semantics; resumption is a later wish |
| 7 | `omni` joins WORKSPACE_EXEMPT at birth | The legacy workspace gate has now bitten twice (task/board, launch); global-scope commands never depend on a repo workspace |
| 8 | INTENTIONAL divergences from v4, stated: timeout→`ask` (v4 hard-resolved to deny) and pure polling (v4 had PG LISTEN/NOTIFY sub-second latency) | Fail-safe beats fidelity; sqlite has no NOTIFY. The spike contract must nail the poll-interval vs hook-timeout budget since the low-latency path is gone. Status enum reshapes too (v4 allow/deny → approved/denied/expired) — the port maps allow→approved |
| 9 | Outbound sends via NATS publish (v4 omni-bridge reply path); registration is the only signed HTTP | v4's `sendApprovalToOmni` shelled to the external `omni` CLI — reviving that adds an undocumented binary dependency; the runner already holds the NATS connection, and publish is a proven v4 path |
| 10 | Inbound concurrency guard: drop-with-notice (one in-flight run per route; concurrent messages get a "busy — one at a time" reply and are stored) | Simplest honest contract; a queue invites unbounded backlog against a one-shot executor |

## Success Criteria

- [ ] Spike verdict documented in `.genie/wishes/omni-runner-port/SPIKE.md` with reproducible evidence (GO: a PermissionRequest hook blocked, was resolved externally, returned `allow`, and Claude Code proceeded; plus deny and timeout→ask runs). NO-GO → wish rescoped via escalation, not silently.
- [ ] Queue lib: multi-process resolution race test (one resolver wins; hook observes it) and expiry test green.
- [ ] Runner round-trip integration tests green with fake transport (+ fake HTTP for registration only): token-approve, reaction-approve, deny, timeout→ask, inbound→one-shot→reply (all outbound asserted on recorded publishes).
- [ ] With omni disabled (default), `genie --help`/`task`/`board` complete without INITIALIZING the transport (runtime marker/spy test — nats is bundled by bun regardless, so module absence is not the claim), and the hook registry contains no omni-approval handler; dispatcher output for all events is byte-identical to today (regression-tested).
- [ ] `genie omni serve|status|inbox` exist; 12 top-level commands; README table + dependency count honest.
- [ ] Real-WhatsApp manual QA recorded in qa.md (what was proven live vs what needs eyes).
- [ ] Full `bun run check` + e2e green; CI green on the PR.

## Execution Strategy

| Wave | Groups | Notes |
|------|--------|-------|
| 1 | Group 1, Group 2 | Spike (scratch storage allowed — it proves CC mechanics, not schema) ∥ global DB + queue lib |
| 2 | Group 3 | Runner + approval wiring — consumes the spike's proven mechanism and G2's queue |
| 3 | Group 4 | Inbound → agent path on the running skeleton |
| 4 | Group 5 | Hook registration polish, docs, e2e, manual QA close-out |

---

## Execution Groups

### Group 1: Approval-capture spike (GATES groups 3-5)
**Goal:** Prove — or refute with evidence — that a stock-Claude-Code `PermissionRequest` hook can hold a permission request while an external process resolves it, then return the decision.

**Deliverables:**
1. Throwaway-quality prototype (may live under `.genie/wishes/omni-runner-port/spike/`): a hook script/handler that on PermissionRequest writes a pending row (scratch sqlite or file), polls bounded by the hook timeout, and emits `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","permissionDecision":"allow|deny"}}` or exits neutrally for `ask`.
2. Live experiment: a Claude Code session configured with the hook (project-local settings in a scratch repo), a tool call that triggers a permission prompt, and a second terminal resolving the row → document that CC proceeds on allow, refuses on deny, prompts normally on timeout. Record timeout ceiling findings (how long can the hook block; configured `timeout` field behavior).
3. `SPIKE.md`: verdict GO/NO-GO, evidence transcript, the exact contract Group 3 must implement (payload fields available in the hook input, the literal `hookSpecificOutput.permissionDecision` response JSON, timing: max hook-block observed, chosen poll interval vs hook-timeout budget — the sqlite port has no LISTEN/NOTIFY, so latency comes from polling), and risks (does blocking a PermissionRequest hook freeze the session UI — observed behavior).

**Acceptance Criteria:**
- [x] All three runs (allow, deny, timeout→ask) documented with observed CC behavior.
- [x] Verdict + Group-3 contract written; NO-GO path names the fallback explicitly.

**Validation:**
```bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
test -f .genie/wishes/omni-runner-port/SPIKE.md
grep -qE '^## Verdict: (GO|NO-GO)' .genie/wishes/omni-runner-port/SPIKE.md
grep -q 'permissionDecision' .genie/wishes/omni-runner-port/SPIKE.md
grep -qi 'poll interval' .genie/wishes/omni-runner-port/SPIKE.md
grep -qi 'timeout' .genie/wishes/omni-runner-port/SPIKE.md
```

**depends-on:** none

---

### Group 2: Global genie.db + approval/inbox queue lib
**Goal:** The machine-scope state store, same engine and discipline as the per-repo DB.

**Deliverables:**
1. FIRST: extract the private sqlite-open primitives from `src/lib/v5/genie-db.ts` (`applyPragmas`, busy-retry open loop, user_version validation) into a shared module (e.g. `src/lib/v5/sqlite-open.ts`) consumed by BOTH DBs — copying ~80 lines of concurrency-critical logic would drift (review M4). Per-repo genie-db behavior + all its tests stay green.
2. `src/lib/v5/global-db.ts` — opens `~/.genie/genie.db` (honors `GENIE_HOME`) on the shared primitives; tables `approvals` + `inbound_messages` per Scope IN; no import of per-repo path constants. v4 queue reference: `origin/v4:src/lib/providers/claude-sdk-remote-approval.ts` + `src/services/omni-queue.ts` + migrations `032-034` (map v4 allow/deny → approved/denied).
3. `src/lib/v5/omni-queue.ts` — typed API: `enqueueApproval`, `attachOmniMessageId`, `resolveApproval(id, decision, resolvedBy)` (atomic conditional update — exactly one resolver wins), `getApproval`, `listPendingApprovals`, `expireStale(olderThanMs)`; `recordInbound`, `listInbox`, `markHandled`.
4. Colocated tests: schema init/idempotency, per-repo genie-db suite still green post-extraction, multi-PROCESS resolution race (N resolvers, one winner — reuse the task-state race-test pattern), expiry, inbox round-trip; `GENIE_HOME` isolation so tests never touch the real `~/.genie`.

**Acceptance Criteria:**
- [x] Race test: exactly one resolver wins; losers get a typed conflict.
- [x] No import from the per-repo genie-db path constants (separate DB, shared patterns only).
- [x] typecheck + tests green.

**Validation:**
```bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
bun test src/lib/v5/global-db.test.ts src/lib/v5/omni-queue.test.ts
bun run typecheck
```

**depends-on:** none

---

### Group 3: The runner — `genie omni serve` + approval round-trip
**Goal:** The one resident process: NATS in, NATS publish out (Decision 9), approvals resolved in the global queue via the spike's proven mechanism.

**Deliverables:**
1. Port from `origin/v4` (reference files: `omni-approval-handler.ts`, `providers/claude-sdk-remote-approval.ts`, `services/omni-bridge.ts`, `services/omni-queue.ts`, `omni-registration.ts`, `omni-signature.ts`, `term-commands/omni/handshake.ts` — faithful semantics, new storage): token + reaction matching, `omni_message_id` correlation, ed25519 signing + keypair handshake, registration against `OMNI_API_URL`; outbound sends via NATS publish per Decision 9 (port the bridge's subject/payload shapes).
2. `src/term-commands/omni.ts` — namespace: `omni serve` (foreground runner: dynamic-`import('nats')`, subscribes, matches, resolves via omni-queue; on new pending approvals PUBLISHES the approval-request message via NATS and records `omni_message_id` from the flow the bridge used), `omni status` (queue counts + config sanity), `omni inbox` (list inbound), `omni handshake` (keypair provisioning to `~/.genie/keys/`, ported). Config via `~/.genie/config.json` omni section + env (`OMNI_API_URL`, instance, token lists) — Zod-validated.
3. Dispatcher-layer support: PreToolUse `buildBlockingResponse`/`buildDenyResponse` emitting the `hookSpecificOutput.permissionDecision` envelope (allow + deny), decision propagation through `executeBlockingChain`, dispatcher unit tests. Then the PreToolUse omni-approval handler itself (`src/hooks/handlers/omni-approval.ts`) — matcher scoped to tools that need gating; poll interval 250–500ms, budget < hook timeout, timeout→ask, expire the row implementing the spike's written contract — added to the registry via a config-gated build at dispatch boot (`setRegistry`; the frozen builtin literal cannot be conditionally edited). Disabled default: handler absent, dispatcher emits today's responses byte-for-byte (regression-tested); timeout → `ask`; never auto-allow.
4. `nats` re-added to package.json; `omni` added to WORKSPACE_EXEMPT; registration in genie.ts.
5. Integration tests with injectable transport (fake NATS stub satisfying the narrow subscribe/publish interface the runner uses — outbound sends assert on recorded publishes) + fake Omni HTTP server (Bun.serve, ephemeral port) for REGISTRATION only (the one real signed-HTTP path — signature headers verified there): the five round-trips (token-approve, reaction-approve, deny, timeout→ask, registration-signature); hook-registry test proving absence when disabled / presence when enabled.

**Acceptance Criteria:**
- [x] Five round-trip tests green without any real NATS/Omni/network.
- [x] Omni-disabled default: no PermissionRequest handler registered; transport not INITIALIZED by `genie --help`/`task`/`board` (runtime marker/spy probe — nats is bundled regardless).
- [x] typecheck + full suite green; `--help` shows 12 commands incl. `omni`.

**Validation:**
```bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
bun test src/term-commands/omni.test.ts src/hooks/
bun run typecheck
bun run build
HELP=$(bun dist/genie.js --help)
echo "$HELP" | grep -qE '^  omni' || { echo "FAIL: omni missing"; exit 1; }
COUNT=$(echo "$HELP" | grep -cE '^  [a-z]')
[ "$COUNT" -eq 12 ] || { echo "FAIL: expected 12 commands, got $COUNT"; exit 1; }
GENIE_TEST_SKIP_PGSERVE=1 bun test
```

**depends-on:** group-1, group-2

---

### Group 4: Inbound → agent (one-shot)
**Goal:** Mapped channel messages reach a real agent and the reply comes back.

**Deliverables:**
1. Runner extension: for inbound messages on chats mapped to a repo dir (config: `omni.routes: [{instance, chat, repo}]`), spawn bounded one-shot `claude -p "<message>"` (cwd = repo, timeout + output cap from config), send the truncated result back via NATS publish (Decision 9), `markHandled`. Unmapped chats: store-only.
2. Concurrency guard per Decision 10: one in-flight run per route; concurrent messages get a "busy — one at a time" reply and are stored (drop-with-notice, no queue); crash of the child never crashes the runner.
3. Tests with a fake `claude` executable (injectable spawn path): mapped round-trip (message → fake claude → reply sent to fake API → handled), unmapped store-only, child-timeout path, child-crash isolation.

**Acceptance Criteria:**
- [x] Round-trip + isolation tests green; runner survives child failures.
- [x] Unmapped messages never spawn anything.

**Validation:**
```bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
bun test src/term-commands/omni.test.ts
bun run typecheck
GENIE_TEST_SKIP_PGSERVE=1 bun test
```

**depends-on:** group-3

---

### Group 5: Docs, e2e guard, manual QA close-out
**Goal:** The surface tells the truth; the live path is exercised for real.

**Deliverables:**
1. README: `omni` rows in the command table, the "11 CLI commands" claim bumped to 12, dependency count 3 → 4 worded "nats initializes only when the omni runner starts", a short honest Omni section (what works, what needs an Omni hub + WhatsApp instance), roadmap trimmed of the ported item.
2. e2e: extend `tests/e2e/v5-lifecycle.sh` with a zero-omni guard — assert `genie --help`, `task`, `board` work with no omni config present and (cheaply, if provable) that the transport is not initialized on those paths.
3. Real-WhatsApp manual QA on this machine against Felipe's Omni instance: runner up, real approval round-trip from a phone (approve, deny, reaction), inbound one-shot round-trip. Recorded in `.genie/wishes/omni-runner-port/qa.md` — what was proven live, what config was used (secrets redacted), what remains open.

**Acceptance Criteria:**
- [ ] README gates green (command-existence loop, stale-claims grep, dependency-count claim matches package.json).
- [ ] e2e + full `bun run check` green.
- [ ] qa.md records the live session honestly (or documents exactly why live QA was blocked and what Felipe must run).

**Validation:**
```bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
V5_E2E_BUILD=1 bash tests/e2e/v5-lifecycle.sh
bun run check
bun run build
HELP=$(bun dist/genie.js --help)
for c in $(grep -oE '`genie [a-z]+' README.md | sed 's/`genie //' | sort -u); do
  echo "$HELP" | grep -qE "^  $c( |$)" || { echo "FAIL: README names missing command: $c"; exit 1; }
done
DEPS=$(python3 -c "import json;print(len(json.load(open('package.json'))['dependencies']))")
grep -q "$DEPS runtime dependencies" README.md || { echo "FAIL: README dependency count mismatch"; exit 1; }
test -f .genie/wishes/omni-runner-port/qa.md
```

**depends-on:** group-3, group-4

---

## Cross-wish dependencies

- **Follows:** warp-integration (merged). **Exits** the omni-dark window opened by v5-demolition (D8).
- **Enables:** `skills/omni` port (follow-up wish once the runner API settles).
- **Hands to distribution wish:** runner supervision/auto-start, if ever wanted.

## Discovered Issues (during execution)

- **HIGH (pre-existing, separate wish) — hook dispatch falls open in v5.** The demolition deleted the hook daemon (`src/serve/`), but `src/hooks/dispatch-command.ts` still defaults to `runDispatchClient()` (daemon socket) unless `GENIE_HOOK_FORCE_INPROC=1`. On the absent socket it F1-falls-open (empty stdout = allow-by-default). Confirmed on `origin/dev` too — so **branch-guard and ALL hooks are non-functional in the real default path today**, and the omni-approval handler (wired via `installDispatchRegistry`, in-process seam only) inherits this. Extra wrinkle: `dispatch-client.ts` `DEFAULT_TIMEOUT_MS=5000` fails OPEN, so naively restoring the daemon makes a 110s approval block auto-ALLOW, not ask. A separate wish must fix the dispatch default (default to in-process now the daemon is gone, OR rebuild a daemon that calls installDispatchRegistry at boot and fails to `ask` not empty). Until then omni approvals cannot gate in production.
- **LOW (follow-up) — reaction correlation resolves oldest-pending under concurrent approvals.** Outbound NATS publish is fire-and-forget; genie never learns omni's real message id, so WhatsApp reactions fall back to oldest-pending. Correct for one pending approval; wrong-row under concurrency. Needs omni to publish a "sent" event carrying its message id.
