# Wish: rlmx v2 — RuntimeBackend seam with prime-agent as gated backend

| Field | Value |
|-------|-------|
| **Status** | APPROVED |
| **Slug** | `rlmx-v2-prime-backend` |
| **Date** | 2026-08-14 |
| **Author** | Felipe |
| **Appetite** | medium |
| **Branch** | `wish/rlmx-v2-prime-backend` |
| **Repos touched** | rlmx |
| **Design** | _No brainstorm — direct wish_ |

## Summary

**Problem statement:** We do not know whether rlmx's microagent platform can run on prime-agent instead of its own RLM engine — this wish answers that with one falsifiable test: the same microagents, on the same models, through both backends, pass the frozen `docs/parity-explore.md` gate with an unchanged MCP contract, or they do not.

Three independent assessments (rlmx1/2/3.md, 2026-08-14) converged on the same decision: keep the rlmx microagent platform (agent.yaml discovery, MCP tool-per-agent, `.proposed` gate — the differentiated ~450-line layer prime-agent does not have) and stop investing in the custom RLM engine, which prime-agent has out-built on every axis. This wish executes the first, falsifiable step: introduce a `RuntimeBackend` seam at the single existing execution call site (`runTurn` → `rlmLoop` in `src/mcp/server.ts`), add a prime-agent subprocess backend, and run the frozen parity/compatibility gate that decides whether the legacy engine can later be deleted. No deletion happens in this wish.

## Scope

### IN

- A `RuntimeBackend` interface at the `runTurn` → `rlmLoop` seam, with the current engine wrapped as `LegacyRlmxBackend` and zero MCP-contract change.
- A `PrimeBackend` that spawns the **pinned, installed prime-agent binary** (0.7.2) per turn via `--mode json -p` (with `--append-system-prompt`, `--model`, `--no-session`, `--cwd`, and the `-nc -ne -ns -np` isolation flags), maps JSONL events to MCP progress notifications and the cost footer, and enforces rlmx budgets via process-tree kill on an rlmx-owned wall-clock deadline and cost/token ceiling.
- An internal, undocumented `backend: rlmx | prime` field on the resolved microagent spec to select the backend per agent.
- A backend contract test that drives **both backends through one harness** and asserts their observable results are equal: result envelope, cost-footer field set, `isError` classification, and progress-notification sequence.
- A gate report (committed to this wish folder) running the **`explore` recipe on the frozen parity suite** (`docs/parity-explore.md`) through both backends — via a gate-only agent directory that reuses `examples/agents/explore/SYSTEM.md` verbatim and re-pins only the model to one both backends can reach — measuring answer quality, cost, tokens, latency, cold-start, concurrency behavior, and forced aborts, with an explicit PASS/FAIL verdict.

### OUT

- Deleting `src/rlm.ts`, `src/repl.ts`/`ipc.ts`, `python/` REPL machinery, pg/pgserve, or `gemini.ts` — deletion is a follow-up wish gated on this wish's parity report.
- Porting station/khal providers as prime-agent custom-provider extensions. **Consequence, stated explicitly:** prime 0.7.2 exposes only the `deepseek` and `prime-inference` providers (verified via `prime-agent model list`), so **no agent may be measured on the prime leg at its shipped `khal/`- or `station/`-pinned model**. The shipped `examples/agents/*` entries pinned to rlmx-internal models — `explore` and `explore-r` (`khal/deepseek-v4-flash`), `changelog`, `codebase-qa`, `log-triage` (`station/Qwen3.6-35B-A3B-MTP-GGUF`) — are therefore never invoked as-is on the prime leg, and the four non-explore ones are out of the quality comparison entirely (legacy-only, re-measured in a follow-up wish that adds provider reach). The `explore` *recipe* still participates, because Group 3 runs it from a gate-only copy re-pinned to a model both backends reach — a model swap applied **identically to both legs**, not a port of khal/station into prime.
- Rewriting the `explore`/`explore-r` prompts against prime-agent's ipython/`rlm()` protocol.
- Migrating or wrapping `khal-os/brain`.
- RPC-mode process pooling, daemon integration, session-dir resume mapping, or any prime-agent SDK/npm dependency.
- Hygiene items from the council (SECURITY.md, checksum-pinned installer, MCP threat-model doc) — orthogonal, separate wish.
- Any change to the `agent.yaml` schema v1 or the Claude Code plugin.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Option B (platform + prime backend), not drop-rlmx (A) or status quo (C) | All three assessments agree the microagent platform is the unique asset (prime-agent has no declarative, host-neutral, MCP-exposed microagents) and the custom engine is an unwinnable one-person race. Dissent's Option A is preserved as the fallback if the gate fails. |
| 2 | Integrate at the **installed binary** (`--mode json -p` subprocess), never the npm SDK | Verified: `@earendil-works/pi-coding-agent` on npm resolves to *upstream pi 0.84.x — a different codebase*; the fork ships only as R2 tarballs on its own 0.7.x line. This settles the rlmx2-vs-rlmx1/3 disagreement on integration surface in favor of the subprocess. **Pinned version for this wish: `0.7.2`** (the installed binary, confirmed by `prime-agent --version`); `prime-agent update` exists, so upgrades are deliberate events and any change to this pin is a recorded decision. |
| 3 | Single adapter seam (`RuntimeBackend`), legacy engine retained as parallel backend | The MCP path calls the engine at exactly one site and reads back `answer`/`budgetHit`/cost. A one-module seam makes swap-back or swap-away cheap (council condition 3) and enables the two-backend gate comparison. |
| 4 | rlmx stays the authoritative budget owner | Prime's session/CLI surface has no budget enforcement. `budget.ts` semantics are enforced by rlmx: wall-clock deadline + subprocess kill on cost/token/time ceiling. |
| 5 | Microagent contract observably stable across the swap | agent.yaml fields + the host-visible MCP behavior *are* the product (council condition 2). The Group 1 contract test enforces this by running **both backends through one harness** and comparing what the host actually sees — result envelope, footer field set, `isError` classification, progress-notification sequence — rather than comparing statically generated schemas, which are produced by zero-argument generators that never see a backend and so could not fail. |
| 6 | Never touch the daemon socket | Explicitly internal/unstable (protocol v4→7 in three months; docs a major version behind). Only documented public contracts: `-p`, `--mode json` (and `--mode rpc` later if pooling is triggered). |
| 7 | The gate runs the **`explore` recipe** on the frozen suite, from a **gate-only agent directory** re-pinned to `deepseek/deepseek-v4-flash`, at a **verified-identical resolved model** on both legs | Three constraints have to hold at once and only this arrangement satisfies all three. (a) *The workload must fit the suite:* `docs/parity-explore.md` is explore-specific — six read-only codebase-exploration tasks scored by a `path:line`-citation rubric — so only a loop-shaped explore agent can execute it; the `gemini-*` demo agents (`hello-world` greet, `research-agent` fetch-url, `brain-triage` corpus, single-step shapes) cannot be scored by it at all and are therefore **not** the quality workload. (b) *The model must be reachable by both backends:* shipped `explore` is `khal/deepseek-v4-flash`, whose `khal/` provider prime cannot address — but the model itself is natively reachable on both legs, so the gate copy re-pins to **`deepseek/deepseek-v4-flash`**: legacy reaches it via pi-ai's built-in `deepseek` provider (`node_modules/@earendil-works/pi-ai/dist/providers/deepseek.js`, `baseUrl: https://api.deepseek.com`), prime as `--provider deepseek --model deepseek-v4-flash` (`prime-agent model list`; live spawn verified 2026-08-14). **Amended 2026-08-14** (Felipe's decision — his actual model) from the original `google/gemini-2.5-flash` pin; see the Amendment section. (c) *The pin must be provider-prefixed:* `applyAgent` (`src/mcp/server.ts:507`) ignores a bare model id — `splitModel`/`parseModelRef` (`src/config.ts:265-271`) returns null without a `/` — so a bare `deepseek-v4-flash` would be silently dropped and the legacy leg would run the ambient `rlmx.yaml` model while prime ran deepseek-v4-flash: model parity false, and nothing would report it. Hence the prefixed pin **plus** the resolved-model pre-flight assertion in Group 3. |

## Amendment 2026-08-14 — Gate model re-pin (recorded decision)

**Decision:** re-pin the parity gate from `google/gemini-2.5-flash` to **`deepseek/deepseek-v4-flash`** on both legs. **Approver:** Felipe (user, wish author). **Trigger:** user correction — "I only use deepseek v4 flash".

**Evidence, verified before recording:**
- Prime leg: `prime-agent model list` exposes `deepseek deepseek-v4-flash` natively; a live `--provider deepseek --model deepseek-v4-flash` spawn completed correctly on this machine (2026-08-14).
- Legacy leg: pi-ai 0.80.10's built-in registry ships a native `deepseek` provider (`node_modules/@earendil-works/pi-ai/dist/providers/deepseek.js`, provider id `deepseek`, `baseUrl: https://api.deepseek.com`) with model id `deepseek-v4-flash` (`deepseek.models.js`), registered via `builtinModels()` (`providers/all.js`). No khal/station involved.
- Both legs therefore address the model without any gateway-specific pin; the serving path is `api.deepseek.com` on both sides (recorded verbatim in the gate report).

**Knock-on changes applied in this document:** Decision 7 re-pinned; Group 2 model mapping names `--provider deepseek --model deepseek-v4-flash` as the gate form (the google→prime-inference mapping stays supported but is no longer the gate model); Group 3 gate-copy pin, pre-flight assertion string, serving-path paragraph, environment prerequisite 2 (now `DEEPSEEK_API_KEY` for the legacy leg; prime uses its own credential store — verified working), Simplicity Case confound note, and the file list updated. The review-notes appendix (HIGH-A/B, MEDIUM-1, LOW-2) retains its historical gemini wording — superseded by this amendment, not rewritten.

**Out of scope of this amendment:** the frozen suite, explore prompts, budget block, and both backends' stop semantics are unchanged.

## Simplicity Case

- **Simplest complete design:** one interface, two implementations, one subprocess spawn per microagent turn. No pooling, no daemon, no resident state, no new user-facing configuration; session resume stays transcript-replay exactly as today.
- **Added machinery:** the `RuntimeBackend` interface and the internal `backend` selector field — both required *now* by the gate itself, which must run identical workloads through legacy and prime side by side.
- **Deferred until measured:** pooled `--mode rpc` subprocess per session — trigger is a decided plan constant, not a judgment call: the gate report shows **prime P50 wall-clock ≥ 1.5× legacy P50 on the parity suite**, *or* **median spawn/cold-start overhead > 2s per turn**. Either threshold alone fires it, with one qualification carried from Group 3: the wall-clock limb was confounded by the original serving-path difference (legacy → `google` direct, prime → `prime-inference` gateway); after the deepseek re-pin (Amendment 2026-08-14) both legs target `api.deepseek.com`, so the confound is reduced to any residual auth-path/upstream difference recorded in the gate report — the limb fires on its own only when the cold-start limb corroborates it; the cold-start limb, which isolates backend overhead, always fires on its own. Both are measured in Group 3 and may be retuned only by a decision recorded in the gate report at gate setup, before any numbers are read. SDK in-process integration (trigger: fork publishes to npm under its own identity); daemon amortization (trigger: real concurrency demand the gate quantifies).
- **Complexity removed:** no fork of prime-agent (would recreate the maintenance problem this removes); no daemon-socket protocol; no new session/compaction machinery; no speculative multi-backend registry — exactly two backends, hard-coded.

## Dependencies

**depends-on:** none
**blocks:** none

## Success Criteria

- [ ] `RuntimeBackend` seam lands with `LegacyRlmxBackend` as default; `npm run check`, `npm run build`, `tests/mcp-agents.test.ts`, and `scripts/smoke-mcp.mjs` all pass with no diff in MCP tool names, schemas, or result shape.
- [ ] `PrimeBackend` runs a microagent end-to-end against the pinned prime-agent binary (0.7.2): exact model + thinking selection applied, microagent role **appended** to prime's base RLM prompt via `--append-system-prompt` (base prompt intact), cwd honored, final answer extracted, usage/cost rendered in the existing cost footer.
- [ ] The rlmx-owned deadline and budget ceiling kill the prime subprocess and its descendants, and the killed run surfaces as a **non-throwing result** consistent with `isFailedRun` in `src/mcp/server.ts`: a cost/token ceiling breach returns an answer with `budgetHit` set and `isError: false`, a wall-clock deadline returns the timeout answer classified as a failed run — the same host-visible outcomes legacy already produces from `maxIterations`/`timeout` (asserted by test). No `AbortSignal` is threaded through the backend interface; each backend owns its own stopping semantics.
- [ ] Backend contract test drives both backends through one harness and proves the observable results are equal: `structuredContent` `{answer, session_id}` mirrored by the text block, cost-footer field set, `isError` classification, and progress-notification sequence.
- [ ] Every compared run is verified to use the **identical resolved model** on both backends — asserted from what each leg actually ran (legacy: the `config.model` the run used, as rendered `provider/model` by `formatFooter`, `src/mcp/server.ts:560`; prime: the `--model` argv of the spawn), not from what the agent file declares — and the comparison aborts rather than reporting numbers on a mismatch.
- [ ] Gate report exists at `.genie/wishes/rlmx-v2-prime-backend/gate-report.md` with quality, cost, tokens, latency, cold-start, concurrency, and abort results for both backends on the frozen parity suite, and an explicit PASS/FAIL verdict against the acceptance gates below.
- [ ] Concurrent invocations of two microagents with different cwds show no workspace/path leakage between sessions (asserted in the gate run).

## Execution Strategy

### Wave 1 (sequential)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 1 | engineer | 3 — mechanical extraction at a single call site, but touches session-store/lifecycle wiring (+2 stateful, +1 multi-module) | engineer-standard / high | Introduce `RuntimeBackend`, wrap legacy engine, add contract test |

### Wave 2 (sequential, after Wave 1)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 2 | engineer | 6 — subprocess lifecycle + abort/kill semantics (+2 stateful, +2 orchestration/lifecycle), cost/model mapping (+2) | engineer-complex / high | Implement `PrimeBackend` subprocess adapter over `--mode json -p` |

### Wave 3 (sequential, after Wave 2)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 3 | engineer | 4 — subjective quality acceptance (+2), cost/model measurement (+2) | engineer-complex / high | Run the two-backend parity/compat campaign; write the gate report |

## Execution Groups

### Group 1: RuntimeBackend seam + legacy wrap

**Goal:** Invert the MCP server from "calls rlmLoop" to "calls a backend" with zero observable change.

**Deliverables:**
1. `src/mcp/backend.ts` — `RuntimeBackend` interface: `run(agent, request, emit) → Promise<MicroagentResult>`. **No `signal` parameter**: the MCP server has no cancellation wiring and `RLMOptions` (`src/rlm.ts`) has no `signal` field, so a signal would have no producer and no legacy consumer. Each backend owns its own stopping semantics — legacy keeps its internal `maxIterations`/`timeout` → `budgetHit` behavior unchanged; prime owns a deadline/kill (Group 2). `MicroagentResult` enumerates exactly the fields `formatFooter` and `isFailedRun` consume: `answer`, `iterations`, `budgetHit`, and `usage.inputTokens` / `usage.outputTokens` / `usage.totalCost`.
2. `src/mcp/backends/legacy.ts` — `LegacyRlmxBackend` wrapping the current `rlmLoop` call, selected by default.
3. Internal `backend: rlmx | prime` field on the resolved spec (`src/sdk/agent-spec.ts`), undocumented. The generic `rlmx_query` tool (`GENERIC_TOOL`, `src/mcp/server.ts:74`) has no agent spec and therefore no `backend` field: **in this wish `rlmx_query` always uses the legacy backend**, unconditionally and with no selection path.
4. `tests/backend-contract.test.ts` — one harness, both backends, same request; asserts their host-visible results are **equal**: the `structuredContent` `{answer, session_id}` envelope and its mirrored text block, the cost-footer field set, the `isError` classification, and the progress-notification sequence. It deliberately does *not* compare generated tool schemas: `genericToolSchema`/`agentToolSchema`/`toolOutputSchema` take no backend argument, so a schema comparison passes by construction and can never fail.

**Acceptance Criteria:**
- [ ] No diff in MCP tool registration, schemas, progress notifications, or result shape (contract test + existing suite prove it).
- [ ] The contract test fails if either backend's result envelope, footer field set, `isError` classification, or progress-notification sequence diverges from the other's (demonstrated by a deliberate temporary divergence during development).
- [ ] `LegacyRlmxBackend` preserves busy/orphan session semantics, non-throwing abort detection, and broken-agent stderr reporting, with its existing `maxIterations`/`timeout` → `budgetHit` semantics untouched.
- [ ] All prime-specific types absent from this group — the seam compiles without any prime-agent reference.

**Validation:**
```bash
npm run check && npm run build && node --test dist/tests/mcp-agents.test.js dist/tests/backend-contract.test.js && node scripts/smoke-mcp.mjs --no-live
```
Scope rationale: this refactor reaches the MCP server's runtime boundary, so it gets the type gate, the full 1,119-line `mcp-agents` behavior suite (the designated safety net), the new contract test, and the MCP smoke script. `--no-live` keeps the smoke leg protocol-only and hermetic; the script's live turns require a running station/Lemonade gateway, which is a **Group 3 gate-environment prerequisite**, not a Group 1/2 one.

**depends-on:** none

---

### Group 2: PrimeBackend subprocess adapter

**Goal:** Execute a microagent turn through the pinned prime-agent binary with rlmx-owned budgets and unchanged host-facing behavior.

**Deliverables:**
1. `src/mcp/backends/prime.ts` — spawns `prime-agent --mode json -p` with:
   - `--append-system-prompt` for the microagent role. **Not `--system-prompt`**: per 0.7.2 `--help`, `--system-prompt` *replaces* the default system prompt while `--append-system-prompt` *appends* to it. Replacing would strip prime's base RLM prompt, handicap the prime leg, and corrupt the Group 3 measurement.
   - `--provider deepseek --model deepseek-v4-flash` — the gate model's exact addressing form (amended 2026-08-14, see Amendment section); verified from `prime-agent model list`. rlmx's `deepseek/deepseek-v4-flash` maps to prime's `deepseek` provider with the same bare id. (The original `google/gemini-2.5-flash` → `--provider prime-inference --model google/<id>` mapping remains supported for `google/`-prefixed specs, but is no longer the gate model.)
   - `--no-session`, `--cwd`.
   - `-nc -ne -ns -np` — disable context-file (AGENTS.md/CLAUDE.md), extension, skill, and prompt-template discovery. Justification: each is discovered from the ambient host by default, which would make gate numbers depend on the operator's machine and would re-open a prompt-injection surface through files rlmx never vetted.

   Parses the JSONL event stream (`agent_start`, `text_delta`, `tool_execution_*`, `turn_end`) into MCP progress notifications and the cost footer.
2. Budget enforcement, owned entirely by this backend (no `signal` crosses the interface): an rlmx wall-clock deadline plus a cost/token ceiling monitored from usage events; either breach kills the subprocess **and its descendants**. The killed run returns a normal `MicroagentResult`, never a throw — a ceiling breach sets `budgetHit` and stays `isError: false`, a deadline expiry produces the timeout answer that `isFailedRun` (`src/mcp/server.ts:653`) classifies as failed. These are the same two host-visible outcomes legacy already produces from `maxIterations`/`timeout`.
3. Binary pinning: an explicit expected-version check at backend startup asserting `prime-agent --version` reports **`0.7.2`**, failing fast with a clear stderr report if the binary is absent or the version differs.
4. Spec mapping per the assessment table: `model`, `thinking`, `system`, `context`/cwd, `budget.max_cost`/`max_iterations` compatibility mapping; unsupported fields fail loudly rather than silently degrade. `MicroagentResult.iterations` is sourced from prime's **turn count** (prime has no iteration concept of its own); the footer renders it in the same field legacy fills.

**Acceptance Criteria:**
- [ ] A prime-backed microagent invoked through `rlmx mcp` returns a final structured result (answer + usage + cost) identical in shape to a legacy-backed one.
- [ ] Prime's base RLM prompt survives the spawn: the spawned session carries prime's default system prompt with the microagent role appended after it, asserted directly (the argv contains `--append-system-prompt` and no `--system-prompt`, and a probe run reports both the base-prompt content and the appended role).
- [ ] Deadline and ceiling breaches terminate the subprocess and its descendants, and the turn returns non-throwing with the `budgetHit` / timeout-answer classification above — no MCP-level exception, matching legacy's `isFailedRun` handling.
- [ ] Version-pin check fails fast with an actionable message when the binary is missing or is not `0.7.2`.
- [ ] No prime-agent SDK/npm import anywhere; the daemon socket is never touched.

**Validation:**
```bash
npm run check && npm run build && node --test dist/tests/mcp-agents.test.js dist/tests/backend-contract.test.js dist/tests/prime-backend.test.js && node scripts/smoke-mcp.mjs --no-live
```
Scope rationale: new runtime behavior at a process boundary — focused behavior tests for spawn/event-mapping/abort/kill (`prime-backend.test.ts`, using a stub binary for determinism) plus the shared gates from Group 1 (same `--no-live` smoke leg, same rationale — the live gateway belongs to Group 3's environment), since this group can regress the same MCP surface.

**depends-on:** Group 1

---

### Group 3: Two-backend parity and compatibility gate

**Goal:** Produce the evidence that decides whether the legacy engine can be deleted — or whether the falsification fallback applies.

**Deliverables:**
1. **Gate-only agent directory** (created in this group, not shipped): a copy of `examples/agents/explore/` whose `SYSTEM.md` is reused **verbatim** — byte-identical, so prompt content is not a variable — and whose `agent.yaml` differs from the shipped one in exactly one line: `model: deepseek/deepseek-v4-flash` instead of `khal/deepseek-v4-flash`. `shape: loop`, `system: SYSTEM.md`, and the `budget` block (`max_iterations: 24`, `max_cost: 2.00`) are carried over unchanged. The provider prefix is load-bearing, not cosmetic — see Decision 7(c). One directory is used for **both legs**, selected per leg only by the internal `backend` field.

   It is discovered via the **`RLMX_AGENTS_DIR` environment variable** (`src/mcp/agents.ts:84`, `agentRoots`), which takes a colon-separated list and **replaces the default roots entirely** (`~/.rlmx/agents`, `<cwd>/.agents`, `<cwd>/.rlmx/agents`). Pointing it at the gate directory alone is what makes the run hermetic: the gate MCP server exposes only the gate agents, so no ambient user or project agent can shadow them or leak into the measurement.
2. Gate run: the `explore` recipe above, on the frozen parity suite (`docs/parity-explore.md` protocol), through both backends — scoring answer quality, failure rate, tokens, cost, latency, and cold-start. The `gemini-*` demo agents (`hello-world`, `research-agent`, `brain-triage`) are **not** part of the quality comparison — they cannot execute this suite (Decision 7(a)) — but they are retained for the contract, abort, and concurrency exercises in deliverable 3, where their cheapness and single-step shape are an advantage and no rubric is involved.
3. Concurrency exercise: parallel invocations with distinct cwds (no path/permission leakage) and forced deadline/ceiling aborts mid-run on both backends.
4. `gate-report.md` in this wish folder: all measurements, both backends, explicit PASS/FAIL per acceptance gate, the exact binary version the prime leg ran (`prime-agent --version` output, expected `0.7.2`, recorded verbatim), the resolved model observed on each leg (deliverable 1's pre-flight, per the AC below), the pooled-RPC trigger thresholds as they stood at gate setup, the environment prerequisites as actually provisioned (see scope rationale), and — on FAIL — the fallback ranking from the council (keep legacy as default second backend; only then consider Option A).

   **Serving-path confound, stated in the report next to every cost and latency number:** with the deepseek re-pin both legs target the same upstream endpoint (`api.deepseek.com` — legacy via pi-ai's `deepseek` provider `baseUrl`, prime via its bundled deepseek provider, both verified at gate setup and recorded verbatim), so the original gemini gateway-vs-direct confound is largely resolved. The report still states each leg's verified serving path next to every cost and latency number, because auth paths differ (legacy uses `DEEPSEEK_API_KEY`, prime its own credential store) and either leg's observed path may still differ from the recorded one. Quality comparison is unaffected (same model, same prompt, same suite). Cold-start and spawn overhead are the metrics that isolate backend cost, so the pooled-RPC trigger's wall-clock limb is reported as confounded: it fires on its own only when the cold-start limb corroborates it, otherwise the report records the delta and defers the pooling decision explicitly.

**Acceptance Criteria:**
- [ ] Report covers quality, cost, tokens, latency, cold-start, concurrency, and abort for both backends with the commands that produced each number, and records the exact prime-agent binary version used.
- [ ] Answer quality is scored by the frozen `docs/parity-explore.md` rubric, not by judgment: its three fixed criteria (*The rubric*, `docs/parity-explore.md:150-163`) — required facts stated at ≥90% of the checklist (⌈0.9 × N⌉), every `path:line` citation under the task root resolving to a real line, and no fabricated path/symbol/line — with **pass = all three**, decided mechanically for criteria 2 and 3 by `parity/score-task.mjs` under that doc's *Scoring conventions*. The suite-level bar is the doc's own gate arithmetic (`docs/parity-explore.md:36-38`): ≥80% of tasks pass, i.e. **≥5 of 6** on the six-task frozen suite. "Meet or exceed legacy answer quality" means the prime leg clears that same bar and its per-task pass count is ≥ the legacy leg's on the identical model.
- [ ] **Resolved-model pre-flight, run before any scored task and recorded in the report:** each leg reports the model it *actually* resolved — legacy the `config.model` the run used (the `provider/model` rendered by `formatFooter`, `src/mcp/server.ts:560`), prime the `--model` value in the spawn argv — and both must read `deepseek/deepseek-v4-flash`. On any mismatch the comparison **aborts and no numbers are reported**. This is not a formality: a bare (unprefixed) model id is silently dropped by `applyAgent` (`src/mcp/server.ts:507`) and the legacy leg would fall back to the ambient `rlmx.yaml` model while prime ran the intended one, so declared parity can be false while every run succeeds.
- [ ] The scored workload is the `explore` recipe on the frozen suite, run from the gate-only directory on both legs with byte-identical `SYSTEM.md`; any agent that cannot execute the suite is reported as excluded from the quality comparison, never as a comparison.
- [ ] The gate run is reproducible from a clean environment: the prime leg spawns with `-nc -ne -ns -np`, so no host AGENTS.md/CLAUDE.md, extension, skill, or prompt template participates, and a re-run on a different machine with the same pinned binary reproduces the recorded configuration.
- [ ] The verdict and fallback decision are written down, not implied.

**Validation:**
```bash
node scripts/smoke-explore.mjs && test -s .genie/wishes/rlmx-v2-prime-backend/gate-report.md && grep -Eq 'Verdict: (PASS|FAIL)' .genie/wishes/rlmx-v2-prime-backend/gate-report.md
```
Scope rationale: this group's deliverable is evidence, not code — validation checks the explore smoke path still runs and that a non-empty report with an explicit verdict exists; the report's own numbers carry the per-measurement commands.

**Environment prerequisites (this group only — Groups 1 and 2 run hermetically with `--no-live`).** The gate cannot start until all four are satisfied, and the report records how each was met:
1. **A running station/Lemonade gateway** — required by the live legs of `scripts/smoke-mcp.mjs` (the ones `--no-live` skips) and by any legacy-leg run of the station-pinned agents.
2. **A `DEEPSEEK_API_KEY`** for the legacy leg — rlmx's `deepseek` provider authenticates with it (`src/settings.ts:41` maps it; currently absent from this machine's env). Absent it, every legacy-leg gate run fails at model call time. The prime leg's deepseek credential is prime-agent's own store (a live `--provider deepseek` spawn succeeded on this machine 2026-08-14); the report records how each was met. (This replaces the original `prime-inference` credential prerequisite — the gate no longer uses the prime-inference gateway.)
3. **The frozen suite's task roots at their absolute paths** — `/home/namastex/prod/brain` and `/home/namastex/workspace/repos/genie` (`docs/parity-explore.md:27-34`). The rubric's criterion 2 resolves `path:line` citations *inside those roots*, so they are part of the frozen suite, not incidental. **They are not present on this machine.** The gate must therefore run on a host that has them, or the roots must be provisioned there; re-pointing the suite at different checkouts changes the frozen artifact and is allowed only by a decision recorded in `gate-report.md` at gate setup, before any run — never silently, and never after seeing scores. (`docs/parity-explore.md:63` already documents that live checkouts moving under the suite corrupted an earlier round.)
4. **`RLMX_AGENTS_DIR` pointed at the gate-only directory** (deliverable 1), so the default discovery roots are replaced and no ambient agent participates.

**depends-on:** Group 2

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] Functional: from Claude Code, invoking a microagent tool served by `rlmx mcp` with `backend: prime` returns an answer with the cost footer, indistinguishable in shape from v1.
- [ ] Integration: flipping the same microagent back to `backend: rlmx` requires no other change and no session-state migration (instant rollback path).
- [ ] Regression: all existing microagents with no `backend` field behave exactly as before (legacy default), including `.proposed` gating and live tool-list refresh.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Prime-agent weekly-release churn breaks the JSONL/CLI contract | Medium | Pin the installed binary version; integrate only documented contracts (`-p`, `--mode json`); smoke test in CI against the pinned version; upgrades are deliberate events. |
| Per-turn subprocess spawn latency erodes the cheap/fast microagent premise | Medium | Measured explicitly in the Group 3 gate (cold-start is a first-class metric); pooled `--mode rpc` is the pre-ranked fallback, deferred behind the decided thresholds in the Simplicity Case (prime P50 ≥ 1.5× legacy P50, or median cold-start > 2s per turn). |
| Parity gate fails: prime-backed quality/cost worse than legacy | Medium | This is the designed falsification point, not a surprise: legacy stays default, fallback ranking applies (legacy as second backend → re-evaluate Option A). Nothing is deleted in this wish. |
| Loss of strict prompt externalization changes explore-class quality | Medium | Legacy backend retained for the comparison; strict externalization only preserved beyond v2 if the gate shows a material advantage. Note the explore parity gate already failed twice on v1 — the baseline is honest. |
| Prime pivots, dies, or ships declarative subagents + outbound MCP (kill-criterion) | Low | The seam is one module; any `-p`-capable agent CLI slots into the same contract, and v1's loop stays in git history. Kill-criterion from the council carries forward to follow-up wishes. |
| `khal-os/brain` breaks when the engine is later removed | Low (out of scope here) | Nothing removed in this wish; the SDK path is untouched. The follow-up deletion wish must inventory brain first. |

---

## Review Results

_The read-only reviewer returns evidence; the invoking orchestrator appends a timestamped block here after plan, execution, and PR reviews._

### Plan review — 2026-08-14T18:53Z — verdict: FIX-FIRST

- **Context:** plan review (pre-`work`), independent reviewer subagent, read-only; target = this WISH.md (untracked working tree). Advisory questioner lens convened alongside.
- **Grounding verified against repo:** single `rlmLoop` call site in MCP path (`src/mcp/server.ts:752` inside `runTurn`; `runTurn` called at `:926` microagent and `:939` generic query); `tests/mcp-agents.test.ts` = 1,119 lines; all referenced scripts/docs exist; package.json `check`/`build`/`test` match validation commands; installed `prime-agent` = 0.7.2; `prime-agent --help` flag inventory captured.
- **Checklist:** Scope IN/OUT PASS; bite-sized groups PASS; dependencies PASS; validation proportionality PASS (caveat MEDIUM-2); aggregate gates PASS; Simplicity Case PASS (deferrals have measurable triggers, both added mechanisms map to current criteria). FAIL: one-sentence problem statement (MEDIUM-5); testable acceptance criteria (HIGH-3, HIGH-4).

**Gaps:**

| # | Severity | Gap | Fix |
|---|----------|-----|-----|
| HIGH-1 | HIGH | Spawn spec uses `--system-prompt`, which *replaces* prime's base RLM prompt (per 0.7.2 `--help`); wish intent is append. Would handicap the prime leg and corrupt the Group 3 measurement. | Use `--append-system-prompt`; add Group 2 AC that prime's base RLM prompt survives. |
| HIGH-2 | HIGH | Gate workload unrunnable on prime as scoped: `explore` uses `khal/deepseek-v4-flash`, three agents use `station/Qwen3.6-*` — rlmx-internal providers excluded by Scope OUT; prime leg of 5/8 example agents fails at spawn; no model named for the prime leg. | Name the exact model per backend; pin both legs to a mutually reachable model (`gemini-*` agents) or map khal/station via prime `--provider` to the same gateway; state model-parity rule as an AC. |
| HIGH-3 | HIGH | `RuntimeBackend.run(..., signal, ...)` has no producer — MCP server has zero cancellation wiring, `RLMOptions` has no `signal` (known limitation per `src/acp/agent.ts:414`); SC 3 / Group 2 AC 2 compare abort semantics legacy does not have. | Drop `signal` (Group 2 owns deadline/kill internally) or add a Group 1 deliverable creating the signal with a named source, documenting that legacy ignores it; restate SC 3 accordingly. |
| HIGH-4 | HIGH | Backend contract test as specified cannot fail: tool names/schemas come from zero-argument generators (`genericToolSchema`/`agentToolSchema`/`toolOutputSchema`) that never see a backend. | Redefine the test to assert equality of result envelope (`structuredContent`), footer field set, `isError` classification, and progress-notification sequence across backends. |
| HIGH-5 | HIGH | Prime spawn inherits ambient host state (AGENTS.md/CLAUDE.md context files, extensions, skills, prompt templates discovered by default) — gate numbers non-reproducible, reopens prompt-injection surface. | Add `-nc -ne -ns -np` to the spawn spec (or justify each kept); Group 3 AC: gate reproducible from clean environment. |
| MEDIUM-1 | MEDIUM | `MicroagentResult` underspecified vs `formatFooter` (also reads `iterations`, `usage.inputTokens/outputTokens/totalCost`); prime has no iterations concept. | Enumerate full field list in Group 1; state prime's `iterations` source (turn count) in Group 2. |
| MEDIUM-2 | MEDIUM | `smoke-mcp.mjs` runs live legs against station/Lemonade gateway unless `--no-live`. | Use `--no-live` in Group 1/2 validation or state gateway prerequisite in scope rationale. |
| MEDIUM-3 | MEDIUM | "Pinned" asserted but no version string anywhere; `prime-agent update` exists. | Write `0.7.2` into Decision 2 and Group 2 deliverable 3; record in gate-report.md. |
| MEDIUM-4 | MEDIUM | Backend selection undefined for generic `rlmx_query` (no spec, no `backend` field). | State in Group 1: `rlmx_query` is always legacy. |
| MEDIUM-5 | MEDIUM | No scoring rubric for "meet or exceed legacy answer quality"; no one-sentence problem statement. | Cite `docs/parity-explore.md` section + numeric bar in Group 3; add one-sentence testable problem statement to Summary. |
| LOW-1 | LOW | Group 1 complexity likely understated at 3 (emitter/heartbeat relocation + signal question). | Rescore if scope grows. |
| LOW-2 | LOW | Per-group `blocks:` tags absent (chain derivable). | Optional. |

**Advisory (questioner lens):** no unjustified machinery found. Open questions: (1) concrete latency/cold-start threshold for the pooled-RPC trigger — "materially degrades" is ambiguous; (2) is the station/khal local-model story load-bearing through v2 (overlaps HIGH-2); (3) where prompt-appending safety is verified (overlaps HIGH-1).

**Reviewer conclusion:** architecture, decomposition, dependency chain, validation strategy, and Simplicity Case are sound; all five HIGH fixes are edits to WISH.md before `work` starts.

### Plan re-review (fix loop 1) — 2026-08-14T19:05Z — verdict: FIX-FIRST

- **Context:** plan re-review by the same independent reviewer after the fix agent's amendments; read-only.
- **Closure check:** HIGH-1, HIGH-3, HIGH-4, HIGH-5 and MEDIUM-1..5 all CLOSED with every added citation verified exact (`isFailedRun` at `src/mcp/server.ts:653`, `GENERIC_TOOL` at `:74`, rubric at `docs/parity-explore.md:150-163`, gate arithmetic at `:36-38`, `parity/score-task.mjs` exists, binary pin `0.7.2`, all 0.7.2 flags present, `prime-agent model list gemini` confirms the addressing form). Questioner advisory CLOSED (numeric pooling thresholds + anti-gaming clause). HIGH-2 NOT closed — its fix regressed into two new gaps.
- **Checklist:** all criteria PASS except "every task has testable acceptance criteria" (Group 3 fails via HIGH-A/HIGH-B).

**New gaps:**

| # | Severity | Gap | Fix |
|---|----------|-----|-----|
| HIGH-A | HIGH | Group 3's replacement workload (gemini demo agents `hello-world`/`research-agent`/`brain-triage`) cannot execute the explore-specific frozen suite it is scored against — the suite's six tasks are read-only codebase explorations with a path:line-citation rubric; a `greet` single-step agent cannot be scored by it. Task roots (`/home/namastex/prod/brain`, `/home/namastex/workspace/repos/genie`) also absent on this machine. | Keep the `explore` prompts and frozen suite; add a **gate-only agent directory** (copy of `examples/agents/explore/`, `SYSTEM.md` verbatim, `model: google/gemini-2.5-flash`) discovered via `RLMX_AGENTS_DIR`, run on both legs. |
| HIGH-B | HIGH | Model parity is silently false on the chosen agents: they declare **bare** model ids, and `applyAgent` (`src/mcp/server.ts:507`) ignores bare ids (`splitModel`/`parseModelRef` returns null), so the legacy leg falls back to ambient `rlmx.yaml` (`google/gemini-3.1-flash-lite-preview`) while prime runs `google/gemini-2.5-flash`. Nothing in the plan would catch it. | Use provider-prefixed models in the gate agents; add a Group 3 pre-flight AC asserting the **resolved** model per leg (legacy `config.model` actually used; prime `--model` argv) and aborting the comparison on mismatch. |
| MEDIUM-A | MEDIUM | Matched model ids still compare two serving paths (legacy → `google` direct; prime → `prime-inference` gateway): cost/latency deltas partly measure gateway-vs-direct. | State the confound explicitly in the gate-report contents. |
| MEDIUM-B | MEDIUM | Group 3 never enumerates its own environment prerequisites (station/Lemonade gateway, the two frozen-suite task roots, `prime-inference` credential). | Add an explicit environment-prerequisites list to Group 3's scope rationale. |

**Reviewer conclusion:** loop-0 fixes well executed and stronger than asked (falsifiable contract-test AC, decided pooling constants); the two remaining HIGHs are confined to Group 3 + Decision 7 and share one edit: an explore-derived gate-only agent with provider-prefixed `google/gemini-2.5-flash` plus a resolved-model pre-flight assertion.

### Plan re-review (fix loop 2, final) — 2026-08-14T19:12Z — verdict: SHIP

- **Context:** final plan re-review by the same independent reviewer; read-only. Zero CRITICAL, zero HIGH.
- **Closure check:** HIGH-A CLOSED (scored workload reverted to the `explore` recipe via the gate-only directory, SYSTEM.md byte-identical; demo agents demoted to contract/abort/concurrency duty; absent task roots handled as prerequisite 3 with the recorded-decision re-pointing rule grounded in `docs/parity-explore.md:63`). HIGH-B CLOSED strongly (provider-prefixed pin demonstrably honored by `parseModelRef` at `src/config.ts:265-271`; pre-flight asserts the **resolved** model per leg from real output — legacy footer `provider/model` at `src/mcp/server.ts:560`, prime `--model` argv — abort-on-mismatch before any scored task). MEDIUM-A and MEDIUM-B CLOSED. **No regressions** across all loop-0/loop-1 closures.
- **Verified this round:** `agentRoots`/`RLMX_AGENTS_DIR` replace-semantics at `src/mcp/agents.ts:84` (hermeticity claim sound); `DEFAULT_MODEL` fallback at `src/config.ts:122-125`; explore fixture buildable with carried-over fields; `scripts/smoke-explore.mjs:198-205` already implements the exact fixture pattern (model-line-swap install) — in-repo precedent for Group 3.
- **Deviations accepted:** (a) pooled-RPC wall-clock limb requiring cold-start corroboration resolves a real contradiction with the serving-path confound, constants and anti-gaming clause intact; (b) Files-section fixture entry is bookkeeping with a useful clarifying note.
- **Checklist:** all eight plan-review criteria PASS.

**Non-blocking gaps carried into execution:**

| # | Severity | Gap | Fix |
|---|----------|-----|-----|
| MEDIUM-1 | MEDIUM | Scored legacy leg's credential missing from Group 3 prerequisites (`google/gemini-2.5-flash` direct needs `GEMINI_API_KEY` — `src/settings.ts:34`, `src/cli.ts:856`). | Add `GEMINI_API_KEY` as a fifth prerequisite when Group 3 is set up. |
| MEDIUM-2 | MEDIUM | Group 2 D1's bare-model mapping line (loop-1 leftover) contradicts Decision 7(c); a bare `model:` under `backend: prime` would silently diverge across backends and the contract test compares footer field set, not model value. | Treat a bare unprefixed `model:` as an unsupported spec field under `backend: prime` — fail loudly per D4's existing rule. Apply during Group 2 implementation. |
| LOW-1 | LOW | Prerequisite 1's justification omits `smoke-explore.mjs`'s own gating station leg. | Optional wording fix. |
| LOW-2 | LOW | `google/gemini-2.5-flash` reachability through pi-ai 0.80.10 unverified (node_modules absent; no shipped agent ever exercised a prefixed gemini id). | Confirm at gate setup; the pre-flight catches a failure loudly. |

**Reviewer conclusion:** SHIP. HIGH-B enforced at the only level that can fail when it should (asserting what each leg actually resolved); every citation added in loop 2 verifies exact; both deviations are improvements. Implementer pointer: follow `scripts/smoke-explore.mjs`'s existing model-line-swap pattern for the gate fixture.

---

## Files to Create/Modify

```
src/mcp/backend.ts                      (new — RuntimeBackend interface + result types)
src/mcp/backends/legacy.ts              (new — LegacyRlmxBackend wrapping rlmLoop)
src/mcp/backends/prime.ts               (new — PrimeBackend subprocess adapter)
src/mcp/server.ts                       (modify — runTurn delegates to selected backend)
src/sdk/agent-spec.ts                   (modify — internal backend: rlmx|prime field)
tests/backend-contract.test.ts          (new)
tests/prime-backend.test.ts             (new — stub-binary behavior tests)
.genie/wishes/rlmx-v2-prime-backend/gate-agents/explore/agent.yaml   (new — Group 3 gate-only copy; model: deepseek/deepseek-v4-flash)
.genie/wishes/rlmx-v2-prime-backend/gate-agents/explore/SYSTEM.md    (new — verbatim copy of examples/agents/explore/SYSTEM.md)
.genie/wishes/rlmx-v2-prime-backend/gate-report.md  (new — Group 3 output)
```
Group 3's `gate-agents/` directory is a measurement fixture, not a shipped agent: it is reached only by pointing `RLMX_AGENTS_DIR` at it for the gate run, and nothing in `examples/agents/` is modified.


---

## Execution Reviews (appended by orchestrator, post-work)

### Execution review — Group 1 (RuntimeBackend seam + legacy wrap) — 2026-08-16 — verdict: SHIP
Independent reviewer subagent (≠ engineer), read-only. All 4 ACs evidenced: zero MCP-observable diff (schema/tool-registration hunks absent; 56/56 mcp-agents assertions unmodified), contract test has teeth (deliberate diverging backend → 9 pass/5 fail; per-dimension corruption tests), legacy busy/orphan/abort/stderr semantics preserved (agents.ts diff empty, isFailedRun logic identical, maxIterations/timeout forwarding verbatim), zero prime-specific types in the seam. Validations re-run: check ✓, 70/70 targeted ✓, smoke --no-live ✓. Two LOW advisories (backend-registry prototype key; no-op emitter) — first closed in G2 (Map registry), second awareness-only. Task done.

### Execution review — Group 2 (PrimeBackend subprocess adapter) — 2026-08-16 — verdict: FIX-FIRST → fix → SHIP
Round 1 (FIX-FIRST): one HIGH — context files passed as plain argv paths (prime runs each path as its own autonomous turn; verified live against the pinned binary's parser; `@`-prefix required). All 5 ACs otherwise green: contract test drives prime through the real runTurn pipeline (5 scenarios host-identical), base-prompt survival (argv + live probe: base RLM prompt first line quoted + appended ROLE_MARKER), process-TREE kills (shim + grandchild asserted dead; ceiling→isError false, deadline→TIMEOUT_ANSWER→isError true), version pin 0.7.2 fail-fast, no SDK/daemon (imports + package.json test-asserted). MEDIUM-1 (turn-cap budgetHit note) carried into the gate report. Fix loop 1 (commit db5c261): `@<abs path>` context args + spawn-time existence pre-check + test/contract updates (+2 tests). Re-review: SHIP — HIGH closed, hunk-by-hunk regression check clean, 107/107, full suite 599/599, dist byte-consistent. Task done.

### Execution review — Group 3 (two-backend parity gate) — 2026-08-16 — verdict: FIX-FIRST → fix → SHIP
Round 1 (FIX-FIRST): gate verdict FAIL adjudicated legitimate (legacy 1/6 generous / 0/6 strict, prime 0/6, bar ≥5/6, prime < legacy on the identical model; fallback written down). One HIGH — measurement rows 5–8/11 for legacy tasks 1/3/4 quoted the contaminated second-pass records (undisclosed, not re-derivable from committed commands). MEDIUMs: D9 unrecorded + D8 wording contradiction; prime contaminated records claimed-preserved but absent at HEAD. Fix loop 1 (commit 61bff13): rows re-derived from final scored records (legacy totals $0.0995, 336,974/120,718, P50 82.2s, cold median 75ms; `summarize.mjs runs` reproduces every cell), D9 recorded (scoring root + task-1 inline-FAIL→final-PASS re-score), prime contaminated records restored byte-identical from git history. Re-review: SHIP — 65/65 programmatic comparisons, setup section byte-preserved, no collateral, all validations green. Task done.

### Final gate (whole-wish) — 2026-08-16 — verdict: SHIP
`final-gate` reviewer, read-only, whole diff `main...HEAD` (15 commits, 87 files, +15,106/−151, all on-scope). All 7 wish-level success criteria evidenced; QA criteria evidenced by the diff (literal Claude Code host invocation remains dev-side post-merge, as stated); known gate findings carried in the report, not hidden; recorded-decision discipline verified (Decision 7 amendment, D1–D5 pre-run byte-preserved, D6–D9 timestamped); hygiene clean (no secrets, dist consistent, genie.db* untracked). Validations re-run: check ✓, 107/107 ✓, full suite 599/599 ✓, smoke-mcp --no-live ✓, smoke-explore live ✓, verdict grep ✓. Non-blocking LOWs: pre-flight mismatch is procedural not a hard assert; gate-report status line reads "measurements pending" (byte-preserved region); genie.db* not gitignored (pre-existing).

### Outcome
Gate verdict: **FAIL** — prime does not pass the frozen parity suite (0/6; bar ≥5/6) on the gate model; the host-visible contract held identically across backends on every run. Fallback applied as written: legacy engine stays default, prime remains the second backend behind the internal `backend: prime` field, no deletion, Option A not pursued. Pooled-RPC not triggered (cold-start 942ms < 2s; wall-clock limb confounded). Gate evidence: `.genie/wishes/rlmx-v2-prime-backend/gate-report.md` (PASS/FAIL verdict + fallback + all measurements with commands).
