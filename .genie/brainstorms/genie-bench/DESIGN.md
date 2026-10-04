# Design: Genie Bench — verified native-client efficiency and autonomy

| Field | Value |
|-------|-------|
| **Slug** | `genie-bench` |
| **Date** | 2026-10-04 |
| **WRS** | 100/100 specification readiness; no implementation or scored result claimed |
| **Size** | G · dependency-aware implementation groups: task/oracle contracts, native adapters, attempt accounting, paired execution, release evidence, improvement campaigns and website integration (lead, round 1; expanded by owner, round 5) |

## Problem

Genie needs reproducible evidence of whether its native-context adaptation changes independently verified completion, speed, cost and autonomy for a specific harness/model configuration. Diagnostic traces alone cannot establish task success, complete accounting or a release-to-release improvement; publish controlled public-task comparisons that can show benefit, no change or regression, not an intelligence index.

## Scope

### IN

Paths below are proposed implementation ownership, not code already created. The engine is operator infrastructure under `scripts/bench/`, not a new Genie daemon or machine-scope task database. The separately reviewed OMP adaptation and the other agent's Phoenix work are dependencies; their files remain outside this wish's ownership until their coordinators agree a specific shared integration change.

The normative contracts and success criteria below are self-contained. `DRAFT.md` and related
research/capture notes cited as provenance are machine-local working evidence under the repository
ignore policy, not additional shipped runtime dependencies. Public original sources:
[DeepSWE pinned packages](https://github.com/datacurve-ai/deep-swe/tree/0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea),
[Terminal-Bench 4.0](https://github.com/harbor-framework/terminal-bench/releases/tag/v4.0.0),
[SWE-Atlas pinned source](https://github.com/scaleapi/SWE-Atlas/tree/49e4af3b6c803dd54a1cd60ead703aac25de4e21),
and [SkillsBench 1.1](https://github.com/benchflow-ai/skillsbench/releases/tag/v1.1).

| # | Deliverable | Files changed | Source |
|---|-------------|---------------|--------|
| 1 | Versioned task, configuration, acceptance and comparison contracts | `scripts/bench/contracts.ts` (new), `scripts/bench/README.md` (new) | `.genie/brainstorms/genie-bench/DRAFT.md`, R1-1, R1-3 |
| 2 | Harness-independent attempt supervisor and whole-attempt accounting | `scripts/bench/run.ts` (new), `scripts/bench/ledger.ts` (new), `scripts/bench/accounting.ts` (new) | `.genie/brainstorms/genie-bench/DRAFT.md` |
| 3 | Controlled paired pilot and reproducible analysis that permits regressions | `scripts/bench/pilot.ts` (new), `scripts/bench/analysis.ts` (new) | R3-1, R4-1 |
| 4 | Static benchmark database and future website data/presentation contract | `scripts/bench/export.ts` (new), `scripts/bench/README.md` (new); actual future website consumer is a separately owned prerequisite, not an invented in-repo application | `.genie/brainstorms/genie-bench/DRAFT.md`, `.genie/brainstorms/genie-bench/INSTRUMENTATION.md` |
| 5 | Execute OMP pilot: 20 existing task identities, three repeats per arm, 120 scored attempts after smoke | `scripts/bench/tasks/public-pilot.json` (new frozen manifest), `scripts/bench/pilot.ts` (new); generated private receipts and public release snapshots outside source | R1-2, R4-1, `.genie/brainstorms/genie-bench/PILOT-TASKS.md` |
| 6 | Claude Code on/off coverage for Sonnet 5.5 medium and Opus 5.5 medium | `scripts/bench/adapters/claude-code.ts` (new), configuration manifests in `scripts/bench/tasks/` (new) | R1-2, R3-2 |
| 7 | Codex on/off coverage | `scripts/bench/adapters/codex.ts` (new), configuration manifests in `scripts/bench/tasks/` (new) | R1-2 |
| 8 | Actual DeepSeek harness on/off coverage, not a substituted model in another client | `scripts/bench/adapters/deepseek.ts` (new), configuration manifests in `scripts/bench/tasks/` (new) | R1-2 |
| 9 | Hermes on/off coverage | `scripts/bench/adapters/hermes.ts` (new), configuration manifests in `scripts/bench/tasks/` (new) | R1-2 |
| 10 | Consume pinned, independently delivered OMP-native Genie adaptation | `scripts/bench/adapters/omp.ts` (new), `scripts/bench/contracts.ts` (new); adaptation implementation remains owned by the linked design's wish | R3-1, `.genie/brainstorms/genie-omp/DESIGN.md` |
| 11 | Keep the actual native client and visible UI in every solver execution path | `scripts/bench/run.ts` (new), the five adapter files above (new) | R3-2 |
| 12 | Lightweight cross-harness context/native/human/outcome evidence and Phoenix mapping | `scripts/bench/capture.ts` (new), `scripts/bench/phoenix.ts` (new), native adapters (new); native/server feature changes belong to their dependency owners | `.genie/brainstorms/genie-bench/INSTRUMENTATION.md` |
| 13 | Versioned verified-autonomy and human-input significance measurements | `scripts/bench/metrics.ts` (new), `scripts/bench/taxonomy.json` (new) | `.genie/brainstorms/genie-bench/DRAFT.md`, `.genie/brainstorms/genie-bench/INSTRUMENTATION.md` |
| 14 | Instance-hosted engine and immutable release exports backed by ledger and frozen extraction | `scripts/bench/ledger.ts` (new), `scripts/bench/export.ts` (new), `scripts/bench/README.md` (new) | `.genie/brainstorms/genie-bench/DRAFT.md`, `.genie/brainstorms/genie-bench/INSTRUMENTATION.md` |
| 15 | Autonomous isolated candidate experiments, independent review and operator-approved promotion | `scripts/bench/improve.ts` (new), `scripts/bench/README.md` (new) | R5-1 |
| 16 | Frozen-core and refreshed-cohort longitudinal comparison, with versioned sources/scoring/models/releases | `scripts/bench/contracts.ts` (new), `scripts/bench/analysis.ts` (new), `scripts/bench/export.ts` (new) | `.genie/brainstorms/genie-bench/DRAFT.md`, `.genie/brainstorms/genie-bench/INSTRUMENTATION.md` |

Implementation adds behavior-focused tests beside these scripts and updates the repository's existing validation/dead-code discovery configuration only where the new entry points require it. No test/source change is claimed in this brainstorm. The website's physical consumer files cannot be assigned before that project exists; its interface and rendering obligations below remain part of full product delivery, with integration tracked in that project's wish rather than silently dropped.

### OUT

- Intelligence/IQ composites, guaranteed superiority and full-suite upstream-score claims from a selected subset (Source: `.genie/brainstorms/genie-bench/DRAFT.md`).
- Newly authored scored tasks, altered source prompts/oracles/reward thresholds, homegrown wish scoreboards, reference-answer access or solver-controlled grading (Source: R1-1, R1-3, `.genie/brainstorms/genie-bench/PILOT-TASKS.md`).
- Headless/print/RPC/SDK replacement of the actual client; mandatory Genie workflow stages or forced delegation on every task (Source: R3-1, R3-2).
- Automatic promotion, merge, release, permission weakening or direct edits to installed/user-owned guidance. The chosen authority is isolated experiments plus reviewed, operator-approved promotion (Source: R5-1).
- Amendment of the approved observe wish, existing proposal-only weekly workflow, or reviewed OMP adaptation by this design. Shared changes need their own scope/approval (Source: `.genie/brainstorms/genie-bench/INSTRUMENTATION.md`, `.genie/brainstorms/genie-omp/DESIGN.md`).
- New agent-called telemetry commands, model turns or stages; Genie resident processes, always-on capture/network, hardcoded Phoenix endpoint/project/credential or copied secret material (Source: `.genie/brainstorms/genie-bench/INSTRUMENTATION.md`, `.genie/brainstorms/genie-bench/LIFECYCLE-CAPTURE.md`).
- A live leaderboard service, extra operational database service, event plugin framework, delta/cache/sharding protocol or automatic benchmark-source upgrades. Reconsider only against measured export/runtime limits or a reviewed consumer requirement (Source: `.genie/brainstorms/genie-bench/INSTRUMENTATION.md`).

## Approach

### 1. Separate authorities and keep native execution

A finite, operator-invoked Bun/TypeScript supervisor uses original source-native task environment and verifier lifecycles; reuse Harbor/Pier where they preserve those semantics and BenchFlow where its conversion parity is unproven. It supplies the original prompt to the actual interactive native executable, observes it, collects the source-prescribed artifact and invokes the independent verifier. It does not implement an alternate agent loop. Ordinary tasks can use relevant guidance without constructing a wish/card or traversing fixed stages.

The external attempt ledger owns scheduled identities, dispositions, external timing and original-oracle receipts. Native observations own dispatch/tool/input provenance; Phoenix is a queryable diagnostic projection. An agent's done message, workflow review verdict, task lane, trace status or forge event cannot substitute for original acceptance. The other agent's lifecycle-capture proposal supplies optional diagnostic linkage, not benchmark outcomes or all-call proof; heuristic time-window joins remain labeled and never establish exact actor attribution.

Genie remains fork-and-exit. Host jobs may supervise a finite attempt/batch on this instance; they are not a resident service shipped or auto-started by Genie. Capture is explicitly configured, transparent and metadata-first: no additional model action, stage or start/end command. No configured endpoint/project means no Phoenix network operation. No changes to unrelated operator settings or credentials; native authentication uses an explicitly authorized route without publishing secrets. Measurement settings are frozen and identical in both arms.

The engine is disabled until explicitly configured; ordinary Genie does not invoke its code or
create its capture files/network work. No endpoint or project fallback, including a private host
or loopback port, is permitted. The owner declined stricter remote-export defaults: do not mandate
hashing private Phoenix worker/session identities or refuse a configured non-loopback HTTP endpoint.
This does not change the separately required public allowlist or authorize exposing credentials.

### 2. Native capability preflight is a hard dependency

Each adapter reports the observed executable/build, launch/UI mechanism, discovery/isolation roots, configuration and model/effort resolution, source-native artifact transport, settled/stop signal, registered lead/worker/auxiliary actors, exposed dispatch/retry/usage/input/approval fields, and safe bounded capture/export capabilities. Test these in the actual client; declarations, catalog entries and SDK callbacks are not proof of TUI subscription behavior. No fabricated APIs, no silently permissive adapter fallback. A missing native capability is a named upstream/dependency requirement before the affected gate can pass.

Use the already exposed session linkage reported by the capture agent: Claude Code
`CLAUDE_CODE_SESSION_ID`; Codex `CODEX_THREAD_ID`, observed equal to rollout
`session_meta.session_id` in 3/3 checked sessions; OMP/pi `PI_SESSION_ID` and `PI_SESSION_FILE`.
The latter identifies the exact native log path; child logs have their own native file identities.
Cross-trace session linkage needs no new adapter API. These are the owner's reported findings,
not fresh probes by this author; the capture note distinguishes older pi observations from live
OMP conformance still to exercise. Runtime/session association does not itself prove input authorship.

Consume the exact reviewed OMP adaptation contract and its pinned resource hashes. Its native blind-admission and reader-only reviewer requirements remain mandatory where wish/review paths are used. The user reported OMP updated; this is not a claim those behavioral requirements passed, and the old inspected version is not asserted to describe the new build. Run the specified native policy and real-client probes during authorized implementation, not a redundant version check to challenge the update.

For OMP, both arms use GPT-6.1 Sol medium, including model/effort controls on natural child and auxiliary calls. Claude Code later gets separate Sonnet 5.5-medium and Opus 5.5-medium pairs. Later adapters must resolve the actual named Codex, DeepSeek and Hermes executable/route; unsupported access is visibly unsupported, not a replacement harness or a portable-model claim. A requested model and observed response/upstream model are separate fields; inaccessible backend/effort facts remain unknown.

### 3. Freeze original public tasks before outcomes

First scored batch is owner-settled: 20 task identities × three independent repeats × two OMP arms = 120 attempts. `PILOT-TASKS.md` is the candidate source list, not an execution-cleared manifest: six DeepSWE, four Terminal-Bench, six SWE-Atlas (two each QnA/test-writing/refactoring), four SkillsBench. Preserve its pinned source revisions and original instructions, graders, thresholds, image/resource/network/artifact policies and supplied development examples. Label results “Genie Bench — selected public tasks,” not official complete upstream suite results.

Eligibility clearance precedes manifest freeze and unblinding: resolve Atlas test-writing target concerns against intact original grading; artifact-level licensing/provisioning; SkillsBench native lifecycle/parity; pinned image/input/verifier digests and judge settings. Require original binary/explicit task acceptance; process exit zero alone is not reward success, and no new pass threshold converts a fractional reward. Retain original QA partial judge coverage and source constraints. No claim of blanket artifact rights from repository licenses.

If a candidate is ineligible, record its reason and replace before any treatment outcome using bytewise original-task-ID order within the same declared source/category from the same frozen eligible pool. Freeze that pool and ordering first; no outcome-dependent substitutions or quota reduction. If a category cannot supply its quota, stop and resolve the manifest rather than silently shrinking the 20-task cohort. The exact final artifact hashes are generated from cleared packages during preflight, never invented in this design.

Existing actionlint-action-pinning-lint and session-window-debug are initial integration candidates in each arm. Preserve their original maxima and grading; integration attempts stay outside scored statistics. Fresh solvers and descendants receive only legitimate original task inputs, not this conversation/research, verifier/rubric/reference solution/cheat material or hidden mounts. Public tasks are not promised unseen by pretrained models; operational leakage is separately controlled and disclosed.

### 4. Matched native pairs, isolation and all-attempt denominator

Arm A has no Genie skills, guidance, agent/workflow catalog, plugin, state or treatment memory; isolate all discovery roots, not just a profile. Arm B has the pinned native-context adaptation. Equal native capabilities, common safety policy, initial task/environment, provider/model/effort, tools/permissions and original oracle apply to both. Benchmark observation runs outside solver context or through agreed native metadata surfaces; it supplies no Genie instructions/resources to baseline. Benchmark-supplied skill condition is frozen identically in both arms, separate from the Genie factor.

Use fresh workspaces, native homes/session/memory/discovery roots and solve contexts per attempt; do not copy previous solutions or this research state. Interleave/randomize paired order with a recorded host seed before outcomes, preserving the three repeats within each task. Provider cache usage is observed, not promised controllably cold. Deliberate model/routing/permission changes are separate practical-stack comparisons, not Genie-only causal attribution.

Register all 120 scheduled attempts before launches. The first pilot has no automatic scored replacement/rerun: retain setup/provider/infra failure, rejection, timeout, interruption and abandonment rows. An authorized later rerun is an explicitly new campaign/revision retaining originals, never best-of-repeat selection. No artificial dollar cap; preserve source time/resource limits. Setup and necessary authentication are separate preflight, not unrecorded solver assistance.

### 5. Durable attempt, event and outcome boundaries

Use one host-owned per-attempt journal plus bounded native evidence; phase checkpoints are durable before external effects. One supervisor owns journal mutation; do not create another Genie task DB or synchronization protocol. Persist registration before launch, observed actor/request inventory and terminal/verification receipts before sealing; preserve partial journals after interruption. Corrupt/truncated records fail closed for affected metrics while raw evidence and scheduled identity remain retained. Recovery checks identity and existing effects, never resets retries/denominators or silently restarts a scored solver.

Contract states are distinct: registered → running → execution stopped → independent verification or terminal failure → capture sealed → reconciled → extraction frozen. Pre-running failures bypass execution; missing telemetry cannot erase terminal outcomes. Native settled state includes pending children/wakes, not merely a lead yield or non-streaming flag; stop/timeout cancellation records remaining actors and usage uncertainty. Original verification binds to the collected immutable artifact and remains outside mutable solver mounts; preserve source-specific committed-patch versus directory/answer transport.

The common envelope retains schema/experiment/pair/task-manifest/task/attempt/event identity, source kind and source instance/sequence, actor/parent/native-session, observed time, trace/span and evidence references, plus per-field availability/provenance. Wish/group/phase are optional. Stable replay identity is not a model-call or span identity; order only within the actual source sequence. Same identity/revision with changed payload is a conflict; unknown parents are not guessed from timestamps. Relevant mutable root payloads have attributable revisions.

External monotonic clocks own task-release, execution-stop and verifier-acceptance intervals; record clock/source provenance. Sum parallel durations only as work, never elapsed time. Preserve native wall timestamps for joins without treating them as exact causal ordering. Setup, solver elapsed, human wait, grading, delivery and publication remain separate; publication is outside task completion accounting.

| Diagnostic area | Source and owner | Required interpretation |
|---|---|---|
| Configuration identity | Supervisor manifests plus native resolved configuration | Compare the observed stack, not just a requested model label |
| Context acquired/delivered | Native acquisition/provider-context evidence, adapter | Invocation, successful body read and delivery are distinct; unavailable delivery proof is explicit |
| Native graph | Native actor/job/session/tool events, adapter | Preserve exact parentage and pending work; heuristic joins stay heuristic |
| Model requests | Native request/usage records and transcripts, adapter/accountant | Request attempts, native sessions/runs and messages have separate identities |
| Human interaction | Input/control surface plus post-run versioned labels | Session/runtime IDs and fallback author labels do not prove a human |
| Independent outcomes | Original artifact/oracle receipts, supervisor | Internal review/lane/trace status cannot decide task acceptance |
| Recovery | Supervisor/native terminal and resume evidence | Keep original failures, uncertainty and budget/disposition across interruption |
| Observer health | Native inventory and server stored-record evidence, separate owners | Native coverage and delivery coverage remain distinct, overhead measured |
| Improvement attribution | Isolated candidate/campaign and approval receipts, engine/operator | Retain every trial and the exact promoted revision; no automatic release |

### 6. Complete request economics and explicit missingness

Capture every observable distinct model dispatch attempt, including leads, workers, auxiliary calls, retries/fallbacks and failed requests. Preserve requested versus response/upstream model, effort evidence, cache/token/reasoning categories and cache-write lifetime buckets, request/response IDs, duration and usage-presence flags. Aggregate only individual billable records, never root rollups plus descendants. Validate each native token convention; reasoning subsets are not added again to output, cache fields are not double-counted. Provider-internal retries absent from native surfaces are a capture gap, not a proven zero retry count.

Maintain separate native-source coverage and observed-record delivery coverage. Complete delivery of observed records does not prove complete native capture. Unknown tokens, price, billable retry status or terminal usage remain null/unavailable with evidence and coverage; no pricing fallback or first-record/missing-as-zero convention. A known zero must have an explicit source basis. Full usage/human-origin capability proof is required before the scored batch is admitted; later loss keeps outcomes but disables unsupported aggregate/ranking claims rather than hiding failures.

Pin price source/version/date/currency and route. Report API-equivalent normalized cost separately from measured billed charges, subscription access, grader/analysis/optimizer and infrastructure costs. Subscription inclusion is not a measured zero-price task. Cost/attempt is cohort cost divided by scheduled attempts; cost/accepted task uses all cohort costs divided by compliant accepted attempts, undefined with zero acceptance or incomplete required costs. Known-spend subtotals are labeled partial, not a cheap winner.

Deduplicate using the native run/session and request identities plus source revisions, not each
user/steering message. Steering can add a request within an existing run without creating another
attempt. The owner's reported brain analysis inflated reviews 284 versus 260 and workers 328
versus 240 by treating steering messages as runs; those numbers are evidence of that report defect,
not benchmark results. Streaming/usage revisions likewise do not become extra billable requests.

For cache pricing, preserve transcript `ephemeral_5m` versus `ephemeral_1h` creation buckets and
the applicable versioned rates. The capture agent reports subagent writes 100% 5-minute and main
agent writes approximately 96% 1-hour in the inspected sample; do not generalize that mix into a
default for future calls. Phoenix's aggregate `cache_write` alone cannot reconstruct lifetime costs.
Join exact native transcripts; missing lifetime data makes affected normalized cost unavailable.

### 7. Versioned autonomy and human significance

Primary Verified Autonomy Rate, for the fixed eligible scheduled cohort with complete origin capture and resolved labels:

`100 × independently accepted, protocol-compliant attempts with zero human rescue / all eligible scheduled attempts`.

Initial task/setup, declared necessary approvals/consent and upstream-required interaction are recorded but not rescue. Unnecessary/repeated clarification, hints, diagnosis, supplied plan/code, manual execution/takeover and interruption are separate labels linked to submitted input, originating request/action and source evidence. Automated runner/tool/peer/wake messages are not human merely because represented as user. `task_events.author_kind = human` is a fallback when runtime environment detection fails, including scripts/cron/unrecognized runtimes; it cannot count as human provenance without corroboration. One reply may contain several atomic decisions. Ambiguity remains unknown, not optimistic independence.

In a strict no-rescue scored attempt, rescue ends autonomous eligibility; preserve its original disposition. A separately authorized assisted continuation is a linked, separately reported attempt/cohort, not an autonomous success. Failures and abandonment contribute no autonomous success. In the fully observed strict cohort autonomy can equal compliant completion; do not manufacture an additional score. Observational production wishes and assisted runs supply richer human-burden data but never enter the controlled task denominator.

Publish completion beside autonomy, raw intervention/request/answer counts, categories, repeated questions, measured human wait and coverage. Active human effort is reported only if directly measured; no invasive keystroke capture, token-length importance score or wait-as-labor estimate. With missing origin or unresolved required labels, autonomy is unavailable with certified counts/bounds and coverage, not a point-estimate ranking.

Significance records observed linked decision/artifact/action/check deltas, evidence, rubric/annotator version and confidence. This is not causal credit for all subsequent work. Any causal with/without-intervention experiment is a separately authorized, source-rule-compatible controlled cohort with disclosed cost and uncertainty. Start without arbitrary severity weights. Labels are post-run deterministic/manual versioned evidence; instrumentation itself adds no LLM action. Optional improvement analysis is separately costed outside attempts.

### 8. Phoenix reconciliation and frozen releases

Use standard OpenInference attributes where they fit and structured benchmark metadata for the envelope; test native GenAI normalization without losing original attributes. Actual server endpoints, stored semantics and pagination/annotation behavior are agreed and exercised with the other agent, not guessed from documentation. Endpoint/project/credential are operator-configured; secrets never enter public events, argv/logs or snapshots. The lifecycle-capture proposal is preserved as separately owned work, not silently approved or duplicated here.

Use the capture agent's reported Linux/ext4 probes only within their scope: disabled gate 5.9 µs,
enabled append 7.9 µs, task-list p50 244.5 ms, and 16 × 5,000 concurrent appends with no torn lines.
These are nonzero prototype costs, not measured zero overhead, native-client performance results,
macOS/NFS guarantees or permission to add a gate to plain Genie. Preserve the owner's zero-change
plain-Genie contract; prove any enabled integration overhead separately without editing the other
agent's capture design or treating the declined stricter security defaults as adopted.

Store bounded metadata/evidence references by default. Capture health records malformed, missing, duplicate, conflicting and unmatched events. HTTP accepted/queued or successful flush is not durable stored proof. Reconcile exact expected identities and relevant payload revisions/digests against server readback; count-only checks and send-only-missing-ID logic are insufficient for changed root revisions. Retry/replay cannot discard a mixed duplicate/new batch. Off-path finite export preserves local journals on network failure; it must not alter the original task outcome/timing.

A bounded paginated extraction freezes the chosen observed inventory/annotations and omissions. Bind it to the external ledger and schema/parser/scorer/taxonomy/price/manifest revisions. Analyze only those frozen inputs. Public immutable release output includes `manifest.json`, `attempts.jsonl`, `results.json`, sanitized verifier/evidence references and checksums; these tables are the static database. No mandatory live database/API; optional downloadable SQLite is deferred until a consumer requires it.

Allowlisted public projection excludes raw prompts, answers/source patches without cleared rights, private wishes/paths/worker names, internal session/trace links, tool payloads, headers and credentials. Use public opaque identities mapped only in private evidence; hashing alone is not anonymization. Keep private source/log retention and public attribution/licensing decisions separate. Verify projection against adversarial fixture fields, not only secret regexes.

Release snapshots are immutable. Late data, annotation/parser/scorer changes or corrections create a new analysis revision retaining old bytes and a reason/provenance link. A reviewed latest pointer can move; it cannot rewrite prior releases. Rebuilding from the same frozen input/version set must reproduce the same canonical data and checksums, excluding nondeterministic execution timestamps from the rebuild operation itself.

### 9. Honest analysis and future website contract

Publish compliant verified completion, autonomy, successful time-to-verified-completion and distribution, all-attempt/accepted-task economics, failed-attempt duration/spend, token/cache/context/request breakdown, counts and native/delivery coverage together. Successful-only time or partial costs cannot establish an efficiency winner. Zero-success, unsupported and all-failure cohorts render with meaningful statuses, not divide-by-zero, empty green results or zero-filled charts.

Pair by task/repeat and pin the analysis unit before outcomes. Uncertainty resamples task clusters with repeats retained; tasks sharing an upstream repository/lineage use the enclosing cluster, not falsely independent samples. State small-cluster/pilot limits; show per-suite/category outcomes and exact pooled task mix, never a universal ranking. Disclose selection/repeated-trial bias and any separate practical-stack comparison.

Each candidate release compares with a contemporaneous zero-Genie baseline and, when compatible, the prior pinned Genie treatment on matched client/model/resource/task conditions. A provider/model/grader/task/taxonomy or permission change creates a distinct cohort/epoch; frozen-core and refreshed-coverage views remain separate, with reference reruns before cross-epoch comparisons. Historic backend changes cannot be claimed as Genie effects; unsupported old treatments are noncomparable, not hidden regressions.

The future Automagik website reads only immutable static snapshots: overview completion/cost/time/autonomy; paired Genie-on/off impact with uncertainty; cost/time plot labeled by completion; chart/table views; filters for harness, model/configuration, Genie state, suite/category, release/cohort; token/cache/failure detail; exact methodology, missingness, provenance and downloadable sanitized records. It must show no improvement/regression/inconclusive data honestly, and prohibit unmatched-cohort winner badges. Actual rendered integration is a future website-project dependency before full product completion; this design neither creates that unrelated app nor claims it exists.

### 10. Autonomous experiments, reviewed promotion

The external finite improvement engine uses production/development evidence to register one scoped hypothesis, expected effect, quality/consent/integrity constraints and evaluation plan before authoring an isolated candidate. It can author and test candidates, as R5-1 settled; it cannot mutate stable/installed/user-owned state or promote/release. Keep all candidate diffs, trial outcomes, failed experiments, analysis/model/infrastructure costs and selection history, not just the winning trial.

Separate operational diagnostic cohorts, development tasks and locked release evaluation. Use existing public development tasks disjoint from the scored manifest; keep locked-task per-attempt trajectories, grader material and solution-bearing evidence out of optimizer context. Optimizer access is restricted to declared development evidence and suitably aggregated release diagnostics, not live unrestricted Phoenix or private raw traces. Treat trace/tool text as untrusted data. Public evaluation is not asserted contamination-free, and repeated locked evaluation is disclosed rather than portrayed as a fresh unseen holdout.

Candidate source/instruction edits run in an isolated workspace with current repository task claims/git-state policy and exact author/reviewer identities. Use original source contracts and existing implementation quality/safety/gate rules, including full repository validation and changed-path runtime smoke. A model/provider/routing change is a distinct stack trial. Any change to an owner-approved policy requires its own question quoting old → new; performance optimization cannot weaken correctness, consent, integrity or native review isolation.

A preregistered campaign compares candidates on development, then locked evaluation only after independent gates; uncertainty and limited pilot power can leave benefit inconclusive. Failure to find a statistically significant loss is not proof of nonregression. The engine returns evidence and a recommendation; independent review plus explicit operator approval is mandatory before promotion, release or latest-pointer publication. No auto-merge or automatic release authority is inferred. Preserve the previous pinned treatment and tested rollback path; record operator dispositions. Every approved release produces a frozen evidence revision, with explicit noncomparable/missing results if changed upstream conditions prevent a clean comparison.

## Simplicity Case

- **Simplest complete design:** a finite host supervisor, source-native task/verifier lifecycle, five thin native-client adapters, one authoritative attempt journal, deterministic analysis/export and the existing Phoenix diagnostic server. Start execution with OMP; retain all later harness/website/improvement obligations.
- **Added machinery:** the attempt journal is required to retain scheduled failures independently of traces; source-aware capture is required for workers/retries/humans; immutable extraction is required for reproducible public releases; isolated campaign records are required for owner-authorized autonomous experiments and trial accountability. These are present user contracts, not scale speculation.
- **Deferred until measured:** distributed scheduling/cache/sharding/deltas, generic adapter registries, live leaderboard services, downloadable SQLite and automatic source refresh. Reconsider only after an observed host/export constraint or explicit consumer requirement, with scope review.
- **Complexity removed:** no replacement agent loop, fixed stage procession, telemetry model calls, new task corpus/oracle, Genie daemon, duplicate task DB, automatic optimizer/promotion policy or default network capture. Source-native executor reuse avoids reimplementing benchmark environments while still proving the visible native solver seam.

## Decisions

| # | Decision | Rationale | Source |
|---|----------|-----------|--------|
| 1 | Existing original public tasks and unchanged acceptance only | Prevent a Genie-favoring homegrown corpus or altered pass rules | R1-1, `.genie/brainstorms/genie-bench/PILOT-TASKS.md` |
| 2 | OMP first; retain Claude Code, Codex, DeepSeek harness and Hermes | Owner's sequence and full named coverage | R1-2 |
| 3 | Verified deliverable is completion; PR/merge/deployment excluded | Acceptance belongs to the task oracle, not publication machinery | R1-3 |
| 4 | Zero-Genie native arm versus pinned adaptive native-context Genie arm | Measure actual Genie effect without replacing OMP or mandating stages | R3-1 |
| 5 | Sol-medium OMP; Sonnet/Opus-medium Claude pairs; subscription/cheap-model real open clients | Honor actual access/model/UI requirements; disclose normalized versus measured spend | R3-2 |
| 6 | 20 tasks × three repeats per OMP arm after smoke | Owner selected 120 scored attempts; no silent smoke-only or smaller pilot | R4-1 |
| 7 | Autonomous isolated experiments; independent review and operator-approved releases | Permit improvement work without unchecked promotion | R5-1 |
| 8 | External ledger owns outcome/time; Phoenix diagnostic projection plus frozen release extraction | Traces may be missing/mutable and cannot erase failure or rewrite historical evidence | `.genie/brainstorms/genie-bench/INSTRUMENTATION.md` |
| 9 | All-attempt verified-autonomy rate, explicit human taxonomy, no arbitrary impact weights | Measure successful independence without rewarding failure/silence or treating role as origin | `.genie/brainstorms/genie-bench/INSTRUMENTATION.md` |
| 10 | Source-native task lifecycles and visible native adapters, capability proof before scored admission | Reuse benchmarks without unsupported conversion or headless substitutes | `.genie/brainstorms/genie-bench/RESEARCH.md`, `.genie/brainstorms/genie-bench/NATIVE-OMP.md` |
| 11 | Static data/public projection and separately owned future website consumer | Reproducible open results without a live trace-service dependency or invented website repository | `.genie/brainstorms/genie-bench/DRAFT.md`, `.genie/brainstorms/genie-bench/INSTRUMENTATION.md` |

## Risks & Assumptions

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| 1 | Native TUI policies, settled signals, input origin or hidden retries remain unsupported | High | Named upstream/dependency gates; actual client/policy/call/input proofs before scored admission; no API invention or permissive fallback |
| 2 | Baseline discovers global Genie resources or previous task memory | High | Fresh discovery roots and source inventories/canaries in the actual client and children; equal common policy; no research context in solvers |
| 3 | Task holds, license/input rights, image or evaluator semantics are unresolved | High | Clear intact source contracts before freeze; deterministic same-category replacement before outcomes; stop on insufficient quota, never alter grader |
| 4 | Missing, duplicated, stale or incorrectly attributed usage makes false cheap wins | High | Individual call identity, explicit field/source coverage, separate delivery reconciliation, null costs and no winner on incomplete evidence |
| 5 | Human-role messages or chronology produce false autonomy/causal credit | High | Native submission provenance, versioned evidence-linked labels, strict versus assisted cohorts, unknowns/bounds and no unsupported causal score |
| 6 | Mutable Phoenix state rewrites historical public results | High | Frozen bounded extraction, exact identity/revision reconciliation, canonical checksums and additive analysis revisions |
| 7 | Private paths/prompts/session data or unauthorized artifacts leak | High | Configured capture, bounded metadata, private mappings, allowlisted public fields, artifact-level rights and adverse projection fixtures |
| 8 | Observer overhead changes the measured task or introduces model stages | High | Transparent capture, same observer both arms, off-path export, separate on/off overhead probe, raw measured times never adjusted into a win |
| 9 | Optimizer sees locked evaluation solutions or selects best trials secretly | High | Disjoint development manifest, restricted optimizer evidence/context, all-trial ledger and independent gates/operator promotion; disclose repeated evaluations |
| 10 | Backend/version/cache drift and shared repositories invalidate comparisons | High | Contemporaneous controls, actual/requested route evidence, frozen epochs, repository/lineage clustering and noncomparability labels |
| 11 | Future website ownership/access is not established | Medium | Implement static consumer contract here; bind actual UI work to future site's own wish/files before it starts; full product completion requires rendered proof |
| 12 | Subscription charges/actual serving model are inaccessible | Medium | Publish normalized price basis/tokens and availability, never invented invoice/model identity; block affected claims rather than silent substitution |

## Success Criteria

All items are implementation/delivery obligations, not observed passes in this design.

- [ ] **SC1 — Complete scope and executable planning:** dependency-aware wish covers all sixteen scope items with file ownership, validation, native/server/website prerequisites and separate authorization. **Proof:** independent plan review and every requirement mapped to a group; missing dependency blocks its group, not a false complete-product claim.
- [ ] **SC2 — Original task/oracle integrity:** twenty eligible pinned identities with original environments/resources/acceptance, cleared holds, deterministic pre-outcome replacements and valid licenses/inputs; solvers cannot read/modify hidden grading or research. **Proof:** frozen manifest/hash/eligibility ledger, intact source verifier parity and isolated collection/grading including tampering/refusal cases.
- [ ] **SC3 — Actual native OMP pair:** visible stock client, exact Sol-medium configuration and natural workers/auxiliary calls; Genie-free discovery versus acquired pinned adaptation; supported native child policy and settled-state proofs. **Proof:** fresh-home/workspace inventories, actual TUI/artifact/oracle records and requested/observed model/effort/capability receipts; no headless-loop substitute.
- [ ] **SC4 — Smoke then full selected pilot:** original actionlint and session-window integration paths run in both arms before admitting the scored batch; exactly twenty task identities with three scheduled repeats per arm, all 120 dispositions retained, no success-dependent reruns/exclusions. **Proof:** independent original receipts, preregistered order/manifest, all-attempt ledger and rejection/timeout/setup/abandonment cases separate from smoke.
- [ ] **SC5 — Whole-attempt economics:** distinct lead/worker/auxiliary/retry requests reconciled, native token conventions and price basis verified, missing response/prices/capture represented as unavailable; no root-plus-child double count or subscription-as-zero. **Proof:** real native main/child/auxiliary capture, deterministic duplicate/fallback/unknown-price/failed-request cases and exact source/delivery inventory reconciliation; zero-acceptance economics remain undefined.
- [ ] **SC6 — Verified autonomy and meaningful input evidence:** complete native origin/approval/interruption capture where scored; rescue disqualifies strict autonomy; initial/necessary approval versus hint/code/manual takeover and automated user-role events remain distinct; observed significance is versioned, not causal invention. **Proof:** real client input/approval/interruption records plus isolated classification/missingness boundaries; in a separately declared assisted cohort, 60 compliant accepted outcomes with 50 rescue-free among 100 yields 60% completion and 50% autonomy, not 83%; strict-cohort rescue is noncompliant and unknown coverage disables the point estimate.
- [ ] **SC7 — Durable recovery and authority:** registration survives failed launch/export/interruption; original oracle binds exact artifact; elapsed time is external and pending child work is not treated as completion; journals preserve partial/corrupt/stale identity evidence. **Proof:** stopped/abandoned/restarted supervisor and native child/wake scenarios, oracle receipt/artifact digests, terminal/clock evidence and recovery readback with unchanged denominator.
- [ ] **SC8 — Real Phoenix reconciliation:** configured endpoint/project with no secret/default leakage; source and normalization metadata retained; queued versus stored, duplicate/new mixed batch and changed root revision converge by exact stored identity/payload, without losing or silently overwriting evidence. **Proof:** authorized actual server ingestion/query/readback/export including offline/replay/stale/missing cases; no count-only or HTTP-202 proof.
- [ ] **SC9 — Immutable private/public release data:** bounded frozen extraction plus ledger regenerates canonical release tables/checksums; public allowlist removes private/uncleared data; late annotations/corrections retain original bytes as new revisions. **Proof:** local extraction→analysis→export→independent rebuild, adverse privacy fixture and replay/revision comparison, all-failure/missing metrics visibly retained.
- [ ] **SC10 — Honest static website consumer:** actual future website renders pinned snapshots with required chart/table/filter/detail/methodology/download views, no Phoenix/secret dependency; unsupported/zero-success/missing/regression/inconclusive data and mismatched cohorts are explicit. **Proof:** real rendered surface and interactions in that project's environment plus sanitized release files; static export alone does not close this criterion.
- [ ] **SC11 — Later named harnesses:** Claude Code's two specified medium model pairs plus actual Codex, DeepSeek harness and Hermes complete matched native-client on/off integration and source-oracle/accounting preflight before scored reporting. **Proof:** per-client visible execution/capability/model/arm inventories, original verifier receipts and honest unsupported fields; OMP-only delivery does not close this criterion.
- [ ] **SC12 — Versioned longitudinal analysis:** frozen core and refreshed epochs use declared matched task/configuration/analysis/price contracts, contemporaneous baseline and compatible prior treatment, paired uncertainty with repeated/shared-repository clustering. **Proof:** deterministic replay/re-scoring on frozen inputs, model/source/taxonomy-change noncomparability cases and published methodology/counts; no historical drift attributed to Genie.
- [ ] **SC13 — Safe autonomous improvement:** engine authors a real isolated scoped candidate from allowed development evidence, records every trial/cost, applies independent quality/safety/full-repo/changed-path gates and restricted locked evaluation, and blocks promotion until independent review and explicit operator approval. **Proof:** actual candidate/dev/evaluation campaign, failed/gate-rejected and no-approval dispositions, exact diff/reviewer/approval evidence, retained prior treatment and rollback exercise; existing observe/weekly workflow and user settings unchanged.
- [ ] **SC14 — Transparent lightweight behavior:** capture adds no model action/stage/agent-called telemetry command, no Genie daemon or unconfigured network/file capture; both arms use the same observer and overhead is measured separately. **Proof:** disabled/enabled actual-client and lifecycle observations, on/off latency/resource records, process/file/network evidence and native task trace; unsupported “zero latency” claims are not accepted.
- [ ] **SC15 — Verified integration quality:** permanent implementation has consumer-visible deterministic boundary/transition tests under isolated temporary homes plus real changed-path smoke, repository aggregate gate and any affected installed/release checks. **Proof:** fresh command exit/output, independent implementation review and actual release/export/native surface evidence; tests alone do not prove integration.

## Next Step

Obtain independent design review of this exact artifact, stamp its returned content digest and verify it; then route to **wish** for dependency-aware planning and separate plan review/authorization. Design SHIP is not implementation approval or a scored benchmark result. Native policy/client capture, original-task eligibility, authenticated model routes, the other agent's Phoenix server and the future website are explicit delivery prerequisites; do not substitute a smaller pilot, headless client, altered oracle or OMP-only completion to evade them.

<!-- genie-design-review:start -->
## Design Review Evidence

- **Verdict:** SHIP
- **Reviewed content SHA-256:** `1c4ad6a923f0c65cc94b926701f650625d74bbf26f4ab6ce1a03e46014da4d9e`
- **Reviewer:** BenchDesignReviewer
- **Reviewed at:** 2026-10-04T19:16:52.000Z
<!-- genie-design-review:end -->
