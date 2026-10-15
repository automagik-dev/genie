# Design: selectable Mikro engines, production-shaped evidence, and Genie subtree

| Field | Value |
|-------|-------|
| **Slug** | `mikro-engine-split` |
| **Date** | 2026-10-04 |
| **WRS** | 100/100 |
| **Size** | G · coordinated groups: subtree/toolchain, RLM reliability, Pi adapter, Genie evaluation, Juice/extraction, integrated experiments (owner selected end-to-end delivery and added Juice/JEV scope) |

## Problem

Every Genie offload pays for the RLM protocol even on bounded tasks, while production failure classes are concealed by HEAD-only fixtures and outer retries. Deliver selectable protocol-free Pi and RLM engines without changing host/accounting contracts; choose routing using verified success, not a speed-only result.

## Scope

### IN

| # | Deliverable | Files changed | Source |
|---|-------------|---------------|--------|
| 1 | Preserve Mikro history in Genie under `mikro/`, independent npm lock/build/tests/CI, unchanged eight-member Genie payload | Imported Mikro tree (new in Genie), Genie `.github/workflows/mikro-ci.yml` (new), root gate isolation configuration where needed | `.genie/brainstorms/mikro-engine-split/HANDOFF.md` |
| 2 | Upgrade the Pi release family together to exact 1.0.2; preserve configured providers, caller sampling/caching and credentials | `package.json`, `package-lock.json`, `src/llm.ts`, `src/custom-providers.ts`, `src/sdk/rlm-driver.ts`, corresponding compiled files | `package.json`, `src/llm.ts` |
| 3 | Truthful provider error/length handling; transport retries; safe FINAL variable parsing; recover block timeouts; bounded validated final turn | `src/llm.ts`, `src/parser.ts`, `src/repl.ts`, `src/rlm.ts`, existing owning tests, compiled artifacts | `.genie/brainstorms/mikro-engine-split/evidence/mikro-diag/FINDINGS.txt` |
| 4 | Documented `engine: rlm|pi|prime|prime-sdk`, default RLM, strict per-call override, complete old `backend` caller migration | `src/sdk/agent-spec.ts`, `src/mcp/server.ts`, `src/mcp/backend.ts`, existing SDK callers/tests/packs, `docs/agent-yaml-schema.md`, `README.md` | `src/sdk/agent-spec.ts`, `src/mcp/server.ts` |
| 5 | Headless Pi SDK backend with explicit scoped read/grep/glob/git and schema final tool; no REPL, ambient resource discovery, shell, mutation, or extra LLM instrumentation | `src/mcp/backends/pi.ts` (new), bounded read-only tool module (new), owning behavior/contract tests (new or extended), compiled artifacts | `src/mcp/backend.ts`, `src/mcp/backends/prime-sdk.ts` |
| 6 | Genie proposal-only NEW verification and parent-tree fixtures, strict per-call engine forwarding and wish variants | Genie `scripts/mikro/call.ts`, `fixtures-from-commits.ts`, `score.ts`, `bench.ts`, `bench-options.ts`, schemas/tests, `.mikro/agents/*`, `.claude/workflows/wish.js` and owning behavior tests | `.genie/brainstorms/mikro-engine-split/HANDOFF.md` |
| 7 | Frozen Genie AND brain existing/new-file cases; three reps per fixture/arm with Flash control, reproducible artifacts and truthful unknowns; separately scored available curated candidates; no Pro/Claude calls | Genie `scripts/mikro/engine-experiment.ts` (new), `.genie/wishes/mikro-engine-split/experiments/manifest.json` (new), benchmark evidence and normal caller ledgers | `.genie/brainstorms/mikro-engine-split/evidence/INTEGRATION-RESEARCH.md` |
| 8 | Real small-objective wish runs: offload-rlm/offload-pi/offload-off; compare SHIP, repairs, observed stage tokens and priced offloads without Claude model calls | Isolated native workflow run artifacts, existing `wish report --append --variant` ledger where backed by actual records; selection report (new) | `.genie/brainstorms/mikro-engine-split/HANDOFF.md`; owner excludes Claude |
| 9 | Independent reviews, actual MCP/CLI/live-model proof, aggregate gates, merge-ready PR to Genie dev; preserve user WIP and main | `.genie/wishes/mikro-engine-split/WISH.md` (new), `README.md`, `CHANGELOG.md`, generated distribution and delivery evidence | `.genie/brainstorms/mikro-engine-split/HANDOFF.md` |
| 10 | Explicit Juice gateway, private project API keys and filtered usage; separate manually triggered Keeper/JEV extraction without instrumentation model calls | Mikro `src/juice.ts` (new), `src/jev.ts` (new), `src/cli.ts`, `src/config.ts`, owning behavior tests and `docs/juice.md` (new) | `.genie/brainstorms/mikro-engine-split/evidence/INTEGRATION-RESEARCH.md` |

### OUT

- Automatic engine/model routing, scheduling, automatic main promotion, or a performance-win claim without verified-success parity. Explicit opt-in is delivered irrespective of which arm wins. (Source: `.genie/brainstorms/mikro-engine-split/HANDOFF.md`.)
- Prime re-pin/benchmark: optional third arm, excluded from scored minimum because installed 0.9.5 differs from the current 0.8.1 pin. Keep existing experimental Prime behavior and explicit errors; do not silently substitute it. (Source: `.genie/brainstorms/mikro-engine-split/HANDOFF.md`.)
- Capture/export/wish-report accounting redesign; installation from dirty Mikro checkout; modification or commit of unrelated installer WIP; brain production runtime changes. (Source: `.genie/brainstorms/mikro-engine-split/HANDOFF.md`.)
- No Claude or DeepSeek Pro model calls; no automatic model-based instrumentation, unattended extraction, external secret disclosure, or mutation of unrelated project keys. (Source: `.genie/brainstorms/mikro-engine-split/evidence/INTEGRATION-RESEARCH.md`.)

## Approach

### History and ownership

Use an isolated Orca Genie worktree from dev. Import clean committed Mikro `62894e49314bad07382492ac074ea96df6776f61` non-squashed under `mikro/`, preserving the full source parent graph and exact imported tree. No original checkout HEAD/index/WIP moves. The host lacks `git subtree`; use equivalent `merge -s ours --no-commit --allow-unrelated-histories` plus `read-tree --prefix=mikro/ -u`, with subtree-dir/split trailers on the two-parent import commit. Verify source SHA ancestry and imported tree equality before edits. No source-repository deletion.

Mikro retains npm/package-lock authority, Node >=22.19.0, tracked compiled distribution, independent build and node:test suite. Genie keeps Bun/bun.lock and existing release staging. Root tooling must not lint/build/run Mikro as Genie code: exclude only the independently gated subtree where a tool's discovery would cross package boundaries; verify the original root test set remains covered. Add a path-scoped Mikro CI workflow and run both complete aggregate gates locally after integration. Do not add Mikro to the Genie executable dependency graph or tarball staging; verify the frozen payload contract through existing executable release checks.

### Selector and host contract

Public `AgentSpec.engine?: 'rlm'|'pi'|'prime'|'prime-sdk'`. Remove the undocumented `backend` YAML field, migrate all active callers/packs/tests (`mikro` value becomes `rlm`), and reject obsolete `backend` rather than preserving an alias. Experimental Prime engines keep their existing pin/runtime constraints. MCP input schemas accept optional `engine`, including generic `mikro_query`; precedence is explicit call engine > agent engine > rlm. Non-string, empty or unknown selectors fail before billable work. Per-call selection must validate the effective engine's model/tool compatibility rather than inheriting an unrelated discovery-time degradation. No engine is selected by `shape`.

Keep `RuntimeBackend.run(agent, request, emit)` and `MicroagentResult` small. MCP keeps `structuredContent {answer, session_id}`, mirrored text including the priced footer, footer field names/meaning, progress heartbeat, and existing failure classification: new terminal engine failures use the existing thrown-error path, not arbitrary `Error:` prefix checks or a falsely successful partial answer. Existing session history folds into each prompt; Pi's internal session is in-memory per offload, not a second persistence system.

Genie adds a validated `--engine` option to call/bench, forwards it as MCP tools/call arguments, and tags the effective selected engine without changing ledger field meanings. Explicit workflow `offloadEngine` selects Pi/RLM for BOTH scout and review commands; default omitted remains RLM. Offload-off skips both and uses normal native stages. Preserve trace/stage tags and trusted origin/base agent resolution. `wish report --variant` remains the authoritative experiment label.

### Pi adapter

Pin coding-agent/pi-ai (and any directly imported agent-core) to the same 1.0.2 family; inspect shipped APIs and compile against repository-local dependencies, never absolute installed SDK imports. One SDK `session.prompt` is one plain agent run with potentially multiple tool/model turns, not literally one provider completion. Explicit in-memory ModelRuntime credentials/catalog, SettingsManager and SessionManager; minimal ResourceLoader returns only Mikro's protocol-free prompt and empty extensions/skills/context resources. Compaction/cache-warming and agent-level retries OFF; provider retries bounded to 3. No ambient model/auth/settings/packages or project instruction discovery.

Allow only custom `read`, `grep`, `glob`, `git` and `emit_done`. Resolve every read target with realpath and symlink-aware containment in request cwd plus explicitly supplied context root; enforce declared narrower read scopes. Text-only bounded read/search outputs; omit secrets/.git internals and node_modules according to current repository context policy. `git` is a closed set of read-only operations over the selected repository (status/log/show/diff/ls-files), argument arrays with fixed flags, no arbitrary command strings, aliases/hooks/network/config mutation. Do not load arbitrary declared plugins on the read-only Pi engine; incompatible declared tools fail visibly before billing, never silently disappear. Plain tool absence is not a sandbox guarantee; existing Genie bwrap remains the stronger optional boundary.

Final-tool schema is `config.output.schema` when supplied, otherwise pack `VALIDATE.md` schema, otherwise `{answer:string}`. If both schemas exist, enforce both through the existing validator; do not silently discard VALIDATE-only packs. Validate schema compatibility at setup. Reject malformed/truncated/missing final calls; tool validation feedback uses remaining normal turns. Accepted final payload is serialized as one fenced JSON block for schema-bearing runs (Genie consumes text JSON), or unwrapped answer for schema-free runs. First successful final emission wins deterministically; later final calls are errors/no replacement. Public `shouldStopAfterTurn` stops after accepted final, including mixed read/final batches; no abort-from-final race or hidden extra completion.

Subscribe to actual assistant/tool events for progress, cumulative usage, iterations and limits; preserve raw provider input/output convention and totalCost. Wrap the SDK's public stream function only to carry caller sampling/output/cache controls; keep its original auth/provider/retry closure. Abort/dispose on deadline, always unsubscribe/clear timers. Turn/cost/token limits are post-response limits with documented one-response overshoot, not prebilling guarantees. No final emission means failure, not a copied last assistant paragraph.

### RLM reliability

Provider completion checks `stopReason:error|aborted|length` before an empty-text diagnosis. Error reports include provider errorMessage, not credentials/request bodies. Error/abort never become a successful final answer; length is not silently accepted as complete structured output. Transport maxRetries defaults to 3 while explicit zero remains zero; forward to root/forced-final calls and appropriate existing subcall paths. Preserve reported usage for responses that contain it; missing billed usage stays an evidence gap.

Only a bare valid Python identifier in out-of-block `FINAL(identifier)` is a variable signal; quoted literals retain literal meaning, fenced execution stays Python, arbitrary expressions are not evaluated. `FINAL(...)` yields repair feedback rather than literal ellipsis. Missing variables get model-visible errors, not success.

A timeout must not re-execute the offending block: it may already have side effects. Introduce a typed timeout outcome, detach the dead child/readline/pending message state, cancel or generation-guard outstanding bridge responses, restart from saved context/tools only after the old process exits, and return a block error explicitly stating user variables were lost. Preserve prior chat observations; never imply namespace continuity. Reuse the existing REPL recovery path without its automatic retry for this case. Failed restart and run deadline remain terminal errors. Pair before/after tool events even for timeout. Keep the current 30s default; no unmeasured 60s timeout increase.

Reserve finalization inside the declared iteration budget: the last available model turn asks for a final answer, validates it, and can use remaining declared validation retry budget only if it fits the run/cost/token/deadline envelope. Remove the extra unbounded one-shot forced completion outside the cap; do not quietly raise 16 to 24. Invalid cap final is visibly validation_failed/error according to existing contract, never advertised as verified success. Record actual model-call counts and costs.

### Provider cutover

Use built-in `deepseek/deepseek-flash` after verifying its exact installed catalog ID/capabilities. Preserve operator-owned credentials and endpoints; do not rewrite existing ~/.mikro/settings.json or gate-env.sh. Custom provider support remains for Juice and other genuine gateways; migrate repository callers of the obsolete deepseek-api alias. Freeze baseline with its old mapping; compare post-upgrade RLM and Pi with the SAME provider/model/options. Disclose dependency/provider changes as a confound against the old baseline. DeepSeek Pro is excluded from every planned call, manifest and scored denominator; historical evidence remains unchanged.

### Juice, project attribution and manual extraction

Explicit gateway base URL is configured as `https://juice.labs.khal.ai/v1` for this deployment, never a compiled default. Resolve candidate IDs from the authenticated `/v1/models` catalog; retain advertised IDs/capabilities and separately report unavailable candidates rather than inventing aliases. Curated requested candidates are GLM 5.3, GPT-6 Luna fast, GLM 5.3-flash, and Xiaomi MiMo 2.6; Codex access is allowed. Flash remains the control. Classify model provenance accurately rather than labelling GPT or unknown providers open-source.

Provision distinct project keys through the supported Juice management API, preserving unrelated keys and using the existing `khal-engine-juice` management credential only in memory. Store Mikro project keys in a private user-level directory with restrictive directory/file permissions; versioned manifests contain only project identities, key aliases and credential references. Keys never enter argv, journals, repository files, error bodies or chat. Validate authenticated catalog access and project-scoped usage after a real call. Keep project configuration explicit and disabled until configured; reject ambiguous project mapping.

Keeper is a separate service under `https://juice.labs.khal.ai/keeper/`. Authenticate only the selected project inference key through `POST /keeper/api/v1/auth/api-key-login` with the request-intent header; hold the viewer session cookie in memory and discard/logout in finally. Retrieve viewer `/key-overview`, `/key-analysis`, and `/key-analysis/latency` for one supported range; server-side viewer scope, not client-supplied IDs, provides project isolation. These are aggregate usage/performance snapshots, not request events, conversation analyses or request/response payload exports. No admin endpoint or management credential is used for extraction. Provenance is configured URL/query, local project/key identity, returned timezone/range, retrieval time and snapshot content hash; do not invent absent request IDs. Confirm authenticated deployment parity before claiming operational support.

JEV is an additional configured extraction/selection layer, not an instrumentation callback: one explicit POST to the configured `/v1/systemone` endpoint with explicit model, bearer credential reference and bounded source-linked Choice candidates plus abstention; preserve raw typed answers, distributions/confidence, actual model, input/output usage and locally reattached snapshot/span references. Candidate selection is advisory, never generated conversation extraction or automatic source mutation. No automatic retries, translation, caching, scheduled work or extra calls on ordinary Mikro runs. Smoke both viewer retrieval and actual manual JEV extraction; unsupported deployed routes remain an exact prerequisite, not fake empty success. Request-level Keeper extraction is outside this project-key capability and requires separately authorized access.

### Production-shaped benchmark

The completed diagnostic baseline has 15 runs/16 attempts, 14/15 first success, 15/15 final success, $0.58 footer-priced total, 14/16 at cap, p50 78.405s/p90 163.948s. Existing-file truth only; no selection claim. Original input hashes stayed unchanged. Durable raw record: `evidence/baseline-2026-10-04.json`.

Freeze a second suite BEFORE new scored outcomes: two real commit-backed wish-context fixtures per repository, one existing-file and one pre-addition nested-new-directory objective in each (four fixtures total, Genie and brain), plus read-only/citation-negative security scenarios tested mechanically outside quality scores. Select recent non-merge commits deterministically with file-status metadata; persist source/parent/evaluation tree SHAs, prompts, existing/new truth paths, schema/prompt/runtime/pricing hashes and complete skip reasons. Added-file wishes run on the parent tree, with implementations absent; review tasks run on appropriate commit/parent pairs. Generator's HEAD-existing added files are not genuine NEW coverage.

Scored control arms: old installed unpatched RLM, patched/upgraded RLM, Pi; Flash only, three reps for every fixture/arm (36 logical runs). Separately pre-register the same matched post-upgrade RLM/Pi fixture cells for each available curated model, with three reps; candidate IDs and exclusions are frozen before their outcomes. No Pro or Claude call. Concurrency 1, same facts mode, caller outer retry policy, boundary mode, request limits and model options per cell. Record old engine's different dependency/provider graph. Isolated fixture repositories and durable output; never install/update production to select an arm. Runtime selection binds PATH launcher/version/artifact identity and respects bwrap runtime root, not tags pretending to select code.

NEW is proposal-only: only top-level plan.files reason prefix NEW:, absent path, no line, nearest existing tracked ancestor inside repository. Reject existing untracked/ignored files, traversal/absolute paths and symlink escapes; an accepted proposal must not make the same missing path valid as ordinary evidence through dedup. Parent-tree ground truth separately scores correct NEW declarations. Expected existing evidence targets allow real citation recall; file-set precision/recall is reported separately from citation validity/recall.

Report first/final verified success, all-attempt and run latency p50/p90, failures, rescued retries, file and NEW precision/recall, expected citation coverage, cost per call and cost per verified success including failed attempts, cost-coverage/unknowns, per-attempt cap share and per-fixture repetition dispersion. Existing aggregate summary scores successful answers only; include all-run results with failure penalty and no stale answer from earlier failed attempts. Never equate missing footer to free billing; do not redesign frozen accounting consumers to obtain these experimental statistics.

Run the same two bounded real objectives in 18 separate repository/common-directory and state roots: offload-rlm/offload-pi/offload-off, three reps per objective/variant. Use an actual saved workflow runner with explicitly approved non-Claude model IDs, or the shipped native wish procedure with real independent stages, never a reauthored substitute pipeline. Prove model routing and observable usage in an unscored smoke before freezing the experiment. Installed DSH can run the saved script but its journal lacks stage/token fields; OMP native execution does not by itself produce report-compatible records. Collect only actual runtime events/usage in the experiment harness; append `wish report` only when real IDs and required measured fields exist. Missing accounting stays unknown and blocks accounting comparison, not a synthetic zero/run ID/SHIP receipt. Preserve each real outcome and all failures. Manual commands only; no schedule.

Selection: Pi may be recommended for explicitly bounded agents only if verified success is no worse than patched RLM in EACH repository/model cell and no security failures, with improved measured cost per success or latency; report small-sample uncertainty and paired fixture differences. Otherwise keep RLM default and explicit Pi as an experiment. Real-workflow SHIP/repairs must not worsen before recommending workflow adoption. Ties retain RLM; no automated defaults change in this delivery.

## Simplicity Case

- **Simplest complete design:** reuse the existing backend/MCP seam and Genie verifier/accounting; embed supported Pi tool loop rather than invent a second one; one subtree, one delivery PR.
- **Added machinery:** isolated SDK resources and scoped tools protect current read-only requirement; timeout restart prevents a dead namespace from masquerading as recovered; parent-tree fixtures prevent completed-code leakage; immutable runtime/manifest receipts prevent measuring PATH production by accident.
- **Deferred until measured:** automatic routing, compaction, extra retry layers, scheduling, caches and Prime upgrade require separate evidence/approval.
- **Complexity removed:** hidden backend alias, duplicated REPL protocol on Pi, forced-final call outside cap, global provider mutation, duplicate accounting stores, submodule and Genie bundling.

## Decisions

| # | Decision | Rationale | Source |
|---|----------|-----------|--------|
| 1 | End-to-end delivery, not design-only | Owner explicitly selected complete implementation/migration/experiments | `.genie/brainstorms/mikro-engine-split/HANDOFF.md` |
| 2 | Pi SDK 1.0.2, explicit empty resource loader and provider-only retries | Installed 0.86.1 proves supported isolation API; same latest release family avoids duplicate runtime/provider identities; later fixes address truncation/retry/schema behavior | `package.json`, `src/sdk/rlm-driver.ts` |
| 3 | RLM remains default; engine never inferred from shape | Explicit choice and evidence preserve existing long-context behavior | `.genie/brainstorms/mikro-engine-split/HANDOFF.md` |
| 4 | Timeout resets state visibly, never replays timed-out code | SIGKILL cannot preserve Python variables; replay can duplicate side effects | `src/repl.ts`, `src/rlm.ts` |
| 5 | Non-squash subtree at mikro/; separate CI and package authority | Owner rejected submodule/bundling and requested kept history | `.genie/brainstorms/mikro-engine-split/HANDOFF.md` |
| 6 | No unconditional 24-iteration or 60s increase | Measurements do not establish larger budgets as correct repair | `.genie/brainstorms/mikro-engine-split/HANDOFF.md` |
| 7 | Prime remains experimental and outside required scored arms | Optional in handoff; current installed/pinned versions disagree | `.genie/brainstorms/mikro-engine-split/HANDOFF.md` |

Primary SDK evidence: [1.0.2 coding-agent changelog](https://github.com/earendil-works/pi/blob/v1.0.2/packages/coding-agent/CHANGELOG.md), [1.0.2 pi-ai changelog](https://github.com/earendil-works/pi/blob/v1.0.2/packages/ai/CHANGELOG.md), shipped `@earendil-works/pi-coding-agent@1.0.2` sdk.d.ts. These establish APIs/version risks, not a performance win.

## Risks & Assumptions

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| 1 | Provider/dependency migration changes behavior independently of engine | High | Old control immutable; matched post-upgrade RLM/Pi; explicit confound and actual catalog/provider proof |
| 2 | SDK defaults load untrusted resources or unrestricted filesystem tools | High | Explicit resources/settings/auth/allowlist, scoped custom operations, adversarial symlink/mutation/ambient-file smoke |
| 3 | Timeout recovery replay or old async response corrupts replacement child | High | No replay, wait old exit, drain/detach state and generation guards; actual bridge-timeout regression |
| 4 | NEW proposal validity leaks to evidence citations | High | Scope-sensitive verification/dedup, paired proposal+bare-evidence negative test |
| 5 | Full Genie tooling absorbs imported node:test/dist and release files | High | Separate package/gate/CI, exact pre-import root suite inventory and distribution payload verification |
| 6 | Shared host load and root disk affect timings/tests | Medium | Concurrency 1, disclose load, serialize Genie full gate, remove only inherited NO_COLOR/TMPDIR for known host fixture issues |
| 7 | Non-Claude workflow runner or actual stage usage unavailable | High | Prove installed DSH/native runner and usage source before scored runs; never use wish.js Claude defaults; a missing prerequisite blocks that group while independent implementation proceeds |
| 8 | Footer rounding/missing usage limits cost certainty | Medium | Record pricing basis/coverage, do not infer zero or exact billing from rounded footers |
| 9 | Juice management, Keeper or JEV deployment differs from upstream | High | Source-linked route/schema evidence, authenticated smoke, project-only mutations, secret-safe failures; preserve unrelated project keys and record missing deployed prerequisites |

## Success Criteria

- [ ] Imported source SHA remains ancestor and imported tree is identical at import commit; original WIP unchanged. **Proof:** Git graph/tree identities plus saved WIP hashes.
- [ ] Both full package gates and independent Mikro CI pass; original Genie tarball payload remains eight members and Mikro absent from executable imports. **Proof:** full aggregate exits and existing release verification on candidate.
- [ ] Provider errors/length, FINAL variable/ellipsis, timeout-with-state-loss and validated cap-final behaviors fail before repair and pass after at the actual runtime boundary. **Proof:** owning regressions plus actual REPL/provider/MCP smokes.
- [ ] Engine defaults/strict override/old-key rejection work; RLM and Pi preserve backend-contract surface, ledger and progress. **Proof:** existing contract harness and actual compiled MCP runs through Genie caller.
- [ ] Pi completes a schema-valid tool run without REPL, ambient tools, shell/mutation or out-of-root reads; failure cases return errors. **Proof:** dependency-backed provider/tool smoke and live bounded Flash call.
- [ ] Built-in provider/model selection is demonstrated without editing operator auth/settings. **Proof:** provider catalog/actual call identity and unchanged user-config hashes.
- [ ] Frozen suite includes Genie and brain parent-tree NEW paths and complete provenance; all 36 Flash control fixture-runs retain artifacts, with separately frozen available candidate cells. **Proof:** manifest, experiment harness, attempt records and selection report; no Pro/Claude call identities.
- [ ] Actual wish procedure produces all 18 registered variant runs with real IDs/outcomes and measured accounting comparisons; existing report ledger receives only compatible real records. **Proof:** actual runtime records, stage usage provenance and `genie wish report --summary` where compatible; missing accounting is not completion.
- [ ] Faster/cheaper routing is never recommended below verified-success parity; defaults remain RLM. **Proof:** paired report and effective agent configuration.
- [ ] Independent execution/security/performance review SHIP and candidate remote CI; single merge-ready PR to dev, main untouched. **Proof:** SHA-bound verdicts, gate exits and forge readback.
- [ ] Explicit Juice project configuration provisions distinct private project keys without changing unrelated keys; real usage is filterable per project. **Proof:** private-file permission checks, authenticated model identity and project-filtered usage smoke; no credential values in artifacts.
- [ ] Manually triggered viewer-scoped Keeper aggregate snapshots and JEV selection preserve configured URL/query, project/key identity, returned timezone/range, retrieval time/content hash and typed answers; no invented request IDs, request/payload export, admin escalation or ordinary-run extraction calls. **Proof:** real configured viewer retrieval/JEV extraction and owning behavior tests.

## Next Step

After independent design SHIP, create the coordinated execution wish in the isolated Genie worktree, preserve this content digest unchanged, validate the plan, and execute its dependency order. Keep the active objective open through all implementation and experiment obligations; do not call design readiness delivery.

<!-- genie-design-review:start -->
## Design Review Evidence

- **Verdict:** SHIP
- **Reviewed content SHA-256:** `f473c5dfff23221fabbcb2aec89880e3199f572ba4dd098ab4be8258a82b79f2`
- **Reviewer:** EngineSplitDesignReview
- **Reviewed at:** 2026-10-05T00:19:55.000Z
<!-- genie-design-review:end -->
