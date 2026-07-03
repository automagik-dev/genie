# Wish: Omni Approval UX — Correlated Identity, Reactions, Anti-Spam

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `omni-approval-ux` |
| **Date** | 2026-07-03 |
| **Author** | Felipe + Genie |
| **Appetite** | ~3-4 days |
| **Branch** | `wish/omni-approval-ux` (from `dev`; PR to `dev`) |
| **Design** | _No brainstorm — grounded in the live WhatsApp QA on 2026-07-03_ |
| **Depends on** | `omni-runner-port` (merged), `wish/omni-hardening` (PR #2507) |

## Summary

The v5 omni approval bridge is live-proven (a PreToolUse hook → WhatsApp 🔔 → text `y` → allow envelope, verified end-to-end against the real Omni hub). But the live QA exposed three UX/correctness gaps: replies resolve the OLDEST pending approval rather than the one the human actually answered (concurrent-approval hazard), reactions (👍/👎) don't resolve because genie subscribes `omni.event.>` while this Omni build doesn't publish reactions there, and every approval is a fresh WhatsApp message with no resolution feedback (a stale "Approval Required" prompt lingers even after it's decided). This wish makes approvals correlated, reaction-driven, and self-updating.

## Scope

### IN
- **Correlated approval identity (fixes the oldest-pending hazard):** capture the REAL Omni message id of each sent approval request and store it in `approvals.omni_message_id`, so a reply/reaction resolves the EXACT approval it answered — not `resolveOldest`. Today the runner publishes fire-and-forget to `omni.reply.{instance}.{chat}` and never learns Omni's message id, so it falls back to oldest-pending (a correctness bug the omni-runner-port reviews flagged as LOW, confirmed live). Decision needed (Group 1 spike): send the approval via the **Omni HTTP send API** (which returns a `messageId` — proven: `omni send` returned `3EB097217C5450F5E0166D`) vs. correlating the NATS-published id. Prefer the path that yields a stable id genie can match inbound replies/reactions against.
- **Reaction-based approve/deny:** verify the ACTUAL NATS subject this Omni build publishes reactions on (the live QA could not confirm `omni.event.>` carries them), subscribe the correct subject, and resolve 👍/👎 by correlating to the stored `omni_message_id` from the correlated-identity work. Text `y`/`n` replies remain a fallback. Honor the instance-scope guard already added in PR #2507.
- **Resolution feedback (anti-spam):** on resolve/expire, update the human's thread so a decided approval doesn't linger as an open prompt — e.g. react ✅/❌ on the original approval message (via `omni react`) and/or send a one-line status ("approved by you ✅"). One message per approval, plus one lightweight status signal — never a re-announce (the per-approval `omniMessageId` dedup at omni-runner.ts:360 already prevents re-fires; keep it).
- **Operator guardrails learned from the QA:** document + enforce that enabling approvals requires the CC hook `timeout` ≥ `pollBudgetMs` (PR #2507 documents this; here, make `genie omni handshake`/a doctor check warn if the installed hook timeout is too low). Provide a `genie omni test-approval` helper that drives ONE approval round-trip end-to-end (so future QA is a single command, not ad-hoc scripts that spam).
- **Tests:** correlated-resolution unit tests (two concurrent pending approvals; a reply/reaction tagged to id B resolves B, not the older A); reaction-subject integration test with a fake transport on the verified subject; resolution-feedback test (approve → ✅ status emitted, row expired). All with injectable transport — zero network.

### OUT
- Reworking the hook/dispatch layer or the global-db schema beyond adding/【using】the existing `omni_message_id` column.
- Multi-approval batching / a full interactive TUI in WhatsApp (buttons, lists) — a later wish if wanted.
- Reconnecting the offline `pessoal-whatsapp` instance (a QR scan — Felipe's manual action; not code).
- Sending live WhatsApp messages during automated tests (fake transport only; live QA is the single `genie omni test-approval` helper, run deliberately).
- Changing the approve/deny vocabulary or the timeout→ask fail-safe (both proven correct).

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Correlate resolution by the real Omni message id, retire `resolveOldest` as the primary path | Live QA confirmed the oldest-pending fallback resolves the WRONG approval under concurrency; the human answered a specific message |
| 2 | Group 1 is a SPIKE — verify the real reaction subject + the id-returning send path before building | The live QA disproved the `omni.event.>` assumption and showed `omni send` returns a messageId; the design must be grounded in this Omni build's actual contract, not the v4-ported assumptions |
| 3 | Reactions become first-class; text replies stay as fallback | Reactions are the low-friction, non-spammy approve/deny gesture the operator wants; text is the compatibility path |
| 4 | One approval message + one status update; never re-announce | Anti-spam: the human sees a prompt and its outcome, not a wall of repeated prompts. The per-approval dedup already prevents re-fires |
| 5 | Ship a `genie omni test-approval` one-command harness | The QA spam came from ad-hoc multi-iteration scripts; a single deliberate command makes future testing safe and repeatable |

## Success Criteria

- [ ] G1 spike: `.genie/wishes/omni-approval-ux/SPIKE.md` documents (with evidence from the real hub) the reaction NATS subject + payload shape AND the send path that yields a correlatable message id; verdict on API-send vs NATS-correlate.
- [ ] Correlated resolution: two concurrent pending approvals — a reply/reaction answering the 2nd resolves the 2nd (not the 1st); `omni_message_id` populated from the real send. Tested.
- [ ] Reaction approve/deny resolves on the verified subject, correlated to the right approval; instance-scoped (PR #2507 guard). Tested.
- [ ] Resolution feedback: on approve/deny the original message gets a ✅/❌ (react or status) and the row is expired/closed; no lingering open prompt. Tested.
- [ ] `genie omni test-approval` drives one clean round-trip (against a fake transport in CI; usable live for one deliberate message).
- [ ] Full `bun run check` green; no live messages sent by the automated suite.

## Execution Strategy

| Wave | Groups | Notes |
|------|--------|-------|
| 1 | Group 1 (spike) | Grounds the design in the real Omni contract; gates G2/G3 |
| 2 | Group 2, Group 3 | Correlated identity + reactions ∥ resolution feedback + test harness (touch disjoint areas: queue/runner-resolve vs runner-outbound/CLI) |

---

## Execution Group 1: Spike — reaction subject + correlatable send id
**Goal:** Replace the disproven `omni.event.>` + oldest-pending assumptions with the real contract of this Omni build.

**Deliverables:**
1. Against the live hub (via `ssh felipe`, MINIMAL messages — one send, subscribe-and-observe for reactions): determine (a) the exact NATS subject + payload omni publishes when a WhatsApp user REACTS to a message, and (b) whether the Omni HTTP send API (`/api/v1/...`) returns a stable `messageId` that later inbound replies/reactions reference. Use `omni --json` + a bounded NATS subscriber (omni's nats module) — do NOT run ad-hoc approval loops that spam.
2. `.genie/wishes/omni-approval-ux/SPIKE.md`: the reaction subject + payload shape, the id-returning send path, and a GO recommendation for Group 2 (API-send vs NATS-correlate) with the exact fields genie must store/match.

**Acceptance Criteria:**
- [ ] SPIKE.md documents the reaction subject + payload and the correlatable-send decision, evidence-backed.
- [ ] No spam: the spike sends at most one or two clearly-labelled messages between Felipe's own numbers.

**Validation:**
```bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
test -f .genie/wishes/omni-approval-ux/SPIKE.md
grep -qiE 'reaction.*subject|omni\.[a-z]+' .genie/wishes/omni-approval-ux/SPIKE.md
grep -qiE 'messageId|correlat' .genie/wishes/omni-approval-ux/SPIKE.md
```

**depends-on:** none

---

## Execution Group 2: Correlated identity + reaction approve/deny
**Goal:** A reply/reaction resolves the exact approval it answers; 👍/👎 works.

**Deliverables:**
1. Capture the real Omni message id on send (per the G1 verdict) and store it via `attachOmniMessageId` immediately, so `handleMessage`/`handleEvent` correlate by `omni_message_id` first and only fall back to oldest-pending when no id matches.
2. Subscribe the VERIFIED reaction subject (from G1) instead of the assumed `omni.event.>`; resolve 👍/👎 correlated to the stored id; keep the PR #2507 instance-scope guard.
3. Tests (fake transport): two concurrent pending approvals resolved to the correct one by id; reaction on the verified subject resolves the correlated approval; text fallback still works.

**Acceptance Criteria:**
- [ ] Concurrent approvals resolve by id, not oldest; reactions resolve on the verified subject; instance-scoped.
- [ ] typecheck + `bun test src/lib/omni-runner.test.ts src/lib/v5/omni-queue.test.ts` green.

**Validation:**
```bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
bun test src/lib/omni-runner.test.ts src/lib/v5/omni-queue.test.ts
bun run typecheck
```

**depends-on:** group-1

---

## Execution Group 3: Resolution feedback + one-command test harness
**Goal:** A decided approval stops looking open; future QA is one safe command.

**Deliverables:**
1. On resolve/expire, emit a resolution signal to the original thread — react ✅/❌ on the approval message (via the omni react path / API) and/or a one-line status; expire/close the row so no stale prompt lingers.
2. `genie omni test-approval` command: drives one approval round-trip (enqueue → announce → resolve) against an injectable transport by default (CI-safe, no network); with `--live` it runs ONE real round-trip between the configured instance/approvalChat (deliberate, single message).
3. `genie doctor`/handshake warning when the installed CC hook `timeout` is below `pollBudgetMs` (the operator guardrail the QA proved essential).
4. Tests: resolution-feedback emitted + row closed; `test-approval` fake path green; doctor warning fires on a too-low timeout.

**Acceptance Criteria:**
- [ ] Approve/deny yields a ✅/❌ thread signal and closes the row; no lingering prompt (tested).
- [ ] `genie omni test-approval` (fake) green in CI; `--live` documented.
- [ ] doctor/handshake warns on an inadequate hook timeout.
- [ ] Full `bun run check` green.

**Validation:**
```bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
bun test src/lib/omni-runner.test.ts src/term-commands/omni.test.ts
bun run check
bun run build
bun dist/genie.js omni test-approval 2>&1 | grep -qiE 'approved|allow|round-trip' || { echo "FAIL: test-approval harness"; exit 1; }
```

**depends-on:** group-1

---

## Cross-wish dependencies

- **Builds on** the live-validated `omni-runner-port` bridge + the `omni-hardening` (PR #2507) instance-scope + approval-budget-doc fixes.
- **Records** the 2026-07-03 live QA outcome (allow path proven end-to-end; deny code-verified; personal instance offline; reactions unconfirmed) — this wish closes the reaction + correlation gaps that QA exposed.
