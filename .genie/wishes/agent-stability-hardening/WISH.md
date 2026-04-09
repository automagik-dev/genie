# Wish: Agent Stability Hardening + Remote Approval

| Field | Value |
|-------|-------|
| **Status** | APPROVED |
| **Slug** | `agent-stability-hardening` |
| **Date** | 2026-04-08 |
| **Design** | [DESIGN.md](../../brainstorms/agent-stability-hardening/DESIGN.md) |
| **GitHub Issues** | #1094, #1093, #1064 |
| **Repo** | automagik-dev/genie |

## Summary

Fix three agent runtime reliability bugs (permission deadlock, clipboard breakage, silent message loss) and introduce a new `remoteApproval` permission mode that routes tool-use approval requests to humans via Omni (WhatsApp) and the Genie desktop app. This transforms the broken permission system from a source of deadlocks into a powerful human-in-the-loop control plane.

## Scope

### IN
- Fix `permissionMode` spread override that causes agent deadlock (#1094)
- Change scaffold default from `permissionMode: default` to `bypassPermissions`
- Defense-in-depth: strip `permissionMode` from `translateSdkConfig`, call `ensureTeammateBypassPermissions` at SDK spawn
- New `permissionMode: remoteApproval` with PG-backed approval queue
- Omni approval frontend: WhatsApp message + reaction/text reply approval
- App approval frontend: toast notification + interactive chat message with Approve/Deny/Preview
- Configurable approve/deny tokens in `workspace.json`
- Fix `osc52-copy.sh` to use `$SSH_TTY` as primary clipboard target (#1093)
- Add `GENIE_TMUX_MOUSE=off` env var opt-out
- Inbox delivery retry (3x) with escalation to team-lead (#1064)
- Fix `isTeamActive` to check per-agent pane liveness

### OUT
- WhatsApp interactive buttons (requires Business API — text reply + reactions are universal)
- Per-agent approval config (workspace-level is sufficient)
- Approval audit dashboard UI (PG table is queryable, UI deferred)
- Full inbox-watcher redesign (incremental fix only)
- OSC52 terminal compatibility matrix testing (fix the script, document Shift workaround)

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Strip `permissionMode` from `translateSdkConfig()` | SDK executor must always bypass — frontmatter `permissionMode` only meaningful for tmux CLI path |
| D2 | Scaffold default `bypassPermissions` | Current `default` causes deadlock for every new agent |
| D3 | PG LISTEN/NOTIFY for approval resolution | Proven pattern (mailbox delivery), works cross-process |
| D4 | Accept both text reply and reaction emoji | Channel-agnostic — works on WhatsApp, Telegram, Slack |
| D5 | Configurable approve/deny tokens in `workspace.json` | Multilingual support ("sim"/"nao"), custom emoji |
| D6 | Timeout 300s default, `defaultAction: deny` | Safe default — no unauthorized tool use |
| D7 | Mode name: `remoteApproval` | Transport-agnostic — works via Omni, app, future channels |
| D8 | Toast + in-chat for app UI | Toast alerts from any tab, chat message is persistent and actionable |
| D9 | Medium preview for Omni, full via app Preview button | WhatsApp can't handle 500-line diffs |
| D10 | `$SSH_TTY` as primary OSC52 target | More reliable than `who -m` in nested tmux |
| D11 | `GENIE_TMUX_MOUSE=off` env opt-out, default on | Preserves behavior, escape hatch for SSH users |
| D12 | 3 delivery retries then escalate to team-lead | Matches existing `spawnFailures` pattern |

## Success Criteria

- [ ] Agent with `permissionMode: bypassPermissions` (new scaffold default) executes tools without approval prompt
- [ ] Agent with `permissionMode: remoteApproval` blocks on tool use, writes approval to PG
- [ ] Approval request appears in genie-app chat as interactive message with Approve/Deny/Preview
- [ ] Approval request delivered via Omni to configured WhatsApp chat
- [ ] Human approves via WhatsApp reaction (configurable, default 👍) — agent resumes within 2s
- [ ] Human approves via WhatsApp text reply (configurable, default "y") — agent resumes within 2s
- [ ] Human approves via app Approve button — agent resumes within 1s
- [ ] Timeout (300s default) with no response — auto-deny
- [ ] Custom approve/deny tokens work from `workspace.json`
- [ ] `osc52-copy.sh` uses `$SSH_TTY` as primary clipboard target
- [ ] `GENIE_TMUX_MOUSE=off` disables mouse capture, native Cmd+C works
- [ ] `deliverToPane()` failure triggers retry (3x) then escalation to team-lead
- [ ] `translateSdkConfig()` never copies `permissionMode` into SDK options
- [ ] `ensureTeammateBypassPermissions()` called at SDK executor spawn path
- [ ] Existing tests pass (`tsc --noEmit` + `biome check`)

## Execution Strategy

### Wave 1 (parallel — independent bug fixes)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Permission fix: spread order, strip translateSdkConfig, scaffold default, ensureTeammate |
| 5 | engineer | OSC52 clipboard: `$SSH_TTY` in osc52-copy.sh, `GENIE_TMUX_MOUSE` env opt-out |
| 6 | engineer | Inbox retry: delivery_status column, retry loop, escalation, isAgentAlive |

### Wave 2 (after Group 1 — approval core depends on permission system)
| Group | Agent | Description |
|-------|-------|-------------|
| 2 | engineer | Remote approval core: PG table, migration, hook factory, workspace config, CLI command |
| review-w1 | reviewer | Review Groups 1, 5, 6 |

### Wave 3 (after Group 2 — frontends depend on approval core)
| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer | Omni approval frontend: message handler, reaction/text matching, rate limiting |
| 4 | engineer | App approval frontend: toast, chat message component, sidecar NATS subjects |
| review-w2 | reviewer | Review Group 2 |

### Wave 4 (final)
| Group | Agent | Description |
|-------|-------|-------------|
| review-w3 | reviewer | Review Groups 3, 4 |
| qa | qa | End-to-end QA: all success criteria |

## Execution Groups

### Group 1: Permission Fix
**Goal:** Eliminate the `permissionMode` spread override that causes agent deadlock.

**Deliverables:**
1. `src/lib/providers/claude-sdk.ts` — Delete line that copies `permissionMode` from `translateSdkConfig()` (line 42). Reorder options spread so `permissionMode: 'bypassPermissions'` and `allowDangerouslySkipPermissions: true` come AFTER `...translatedSdk` and `...extraOptions`.
2. `src/lib/providers/claude-sdk.ts` — Call `ensureTeammateBypassPermissions()` at top of `runQuery()`.
3. `src/templates/index.ts` — Change `permissionMode: default` to `permissionMode: bypassPermissions` (line ~93).
4. `src/templates/genie-agents.md` — Change `permissionMode: default` to `permissionMode: bypassPermissions` (line ~9).
5. `src/lib/defaults.ts` — Change `permissionMode: 'default'` to `permissionMode: 'bypassPermissions'` (line ~27).
6. Update existing tests that assert `permissionMode: default` or the old spread order.

**Acceptance Criteria:**
- [ ] `translateSdkConfig()` output never contains `permissionMode` key
- [ ] Options object has `permissionMode: 'bypassPermissions'` after all spreads
- [ ] New scaffolded agent has `permissionMode: bypassPermissions` in frontmatter
- [ ] `ensureTeammateBypassPermissions()` called before SDK query

**Validation:**
```bash
cd repos/genie && npx tsc --noEmit && npx biome check src/
grep -r "permissionMode: 'default'" src/templates/ src/lib/defaults.ts && echo "FAIL: default still present" && exit 1 || echo "PASS"
```

**depends-on:** none

---

### Group 2: Remote Approval Core
**Goal:** Build the PG-backed approval queue and SDK hook that blocks until a human decides.

**Deliverables:**
1. `src/db/migrations/030_approvals.sql` — Create `approvals` table with columns: `id`, `executor_id`, `agent_name`, `tool_name`, `tool_input_preview`, `decision` (pending/allow/deny), `decided_by`, `decided_at`, `timeout_at`, `created_at`. Add trigger `notify_approval_resolved` that fires `pg_notify('genie_approval_resolved', id)` on decision change from pending.
2. `src/lib/providers/claude-sdk-remote-approval.ts` — New file. Export `createRemoteApprovalGate(config)` that returns a PreToolUse hook. Hook inserts approval row, subscribes to LISTEN channel, safety-net polls every 5s, returns allow/deny on resolution or timeout.
3. `src/lib/providers/claude-sdk.ts` — When `sdkConfig.permissionMode === 'remoteApproval'`, wire `createRemoteApprovalGate` as PreToolUse hook instead of the standard permission gate. Keep `permissionMode: 'bypassPermissions'` in SDK options (the hook handles blocking).
4. `src/lib/workspace.ts` — Add `permissions` section to workspace schema: `approveTokens`, `denyTokens`, `timeout`, `defaultAction`, `omniChat`, `omniInstance`.
5. `src/term-commands/approval.ts` — New CLI command `genie approval request --tool <name> --input <preview> --agent <name> --wait` for tmux-path agents. Writes to same PG approvals table, blocks until resolved. Also `genie approval resolve <id> --decision allow|deny --by <actor>`.
6. Register approval CLI commands in `src/genie.ts`.

**Acceptance Criteria:**
- [ ] `approvals` table created by migration
- [ ] `genie approval request --tool Write --input "test" --agent test-agent --wait` blocks and returns on resolve
- [ ] `genie approval resolve <id> --decision allow --by human` resolves pending approval within 2s
- [ ] Timeout auto-resolves with configured `defaultAction`
- [ ] Hook returns `{ permissionDecision: 'allow' }` or `'deny'` correctly

**Validation:**
```bash
cd repos/genie && npx tsc --noEmit && npx biome check src/
```

**depends-on:** Group 1

---

### Group 3: Omni Approval Frontend
**Goal:** Route approval requests to WhatsApp and accept human decisions via text reply or reaction.

**Deliverables:**
1. `src/lib/providers/claude-sdk-remote-approval.ts` — Add Omni send on approval creation: format message with tool name + target + ~200 char preview. Read `omniChat` and `omniInstance` from workspace config. Use `omni send` CLI.
2. Omni incoming message handler — Match incoming text replies against `approveTokens`/`denyTokens` from workspace config. Match reaction emoji on the approval message. On match, call `genie approval resolve <id> --decision allow|deny --by <sender>`.
3. Rate limiting — If >3 pending approvals within 10s, batch into single summary message with count.

**Acceptance Criteria:**
- [ ] Approval request sends formatted WhatsApp message via Omni
- [ ] Reply "y" on WhatsApp resolves approval as allow
- [ ] Reply "n" resolves as deny
- [ ] Reaction 👍 resolves as allow
- [ ] Reaction 👎 resolves as deny
- [ ] Custom tokens from workspace.json work
- [ ] >3 rapid approvals are batched

**Validation:**
```bash
cd repos/genie && npx tsc --noEmit && npx biome check src/
```

**depends-on:** Group 2

---

### Group 4: App Approval Frontend
**Goal:** Show approval requests in the Genie desktop app as toasts and interactive chat messages.

**Deliverables:**
1. `packages/genie-app/src-backend/index.ts` — Add NATS subjects: `genie.approval.request` (subscribe to PG LISTEN, publish to frontend), `genie.approval.resolve` (req/reply — update PG), `genie.approval.list` (req/reply — list pending).
2. `packages/genie-app/views/shared/ApprovalToast.tsx` — New component. Non-blocking toast notification when approval arrives. Shows agent name + tool name + "View in Chat" link. Auto-dismisses after 10s.
3. `packages/genie-app/views/` (chat view) — New `ApprovalMessage.tsx` component. Renders in chat as interactive card: tool info, Approve/Deny buttons, Preview expand. Buttons send NATS `genie.approval.resolve` request.
4. Wire toast into `App.tsx` — subscribe to `events.approval_request` NATS event, render `ApprovalToast`.

**Acceptance Criteria:**
- [ ] Toast appears when approval request fires
- [ ] Chat message renders with Approve/Deny/Preview buttons
- [ ] Approve button resolves approval, agent resumes within 1s
- [ ] Deny button resolves approval, agent gets deny
- [ ] Preview button shows full tool input
- [ ] Agent state shows `permission` in AgentsView during pending approval

**Validation:**
```bash
cd repos/genie && npx tsc --noEmit && npx biome check src/ packages/
```

**depends-on:** Group 2

---

### Group 5: OSC52 Clipboard Fix
**Goal:** Fix clipboard copy over SSH and add mouse capture opt-out.

**Deliverables:**
1. `scripts/tmux/osc52-copy.sh` — Add `$SSH_TTY` as primary target before `who -m` fallback:
   ```bash
   if [ -n "$SSH_TTY" ]; then
     printf '%s' "$seq" > "$SSH_TTY" 2>/dev/null || true
   fi
   ```
2. `scripts/tmux/genie.tmux.conf` — Wrap mouse setting: `if-shell '[ "$GENIE_TMUX_MOUSE" != "off" ]' 'set -g mouse on'`
3. `scripts/tmux/tui-tmux.conf` — Same conditional mouse wrapping.
4. `src/term-commands/serve.ts` — Conditional `set-option mouse on` only when `GENIE_TMUX_MOUSE !== 'off'`.
5. Update `src/__tests__/tmux-config.test.ts` if tests assert unconditional `mouse on`.

**Acceptance Criteria:**
- [ ] `osc52-copy.sh` tries `$SSH_TTY` before `who -m`
- [ ] `GENIE_TMUX_MOUSE=off genie serve` starts without mouse capture
- [ ] Default (no env var) preserves current mouse-on behavior
- [ ] Existing tmux config tests pass

**Validation:**
```bash
cd repos/genie && grep -q 'SSH_TTY' scripts/tmux/osc52-copy.sh && echo "PASS: SSH_TTY present" || exit 1
grep -q 'GENIE_TMUX_MOUSE' scripts/tmux/genie.tmux.conf && echo "PASS: mouse opt-out present" || exit 1
npx tsc --noEmit && npx biome check src/
```

**depends-on:** none

---

### Group 6: Inbox Delivery Retry + Escalation
**Goal:** Stop messages from silently vanishing when target agent is unreachable.

**Deliverables:**
1. `src/db/migrations/031_mailbox_delivery_status.sql` — Add columns to `mailbox` table: `delivery_status TEXT DEFAULT 'pending'` (pending/delivered/failed/escalated), `delivery_attempts INT DEFAULT 0`. Backfill: set existing rows with `delivered_at IS NOT NULL` to `delivery_status = 'delivered'`.
2. `src/lib/mailbox.ts` — Add `markFailed(messageId)` (increment attempts, set status=failed), `getRetryable(maxAttempts)` (return failed messages with attempts < max), `markEscalated(messageId)`.
3. `src/lib/protocol-router.ts` — In `deliverToPane()`, on failure call `mailbox.markFailed()` instead of silent return.
4. `src/lib/scheduler-daemon.ts` — New retry loop every 60s: `getRetryable(3)` → attempt `deliverToPane()` → on 3rd failure call `mailbox.markEscalated()` + send escalation to team-lead via mailbox.
5. `src/lib/team-auto-spawn.ts` — Add `isAgentAlive(agentName): Promise<boolean>` that checks if the specific agent's pane exists (not just the team window). Export for use by inbox-watcher.
6. `src/lib/inbox-watcher.ts` — Use `isAgentAlive` for per-recipient check alongside existing `isTeamActive`.

**Acceptance Criteria:**
- [ ] Failed delivery increments `delivery_attempts` and sets `delivery_status = 'failed'`
- [ ] Retry loop picks up failed messages and re-attempts delivery
- [ ] After 3 failures, message is escalated to team-lead
- [ ] `isAgentAlive` correctly detects dead agent panes
- [ ] Existing mailbox tests pass

**Validation:**
```bash
cd repos/genie && npx tsc --noEmit && npx biome check src/
```

**depends-on:** none

---

## QA Criteria

_What must be verified on dev after merge._

- [ ] Spawn agent with default frontmatter → tools execute without approval prompt (no deadlock)
- [ ] Spawn agent with `permissionMode: remoteApproval` → tool use triggers approval request in PG
- [ ] Approve via app chat → agent resumes, tool executes
- [ ] Approve via WhatsApp reply "y" → agent resumes within 2s
- [ ] Deny via WhatsApp reaction 👎 → agent gets deny, continues gracefully
- [ ] Timeout with no response → auto-deny after configured timeout
- [ ] SSH session: drag-select text, Cmd+C copies to clipboard (via OSC52)
- [ ] `GENIE_TMUX_MOUSE=off` → Cmd+C works natively without OSC52
- [ ] Send message to dead agent → message retried 3x → escalated to team-lead
- [ ] No regressions: `tsc --noEmit`, `biome check`, existing test suite green

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| PG LISTEN missed → hook blocks forever | High | 300s timeout + safety-net polling every 5s |
| Multiple approvals flood WhatsApp | Medium | Rate limit: batch if >3 pending within 10s |
| Approval latency slows agent execution | Medium | Only `remoteApproval` mode — `bypassPermissions` remains default |
| PG approvals table grows unbounded | Low | TTL cleanup: resolved approvals >7d auto-purged by scheduler |
| `$SSH_TTY` not set in all SSH configs | Low | Fallback chain: `$SSH_TTY` → `who -m` → stdout passthrough |
| Inbox retry storms on dead agents | Low | Max 3 retries then escalate once and stop |
| Omni not configured | Low | App UI works independently. If neither configured, timeout auto-denies. |

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
# Group 1 — Permission Fix
src/lib/providers/claude-sdk.ts                    (modify — spread order, strip permissionMode, ensureTeammate)
src/templates/index.ts                             (modify — scaffold default)
src/templates/genie-agents.md                      (modify — scaffold default)
src/lib/defaults.ts                                (modify — builtin default)
src/lib/providers/__tests__/claude-sdk.test.ts     (modify — update assertions)
src/__tests__/defaults.test.ts                     (modify — update assertions)
src/__tests__/mini-wizard.test.ts                  (modify — update assertions)

# Group 2 — Remote Approval Core
src/db/migrations/030_approvals.sql                (create)
src/lib/providers/claude-sdk-remote-approval.ts    (create)
src/lib/providers/claude-sdk.ts                    (modify — wire remoteApproval hook)
src/lib/workspace.ts                               (modify — permissions schema)
src/term-commands/approval.ts                      (create)
src/genie.ts                                       (modify — register approval commands)

# Group 3 — Omni Approval Frontend
src/lib/providers/claude-sdk-remote-approval.ts    (modify — add Omni send)
src/lib/omni-approval-handler.ts                   (create — incoming message matching)

# Group 4 — App Approval Frontend
packages/genie-app/src-backend/index.ts            (modify — approval NATS subjects)
packages/genie-app/views/shared/ApprovalToast.tsx  (create)
packages/genie-app/views/shared/ApprovalMessage.tsx (create)
packages/genie-app/src/App.tsx                     (modify — wire toast subscription)
packages/genie-app/lib/subjects.ts                 (modify — add approval subjects)

# Group 5 — OSC52 Clipboard Fix
scripts/tmux/osc52-copy.sh                         (modify — SSH_TTY primary)
scripts/tmux/genie.tmux.conf                       (modify — conditional mouse)
scripts/tmux/tui-tmux.conf                         (modify — conditional mouse)
src/term-commands/serve.ts                          (modify — conditional mouse)
src/__tests__/tmux-config.test.ts                  (modify — update assertions)

# Group 6 — Inbox Delivery Retry
src/db/migrations/031_mailbox_delivery_status.sql  (create)
src/lib/mailbox.ts                                 (modify — markFailed, getRetryable, markEscalated)
src/lib/protocol-router.ts                         (modify — call markFailed on delivery failure)
src/lib/scheduler-daemon.ts                        (modify — retry loop)
src/lib/team-auto-spawn.ts                         (modify — isAgentAlive)
src/lib/inbox-watcher.ts                           (modify — per-agent check)
```
