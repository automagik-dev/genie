# Wish: Genie Bench — attempt engine, native OMP adapter and smoke evidence (wave 1)

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `genie-bench` |
| **Date** | 2026-10-09 |
| **Author** | Felipe Rosa |
| **Appetite** | large |
| **Branch** | `wish/genie-bench` (one branch per group: `wish/genie-bench-g<n>`) |
| **Repos touched** | automagik-dev/genie |
| **Design** | [DESIGN.md](../../brainstorms/genie-bench/DESIGN.md) |

## Summary

This is the first executable wave of the reviewed Genie Bench design (design SHIP 2026-10-04, digest `6acd07d9…`, preflight re-verified 2026-10-09). It builds the operator-invoked engine under `scripts/bench/`: versioned contracts, one durable per-attempt journal, the deterministic task-manifest freeze and preregistered schedule, a finite attempt supervisor bound to the original verifier, presence-preserving native OMP capture and request accounting, and the visible native OMP adapter. Its last group runs the native capability preflight, freezes the 20-task manifest and runs the two integration smoke tasks in both arms. That group is blocked until the design's hard prerequisites are proven. The 120 scored attempts, analysis/release export, Phoenix reconciliation, the other four harnesses, the website and the improvement engine are sibling wishes, named under `## Dependencies`. This plan claims no benchmark runtime, scored result or performance gain.

## Scope

### IN

- `scripts/bench/contracts.ts`: versioned task, eligibility, configuration, treatment-pin, attempt-identity, state-machine, event-envelope, native-request and adapter contracts (design IN 1, 10, 16). `scripts/bench/README.md` is the operator contract.
- `scripts/bench/ledger.ts`: one host-owned per-attempt journal with durable checkpoints, fail-closed corruption handling and identity-checked recovery. The whole campaign is registered before any launch (design IN 2, 14; §5).
- `scripts/bench/pilot.ts` (`freeze`, `replace`, `schedule`): eligible-pool freeze, deterministic pre-outcome replacement in bytewise original-task-ID order within source/category, a hard stop on insufficient quota, and seeded paired interleaving of 20 tasks × 3 repeats × 2 arms (design IN 3, 5; §3–4).
- `scripts/bench/run.ts` (`preflight`, `attempt`, `recover`, `status`): a finite supervisor. It drives a native adapter through registered → running → execution stopped → verified | terminal failure → capture sealed, on an external monotonic clock. The original verifier runs outside solver mounts against the digest-bound collected artifact (design IN 2, 11; §1, §5).
- `scripts/bench/capture.ts`: bounded native OMP evidence from the per-attempt isolated home: sessions, actor graph with parentage and pending work, model requests, input/approval/interruption origin events, and capture health. Unknown stays null (design IN 12, 13 origin capture; §5–7).
- `scripts/bench/accounting.ts`: whole-attempt request economics. Distinct dispatch attempts, native token-convention validation, cache 5m/1h buckets, a pinned price basis, and cost/attempt plus cost/accepted-task that stay undefined when required costs are missing or acceptance is zero (design IN 2; §6).
- `scripts/bench/adapters/omp.ts`: the stock interactive OMP client on a genuine PTY the operator can attach to. It consumes the pinned treatment contract for the Genie arm and leaves every discovery root Genie-free for the zero-Genie arm (design IN 10, 11; §2, §4).
- Native capability preflight, the frozen `scripts/bench/tasks/public-pilot.json` manifest, `scripts/bench/tasks/omp-sol-medium.json` configuration, and both-arm smoke receipts for `actionlint-action-pinning-lint` and `session-window-debug`. These are **blocked-on-prerequisite** (Group 8; design IN 5 smoke; SC2–SC4).
- `tsconfig.json` `include` gains `scripts/bench/**/*` so the repository gate type-checks the engine. This is the only validation-configuration change the new entry points require (design line 47).

### OUT

- Intelligence/IQ composites, guaranteed superiority, full-suite upstream-score claims from a selected subset.
- Newly authored scored tasks; altered source prompts, oracles or reward thresholds; homegrown wish scoreboards; reference-answer access or solver-controlled grading.
- Headless/print/RPC/SDK replacement of the actual client; mandatory Genie workflow stages or forced delegation on every task. A test-only fake adapter inside `*.test.ts` is a fixture, never registered and never a solver.
- Automatic promotion, merge, release, permission weakening or direct edits to installed/user-owned guidance.
- Amendment of the approved observe wish, the proposal-only weekly workflow, the reviewed OMP adaptation, or `src/lib/metrics-*.ts` (the lifecycle-capture owner's modules). This wish imports their exports read-only.
- New agent-called telemetry commands, model turns or stages; Genie resident processes; always-on capture or network; hardcoded Phoenix endpoint, project or credential; copied secret material.
- A live leaderboard service, extra operational database, event plugin framework, delta/cache/sharding protocol, or automatic benchmark-source upgrades.
- Within this wish (owned by the sibling wishes below): the 120 scored attempts, autonomy labelling, analysis and release export, Phoenix projection, the Claude Code/Codex/DeepSeek/Hermes adapters, the website consumer, and the improvement engine.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Wave 1 ends at manifest freeze + both-arm smoke. Scored execution and everything downstream are sibling wishes | Smallest set that produces real evidence (original verifier receipts + native preflight + journal) inside the admission band; the design's sixteen items do not fit one wish |
| 2 | The engine is `bun scripts/bench/<file>.ts <verb>` operator tooling, not a `genie` CLI command | Design §1: operator infrastructure, not a Genie daemon or product surface. No `src/genie.ts`, CLAUDE.md command-table or knip `project` change |
| 3 | Every verb requires an explicit `--root <dir>` for private receipts; there is no default location | Owner rule "nothing on by default and nothing hardcoded". Missing `--root` exits 2 and writes nothing |
| 4 | Exit codes follow the mikro vocabulary: 0 ok, 1 not ok, 2 refusal that cost nothing | One house convention for operator scripts (`scripts/mikro/*`) |
| 5 | `src/lib/metrics-*.ts` is consumed read-only: `matchOmpSessionByCwd`/`PiSessionMatch` (`metrics-usage.ts`), `loadPriceTable`/`tableCost`/`PriceTable` (`metrics-prices.ts`). `UsageSample` sums are NOT reused | `metrics-usage.ts` `num()` maps a missing count to 0, which violates "unknown is null". The bench parses records with per-field presence, and editing the capture owner's modules is out of scope (design §8) |
| 6 | OMP launch = stock interactive client on a genuine PTY inside a per-attempt `tmux -L <attemptId>` session (argv array, tmux ≥ 3.2 recorded by preflight), no `--print`/`--mode` | Design §2 requires the visible native client and reports the launch mechanism. The machine-local NATIVE-OMP note recommends a genuine PTY with the task as one argv value. tmux makes it attachable and is already a Genie host dependency. Preflight must prove it, or G8 stays blocked |
| 7 | With a fresh per-attempt native home, OMP session linkage is `match=isolated-home` when exactly one top-level session exists there. Otherwise null/ambiguous. Window matching (`matchOmpSessionByCwd`) is labelled `match=window` and used only as a fallback | Design §2: never call heuristic linkage exact. Isolation is the stronger, provable basis |
| 8 | Settled state is the native authoritative signal only. With no such TUI signal, the adapter reports `settledSignal: 'unsupported'` and preflight fails | Design §2, §5: no quiet-interval polling or last-text heuristic. A missing capability is a named upstream requirement |
| 9 | Proposed sibling slugs are listed as prose under Dependencies, and `**depends-on:**`/`**blocks:**` stay `none` until each sibling's WISH.md exists | `bun run wishes:lint` refuses a reference to a missing wish slug. Each sibling adds its edge when scaffolded |

## Simplicity Case

- **Simplest complete design:** five engine modules plus one adapter, on one append-only JSON-lines journal per attempt under an operator-named root. Contracts are zod schemas, and supervision is a finite fork-and-exit run. Nothing runs unless an operator invokes a verb with `--root`.
- **Added machinery:** (a) the per-attempt journal and pre-launch campaign registration: scheduled failures must survive independently of traces (design §5, SC7). (b) The O_EXCL supervisor lock: "one supervisor owns journal mutation" (§5). (c) Per-field presence flags on request records: unknown must stay null (§6, SC5). (d) The seeded schedule: paired order must be fixed before outcomes (§4). Each is a present design contract.
- **Deferred until measured:** a generic adapter registry (one adapter now; a map literal suffices), downloadable SQLite, distributed scheduling, caching and sharding. Reconsider each only against an observed host/export limit or a reviewed consumer requirement.
- **Complexity removed:** no replacement agent loop, no telemetry model calls, no new task DB (the per-repo `genie.db` is untouched), no Phoenix network in this wish, no edits to `src/lib/metrics-*`, and no default paths or endpoints.

## Dependencies

**depends-on:** none
**blocks:** none

External and cross-wish prerequisites. Each one blocks the named group and is never substituted with a smaller pilot, a headless client or an altered oracle:

| # | Prerequisite | Blocks | Exact proof that unblocks |
|---|--------------|--------|---------------------------|
| P1 | Native OMP capability preflight in the actual visible client | G8 | `bun scripts/bench/run.ts preflight --root <private> --adapter omp --config scripts/bench/tasks/omp-sol-medium.json --arm <zero-genie\|genie>` exits 0 for **both** arms on the operator host. The stored `CapabilityReport` has every `REQUIRED_CAPABILITIES` field `proven`, including `settledSignal` (authoritative native settled state covering pending children/wakes), child/auxiliary model+effort control, request usage fields and input-origin fields. Any `unsupported` field names its upstream requirement and keeps G8 blocked |
| P2 | Original-task/oracle eligibility clearance | G8 | An operator-authored eligibility pool file in which every candidate carries source revision, artifact-level license/provisioning clearance, image/input/verifier digests and judge settings. SWE-Atlas test-writing HOLDs are resolved against intact original grading, and SkillsBench native lifecycle parity is shown. `bun scripts/bench/pilot.ts freeze --pool <file> --out scripts/bench/tasks/public-pilot.json` exits 0 with 20 selected and quotas DeepSWE 6 / Terminal-Bench 4 / SWE-Atlas 6 (qa 2, tw 2, rf 2) / SkillsBench 4, and with no `unresolved` entry |
| P3 | Authenticated GPT-6.1 Sol medium route for OMP | G8 | The P1 preflight report records requested model/effort and the observed response/upstream model and effort for a lead, a natural child and an auxiliary call in both arms. A version string or catalog entry is not proof |
| P4 | Pinned OMP-native Genie treatment (the `genie-omp` design's item 5 "pinned treatment contract for Genie Bench") | G8 Genie arm | The `genie-omp` wish (not yet planned; it waits on its own upstream P0, a supported pinned OMP build) is SHIPPED with a treatment contract naming resource paths + sha256. `preflight --arm genie` verifies those hashes in the fresh home |
| P5 | The operator's Phoenix server | sibling `genie-bench-phoenix` | Operator-supplied endpoint/project/API-key env name. One exact span id + payload digest is posted and read back by id |
| P6 | The future Automagik website project | sibling `genie-bench-website` | That project's repository and wish exist with owned consumer files |

Proposed sibling wishes (not yet created; each adds `**depends-on:** genie-bench` when scaffolded):

- `genie-bench-omp-pilot`: registers and runs the 120 scored OMP attempts with every disposition retained (SC2 full, SC3, SC4 full; design IN 5). Depends on `genie-bench` (G8 done) and `genie-omp`.
- `genie-bench-analysis`: `scripts/bench/metrics.ts`, `scripts/bench/taxonomy.json`, `scripts/bench/analysis.ts`, `scripts/bench/export.ts`. Covers frozen extraction, Verified Autonomy Rate and versioned labels, paired task-cluster uncertainty, frozen-core/refreshed epochs, immutable release tables, the public allowlist and the website data contract (SC6 classification, SC9, SC12; design IN 3 analysis, 4, 13, 14 export, 16).
- `genie-bench-phoenix`: `scripts/bench/phoenix.ts`. Reconciles by exact stored identity plus payload digest (not `projectToPhoenix`'s send-only-missing-id). Blocked on P5 (SC8; design IN 12 Phoenix).
- `genie-bench-harnesses`: `scripts/bench/adapters/{claude-code,codex,deepseek,hermes}.ts` plus their configuration manifests, one group per harness. Each is blocked on its own authenticated route and native preflight (SC11; design IN 6–9).
- `genie-bench-website`: the rendered consumer in the website project. Blocked on P6 (SC10).
- `genie-bench-improve`: `scripts/bench/improve.ts`, for isolated candidates, all-trial ledger, restricted locked evaluation and operator-approved promotion (SC13; design IN 15).

## Success Criteria

Design criterion → owner. A sibling-owned row is not closed by this wish.

| Design SC / IN item | Owner in this wish | Remainder owned by |
|---|---|---|
| SC1 complete scope & planning | this plan (all 16 IN items mapped below) + independent plan review | — |
| SC2 task/oracle integrity | G3 (freeze/replace), G4 (verifier isolation + artifact digest, tamper/refusal cases), G8 (frozen manifest, eligibility ledger; P2) | `genie-bench-omp-pilot` (20-task execution) |
| SC3 actual native OMP pair | G7 (adapter), G8 (preflight + smoke; P1, P3, P4) | `genie-bench-omp-pilot` |
| SC4 smoke then full pilot | G3 (schedule registers 120), G2 (all dispositions retained), G8 (smoke both arms) | `genie-bench-omp-pilot` (120 dispositions) |
| SC5 whole-attempt economics | G5 (request inventory), G6 (accounting), G8 (real main/child/aux capture) | — |
| SC6 autonomy & input evidence | G5 (input/approval/interruption origin capture) | `genie-bench-analysis` (labels, VAR) |
| SC7 durable recovery & authority | G2, G4, G7 (pending children in settled state) | — |
| SC8 Phoenix reconciliation | — | `genie-bench-phoenix` (P5) |
| SC9 immutable release data | — | `genie-bench-analysis` |
| SC10 static website consumer | — | `genie-bench-website` (P6) |
| SC11 later named harnesses | G1 (harness-neutral adapter contract) | `genie-bench-harnesses` |
| SC12 longitudinal analysis | G1 (epoch/cohort fields) | `genie-bench-analysis` |
| SC13 safe autonomous improvement | — | `genie-bench-improve` |
| SC14 transparent lightweight behavior | G4 (no daemon, explicit `--root`), G5 (bounded, no model action), G8 (on/off overhead probe) | — |
| SC15 verified integration quality | every group (`bun run check` + changed-path smoke) | every sibling |
| IN 1 contracts | G1 | — |
| IN 2 supervisor + accounting | G2, G4, G6 | — |
| IN 3 paired pilot + analysis | G3 | `genie-bench-analysis` |
| IN 4 static DB + website contract | — | `genie-bench-analysis`, `genie-bench-website` |
| IN 5 execute OMP pilot | G8 (manifest + smoke) | `genie-bench-omp-pilot` |
| IN 6–9 Claude Code / Codex / DeepSeek / Hermes | — | `genie-bench-harnesses` |
| IN 10 consume pinned OMP adaptation | G1 (`TreatmentPin`), G7 | `genie-omp` delivers it (P4) |
| IN 11 actual native client + visible UI | G4, G7 | `genie-bench-harnesses` |
| IN 12 capture + Phoenix mapping | G5 | `genie-bench-phoenix` |
| IN 13 autonomy measurements | G5 (origin capture) | `genie-bench-analysis` |
| IN 14 engine + immutable exports | G2, G4 | `genie-bench-analysis` |
| IN 15 autonomous improvement | — | `genie-bench-improve` |
| IN 16 longitudinal comparison | G1 | `genie-bench-analysis` |

This wish is complete when:

- [ ] G1–G7 are merged with `bun run check` green and every group's acceptance criteria met.
- [ ] G8 has stored P1 preflight reports for both arms, a frozen `public-pilot.json` that `pilot.ts verify` accepts, and smoke receipts for both integration tasks in both arms carrying original verifier output. It is otherwise recorded as BLOCKED with the failing prerequisite named. A blocked G8 leaves this wish IN_PROGRESS, never SHIPPED.
- [ ] No file under `src/` changes. `src/lib/metrics-*.ts` is unchanged (`git diff --stat origin/dev -- src/` is empty).

## Execution Strategy

### Wave 1 (sequential)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 1 | engineer | medium: every later group binds to these shapes; a wrong field forces a cascade | inherit | Contracts, README, tsconfig include |

### Wave 2 (parallel, disjoint files)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 2 | engineer | high: durability, fail-closed corruption and recovery invariants | inherit | Attempt journal + campaign registration |
| 5 | engineer | high: native log formats, presence semantics, untrusted input | inherit | Native OMP capture |

### Wave 3 (parallel, disjoint files)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 3 | engineer | medium: deterministic, outcome-blind selection and seeding | inherit | Manifest freeze/replace + paired schedule |
| 4 | engineer | high: state machine, external clock, verifier isolation, process control | inherit | Attempt supervisor |
| 6 | engineer | medium: token conventions, null propagation, price pinning | inherit | Request accounting |

### Wave 4 (sequential)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 7 | engineer | high: PTY/tmux control, discovery isolation, treatment-hash verification | inherit | Visible native OMP adapter |

### Wave 5 (sequential, blocked-on-prerequisite P1–P4)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 8 | engineer | high: real client, real oracles, operator-host evidence; blocked until P1–P4 are proven | inherit | Native preflight, manifest freeze, both-arm smoke |

**Global constraints:**
- Transparent instrumentation with zero added LLM actions: no agent-called span/start/end command, no telemetry model turn or stage; capture happens outside the solver context or through native metadata surfaces.
- Nothing on by default and nothing hardcoded: endpoints, keys, projects, roots, model routes and price tables arrive through configuration files or arguments; a missing one is a refusal (exit 2), never a fallback.
- Unknown is null, never 0: a known zero needs an explicit source basis; missing tokens, prices, usage or origin make the dependent metric unavailable.
- Linux + macOS: no `/proc`, GNU-only flags or platform literals in source or tests without checking both CI legs; Windows is not a target.
- Manual-first, scheduling last: every verb is operator-invoked and finite; no cron, timer, daemon or auto-start.
- The repository gate `bun run check` is required for every group; a group's own focused tests never replace it.
- Parallel writers need disjoint file ownership (the waves above are disjoint by construction); only the orchestrator moves HEAD.
- Genie is zero-daemon; the engine creates no `genie.db` and no machine-scope task database; one supervisor owns journal mutation.
- Original task prompts, oracles, thresholds and resource limits are never altered; solvers never see verifier, rubric, reference solutions or this research.
- Secrets never on argv, in logs, journals or snapshots; an API key is named by env-var NAME only (`PhoenixExportTarget.apiKeyEnv` convention).
- Biome: single quotes, 2-space indent, 120 columns, trailing commas; no `console.log` in source (use `process.stdout.write`/`process.stderr.write`). `scripts/**` has the Biome complexity rule off; keep functions linear per the repository's ≤ 25 guidance anyway.
- Tests use `bun:test`, temp dirs with cleanup, `GENIE_HOME` set to a temp dir whenever a Genie path could resolve, real git repos for git behaviour.

## Execution Groups

### Group 1: Versioned bench contracts

**Goal:** Define every boundary type the engine and its siblings bind to, as zod schemas with typed parse results, plus the operator README.

**Deliverables:**
1. `scripts/bench/contracts.ts` (new) with the exports below. Every schema carries `schemaVersion: 1`, and unknown keys are refused.
2. `scripts/bench/contracts.test.ts` (new): parse success/refusal per schema, the full legal/illegal `ATTEMPT_TRANSITIONS` matrix, a `null` vs `0` round-trip, and refusal of a request record that claims a known zero with no `presence` basis.
3. `scripts/bench/README.md` (new): purpose, the "selected public tasks" label, the verbs and exit codes, the explicit `--root`, the prerequisites P1–P6, and what is never claimed.
4. `tsconfig.json`: `"include": ["src/**/*", "scripts/bench/**/*"]`.

**Interfaces:**
- Consumes: none
- Produces:
  - `export const BENCH_SCHEMA_VERSION = 1`
  - `export type Result<T> = { ok: true; value: T } | { ok: false; issues: string[] }`
  - `export type Harness = 'omp' | 'claude-code' | 'codex' | 'deepseek' | 'hermes'`; `export type ArmId = 'zero-genie' | 'genie'`
  - `export type SourceKind = 'deepswe' | 'terminal-bench' | 'swe-atlas' | 'skillsbench'`; `export type ArtifactTransport = 'committed-patch' | 'directory' | 'answer'`
  - `export interface TaskIdentity { source: SourceKind; sourceRevision: string; taskId: string; category: string; cluster: string; artifactTransport: ArtifactTransport; imageDigest: string | null; verifierDigest: string | null; timeLimitSec: number | null }`; `export const taskKey: (t: TaskIdentity) => string` (`<source>/<category>/<taskId>`)
  - `export type Eligibility = { status: 'eligible'; clearance: EvidenceRef[] } | { status: 'ineligible'; reason: string } | { status: 'unresolved'; blocker: string }`
  - `export interface PoolEntry { task: TaskIdentity; eligibility: Eligibility }`; `export type Quotas = Record<string, number>` (key `<source>/<category>`)
  - `export interface ReplacementRecord { replaced: string; by: string; reason: string; recordedAt: string }`
  - `export interface TaskManifest { schemaVersion: 1; manifestId: string; poolDigest: string; quotas: Quotas; selected: TaskIdentity[]; replacements: ReplacementRecord[]; smoke: TaskIdentity[]; frozenAt: string }`
  - `export interface TreatmentPin { contract: string; resources: Record<string, string /* sha256 */> }`
  - `export interface HarnessConfiguration { schemaVersion: 1; configId: string; harness: Harness; executable: string; requestedModel: string; requestedEffort: string; treatment: TreatmentPin | null; epoch: string; cohort: string }`
  - `export interface AttemptIdentity { experimentId: string; pairId: string; manifestId: string; taskKey: string; configId: string; arm: ArmId; repeat: number; attemptId: string; scheduledIndex: number; kind: 'smoke' | 'scored' }`
  - `export type AttemptState = 'registered' | 'running' | 'execution-stopped' | 'verified' | 'terminal-failure' | 'capture-sealed' | 'reconciled' | 'extraction-frozen'`; `export const ATTEMPT_TRANSITIONS: Readonly<Record<AttemptState, readonly AttemptState[]>>` (pre-running failure: `registered → terminal-failure`)
  - `export type Disposition = 'accepted' | 'rejected' | 'timeout' | 'setup-failure' | 'provider-failure' | 'infra-failure' | 'interrupted' | 'abandoned'`
  - `export interface EvidenceRef { kind: string; path: string; sha256: string; bytes: number }`
  - `export interface EventEnvelope { schemaVersion: 1; experimentId: string; pairId: string; manifestId: string; taskKey: string; attemptId: string; eventId: string; sourceKind: string; sourceInstance: string; sourceSeq: number; actorId: string | null; parentActorId: string | null; nativeSessionId: string | null; observedAt: string; monotonicNs: string | null; traceId: string | null; spanId: string | null; evidence: EvidenceRef[]; availability: Record<string, 'observed' | 'absent' | 'unsupported'>; wish?: string; group?: string; phase?: string }`
  - `export type Presence = 'observed' | 'absent' | 'unsupported'`
  - `export interface NativeRequestRecord { requestId: string | null; responseId: string | null; revision: string; actorId: string; parentActorId: string | null; role: 'lead' | 'worker' | 'auxiliary'; nativeSessionId: string | null; requestedModel: string | null; observedModel: string | null; effort: string | null; tokens: { input: number | null; cacheRead: number | null; cacheWrite5m: number | null; cacheWrite1h: number | null; output: number | null; reasoning: number | null }; reasoningIncludedInOutput: boolean | null; durationMs: number | null; failed: boolean | null; retryOf: string | null; presence: Record<string, Presence> }`
  - `export type InputOrigin = 'human' | 'automated' | 'unknown'`; `export interface InputEvent { eventId: string; at: string; origin: InputOrigin; kind: 'initial-task' | 'approval' | 'message' | 'interrupt'; evidence: EvidenceRef[]; basis: string }`
  - `export const REQUIRED_CAPABILITIES: readonly string[]`; `export interface CapabilityReport { harness: Harness; arm: ArmId; executable: { path: string; build: string | null; sha256: string }; launchMechanism: string; discoveryRoots: string[]; resolved: { model: string | null; effort: string | null }; artifactTransport: ArtifactTransport; capabilities: Record<string, { status: 'proven' | 'unproven' | 'unsupported'; evidence: EvidenceRef[]; upstreamRequirement?: string }>; observedAt: string }`
  - `export interface NativeAdapter { harness: Harness; preflight(ctx: AdapterContext): Promise<CapabilityReport>; launch(ctx: AdapterContext, prompt: string): Promise<LaunchHandle>; settled(h: LaunchHandle, signal: AbortSignal): Promise<SettledResult>; stop(h: LaunchHandle, reason: 'settled' | 'timeout' | 'interrupt'): Promise<StopReceipt>; collectArtifact(h: LaunchHandle, dest: string): Promise<EvidenceRef> }`, together with `AdapterContext { root: string; attempt: AttemptIdentity; config: HarnessConfiguration; task: TaskIdentity; workspace: string; nativeHome: string }`, `LaunchHandle { attemptId: string; session: string; startedMonotonicNs: string }`, `SettledResult { settled: boolean; pendingActors: string[]; basis: string }` and `StopReceipt { reason: string; remainingActors: string[]; usageUncertain: boolean; stoppedMonotonicNs: string }`
  - `export function parseManifest(raw: unknown): Result<TaskManifest>`, `parseConfiguration(raw: unknown): Result<HarnessConfiguration>`, `parsePool(raw: unknown): Result<PoolEntry[]>`, `parseCapabilityReport(raw: unknown): Result<CapabilityReport>`

**Acceptance Criteria:**
- [ ] Every exported schema refuses unknown keys and a wrong `schemaVersion` with an issue naming the field.
- [ ] `ATTEMPT_TRANSITIONS` admits exactly the design §5 chain: registered → running → execution-stopped → (verified | terminal-failure) → capture-sealed → reconciled → extraction-frozen. It also admits the pre-running and interrupted exits `registered → terminal-failure` and `running → terminal-failure`, and nothing else. The test enumerates all 64 pairs.
- [ ] A `NativeRequestRecord` with a token `0` whose `presence` entry is not `observed` is refused. `null` survives a JSON round-trip as `null`.
- [ ] `bun run typecheck` covers `scripts/bench/**`: a deliberate type error in a scratch copy fails it (shown once in the PR body, not committed).

**Validation:**
```bash
bun test scripts/bench/contracts.test.ts && bun run check
```

**depends-on:** none

---

### Group 2: Durable attempt journal and campaign registration

**Goal:** One append-only, fsync'd journal per attempt under `--root`, written by a single supervisor, that retains every scheduled identity and failure and recovers without resetting denominators.

**Deliverables:**
1. `scripts/bench/ledger.ts` (new). The layout is `<root>/campaigns/<experimentId>/schedule.jsonl` and `<root>/attempts/<attemptId>/journal.jsonl`, with directories at 0700 and files at 0600. A lock is taken with O_EXCL on `<root>/supervisor.lock` (pid + start time). A stale lock is reported, never stolen silently.
2. `scripts/bench/ledger.test.ts` (new). It covers: register-before-launch; an illegal transition refused; a torn last line and a corrupt middle line (affected metrics fail closed, raw bytes and identity retained); a second writer refused; recovery of an interrupted `running` attempt to `terminal-failure/interrupted` with an unchanged campaign count; and an identity mismatch on reopen refused.

**Interfaces:**
- Consumes: G1 `AttemptIdentity`, `AttemptState`, `ATTEMPT_TRANSITIONS`, `Disposition`, `EvidenceRef`, `Result`.
- Produces:
  - `export function acquireSupervisor(root: string): Result<{ release(): void }>`
  - `export function registerCampaign(root: string, schedule: AttemptIdentity[]): Result<{ registered: number }>`. It refuses a campaign that already exists with different content and is a no-op on an identical one.
  - `export interface JournalEntry { seq: number; at: string; monotonicNs: string; state: AttemptState; disposition?: Disposition; evidence: EvidenceRef[]; note?: string }`
  - `export function appendTransition(root: string, attemptId: string, to: AttemptState, data: Omit<JournalEntry, 'seq' | 'state'>): Result<JournalEntry>`. It is durable (fsync) before return and refuses transitions not in `ATTEMPT_TRANSITIONS`.
  - `export interface JournalRead { identity: AttemptIdentity; entries: JournalEntry[]; state: AttemptState; corrupt: Array<{ line: number; reason: string }> }`
  - `export function readJournal(root: string, attemptId: string): Result<JournalRead>`
  - `export type RecoveryAction = 'none' | 'record-interrupted' | 'verify-collected-artifact' | 'seal-capture'`; `export function planRecovery(read: JournalRead): RecoveryAction`. It never returns a relaunch of a scored solver.
  - `export function campaignStatus(root: string, experimentId: string): Result<{ scheduled: number; byState: Record<AttemptState, number>; byDisposition: Record<Disposition | 'none', number> }>`

**Acceptance Criteria:**
- [ ] `registerCampaign` persists all scheduled identities before any `running` entry can be appended. Appending `running` for an unregistered id is refused.
- [ ] After a simulated crash (process killed between append and the next step), `campaignStatus().scheduled` is unchanged and the attempt is recoverable to a terminal state with its original disposition semantics.
- [ ] A corrupt line yields `corrupt[]` populated, the identity still readable, and the raw file byte-identical after read.
- [ ] A second `acquireSupervisor` on the same root fails with exit-2-class refusal text naming the holder pid.

**Validation:**
```bash
bun test scripts/bench/ledger.test.ts && bun run check
```

**depends-on:** Group 1

---

### Group 3: Manifest freeze, deterministic replacement and paired schedule

**Goal:** Turn an operator-cleared eligible pool into a frozen 20-task manifest without any outcome-dependent choice, and preregister the seeded paired schedule.

**Deliverables:**
1. `scripts/bench/pilot.ts` (new) with verbs `freeze`, `replace`, `verify`, `schedule`. `schedule` writes through G2's `registerCampaign`.
2. `scripts/bench/pilot.test.ts` (new) and a synthetic fixture pool `scripts/bench/fixtures/pool.fixture.json` (new; fake task ids, never a real manifest).

**Interfaces:**
- Consumes: G1 `PoolEntry`, `Quotas`, `TaskManifest`, `TaskIdentity`, `HarnessConfiguration`, `AttemptIdentity`, `parsePool`, `parseManifest`, `parseConfiguration`; G2 `registerCampaign`, `acquireSupervisor`.
- Produces:
  - `export function freezeManifest(pool: PoolEntry[], quotas: Quotas, smoke: string[], frozenAt: string): Result<TaskManifest>`. Per `<source>/<category>`, it takes eligible entries in bytewise `taskId` order. Any `unresolved` entry in a needed category refuses. An unfillable quota refuses with the category named, and nothing is ever silently shrunk. Smoke tasks are excluded from `selected`.
  - `export function replaceIneligible(m: TaskManifest, pool: PoolEntry[], taskKey: string, reason: string, outcomesRecorded: boolean): Result<TaskManifest>`. It refuses when `outcomesRecorded` and takes the next bytewise eligible id in the same category.
  - `export function scheduleCampaign(m: TaskManifest, configs: [HarnessConfiguration, HarnessConfiguration], repeats: number, seed: string, experimentId: string): AttemptIdentity[]`. It is deterministic for the same inputs, interleaves arms within each task/repeat pair, records `seed`, and yields `kind: 'smoke'` rows for smoke tasks separately from `scored` rows.
  - CLI: `bun scripts/bench/pilot.ts freeze --pool <file> --quotas <file> --smoke <id,id> --out <file>`; `replace --manifest <file> --pool <file> --task <key> --reason <text> --root <dir>` (reads G2 journals to decide `outcomesRecorded`); `verify <manifest>`; `schedule --manifest <file> --config-a <file> --config-b <file> --repeats 3 --seed <s> --experiment <id> --root <dir>`. Exit 0 ok, 1 not ok, 2 refusal.

**Acceptance Criteria:**
- [ ] With the fixture pool and quotas 6/4/2/2/2/4, `freeze` selects exactly 20, and the result is byte-identical across two runs.
- [ ] An ineligible entry is replaced by the next bytewise id in its category. Replacement after a recorded outcome exits 2. A category short of quota exits 2 naming it.
- [ ] `schedule` with 20 tasks × 3 repeats × 2 configs registers exactly 120 `scored` identities plus the smoke rows. The same seed gives an identical schedule, and a different seed gives a different order with the same multiset.
- [ ] A `--root` missing from any verb that writes exits 2 with nothing written.

**Validation:**
```bash
bun test scripts/bench/pilot.test.ts && bun run check
```

**depends-on:** Group 1, Group 2

---

### Group 4: Finite attempt supervisor bound to the original verifier

**Goal:** Run one registered attempt end to end through a `NativeAdapter`, timing it on an external monotonic clock, and accept it only on the original verifier's receipt against the digest-bound collected artifact.

**Deliverables:**
1. `scripts/bench/run.ts` (new) with verbs `preflight`, `attempt`, `recover`, `status`. The adapter map is a literal `{ omp: () => import('./adapters/omp.ts') }`. Any other harness exits 2 `unsupported harness`, with no fallback.
2. `scripts/bench/run.test.ts` (new). It uses a test-local fake adapter (never exported or registered) and a fixture verifier script. Cases: accepted; verifier rejects; verifier exit 0 without a binary reward refuses acceptance; timeout → `stop('timeout')` records remaining actors and `usageUncertain`; a settled result with pending actors is not treated as completion; a launch failure is `registered → terminal-failure/setup-failure`; the artifact is mutated after collection (the digest mismatch is refused); the verifier cannot see the solver workspace path; recovery of a killed run.

**Interfaces:**
- Consumes: G1 `NativeAdapter`, `AdapterContext`, `CapabilityReport`, `REQUIRED_CAPABILITIES`, `TaskIdentity`, `HarnessConfiguration`, `parseCapabilityReport`; G2 `acquireSupervisor`, `appendTransition`, `readJournal`, `planRecovery`, `campaignStatus`.
- Produces:
  - `export interface VerifierSpec { command: string[]; timeoutMs: number; rewardFile: string; acceptWhen: 'binary-one' | 'source-declared' }`. The command is the source's own verifier invocation from the manifest's pinned package. The supervisor never edits it.
  - `export interface VerifierReceipt { exitCode: number | null; reward: number | null; accepted: boolean; artifact: EvidenceRef; output: EvidenceRef; startedMonotonicNs: string; endedMonotonicNs: string }`
  - `export interface MonotonicClock { nowNs(): bigint; wall(): string }`; `export const hostClock: MonotonicClock` (`process.hrtime.bigint()`)
  - `export async function runPreflight(root: string, adapter: NativeAdapter, ctx: AdapterContext): Promise<Result<CapabilityReport>>`. It stores the report under `<root>/preflight/` and fails when any `REQUIRED_CAPABILITIES` entry is not `proven`.
  - `export async function runAttempt(root: string, attemptId: string, adapter: NativeAdapter, verifier: VerifierSpec, clock?: MonotonicClock): Promise<Result<{ state: AttemptState; disposition: Disposition; receipt: VerifierReceipt | null }>>`
  - CLI: `bun scripts/bench/run.ts preflight --root <dir> --adapter <harness> --config <file> --arm <arm>`; `attempt --root <dir> --attempt <id> --manifest <file> --config <file>`; `recover --root <dir> --attempt <id>`; `status --root <dir> --experiment <id> [--json]`.

**Acceptance Criteria:**
- [ ] Acceptance needs the original verifier's own acceptance (`binary-one` reward = 1, or the source-declared rule). Process exit 0 alone never marks `accepted`, and no new threshold converts a fractional reward.
- [ ] The verifier runs in a directory outside the solver workspace and native home, on a copy whose sha256 equals the journal's collected `EvidenceRef`. A mismatch yields `terminal-failure/infra-failure`, never acceptance.
- [ ] Execution elapsed, verification elapsed and setup come from `MonotonicClock` and are journaled separately. Wall time is recorded only alongside them.
- [ ] Every failure case in Deliverable 2 leaves exactly one terminal entry, and `campaignStatus().scheduled` is unchanged.
- [ ] Nothing persists after exit: the command spawns no detached process (checked by listing children after `runAttempt` resolves in the test).

**Validation:**
```bash
bun test scripts/bench/run.test.ts && bun run check
```

**depends-on:** Group 1, Group 2

---

### Group 5: Bounded native OMP capture with explicit presence

**Goal:** Read the per-attempt isolated OMP home into a bounded capture bundle: sessions, actor graph, distinct model requests, input-origin events and capture health. Every unknown stays null.

**Deliverables:**
1. `scripts/bench/capture.ts` (new).
2. `scripts/bench/capture.test.ts` (new) plus synthetic OMP session fixtures under `scripts/bench/fixtures/omp/` (new; hand-built JSONL in the native shape: lead + child + auxiliary, a retry, a failed request, a streaming usage revision, a malformed line, a duplicate, a missing usage block, a message steered into an existing run, and a runner-injected user-role message).

**Interfaces:**
- Consumes: G1 `NativeRequestRecord`, `InputEvent`, `EvidenceRef`, `Presence`, `Result`. Read-only from `src/lib/metrics-usage.ts`: `matchOmpSessionByCwd(cwd: string, openedAt: number, env?: NodeJS.ProcessEnv): PiSessionMatch` (window fallback only).
- Produces:
  - `export type SessionLinkage = { match: 'isolated-home'; file: string } | { match: 'window'; file: string } | { match: 'ambiguous'; candidates: string[] } | { match: 'none' }`
  - `export interface ActorRecord { actorId: string; parentActorId: string | null; role: 'lead' | 'worker' | 'auxiliary'; sessionFile: string; pending: boolean }`
  - `export interface CaptureHealth { malformed: number; duplicate: number; conflicting: number; unmatched: number; truncated: boolean; bytesRead: number }`
  - `export interface CaptureBundle { linkage: SessionLinkage; actors: ActorRecord[]; requests: NativeRequestRecord[]; inputs: InputEvent[]; health: CaptureHealth; evidence: EvidenceRef[] }`
  - `export function captureOmpAttempt(nativeHome: string, workspace: string, opts: { maxBytes: number; openedAtMs: number }): Result<CaptureBundle>`

**Acceptance Criteria:**
- [ ] With exactly one top-level session in the isolated home, linkage is `isolated-home`. With two it is `ambiguous`, and requests are still inventoried but carry `nativeSessionId: null`.
- [ ] Requests are deduplicated by native run/request id + revision. A steering message inside an existing run adds no attempt. A streaming usage revision replaces, and never adds, a billable record. Same id + revision with a changed payload counts as `conflicting`.
- [ ] A missing usage block gives `tokens.* = null` with `presence = 'absent'`, never 0. A reasoning subset reported inside output sets `reasoningIncludedInOutput: true`.
- [ ] A user-role message injected by a runner/tool/peer gets `origin: 'automated'` or `'unknown'`, never `'human'` without a native submission-provenance basis.
- [ ] `maxBytes` is honoured (`truncated: true`), and the capture never reads outside `nativeHome`/`workspace`. It makes no network call (enforced in a test by stubbing `globalThis.fetch` to throw).

**Validation:**
```bash
bun test scripts/bench/capture.test.ts && bun run check
```

**depends-on:** Group 1

---

### Group 6: Whole-attempt request accounting

**Goal:** Turn a capture bundle into per-attempt and per-cohort economics that never double-count, never price unknowns, and report coverage beside every number.

**Deliverables:**
1. `scripts/bench/accounting.ts` (new).
2. `scripts/bench/accounting.test.ts` (new). It reuses G5's fixtures read-only. Cases: lead+child+aux sum; a root rollup alongside its descendants (the rollup is excluded); a reasoning subset not re-added; cache 5m/1h priced separately; an unknown model price → `null`; a missing 1h split → normalized cost `null`; a failed request kept in the count; zero accepted → cost/accepted `undefined`; a subscription route reported as `subscription`, never 0.

**Interfaces:**
- Consumes: G1 `NativeRequestRecord`, `Disposition`; G5 `CaptureBundle`. Read-only from `src/lib/metrics-prices.ts`: `loadPriceTable(path: string): PriceTable | null`, `tableCost(table: PriceTable, model: string | null, tokens: PricedTokens): number | null`, `PriceTable['meta']` (`source`, `fetchedAt`, `sha256`).
- Produces:
  - `export interface PriceBasis { path: string; source: string; fetchedAt: string; sha256: string; currency: 'USD'; route: 'api' | 'subscription' | 'unknown' }`
  - `export interface AttemptEconomics { attemptId: string; requests: number; failedRequests: number; retries: number | null; tokens: Record<'input' | 'cacheRead' | 'cacheWrite5m' | 'cacheWrite1h' | 'output' | 'reasoning', number | null>; normalizedCostUsd: number | null; coverage: { nativeSource: 'complete' | 'partial' | 'unknown'; pricedRequests: number; unpricedRequests: number }; basis: PriceBasis }`
  - `export function attemptEconomics(bundle: CaptureBundle, attemptId: string, table: PriceTable, basis: PriceBasis): AttemptEconomics`
  - `export interface CohortEconomics { scheduled: number; accepted: number; costPerAttemptUsd: number | null; costPerAcceptedUsd: number | null; partial: boolean }`
  - `export function cohortEconomics(rows: Array<{ econ: AttemptEconomics | null; disposition: Disposition }>): CohortEconomics`. It divides by **scheduled** attempts and by compliant accepted attempts, and returns `null` when any required cost is null or acceptance is 0.
  - `--prices <file>` is mandatory wherever a cost is computed. There is no `DEFAULT_PRICE_SOURCE` fetch.

**Acceptance Criteria:**
- [ ] Any `null` input token makes the attempt's `normalizedCostUsd` `null`, and `coverage.unpricedRequests` counts it.
- [ ] `costPerAcceptedUsd` is `null` with 0 accepted and with any null attempt cost. `partial: true` labels any subtotal of known spend.
- [ ] A provider-internal retry absent from the native log yields `retries: null` (capture gap), not 0.
- [ ] `basis.sha256` equals the price table's `meta.sha256`, and a mismatched table is refused.

**Validation:**
```bash
bun test scripts/bench/accounting.test.ts && bun run check
```

**depends-on:** Group 1, Group 5

---

### Group 7: Visible native OMP adapter

**Goal:** Implement `NativeAdapter` for the stock interactive OMP client on an attachable PTY, with Genie-free discovery for the zero-Genie arm and hash-verified treatment resources for the Genie arm. Each capability is reported honestly as proven, unproven or unsupported.

**Deliverables:**
1. `scripts/bench/adapters/omp.ts` (new). It does the following:
   - Prepares a fresh native home and workspace per attempt, with an allowlisted environment and no `CLAUDE_CODE_SESSION_ID` or other outer session id inherited, never beneath the Genie checkout.
   - Launches `tmux -L <attemptId> new-session -d -s <attemptId> -- <omp executable> <prompt>` (argv, no shell interpolation, no `--print`/`--mode`).
   - Inventories the discovery roots, with a canary proving zero Genie resources in the `zero-genie` arm.
   - Installs and verifies the `TreatmentPin` resources by sha256 in the `genie` arm.
   - Uses only the native settled signal for `settled` and returns `unsupported` with an upstream requirement when none is exposed.
   - Collects the artifact per `ArtifactTransport` into the supervisor's directory.
   - Runs G5 capture at seal time.
2. `scripts/bench/adapters/omp.test.ts` (new). It uses a stub `omp` executable on `PATH` inside a temp dir, plus a real tmux when one is available (skipped with a printed reason otherwise). Cases: argv preserved byte-exact, including quotes/newlines; a stray Genie skill planted in a would-be discovery root fails the zero-genie canary; a treatment hash mismatch refuses launch; the environment allowlist drops outer session ids; `settled` without a native signal reports `unsupported`; `stop('timeout')` kills the tmux server and records remaining actors.

**Interfaces:**
- Consumes: G1 `NativeAdapter`, `AdapterContext`, `CapabilityReport`, `REQUIRED_CAPABILITIES`, `TreatmentPin`, `ArtifactTransport`; G4 `runPreflight` (caller); G5 `captureOmpAttempt`.
- Produces: `export const ompAdapter: NativeAdapter`; `export function zeroGenieCanary(nativeHome: string, workspace: string): { clean: boolean; found: string[] }`; `export function verifyTreatment(pin: TreatmentPin, nativeHome: string): Result<void>`.

**Acceptance Criteria:**
- [ ] The adapter never invokes OMP with `--print`, `--mode` or piped stdin (asserted on the stub's recorded argv/isatty).
- [ ] The zero-genie canary fails on any Genie skill, guidance, agent/workflow catalog, plugin or state under any discovery root, including the planted one.
- [ ] The Genie arm refuses to launch unless every `TreatmentPin.resources` hash matches.
- [ ] `preflight` never marks a capability `proven` from a declaration or version string. Only observed native evidence (an `EvidenceRef` to captured output) can prove one. The test asserts that `settledSignal` stays `unsupported` against the stub.
- [ ] The adapter's process tree is gone after `stop` (no tmux server left on the `-L` socket).

**Validation:**
```bash
bun test scripts/bench/adapters/omp.test.ts && bun run check
```

**depends-on:** Group 4, Group 5

---

### Group 8: Native preflight, frozen manifest and both-arm smoke (blocked-on-prerequisite P1–P4)

**Goal:** On the operator host, prove native capability in both arms, freeze the 20-task manifest from the cleared pool, and run the two original integration tasks in both arms as unscored smoke with original verifier receipts.

**Status:** BLOCKED until P1 (native capability preflight), P2 (task/oracle eligibility), P3 (authenticated Sol-medium route) and P4 (pinned `genie-omp` treatment) each show the exact proof in `## Dependencies`. A partial result (e.g. zero-genie preflight only) is recorded as evidence and does not complete the group. No smaller pilot, headless client, altered oracle or OMP-only substitute is allowed.

**Deliverables:**
1. `scripts/bench/tasks/omp-sol-medium.json` (new): two `HarnessConfiguration`s (`zero-genie`, `genie`) with identical executable, requested model/effort, epoch and cohort. The Genie arm carries the `genie-omp` `TreatmentPin` verbatim.
2. `scripts/bench/tasks/public-pilot.json` (new): the output of `pilot.ts freeze` over the operator's cleared pool. The pool and eligibility ledger stay private under `--root`, and only their digest (`poolDigest`) is committed.
3. Private evidence under the operator's `--root`, never committed: both preflight reports; the smoke schedule; `actionlint-action-pinning-lint` and `session-window-debug` journals and original verifier receipts in both arms; and one on/off observer-overhead probe (the same smoke task with capture sealed vs. capture disabled, timed on `hostClock`).
4. `scripts/bench/README.md`: a "Wave 1 evidence" section recording the commands run, the digests, and every `unsupported`/blocked item verbatim.

**Interfaces:**
- Consumes: G3 `freeze`/`verify`/`schedule` CLI; G4 `preflight`/`attempt`/`status` CLI; G6 `attemptEconomics`; G7 `ompAdapter`; `genie-omp` treatment contract (P4).
- Produces: `scripts/bench/tasks/public-pilot.json` and `scripts/bench/tasks/omp-sol-medium.json`, the frozen inputs `genie-bench-omp-pilot` consumes unchanged.

**Acceptance Criteria:**
- [ ] `run.ts preflight` exits 0 for both arms, and every `REQUIRED_CAPABILITIES` field is `proven` with an evidence ref. The report records requested vs. observed model/effort for lead, child and auxiliary calls.
- [ ] `pilot.ts verify scripts/bench/tasks/public-pilot.json` exits 0, with 20 selected, quotas met, no `unresolved`, and every replacement recorded with its reason before any treatment outcome exists.
- [ ] Each smoke task has, in both arms, a terminal journal entry and an original verifier receipt, accepted or not. Smoke rows are `kind: 'smoke'` and excluded from any scored count.
- [ ] Each smoke attempt's `attemptEconomics` lists lead/child/auxiliary requests with coverage. Any `null` is explained in the README evidence section.
- [ ] The overhead probe reports both timings without adjustment. No "zero overhead" claim is made.

**Validation:**
```bash
bun scripts/bench/pilot.ts verify scripts/bench/tasks/public-pilot.json \
  && bun scripts/bench/run.ts status --root "$GENIE_BENCH_EVIDENCE_ROOT" --experiment "$GENIE_BENCH_SMOKE_EXPERIMENT" --json \
  && bun run check
```
(`GENIE_BENCH_EVIDENCE_ROOT` and `GENIE_BENCH_SMOKE_EXPERIMENT` are operator-supplied for this one validation. The engine itself reads no environment default.)

**depends-on:** Group 3, Group 4, Group 6, Group 7

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] Functional: on a fresh checkout, `bun scripts/bench/pilot.ts freeze --pool scripts/bench/fixtures/pool.fixture.json --quotas <fixture quotas> --smoke <ids> --out "$TMP/m.json"` exits 0, and running it again produces identical bytes. The same command without `--out` or with a short pool exits 2 with a named reason.
- [ ] Functional: `bun scripts/bench/run.ts status` without `--root` exits 2 and creates no file anywhere (checked with a before/after listing of `$HOME` and the repo).
- [ ] Integration: a full fake-adapter attempt (the test harness) passes register → running → stopped → verified → sealed with the receipt digest equal to the collected artifact. G8, when unblocked, does the same with the real OMP client.
- [ ] Regression: ordinary `genie` commands create no `scripts/bench` files, no `<GENIE_HOME>/metrics` changes, and no network traffic (`GENIE_HOME` temp dir diffed before/after a `genie task list`). `src/lib/metrics-*.ts` is byte-unchanged from the wave base.
- [ ] Regression: `bun run check` passes on both the Linux and macOS CI legs.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| OMP TUI exposes no authoritative settled signal (machine-local NATIVE-OMP note: `isIdle` is only non-streaming) | High | `settledSignal` stays `unsupported`. P1 fails, G8 stays BLOCKED with the upstream requirement named. No quiet-interval polling |
| The `genie-omp` treatment (P4) is itself blocked on its upstream OMP P0 | High | G1–G7 do not depend on it. The Genie arm of G8 waits, and zero-genie preflight evidence is recorded without completing G8 |
| Eligibility holds (SWE-Atlas test-writing, SkillsBench third-party inputs) cannot be cleared | High | `freeze` refuses a short category. The operator resolves the manifest, and the cohort is never silently shrunk |
| `tmux` introduces environment or terminal differences from a bare PTY | Medium | Preflight records the tmux version and env. If a difference proves material, the launch mechanism is changed in G7 by a reviewed decision, never in a scored run |
| `metrics-usage.ts` session-file format drifts under the capture owner | Medium | The bench imports only `matchOmpSessionByCwd`, as a labelled fallback. Its own parser keeps the presence semantics, and fixtures pin the native shape |
| Adding `scripts/bench/**` to `tsconfig.json` surfaces type errors in later sibling files | Low | Intended. Every sibling inherits the same gate |
| An evidence root is committed by accident | Medium | `--root` is required and outside the repo by README convention. The G8 PR diff is limited to the two task JSONs and the README |

---

## Review Results

_The read-only reviewer returns evidence; the invoking orchestrator appends a timestamped block here after plan, execution, and PR reviews._

---

## Files to Create/Modify

```
tsconfig.json                                   (G1: include scripts/bench/**/*)
scripts/bench/contracts.ts                      (G1, new)
scripts/bench/contracts.test.ts                 (G1, new)
scripts/bench/README.md                         (G1 new; G8 appends "Wave 1 evidence")
scripts/bench/ledger.ts                         (G2, new)
scripts/bench/ledger.test.ts                    (G2, new)
scripts/bench/pilot.ts                          (G3, new)
scripts/bench/pilot.test.ts                     (G3, new)
scripts/bench/fixtures/pool.fixture.json        (G3, new)
scripts/bench/run.ts                            (G4, new)
scripts/bench/run.test.ts                       (G4, new)
scripts/bench/capture.ts                        (G5, new)
scripts/bench/capture.test.ts                   (G5, new)
scripts/bench/fixtures/omp/*.jsonl              (G5, new)
scripts/bench/accounting.ts                     (G6, new)
scripts/bench/accounting.test.ts                (G6, new)
scripts/bench/adapters/omp.ts                   (G7, new)
scripts/bench/adapters/omp.test.ts              (G7, new)
scripts/bench/tasks/omp-sol-medium.json         (G8, new; blocked P1-P4)
scripts/bench/tasks/public-pilot.json           (G8, new; blocked P2)
```
