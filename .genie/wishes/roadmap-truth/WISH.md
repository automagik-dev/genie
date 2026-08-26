# Wish: Roadmap Truth — deterministic lifecycle projection

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `roadmap-truth` |
| **Date** | 2026-08-06 |
| **Author** | Felipe + Genie council |
| **Appetite** | large — six independently shippable groups |
| **Branch** | `wish/roadmap-truth` |
| **Repos touched** | `automagik-dev/genie` |
| **Design** | _No brainstorm — direct wish_ |

## Observable Problem

For the same checked-in wish and task database, human board, JSON, MCP, and UI reads can disagree about the lifecycle lane or mutate state, while the orchestrator must separately create/link group rows before performing its existing claim and verified-completion duties.

## Direct-Wish Rationale

This plan proceeds directly from the completed 2026-08-06 five-lens council review (architecture, correctness, delivery, performance, and dissent/risk): the council established the authority split and narrowed the safe implementation seams, so no unreviewed or fabricated DESIGN artifact is claimed. The review specifically requires pure projection first, DB-only materialization at existing executable command boundaries, consumer evidence before any state removal, provider-neutral linting without install/doctor redesign, bounded installed context, and measurement before hook optimization.

## Scope

### IN

- One exact, side-effect-free lifecycle parser/projector and a versioned `LifecycleCard v1` read API shared by human board, JSON, MCP, and UI bridge.
- Stable wish/group identity and automatic materialize-and-claim only at two concrete existing CLI boundaries: `genie task checkout --wish <slug> --group <group-id> --worker <name>` and non-dry `genie launch <slug> [--groups <csv>]`.
- A read-only consumer/portability audit followed by a written demolition decision; no state deletion in this wish.
- Removal of imperative provider CLI commands from the two known shared guidance surfaces, plus narrowly scoped lint/parity coverage.
- An installed lightweight-bypass contract and exact compact-context byte budgets; review-fan-out policy remains unchanged.
- A reproducible hook/session baseline and attribution report; no optimization or latency gate in this wish.
- Removal of PR #2751's roadmap read-side writer, while preserving its exact `task link` recovery primitive.

### OUT

- Deleting or changing the `wish_groups` table, `wish_sig`, `roadmap.json`, `.genie/INDEX.md`, snapshot/import semantics, or any current database index/`UNIQUE` constraint.
- Claiming DB transactions can roll back worktrees, panes, spawned agents, or any other external side effect.
- Automatic materialization in the model-driven/native `$work` skill, which has no executable transaction boundary.
- Rewriting doctor, install, update, skill-discovery precedence, or user-tier cleanup unless a provider-lint fixture added by this wish reproduces a concrete defect; any such defect becomes a separately reviewed follow-up.
- Changing review fan-out, proportional-validation policy, existing independent-review gates, or release/security/CI criteria.
- Hook/session optimization, a 30% latency promise, caching, daemon, watcher, or background synchronization.
- Same-visible-roadmap fresh-clone equivalence; a clone without the local database cannot reproduce local manual cards or runtime task state.
- Provider-specific adapter removal or a ban on descriptive provider names.

## Authority and Compatibility Contracts

### Lifecycle precedence (first matching rule wins)

Projection operates from one immutable input snapshot and never writes. Manual/unlinked cards are outside this precedence and retain their stored lane.

1. Reject an unsafe slug, symlinked/out-of-root artifact, oversize artifact, unreadable artifact, malformed metadata, or unknown status with a visible diagnostic; do not derive or overwrite a card from that input.
2. If an exact WISH exists with `SHIPPED`, `DONE`, or `EXECUTED`, project `Done`, regardless of group rows.
3. If exact `(wish, group-id)` task rows exist and every declared group is complete, project `Review`; undeclared, duplicate, or missing declared rows add diagnostics and never count as complete.
4. If any declared group row exists and at least one declared group is not complete, project `Work`; `BLOCKED` is a card badge/reason, not a separate lane.
5. With no materialized group rows, canonical `IN_PROGRESS` or `BLOCKED` projects `Work`.
6. With no materialized group rows, canonical `DRAFT`, `FIX-FIRST`, or `APPROVED` projects `Wish`.
7. With no WISH, an exact DESIGN artifact for the same validated slug projects `Brainstorm`.
8. With neither WISH nor DESIGN, an exact idea task carrying `tasks.wish=<slug>` projects `Idea`.
9. With no exact artifact or identity match, emit no lifecycle card; title or prefix inference is forbidden.

The lifecycle-projection group owns the complete compatibility table: `DONE -> SHIPPED` and `EXECUTED -> SHIPPED`, and no other aliases. Each alias use emits diagnostic code `LEGACY_WISH_STATUS` containing the source value and replacement. The sunset target is v6.0.0; removal is permitted only after the checked-in wish corpus has zero alias uses in two consecutive releases, otherwise v6.0.0 must retain the aliases and warning.

### `LifecycleCard v1`

```ts
type LifecycleLane = 'Idea' | 'Brainstorm' | 'Wish' | 'Work' | 'Review' | 'Done';
type LifecycleDiagnostic = {
  code: string;
  severity: 'warning' | 'error';
  message: string;
  sourcePath?: string;
};
type LifecycleBlockedReason = {
  kind: 'dependency' | 'enforced';
  groupId: string;
  reason: string;
};
type LifecycleCardV1 = {
  schemaVersion: 1;
  id: `wish:${string}`;
  wishSlug: string;
  lane: LifecycleLane;
  status: 'DRAFT' | 'FIX-FIRST' | 'APPROVED' | 'IN_PROGRESS' | 'BLOCKED' | 'SHIPPED' | null;
  source: 'idea' | 'design' | 'wish';
  groupCounts: {
    declared: number;
    ready: number;
    inProgress: number;
    dependencyBlocked: number;
    enforcedBlocked: number;
    done: number;
  };
  blockedReasons: readonly LifecycleBlockedReason[];
  operations: { openArtifact: boolean; inspectTasks: boolean; move: false };
};
type LifecycleProjectionResultV1 = {
  schemaVersion: 1;
  wishSlug: string;
  card: LifecycleCardV1 | null;
  diagnostics: readonly LifecycleDiagnostic[];
};
type LifecycleProjectionInput = Readonly<{
  artifacts: readonly Readonly<LifecycleArtifactSnapshot>[];
  tasks: readonly Readonly<LifecycleTaskSnapshot>[];
  manualCards: readonly Readonly<ManualCardSnapshot>[];
}>;

loadLifecycleProjectionInput(repoRoot: string, db: Database): Promise<LifecycleProjectionInput>;
projectLifecycleCard(input: LifecycleProjectionInput, wishSlug: string): LifecycleProjectionResultV1;
listLifecycleCards(input: LifecycleProjectionInput): readonly LifecycleProjectionResultV1[];
```

`loadLifecycleProjectionInput` is the only filesystem/DB loader: it reads each bounded artifact once, reads lifecycle task/manual-card rows in one SQLite read transaction, copies bytes/rows into immutable values, and sorts them before returning. The projector and materializer import this snapshot/parser contract; neither rereads or reparses artifacts independently.

Deterministic ordering is part of v1: card-bearing results sort by lane rank `Idea, Brainstorm, Wish, Work, Review, Done`, then `wishSlug`; null-card results follow all cards and sort by result `wishSlug`, then their first diagnostic tuple. Task inputs and group-derived output sort by `groupId`, then task ID. A group explicitly marked blocked counts only as `enforcedBlocked`; otherwise an incomplete group with an unmet dependency counts as `dependencyBlocked`; remaining incomplete unclaimed groups count as ready. `blockedReasons` sort by `kind` (`dependency` before `enforced`), then `groupId`, then `reason`; diagnostics sort by severity (`error` before `warning`), then code, source path (missing path sorts first), then message. Rejected/unknown input returns `{ schemaVersion: 1, wishSlug, card: null, diagnostics: [...] }`, so diagnostics remain visible without inventing a card.

Human board, `board --json`, MCP `genie_board`, and the UI bridge may only list/get these results and open the referenced artifact or inspect exact tasks. Virtual cards have no create, move, claim, complete, or delete operation; execution mutations remain task commands. All surfaces serialize the same fields and diagnostic codes; presentation-only labels may differ.

### Stable identity and mutation boundary

- A wish slug must match `^[a-z0-9]+(?:-[a-z0-9]+)*$`, be 1–64 ASCII characters, equal its artifact directory name, and be collision-checked before persistence. The collision namespace is the union of non-null `tasks.wish`, `.genie/brainstorms/<slug>/` (including DESIGN), `.genie/wishes/<slug>/` (including WISH), and projected/virtual `wish:<slug>` IDs; each source has a fixture. The lifecycle key is exactly `wish:<slug>` and is never reconstructed from a title after capture.
- `genie idea` derives a base once by NFKD-normalizing the title, dropping combining marks, lowercasing, joining maximal ASCII alphanumeric runs with `-`, truncating to 64 characters, and trimming a trailing `-`. Let `h12` be the first 12 lowercase hex characters of SHA-256 over the original UTF-8 title. An empty/non-Latin base becomes `idea-<h12>`; a namespace collision becomes `<base-truncated-to-51>-<h12>`. Only collision of that hashed fallback refuses creation and requests an explicit grammar-valid `--slug`. The chosen value is persisted in `tasks.wish` and never re-derived.
- A group ID must match `^[a-z0-9]+(?:-[a-z0-9]+)*$`, be 1–64 ASCII characters, and be unique within the WISH. The task linkage is exactly `tasks.wish=<slug>` plus `tasks.group_name=<group-id>`; dependency references use the literal group ID. Group headings, `--groups`, task rows, dependency parsing, claims, prompts, and projection must preserve the same bytes.
- New wishes must declare `### Group <group-id>:`. Historical headings are accepted only when their extracted ID already satisfies the grammar; ambiguity, duplicates, unknown dependencies, or cycles stop before mutation.
- Legacy `genie task checkout <id> --worker <name>` remains unchanged. The new mutually exclusive form is `genie task checkout --wish <slug> --group <group-id> --worker <name>`: mixing an ID with `--wish/--group`, omitting both selectors, supplying only one of `--wish/--group`, or omitting `--worker` exits 2 with no mutation; unknown wish plan/group exits 1 with no mutation; same-worker retry succeeds with no new event; different-worker retry conflicts and exits 1; first success emits exactly one claim event.
- Idea creation, the new checkout form, and non-dry `genie launch` each start `BEGIN IMMEDIATE`. Idea creation rechecks all four slug-namespace sources inside that transaction immediately before inserting the task. Materialization rechecks exact `(tasks.wish, tasks.group_name)` rows and dependency edges inside that transaction immediately before insert, reuses exactly one matching row/edge, and refuses pre-existing duplicates rather than guessing. Non-dry launch claims selected ready groups in that same DB transaction before any pane/worktree launch. No existing or new uniqueness constraint is credited for serialization; separate-connection and separate-process races cover idea slug allocation and group materialization/claim.
- `genie launch --dry-run` parses and reports only; it writes no DB rows and claims nothing. Retry returns the existing exact row/edge and never duplicates it.
- Engineers perform no lifecycle bookkeeping. The orchestrator still invokes the existing claim boundary, acknowledges successful claims, and remains the only actor that marks verified completion; the change removes prerequisite create/link rituals, not orchestrator claim/completion responsibility. Engineer prompts contain no checkout/done instruction.
- Atomicity ends at the SQLite commit. If later worktree, pane, or dispatch creation fails, the command reports the already-claimed task IDs and an exact recovery instruction; it does not promise cross-system rollback.

## Dependencies

**depends-on:** none

`proportional-validation-policy` coordinates only the worker-context byte-budget fixtures in Group `automatic-materialization`; that group must not ship until those fixtures use the existing policy's terminology and gates. It is deliberately not a wish-level graph edge because the current graph cannot express group-scoped coordination without incorrectly blocking all groups.

**blocks:** none

There is no wish-level blocking graph edge: `genie-official-roadmap` coordination ends as soon as Group `lifecycle-projection` ships, and the graph cannot express that partial unblock without overstating the dependency.

## Success Criteria and Ownership Map

| Criterion | Owning group |
|---|---|
| All four roadmap surfaces return byte-equivalent `LifecycleProjectionResultV1` data and repeated reads leave DB bytes/events/timestamps and artifact bytes unchanged | `lifecycle-projection` |
| Exact canonical/legacy parsing, exhaustive precedence, unsafe-input diagnostics, and alias warning/sunset behavior are table-tested | `lifecycle-projection` |
| Stable slug/group IDs propagate without title inference | `automatic-materialization` |
| Both concrete CLI boundaries atomically materialize exact rows/edges and claim selected ready groups; dry-run is read-only and retries are idempotent | `automatic-materialization` |
| Consumer inventory covers every named state/snapshot/index surface and ends in a reviewed keep/remove/defer follow-up decision, without schema or snapshot mutation | `state-demolition` |
| The two known shared guidance surfaces contain no imperative provider CLI invocation; lint rejects representative command forms and generated parity holds | `provider-neutrality` |
| The approved source bypass behaves identically in the installed artifact, and installed session context stays within reduced exact budgets | `harness-budget` |
| Hook/session baseline records command, environment, samples, warmup, p50/p95, raw observations, and attribution without changing runtime behavior | `hook-fast-path` |
| Current review topology, proportional validation, `roadmap.json`, `wish_groups`, INDEX, and database constraints remain unchanged except removal of PR #2751's read-side writer | Owning group for each touched surface; aggregate final review |

## Execution Strategy

Writable ownership below is exclusive. Generated artifacts are owned by the same group as their source, so no two parallel groups regenerate the same file.

| Wave | Group | Depends on | Complexity | Model | Exclusive responsibility |
|---|---|---|---|---|---|
| 1 (parallel) | `lifecycle-projection` | none | 4 — multi-surface, read-state risk | engineer-complex / high + independent reviewer | Immutable loader/parser/API and four read consumers |
| 1 (parallel) | `provider-neutrality` | none | 3 — shared guidance and lint | engineer-standard / high + independent reviewer | Two bounded guidance edits and provider-command lint fixtures |
| 2 (parallel) | `automatic-materialization` | `lifecycle-projection` | 5 — transactional/concurrent CLI boundary | engineer-complex / high + independent reviewer | CLI-boundary DB materialization/claim using the shipped parser/identity contract |
| 2 (parallel) | `harness-budget` | `provider-neutrality` | 3 — installed parity/context boundary | engineer-standard / high + independent reviewer | Installed bypass parity and session context only; no routing-policy change |
| 3 (parallel) | `state-demolition` | `automatic-materialization` | 3 — broad consumer audit, no mutation | engineer-standard / high + independent reviewer | Audit-only QA report after final materialization shape |
| 3 (parallel) | `hook-fast-path` | `harness-budget` | 3 — security-sensitive measurement | engineer-standard / high + independent reviewer | Benchmark final bundle and evidence only |

### Aggregate review

After all groups, one independent reviewer checks the unchanged-state promises, cross-group identity contract, file ownership, and full validation. Existing repository review gates remain in force.

## Execution Groups

### Group lifecycle-projection: Exact projection and API

**Goal:** Make every roadmap reader consume one pure, exhaustive lifecycle projection.

**Exclusive file ownership:**

- `src/lib/v5/wish-lifecycle.ts` (new)
- `src/lib/v5/wish-lifecycle.test.ts` (new)
- `src/lib/v5/wish-document.ts` (new)
- `src/lib/v5/wish-document.test.ts` (new)
- `src/term-commands/v5-board.ts`
- `src/term-commands/v5-board.test.ts`
- `src/lib/v5/mcp-tools.ts`
- `src/lib/v5/mcp-tools.test.ts`
- `src/term-commands/ui-bridge.ts`
- `src/term-commands/ui-bridge.test.ts`

**Deliverables:**

1. Implement the one immutable `LifecycleProjectionInput` loader, the exact WISH/group parser, precedence, compatibility owner/warning/sunset, `LifecycleCard v1` result, ordering, and pure list/project functions above.
2. Wire human board, JSON, MCP, and UI bridge to the same projection; remove PR #2751's read-time writer, broad prefix mapper, and read-created events while retaining exact `task link` mutation behavior.
3. Test immutable one-read snapshot loading; every canonical value and both aliases; misleading prefixes (`INVALID`, `INSECURE`, `SHIPPING`); each precedence transition; null-card diagnostics; deterministic card/task/reason/diagnostic ordering; partial/missing/extra groups; manual-card coexistence; and unsafe/unreadable/symlink/oversize artifacts.

**Independent gate (required; high-risk state/read surface):** a reviewer other than the implementer must compare all four serialized outputs and prove two repeated reads preserve a captured pre/post SQLite file hash, task-event count, timestamps, and hashes of every artifact read by the fixture.

**Acceptance Criteria:**

- [ ] The loader/parser, `LifecycleProjectionResultV1`, deterministic ordering, and all nine precedence rules are implemented exactly once and consumed by all four readers and imported by materialization.
- [ ] Every listed parser/alias/unsafe-input fixture passes with exact diagnostics.
- [ ] The independent mutation-parity gate passes; no board read writes.
- [ ] Existing exact `task link` recovery tests remain green.

**Validation:**

```bash
bun test src/lib/v5/wish-lifecycle.test.ts src/lib/v5/wish-document.test.ts src/term-commands/v5-board.test.ts src/lib/v5/mcp-tools.test.ts src/term-commands/ui-bridge.test.ts
bun test src/term-commands/v5-task.test.ts
bun run typecheck
```

**depends-on:** none

---

### Group automatic-materialization: Stable identity at executable boundaries

**Goal:** Remove prerequisite create/link rituals by materializing exact group tasks when the orchestrator performs its existing claim at either DB-backed CLI boundary.

**Exclusive file ownership:**

- `src/lib/v5/task-state.ts`
- `src/lib/v5/task-state.test.ts`
- `src/term-commands/v5-task.ts`
- `src/term-commands/v5-task.test.ts`
- `src/term-commands/idea.ts`
- `src/term-commands/idea.test.ts`
- `src/term-commands/launch.ts`
- `src/term-commands/launch.test.ts`
- `skills/brainstorm/SKILL.md`
- `plugins/genie/skills/brainstorm/SKILL.md` (generated counterpart)
- `skills/wish/SKILL.md`
- `plugins/genie/skills/wish/SKILL.md` (generated counterpart)
- `skills/wish/templates/wish-template.md`
- `plugins/genie/skills/wish/templates/wish-template.md` (generated counterpart)
- `skills/work/SKILL.md`
- `plugins/genie/skills/work/SKILL.md` (generated counterpart)
- `scripts/wishes-lint.ts`
- `scripts/wishes-lint.test.ts`

**Deliverables:**

1. Import the lifecycle group's immutable loader/parser; persist the exact collision-checked slug during `genie idea` capture; and carry the exact identity through brainstorm, wish/template/linter, work prompt, task linkage, dependency, command selection, and projection without a second parser.
2. Add lookup/materialize-and-claim to `task checkout --wish/--group` and non-dry `launch`; use the existing task/dependency schema and constraints without changing `wish_groups`, INDEX, or snapshot behavior.
3. Keep `launch --dry-run` read-only. Commit DB rows/edges/claims before external launch; on later launch failure report claimed IDs and recovery, never claim external rollback.
4. Replace engineer checkout/done instructions only where this group dispatches them; require orchestrator claim acknowledgement and orchestrator-only verified completion.
5. Curate worker handoff to at most 12,288 UTF-8 bytes, including only selected group, mapped criteria, owned files, dependencies, validation, stop conditions, and a shared policy excerpt of at most 1,024 bytes; exclude full WISH, INDEX, other groups, and Review Results. Test budget-1/budget/budget+1 and multibyte input.
6. Test every collision namespace source and fallback; separate-connection and multiprocess idea/materialization races; both checkout forms and exact exit/event behavior; empty DB; exact/pre-existing duplicate rows; two waves; partial readiness; group subset; retry; malformed/duplicate IDs; unknown dependency; cycle; DB rollback; and post-commit external-launch failure.

**Independent gate (required; high-risk mutation):** a reviewer other than the implementer runs concurrency and injected-failure fixtures, inspects the resulting rows/edges/events, and confirms no schema/index change.

**Acceptance Criteria:**

- [ ] Exact identity propagates through idea, brainstorm, wish/template/linter, heading, imported parser, task linkage, dependency, CLI selection, prompt, and projection.
- [ ] Both concrete boundaries materialize and claim in one DB transaction; a second invocation creates no duplicate row, edge, or event.
- [ ] `BEGIN IMMEDIATE`, in-transaction namespace/row/edge rechecks, duplicate refusal, separate-connection/process races, legacy/new checkout compatibility, exact exits, and exact claim-event counts pass without schema/index changes.
- [ ] Dry-run has zero DB mutation, DB failure rolls back DB changes, and post-commit external failure reports recovery without claiming rollback.
- [ ] Engineers receive work without checkout/done commands; orchestrator acknowledgement and completion ownership are explicit.
- [ ] Worker handoff is <=12,288 bytes and its policy excerpt <=1,024 bytes with forbidden sources absent.

**Validation:**

```bash
bun test src/lib/v5/task-state.test.ts src/term-commands/idea.test.ts src/term-commands/v5-task.test.ts src/term-commands/launch.test.ts scripts/wishes-lint.test.ts
bun run wishes:lint
bun run skills:lint
bun scripts/sync-plugin-skills.ts --check
bun run typecheck
```

**depends-on:** lifecycle-projection

---

### Group state-demolition: Consumer audit and follow-up decision

**Goal:** Establish whether duplicate state can be removed safely without deleting or migrating anything in this wish.

**Exclusive file ownership:**

- `.genie/wishes/roadmap-truth/qa/state-consumer-audit.md` (new)

**Deliverables:**

1. Inventory every production/test read and write of `wish_groups`, `wish_sig`, `task_dependencies`, `roadmap.json`, `.genie/INDEX.md`, and all current task/index uniqueness semantics, including CLI, MCP, UI bridge, doctor, import/export, migration, tests, and release tooling. Each row records symbol/file, read/write, authority assumed, portability effect, and covering test.
2. Audit manual-card intent separately from artifact-derived lanes and runtime state; explicitly state what a fresh clone cannot reproduce.
3. End with one reviewed decision table: keep, port-then-remove in a named follow-up, or defer. A removal follow-up must specify consumer ports, migration preflight, backup path, restore command, downgrade reader/version window, ambiguity refusal, retry, and preservation of original DB bytes before any destructive proposal is accepted.
4. Record whether the current task/index `UNIQUE` intent is required by each consumer; do not alter it.

**Independent gate (required; high-risk state scope):** a reviewer other than the auditor samples every inventory category with `rg`/tests and rejects any deletion recommendation lacking restore and downgrade contracts.

**Acceptance Criteria:**

- [ ] The inventory has no unclassified named surface or consumer category.
- [ ] The decision names a follow-up and prerequisites; this wish performs no schema/table/snapshot/INDEX/index deletion or migration.
- [ ] Fresh-clone limits, manual-card portability, and exact restore/downgrade requirements are explicit.

**Validation:**

```bash
rg -n "wish_groups|wish_sig|task_dependencies|roadmap\.json|INDEX\.md|CREATE UNIQUE|UNIQUE" src plugins scripts skills tests
bun test src/lib/v5/genie-db.test.ts src/lib/v5/task-state.test.ts src/term-commands/v5-task.test.ts src/lib/v5/mcp-tools.test.ts src/term-commands/ui-bridge.test.ts src/genie-commands/doctor.test.ts
```

**depends-on:** automatic-materialization

---

### Group provider-neutrality: Bounded command removal and lint

**Goal:** Stop shared guidance from instructing agents to invoke provider CLIs, without redesigning provider installation or runtime adapters.

**Exclusive file ownership:**

- `skills/genie-hacks/references/catalog.md`
- `plugins/genie/skills/genie-hacks/references/catalog.md` (generated counterpart)
- `plugins/genie/references/codex-integration-map.md`
- `scripts/skills-lint.ts`
- `scripts/skills-lint.test.ts`

**Deliverables:**

1. Replace imperative provider CLI invocations in the two named guidance sources with semantic native delegation language.
2. Add lint fixtures for inline, fenced, quoted, piped, and env-prefixed imperative `codex`, `claude`, and `hermes` commands while allowing descriptive prose and provider-specific adapter source/tests.
3. Prove source/generated catalog parity. Do not touch doctor/install/update; if a new fixture reproduces a real distribution defect, capture it as a separate follow-up rather than expanding this group.

**Independent gate (required; provider/release-facing):** a reviewer other than the implementer checks lint false positives/negatives and the exact generated diff, and confirms adapter tests remain unchanged and green.

**Acceptance Criteria:**

- [ ] The named shared guidance no longer issues provider CLI commands.
- [ ] All five command forms fail fixtures, descriptive references pass, and adapter implementation remains in scope.
- [ ] Source/generated catalog bytes match and no doctor/install/update file changes.

**Validation:**

```bash
bun run skills:lint
bun test scripts/skills-lint.test.ts scripts/sync-plugin-skills.test.ts
bun scripts/sync-plugin-skills.ts --check
git diff --exit-code -- src/genie-commands/doctor.ts src/genie-commands/doctor.test.ts src/genie-commands/install.ts src/genie-commands/install.test.ts
```

**depends-on:** none

---

### Group harness-budget: Installed bypass parity and compact session context

**Goal:** Make the already-approved source bypass behave identically when installed and reduce session context without changing routing or review policy.

**Exclusive file ownership:**

- `plugins/genie/skills/genie/SKILL.md` (generated counterpart)
- `plugins/genie/scripts/src/session-context.ts`
- `plugins/genie/scripts/session-context.cjs` (generated bundle)
- `plugins/genie/scripts/session-context.test.ts`
- `scripts/fresh-install-smoke.ts`
- `scripts/fresh-install-smoke.test.ts`

**Deliverables:**

1. Copy/ship the already-approved source lightweight bypass byte-for-byte and prove source-versus-installed behavior parity using the existing approved routing fixtures. Do not add a keyword classifier, new risk trigger, or routing branch before the deferred deterministic risk-table/historical-replay work.
2. Reduce the existing 2 KiB SessionStart cap: no-active-wish output is <=256 UTF-8 bytes and active-wish output is <=1,024 UTF-8 bytes, including only stable identity, canonical status, and an artifact pointer. Full WISH, INDEX, group bodies, policy text, and Review Results are forbidden.
3. Test source/installed byte and behavior equivalence plus session boundaries at budget-1, budget, and budget+1 bytes, multibyte text, missing artifact, no-active wish, and active wish against the final built/installed bundle.
4. Leave current bypass classification and review fan-out untouched. A follow-up may change either only after a deterministic risk table maps each trigger to required gates and a historical replay over shipped wishes reports false-positive/false-negative cases; reviewer != engineer remains mandatory.

**Independent gate (required; routing/context):** a reviewer other than the implementer executes source-versus-installed byte/behavior parity and session boundary fixtures and confirms no source routing or review policy changed.

**Acceptance Criteria:**

- [ ] Every already-approved source bypass fixture has byte/behavior-equivalent installed results; no new classifier or routing branch exists.
- [ ] No-active SessionStart is <=256 bytes and active SessionStart is <=1,024 bytes, both below the prior 2 KiB cap, with forbidden sources absent.
- [ ] Review topology is byte-unchanged; the replay/risk-table work is explicitly deferred.

**Validation:**

```bash
bun test scripts/fresh-install-smoke.test.ts plugins/genie/scripts/session-context.test.ts
bun scripts/sync-plugin-skills.ts --check
git diff --exit-code -- skills/review/SKILL.md plugins/genie/skills/review/SKILL.md skills/fix/SKILL.md plugins/genie/skills/fix/SKILL.md
```

**depends-on:** provider-neutrality

---

### Group hook-fast-path: Reproducible baseline and attribution

**Goal:** Measure hook/session costs and attribute them before proposing any optimization.

**Exclusive file ownership:**

- `tests/hooks/genie-hook-perf.test.ts`
- `.genie/wishes/roadmap-truth/qa/hook-baseline.json` (new, raw observations)
- `.genie/wishes/roadmap-truth/qa/hook-baseline.md` (new, commands and attribution)

**Deliverables:**

1. After `harness-budget` has generated and parity-checked the final installed bundle, benchmark that exact `plugins/genie/scripts/dispatch-runtime.cjs` for representative no-op, deny, and ask events and that exact `plugins/genie/scripts/session-context.cjs` with no active wish and one active wish. Do not name or require an upstream-generated artifact before this wave.
2. At group start, record SHA-256 hashes for both benchmarked bundles, `plugins/genie/hooks/hooks.json`, and a sorted path/hash manifest of `src/hooks/**`; repeat the same hash capture at group end and require equality. This group-specific pre/post manifest, not an aggregate worktree diff, proves the benchmark did not mutate runtime inputs.
3. Use exactly 20 unrecorded warmups followed by 100 recorded samples per case on an otherwise idle host. Capture `uname -a`, CPU model (`sysctl -n machdep.cpu.brand_string` where available), logical CPU count, RAM, Bun/Node versions, commit SHA, dirty flag, final-bundle build/parity command, benchmark command, fixture bytes, and child-process count.
4. Store every raw duration in milliseconds and decision/output digest in `qa/hook-baseline.json`; report per case sample count, p50, p95, min/max, externally measured total duration, empty-runtime startup control, startup residual (`case total - median empty-runtime control`, floored at zero), and observed child-process count in `qa/hook-baseline.md`. Do not add internal timers or claim parse/I/O/validation attribution.
5. Do not optimize or add a performance gate here. Open an optimization follow-up only for a case whose p95 is >= 50 ms; adopt a future change only if the same harness/host shows >= 20% p95 improvement, all 100 decision/output digests match baseline, and child-process count does not increase.

**Independent gate (required; security-sensitive hooks):** a reviewer other than the benchmark author reruns one no-op and every deny/ask case, verifies raw percentile/residual calculation, and compares the captured group-start/group-end hash manifests.

**Acceptance Criteria:**

- [ ] The final-bundle harness, environment, warmup, 100 samples, raw path, p50/p95, total/startup-residual/process-count attribution are reproducible from the report.
- [ ] Baseline output/decision digests and child-process counts are recorded for every case.
- [ ] Captured group-start/group-end runtime-input hash manifests match exactly without relying on aggregate git diff.
- [ ] No hook/session optimization or 30% gate is introduced; the >=50 ms follow-up and >=20% adoption thresholds are applied only after measurement.

**Validation:**

```bash
bun run build
GENIE_HOOK_PERF_WARMUP=20 GENIE_HOOK_PERF_SAMPLES=100 GENIE_HOOK_PERF_RAW=.genie/wishes/roadmap-truth/qa/hook-baseline.json bun test tests/hooks/genie-hook-perf.test.ts
bun test plugins/genie/scripts/dispatch-runtime.test.ts plugins/genie/scripts/session-context.test.ts src/hooks/__tests__/
bun run lint:hook-bundles
bun run lint:hook-content
```

**depends-on:** harness-budget

## QA Criteria

- [ ] `lifecycle-projection`: compare the four exact `LifecycleProjectionResultV1` payloads and the read-only hashes/events/timestamps evidence.
- [ ] `automatic-materialization`: run empty/existing/concurrent/retry/DB-failure/post-commit-external-failure cases and inspect exact IDs/edges/claims.
- [ ] `state-demolition`: independently sample every consumer category and verify the audit proposes no schema, snapshot, INDEX, or index mutation in this wish.
- [ ] `provider-neutrality`: run five rejected command forms, allowed descriptive/adapter cases, and source/generated parity.
- [ ] `harness-budget`: run approved-source versus installed byte/behavior parity and session boundary/multibyte fixtures; confirm routing and review gates are untouched.
- [ ] `hook-fast-path`: rerun the documented benchmark and validate raw p50/p95 math, decision digests, attribution, and no-runtime-change proof.
- [ ] Aggregate: `bun run check`, `bun run build`, and `V5_E2E_BUILD=1 bash tests/e2e/v5-lifecycle.sh` pass after all group-focused gates.

## Risks

| Risk | Mitigation / owner |
|---|---|
| Projection accidentally becomes a writer or precedence diverges | Pure API plus byte/event/timestamp proof and independent `lifecycle-projection` gate |
| Concurrent idea/materialization duplicates or claims wrong work | `BEGIN IMMEDIATE`, exact in-transaction rechecks, duplicate refusal, multiprocess fixtures, independent `automatic-materialization` gate; no uniqueness-constraint assumption |
| External launch fails after DB commit | Acknowledge DB-only atomicity and return claimed IDs/recovery; never promise worktree/pane rollback |
| Consumer audit misses a destructive dependency | Exhaustive category inventory and independent `state-demolition` sampling; deletion deferred |
| Provider lint bans legitimate adapters or expands into installer redesign | Scoped paths/fixtures and independent `provider-neutrality` false-positive review |
| Installed lightweight bypass drifts from approved routing | Byte/behavior parity with the unchanged source bypass, session boundary tests, unchanged review topology |
| Benchmark noise or security regression drives premature optimization | Fixed harness/raw evidence, independent rerun, decision digests, thresholded follow-up only |

## Review Results

### Final plan review — BLOCKED (2026-08-06T21:15:07Z)

- **Reviewed content SHA-256:** `98c72985bf8dfade944bf29665c590de5307f4ce185045eb556020958fbca4a4`
- **Validation:** `rtk bun run wishes:lint` passed (70 files, zero structural/graph issues).
- **Fix budget:** 2/2 loops used; no model/effort escalation.
- **Cause:** `ambiguous-spec` — the remaining gaps require explicit lifecycle-contract choices, not more reviewer capacity.
- **Remaining HIGH gaps:**
  1. Define readonly/no-create behavior for absent, stale, or malformed `genie.db`, including DB/WAL/SHM non-creation fixtures.
  2. Define the mixed surface envelope that carries stored manual/unlinked cards alongside `LifecycleProjectionResultV1`; a manual card cannot inhabit the current `wish:*` lifecycle type.
  3. Preserve current stale different-worker claim recovery while retaining live-claim conflict and exact event/exit behavior.
  4. Trim a trailing hyphen after the 51-character slug truncation, validate the final grammar, and cover that boundary fixture.
- **Remaining MEDIUM gap:** the `harness-budget` group must run `lint:hook-bundles` and `lint:hook-content` itself.
- **Corrective route:** obtain the human lifecycle choices above, amend the WISH without widening scope, then start a fresh independent plan review. No implementation is authorized while status remains `DRAFT`.

## Files to Create/Modify

The exact per-group inventories above are authoritative. Across this wish they cover:

```text
.genie/wishes/roadmap-truth/WISH.md
.genie/wishes/roadmap-truth/qa/state-consumer-audit.md
.genie/wishes/roadmap-truth/qa/hook-baseline.json
.genie/wishes/roadmap-truth/qa/hook-baseline.md
src/lib/v5/wish-lifecycle.ts
src/lib/v5/wish-lifecycle.test.ts
src/lib/v5/wish-document.ts
src/lib/v5/wish-document.test.ts
src/lib/v5/task-state.ts
src/lib/v5/task-state.test.ts
src/lib/v5/mcp-tools.ts
src/lib/v5/mcp-tools.test.ts
src/term-commands/v5-board.ts
src/term-commands/v5-board.test.ts
src/term-commands/ui-bridge.ts
src/term-commands/ui-bridge.test.ts
src/term-commands/v5-task.ts
src/term-commands/v5-task.test.ts
src/term-commands/idea.ts
src/term-commands/idea.test.ts
src/term-commands/launch.ts
src/term-commands/launch.test.ts
skills/brainstorm/SKILL.md
plugins/genie/skills/brainstorm/SKILL.md
skills/wish/SKILL.md
plugins/genie/skills/wish/SKILL.md
skills/wish/templates/wish-template.md
plugins/genie/skills/wish/templates/wish-template.md
skills/work/SKILL.md
plugins/genie/skills/work/SKILL.md
scripts/wishes-lint.ts
scripts/wishes-lint.test.ts
skills/genie-hacks/references/catalog.md
plugins/genie/skills/genie-hacks/references/catalog.md
plugins/genie/references/codex-integration-map.md
scripts/skills-lint.ts
scripts/skills-lint.test.ts
plugins/genie/skills/genie/SKILL.md
plugins/genie/scripts/src/session-context.ts
plugins/genie/scripts/session-context.cjs
plugins/genie/scripts/session-context.test.ts
scripts/fresh-install-smoke.ts
scripts/fresh-install-smoke.test.ts
tests/hooks/genie-hook-perf.test.ts
```

Explicitly unchanged by this wish: `src/lib/v5/genie-db.ts` schema, `wish_groups`, `wish_sig`, `roadmap.json` behavior/schema, `.genie/INDEX.md` semantics, current task/index `UNIQUE` constraints, doctor/install/update behavior, review fan-out, and existing proportional-validation/release/security gates.
