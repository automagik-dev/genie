# Wish: rlmx-acp-adapter — `rlmx acp` (ACP agent for web + editor consumption)

| Field | Value |
|-------|-------|
| **Status** | IN_PROGRESS (execution started 2026-07-21; depends-on rlmx-live-tui SHIPPED) |
| **Slug** | `rlmx-acp-adapter` |
| **Date** | 2026-07-20 |
| **Author** | felipehowit@gmail.com |
| **Appetite** | large |
| **Branch** | `wish/rlmx-acp-adapter` |
| **Repos touched** | `~/prod/rlmx` |
| **Design** | [DESIGN.md](../../brainstorms/rlmx-acp-adapter/DESIGN.md) |

## Summary

Ship `rlmx acp` — a stdio JSON-RPC **ACP (Agent Client Protocol) agent** (via
`@agentclientprotocol/sdk`, pi-acp-shaped) that drives rlmx's instrumented recursion path in-process
and translates its event stream into ACP session updates. Existing ACP clients — **Tidewave** in the
browser (primary), Newio (secondary), `acp-inspector` (dev) — then drive rlmx agents and see the
recursion/tool activity, with no bespoke UI and no reinvented transport (the host bridges stdio↔browser).

## Scope

### IN

- **`rlmx acp` subcommand** (new `command`-union arm + parse + switch in `src/cli.ts`) implementing a
  stdio ACP `Agent` on `@agentclientprotocol/sdk` (add the dep): `initialize` / `authenticate` /
  `session/new` / `session/load` / `session/prompt`.
- **In-process drive of the instrumented `rlmLoop`** (`src/rlm.ts`) — NOT `sdk/runAgent` — subscribing
  the per-run `createEmitter()` bus rlmx-live-tui exposes. **v1 = one active session, serialized**, each
  run wrapped in a try/catch so a failure fails only that session (per Design Decision #9).
- **Event translation** (`src/acp/session.ts`-analog): `Message`→`agent_message_chunk`;
  `ToolCallBefore/After`→`tool_call`/`tool_call_update`; **`RecurseEvent`→a tool-call node (nested where
  the client supports it, flat otherwise) carrying per-node tokens/cost/latency**; permission→`requestPermission`.
- **Tidewave-recognition + persistence**: advertise `loadSession:true` + MCP-server support in `initialize`;
  accept + materialize host MCP config (advertise/store only); durable session persistence with
  **restore-on-empty** (fixes multi-turn "Invalid params").
- **Client wiring docs**: Tidewave External Agent `exec` entry, Newio `custom`-type snippet, `acp-inspector` dev loop.
- **`scripts/smoke-acp.mjs`**: an automated ACP client that spawns `rlmx acp` over stdio and drives the
  handshake + a prompt — the deterministic gate (pi-acp ships the same pattern).

### OUT

- **A bespoke web UI** — reuse Tidewave/Newio; `acp-components` only if ever needed (deferred).
- **ACP remote HTTP/WebSocket transport** — the host bridges; we ship plain stdio.
- **Executing host MCP tools** — rlmx has no MCP client; advertise/store only, execution is a follow-on.
- **The recursion instrumentation** — that's `rlmx-live-tui`; this wish consumes its stream.
- **Per-session subprocess/worker isolation** and **concurrent multi-session** — v1 is single-session serialized; isolation is the follow-on.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Stdio ACP agent via `@agentclientprotocol/sdk`; no remote transport | Stable transport; host bridges to browser (Tidewave/Newio). |
| 2 | Drive instrumented **`rlmLoop`** in-process (not `sdk/runAgent`) | `rlmLoop` is the recursion path rlmx-live-tui instruments; `runAgent` is un-wired. |
| 3 | **v1 = single active session, serialized**, per-run try/catch isolation | In-process drive loses pi-acp's per-subprocess isolation; contain the blast radius. |
| 4 | Emitter seam pinned to **opts injection**: caller creates `createEmitter()`, subscribes, passes it via `rlmLoop(..., { emitter })` | `rlmLoop` today has no emitter param; opts injection (not a returned stream) lets the caller subscribe *before* the run so no opening events are missed. rlmx-live-tui G2 exposes this exact signature. |
| 5 | Bake in `loadSession:true` + MCP-advertise + restore-on-empty | The exact patches pi needed to run in Tidewave — spec, not surprises. |
| 6 | `RecurseEvent`→tool-call node, **nested-or-flat** | ACP has no first-class sub-agent primitive; degrade gracefully. |

## Dependencies

**depends-on:** rlmx-live-tui
**blocks:** none

## Success Criteria

- [ ] `rlmx acp` starts as a stdio ACP agent; `scripts/smoke-acp.mjs` (and `acp-inspector` manually)
      complete `initialize` (advertising `loadSession:true` + MCP support) → `session/new` → `session/prompt` end-to-end.
- [ ] A **recursive** run surfaces as streamed `agent_message_chunk` + `tool_call`/`tool_call_update`,
      with each `RecurseEvent` spawn as a **nested-or-flat tool-call node** carrying per-node tokens/cost/latency.
- [ ] **Multi-turn**: `session/load` restores a persisted session and a follow-up `session/prompt` does
      **not** throw "Invalid params".
- [ ] Runs as a **Tidewave External Agent** end-to-end (a recursive run is visible in the browser). If
      Tidewave is environmental, demonstrated via `acp-inspector` + a recorded Tidewave-handshake test (Tidewave run → QA).
- [ ] Docs present (Tidewave `exec` + Newio `custom` + `acp-inspector` loop); `npm run build`/`npm test` green; adapter is additive.

## Execution Strategy

### Wave 1 (sequential) — ACP agent skeleton + lifecycle

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 1 | engineer | 5 (orchestration/lifecycle +2, stateful sessions +2, multi-package new dep +1) | engineer-complex / high | `rlmx acp` subcommand + ACP Agent (init/auth/session lifecycle) + in-process rlmLoop drive (single-session) + smoke harness |

### Wave 2 (sequential) — event translation

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 2 | engineer | 5 (subjective mapping +2, stateful +2, no deterministic test +1) | engineer-complex / high | rlmx event stream → ACP session updates (message/tool_call/recurse/permission) |

### Wave 3 (sequential) — Tidewave recognition + persistence + docs

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 3 | engineer | 5 (stateful persistence +2, external-client integration +2, no deterministic test +1) | engineer-complex / high | loadSession/MCP-advertise + restore-on-empty persistence + client wiring docs + Tidewave e2e |

## Execution Groups

### Group 1: `rlmx acp` agent skeleton + session lifecycle

**Goal:** a stdio ACP agent that completes the handshake and a prompt round-trip, driving rlmLoop in-process.

**Deliverables:**
1. Add `@agentclientprotocol/sdk` to `dependencies`.
2. `rlmx acp` subcommand: extend the `command` union (`cli.ts:122`), positional parse (~`cli.ts:208`), switch (`cli.ts:965`).
3. `src/acp/agent.ts`-analog: ACP `Agent` implementing `initialize`/`authenticate`/`session/new`/`session/load`/`session/prompt`.
4. On `session/prompt`, run the instrumented `rlmLoop` in-process, **single active session, serialized**,
   per-run try/catch (against a recorded event fixture until rlmx-live-tui lands — Risk #1).
5. `scripts/smoke-acp.mjs`: spawn the built entry as the `acp` subcommand — `node dist/src/cli.js acp`
   (rlmx builds to `dist/src/`, not pi-acp's `dist/index.js`) — drive initialize→session/new→session/prompt, assert responses.

**Acceptance Criteria:**
- [ ] `npm run build && npm test` pass; the adapter adds no regression to existing subcommands.
- [ ] `node scripts/smoke-acp.mjs` completes the handshake + a prompt and exits 0.
- [ ] A second concurrent `session/prompt` is rejected/queued (single-session invariant holds).

**Validation:**
```bash
cd ~/prod/rlmx && npm ci && npm run build && npm test && node scripts/smoke-acp.mjs
```

**depends-on:** none

---

### Group 2: event translation (rlmx stream → ACP session updates)

**Goal:** a recursive run streams as ACP session updates a client can render.

**Deliverables:**
1. Translation layer: `Message`→`agent_message_chunk`; `ToolCallBefore/After`→`tool_call`/`tool_call_update`
   (with `durationMs`); `RecurseEvent`→a tool-call node (**nested-or-flat**) with per-node
   tokens/cost/latency from `IterationOutputEvent.metrics` + bridged `RlmChildResult.usage`; permission→`requestPermission`.
2. Extend `scripts/smoke-acp.mjs` to run a **recursive** prompt (or replay the recorded fixture) and assert the update types.

**Acceptance Criteria:**
- [ ] A ≥2-level recursive run emits `agent_message_chunk` + ≥1 `tool_call`/`tool_call_update`, with a
      `RecurseEvent`-derived node per spawn carrying metrics.
- [ ] The smoke harness asserts these update types appear (deterministic against the fixture).

**Validation:**
```bash
cd ~/prod/rlmx && npm run build && node scripts/smoke-acp.mjs --recursive | grep -Eq 'tool_call|agent_message_chunk' && echo "updates present"
```

**depends-on:** 1

---

### Group 3: Tidewave recognition + persistence + client docs

**Goal:** the agent is recognized + multi-turn-safe in a real host, with wiring docs.

**Deliverables:**
1. `initialize` advertises `loadSession:true` + MCP-server support; accept + materialize host MCP config (store only).
2. Durable session persistence with **restore-on-empty** (rehydrate a persisted session when the in-memory map is empty).
3. Docs: Tidewave External Agent `exec` entry, Newio `custom`-type snippet, `acp-inspector` dev loop, node-field legend.
4. Extend `scripts/smoke-acp.mjs` with a session/load + follow-up prompt asserting no "Invalid params".

**Acceptance Criteria:**
- [ ] `initialize` response advertises `loadSession:true` + MCP support (smoke-asserted).
- [ ] `session/load` + a follow-up `session/prompt` succeeds (restore-on-empty) — no "Invalid params".
- [ ] Runs as a Tidewave External Agent end-to-end (QA; `acp-inspector` + recorded-handshake test as the automated stand-in).

**Validation:**
```bash
cd ~/prod/rlmx && npm run build && npm test && node scripts/smoke-acp.mjs --multiturn && echo "multi-turn ok"
```

**depends-on:** 2

---

## QA Criteria

_What must be verified on dev after merge._

- [ ] Functional: `rlmx acp` drives a recursive rlmx run visible in Tidewave (browser), tool/recurse nodes rendering.
- [ ] Integration: the full chain (rlmx-live-tui emitter → rlmx acp translation → ACP client) works end-to-end.
- [ ] Regression: existing rlmx subcommands (query/cache/batch/config/…), CAG, and Langfuse spans unaffected.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Depends on `rlmx-live-tui` instrumentation (the emitter it translates) not yet built | High | Sequence after it; build G1-2 against a recorded event fixture until it lands; `depends-on` declared. |
| In-process drive loses per-session isolation — one `rlmLoop` throw could crash the agent | High | v1 single-session serialized + per-run try/catch; reject/queue overlapping prompts; per-session isolation is a follow-on. |
| Emitter seam (`rlmLoop` has no emitter param today) | Medium | Pinned to opts injection `rlmLoop(..., { emitter })` (Decision #4); rlmx-live-tui G2 exposes this exact signature — the headless subscriber uses the same seam. |
| Child-internal events run in the child process (not in the parent emitter) — v1 shows child nodes only on spawn + final usage | Medium | Bridge `RlmChildResult.usage` on `onChildEnd` (Level-1 boundary); live child-internal streaming is a follow-on. QA must not expect live child internals. |
| ACP has no first-class recursion/sub-agent node | Medium | Nested tool_call where supported, flat fallback with metrics; validate in `acp-inspector`. |
| Tidewave won't recognize the agent without the right capabilities | Medium | Replicate pi-acp's patches (loadSession + MCP advertise + restore-on-empty); validate in `acp-inspector` then Tidewave. |
| `@agentclientprotocol/sdk` version churn (remote transport WIP) | Low | Pin the SDK (pi-acp uses ^0.26); use only stable stdio surface. |

---

## Review Results

### Plan review — 2026-07-20 — **SHIP** → Status APPROVED

- **Reviewer:** reviewer (independent plan gate, Opus 4.8). Verified faithful to the SHIP design; both
  HIGH risks carried (in-process isolation → single-session serialized; depends-on `rlmx-live-tui`);
  the `rlmLoop`-not-`runAgent` seam and nested-or-flat recursion representation preserved; all cli.ts
  line refs (122/~208/965), `npm run build`/`test`, the `smoke-acp.mjs` pattern, and the
  `@agentclientprotocol/sdk ^0.26` dep verified against the repo. Groups ordered, `depends-on` correct.
- **Non-blocking findings applied post-SHIP:** emitter seam pinned to **opts injection**
  `rlmLoop(..., { emitter })` in both this wish (Decision #4) and `rlmx-live-tui` G2 (the MEDIUM);
  added the child-internal Level-1-boundary risk row; fixed SC `npm run build/test` wording; noted the
  smoke script spawns `node dist/src/cli.js acp` (rlmx builds to `dist/src/`).
- **Design provenance:** design review was FIX-FIRST (in-process isolation trade hidden; rlmLoop-vs-runAgent
  seam) → fixed → SHIP.

_Execution and PR review evidence appended below as they occur._

### Execution review — Group 1 (acp skeleton + lifecycle) — 2026-07-21 — **SHIP**

- **Engineer:** engineer-complex (Opus 4.8/high) — commits `2aff0eb` → `261dd10`. New `src/acp/agent.ts`
  (ACP `Agent` + `runAcp` stdio bootstrap on `@agentclientprotocol/sdk` ^0.26.0 — pi-acp's family;
  registry 1.2.x deliberately not taken), additive `acp` subcommand in cli.ts (union/parse/switch),
  `scripts/smoke-acp.mjs`. Drives the REAL instrumented `rlmLoop(query, null, config, { emitter,
  output:"json" })` with a `createEmitter()` subscribed before the run — NOT `runAgent`.
- **Design facts recorded:** SDK member→wire mapping 1:1 (`newSession`→`session/new` etc.);
  single-session serialization via race-free `promptInFlight` guard, concurrent prompt REJECTED with
  JSON-RPC -32600 (documented choice); per-run try/catch → `RequestError.internalError`, agent never
  dies; stdout discipline = console rerouted to stderr + SDK owns stdout, smoke asserts every stdout
  line parses as JSON-RPC; `loadSession:false` advertised HONESTLY until Group 3; cancel() no-op
  (Group 3 threads AbortSignal).
- **Acceptance review:** SHIP first pass — reviewer re-ran the gate, probed concurrency + stdout
  discipline independently, verified the diff additive-only and the query path byte-identical.
- **Quality review:** FIX-FIRST (major: smoke was non-deterministic — unbounded LLM leg on the 2B
  could over-iterate) → fixed via `budget.max-tokens` cap in the smoke's scratch config (`261dd10`) →
  re-review **SHIP** with 4 consecutive smoke passes (~5-8s each). Deferred minors: mid-run client
  disconnect exits without rlmLoop cleanup (Group 3 owns connection lifecycle + AbortSignal).
- **Orchestrator validation:** check/build/test **391/391** + `smoke-acp.mjs` exit 0 — real local
  round-trip (station/qwen3.5-2b-FLM), handshake + prompt + single-session invariant verified.

### Execution review — Group 2 (event translation) — 2026-07-21 — **SHIP**

- **Engineer:** engineer-complex (Opus 4.8/high) — commits `e0668bb` → `00cfa63` → `00ac0ac`. New
  `src/acp/session.ts` (translateEvent): Message/EmitDone→`agent_message_chunk` (suffix-dedupe,
  shared messageId), root IterationOutput→`agent_thought_chunk`, ToolCallBefore/After→
  `tool_call`/`tool_call_update` (FIFO-paired, durationMs), **Recurse→flat tool-call node
  `rlm:<childCorrelationId>`** with ancestry in title (`[d{depth}]`) + machine-readable
  `_meta["rlmx/node"]` {correlationId,parentRunId,depth,latencyMs,costUsd,tokens}; child completions
  update the same node; Errors route to failed updates or error chunks; unknown events counted, never
  thrown. Cooperative cancel() (stream-cut; rlmLoop untouched — additive `RLMOptions.signal` noted as
  the future fix). `--recursive` smoke mode + 15 deterministic unit tests.
- **Engineering finds:** the 2B cannot drive delegation (emits ```python, ~12 tok/s) — recursive
  smokes pin the 35B-A3B; child budget is bounded via parent remaining budget; per-turn wall-clock
  override `RLMX_ACP_RUN_TIMEOUT_MS`.
- **Acceptance review:** SHIP — reviewer's OWN live recursive run passed end-to-end (full update
  sequence, real metrics latencyMs=231120 tokens 5137/3486, answer "391"). Minors recorded:
  completed-then-failed update ordering on failed children (bridge emit order, out of scope);
  streamedAnswer accumulation assumption documented; single-depth live proof.
- **Quality review (payload hygiene mandate):** FIX-FIRST twice, both real: (1) no truncation/
  redaction at the web boundary → added MAX_PAYLOAD_CHARS=16384 cap + secret redaction (`00cfa63`);
  (2) **measured ReDoS** — redaction regex ran on uncapped payloads (400KB "auth"-repeat = 15.4s
  synchronous event-loop freeze) → truncate-then-redact via boundedRedact (+256 overlap so secrets
  never straddle-leak) + regex runs bounded `{0,64}` (`00ac0ac`; 400KB → 3.2ms, verified from dist
  at 3 boundary placements). Final verdict **SHIP**; informational note: preview() safety rests on
  the regex bound — never add unbounded quantifiers to REDACTIONS.
- **Orchestrator validation:** check clean, **406/406 tests**, default smoke exit 0.

---

## Files to Create/Modify

```
~/prod/rlmx/package.json          (add @agentclientprotocol/sdk)
~/prod/rlmx/src/cli.ts            (new `acp` subcommand: command union + parse + switch)
~/prod/rlmx/src/acp/agent.ts      (new: ACP Agent — lifecycle)
~/prod/rlmx/src/acp/session.ts    (new: rlmx event stream → ACP session updates)
~/prod/rlmx/src/acp/session-store.ts (new: durable session persistence + restore-on-empty)
~/prod/rlmx/scripts/smoke-acp.mjs (new: automated ACP handshake/prompt/multiturn gate)
~/prod/rlmx/README.md             (Tidewave exec + Newio custom + acp-inspector dev loop)
```

### Execution review — Group 3 (recognition + persistence + docs) — 2026-07-21 — **SHIP**

- **Engineer:** engineer-complex (Opus 4.8/high) — commit `199d605` (+1 fix-loop commit). New
  `src/acp/session-store.ts`: one JSON/session at `~/.rlmx/acp-sessions/` (override
  `RLMX_ACP_SESSIONS_DIR`), atomic writes, bounded (32KB/field, 100 turns, 500 files);
  restore-on-empty on session/load; multi-turn via `buildConversationalQuery` preamble (8 turns,
  original query stored — never compounds). `initialize` advertises `loadSession:true` +
  `mcpCapabilities{http,sse}` with `_meta` honesty note (store/advertise only). Disconnect hardening:
  `abortActivePrompt` reuses cancel path + best-effort process-group reap. README client-wiring
  section (Tidewave/Zed/Newio/acp-inspector + ssh-remote first-class). `--multiturn` smoke:
  real SIGKILL → respawn → session/load → codeword recalled.
- **Reviews:** acceptance SHIP (1 fix loop); quality SHIP. Recorded minors: host-supplied sessionId
  lacks UUID guard in `sessionPath()` (same-user trust boundary — recommend guard); group-reap only
  when group leader; `--recursive` smoke environmentally blocked (35B decode > 600s REPL cap;
  recursion-path diff EMPTY — not a regression; passing runs recorded earlier in Group 2; latent
  smoke-budget note: attempt-2 window too small).
- **Orchestrator validation:** check clean, **417/417**, default + `--multiturn` smokes PASS
  (session survived agent restart, no "Invalid params").
