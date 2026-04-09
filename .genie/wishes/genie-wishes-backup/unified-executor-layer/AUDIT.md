# Group 1 Audit — World B Dependency Map

**Wish:** `unified-executor-layer`
**Group:** 1 (trace)
**Date:** 2026-04-04
**Scope:** Map every consumer of World B so Groups 4–11 know what to touch.

> **World B** = `src/services/executor.ts` (parallel `IExecutor`/`OmniSession`/`OmniMessage` types), `src/services/executors/claude-code.ts`, `src/services/executors/claude-sdk.ts`, `src/services/omni-bridge.ts` (in-memory session Map).

---

## 1. Import Map (per importee)

### 1.1 `src/services/executor.ts`

Exports: `IExecutor`, `OmniSession`, `OmniMessage` (types only).

| Importer | Line | What it imports |
|----------|------|-----------------|
| `src/services/omni-bridge.ts` | 14 | `IExecutor`, `OmniMessage`, `OmniSession` (type-only) |
| `src/services/executors/claude-code.ts` | 16 | `IExecutor`, `OmniMessage`, `OmniSession` (type-only) |
| `src/services/executors/claude-sdk.ts` | 5 | `IExecutor`, `OmniMessage`, `OmniSession` (type-only) |

**Observation:** 3 importers, all inside World B itself. No file outside `src/services/` imports `executor.ts`. Once the three files above migrate to World A's `Executor` type (`src/lib/executor-types.ts`), `executor.ts` has zero consumers and can be deleted outright.

---

### 1.2 `src/services/executors/claude-code.ts`

Exports: `ClaudeCodeOmniExecutor` (class), `sanitizeWindowName` (pure helper).

| Importer | Line | What it imports |
|----------|------|-----------------|
| `src/services/omni-bridge.ts` | 15 | `ClaudeCodeOmniExecutor` (constructed on line 106) |
| `src/services/executors/claude-code.test.ts` | 2 | `sanitizeWindowName` only (pure utility test) |

**Observation:** Only two importers. The test file `claude-code.test.ts` imports a pure utility (`sanitizeWindowName`) — no coupling to `OmniSession` shape. It survives any refactor unless `sanitizeWindowName` is moved/deleted. The class itself is only instantiated by `omni-bridge.ts`.

---

### 1.3 `src/services/executors/claude-sdk.ts`

Exports: `ClaudeSdkOmniExecutor` (class).

| Importer | Line | What it imports |
|----------|------|-----------------|
| `src/services/omni-bridge.ts` | 16 | `ClaudeSdkOmniExecutor` (constructed on line 104, type-checked on line 132) |
| `src/services/executors/__tests__/claude-sdk.test.ts` | 35 | `ClaudeSdkOmniExecutor` (dynamic `await import`) |

**Observation:** Two importers. The test file DOES assert on `OmniSession` shape (see §2).

---

### 1.4 `src/services/omni-bridge.ts`

Exports: `OmniBridge` (class), `getBridge` (singleton accessor), `BridgeStatus` (type).

| Importer | Line(s) | What it imports |
|----------|---------|-----------------|
| `src/term-commands/omni.ts` | 21, 51, 66 | `OmniBridge` (construct in `start`), `getBridge` (in `stop`/`status`) — all via dynamic `await import` |

**Observation:** Exactly one consumer outside World B: `src/term-commands/omni.ts`. No direct imports from the TUI, from `genie.ts`, from `agents.ts`, or from any other term-command. Confirmed by grepping for `OmniBridge|getBridge|BridgeStatus|BridgeConfig` across the whole codebase — only `term-commands/omni.ts` and `services/omni-bridge.ts` match.

---

## 2. Tests Asserting on `OmniSession` Fields

The only test that asserts on World B's tmux-shaped `OmniSession` fields (`tmuxSession`, `tmuxWindow`, `paneId`) is:

**`src/services/executors/__tests__/claude-sdk.test.ts`**

| Line | Assertion | Context |
|------|-----------|---------|
| 51 | `expect(session.paneId).toBe('sdk-chat-123')` | `spawn()` returns SDK-specific pane id |
| 52 | `expect(session.tmuxSession).toBe('')` | SDK stubs the field to empty |
| 53 | `expect(session.tmuxWindow).toBe('')` | SDK stubs the field to empty |
| 84–86 | `tmuxSession: ''`, `tmuxWindow: ''`, `paneId: ''` | `isAlive()` fake-session literal (unknown-session test) |
| 107–109 | `tmuxSession: ''`, `tmuxWindow: ''`, `paneId: ''` | `shutdown()` idempotency fake-session literal |
| 172–174 | `tmuxSession: ''`, `tmuxWindow: ''`, `paneId: ''` | `deliver()` fake-session literal (error path) |

**All six sites** are there only because `OmniSession` is hardcoded with tmux-only fields. Once Group 11 replaces `OmniSession` with World A's `Executor` (which has `tmuxSession/tmuxWindow/tmuxWindowId` as `string | null`), these assertions should be rewritten to either (a) pass `null` for tmux fields, or (b) drop the tmux assertions entirely and assert on `transport='api'` and metadata instead. The fake-session literals in lines 84–86 / 107–109 / 172–174 can also be replaced by `Executor`-shaped fixtures.

**Unrelated `paneId`/`tmuxSession` assertions in the codebase** (grepped but confirmed to be World A or tmux-native): `src/lib/executor-registry.test.ts`, `src/lib/target-resolver.test.ts`, `src/lib/protocol-router.test.ts`, `src/lib/event-listener.test.ts`, `src/lib/scheduler-daemon.test.ts`, `src/__tests__/resume.test.ts`, `src/__tests__/events.test.ts`, `src/tui/session-tree.test.ts`, `src/lib/claude-logs.test.ts`, `src/lib/unified-log.test.ts`, `src/term-commands/approve.test.ts`, `src/lib/__tests__/zombie-spawns.test.ts`, `src/lib/__tests__/edge-cases-stability.test.ts`. **None of these import World B** — they are all World A / tmux-resolver tests and are out of scope for Group 11.

---

## 3. In-Memory Session Map Call Sites

**Declaration:** `src/services/omni-bridge.ts:152` — `private sessions = new Map<string, SessionEntry>();`
**Type:** `SessionEntry` — defined at `src/services/omni-bridge.ts:58`.

> **Note:** Line numbers re-verified against the current 644-line file after Group 3's PG scaffolding landed. The Map's structure and count of call sites (14) are unchanged — only the line numbers shifted.

All read/write sites inside `omni-bridge.ts`:

| Line | Operation | Method | Purpose |
|------|-----------|--------|---------|
| 152 | `new Map<string, SessionEntry>()` | (field decl) | Declare the Map |
| 260 | `for (const [key, entry] of this.sessions)` | `stop()` | Iterate all sessions to shut them down |
| 270 | `this.sessions.clear()` | `stop()` | Empty the Map after shutdown |
| 305 | `this.sessions.size` | `status()` | Report `activeSessions` count |
| 309 | `Array.from(this.sessions.entries()).map(...)` | `status()` | Build `BridgeStatus.sessions` payload |
| 435 | `this.sessions.get(key)` | `routeMessage()` | Look up existing session for a `{agent}:{chatId}` key |
| 475 | `this.sessions.size` | `spawnSession()` | Enforce `maxConcurrent` limit |
| 492 | `this.sessions.set(key, placeholder)` | `spawnSession()` | Register the "spawning" placeholder before the executor spawns |
| 528 | `this.sessions.delete(key)` | `spawnSession()` (catch) | Clean up placeholder if spawn throws |
| 536 | `this.sessions.get(key)` | `resetIdleTimer()` | Look up the entry whose idle timer to refresh |
| 560 | `for (const [key, entry] of this.sessions)` | `checkIdleSessions()` | Iterate every 30s to kill idle/dead sessions |
| 589 | `this.sessions.get(key)` | `removeSession()` | Fetch entry to clear its idle timer |
| 591 | `this.sessions.delete(key)` | `removeSession()` | Evict the entry |
| 599 | `this.sessions.size` | `drainQueue()` | Check capacity before draining queued messages |

**Count:** 14 references. **Group 6** (`Refactor omni-bridge.ts`) must replace every one of these with a query against World A's `executor-registry` (filtered by `metadata->>'source'='omni'`). Notes for Group 6:

- **Spawning placeholder (lines 317–324, 337–338, 360):** World A has no in-memory "spawning" state. Either add a `state='spawning'` row immediately and update to `'running'` on success, or keep a small per-bridge `Map<key, { spawning: boolean; buffer: OmniMessage[] }>` limited to in-flight spawn/buffer concerns (NOT long-lived session truth). The buffering machinery is a bridge concern and can stay local; the session identity must live in PG.
- **Idle timer (lines 368, 373, 392, 421):** Per-session `setTimeout` handles are ephemeral and belong in a local `Map<executorId, Timer>`. They should NOT be persisted — but they should be keyed by `executor.id` from World A rather than the synthetic `${agent}:${chatId}` string.
- **Concurrency count (307, 431):** Compute by counting un-ended `executors` rows where `metadata->>'source'='omni'` — OR cache the count locally and recompute on each spawn/shutdown. The wish leaves this detail to Group 6.
- **`status()` payload (215):** Must read from `executor-registry` via metadata filter. `BridgeStatus.sessions` schema may change (Group 11 confirms).
- **`SessionEntry` interface (line 39):** Goes away; replace any remaining local state with a minimal `{ buffer: OmniMessage[]; idleTimer: Timer | null; spawning: boolean }` keyed by executor id.

---

## 4. CLI Commands Importing World B

| Command file | Imports from World B | Purpose |
|--------------|----------------------|---------|
| `src/term-commands/omni.ts` | `OmniBridge`, `getBridge` (dynamic imports of `../services/omni-bridge.js`) | The only CLI surface that binds to the bridge |

**No other CLI files import World B.** Verified by grepping every file under `src/term-commands/` for `omni-bridge|services/executor|ClaudeCodeOmniExecutor|ClaudeSdkOmniExecutor|IExecutor|OmniSession`. Zero matches.

> Note: `src/term-commands/agents.ts:936` imports `ClaudeSdkProvider` from `src/lib/providers/claude-sdk.js` — this is the **provider** in World A's `lib/providers/` tree, NOT the World B **executor** in `services/executors/`. Out of scope.

---

## 5. Surprise Dependencies

**None found.** Group 1 swept the entire codebase for anything unexpected:

- **TUI (`src/tui/**`):** No imports of `omni-bridge`, `executor.ts`, `claude-code.ts`, `claude-sdk.ts`, `OmniSession`, `IExecutor`, or `OmniBridge`. The TUI is entirely World A / tmux-resolver based.
- **Hooks (`src/hooks/**`):** No references.
- **`src/genie.ts` entry point:** No references.
- **Other `src/services/*`:** `omni-reply.ts` stands alone as a standalone CLI JSON publisher (`import.meta.url` main-check). It is referenced ONLY by a bash heredoc inside `claude-code.ts:248` (runtime string path, not a TS import). When `claude-code.ts` is removed/refactored, the heredoc goes too. `omni-reply.ts` has its own life as a CLI shim and is out of Group 1's scope (covered by the bridge-process footnote in the wish).
- **`knip.json:23`** lists `src/services/omni-bridge.ts` as a knip entry point (so its exports don't flag as unused). When Group 11 refactors/renames the bridge, this line must stay in sync.
- **Docs mentions:**
  - `docs/ARCHITECTURE.md:55` and `:259` mention `src/services/omni-bridge.ts`
  - `docs/CLI-REFERENCE.md:22` links to `#omni-bridge`
  - `docs/sdk-executor-guide.md:564` mentions the `src/services/executors/` path
  These are documentation-only and should be updated in Wave 4 cleanup (not a compile-time dependency).
- **`src/services/executors/claude-code.test.ts`** imports the pure helper `sanitizeWindowName` only. It does **not** reference `IExecutor` or `OmniSession`. If `sanitizeWindowName` is retained when `claude-code.ts` is refactored/deleted, this test remains valid; otherwise it should be deleted along with the function.

**Zero surprises.** World B is fully contained: the only external seam is `term-commands/omni.ts`.

---

## 5a. Does `ClaudeCodeOmniExecutor` (tmux) Already Register in World A's `executor-registry`?

**Answer: NO.** The tmux executor in World B (`src/services/executors/claude-code.ts`) does **not** call `createAndLinkExecutor`, `updateExecutorState`, or `terminateExecutor` anywhere. Evidence:

```
$ grep -n "createAndLinkExecutor\|updateExecutorState\|terminateExecutor\|executor-registry" src/services/executors/claude-code.ts
(zero matches)
```

What it *does* use from World A's stack:
- `ensureTeamWindow`, `executeTmux`, `isPaneAlive`, `isPaneProcessRunning`, `killWindow` from `src/lib/tmux.js` (line 15) — these are **tmux helpers**, shared with the normal spawn path, but they don't touch the `executors` PG table.
- `directory.resolve` from `src/lib/agent-directory.js` (line 13).
- `shellQuote` from `src/lib/team-lead-command.js` (line 14).

All of these are utility modules. None of them persist to `executors`, `sessions`, `session_content`, or `audit_events`.

**Contrast — the normal `genie spawn` tmux path** (`src/term-commands/agents.ts:832–851`, helper `createTmuxExecutor`) DOES register via `createAndLinkExecutor(agentIdentityId, provider, 'tmux', { tmuxSession, tmuxPaneId, tmuxWindow, tmuxWindowId, claudeSessionId, state: 'spawning', repoPath, paneColor })`. That path is invoked from `agents.ts:1022, 1054, 1785`.

**Implication for Group 11:**
- When a WhatsApp message arrives and `GENIE_EXECUTOR=tmux`, the bridge spawns a tmux window **invisible** to `genie ls`, `genie sessions`, and `genie events timeline`. No row is created in the `executors` table; no `audit_events` are emitted.
- This means Group 4's scope is **understated** in the wish: the wish says the tmux executor is "already partially integrated" and "Group 4 only verifies it, doesn't refactor it" — but based on this audit, the tmux executor needs the **same** `createAndLinkExecutor` / `updateExecutorState` / `terminateExecutor` wiring that Group 4 plans to add to the SDK executor. Either:
  - **(Option A)** Group 4 adds executor-registry calls to **both** `claude-sdk.ts` and `claude-code.ts`, OR
  - **(Option B)** `ClaudeCodeOmniExecutor` is refactored to delegate tmux spawning to `term-commands/agents.ts`'s spawn helpers (reuse existing `createTmuxExecutor`), OR
  - **(Option C)** `ClaudeCodeOmniExecutor` is deleted entirely and the bridge simply shells out to `genie spawn --role <agent>` when `GENIE_EXECUTOR=tmux` (heaviest refactor but cleanest — tmux already has full registry integration via the main spawn path).
- Group 11's delete-or-keep decision for `claude-code.ts` hinges on this. If Option C is taken, **both `claude-code.ts` and `claude-code.test.ts` can be deleted** (the `sanitizeWindowName` helper would move to `lib/tmux.ts` or be inlined into whatever bridge code produces window names).

**Recommendation for the orchestrator:** Revisit Group 4's scope to cover the tmux executor explicitly. As written, the wish would leave `GENIE_EXECUTOR=tmux` runs invisible to World A — a latent regression that breaks success criterion #1 ("`genie ls` shows SDK-backed omni sessions alongside tmux-backed genie sessions") for the tmux code path specifically.

---

## 5b. Wave 1 Verification — Groups 2 & 3 Status

The team-lead asked Group 1 to verify two hypotheses about Wave 1 scope. Both are answered here with evidence.

### 5b.1 Group 2 — NATS reply path in `claude-sdk.ts` — **NO-OP CONFIRMED**

The hypothesis "claude-sdk.ts already has `natsPublish` wired; Group 2 is a no-op" is **correct**. Evidence:

```
$ grep -n 'execFile\|child_process\|execFileAsync' src/services/executors/claude-sdk.ts
(zero matches)

$ grep -n 'natsPublish\|setNatsPublish' src/services/executors/claude-sdk.ts
73:  private natsPublish: ((topic: string, payload: string) => void) | null = null;
86:  setNatsPublish(fn: (topic: string, payload: string) => void): void {
87:    this.natsPublish = fn;
190:    if (replyText && this.natsPublish) {
199:      this.natsPublish(topic, payload);
```

- Line 73: private field declared, typed `((topic, payload) => void) | null`
- Lines 86–88: `setNatsPublish(fn)` setter method present
- Line 190: reply path gates on `replyText && this.natsPublish`
- Line 199: in-process `this.natsPublish(topic, payload)` call (microsecond, not fork)
- Line 191: topic built as `omni.reply.${message.instanceId}.${message.chatId}` (matches wish spec)

And the bridge wiring is already in place — `src/services/omni-bridge.ts:219–225`:
```
if (this.executor instanceof ClaudeSdkOmniExecutor) {
  const nc = this.nc;
  const sc = this.sc;
  this.executor.setNatsPublish((topic, payload) => {
    nc.publish(topic, sc.encode(payload));
  });
}
```

**Group 2 scope reshapes from "restore NATS reply path" to "verify nothing regressed" — no code change needed.** The test file `claude-sdk.test.ts` already asserts on `natsPublish` (lines 120–143 in the test file) rather than `execFile`. PR #1042's `execFile` regression never landed on this branch.

### 5b.2 Group 3 — PG optional / degraded mode in `omni-bridge.ts` — **SCAFFOLDING ALREADY LANDED**

The hypothesis "omni-bridge has zero PG refs" is **outdated**. Group 3's scaffolding is already present in the current `omni-bridge.ts` (644 lines). Evidence:

| Line(s) | Symbol | Purpose |
|---------|--------|---------|
| 14 | `import type { Sql } from '../lib/db.js'` | PG client type |
| 28–29 | `PG_STARTUP_PROBE_TIMEOUT_MS = 5_000`, `PG_RUNTIME_QUERY_TIMEOUT_MS = 2_000` | Matches wish's "5s startup / 2s read" budgets |
| 36 | `export type PgProvider = () => Promise<Sql>` | DI factory type |
| 42–45 | `SafePgCallContext { executorId?, chatId? }` | Log context shape |
| 53 | `config.pgProvider?: PgProvider` | DI hook in `BridgeConfig` |
| 70 | `BridgeStatus.pgAvailable: boolean` | Exposed on status payload |
| 106–121 | `function withTimeout<T>(p, ms, label)` | Timeout helper with `timer.unref()` |
| 131–142 | `function isPgConnectionError(err)` | Connection-error classifier (ECONNREFUSED, ECONNRESET, ETIMEDOUT, connection terminated, etc.) |
| 158, 160, 161 | `private sql: Sql \| null`, `private pgAvailable = false`, `private readonly pgProvider: PgProvider` | Instance state |
| 177–182 | Default `pgProvider` = `async () => (await getConnection()) as Sql` | Lazy-imports `lib/db.js` |
| 216 | `await this.probePg()` | Called from `start()` after NATS connect, **never throws** |
| 286–289 | PG state reset in `stop()` | Clears `sql` and `pgAvailable` |
| 304 | `pgAvailable: this.pgAvailable` in `status()` | Exposed on `BridgeStatus` |
| 332–353 | `private async probePg()` | Graceful startup probe with 5s timeout, `SELECT 1` check, degraded-mode warning log |
| 370–394 | `private async safePgCall<T>(op, fn, fallback, ctx?)` | **The only way** downstream groups are supposed to touch PG. Fast-paths to fallback if `pgAvailable` is false, single attempt with 2s timeout, logs at warn, flips `pgAvailable=false` on connection-level errors |

**What Group 3 still has to do:** Verify the existing scaffolding matches the wish's PG Error Handling Strategy table (§3 of the wish) and confirm the unit tests exist. Based on this audit, the scaffolding matches the spec exactly:

- ✅ Startup connect: fail-fast with graceful degradation (line 347–352)
- ✅ Runtime write: single attempt, log error, continue (line 370–394)
- ✅ Runtime read: 2s query timeout, return fallback on failure (line 381)
- ✅ Connection loss mid-run: flip `pgAvailable=false`, log "switching to degraded mode" (lines 387–391)
- ⚠️ Migration missing / schema mismatch: **not explicitly handled** — the current `probePg` treats all startup failures the same (degraded mode). The wish says schema mismatches should be fail-fast with a clear message, but the scaffolding silently degrades. **This is a gap Group 3 should close** — or the wish should be updated to accept "always degrade on startup failure" as the final behavior.
- ✅ Never drops a user reply due to PG failure (safePgCall returns fallback, doesn't throw)

**What is NOT yet present:**
1. **No downstream call site actually uses `safePgCall` yet.** The helper exists and is private; no method in `omni-bridge.ts` currently wraps a PG query through it. Groups 4, 5, 6, and 7 will wire their PG writes/reads through `this.safePgCall(...)` as they add functionality. (Because `safePgCall` is `private`, downstream groups will need to either call methods on `OmniBridge` that internally wrap `safePgCall`, or Group 3 will need to expose a narrower public API. This is a minor surface-area decision for Group 6's refactor.)
2. **No unit tests exist yet** for `probePg()` or `safePgCall()` (checked `src/services/__tests__/` — directory does not exist). The wish's Group 3 deliverable #5/#6 require:
   - Test: start a bridge with broken PG → assert `start()` succeeds + `status().pgAvailable === false`
   - Test: inject mid-run PG error → assert `safePgCall` returns fallback + `pgAvailable` flips + delivery loop continues

   These tests are **the remaining work for Group 3**. The helper code is done; the coverage is missing.

**Correction for the task list:** Task #5's description ("omni-bridge has zero PG refs") is **incorrect** as of the current worktree state. The bridge is already PG-aware as of the scaffolding commit. Group 3's remaining scope is: (a) add the two unit tests from wish deliverables §5/§6, (b) decide on the migration-mismatch behavior gap, (c) consider whether `safePgCall` should become public (or exposed via a typed method) so Groups 4–7 can consume it. The task description should be updated to "Finish Group 3 — add degraded-mode unit tests; resolve migration-mismatch gap" rather than "VERIFY omni-bridge has zero PG refs".

### 5b.3 Summary of Wave 1 Status

| Group | Hypothesis | Verdict | Remaining work |
|-------|-----------|---------|----------------|
| 2 (NATS reply) | No-op (already wired) | ✅ CONFIRMED | Nothing. Close the group. |
| 3 (PG optional) | Zero PG refs | ❌ OUTDATED. Scaffolding already landed. | (a) Add the two degraded-mode unit tests. (b) Handle migration-mismatch gap. (c) Decide public API shape for `safePgCall` so Groups 4–7 can consume it. |

Wave 1's original parallelization assumption no longer holds for Group 3 — the helper is present, but the tests and DI surface are not. The team-lead should adjust Group 3's scope before dispatching Wave 2, because Group 4 (SDK executor registers in World A) needs to call PG writes through `safePgCall`, which is currently `private`.

---

## 6. Proposed Deletion / Refactor Order (for Group 11)

Work bottom-up in the dependency graph so TypeScript compilation stays green at every step:

```
term-commands/omni.ts
        │
        ▼
services/omni-bridge.ts
        │
        ├──▶ services/executors/claude-code.ts
        │            │
        │            └──▶ services/executor.ts  (types)
        │
        └──▶ services/executors/claude-sdk.ts
                     │
                     └──▶ services/executor.ts  (types)
```

**Order within Group 11 (assumes Groups 4–10 already landed):**

1. **Rewrite `src/services/executors/__tests__/claude-sdk.test.ts`** — replace `OmniSession` fake-session literals with `Executor`-shaped fixtures (or drop the tmux-field assertions entirely, since `transport='api'` and metadata are the new truth). This unblocks every downstream edit without a failing test run.
2. **Refactor `src/services/executors/claude-sdk.ts`** — replace `import type { IExecutor, OmniMessage, OmniSession } from '../executor.js'` with `import type { Executor } from '../../lib/executor-types.js'`. Drop the `tmuxSession: ''` / `tmuxWindow: ''` / synthetic `paneId` stubs; return an `Executor` row created via `createAndLinkExecutor` (this work is actually Group 4 — Group 11 just finalizes it by deleting any leftover `OmniSession` residue).
3. **Refactor or delete `src/services/executors/claude-code.ts`** — same type swap. Because the tmux backend is only used when `GENIE_EXECUTOR=tmux` and the wish's Group 4 comment says "it's already partially integrated; Group 4 only verifies it", the existing file can likely be refactored in place (not deleted). Its `sanitizeWindowName` export must be preserved for the unit test.
4. **Refactor `src/services/omni-bridge.ts`** — remove the `import type { IExecutor, OmniMessage, OmniSession } from './executor.js'` line and the private session Map. Replace with executor-registry queries + a minimal local `Map<executorId, { buffer, idleTimer, spawning }>` for spawn/idle concerns only. Keep the singleton `getBridge()` accessor — `term-commands/omni.ts` still depends on it.
5. **Delete `src/services/executor.ts`** once nothing imports it. Verify with `grep -r "from.*services/executor\\.js" src/`. The wish permits an optional ≤20-line adapter re-export if any edge caller remains — based on this audit, nothing remains, so **full delete** is on the table.
6. **Update `knip.json:23`** only if `omni-bridge.ts` is renamed. If the path stays the same, no change.
7. **Touch docs (`ARCHITECTURE.md`, `CLI-REFERENCE.md`, `sdk-executor-guide.md`)** — Wave 4 cleanup, not blocking.

**Safe-to-delete-first files (if the wish decides to nuke rather than refactor):** None. `src/services/executor.ts` is the only file that could conceivably be deleted without touching others — but doing so first would break the remaining World B files that still `import type` from it. The correct order is: **consumer edits first, producer delete last.**

---

## 7. Summary

| Metric | Count |
|--------|-------|
| World B files | 4 |
| Unique external importers of World B | 1 (`src/term-commands/omni.ts`) |
| Internal cross-imports within World B | 3 (omni-bridge → claude-code, omni-bridge → claude-sdk, each executor → executor.ts types) |
| In-memory `sessions` Map call sites | 14 (all in `omni-bridge.ts`) |
| Tests asserting on `OmniSession` tmux fields | 1 file, 6 assertion sites (all in `claude-sdk.test.ts`) |
| Surprise dependencies | 0 |
| Files that can be deleted outright after Group 11 | 1 (`src/services/executor.ts`) |
| CLI files referencing World B | 1 (`src/term-commands/omni.ts`) |

**Bottom line:** World B is impressively self-contained. The merge into World A only touches the files Group 1 has listed here. Groups 4, 5, 6, and 11 now have a precise map of every location they need to edit.
