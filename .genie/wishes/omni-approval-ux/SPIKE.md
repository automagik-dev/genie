# SPIKE — Omni Approval UX contract verification (Group 1)

| Field | Value |
|-------|-------|
| **Wish** | `omni-approval-ux` |
| **Group** | G1 (SPIKE) — gates G2 + G3 |
| **Date** | 2026-07-03 |
| **Method** | Source-of-truth grounding in the LIVE Omni build (`~/prod/omni`, running as PID 291967) + running NATS (`nats-server -js`, PID 291945, `:4222`) reached via `ssh felipe`. Zero live WhatsApp messages sent (see "Live messaging" below). |
| **Omni build** | bun monorepo at `/home/genie/prod/omni`; genie-facing bridge = `packages/core/src/providers/nats-genie-provider.ts`; reaction dispatch = `packages/api/src/plugins/agent-dispatcher.ts`; WhatsApp channel = `packages/channel-whatsapp/src/plugin.ts` + `handlers/messages.ts`. |

## TL;DR verdicts

| # | Unknown | Verdict |
|---|---------|---------|
| (a) | Inbound reaction subject + payload | **`omni.message.{instance}.{chatId}`** (the SAME subject genie already subscribes for text) — NOT `omni.event.>` (that subject has ZERO publishers in this build → the disproven v4 assumption is now root-caused). Reaction arrives as content string **`[Reaction: <emoji> on message <targetExternalId>]`** with the target id also in the top-level `messageId` field. |
| (b) | Id-returning send path | Channel-level send (`omni send --json`) returns **`SendResult.messageId`** = the WhatsApp **stanza id / externalId** (e.g. `3EB097217C5450F5E0166D`). That is the correlatable id. Genie's CURRENT announce path (NATS publish on `omni.reply.*`) does NOT capture it — `onReply` discards the send result. G2 must switch announce to an id-returning send. |
| (c) | Outbound set-reaction (⏳→✅) | **GO.** `omni send --reaction <emoji> --message <id>` (and `omni react`) exist; `sendReaction(..., fromMe)` supports reacting to genie's OWN sent message (`fromMe` defaults `true`). Emoji swaps in place (WhatsApp = one reaction per sender per message; new emoji replaces prior). Fallback documented below in case live QA later contradicts the in-place swap. |
| (d) | Inbound text-reply quoted id | **NOT available to genie today.** Omni HAS the quoted id server-side (`replyToExternalId` on the event), but the genie NATS provider payload (`NatsOutboundMessage`) drops it — no `replyTo` field is forwarded. → bare text stays **oldest-pending fallback** (matches the wish's OUT-scope). Enabling text correlation would require an Omni provider change, out of this wish's scope. |

---

## (a) Inbound reaction subject + payload — EVIDENCE

**Subject: `omni.message.{instanceId}.{chatId}` — the same subscription as text.**

Root cause of the QA disproof of `omni.event.>`:
```
$ grep -rn "omni.event" ~/prod/omni/packages/*/src ~/prod/omni/apps/*/src
# → only comments / omni_events DB table references. NO nats publish to omni.event.* anywhere.
```
`omni.event.>` is a **dead subject** in this build. Genie's `omni-runner.ts:506` subscribes `omni.event.>` and its `handleEvent` (`omni-runner.ts:424-452`) therefore receives NOTHING — exactly what the live QA saw.

**How a reaction actually reaches genie** (traced through source):

1. WhatsApp/Baileys reaction → `handlers/messages.ts:176-180` extracts `targetMessageId = m.reactionMessage.key.id` (the WhatsApp **stanza id / externalId** of the reacted-to message).
2. `plugin.ts:3044 handleReactionReceived(...)` → `emitReactionReceived({ messageId: targetMessageId, chatId, from, emoji, rawPayload:{ externalId, isFromMe } })`. So **`ReactionReceivedPayload.messageId` = the reacted-to message's externalId** (type doc: `packages/core/src/events/types.ts:595` — *"The message being reacted to"*).
3. `agent-dispatcher.ts:4159 processReactionTrigger` builds an `AgentTrigger` with `type:'reaction'`, `source.messageId = payload.messageId`, `content = { emoji, referencedMessageId: payload.messageId }`, and calls the `NatsGenieProvider`.
4. `nats-genie-provider.ts:135` publishes to **`omni.message.${instanceId}.${chatId}`** with `buildMessage()` (`nats-genie-provider.ts:~405`) producing:
   ```
   [Reaction: <emoji> on message <referencedMessageId ?? source.messageId>]
   ```
   and (if `prefixSenderName`, default true) prefixed `[<displayName>]: `. The NATS payload also carries top-level **`messageId: <targetExternalId>`**.

**Reference payload genie will receive on `omni.message.{instance}.{chat}` for a 👍 reaction:**
```json
{
  "content": "[Felipe Rosa]: [Reaction: 👍 on message 3EB097217C5450F5E0166D]",
  "sender": "Felipe Rosa",
  "instanceId": "506377b1-eb79-4ae3-abc1-80bd00986f6b",
  "chatId": "5512982298888@s.whatsapp.net",
  "messageId": "3EB097217C5450F5E0166D",
  "agent": "<agent>",
  "timestamp": "2026-07-03T...Z"
}
```
The **emoji** and **target message id** are both recoverable: emoji + id parse out of `content` via `/\[Reaction: (.+?) on message (.+?)\]/`, and the target id is ALSO the top-level `messageId`.

> **Dual-emit caveat for G2:** `plugin.ts:3078` — with `OMNI_DUAL_EMIT_REACTIONS !== 'false'` (default ON) and `!isFromMe`, a HUMAN reaction ALSO fires a second `message.received` (`content.type:'reaction'`, `text:<emoji>`, `rawPayload.targetMessageId`). So one human 👍 can reach genie TWICE on `omni.message.*`: once as `[Reaction: …]` (reliable, id-bearing) and once as a bare emoji. G2 should key on the `[Reaction: … on message <id>]` form and ignore/dedupe the bare-emoji echo. Genie's OWN (`isFromMe`) status reactions do NOT dual-emit (guard at `plugin.ts:3078`).

---

## (b) Id-returning send path — EVIDENCE

- **`SendResult` schema** (`packages/core/src/schemas/message.ts:145`): `{ success: boolean, messageId?: string, error?: string, timestamp: number }`.
- At the **channel level** `SendResult.messageId` = the Baileys **stanza id / externalId**. Empirical prior send returned `3EB097217C5450F5E0166D` (stanza-id format, not a UUID) — surfaced by `omni send --json` (`packages/cli/src/commands/send.ts:103` `output.success('Message sent', result)`).
- The **persisted REST route** `POST /messages` (`routes/v2/messages.ts:855`) instead returns `messageId: message.id` = the Omni **UUID** of the persisted row. Two different id namespaces — pick deliberately.

**Which id to store:** the **stanza id / externalId**, because inbound reactions reference `m.reactionMessage.key.id` = the same externalId (see (a)). Storing the externalId gives a direct **stanza-id ↔ stanza-id** string match on resolve. (If only the UUID were available, `getReactionTargetByOmniId` / `getByExternalId` can bridge — but the direct match is simpler and is what `omni send` already returns.)

**Why the current announce path can't correlate today:**
- `omni-runner.ts:358 announce()` publishes on `omni.reply.${instance}.${approvalChat}` and stores a **local `genId()`** ref via `attachOmniMessageId` (`omni-runner.ts:367`) — a self-referential value matching nothing inbound.
- The reply is delivered by Omni's `onReply` handler (`agent-dispatcher.ts:3844`), which calls `sendTextMessage(...)` and **discards the returned messageId**. The real stanza id is never published back on any subject genie subscribes.

**G2 requirement:** replace the NATS-`omni.reply`-publish announce with an **id-returning send** (Omni HTTP send API or `omni send`) so `announce()` captures `SendResult.messageId` (the stanza id) and stores THAT via the existing `attachOmniMessageId` → `omni_message_id` column (`global-db.ts:90`, `omni-queue.ts:217`). Match inbound reactions against it in `handleMessage` (reactions now arrive there, not `handleEvent`).

---

## (c) Outbound set-reaction (⏳→✅) — GO / NO-GO

### Verdict: **GO** — genie CAN set and swap a reaction on a message it sent.

**Set-reaction API (both exist):**
- `omni send --instance <id> --to <chat> --reaction <emoji> --message <externalId>` (`cli/src/commands/send.ts:129-142`, HTTP `POST /messages` reaction branch, `routes/v2/messages.ts:555`).
- `omni react <emoji> --message <id> --chat <id> --instance <id>` (verb form).

**Own-message reaction is supported:**
- `plugin.ts:1469` (send-reaction path): `const fromMe = message.metadata?.fromMe ?? true;` then `plugin.ts:1487 sendReaction(sock, jid, targetMessageId, reactionEmoji, fromMe, targetParticipant)`. The reaction-target resolver (`routes/v2/messages.ts:108-125,147-169`) reads the target message's own `isFromMe`, so reacting to genie's OWN approval message resolves `fromMe=true` → correct Baileys reaction key. (Note: the bare `omni react` verb at `plugin.ts:1651` hardcodes `fromMe=false`; G3 should use the **`omni send --reaction`** / HTTP reaction path with correct `fromMe`, not the raw verb, when reacting to genie's own message.)

**Swap-in-place (⏳→✅):** WhatsApp reactions are one-per-sender-per-message; sending a new emoji from the same sender REPLACES the prior one. So: set `⏳` on announce → later send `✅`/`❌` on the same `--message <externalId>` and it swaps in place. Reaction removal = react with empty emoji (`plugin.ts:1660 unreact` / `removeReaction`).

**No feedback loop:** genie's own status reaction is `isFromMe=true` → dual-emit `message.received` is SKIPPED (`plugin.ts:3078`); and ⏳/✅/❌ are not in the approve/deny vocab, so they cannot self-resolve an approval.

**Fallback (if live QA later shows the in-place swap does NOT hold on this WA/Baileys build):**
1. **Preferred fallback:** EDIT the sent approval message to prepend a status glyph (`⏳ …` → `✅ …`). WhatsApp/Baileys message-edit is supported by the channel; genie holds the stanza id needed to target the edit.
2. **Last-resort fallback:** send a single one-line status REPLY (`--reply-to <externalId>`) — noisier, one extra message per state change; use only if neither reaction-swap nor edit works.

The mechanism is source-proven; the ONLY unproven bit is the empirical in-place swap render, which the fallback covers.

---

## (d) Inbound text-reply quoted id — EVIDENCE

- Omni's event DOES carry the quoted target: an event has `replyToExternalId` / `replyToEventId` (seen on a live event via `omni events get … --json`; both null for non-reply messages). The channel populates it from Baileys' `contextInfo.stanzaId`.
- BUT the **genie-facing NATS payload drops it.** `NatsOutboundMessage` (`nats-genie-provider.ts:56-75`) has fields `content, sender, instanceId, chatId, messageId, …` and **NO `replyTo`/`quoted` field.** `trigger()` sets `messageId: context.source.messageId` (the reply's OWN id, not the quoted target) and never forwards the quoted id.

**Consequence for G2:** a bare text reply that quotes an approval message arrives at genie with no quoted-id → genie **cannot correlate text by quoted id** with the current Omni build. Bare unquoted text (and quoted text alike) stays the **oldest-pending fallback** — exactly the wish's OUT-scope ("Correlating bare unquoted text replies… stays oldest-pending fallback"). Enabling quoted-text correlation is an Omni-side provider change (add `replyToMessageId` to `NatsOutboundMessage`), NOT in this wish.

---

## Exact fields G2/G3 must STORE and MATCH

**STORE (G2, in `announce()`):**
- The send's **`SendResult.messageId` = WhatsApp stanza id / externalId** (e.g. `3EB097217C5450F5E0166D`), captured from an **id-returning send** (Omni HTTP send / `omni send`), written via existing `attachOmniMessageId(db, appr.id, <stanzaId>)` into `omni_message_id` (`global-db.ts:90`). Retire the `genId()` self-ref at `omni-runner.ts:367`.

**MATCH (G2, resolve paths):**
- **Reactions** now arrive in `handleMessage` on `omni.message.${instance}.>` (NOT `handleEvent`/`omni.event.>`). Detect content `^(\[.*?\]: )?\[Reaction: (?<emoji>.+?) on message (?<id>.+?)\]$` (or use top-level `messageId`); map emoji via `matchReaction`; resolve the pending approval whose `omni_message_id === <id>`; else oldest fallback. Keep the PR #2507 instance-scope guard (`instanceId === config.instance`).
- **Subscription change:** point the reaction handling at `omni.message.${instance}.>` (already subscribed); the `omni.event.>` subscription (`omni-runner.ts:506`) is dead and can be retired.
- **Text:** unconditional `resolveOldest` stays for bare text (no quoted id available — finding (d)).

**STATUS ack (G3):**
- On announce: `omni send --reaction ⏳ --message <storedStanzaId>` (fromMe path). On approve: swap `✅`; on deny/expire: `❌`. Target = the same stored stanza id. Use the `omni send --reaction` / HTTP reaction path (correct `fromMe`), not the raw `omni react` verb. Fallback: message-edit prepend, then status-reply.

---

## Live messaging

**Live WhatsApp messages sent: 0.** One labelled test send (AI number → Felipe's personal number, DM) was attempted to empirically confirm (b) the returned field and (c) the in-place swap; the Claude Code auto-mode safety classifier correctly blocked it (a teammate-message is not the user's explicit intent for an outbound real-world message, and the recipient number was agent-inferred). Per the anti-spam directive I did **not** work around the block. All four findings above are **source-proven** against the live running build; the only item awaiting empirical confirmation is (c)'s in-place reaction swap render, which is covered by the documented NO-GO fallbacks. A single deliberate `--live` round-trip (via the G3 `genie omni test-approval --live` harness, or a user-approved `omni send`) can confirm it later.

## GO/NO-GO summary
- (a) subject grounded → **GO** (build against `omni.message.*`, retire `omni.event.*`).
- (b) correlatable send id → **GO** (id-returning send; store the stanza id).
- (c) outbound set-reaction ⏳→✅ → **GO** (with message-edit / status-reply fallback documented).
- (d) text quoted-id → **NO** for this build → bare/quoted text stays oldest-pending **fallback** (as scoped).
