# Wish: rlmx explore offload — khal provider, live MCP refresh, explore microagent, parity gate

| Field | Value |
|-------|-------|
| **Status** | APPROVED |
| **Slug** | `rlmx-explore-offload` |
| **Date** | 2026-07-26 |
| **Author** | Genie (Claude, Fable 5) |
| **Appetite** | medium |
| **Branch** | `wish/rlmx-explore-offload` |
| **Repos touched** | automagik-dev/rlmx |
| **Design** | [DESIGN.md](../../brainstorms/rlmx-claude-plugin/DESIGN.md) |

## Summary

Wish A of the `rlmx-claude-plugin` program: make rlmx a real offload target
for Claude Code's explore-class work. Adds the `khal` LiteLLM provider (with
correct per-million cost mapping and fail-fast no-key behavior), makes the
MCP server's tool set live (list *and* call path, honest `list_changed`),
makes the tool surface **isomorphic to Claude Code's native Agent tool**
(`prompt` param, spawn-style descriptions, `session_id` + resume), adds
`rlmx mcp --dir`, ships the `explore` microagent, and proves the thesis
with a parity gate: ≥5 real tasks mined from this host's transcripts, scored
by a fixed rubric against native Explore. Wish B (plugin packaging, shootout,
`/microagent-create`) depends on this gate passing.

## Scope

### IN

- `khal` provider: OpenAI-compatible LiteLLM gateway `https://llm.khal.ai/v1`;
  key from `KHAL_API_KEY` (fallback `RLMX_KHAL_API_KEY`), env-only.
- Cost mapping from LiteLLM `/model/info`: per-token dollars **×1e6** into
  pi-ai's per-million `Model.cost`, fixture-tested (deepseek-v4-flash
  `1e-7`/token → `0.10` $/Mtok). `/model/info` outage → models resolve from
  `/v1/models` with cost 0 + one stderr warning.
- `ensureKhalModels` pre-resolution guard at both resolution sites
  (`src/llm.ts`, `src/sdk/rlm-driver.ts`): no key → throw
  `khal provider requires KHAL_API_KEY` before model lookup.
- MCP live refresh: re-scan `discoverAgents` on every `tools/list` and
  `tools/call`; rebuild the advertised list and `byToolName` from the same
  scan; emit `notifications/tools/list_changed` on set change; declare
  `tools.listChanged`.
- Agent-tool isomorphism (design D12): input param `prompt` with `query` as
  deprecated alias (both optional in schema, runtime demands exactly one —
  no `anyOf`); spawn-style tool descriptions; every result carries
  `session_id` in `structuredContent` (echoed in the footer); follow-up
  call with `session_id` continues the agent via **conversation replay**
  (bounded turn history folded into the query, the proven
  `src/acp/agent.ts:298` mechanism — fresh `rlmLoop`/REPL per call, REPL
  state deliberately not preserved); in-process TTL + size-cap session map
  (new code, unit-tested); expired/unknown `session_id` → clear error;
  concurrent same-session calls → "session busy" (serialize-and-reject);
  agent deleted mid-session → "Unknown tool" wins, orphan session evicted;
  agent modified mid-session → current spec wins.
- `rlmx mcp --dir <dir>` (reuses the existing `--dir` flag,
  `src/cli.ts:157`): chdir at startup so discovery, `loadConfig`, relative
  `context`, and the REPL cwd agree.
- Extended `scripts/smoke-mcp.mjs`: real workspace root via temp cwd (no
  `RLMX_AGENTS_DIR` override), create-then-list-then-call mid-session,
  `list_changed` observed, stale "tool count unchanged" assertion removed.
- `explore` microagent (`examples/agents/explore/` in-repo, installed to
  `<workspace>/.rlmx/agents/explore/` for dogfood): answers codebase
  questions with resolvable `file:line` citations, shape `loop` +
  `budget.max_iterations`.
- Task mining + parity harness: extract ≥5 real explore-class tasks from
  past-24h Claude Code transcripts, build per-task rubrics from native
  Explore's verified findings, score both arms, produce
  `docs/parity-explore.md` with per-task scores + premium-token accounting.
- Parity gate + failure branch: pass = ≥4 of 5 tasks, **≥80% for larger
  suites** (≥90% required facts, all citations resolve, zero fabrications);
  3 tuning rounds per model then tier
  escalation flash → mimo-v2.5 → kimi-code → claude-haiku; if haiku cannot
  pass, stop and report honestly — Wish B does not start.

### OUT

- Claude Code plugin packaging, offload-guidance skill, `/microagent-create`,
  khal model shootout, legacy-agent archival — all Wish B
  (`rlmx-microagent-plugin`).
- Aider polyglot benchmark — owned by `rlmx-proof`.
- fs-watcher-based discovery — re-scan-on-request suffices.
- LiteLLM management-API integration (virtual keys, team routing).
- npm publishing.
- Synthetic benchmark tasks — mined real tasks only (design D8).

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Cost conversion ×1e6 lives in the khal overlay parser, fixture-tested | LiteLLM prices $/token, pi-ai $/Mtok (`pi-ai/dist/models.js:384` divides by 1e6 at usage time); without it every run prints $0.0000 (design-review N1) |
| 2 | No-key guard throws at the `ensureKhalModels` hook, before `resolveModel` | Empty catalog would otherwise surface as misleading "unknown model" (N6); mirrors the proven `ensureStationModels` seam (`src/llm.ts:220`) |
| 3 | Live refresh rebuilds list + call lookup from one scan; emit on change | Listed-but-uncallable is the failure mode to design out (M3/M4); capability declared only because it is emitted |
| 4 | Reuse `--dir`, not a new `--cwd` flag | `dir` already in the shared parseArgs table (`src/cli.ts:157`); one directory-flag convention (N5) |
| 5 | **"Parity model" = whichever tier passed the gate** (P1). The D9 `khal/deepseek-v4-flash` dogfood default holds only if flash is what passed; Wish B's shootout fallback keys off the gate-passing tier, not off flash | The escalation ladder can land parity above flash; the term must be unambiguous for Wish B's comparison logic |
| 6 | Rubric applied identically to both arms; ground truth derived from native Explore's verified findings — a disclosed, deliberately conservative asymmetry (P3) | Native scores 100% by construction; the bias makes the gate harder for rlmx and cannot manufacture a false pass |
| 7 | Parity report includes premium-token accounting as *reported* data, never as the gate | The token win is near-automatic; quality is the discriminator (design M2) |
| 8 | khal key handled env-only; rotation recommended after wiring | Key transited chat (design D2) |
| 9 | MCP surface mirrors the native Agent tool (`prompt`, spawn-style descriptions, `session_id` resume via conversation replay — fresh REPL per call). Named divergences: same-tool resume (native continues via a separate tool), background mode OUT | User decision 2026-07-26 (design D12): delegation that pattern-matches the Agent tool gets used; a new idiom gets ignored. REPL persistence rejected — no `rlm.ts` seam, no observable benefit for explore follow-ups. MCP stays request/response — progress + heartbeat covers long calls |

## Dependencies

**depends-on:** none
**blocks:** rlmx-microagent-plugin

## Success Criteria

- [ ] A1: From a workspace containing `.rlmx/agents/explore/`, a Claude Code
  session lists `rlmx_explore` and a delegated question returns a correct
  answer whose `file:line` citations all resolve.
- [ ] A2: An agent directory created mid-session is listed **and callable**
  without reconnect; the server emits `notifications/tools/list_changed` on
  set change (extended smoke-mcp proves list + call + notification).
- [x] A3: `khal/<model>` resolves with the key present and shows real
  per-token cost in the MCP footer (sourced from `/model/info`, ×1e6);
  without the key, resolution fails fast naming `KHAL_API_KEY`. Station
  behavior unchanged. — Group 1 evidence: live MCP footer
  `khal/deepseek-v4-flash · 2,290 in / 33 out · $0.0002`, keyless and
  rejected-key calls both `isError` with the credential named, 472/472 tests
  green ([evidence-group-1.md](evidence-group-1.md)).
- [x] A4: Parity gate **executed** on the ≥5-task mined suite and
  `docs/parity-explore.md` committed with per-task rubric, scores,
  tuning/escalation history, and premium-token accounting (reported, not
  gated) — required regardless of outcome. — executed on all 6 mined tasks
  through the real MCP path, **16 rounds / 96 recorded task-runs** across the
  full escalation ladder (flash ×3 tuning, mimo ×3, kimi ×1, haiku ×3, plus a
  flash control and one discarded 300s-capped mimo attempt), $11.43 khal spend
  — plus 7 unreported re-runs ($0.81) and one post-gate re-check ($0.07), for
  **104 model invocations and $12.31 in total**; report at
  [docs/parity-explore.md](../../../docs/parity-explore.md) with both arms
  scored per task, every round logged with what changed and why, and token
  accounting stating its method
  ([evidence-group-4.md](evidence-group-4.md)). The first published totals
  (15 rounds / 90 runs / $11.00) omitted the discarded round and the re-runs;
  corrected in the audit pass recorded in
  [evidence-group-4.md §11](evidence-group-4.md).
- [ ] A4b: Parity gate **PASSED** — ≥4 of 5 tasks (≥80% for larger suites)
  pass the fixed rubric (≥90% required facts, all citations resolve, zero
  fabrications), passing tier named. If the gate failed, this box stays
  unchecked and Wish B does not start. — **stays unchecked: `Gate: FAIL`**
  ([docs/parity-explore.md](../../../docs/parity-explore.md), verdict line).
  0 of 6 tasks passed on every tier; the ladder reached `khal/claude-haiku` and
  stopped there per the design failure branch. No parity model exists
  (decision 5 defines it as the tier that passed). **Wish B
  (`rlmx-microagent-plugin`) does not start.**
  **Round 2 does not change this.** The pre-registered single shot of the
  round-2 recursive recipe (gen-1 `02184f35`, `khal/deepseek-v4-flash`, one run
  per frozen task) scored **0 of 6** — `Round-2 gate: FAIL`
  ([docs/parity-explore.md](../../../docs/parity-explore.md) → *Round 2 — the
  frozen-suite shot*; evidence in [evidence-group-4.md §12](evidence-group-4.md)).
  Criteria 2 and 3 were clean on all six (215/215 citations, 0 fabrications);
  criterion 1 reached at best 9 of the 10 needed on task 3 under the generous
  reading. This box flips only on a PASS, so it stays unchecked.
- [ ] A5: `rlmx mcp --dir <dir>` makes discovery, config, context, and REPL
  cwd agree on `<dir>` (test proves an agent + config in `<dir>` load while
  the process was spawned elsewhere).
- [ ] A6: tools accept `prompt` (and `query` alias; both/neither rejected
  naming `prompt`); results carry `session_id` in `structuredContent`; a
  second call with `session_id` continues the conversation via turn replay
  (live REPL state explicitly not promised); expired/unknown `session_id`
  and concurrent same-session calls return their specified errors.
- [ ] Full gate green: `npm run check`, `npm run build`, `npm test`,
  `node scripts/smoke-mcp.mjs`, `npm audit --omit=dev` with 0
  vulnerabilities.

## Execution Strategy

### Wave 1 (parallel — disjoint files)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 1 | engineer | 3 — cost/model mapping +2, multi-package sites +1 | engineer-standard / high | khal provider + cost ×1e6 + no-key guard + tests |
| 2 | engineer | 6 — stateful sessions +2, agent-lifecycle/routing +2, cost/escalation surface +2 | engineer-complex / high | MCP live refresh + Agent-tool isomorphism (prompt/session_id/resume) + `--dir` + extended smoke |

### Wave 2 (sequential — needs Wave 1 to run agents on khal)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 3 | engineer | 2 — prompt-skill change +1, no deterministic test +1 | engineer-standard / medium | explore microagent + mining harness + rubric format |

### Wave 3 (sequential — the gate)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 4 | engineer | 5 — subjective acceptance +2, cost/escalation +2, no deterministic test +1 | engineer-complex / high | parity loop execution, tuning/escalation, report + verdict |

## Execution Groups

### Group 1: khal provider

**Goal:** `khal/<model>` resolves everywhere station does, with real costs and
fail-fast no-key behavior.

**Deliverables:**
1. `src/khal-provider.ts`: provider id `khal`, base URL
   `https://llm.khal.ai/v1` (override `KHAL_BASE_URL`), auth from
   `KHAL_API_KEY`/`RLMX_KHAL_API_KEY`; dynamic catalog from `/model/info`
   (fallback `/v1/models`, cost 0 + stderr warning); cost fields ×1e6;
   memoized `ensureKhalModels(models)` overlay mirroring
   `ensureStationModels`, plus the no-key throw
   `khal provider requires KHAL_API_KEY`.
2. Registration + pre-resolution hook at both sites: `src/llm.ts` and
   `src/sdk/rlm-driver.ts` (same seam as station, `src/llm.ts:220`).
3. `tests/khal-provider.test.ts`: fixture `/model/info` payload → asserted
   `$/Mtok` (flash `1e-7` → `0.10`); no-key throw; `/model/info`-outage
   fallback; memoization reset seam.
4. CHANGELOG entry under `[Unreleased]` in a `### khal provider`
   sub-heading (Group 2 uses `### MCP`; whichever group lands second
   rebases its one-line anchor — the sub-headings prevent content
   conflicts, not anchor collisions).

**Acceptance Criteria:**
- [x] With key (**prerequisite: `KHAL_API_KEY` in env + reachable
  `llm.khal.ai` — present on this host; a keyless run failing here is an
  environment gap, not a code defect**): a real khal run completes and reports
  nonzero cost. **Corrected invocation** (rev 3): rlmx has no `-m`/`--model`
  flag — it is absent from the parseArgs table (`src/cli.ts:151-175`) and
  `strict: false` swallows it silently, so `rlmx -m khal/<model> "…"` runs the
  *configured* model with `khal/<model>` as the query — and the plain-text CLI
  prints no cost footer. Use either:
  `HOME=<tmp> rlmx --stats "…"` with
  `{"model.provider":"khal","model.model":"deepseek-v4-flash"}` in
  `<tmp>/.rlmx/settings.json` (cost in the `--stats` JSON on stderr, or in
  `--output json`), **or** the MCP `rlmx_query` tool with
  `model: "khal/deepseek-v4-flash"` (cost in the footer — A3's surface).
- [x] Without a usable key, resolution fails before lookup naming the
  credential: missing → exactly `khal provider requires KHAL_API_KEY`;
  present but rejected (401/403) → `khal gateway rejected <ENV_VAR> (HTTP
  401) …`. Neither degrades into "unknown model" (decision 2).
- [x] Fixture test pins the ×1e6 conversion; station tests untouched and green.

**Evidence:** [evidence-group-1.md](evidence-group-1.md) — every command above
run live, verbatim output, with the cost arithmetic checked against the
fixture rate.

**Validation:**
```bash
cd ~/prod/rlmx && npm run build && node --test dist/tests/khal-provider.test.js && node --test dist/tests/station-provider.test.js
```

**depends-on:** none

---

### Group 2: MCP live refresh, Agent-tool isomorphism, `--dir`

**Goal:** agents created mid-session are listed and callable without
reconnect; the tool surface behaves like the native Agent tool (prompt →
final report, session_id → resume); the server's cwd is an explicit
contract.

**Internal order (land as verifiable increments, one shared file):**
refresh + set-diff/emit → schema/isomorphism surface → session map →
`--dir` → smoke rewrite.

**Deliverables:**
1. `src/mcp/server.ts`: per-request re-scan (`tools/list` + `tools/call`)
   rebuilding the tool list and `byToolName` from one `discoverAgents` call;
   set-diff detection; `notifications/tools/list_changed` emission;
   `tools: { listChanged: true }` capability.
2. `src/mcp/server.ts` isomorphism: schema with `prompt` + deprecated
   `query` both optional, runtime exactly-one validation (error names
   `prompt`); spawn-style tool descriptions; `session_id` in
   `structuredContent` + footer; optional `session_id` input resuming via
   conversation replay (`buildConversationalQuery`-style bounded turn
   fold, fresh `rlmLoop`/REPL per call); in-process TTL + size-cap session
   map (LRU eviction); expired/unknown `session_id` → `isError`;
   concurrent same-session call → `isError` "session busy" (ACP
   serialize-and-reject rule, refined to per-`session_id`); deleted agent
   mid-session → "Unknown tool" wins + orphan eviction; modified agent →
   current spec wins. **A `session_id` is bound to the tool that created
   it** — presenting it to a different tool is an error (design-review P4).
   The generic `rlmx_query` tool participates fully in the isomorphism
   (`prompt` param, `session_id`, resume) and keeps its `model` override;
   its name refers to the tool, not the deprecated param (P5). Each tool
   declares a minimal `outputSchema` (`{session_id: string}`) so the
   `structuredContent` assertion rests on a stated contract (P7).
3. `src/cli.ts`: `rlmx mcp --dir <dir>` → validated `process.chdir` before
   `runMcp()`; HELP text updated.
4. `scripts/smoke-mcp.mjs` extended: temp-cwd workspace root (no
   `RLMX_AGENTS_DIR`), create-then-list-then-call mid-session, `list_changed`
   notification asserted, stale unchanged-count assertion removed, the
   "must require query" schema assertion (`smoke-mcp.mjs:95-99`) replaced
   with the new shape (prompt accepted, query accepted, both/neither
   rejected), plus a resume round-trip (call → `session_id` → follow-up)
   and unknown-session + session-busy error cases.
5. `tests/mcp-agents.test.ts` additions for the re-scan/diff helper and the
   session-map TTL/eviction seam.
6. CHANGELOG entries under `[Unreleased]` in a `### MCP` sub-heading —
   distinct from Group 1's `### khal provider` sub-heading, so parallel
   Wave 1 edits the same file without conflicting hunks.

**Acceptance Criteria:**
- [ ] smoke-mcp: agent dir created after connect → appears in next
  `tools/list`, call succeeds, `list_changed` observed once per set change.
- [ ] smoke-mcp: resume round-trip works (follow-up references prior
  answer's context); unknown `session_id`, session-busy, and cross-tool
  `session_id` reuse each return `isError` and the server survives.
- [ ] `--dir` case: process spawned in `/tmp`, `--dir` pointing at a fixture
  workspace → fixture agent + config load (A5).
- [ ] Existing MCP behavior unchanged for a static agent set (no spurious
  notifications); `query` alias still accepted.

**Validation:**
```bash
cd ~/prod/rlmx && npm run build && node scripts/smoke-mcp.mjs && node --test dist/tests/mcp-agents.test.js
```

**depends-on:** none

---

### Group 3: explore microagent + mining harness

**Goal:** the `explore` agent exists as the workspace-convention reference,
and ≥5 real mined tasks with rubrics are ready for the gate.

**Deliverables:**
1. `examples/agents/explore/{agent.yaml,SYSTEM.md}`: shape `loop`,
   `budget.max_iterations`, model `khal/deepseek-v4-flash` default,
   citation contract in the system prompt (answer + `file:line` list, never
   raw dumps; say "not found" over guessing). Layout note (plan-02 M4):
   `examples/agents/` is deliberately the new canonical agent-recipe
   subtree — design B5 already targets it for the archived recipes; the
   existing flat `examples/<name>/` entries migrate there in Wish B, so
   the split is transitional, not permanent.
2. Dogfood install: copy into `~/workspace/.rlmx/agents/explore/` (workspace
   convention, shadows global).
3. `scripts/mine-explore-tasks.mjs`: scan past-24h `~/.claude/projects`
   transcripts for explore-class work (Explore spawns, grep/read-heavy
   sequences with a stated question); emit
   `.genie/wishes/rlmx-explore-offload/tasks/<n>.md` — question, repo/cwd,
   native answer trace, required-facts checklist (verified against the repo,
   per design D6/P3), rubric.
4. Docs: `.rlmx/agents/` convention + `.agents/` alias note in README's MCP
   section (brief — full docs land in Wish B).
5. `scripts/smoke-explore.mjs`: MCP client drives `dist/src/cli.js mcp
   --dir <the rlmx checkout itself>` with `.rlmx/agents/explore/` copied
   there from `examples/agents/explore/` (so `--dir`, the agent, the
   question subject, and the citation-resolution root are all the same
   tree), asks a fixed question about the rlmx repo via `rlmx_explore`,
   asserts ≥1 citation resolves to a real `file:line` against that root.
   Model from `RLMX_SMOKE_MODEL`, defaulting to a `station/` model so the
   script stays runnable keyless (repo smoke convention,
   `scripts/smoke-mcp.mjs:18-19`); the khal arm runs when `KHAL_API_KEY`
   is present. Validates the real agent through the real path, unlike
   smoke-mcp's synthetic fixture. (The `~/workspace` install in D2 is for
   interactive dogfood, not this script.)

**Acceptance Criteria:**
- [x] `rlmx_explore` visible and callable from a Claude Code session in
  `~/workspace` (A1 precondition). — listed among 5 tools and answered a
  question about `~/workspace/.rlmx/agents/explore/agent.yaml` with a resolving
  citation ([evidence-group-3.md](evidence-group-3.md)).
- [x] ≥5 task files exist, each with a repo-verified required-facts checklist
  and rubric; no synthetic tasks. — 6 tasks, 60 facts (43 `exact`, 17
  `re-anchored`, nothing weaker), every one a `path:line` claim the native
  answer made about that task's own root, emitted only when a term the claim
  *itself supplies* — an identifier it names or a fragment it quotes — is still
  in that file and is specific enough to point at a line; the term is printed
  beside the quoted evidence, so each fact is auditable rather than asserted.
  Drawn from 4 sessions across 2 repos under per-session/per-repo caps. Review
  commissions are rejected (WISH.md:66), and a task is not written unless the
  native arm passes its own criteria 2 and 3, so decision 6 is checked rather
  than assumed.
- [x] Explore agent answers a smoke question about the rlmx repo with ≥1
  resolvable citation. — station (gating) and khal (reported) arms both answered
  with grounded citations. The gate rests on **prompt-independence**: a citation
  must resolve, be grounded, and carry an anchor and identifier absent from
  `SYSTEM.md`, `agent.yaml`, and the question — proven to bite by re-introducing
  the historical leak for one run, which failed the gating arm at 3 iterations
  with resolution and grounding both green. The iteration floor is kept as a
  floor and described as one: a model that never emits `FINAL` saturates at
  `max_iterations`, so it cannot fail that check.

**Evidence:** [evidence-group-3.md](evidence-group-3.md) — every command above
run live, verbatim output, with four facts spot-checked against the trees they
were mined from.

**Validation:**
```bash
cd ~/prod/rlmx && npm run build && test "$(ls .genie/wishes/rlmx-explore-offload/tasks/*.md 2>/dev/null | wc -l)" -ge 5 && node scripts/smoke-explore.mjs
```

**depends-on:** Group 1, Group 2

---

### Group 4: parity loop + report

**Goal:** run the gate honestly and record the verdict.

**Deliverables:**
1. Parity runs: each task through `rlmx_explore` (MCP path) and scored
   against its rubric; native side scored from the mined trace.
2. Tuning/escalation per design failure branch: ≤3 prompt/budget rounds per
   model, then flash → mimo-v2.5 → kimi-code → claude-haiku; every round
   logged.
3. `docs/parity-explore.md`: per-task scores both arms, tuning history,
   final parity model (= the tier that passed, decision 5), premium-token
   accounting (method: native = Explore subagent transcript
   input+cacheRead+output; rlmx = main-session call delta, result bytes ÷ 4),
   gate verdict.
4. Frozen suite handoff note for Wish B (regression + shootout input).

**Acceptance Criteria:**
- [x] Gate outcome recorded: PASS (≥4 of 5; ≥80% for larger suites) with
  the passing tier named, or FAIL with the honest report and Wish B
  explicitly not started. — **`Gate: FAIL`** recorded on one line
  ([docs/parity-explore.md](../../../docs/parity-explore.md)); 6-task suite
  needed ≥5 passes and got 0, on every tier of the ladder. Wish B explicitly
  not started, and the falsification is scoped rather than overclaimed (three
  untried experiments named in the verdict section). The suite was not
  softened: no task dropped, no threshold moved, no fact reinterpreted; the two
  scoring conventions that were added were forced by the **native** arm and
  apply to both ([evidence-group-4.md §2](evidence-group-4.md)).
- [x] Every claim in the report traceable to a logged run (model, tokens,
  wall-time, cost per attempt). — **failed on first publication, re-established
  by audit.** Seven matrix rows mixed columns from two different runs (a re-run
  had silently overwritten a scored run JSON), so those rows described no single
  actual run. Every run JSON on disk has been re-scored, the matrix regenerated
  from matched pairs, the discarded round un-hidden, and the overwrite made
  impossible (`run-task.mjs` now refuses to replace an existing run record). All
  97 recorded task-runs are in one matrix with model, iterations, wall-time,
  khal cost and per-criterion verdict ([evidence-group-4.md §3](evidence-group-4.md));
  each run's returned text, footer, progress and per-citation verdict persisted
  under `.genie/wishes/rlmx-explore-offload/parity/runs/<round>/`. The 7
  overwritten runs are **not** recoverable — their surviving score JSONs are
  kept as `task-N.score.orphaned.json` and the loss is stated rather than
  papered over ([evidence-group-4.md §11](evidence-group-4.md)).
- [x] A4's token accounting present for every task, labeled reported-not-gated.
  — per-task native vs rlmx premium tokens with the method stated (native =
  input+cacheRead+cacheCreate+output of the recorded Explore segment; rlmx =
  host-session call delta, request + result chars ÷ 4), 366×–2,110× per task and
  921× overall, headed "reported, never gated" per decision 7
  ([docs/parity-explore.md](../../../docs/parity-explore.md), token section).

**Evidence:** [evidence-group-4.md](evidence-group-4.md) — ground truth
re-verified before scoring, the 97-run matrix, criterion 1 judged fact by fact
on every run whose upper bound reaches its threshold under **either** reading of
the bound (no run reaches it on the strict reading; 8 do on the basename
reading, and all 8 were judged), verbatim returned text for the decisive rounds,
the validation command with its output, and §11's audit log of what the first
publication got wrong.

**Validation:**
```bash
cd ~/prod/rlmx && test -f docs/parity-explore.md && grep -qE 'Gate: (PASS|FAIL)' docs/parity-explore.md
```

Run verbatim; exit `0` (`grep -q` is silent on success), matching
`docs/parity-explore.md:572` → `Gate: FAIL`
([evidence-group-4.md §7](evidence-group-4.md)).

**depends-on:** Group 3

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] Functional: in a fresh Claude Code session in a workspace with
  `.rlmx/agents/explore/`, ask a repo question via `rlmx_explore` → correct
  cited answer; footer shows model + nonzero khal cost.
- [ ] Integration: create a new agent dir mid-session → tool appears and is
  callable without `/mcp` reconnect.
- [ ] Integration: ask `rlmx_explore` a question, then a follow-up via
  `session_id` that only makes sense with the first answer in context →
  coherent continuation (A6).
- [ ] Regression: station models still resolve; `rlmx mcp` without `--dir`
  behaves exactly as before for the three-root discovery; 435+ existing
  tests green; `npm audit --omit=dev` = 0.
- [ ] Negative: unset `KHAL_API_KEY` → khal delegation fails with the named
  message, server survives (error isolation).

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Cheap model can't reach parity even at haiku tier | Medium | Design failure branch: stop, report honestly, Wish B blocked — falsified beats shipped-anyway |
| Mined tasks under-represent explore-class variety (quiet 24h window) | Medium | Widen mining window to 7 days if <5 significant tasks found in 24h; keep "real tasks only" invariant |
| `/model/info` payload shape drifts (LiteLLM-internal) | Low | Tolerant parser (missing fields → cost 0 + warning) + fixture test |
| Per-request re-scan races a concurrent create (partial agent dir) | Low | `loadOne` already skips invalid/incomplete agent.yaml; a later request picks it up |
| khal key security (transited chat) | Medium | Env-only; rotation recommended once wired; never in repo files |
| Host cwd behavior differs off Claude Code | Low | Verified on Claude Code 2.1.220 (probe artifact in brainstorm dir); `--dir` is the contract elsewhere |
| Session map grows unbounded / holds stale REPL state | Low | TTL + size cap with LRU eviction; eviction seam unit-tested; sessions are advisory (loss = fresh start with clear error, never corruption) |

---

## Review Results

_The read-only reviewer returns evidence; the invoking orchestrator appends a timestamped block here after plan, execution, and PR reviews._

### Plan review — SHIP (2026-07-26)

- **Round 1:** FIX-FIRST — genie:reviewer/plan-01, 2026-07-26T18:45:18Z.
  2 MAJOR (W1 broken Group 1 validation command — phantom `npm run
  typecheck`, no build before `dist/` tests; W2 parity bar flattened —
  "≥80% for larger suites" dropped) + 5 MINOR (W3 `sessionId` casing
  regressions, W4 CHANGELOG ownership, W5 Group 3 validation didn't test
  its own ACs, W6 A4 checkable on falsified thesis, W7 Group 2 internal
  order). All fixed in plan rev 2.
- **Round 2:** **SHIP** — genie:reviewer/plan-02, 2026-07-26T18:49:01Z.
  All 7 verified against the repo. 4 MINOR follow-ups (M1 CHANGELOG anchor
  collision, M2 keyed-validation prerequisite vs credential-free smoke
  convention, M3 smoke-explore cwd/agent/question triangle, M4
  `examples/agents/` layout) — all four folded into the group specs before
  dispatch (M1: second-lander rebases anchor; M2: prerequisite stated +
  `RLMX_SMOKE_MODEL` station fallback; M3: `--dir` pinned to the rlmx
  checkout; M4: `examples/agents/` declared canonical, flat entries
  migrate in Wish B).
- Design basis: `rlmx-claude-plugin` DESIGN.md rev 5, SHIP
  genie:reviewer/rcp-05, digest
  `94b73f45d8791ea55f9206a194011d2eed16a96e9a86981f9c43adeb43dae3c2`,
  verified at wish pre-flight.

---

## Round-2 prep — what the training suite can and cannot measure

The parity gate FAILed honestly (`docs/parity-explore.md`, Gate: FAIL) and the
user overrode the stop: round 2 continues with the levers round 1 never used.
The frozen six (`tasks/{1..6}.md`), the rubric and the scoring conventions are
**unchanged and eval-only**. Round 2 adds a separate *training* suite,
`parity/round2/train-tasks/`, for prompt optimization.

**A4b is still the gate, and only the frozen suite can settle it.** The training
suite is not a second gate and is not comparable to the first. Recorded here so
that a round-2 summary cannot quietly promote it:

| Measurement | Frozen eval suite | `round2/train-tasks/` |
|---|---|---|
| rlmx-arm criterion 1 (fact coverage) | yes | **yes — the only signal it has** |
| rlmx-arm criteria 2, 3 | yes | **yes** |
| Native arm under the same rubric | yes | **no** |
| D6/P3 conservative asymmetry | yes | **no** |
| Premium-token reduction | yes | **no** |

All 8 training tasks are **authored**, not mined, so none carries a native
session answer: `score-task.mjs --native` has nothing to read, and there is no
native token accounting to divide by. The reason is measured, not assumed — with
the eval suite's four sittings excluded by session, this host's entire
751-transcript corpus yields **zero** further explore-class candidates at every
window from 24h to 720h (`train-tasks/train-mining-run.json`, `written: 0`).

Two further constraints on how the suite may be used:

- **The optimizer's fitness set is 6 of the 8 tasks** (`3.md`…`8.md`, 34 facts,
  3 roots). `1.md` and `2.md` are authored about this repository — the same tree
  and sitting the round-2 prompt was written in, `1.md` on the identical line
  set `parity/round2/recursion-recon.md` is built from — so selecting on them
  would tune a prompt against ground truth its own investigation produced. They
  are held out as diagnostics, machine-readably
  (`authored-run.json` → `fitnessSet`, and a row in each task file's header).
- **Disjointness from the frozen six is by session and by subject.** The miner
  runs at its default `--disjoint-by session+subject`, excluding all four eval
  sittings outright; the authored tasks are all in roots no eval task uses. An
  earlier cut of this suite relaxed the miner to `--disjoint-by subject` and
  admitted one task from a sitting two eval tasks came from — that amended the
  acceptance criterion rather than meeting it, and has been reverted.
  `train-tasks/README.md` records the episode.

---

## Files to Create/Modify

```
src/khal-provider.ts                      (new)
src/llm.ts                                (register + ensureKhalModels hook)
src/sdk/rlm-driver.ts                     (register + ensureKhalModels hook)
src/mcp/server.ts                         (live refresh, list_changed, lookup rebuild)
src/cli.ts                                (mcp --dir, HELP)
scripts/smoke-mcp.mjs                     (workspace root, create-then-list-then-call, notification)
scripts/mine-explore-tasks.mjs            (new)
scripts/smoke-explore.mjs                 (new)
tests/khal-provider.test.ts               (new)
tests/mcp-agents.test.ts                  (re-scan/diff additions)
examples/agents/explore/agent.yaml        (new)
examples/agents/explore/SYSTEM.md         (new)
docs/parity-explore.md                    (new, Group 4 output)
.genie/wishes/rlmx-explore-offload/tasks/ (mined task files)
README.md                                 (brief .rlmx/agents convention note)
CHANGELOG.md                              ([Unreleased] entries)
```
