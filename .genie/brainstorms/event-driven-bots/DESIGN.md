# Design: durable wake-ups for the Bot team, slice one

Status: DESIGN, written 2026-10-26 by Genie (the reviewer of record moved to Genie automagik, see the last section).
Decisions: Felipe, 2026-10-26, delegated by the user ("decide between the both of you"), with Genie's corrections folded in.
Evidence: [EVENT-SURFACE.md](EVENT-SURFACE.md), [BOT-WISH-EVIDENCE.md](BOT-WISH-EVIDENCE.md), [OMNI-EVIDENCE.md](OMNI-EVIDENCE.md).
Code read: `automagik` at `879f53b` (`apps/bots-dsh/src/host/*`), installed `@automagik/genie-dsh` 0.1.4, installed dsh 0.2.1-rc.3.

## Problem

A finished piece of work must wake the actor that is waiting for it, and it must still do that after a dsh restart. Today three paths save "finished" before the report goes out, and the report goes out fire-and-forget:

| Path | Where | What a crash between the two loses |
|---|---|---|
| Task report | `agents.js:294` sets `done`, `:305` delivers with `void … .catch(warn)` | The report. The `status !== 'working'` guard (`agents.js:273-274`) then stops it from being sent again. |
| Group report_back | `groups.js:959` `closeWork`, `:960` deliver with `.catch(warn)` | The report, and the poster's work is already closed. Round state is process-local (`turns.js:84-94`). |
| Wish completion | genie-dsh `genie.js:277` reacts to the task's `turn/end`; the report is the generic task report above, sent to the Genie that granted the wish | The asker one level up is never woken. The Genie answered it with "started on wish/…" long before the wish ended. |

Nothing replays these on restart. `inflight.json` (`resume.js:64-93`) is a best-effort hint: written asynchronously, with torn writes accepted, and cleared before it is processed (`resume.js:274-277`). `session/event` listeners do not see restored history (EVENT-SURFACE.md). The 19:20 restart today was this failure: a call was dropped and nobody was woken.

## Decisions (settled, not reopened here)

1. **The wake log lives on the dsh side**: an append-only JSONL file in the bots-dsh state dir, fsynced before any delivery. Omni's journal is out for slice one.
2. **An event only wakes a session.** It arrives as an inbox message. It never re-arms a disarmed `/goal`, and nothing in this slice calls `goals.resume`. A goal resumes only with human authorization (`dsh-goal` `lib/index.js:594-603`: every load and every goal change disarms unless the change itself armed it).
3. **The intent is logged before the terminal save**: before `done`, before `closeWork`, before a wish is marked delivered.
4. **Slice one covers three causes**: task-done, wish completion (it also wakes whoever dispatched the wish), and group report_back. Excluded: `agent/assistant-stream`, any broker, and a general "subscribe to any event" API.
5. **Acceptance**: tests at two crash points (A: before delivery; B: after the recipient persisted the message, before the ack) show the report arriving exactly once after restart.

## The wake log

File: `<home>/wake.jsonl`, where `home` is the same bots-dsh state dir that holds `inflight.json` (`resume.js:64`). Only the host that saves the team writes it. When `rt.readOnly() !== undefined` the host neither writes nor replays it, the same rule `persist()` follows (`resume.js:79`).

Each line is one JSON object, `v: 1`. There are three line kinds:

```jsonc
// 1. intent: written and fsynced before the terminal save and before delivery
{"v":1,"op":"intent","deliveryId":"task-done:<taskSessionId>:<turnEndSeq>","at":1761520000000,
 "cause":{"kind":"task-done","sessionId":"<taskSessionId>","seq":412},
 "to":{"botId":"<botId>","sessionId":"<optional explicit session>"},
 "args":{"role":"task-done","text":"…","note":"…","taskSessionId":"…"}}
// 2. ack: the recipient's session log holds the message, flushed
{"v":1,"op":"ack","deliveryId":"…","at":…,"sessionId":"<recipient session>","seq":<user/message seq>}
// 3. dropped: closed without delivery, with the reason
{"v":1,"op":"dropped","deliveryId":"…","at":…,"reason":"recipient-deleted|discarded-by-user"}
```

`args` holds exactly the `deliver()` arguments minus `exchangeId`, so a replay calls the same function with the same input. A long text is kept the same way `deliver()` keeps it today: `attachLong` stores the file first, and the intent records the file reference.

### deliveryId: stable, deterministic, and the exchangeId

- `deliveryId` is derived from the cause, never random:
  - `task-done:<taskSessionId>:<seq of the turn/end>`
  - `wish-done:<taskSessionId>:<seq of the turn/end>`
  - `report:<roomId>:<post exchange id>`
- It is passed to `deliver()` as `exchangeId`. No new source field is added. The recipient's `user/message` carries `source.exchangeId === deliveryId`, which is what `resume.js` already keys its inbox and `taken` checks on (`resume.js:136-158, 224`).
- Determinism matters for one crash window. If dsh dies after the cause (`turn/end`) but before the intent line, the startup sweep re-derives the same id. A second derivation of an id already in the log is a no-op.

### Write order

```
cause durable in the source session (turn/end appended)
  → 1. append intent line + fd.datasync()           ← awaited
  → 2. terminal save (task done / closeWork / wish delivered)
  → 3. deliver(args, exchangeId = deliveryId)          (followup + sessions.flush, delivery.js:101-103)
  → 4. recipient persists: its session log gets user/message{source.exchangeId = deliveryId}
  → 5. append ack line + fd.datasync()               ← after ctx.sessions.flush(recipient session)
```

- Steps 1 and 5 use `fs.promises.open(path, 'a')` → `appendFile(line + '\n')` → `datasync()`, one awaited chain per process (same pattern as `store.js:305-341`).
- Step 2 no longer races the report. If step 1 throws, step 2 does not run: the task stays `working` and the sweep picks it up. That is the honest state.
- Step 5 is driven by an event, not a timer. A `session/event` listener sees `user/message` with an `exchangeId` that matches an open intent, awaits the flush of that session, then appends the ack.
- The ack is an optimization. The recipient's session log is the truth, and a lost ack is repaired at startup by the dedupe check below.

### Recipient deduplication by ID (closes crash point B)

Before any replayed delivery, an open intent is checked against the recipient, in this order:

1. **Session log**: `rt.eventsBackwards(recipientSession)` (`chat-index.js:53`) finds a `user/message` with `source.exchangeId === deliveryId` → write the ack and skip delivery.
2. **Inbox**: `agent.inbox.nextStep` / `nextTurn` holds that exchangeId (the same check as `resume.js:224`) → leave the intent open. The live ack listener closes it when a turn admits it.
3. **Neither** → `deliver({...args, exchangeId: deliveryId, resent: true})`. `resent` skips the `state.exchanges` push (`delivery.js:81`), which stops replay from duplicating the dialog row.

The backward scan is bounded by `HISTORY_PAGES_MAX`. An intent whose message is older than the scan reaches is a recipient that has had a long conversation since. The design treats "not found within bounds" as "not delivered" and accepts one duplicate in that case. A test pins this behaviour, so it is stated, not hidden.

### Startup catch-up

This runs inside `resumeAll()` (`resume.js:271`), after `rt.load()`, before `resendQueued` (`:290`) and before `healCutSessions`:

1. **Fold** `wake.jsonl` into open intents (an intent with no ack or dropped line), in file order. A torn final line, meaning an unparsable last line with no trailing newline, is ignored. An unparsable line in the middle of the file stops catch-up loudly (`rt.warn`); the file is not truncated or rewritten.
2. **Re-derive** missed intents:
   - For each `state.tasks` entry with `status === 'working'`: if the last turn event of its session is a non-cut `turn/end`, write the intent the live path would have written. The text is taken from the session's last `assistant/message`, because `lastWords` (`agents.js:270`) does not survive a restart. Then run the terminal save.
   - The same rule applies to each genie-dsh wish with `delivered !== true`, through the hook described below.
3. **Deliver** each open intent through the dedupe check above.
   - A recipient Bot that no longer exists → `dropped: recipient-deleted`.
4. **Compact**, only when the file passes 1 MiB: rewrite it with only the open intents, through `replaceFile` (`files.js:15`) to a temp file and rename. This is the one place the file is rewritten, and it happens only at startup.

`resendQueued` then runs as today. A wake-logged message that catch-up already delivered sits in the recipient's inbox, so its `waiting` check (`resume.js:224`) skips it. The two paths cannot double-send.

### Retry without timers

A live `deliver()` that throws (for example, `resolveAgent` fails) leaves the intent open. It is retried on the next event about that recipient, never on a clock:

- `agent/created` for the recipient's session: the session was loaded again.
- the recipient's next `turn/end`.
- startup catch-up.

### Discarded messages

`agent/inbox/discarded` (`resume.js:136`) for an open intent's exchangeId → `dropped: discarded-by-user`. Today that event means the user stopped the Bot or DS Bot withdrew the message. Replay must not re-wake a Bot the user stopped.

## The three causes

### Task-done (`agents.js:285-306`)

On a non-cut `turn/end` for a `working` task:

1. Compute the status and the report text exactly as today.
2. `await rt.wake({cause, to: {botId: task.from}, args})`, which writes the intent.
3. Set `task.status` and save.
4. Deliver.

If `task.from` is no longer a Bot, no intent is written, as the return at `:301` does today.

### Group report_back (`groups.js:947-961`)

Compose the text, then `await rt.wake(...)` with `deliveryId = report:<roomId>:<post exchange id>`. Only after that, `closeWork(post.sub, …)`, then deliver. A crash before `reportRound` is reached (in the middle of the round) is outside this slice. Round state is process-local, and `resume.js` already resumes the cut turns.

### Wish completion (genie-dsh, plus one bots-dsh seam)

- **New seam**: `rt.wake({cause, to, args})` on bots-dsh, exported next to `deliver` (`delivery.js:165`). It writes the intent and returns once the line is fsynced. Delivery follows by itself through the write order above. This is the only public API slice one adds.
- **Dispatcher capture**: when `grant_wish` runs (`genie.js:231`), the wish entry also records `notify`, the Bot that the granting Genie's current turn is answering. That comes from `rt.live.get(genieSessionId)?.info`: `senderSessionId` for a direct request, or `askedBy` when the request came through handed-on work. `notify` is omitted when the turn was the user's own.
- **Completion** (`genie.js:268-281`): on a non-cut `turn/end` for the wish task:
  1. Await `fetchWishBranch`.
  2. Write the `wish-done` intent addressed to `notify`. Its text carries the fetch outcome: "branch fetched into <repo>" or "branch stayed in <folder>: <error>". The wake therefore proves where the branch is.
  3. Mark the wish `delivered` and save.

  A crash during the fetch is covered by re-derivation (catch-up step 2): the wish is still `delivered !== true`, and the fetch is idempotent (`git.js:108-112` fetches a named ref into itself).
- The Genie still gets its own task-done report through the task path. The dispatcher gets a separate `wish-done` message, so Felipe is woken directly.
- **Compatibility**: genie-dsh checks `typeof rt.wake === 'function'`. On an older bots-dsh it keeps today's behaviour, the same pattern as the `startTask` cwd note at `genie.js:247-248`.

## Bounds and the history/live split

- `wake.jsonl` is **pending-delivery state, not history**. Message history stays in the session logs. A closed intent has no reader after compaction.
- Open intents are bounded by real undelivered work: one per finished task, wish or round report not yet in its recipient's log. Compaction bounds the file at about 1 MiB plus one startup's appends.
- No stream chunks, no status events, no broker.

## Acceptance tests (automagik `apps/bots-dsh/test/wake.test.js`, on `fake-ctx.js`)

"Kill" means: abandon the runtime instance at an injected seam, so no in-memory continuation runs, then install a fresh instance on the same `home` and the same persisted session store.

| # | Kill point | After restart, must hold |
|---|---|---|
| A | Intent fsynced, task saved `done`, before `deliver()` | The recipient has exactly **one** `user/message` with `exchangeId = deliveryId`, and an ack line exists. |
| B | Recipient `user/message` persisted and flushed, before the ack line | **Zero** new deliveries. Catch-up writes the ack from the log scan. |
| C | `turn/end` in the task log, before the intent line (task still `working`) | Re-derivation sends exactly one report, carrying the session's last assistant text. |
| D | Same as A, for `reportRound` | The poster gets one report. `closeWork` ran once. |
| E | Same as A, for a wish with `notify` set | The dispatcher gets one `wish-done`. The granting Genie gets one task-done. |
| F | Torn final line / corrupt middle line | Torn: ignored, catch-up proceeds. Corrupt middle: catch-up stops with a warning, and the file is byte-identical afterwards. |
| G | Wake delivered to a session whose goal is disarmed | The goal's `activation` is still `disarmed` after the woken turn. |
| H | Recipient message older than the bounded scan | The documented single duplicate occurs, and the test pins it. |

Before the PR is called ready, A and B are also run once with a real `kill -9` against a scratch dsh profile, and the output goes in the PR body. Seam tests prove the logic; the real kill proves `datasync` and dsh's own session flush.

## Not verified (stated, not assumed)

- **Whether dsh's inbox survives a restart.** The comment at `resume.js:211` ("a hard stop keeps the inbox") suggests it does. The design is correct either way, because dedupe checks both the log and the inbox.
- **dsh's 200 ms session-persistence batch** (`dsh-session-persistence-jsonl` `lib/index.js:187-194`). A crash inside that window can lose the `turn/end` itself, and a task in that state looks like it is still running. That is outside slice one, and dsh owns it.
- **Where genie-dsh's source lives.** Only the installed 0.1.4 package was read. The current genie checkout's `plugins/` has no `grant_wish`.
- **That `rt.live.get(id).info` carries `senderSessionId` / `askedBy` during the tool call**, for a room-triggered Genie turn. Read from `turns.js:68-76, 461-474`, not exercised.
- **The fidelity of `fake-ctx.js` for `flush` and `eventsBackwards`.** The real `kill -9` run is the backstop.
- No fault injection has been run yet. Everything above comes from reading source.

## Deferred, each with its trigger

| Deferred | Trigger to revisit |
|---|---|
| Omni journal / `custom.dsh.wake` via `/events/trigger` with `idempotencyKey = deliveryId` | The first consumer that runs outside the dsh process. A prerequisite on that day: fix the swallowed journal error (`event-persistence.ts:745-751`). |
| Reply path `tellSender` (`turns.js:197-209`) and handoff close (`handoffs.js:39-52`): the same ordering bug | Slice two. It is the next most common lost-wake path, and it is held back only to keep slice one to the three decided causes. |
| A general `rt.wake` for any cause | A fourth cause kind is requested. The seam already exists; the only addition is a new `deliveryId` prefix. |
| Round-in-progress durability | A group round is observed lost in the middle of a round in a way `resume.js` turn resumption does not cover. |

## Build and review

- Builder: Genie automagik, on **one** branch in `automagik`. The five `wish/*event*` branches there hold zero commits past `main` as of 21:40, so nothing needs adopting.
- Reviewer of this design: Genie automagik (Felipe's split, 2026-10-26). The build starts on SHIP.
- Merge, deploy and live-session shutdown stay out of scope.
