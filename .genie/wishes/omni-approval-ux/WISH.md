# Wish: Omni Approval UX — Correlated Identity, Reactions, ⏳→✅ Acks

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `omni-approval-ux` |
| **Date** | 2026-07-03 |
| **Author** | Felipe + Genie |
| **Appetite** | ~3-4 days |
| **Branch** | `wish/omni-approval-ux` (from `dev`; PR to `dev`) |
| **Design** | _No brainstorm — grounded in the live WhatsApp QA on 2026-07-03_ |
| **Depends on** | `omni-runner-port` (merged), `omni-hardening` (PR #2507, merged) |

## Summary

The v5 omni approval bridge is live-proven (a PreToolUse hook → WhatsApp 🔔 → text `y` → allow envelope, verified end-to-end against the real Omni hub). But the live QA exposed UX/correctness gaps: replies resolve the OLDEST pending approval rather than the one the human answered (concurrent-approval hazard); reactions (👍/👎) don't reliably resolve; and an approval message gives the human NO feedback about its state — it looks unread until (and after) it's decided. This wish makes approvals **correlated** (a reaction — or a quoted reply — resolves the exact approval it targets, via the real Omni message id; bare text stays an oldest-pending fallback), **reaction-driven** (👍/👎 approve/deny), and **self-updating** via a **two-state ⏳→✅ ack**: genie sets a ⏳ (ampulheta) status reaction on its OWN approval message the moment it's sent, then swaps it to ✅ (approved) / ❌ (denied/expired) once resolved — so the human always sees a message's live state at a glance.

## Scope

### IN
- **Two-state ⏳→✅ acknowledgement (the headline UX):** the instant an approval request is sent, genie sets a ⏳ reaction on its OWN approval message (received & awaiting you); on resolve it swaps that reaction to ✅ (approved) / ❌ (denied), and on expiry to ❌/⌛. WhatsApp reactions are one-per-sender-per-message, so genie's status reaction swaps in place and coexists with the human's separate 👍/👎 decision reaction. This needs an OUTBOUND set-reaction capability (react to a message genie sent) that **does not exist today** — G1 spike verifies it (GO) or picks a fallback (NO-GO): editing the sent message to prepend a status glyph, or a one-line status reply.
- **Correlated approval identity (fixes the oldest-pending hazard):** the `omni_message_id` column + `attachOmniMessageId` already exist (`omni-queue.ts:217`, `global-db.ts:90`), but `announce()` stores genie's OWN local `genId()` ref (`omni-runner.ts:367`), not the real Omni message id — a self-referential illusion. Capture the REAL Omni id on send (per the G1 verdict) and store THAT, then make the inbound paths correlate by it first: `handleEvent` already correlates reactions by `omniMessageId` with an oldest fallback (`omni-runner.ts:444-451`) — extend the same id-first correlation to the text path (`handleMessage`, currently unconditional `resolveOldest` at `omni-runner.ts:421`). A reaction or a quoted reply resolves the exact approval; bare unquoted text keeps the oldest-pending fallback (documented, not claimed as correlated).
- **Reaction-based approve/deny:** verify the ACTUAL NATS subject this Omni build publishes inbound reactions on (the live QA could not confirm `omni.event.>`), subscribe the correct subject, and resolve 👍/👎 correlated to the stored real `omni_message_id`. Honor the instance-scope guard added in PR #2507.
- **Operator guardrails learned from the QA:** a `genie doctor` (`src/genie-commands/doctor.ts`)/handshake warning when the installed CC hook `timeout` is below `pollBudgetMs`. A `genie omni test-approval` helper that drives ONE approval round-trip end-to-end (so future QA is a single command, not ad-hoc scripts that spam).
- **Tests (injectable transport, zero network):** two concurrent pending approvals — a reaction/quoted reply tagged to id B resolves B, not the older A; the ⏳→✅/❌ status-reaction (or NO-GO fallback) lifecycle; reaction approve/deny on the verified subject; resolution closes the row; the `test-approval` fake path; the doctor timeout warning.

### OUT
- Reworking the hook/dispatch layer or the global-db schema beyond USING the existing `omni_message_id` column (+ at most a small status-reaction bookkeeping field if the spike shows one is needed).
- Multi-approval batching / a full interactive TUI in WhatsApp (buttons, lists) — a later wish.
- Reconnecting the offline `pessoal-whatsapp` instance (a QR scan — Felipe's manual action; not code).
- Sending live WhatsApp messages during automated tests (fake transport only; live QA is the single `genie omni test-approval --live` helper, run deliberately, between Felipe's own numbers).
- Changing the approve/deny vocabulary or the timeout→ask fail-safe (both proven correct).
- Correlating bare unquoted text replies (no quoted-message id → stays oldest-pending fallback; correlation is for reactions + quoted replies).

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Two-state ⏳→✅ ack via genie's OWN swapping status reaction (fallback: message-edit / status line if no outbound-react API) | Felipe's explicit ask: hourglass on receipt, green check once answered. A single swapping reaction is the lowest-noise way to show live state; coexists with the human's 👍/👎. The capability is unverified, so G1 gates it with a NO-GO fallback |
| 2 | Correlate resolution by the REAL Omni message id; retire the self-referential local ref at `omni-runner.ts:367` | Live QA confirmed oldest-pending resolves the WRONG approval under concurrency; today `announce()` stores a genId() ref that matches nothing inbound. The real id is also the target for the status reaction |
| 3 | Group 1 is a SPIKE — verify (a) the inbound reaction subject, (b) the id-returning send path, (c) the OUTBOUND set-reaction capability, AND (d) whether inbound text replies carry a quoted-message id — before building | The live QA disproved `omni.event.>`; the ⏳→✅ ack depends on outbound-react existing; text correlation depends on a quoted id. Ground all four in this Omni build's actual contract with an explicit GO/NO-GO per capability |
| 4 | Reactions first-class (both directions); text replies stay as fallback | Genie's ⏳/✅/❌ status outbound, the human's 👍/👎 inbound. Bare text is the compatibility path (oldest-pending) |
| 5 | One approval message + in-place status; never re-announce | Anti-spam: the human sees a prompt and its live state, not a wall of prompts. The per-approval `omniMessageId` dedup already prevents re-fires |
| 6 | Ship a `genie omni test-approval` one-command harness | The QA spam came from ad-hoc multi-iteration scripts; one deliberate command makes future testing safe and repeatable |

## Success Criteria

- [ ] **G1 spike:** `.genie/wishes/omni-approval-ux/SPIKE.md` documents (evidence from the real hub) the inbound reaction NATS subject + payload, the send path that yields a correlatable message id, the outbound set-reaction capability (GO/NO-GO + the swap mechanism or the fallback), AND whether inbound text replies carry a quoted-message id — with the exact fields genie stores/matches.
- [ ] **⏳→✅ ack lifecycle:** on announce, the approval message carries a ⏳ status (reaction, or the NO-GO fallback); on approve it becomes ✅; on deny/expire ❌. Verified with a fake transport asserting the set-reaction/edit calls + target id.
- [ ] **Correlated resolution:** two concurrent pending approvals — a reaction/quoted reply answering the 2nd resolves the 2nd (not the 1st); `omni_message_id` holds the REAL send id. Tested. (Bare unquoted text still resolves oldest — documented fallback, also tested.)
- [ ] **Reaction approve/deny** resolves on the verified subject, correlated to the right approval; instance-scoped (PR #2507 guard). Text fallback still works. Tested.
- [ ] `genie omni test-approval` drives one clean round-trip (fake transport in CI; `--live` documented); `genie doctor`/handshake warns when the CC hook timeout < pollBudgetMs.
- [ ] Full `bun run check` green; NO live messages sent by the automated suite.

## Execution Strategy

| Wave | Groups | Notes |
|------|--------|-------|
| 1 | Group 1 (spike) | Grounds the design: inbound reaction subject + id-returning send + outbound set-reaction (GO/NO-GO) + text quoted-id. Gates all |
| 2 | Group 2 | Correlated identity + inbound reactions — captures the real send id G3 needs |
| 3 | Group 3 | ⏳→✅ status lifecycle + resolution close + `test-approval` + doctor. Depends on G2 (the ⏳ target is the real id G2 captures) |

> Sequential (G1→G2→G3), not parallel: G3's status reaction targets the real Omni id that only G2 teaches the runner to capture, and both modify `announce()`/the resolve path in `omni-runner.ts` — parallel edits would conflict and G3 would react to a non-existent ref.

---

## Execution Group 1: Spike — reaction subjects (in + out), correlatable send id, text quoted-id
**Goal:** Replace the disproven `omni.event.>` + self-referential-id assumptions, confirm genie can SET a reaction on a message it sent (or pick a fallback), and learn whether text replies carry a quoted id — using the real contract of this Omni build.

**Deliverables:**
1. Against the live hub (via `ssh felipe`, MINIMAL messages — one/two clearly-labelled sends between Felipe's OWN numbers 1986780008↔12982298888, subscribe-and-observe for reactions): determine (a) the exact NATS subject + payload omni publishes when a WhatsApp user REACTS; (b) whether the Omni HTTP send API returns a stable `messageId` later inbound events reference; (c) the OUTBOUND set-reaction path — can genie set/change a reaction (⏳ then ✅) on a message it sent, and does the emoji swap in place? If NO, the fallback (message-edit prepend, or a status reply); (d) whether an inbound text reply payload carries a quoted/replied-to message id. Use `omni --json` + a bounded NATS subscriber — NO ad-hoc approval loops.
2. `.genie/wishes/omni-approval-ux/SPIKE.md`: the inbound reaction subject + payload, the id-returning send path, the outbound set-reaction GO/NO-GO + swap-or-fallback mechanism, the text quoted-id finding, and a GO recommendation for G2/G3 with the exact fields genie must store/match.

**Acceptance Criteria:**
- [x] SPIKE.md documents the inbound reaction subject + payload, the correlatable-send decision, the outbound set-reaction GO/NO-GO (+ fallback if NO-GO), and the text quoted-id finding — evidence-backed.
- [x] No spam: at most one or two clearly-labelled messages between Felipe's own numbers.

**Validation:**
```bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
test -f .genie/wishes/omni-approval-ux/SPIKE.md
grep -qiE 'reaction.*subject|omni\.[a-z]+' .genie/wishes/omni-approval-ux/SPIKE.md
grep -qiE 'messageId|correlat' .genie/wishes/omni-approval-ux/SPIKE.md
grep -qiE 'set.?reaction|outbound react|GO/NO-GO|fallback' .genie/wishes/omni-approval-ux/SPIKE.md
```

**depends-on:** none

---

## Execution Group 2: Correlated identity + inbound reaction approve/deny
**Goal:** Store the REAL Omni send id and resolve a reaction/quoted reply to the exact approval it answers; 👍/👎 works.

**Deliverables:**
1. In `announce()` (`omni-runner.ts:358-370`), replace the self-referential local `genId()` ref stored at `omni-runner.ts:367` with the REAL Omni message id captured from the send (per the G1 verdict — API-send return or NATS-correlated), via the existing `attachOmniMessageId` (`omni-queue.ts:217`) into the existing `omni_message_id` column (`global-db.ts:90`). Do NOT re-add the column/helper — they exist.
2. Extend the id-first correlation already present in `handleEvent` (`omni-runner.ts:444-451`) to the text path `handleMessage` (`omni-runner.ts:421`, currently unconditional `resolveOldest`): correlate by the real `omni_message_id` when the inbound carries a quoted/replied id (per G1(d)); fall back to oldest only for bare unquoted text. Subscribe the VERIFIED inbound reaction subject (from G1) instead of the assumed `omni.event.>`; keep the PR #2507 instance-scope guard.
3. Tests (fake transport): two concurrent pending approvals resolved to the correct one by the real id; reaction on the verified subject resolves the correlated approval; a quoted reply resolves the correlated approval; bare text still resolves oldest.

**Acceptance Criteria:**
- [x] Concurrent approvals resolve by the real id (reaction/quoted reply), not oldest; reactions resolve on the verified subject; bare text = oldest fallback; instance-scoped.
- [x] typecheck + `bun test src/lib/omni-runner.test.ts src/lib/v5/omni-queue.test.ts` green.

**Validation:**
```bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
bun test src/lib/omni-runner.test.ts src/lib/v5/omni-queue.test.ts
bun run typecheck
```

**depends-on:** group-1

---

## Execution Group 3: ⏳→✅ status lifecycle + resolution close + test harness + doctor
**Goal:** Every approval shows its live state via a swapping status (reaction or NO-GO fallback); a decided approval closes; future QA is one safe command.

**Deliverables:**
1. **⏳→✅ ack lifecycle:** on announce, set a ⏳ status on the approval message targeting the REAL Omni id captured in G2 — via the outbound set-reaction path from G1 (GO), or the G1 fallback (message-edit / status line) if NO-GO; on resolve, swap to ✅ (approved) / ❌ (denied); on expiry, ❌/⌛. Close/expire the row so no stale open prompt lingers. Never re-announce.
2. `genie omni test-approval` command: drives one approval round-trip (enqueue → announce+⏳ → resolve+✅) against an injectable transport by default (CI-safe, no network); `--live` runs ONE real round-trip between the configured instance/approvalChat (deliberate, single message).
3. `genie doctor` (`src/genie-commands/doctor.ts`)/handshake warning when the installed CC hook `timeout` is below `pollBudgetMs`.
4. Tests (fake transport): ⏳ set on announce with the right target id; swapped to ✅ on approve, ❌ on deny/expire; row closed; `test-approval` fake path green; doctor warning fires on a too-low timeout.

**Acceptance Criteria:**
- [ ] Announce sets ⏳ on the approval message (real id); approve→✅, deny/expire→❌; row closed; no lingering prompt (tested with a fake transport asserting the set-reaction/edit calls + target).
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

**depends-on:** group-2

---

## Cross-wish dependencies

- **Builds on** the live-validated `omni-runner-port` bridge + the `omni-hardening` (PR #2507) instance-scope + approval-budget-doc fixes.
- **Records** the 2026-07-03 live QA outcome (allow path proven end-to-end; deny code-verified; personal instance offline; reactions unconfirmed) — this wish closes the reaction + correlation + feedback gaps that QA exposed.
