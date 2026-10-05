# Design: Prime 0.8.1 reconciliation

| Field | Value |
|---|---|
| **Slug** | `mikro-prime-081-reconciliation` |
| **Date** | 2026-08-31 |
| **Status** | DRAFT — validation-ready, not reviewed |
| **WRS** | 100/100 |

## Problem

Mikro has two Prime 0.8.1 surfaces, but current evidence cannot prove that either is a safe default replacement. This child is evidence/reconciliation-first: it records what the current runtimes actually support, runs only comparisons whose controls and receipts are provable, and may conclude that `prime-sdk` is ineligible while Mikro remains the default. It does not implement foundational parity merely to make Prime pass.

Roles are fixed:

- **Mikro** — incumbent and effective default.
- **`prime-sdk`** — sole default-eligibility candidate.
- **`prime`** — non-eligible, opaque subprocess comparator and explicit fallback capability. It may be observed, but never enters the exact-control quality/cost verdict.

## Scope

### IN

- Reconcile current capability truth for Mikro, `prime`, and `prime-sdk` against the 35-row matrix below.
- Pin both Prime surfaces to `prime-agent` 0.8.1 and bind evidence to exact source, package, fixture, configuration, and runtime identities.
- Run an exact-control **Mikro versus `prime-sdk`** campaign only when both in-process paths expose the required request controls and provider receipts.
- Permit a valid result of `PRIME_SDK_INELIGIBLE` or `CAMPAIGN_NO_GO`; either leaves Mikro effective without requiring owner action.
- Preserve two separate Felipe decisions: authorization to prepare one non-effective mutation, then final selection on its isolated post-mutation evidence.
- After final selection and independent immutable review, use the separately approved delivery child for remote-dev integration and read-back.

### OUT

- Implementing missing cancellation, immutable snapshots, budgets, structured protocol, usage receipts, recursion identity/accounting, or provider features. Each foundational gap requires a separately scoped and separately approved future wish.
- Making `prime` the default or using its opaque subprocess results in exact-control quality, latency, or cost eligibility.
- Treating future Gemini flags as implemented, silently ignoring unsupported options, or adding unrelated provider work.
- Automatic fallback, ACP persistence, remote-dev creation/operation inside this child, or any effective mutation before the authorization chain permits it.
- Deleting Mikro/pi-ai or any backend. Legacy deletion remains out even after a successful selection.
- The superseded four-file benchmark v1 artifacts and their three-arm/186-call campaign. They are legacy pre-design material, are not recreated by this child, and are not acceptance evidence for this 35-row matrix or the 124-call v2 campaign.

## Eligibility rule

Current observations use `SUPPORTED`, `CURRENT_REJECT`, `SILENT_GAP`, `GAP`, `N/A`, or `UNVERIFIED`; eligibility expectations use `PASS`, `LOUD-REJECT`, or `N/A`:

- `SUPPORTED` means current code has a matching positive path, but the frozen fixture must still prove the exact oracle on the candidate identity.
- `CURRENT_REJECT` means current code deterministically rejects the named field/configuration before provider or subprocess dispatch, but emits a field-oriented error rather than the capability ID. It is useful current behavior, but it does **not** satisfy a required `LOUD-REJECT` oracle.
- `SILENT_GAP` means current code accepts, ignores, or does not inspect the declaration instead of implementing or deterministically rejecting the capability.
- `GAP` means the required behavior or proof is unavailable now, without a proven current positive path or deterministic field rejection. A mandatory `GAP` is a candidate failure, never a synthetic `PASS`.
- `UNVERIFIED` means support is plausible but live code and admissible current receipts do not decide it. It remains a failure until measured.
- `N/A` is allowed only where the surface cannot exist, and the fixture proves zero exercise.

The `prime-sdk required` column is the eligibility expectation. `PASS` requires the exact positive oracle. `LOUD-REJECT` requires pre-dispatch rejection that names the capability ID and proves zero provider calls. `CURRENT_REJECT`, `SILENT_GAP`, missing, warning-only, ignored, inferred, post-dispatch, or unobservable behavior fails that expectation. Foundational current failures against required `PASS` make `prime-sdk` ineligible in this child; they are not implementation tasks here.

## Truthful 35-row capability matrix

Each future fixture has a stable ID, digest, schema-valid oracle, and declared `provider_calls`. Capability fixtures use an injected deterministic transport and therefore declare `provider_calls: 0`; live campaign calls are mapped separately. “Current” is intentionally not an eligibility verdict.

| ID | Capability / exact oracle | Mikro current | `prime` observational current | `prime-sdk` current | `prime-sdk` required | Mandatory |
|---|---|---|---|---|---|---|
| `CAP-01` | Runtime identity receipt names the selected backend and exact Prime package 0.8.1; no fallback. | GAP | GAP | GAP | PASS | Yes |
| `CAP-02` | Captured final request plus raw provider receipt reconcile provider, endpoint, and model; no rewrite. | GAP | GAP | GAP | PASS | Yes |
| `CAP-03` | Agent model pin overrides ambient model and equals `CAP-02` identity. | SUPPORTED | SUPPORTED | SUPPORTED | PASS | Yes |
| `CAP-04` | `SYSTEM.md` nonce appears once in the effective system contract and changes the deterministic answer. | SUPPORTED | SUPPORTED | SUPPORTED | PASS | Yes |
| `CAP-05` | `criteria` nonce rejects a conflicting decoy; captured prompt contains criteria once. | SUPPORTED | SUPPORTED | SUPPORTED | PASS | Yes |
| `CAP-06` | Second MCP turn returns the first-turn nonce from bounded replay, not live REPL state. | SUPPORTED | SUPPORTED | SUPPORTED | PASS | Yes |
| `CAP-07` | `--dir` controls agent roots and all relative file/tool access. | SUPPORTED | SUPPORTED | SUPPORTED | PASS | Yes |
| `CAP-08` | File/directory/list context is an immutable pre-dispatch snapshot with exact set/digests/citations. | GAP | GAP — reads original paths after dispatch | GAP | PASS | Yes |
| `CAP-09` | Dictionary context is consumed exactly or rejected before dispatch as named unsupported context. | SUPPORTED | SUPPORTED — deterministically rejects dict as unsupported | SILENT_GAP — the loader returns serialized JSON text, which the adapter enumerates by character index into corrupted one-character snapshots | PASS | Yes |
| `CAP-10` | Unsupported context kind/path rejects as `CAP-10` before any provider activity. | CURRENT_REJECT | CURRENT_REJECT | CURRENT_REJECT | LOUD-REJECT | Yes |
| `CAP-11` | Mutation after dispatch barrier cannot change captured bytes or digest. | GAP | GAP — original paths remain live | GAP | PASS | Yes |
| `CAP-12` | Declared wall cap yields one classified timeout terminal and no answer success. | SUPPORTED | SUPPORTED | SUPPORTED | PASS | Yes |
| `CAP-13` | Injected host cancellation stops in-flight work and emits no later progress/result. | GAP — backend seam has no signal | GAP — backend seam has no signal | GAP — backend seam has no signal | PASS | Yes |
| `CAP-14` | Adapter-owned child/grandchild PIDs are gone after cancellation and cannot write later. | N/A | UNVERIFIED | N/A | N/A | No |
| `CAP-15` | Exact tokenizer rejects `input_cap+1` before provider call and accepts `input_cap`. | GAP | GAP | GAP | PASS | Yes |
| `CAP-16` | Captured final request proves exact output cap; over-cap generation cannot occur. | GAP | GAP | GAP | PASS | Yes |
| `CAP-17` | Provider-reported decimal charge at ceiling terminates as `max-cost`; missing charge fails loudly. | GAP | GAP | GAP | PASS | Yes |
| `CAP-18` | Attempt `cap+1` is prevented and reports the exact iteration/turn budget reason. | SUPPORTED | SUPPORTED | SUPPORTED | PASS | Yes |
| `CAP-19` | Recursion is either fully evidenced through `CAP-31`/`CAP-32` or recursion config rejects pre-dispatch. | SILENT_GAP — accepts recursion without the required receipts | CURRENT_REJECT — rejects `budget.max_depth`, not `CAP-19` | SILENT_GAP — accepts depth without child identity/usage proof | LOUD-REJECT | Yes |
| `CAP-20` | `agent.spec.tools[]` custom tool schema/input/output execute once; missing tool rejects pre-call. | SILENT_GAP — MCP legacy ignores spec tools | SILENT_GAP — subprocess adapter does not inspect spec tools | SUPPORTED | PASS | Yes |
| `CAP-21` | `config.tools` / `TOOLS.md` Python source works, or the whole run rejects pre-dispatch; never conflated with spec tools. | SUPPORTED | CURRENT_REJECT | CURRENT_REJECT | LOUD-REJECT | Yes |
| `CAP-22` | `output.schema` invalid final payload rejects; valid payload round-trips exactly. | SUPPORTED | CURRENT_REJECT | SUPPORTED | PASS | Yes |
| `CAP-23` | `VALIDATE.md` valid/invalid fixtures follow the declared validation/retry contract, distinct from `output.schema`. | SUPPORTED | SILENT_GAP — subprocess adapter does not inspect `config.validate` | SILENT_GAP — SDK adapter does not inspect `config.validate` | PASS | Yes |
| `CAP-24` | Structured final channel emits one non-empty host result, never progress prose. | GAP | UNVERIFIED | GAP | PASS | Yes |
| `CAP-25` | Empty/whitespace completion is a classified failure, never success. | SUPPORTED | SUPPORTED | SILENT_GAP — empty unstructured `emit_done` can succeed | PASS | Yes |
| `CAP-26` | Duplicate terminal, malformed event, and missing terminal each produce a named protocol failure. | GAP | GAP | GAP | PASS | Yes |
| `CAP-27` | Only selected-provider credentials reach the request/child and none are logged. | GAP | GAP | GAP | PASS | Yes |
| `CAP-28` | Captured environment/request proves telemetry disabled and fixture sink receives zero events. | GAP | GAP | GAP | PASS | Yes |
| `CAP-29` | **Supported Gemini set:** thinking level, Google Search, URL context, code execution, and media resolution are applied exactly or named-rejected pre-dispatch. | SUPPORTED | SUPPORTED — thinking level applies; the other named fields reject pre-dispatch | SUPPORTED — thinking level applies; the other named fields reject pre-dispatch | PASS | Yes |
| `CAP-30` | **Future Gemini set:** `computerUse`, `mapsGrounding`, and `fileSearch` reject pre-dispatch; warning-only ignore is failure. | SILENT_GAP — warning-only/ignored today | CURRENT_REJECT — rejects each field, not `CAP-30` | CURRENT_REJECT — rejects each field, not `CAP-30` | LOUD-REJECT | Yes |
| `CAP-31` | Recursive child provider/model identity is receipt-proven; if unavailable, all recursion config rejects pre-dispatch. | GAP | CURRENT_REJECT — rejects `budget.max_depth`, not `CAP-31` | SILENT_GAP — accepts depth; child identity unavailable | LOUD-REJECT | Yes |
| `CAP-32` | Parent and child tokens/cost reconcile exactly; if unavailable, all recursion config rejects pre-dispatch. | GAP | CURRENT_REJECT — rejects `budget.max_depth`, not `CAP-32` | SILENT_GAP — accepts depth; child usage unavailable | LOUD-REJECT | Yes |
| `CAP-33` | Every successful live call has raw provider-reported input/output tokens and decimal cost; estimates never satisfy it. | GAP | GAP | GAP | PASS | Yes |
| `CAP-34` | Live `McpSessionStore` replays at most eight capped turns across selection; restart makes old ID unknown. | SUPPORTED | SUPPORTED | SUPPORTED | PASS | Yes |
| `CAP-35` | Omitted `backend` and generic `mikro_query` select Mikro before effective deployment; explicit selectors never cross-fallback. | SUPPORTED | SUPPORTED | SUPPORTED | PASS | Yes |

### Matrix consequences

- The matrix is a reconciliation ledger, not a promise that parity already exists. On current evidence, `prime-sdk` is **not eligible** because mandatory current observations fail their required `PASS` or `LOUD-REJECT` oracle.
- Recursion is one contract: because child identity and usage are unavailable, `CAP-19`, `CAP-31`, and `CAP-32` all require `LOUD-REJECT`. Subprocess `prime` currently rejects the field without capability IDs, while Mikro and `prime-sdk` accept recursion without the required receipts; all fail the exact required oracle.
- `CAP-29` contains only the supported Gemini set. `CAP-30` contains future flags and requires loud rejection. Implementing those flags is unrelated provider work and needs another approved wish.
- `CAP-09` is not a positive `prime-sdk` path. For a JSON object, `loadContextFromFile()` (and `loadContext()` through its file branch) returns `LoadedContext { type: "dict", content: <serialized JSON string> }`; `planContextSnapshots()` then applies `Object.entries()` to that string, producing one snapshot per character index with one-character content instead of keyed dictionary values. The existing hand-built object-shaped/double-cast test does not represent production loader output. The v2 capability fixture must expose this corruption and fail the required `PASS`; this child must not parse the string or implement the future dictionary fix.
- A later parity wish may replace a `GAP` with implementation and produce a new frozen candidate. This reconciliation child never marks that future work complete.

## Executable exact-control campaign

### Included legs and arithmetic

Only Mikro and `prime-sdk` enter the eligibility campaign:

- 2 runtimes (`mikro`, `prime-sdk`)
- 2 models (`deepseek/deepseek-v4-flash`, `zai/glm-5.2`)
- 6 tasks (`T01`–`T06`)
- 5 repetitions

Scored calls: `2 × 2 × 6 × 5 = 120`.

Control probes: one per runtime/model pair: `2 × 2 = 4`.

**Exact campaign total: 124 calls.** There are no retries, replacements, subprocess `prime` calls, Gemini calls, or hidden capability calls in this total.

### Call-to-fixture map

The execution wish must create these committed files before any live call:

- `tests/fixtures/prime-gate-v2/call-map.json` — explicit 124-row map.
- `tests/fixtures/prime-gate-v2/tasks/T01.json` through `T06.json` — prompt/fixture/answer-key digests and deterministic oracle.
- `schemas/prime-campaign-call.schema.json` — strict call-row schema (`additionalProperties: false`).
- `schemas/prime-control-receipt.schema.json` — strict pre-call/outbound/provider receipt schema.
- `scripts/validate-prime-campaign-map.mjs` — independently constructs the Cartesian set and proves exact set equality, IDs, counts, fixture existence/digests, and absence of `prime`.
- `scripts/validate-prime-capability-map.mjs` — proves exactly `CAP-01`–`CAP-35`, required status enums, fixture digests, and `provider_calls: 0` for each deterministic capability fixture.
- `scripts/validate-prime-evidence.mjs` — joins every call to exactly one map row and validates controls, raw receipt digests, usage/cost, score, and aggregate populations.

`CAP-09` has an additional loader-shaped fixture contract. The deterministic fixture must create an actual `.json` file containing a plain object with at least two distinguishable values, then exercise both production loader entry points: call `loadContextFromFile(path)` in one case and `loadContext(path)` in another. In each case it must pass the exact returned `LoadedContext` object, unchanged and without casts or object reconstruction, as the `prime-sdk` adapter request context. With an injected zero-call transport, it must assert the current one-character/indexed snapshot corruption and the absence of the original dictionary values as complete snapshot contents; that observation records `SILENT_GAP` and fails the required `PASS`. A future separately approved parity wish may instead prove exact keyed consumption or capability-ID pre-dispatch rejection.

IDs and fixtures are deterministic:

| Kind | ID template | Rows | Fixture mapping |
|---|---|---:|---|
| Control | `P-{runtime}-{model}` | 4 | `control/provider-control-v2.json`; one each for the 2 × 2 runtime/model set |
| Scored | `S-{runtime}-{model}-{task}-R{01..05}` | 120 | Each task ID maps to exactly one `tasks/{task}.json`; each runtime/model/task has repetitions `R01`–`R05` |

The map validator rejects missing, extra, duplicate, retried, replaced, unknown-fixture, digest-mismatched, or out-of-order start-plan rows before network use. The evidence validator rejects any result row not in the map. Capability fixtures run against deterministic injected transports with zero live provider calls; they do not inflate or hide inside 124.

The removed legacy benchmark v1 files, manifests, tests, and any surviving historical outputs are superseded and outside this design. They must not be recreated, validated as a substitute, merged into the v2 manifest, or cited for any success criterion, matrix verdict, campaign gate, owner decision, or acceptance claim. Only the evidence-first 35-row capability map and exact 124-call v2 design are admissible here.

### Exact-control proof sources

The harness calls the in-process backend APIs through a test-only injected transport that captures the final outbound request bytes before forwarding them. It does not infer provider defaults.

For every one of the 124 mapped calls:

1. **Harness receipt** must prove exact final-message bytes, manifest-bound tokenizer/model and input count `≤ 32,768`, a `1,024` output-token request, a `120,000 ms` abort timer, no-retry ID, and budget reservation.
2. **Captured outbound request** must prove provider, endpoint, model, system ordering, numeric temperature `0`, reasoning disabled, output cap `1,024`, selected credential only, and telemetry-off fields/headers.
3. **Raw provider receipt** must prove request/provider ID, returned model, input/output tokens, currency, and positive decimal cost.
4. The three receipts must join on `call_id`, runtime, model, request identity, and request digest.

If either in-process runtime cannot expose the final request, transmit an exact control, enforce the timer/input bound, or return a raw usage/cost receipt, its probe records `UNPROVABLE` and the campaign ends `CAMPAIGN_NO_GO` before scored calls. `UNSUPPORTED`, omitted, defaulted, catalog-estimated, zero-filled, normalized, or inferred evidence is never `APPLIED_EXACT`. Controls or receipts impossible to prove fail closed; no adapter is changed in this child to manufacture observability.

### `prime` observational boundary

The subprocess `prime` surface may receive separately authorized observations only:

- at most two live probes, `O-prime-{model}`, one per frozen model; and
- deterministic fallback-capability probes using synthetic fixtures.

These observations disclose unsupported/unobservable controls honestly, use their own map/report/spend authorization, and are excluded from the 124-call campaign, candidate eligibility, quality/cost ratios, and owner eligible set. They may support a future fallback-operability decision only. No “normalized” subprocess score is compared to exact-control arms.

## Evidence manifest

Canonical manifest JSON is UTF-8, recursively key-sorted, duplicate-key-free, decimal-as-string, and ends in one LF. SHA-256 digests are lowercase over raw bytes. `manifest_sha256` hashes the canonical document with that field omitted.

Required bindings:

- exact commit, tree, base, clean status receipt, measured-file allowlist and set equality;
- exact Prime 0.8.1 SDK and CLI package identities, entrypoint/binary digests, lock integrity, and installed tarball digest;
- complete corpus, call map, capability map, schemas, validators, task/oracle, tokenizer, and harness digests;
- Node/OS/runtime, models, resolved providers/endpoints, controls, order seed, caps, prices, spend authorization, credential variable names/presence only, and telemetry setting;
- exactly 4 probe plus 120 scored call records for the exact-control campaign;
- per-call harness, captured-request, and raw-provider receipt digests with provider-reported usage/cost;
- separate observational `prime` report when explicitly authorized, never merged with campaign evidence;
- capability, quantitative, rollback, authorization, final-selection, review, and delivery report digests when each exists.

Secret values, prefixes, lengths, hashes, and raw model responses are forbidden from tracked evidence. Missing/extra/dirty/unresolved/hash-mismatched data makes the relevant gate fail closed.

## Quantitative eligibility gate

### Populations

- Each runtime has exactly 60 scored calls; each runtime/model has 30.
- Correctness uses all mapped scored calls. A deterministic oracle pass scores integer `1`; every wrong answer or failure scores `0`.
- Cost median uses only completed, protocol-valid calls with complete provider usage/cost. Wrong-but-well-formed calls remain in this population.
- Latency uses all mapped calls. Timeout, cancellation, empty, protocol, transport, or other right-censored calls are charged exactly `120,000 ms`.
- Missing/extra/retried/replaced/unscored calls make the campaign incomplete. Missing provider usage/cost is a reliability failure and cannot be replaced by a local estimate.

### Floors

For each model, `prime-sdk` must pass at least `4/5` repetitions for every task and `27/30` overall. Across both models it must pass `54/60`. It must have no fewer passes than Mikro for each task/model cell, each model aggregate, and overall.

Candidate reliability requires zero timeouts, cancellations, empty responses, protocol failures, transport failures, process crashes, unclassified errors, missing usage, or missing provider cost.

For each model and overall:

- median provider-reported cost must be `≤ 1.05 ×` Mikro;
- nearest-rank p95 all-call latency must be `≤ 1.10 ×` Mikro;
- every mandatory matrix row must match `prime-sdk required`; and
- map/schema/evidence validators, repository gates, rollback oracle, authorization chain, review, and delivery gates must pass on their exact bound identities.

Sort numeric populations ascending. Odd median is item `(n+1)/2`; even median is the exact decimal mean of items `n/2` and `n/2+1`. p95 is item `ceil(0.95 × n)` (29 of 30; 57 of 60). Cost math uses arbitrary-precision base-10 decimals; latency/counts are integers. Exact inclusive comparisons use unrounded values. Display-only costs/ratios round half-up to 12 decimals and milliseconds/ratios to 3. Empty populations, zero Mikro denominator, unknown/non-positive prices, unconvertible currency, NaN/infinity, overflow, or raw/display verdict disagreement fail closed.

## Two-stage authorization and non-effective mutation

Eligibility is not authorization; authorization to prepare is not final selection; final selection is not deployment.

1. **Frozen pre-mutation reconciliation.** Build the matrix and, only if controls are provable, the 124-call report on an identity where omitted `backend` selects Mikro. A truthful ineligible/no-go report is a valid completion.
2. **Felipe authorization to prepare.** A first artifact contains exactly `AUTHORIZE_PREPARE_PRIME_SDK` or `DO_NOT_PREPARE`, Felipe identity, UTC timestamp, source message reference, pre-mutation SHA/tree, manifest/report hashes, and acknowledgement that this permits one non-effective candidate only.
3. **Isolated post-mutation candidate.** Only `AUTHORIZE_PREPARE_PRIME_SDK` permits default-selection code/schema/templates/docs to change on a new SHA/tree. Install and exercise it only in an ephemeral, access-isolated local sandbox whose config, package prefix, process namespace, ports, and state are disjoint from main/public/remote dev. The sandbox has no promotion credentials or deployment route. Run the complete matrix, 124-call campaign (if feasible), repository gate, manifest validation, and MCP rollback there. Destroy it after receipt capture. This produces evidence without making the mutation effective anywhere.
4. **Felipe final selection.** A distinct artifact contains exactly `FINAL_SELECTION = keep-mikro | select-prime-sdk`, Felipe identity, UTC timestamp, source reference, isolated post-mutation SHA/tree and installed-artifact digest, manifest/capability/quantitative/rollback hashes, and eligible set. Missing, stale, ambiguous, or ineligible selection means `keep-mikro` operationally.
5. **Independent immutable review.** Only after final selection may a separate read-only reviewer approve the exact post-mutation identity and all bound evidence. The reviewer cannot mutate artifacts or substitute owner intent.
6. **Remote dev and delivery.** Remote-dev integration/install/read-back occurs only after `select-prime-sdk` **and** independent review `SHIP`, through the separately owner-approved `mikro-dev-release-promotion` child. A different ordering would require a separate explicit Felipe dev-only deployment authorization artifact; this design grants none. Failed/stale remote receipts block effectiveness and leave Mikro installed/default.
7. **Effectiveness.** Merge/release/deployment may make `prime-sdk` effective only after final selection, independent review, and delivery identity/read-back gates all pass. Any missing/failed/stale gate leaves Mikro effective. No backend is deleted.

## Rollback oracle

The in-scope store is MCP's live in-process `McpSessionStore`: TTL 30 minutes, at most 64 sessions, at most eight retained turns, bounded replay bytes, and no persistence claim. Restart loss is expected.

In the isolated sandbox, create a session, complete planted turns, then install the rollback candidate that restores omitted/default selection to Mikro without deleting the store. The same session ID must select Mikro, replay only the newest eight capped turns, recover the nonce, and perform no conversion write. After server restart, the old ID must be unknown. With rollback installed, omitted `backend` and generic `mikro_query` must select Mikro; explicit selectors remain explicit and never cross-fallback.

## Delivery dependency

This design depends on a separately owner-approved `mikro-dev-release-promotion` child for real remote `dev`, exclusive integration, compare-and-fast-forward control, CI `headSha`, installed-checkout read-back, and revert/retention behavior. This reconciliation child neither creates nor operates that lane. The dependency is admitted only after final selection and independent review unless Felipe separately authorizes dev-only deployment, which is not part of this design.

## Decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | Evidence/reconciliation may conclude Prime ineligible | Truthful no-go evidence is safer than parity work hidden inside selection. |
| 2 | `prime-sdk` alone is default-eligible | It is the intended in-process candidate. |
| 3 | Opaque `prime` is observational only | Its CLI cannot prove the exact controls or raw receipts required for quality/cost comparison. |
| 4 | Mandatory unavailable parity fails | `GAP` and `UNVERIFIED` never become synthetic `PASS`. |
| 5 | Recursion rejects until child identity and usage are provable | Depth without identity/accounting is not safe parity. |
| 6 | Supported and future Gemini flags are separate | Future warning-only flags require loud rejection, not implementation in this child. |
| 7 | Post-mutation evidence is isolated and non-effective | Evidence cannot depend on an unauthorized remote deployment. |
| 8 | Remote dev follows final selection and independent review | This removes circular authorization. |
| 9 | Mikro remains default on every failed/incomplete/stale gate | Retention is the fail-closed outcome. |
| 10 | Deletion remains out | Selection and removal have different rollback risks. |

## Risks

| Risk | Mitigation |
|---|---|
| Current gaps make the candidate ineligible | Record the result; propose separate future wishes only after Felipe approves their product value. |
| A control looks configured but is not transmitted | Require captured final request bytes; inferred/defaulted controls fail. |
| Provider usage/cost is absent | Fail closed; never zero-fill or use catalog estimates. |
| Observational `prime` data is mistaken for comparable evidence | Separate IDs, map, report, authorization, and explicit exclusion from eligibility. |
| Post-mutation evidence changes a shared environment | Use an isolated sandbox with no deployment route; remote dev comes later. |
| Owner preparation approval is mistaken for selection | Separate vocabularies, identities, hashes, and stages. |

## Success criteria

- [ ] Matrix validator proves exactly 35 sequential rows and every row records current truth separately from required eligibility behavior.
- [ ] Known current behavior is classified as `SUPPORTED`, field-oriented `CURRENT_REJECT`, `SILENT_GAP`, `GAP`, or `UNVERIFIED`; no unavailable mandatory capability is reported `PASS`.
- [ ] `CAP-29` supported Gemini and `CAP-30` future Gemini are distinct; future flags are required to capability-ID loud-reject even though both Prime adapters currently reject only by field.
- [ ] `CAP-19`, `CAP-31`, and `CAP-32` consistently require recursion rejection while child identity/usage are unavailable.
- [ ] `CAP-09` uses a real JSON file and both production loader entry points, passes each exact returned `LoadedContext` unchanged to `prime-sdk`, and records the current serialized-string-to-character-snapshot behavior as `SILENT_GAP`; no object-shaped cast or future dict fix can satisfy the fixture.
- [ ] Exact-control campaign contains only Mikro and `prime-sdk`, exactly 4 probes plus 120 scored calls, with schema-validated set-equal call/fixture maps.
- [ ] Every campaign call has joined harness, captured outbound request, and raw provider receipt evidence, or the campaign ends fail-closed before scoring.
- [ ] `prime` observations are separately authorized and cannot affect eligibility, quality, cost, latency, or owner eligible set.
- [ ] A valid reconciliation may end `PRIME_SDK_INELIGIBLE`/`CAMPAIGN_NO_GO`, retaining Mikro without parity implementation.
- [ ] Any foundational parity implementation is proposed as a separate future wish and has no completed status here.
- [ ] Post-mutation reruns occur only in a non-effective isolated sandbox before Felipe's final selection.
- [ ] Remote dev occurs only after final selection plus independent review, absent a separate explicit dev-only authorization not granted here.
- [ ] Two-stage Felipe authorization remains exact and distinct; any stale/missing/failed state retains Mikro.
- [ ] No backend deletion enters scope or diff.

## Next step

Validate this DRAFT locally. Do not run review, benchmarks, network calls, runtime mutations, owner gates, or remote-dev operations in this planning step. After validation, a later explicit instruction may request independent design review.

<!-- genie-design-review:start -->
## Design Review Evidence

- **Verdict:** SHIP
- **Reviewed content SHA-256:** `b727da909205766bf6078c1a92ae62965c228d0c25858a017bf69e125f11bc4e`
- **Reviewer:** `openai-codex:gpt-5.6-sol-900k`
- **Reviewed at:** `2026-09-01T05:32:35Z`
<!-- genie-design-review:end -->
