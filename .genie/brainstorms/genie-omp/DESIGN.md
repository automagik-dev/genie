# Design: Genie as an OMP-native context framework

| Field | Value |
|-------|-------|
| **Slug** | `genie-omp` |
| **Date** | 2026-10-04 |
| **WRS** | 100/100 — design scope/decisions/risks/criteria specified, not runtime completion |
| **Size** | G · native compatibility prerequisite followed by a multi-group Genie wish (lead set G in round 1; owner added whole-framework optimization in round 2) |

## Problem

Genie must supply useful context, durable intent and delivery guarantees through OMP's native execution graph without replacing the harness or wasting tokens/time on mechanical model stages. The first optimized/validated combination is GPT-6.1 Sol at medium with OMP, while general support and shared skills remain portable.

**Compatibility prerequisite:** installed OMP 18.6.0 lacks a native repository-blind child-input policy. The approved native wish cutover must wait for a supported native child-context/capability surface, defined below. This document designs that dependency and the Genie integration; it does not claim the surface exists, authorize third-party implementation, or approve shipping an incomplete adaptation.

Owner choices: R1-1 general OMP support; R1-2 task-aware use plus explicit commands; R2-1 Sol/OMP first; R3-1 outcome-preserving native wish graph. All seven DRAFT Scope IN items are retained. Parent Genie Bench R4-1, pilot size, stays unanswered.

Evidence: [native discovery and existing installer behavior](NATIVE-CONTRACT.md), [official model guidance and native overlap](MODEL-HARNESS.md), [native compatibility boundaries](NATIVE-BOUNDARIES.md). Current facts are source inspection plus the named prior probes; every new behavior below is future acceptance, not an executed result.

## Scope

### IN

| # | Deliverable | Files changed | Source |
|---|-------------|---------------|--------|
| 1 | General OMP consumption through the existing recorded pinned local skills channel; same positive consumer evidence for selection and pruning | `src/lib/skills-agents.ts`, `src/lib/skills-agents.test.ts`, `src/lib/skills-installer.ts`, `src/lib/skills-installer.test.ts`, `.claude/rules/skills-installer.md` | R1-1; `.genie/brainstorms/genie-omp/NATIVE-CONTRACT.md` |
| 2 | Task-aware portable routing/context; explicit native invocation; skill-local OMP binding and recipient handoff contract | `skills/genie/SKILL.md`, `skills/genie/reference/lifecycle.md`, new `skills/genie/reference/omp.md`, `skills/wish/SKILL.md`, new `skills/wish/references/omp-native.md`, `skills/work/SKILL.md` and work-local references only if needed to preserve house size | R1-2; `skills/authoring/SKILL.md` |
| 3 | Approved native wish graph with unchanged guarantees, native-policy compatibility gate, exact-revision evidence and bounded repair/resume/publication | new `skills/wish/references/native-wish.mjs`, new `skills/wish/references/native-wish-policy.mjs`, new `skills/wish/references/native-wish.d.mts`, new `scripts/native-wish.test.ts`; affected behavioral wish-contract tests only | R3-1; `.genie/brainstorms/genie-omp/NATIVE-BOUNDARIES.md`; `skills/wish/SKILL.md` |
| 4 | Whole-framework authoring guidance beginning with Sol: precise triggers, selective references, source-applicable model advice, no per-task rewriter | `skills/refine/SKILL.md`, `skills/refine/prompts/openai.md`, new `skills/refine/prompts/openai-sol-6-1.md`, relevant instruction surfaces from rows 2–3 | R2-1; `.genie/brainstorms/genie-omp/MODEL-HARNESS.md` |
| 5 | Delivery/context/compatibility acceptance exercised against the exact installed resource tree, plus real-client evidence and a pinned treatment contract for Genie Bench | new `scripts/omp-adaptation-smoke.ts`, `scripts/fresh-install-smoke.ts`, affected real behavior fixtures, `README.md`, `skills/README.md`, `CHANGELOG.md` | R1-1; R2-1; `.genie/brainstorms/genie-omp/NATIVE-CONTRACT.md`; `.genie/brainstorms/genie-bench/DRAFT.md` |
| 6 | Explicit native prerequisite specification, dependency order and unsupported-version refusal; no claim current task arguments support it | `.genie/brainstorms/genie-omp/NATIVE-BOUNDARIES.md`, this `DESIGN.md`, owning native-binding reference in row 2 | R3-1; `.genie/brainstorms/genie-omp/NATIVE-BOUNDARIES.md` |

Files marked new are proposed future implementation files, not scaffolds created in this brainstorm. Final wish groups own disjoint pathsets or use separate worktrees. Test changes must cover consumer-visible boundaries; do not re-pin source wording/copies/incidental stage declarations.

### OUT

- Replacing OMP's system prompt or agent loop; porting Claude's workflow runner; adding a scheduler, routing model, resident process, automatic lifecycle hooks or periodic status agents. Native support supplies the graph. (Source: R3-1; `AGENTS.md`)
- Editing Claude's saved workflow, stage roster, model tiers or publication behavior in the initial slice; generating an embedded policy copy into it. Shared workflow extraction is a separate approved change if later needed. (Source: R3-1; `.genie/brainstorms/genie-omp/NATIVE-BOUNDARIES.md`)
- Weakening blind admission, independent review, work's separate quality pass, claims, scope, budgets, evidence or publication authorization. Any relaxation needs its own owner decision. (Source: R3-1; `skills/work/SKILL.md`)
- Modifying a third-party OMP checkout or silently replacing the installed binary in this Genie wish. The native prerequisite needs its own upstream work and a supported pinned delivery before cutover. (Source: `.genie/brainstorms/genie-omp/NATIVE-BOUNDARIES.md`)
- A custom SDK judge runner, prompt redaction, replacement prompt template or extension hook that pretends to satisfy the missing native policy. (Source: `.genie/brainstorms/genie-omp/NATIVE-BOUNDARIES.md`)
- Reviewer LSP/OS sandbox work. Reader-only tools suffice initially; adding LSP requires proven nonmutation including server callbacks/checkers, not a role label. Main engineering keeps its existing native LSP. (Source: `.genie/brainstorms/genie-omp/NATIVE-BOUNDARIES.md`)
- New model selection/effort defaults, per-request profile questions, a model registry, N×M skill forks, automatic prompt rewriting, new refine target flags, or unsupported automatic profile unloading. (Source: R2-1; `.genie/brainstorms/genie-omp/MODEL-HARNESS.md`)
- New benchmark tasks/oracles, scored attempts, a settled pilot size, billing-cap policy or efficiency claim. Baseline observation/accounting is a separate arm-neutral Genie Bench responsibility. (Source: `.genie/brainstorms/genie-bench/DRAFT.md`)
- Another skill provider/install receipt, Pi/Codex impersonation, new native product homes, automatic user AGENTS/RULES/settings edits, or cleanup of unrelated user resources. (Source: `AGENTS.md`; `.claude/rules/skills-installer.md`)

## Approach

### 1. One portable contract; native execution

Compose only what the task needs: portable scope/authority/evidence guarantees, selected task skill, source-backed model guidance where relevant, and a small native binding. These are concerns, not four compulsory prompt copies.

Skill descriptions carry precise triggers. Root skills stay compact and runtime-neutral, with supporting detail under their own resource directory. An explicit request selects that skill; otherwise retain current Genie precedence: related resumable work, safety-bearing route, narrower route. Ordinary unrelated work remains ordinary and creates no wish/card/database record merely to use OMP.

OMP discovers the installed shared catalog; matching task guidance is read on demand. Use the actual resolved native name/path and warnings. Native explicit invocation is `/skill:genie`, `/skill:wish`, `/skill:work` or another resolved/namespaced name; `skill://` reads the body/resources. Do not promise `/genie` as a native command. Respect skill discovery/command/provider/filter settings; if disabled or shadowed, give the actual remedy without changing user configuration.

No always-apply skill knob is invented. Task-aware matching is native model behavior guided by precise descriptions and the selected contract, not deterministic lifecycle enforcement. Required gates remain explicit checkable handoffs.

### 2. Safe recorded delivery for OMP consumers

Keep `skills@1.5.23`, explicit target argv, the local delivered source tree and existing receipt. The real `universal` target writes canonical HOME/.agents/skills. OMP is a consumer of that tree, not the upstream registry's `pi` or an invented CLI key.

Add a bounded Genie-owned consumer resolver alongside the upstream registry mirror. Resolve one evidence snapshot per convergence and thread it into both pre-selection independent-consumer pruning and target selection. Preserve existing other-agent order/deduplication; append `universal` only when credible OMP evidence requires the canonical shared destination and no selected target already supplies it. Selection still returns that canonical home for recording/collision safeguards. A prior receipt can refresh recorded resources but is not independent evidence of OMP installation.

Positive evidence is an existing directory at a native-resolved agent state path. Match the inspected native rules:

1. Config root uses `path.join(home, PI_CONFIG_DIR || '.omp')`.
2. Defined OMP_PROFILE wins over PI_PROFILE, including empty/default suppression; validate native profile grammar/reserved names. Invalid input is reported, not silently treated as default proof.
3. A named profile derives config-root/profiles/name/agent and ignores PI_CODING_AGENT_DIR. Default may use a truthy cwd-resolved override, except native inherited-profile suppression.
4. Probe that active path and existing immediate valid profile/agent directories for initialized inactive profiles. Do not recursively scan profile contents, auth databases or caches.
5. Reject missing/file/inaccessible/dangling paths and exclude evidence inside the candidate shared-home ancestor chain from independent protection. Do not create state or activate a profile.

Relocated state remains evidence, never a delivery destination: OMP shared discovery still uses HOME/.agents/skills. No consumer/receipt keeps the current skip. Consent none remains a complete channel skip. Backup-first collision snapshots, pre-spawn retirement, preserved entries, malformed-record refusal, accumulated archives, vanished recorded homes and recorded uninstall authority remain unchanged. No receipt/schema replacement or second convergence mechanism.

### 3. Native child-policy prerequisite, before activation

The required new surface belongs to OMP's native child path, not a Genie extension or SDK runner. **The following version-1 compatibility contract is proposed; none of these policy selectors/acknowledgements exists in the inspected 18.6.0 task interface.**

OMP exposes two host-defined restrictive child policies through supported task/eval types/schema and a capability descriptor. A caller selects a predefined policy; it cannot supply arbitrary replacement system text or broaden parent permissions. Unrestricted existing task behavior stays unchanged.

| Policy | Explicit inputs | Native capability ceiling |
|---|---|---|
| Admission | Frozen objective/issue/context framed as data, read-only facts/estimate, applicable admission constraints, output schema | OMP-owned generic protocol baseline plus these inputs; yield only; no LSP, repository resources, source skill catalog/autoload, user/project prompt overrides, memory/plan/workpool, inherited MCP/extensions or peer/parent messages |
| Reader-only review | Frozen criteria, exact candidate snapshot identity, cumulative scope and observed check evidence, applicable reviewer contract | Native read/grep/glob/yield; no LSP, shell/eval, write/edit, child delegation, custom/device transports, MCP or extension execution |

Policy resolution happens before discovery, extension factories/autoload, auxiliary label/effort inference and first task inference. Admission uses a fresh native conversation/provider lineage. No project cwd/tree/root metadata or user SYSTEM/template sources are rendered; native core builds its bundled clean baseline directly from typed inputs. Do not strip rendered blocks after the fact. Main-session instructions/context stay untouched.

Native acknowledgement version 1 binds parent/child/artifact identity, selected policy, admitted source categories, input/schema digests, effective tool set and resolved model/effort/fallback. It is emitted before first inference and preserved across rebuild/supported revival. Unsupported replay fails closed. Admission followups/peer messages cannot add unadmitted context; a new payload needs a new frozen admission turn.

Reviewer restriction is enforced in the actual native tool registry, including automatic task/spawns expansion and device/MCP/custom transports. Use a coordinator-prepared exact source snapshot plus manifest, with the full commit/tree identity and cumulative base→candidate pathset. Review link entries as links; an external/unavailable target required for judgment is a named evidence blocker, not mutable source silently read as candidate content. Parent verifies the snapshot identity before/after review and candidate identity immediately before publication. This is a trusted-builtin capability clamp, not an OS sandbox or proof against a malicious native runtime.

Upstream seams are native agent definition/task types, structured-subagent inheritance, executor preparation, SDK/system-prompt discovery, persisted revival and corresponding tests. Generic native registry/accounting, result delivery, cancellation and teardown remain intact. No native LSP changes are required because LSP is absent in this restricted role.

Genie activates the native wish branch only with a pinned supported OMP build, required descriptor and attributable policy acknowledgement. A version string, stock reviewer name, prompt substring or extension claim is insufficient. Missing support reports the prerequisite and blocks this branch; it does not claim the legacy fallback proves parity or silently drop admission. Shared routing/discovery remains available, but cannot be advertised as completed native wish delivery.

### 4. Native graph and acquisition

For a decided one-task wish:

1. Lead gathers read-only repository facts, original issue evidence, duplicate-work/recorded-intent facts, discovered check/install commands, candidate file set and size estimate.
2. Separate admission child receives only the frozen explicit input packet under the native admission policy. Strict structured results carry route/criteria/declared scope. The lead cannot admit its own proposal.
3. Mechanical admission validation preserves current size/trust/base/command rules, judge-file subset and nonempty criteria; linked design preflight remains the existing skill-relative Node verifier. A refusal creates no implementation worktree.
4. Lead implements after admission in the preserved named wish worktree, using the existing common-dir/branch/adoption rules. Frozen install, when required, precedes the first commit; no dirty/diverged adoption, sweeping unrelated edits or destructive cleanup.
5. Lead executes changed-path smoke. The mechanical gate observes hooks/identity and runs the required command. A different reader-only native reviewer judges the exact candidate against the frozen criteria.
6. FIX-FIRST uses bounded scope-preserving repair, then new checks and independent review. BLOCKED stops; exhausted budget is missed, never success.
7. With the selected delivery contract's actual publication authorization, the binary publisher/readback returns merge-ready, pr-open or blocked. No merge or SHIPPED inference.

Native OMP owns ready dependencies, agents, live messaging/results and waits. Reuse live workers and completion delivery; no periodic progress polling or mirrored stage roster. Model agents remain for judgment/work, not to echo subprocess exits.

Every recipient brief carries role/goal, frozen subject, owned scope, applicable guarantees, acceptance/validation, dependencies, stop conditions and required acquired references. A catalog is not body acquisition. Judge restrictions intentionally prevent source reads; the lead puts the admitted contract/facts in its packet instead. Reviewer receives required contract/criteria and exact snapshot evidence, not an expectation that parent-read instructions magically arrived.

Native role model aliases are not inheritance. Use supported explicit inheritance/recipient effort controls when the contract requires it, and inspect resolved identity/effort/fallback. Do not substitute coarse med for literal medium or override operator model choices. The benchmark pins Sol medium for applicable recipients; ordinary product use keeps operator configuration. Unknown model identity means portable advice, not a guessed profile; if unknown identity prevents required benchmark pin verification, that attempt is not accepted.

### 5. Mechanical helpers and type/error boundaries

Keep one wish-local Node entrypoint `native-wish.mjs` with sibling `native-wish-policy.mjs` and declaration boundary `native-wish.d.mts`. No npm packages, runtime imports of wish.js, cross-skill filesystem dependencies, generated Claude embedding or compiled CLI namespace. The installer already copies these resources recursively.

Fixed proposed actions, not a generic executor:

| Action | Input boundary | Observed output / side effects |
|---|---|---|
| `admit` | Explicit repository, frozen job/facts/judge output/native policy acknowledgement, expected identity | Current admission policy/refusal; digest-bound frozen contract and attempt evidence only after valid admission; no code/remote mutation |
| `gate` | Frozen contract digest, named worktree, exact candidate, admitted attempt | Real Git/hook/path observations; one selected foreground check with command/cwd/exit/signal/log identity; no model judgment or publication |
| `record` | Typed review result/native identity or repair reservation/disposition, exact subject and expected record identity | Validated immutable evidence references and budget disposition; no agent dispatch/code repair; rejects unknown/stale subjects |
| `publish` | Current contract/gate/SHIP/native review identity, exact candidate, explicit publication authority | gh-presence-first, allowlisted literal Git/gh operations, existing PR reuse and actual remote readback; no credential discovery, force, bypass, merge or base push |

Typed records distinguish job/frozen contract, native policy acknowledgement, candidate, process result, review evidence, repair disposition and publication readback. Required fields are validated before effects; unknown/empty/unread data is not pass. CLI exit 0 means successful requested action (its structured result still distinguishes pending PR checks), 1 means policy/environment refusal or failed validation, 2 means usage/unexpected execution failure. Diagnostics use stderr; stdout has one typed JSON result. No silent no-op fallback or success after a failed observation.

Git/gh receive argv arrays and explicit cwd; report/PR rich text uses files/stdin and readback. The frozen repository validation command remains the existing trusted shell-text contract; current refusal patterns are not a general shell sandbox. No generic retry/install-on-failure mechanism is added.

Preserve existing admission maxima 25 files/2,000 insertions; units advisory; current default/base/path/denylist/command rules, exact Darwin exception, hook/no-hook fallback, scope equality, refusal states and repair semantics. Measured diff overrun remains reported rather than silently becoming a new retrospective size stop. Unknown hook state is not none. Dead hooks or no usable required command block. Preserve repository-required aggregate checks.

Native code observes real platform, hooks, Git, process and remote data. Claude's current script consumes agent reports and stays unchanged. The native adapter is a distinct observing implementation of the same authored wish contract, not a second lifecycle policy or a copied workflow engine. A shared consumer-facing conformance corpus compares decisions while documenting intentional stronger observation (actual host/candidate/PR OID). Do not claim one executable policy module already serves both runtimes.

### 6. Durable intent, evidence and interruption

Approved designs/wishes/decisions/dependencies remain in tracked documents. Existing task DB/card conversation/claims remain for tracked groups. OMP owns the live graph/session/artifacts. Native todo/idle/completion never substitutes for shared ownership, approval or verified delivery.

One coordinator-owned evidence record per single-task attempt is justified by frozen-contract continuity and repair/publication recovery. Resolve the real Git common directory, then store under its administrative genie/wish/slug area; do not assume .git is a directory, put a new state DB in the machine home, or stage this operational record into the task diff. Log references/digests/native identities, not full copied transcripts. Store frozen objective/context/issue/base/initial merge-base/contract/policy/native-origin identity, candidate/check/review receipts, repair numbers/dispositions and publication/readback references. The coordinator serializes actions; conflicting identity blocks. Atomic replacement prevents torn records, not a claimed cross-process lock or authenticated reviewer provenance.

Reserve a repair attempt before mutation/dispatch and bind its native identity. Interruption after a repair commit leaves that pending attempt incomplete until its check/review is reconciled; it cannot reset the budget. No-response/no-write release needs attributable evidence. Unreachable disposition blocks. Every changed candidate invalidates prior check/review. Missing/corrupt evidence is reacquired or diagnosed, never replaced with a local invented verdict.

Multi-group work retains its existing APPROVED/IN_PROGRESS transition, WISH DAG, claim-before-setup, losing-claim stand-down, disjoint writers or deliberate worktrees, coordinator-only HEAD, exact reviewed commits, per-group implementation review, separate quality pass and distinct cap, integrated review/checks and authorized delivery. Work does not adopt a sibling skill's single-task journal or wish cap blindly. Documented CLI-unavailable fallback does not bypass a live conflict.

Only authorized merge plus required QA/release evidence establishes SHIPPED. Merge-ready remains the one-task endpoint. Helper use is an operator-trust guardrail, not a capability wall preventing the lead from issuing unrelated commands through other native tools.

### 7. Model-aware authoring without daily friction

Reuse refine as the authoring workbench for maintained skill roots/references and worker briefs. No automatic runtime refiner call, whole-library injection, model router, new target switch or per-task questionnaire.

Preserve existing `--for openai`/`--for claude` and current Claude target semantics. Qualify OpenAI family guidance versus Astra-observed examples and add a small Sol source/capability note under the owning refine skill. The note selects advice, not an inference model. Known actual intended recipient may select applicable reference loading; input prompt contents cannot select a provider/profile or broaden authority. Unknown identity uses provider/common guidance and only material limits are disclosed.

Maintain URL, applicability/model, per-source checked date and origin for each reference; do not advertise one umbrella freshness date as verification of unread references. Do not refresh Claude content from OpenAI evidence or treat installed/check-out differences as a broken installer. Sol-specific behavior clauses require source applicability or reproduced failures; the initial note may carry no unique behavior at all.

Remove duplicated execution prescriptions only where native instructions already provide the same meaning. Scope, evidence, required checks, independence, permission and completion remain invariant. Do not transplant Astra delegation or historical o-series formatting rituals. Honor current native model/effort/schema/history/cache/transport; model switches do not automatically unload old text. Conditional applicability and fresh acquisition prevent an old profile becoming policy for a new recipient, but no automatic reconciliation feature is claimed.

### 8. Validation and dependency order

**Dependency P0:** a supported pinned OMP build with the described native policy and tests is required for adaptive wish cutover. Its implementation is upstream work, not an edit to third-party installed files here. Missing P0 must block activation and final delivery, not silently shrink acceptance.

Once P0 is available, plan a Genie multi-group wish: (A) consumer/delivery mapping and ownership fixtures; (B) portable routing/authoring and wish-local native binary evidence resources; (C) integrated installed-tree/real-client/compatibility acceptance. A/B can have disjoint ownership; C follows both and P0. Shared interfaces and global constraints are fixed before dispatch. No implementation starts from this document alone: linked design preflight and independent plan approval remain required.

Run the repository contract after implementation: frozen install, full `bun run check`, affected behavior tests, installed-tree and real-client smoke. Permanent tests target consumer-visible failures/transitions/boundaries; throwaway probes cover assembly/wiring. Remove incidental wording/implementation-copy assertions when touched rather than repinning them. Real client remains open for native invocation/delegation; RPC/headless metadata is not substituted for TUI task behavior.

Genie Bench retains original public tasks/oracles and primary native-zero-Genie versus pinned adaptation pair using the same supported OMP build/model route/effort/native capabilities. The treatment includes declared Genie instructions/helpers; no Genie resource reaches baseline and no research/solution metadata reaches solver context. The upstream native policy is present in both clients, not a treatment-only harness patch. Version/hash exact skill/helper sources and native build; record effective recipient identity and accounting coverage. Core-only diagnostics are separate declared experiments. Pilot size and scored execution remain the parent owner's frontier.

## Simplicity Case

- **Simplest complete design:** one portable library, one existing recorded channel, two fixed native restriction policies provided by OMP, one wish-local mechanical entrypoint, and one evidence record for required resume/repair continuity. Native execution remains native.
- **Added machinery:** consumer evidence fixes an exercised OMP-only delivery gap; native restriction is necessary for approved blind/read-only boundaries; observing binaries replace model exit-code/remote echoes; evidence continuity prevents false resume/budget reset. None schedules work or invents another live-state authority.
- **Deferred until measured:** model-specific behavior overlays require a source/reproduced defect and evaluation; reviewer LSP requires proven nonmutation; shared Claude policy extraction requires a separately approved compatibility need; broader native bindings follow evidenced additional clients. No cache/compiler/plugin/router/daemon is prebuilt.
- **Complexity removed:** mechanical model stages, runtime prompt rewriting, N×M forks, copied tool inventories, duplicate personas, generated Claude policy embedding, second install receipts, live-step DB mirroring, polling/progress ceremonies and shadow task ownership.

## Decisions

| # | Decision | Rationale | Source |
|---|----------|-----------|--------|
| 1 | General OMP support, not benchmark-only treatment | Product adaptation must be usable outside the pilot | R1-1 |
| 2 | Task-aware selection and explicit native commands | Native matching/on-demand context avoids forced lifecycle and respects owner invocation | R1-2 |
| 3 | Sol/OMP first at medium for validation; preserve other clients | Daily-driver priority without per-request model switches | R2-1; `.genie/brainstorms/genie-bench/DRAFT.md` |
| 4 | Native outcome graph; retained independent judgments; binaries for mechanics | Remove model-stage overhead without removing quality gates | R3-1 |
| 5 | OMP consumer maps to pinned universal delivery; same evidence protects pruning | Current selector misses OMP-only roots; destination already supported | `.genie/brainstorms/genie-omp/NATIVE-CONTRACT.md` |
| 6 | Native child-policy prerequisite; no custom SDK replacement or hooks | Stock task inheritance cannot prove blind admission | `.genie/brainstorms/genie-omp/NATIVE-BOUNDARIES.md` |
| 7 | Reader-only reviewer without LSP | Current LSP action clamp does not prevent checker/server mutation | `.genie/brainstorms/genie-omp/NATIVE-BOUNDARIES.md` |
| 8 | Claude workflow code unchanged; native observers validated against same contract | Avoid unapproved extraction/generation machinery and semantic drift | R3-1; `.genie/brainstorms/genie-omp/NATIVE-BOUNDARIES.md` |
| 9 | Author-time refinement and small applicable model notes | Native already owns model-sensitive tools/delegation; family examples are not Sol tuning evidence | `.genie/brainstorms/genie-omp/MODEL-HARNESS.md` |
| 10 | Durable evidence/claims versus native live graph, with bounded interruption reconciliation | Resume/repair requires real validated identity; idle is not proof | `skills/genie/reference/lifecycle.md`; `skills/work/SKILL.md` |

## Risks & Assumptions

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| 1 | Required native policy is unavailable today | High | Explicit P0 dependency, descriptor/acknowledgement and exercised native acceptance before activation/delivery |
| 2 | Inherited context/extensions or rebuild/revive leaks data into judge | High | Source-level pre-discovery restriction and forbidden-context canaries; unsupported replay blocks |
| 3 | Reviewer label or LSP falsely represented as nonmutation | High | Actual restricted registry, LSP absent, no executable/device/custom transport, exact snapshot checks; no OS-sandbox claim |
| 4 | Recipient aliases/fallbacks violate Sol-medium pin | High | Supported recipient selection and observed native identities/effort; mismatch/unreadable pin fails benchmark acceptance |
| 5 | Consumer detection and pruning disagree or corrupt user resources | High | One evidence snapshot, relocated/profile/own-chain fixtures, existing records/backups/retirement/uninstall preserved |
| 6 | Native/legacy policy drifts despite unchanged Claude file | High | Same consumer conformance corpus, original exception/route boundaries preserved, intentional stronger observation documented |
| 7 | Interruption resets repairs, resumes stale evidence or repeats publication | High | Frozen identity, pre-mutation repair reservation, pending-disposition reconciliation, current-SHA checks and PR reuse; unknown evidence blocks |
| 8 | Evidence record described as lock/authenticated trust wall | Medium | One coordinator serializes; record hashes bind bytes only; native identities and real subject observations required; no cryptographic-independence claim |
| 9 | Provider guidance claims Sol traits or freshness not actually supported | Medium | Source applicability/date/origin, no speculative behavior delta or umbrella revalidation claim |
| 10 | Discovery smoke confused with model obedience/end-to-end delivery | High | Separate observed evidence from future real-client acceptance; no complete adaptation claim on read/catalog alone |
| 11 | Expected efficiency gain absent or worse | Medium | Compare original task success/time/tokens; no benefit is a valid result and unnecessary deltas are removed |

## Success Criteria

All checkboxes are implementation acceptance obligations, not work claimed completed in this brainstorm.

- [ ] **SC1 — Safe OMP-only delivery:** an initialized default/named/relocated OMP-only home selects canonical shared delivery; no unrelated product home is created. Empty/unproven homes still skip; receipt-only refresh is not independent proof. **Proof:** isolated actual pinned-channel install/update fixture, observed target argv/record/files, detector precedence/invalid/path cases.
- [ ] **SC2 — Ownership continuity:** repeat update protects the legitimate shared tree, preserves foreign/modified resources via current backups, retires before copy, retains vanished/preserved/archive evidence, and uninstall removes only owned recorded content. Consent none and malformed records fail closed without mutation. **Proof:** existing installer behavior fixtures plus real isolated install→update→retire→uninstall and failure-path readback.
- [ ] **SC3 — Exact native acquisition:** real TUI invokes the correct resolved `/skill:` body/resources, detects namespace shadowing/disabled filters, and task-aware use loads only relevant guidance. Plain work creates no automatic wish/card/stage procession. **Proof:** actual client transcript, resolved native paths/versions/warnings and observable artifacts.
- [ ] **SC4 — Native compatibility and blind admission:** unsupported/mismatched descriptors refuse; supported native preparation emits policy/version/input/schema/tool/source acknowledgement before any inference; forbidden context/SYSTEM/autoload/extensions/peer canaries are absent through rebuild/revive. **Proof:** native upstream preparation fixture with provider tripwire plus real-client independent admission trace; OMP version/build recorded.
- [ ] **SC5 — Reader-only exact review:** every reviewer differs from all authors/fixers, receives frozen criteria and exact snapshot, has read/grep/glob/yield only, no LSP/mutation/exec/device/custom/delegation/MCP, and snapshot/candidate identity is checked. **Proof:** direct native registry/dispatch permission fixture and real-client reviewer artifact/revision/manifest; failed/stale/absent identity blocks publication.
- [ ] **SC6 — Model and context handoff:** native recipients acquire the applicable contract, use evidenced inheritance/effort semantics, and report actual resolved model/effort/fallback. Sol-medium benchmark recipients match the pin; unknown identity retains generic guidance without silent rerouting. **Proof:** real-client native child metadata/context evidence, including configured role overrides and a different-recipient scenario.
- [ ] **SC7 — Admission policy parity:** size/trust/base/path/frozen-command/declared-subset/linked-design and criteria rules preserve current semantics; refusal has no implementation mutation. **Proof:** consumer-facing native CLI fixtures compared with current wish workflow behavior, including missing/malformed estimates, advisory units, protected bases and stale design digest.
- [ ] **SC8 — Actual binary gates:** common-dir/worktree/adoption/branch/cumulative scope and hooks are observed; wrong revision/dead hooks/unknown classification/no required command/process failure cannot pass; one selected foreground command and changed-path smoke are evidenced. **Proof:** real temporary Git/hook/process fixtures, exact Darwin boundary cases, actual installed-resource smoke and repository full gate at candidate.
- [ ] **SC9 — Bounded repairs and resume:** interrupted dispatch/commit/check/review preserves attempt disposition/budgets; null/no-write release is evidenced; identity conflict/corrupt/missing evidence blocks; changed SHA invalidates old receipts. **Proof:** deterministic interruption scenarios and native resume transcript, including fix committed before gate and no free retry after reset.
- [ ] **SC10 — Multi-group coordination:** approved DAG/claims/disjoint scope/coordinator HEAD policy and exact paths survive dependency waves and resume; separate implementation and quality passes retain their own budgets; no native todo becomes a lock. **Proof:** isolated multi-group native run with observed card/doc/evidence transitions and a losing-claim scenario; existing task-state authority unchanged.
- [ ] **SC11 — Authorized publication/readback:** missing gh causes no push/credential search; repeated publication reuses the PR; current gate/SHIP/author identity and exact candidate precede effects; actual remote SHA/OID/base/head/pathset/CI are read back. Pending→pr-open; failure/mismatch→blocked with artifacts preserved. No merge/force/bypass/base push/SHIPPED claim. **Proof:** negative fixed-command fixtures plus an explicitly authorized disposable forge integration against a nonprotected branch and native result readback.
- [ ] **SC12 — Self-contained installed resources:** helpers work from the exact copied wish skill under unrelated cwd/spaces, without sibling skills/Genie binary/node_modules; missing Node/resources fail actionably. New CLI success/refusal/stderr/idempotency are exercised. **Proof:** fresh subset install and delivered-resource execution, packaging/digest/retirement fixtures, no source-only substitution.
- [ ] **SC13 — Other-client compatibility:** Claude workflow bytes/behavior/stages/defaults/report/publication remain unchanged; affected shared skills still work in existing Claude/Codex/DSH discovery without OMP directives leaking into neutral roots. **Proof:** existing consumer behavior suites, installed skill-channel checks and actual affected client acquisition; repository full gate.
- [ ] **SC14 — Whole-framework authoring:** refine preserves switches, scope/schema/check/approval boundaries and source provenance; no rewrite runs automatically; roots/briefs carry only relevant contract and source-applicable guidance. **Proof:** authoring smoke of relevant and adversarial input, acquired-reference/readback evidence, unchanged runtime settings and absence of extra refine call in real task trace.
- [ ] **SC15 — Honest benchmark handoff:** exact supported native build and adaptation resource hashes/policies/model/effort/accounting limits are published to the parent plan; no Genie resources in baseline, no solution notes in solver context, original public oracles unchanged and no pilot-size/performance result inferred. **Proof:** separate arm inventories and pinned handoff record, real-client integration smoke and original-oracle result provenance when execution is later authorized.

## Next Step

After independent design review returns SHIP, persist and verify its content digest; then route to **wish** for a dependency-aware multi-group plan and separate plan review. **P0 remains an implementation blocker:** current OMP 18.6.0 cannot activate the approved native wish graph. Upstream native-policy work must be authorized and delivered separately before adaptive cutover or a complete adaptation claim. Independent design approval does not approve implementation, change native/user settings, execute benchmark tasks, choose the parent pilot size or authorize publication.

<!-- genie-design-review:start -->
## Design Review Evidence

- **Verdict:** SHIP
- **Reviewed content SHA-256:** `2a2c82fe50aa1fa636525dadf914d249dce56e1e3143725d2d55416924f60e21`
- **Reviewer:** OmpDesignReviewer
- **Reviewed at:** 2026-10-04T17:05:41.000Z
<!-- genie-design-review:end -->
