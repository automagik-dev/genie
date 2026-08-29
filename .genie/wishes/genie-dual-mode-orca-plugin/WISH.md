# Wish: Genie dual-mode Orca plugin — Option A

| Field | Value |
|-------|-------|
| **Status** | APPROVED — design SHIP and plan SHIP 2026-08-29 |
| **Slug** | `genie-dual-mode-orca-plugin` |
| **Date** | 2026-08-29 |
| **Author** | Codex wish author |
| **Appetite** | large |
| **Branch** | `wish/genie-dual-mode-orca-plugin` |
| **Repos touched** | `automagik-dev/genie` |
| **Design** | [DESIGN.md](../../brainstorms/genie-dual-mode-orca-plugin/DESIGN.md) |

## Summary

Add an explicit dual-mode lifecycle contract: standalone mode remains backward compatible, while Orca mode
makes Orca the sole lifecycle authority through a closed, schema-validated public CLI adapter. Ship the plugin,
its lifecycle and release support, and documentation before retiring the superseded Genie MCP surface.

## Scope

### IN

- Global `orchestration.mode` schema with `standalone` default and one central resolver.
- Fail-closed pre-open lifecycle-DB and pre-write roadmap barriers covering direct and indirect writable paths.
- Genie-owned Orca plugin using only allowlisted `orca orchestration <verb> ... --json` argv with `shell: false`.
- Closed input, output, receipt, read-back, timeout, output-cap, runtime-resolution, and typed-error contracts.
- Plugin manifests/marketplaces, compatibility probe, real-runtime smoke, install/update/rollback/uninstall, explicit
  mode switching, ownership-safe cleanup, `doctor`, release inventory, supported tarballs, and user/contributor docs.
- Parity-first retirement of `genie mcp` and only registrations proven Genie-owned, with a stable retired diagnostic.

### OUT

- Typed/private Orca host APIs, internal RPC, direct Orca DB access, Orca forks, or terminal injection.
- Shell strings, caller-selected executables/argv/flags, generic process runners, or configurable allowlists.
- Local fallback, mirrors, caches, queues, retry ledgers, background synchronization, or a second lifecycle store.
- Migration or deletion of existing lifecycle history; Linear, telemetry, daemon, or named-model requirements.
- Source implementation, board/global-DB mutation, release promotion, or PR creation as part of this planning wish.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | `standalone` is default; Orca mode is explicit. | Existing users retain behavior and authority changes remain intentional. |
| 2 | Guard DB pre-open and roadmap pre-write seams. | Low-level barriers make a missed caller fail closed before mutation. |
| 3 | Refuse authoritative local reads and writes in Orca mode. | Stale reads create a competing source of truth. |
| 4 | Use a compiled CLI grammar and platform spawn with `shell: false`. | This is the public boundary and removes injection extension points. |
| 5 | Require validated receipts and public read-backs where available. | Exit zero alone cannot prove an authoritative mutation. |
| 6 | Keep no fallback or lifecycle state in the plugin. | Orca remains sole authority when selected. |
| 7 | Retire MCP last in a slim, revertible PR. | Parity, lifecycle, packaging, and migration docs must land first. |

## Simplicity Case

- **Simplest complete design:** one two-value mode, two low-level authority barriers, and one stateless adapter over a
  finite public CLI table; standalone behavior is otherwise unchanged.
- **Added machinery:** schemas, bounded process execution, receipts/read-backs, lifecycle transitions, and packaging
  proof are presently required by the trust boundary, deterministic failure contract, safe ownership, and releases.
- **Deferred until measured:** no caches, retries, remote protocol, configurable allowlist, or background coordination;
  a new verb requires a design amendment plus schema/argv/response and threat-review evidence.
- **Complexity removed:** no daemon, mirror, dual-write, migration, typed host integration, arbitrary runner, Linear
  dependency, or model routing policy.

## Dependencies

**depends-on:** none
**blocks:** none

## Success Criteria

- [ ] Omitted config resolves to `standalone`; only `standalone | orca` validates, and malformed config fails clearly.
- [ ] In Orca mode every lifecycle DB path refuses before DB/WAL/SHM creation or migration, and every roadmap write
  refuses before file change; direct and indirect task/board/sync/export/former-MCP fixtures prove both invariants.
- [ ] Standalone focused and full regression suites retain the approved compatibility contract.
- [ ] Every approved verb has exact positive argv and negative schema/flag-shaped-input tests; unlisted verbs,
  terminal/routing/placement flags, raw argv, caller `--json`, malformed data, and shell evaluation fail pre-spawn.
- [ ] Runtime selection is deterministic; execution is bounded; stdout is one valid envelope; errors are typed; mutation
  read-backs prove identity and immutable fields wherever the public CLI offers a read path. A post-spawn timeout,
  output-limit, or transport failure before a valid receipt supplies a newly created ID never triggers inferred
  entity lookup or retry: receipt-only mutations and unidentified creates return `ambiguous_after_possible_commit`
  for operator/external confirmation, and only an identifier known before launch permits its exact table-defined read.
- [ ] A packaged-plugin smoke against supported real Orca creates and reads back a disposable Run/Task without changing
  local Genie lifecycle state; an unsupported host fails `unsupported_environment` without fallback.
- [ ] Install/update/rollback/uninstall and mode switches preserve user config/history, touch only Genie-owned
  registrations, are idempotent and backup-first where applicable, and expose truthful `doctor` diagnostics.
- [ ] Plugin/marketplace/package/VERSION versions agree; release inventory is complete; every supported tarball builds
  and passes content/installation verification with stable remaining the default channel.
- [ ] Docs cover selection, authority, recovery, compatibility, upgrade, rollback, uninstall, unsupported environments,
  and MCP retirement without private APIs or obsolete v6 assumptions.
- [ ] MCP runtime/tools/launchers and proved-owned registrations are removed only in A7; legacy invocation exits non-zero
  with its stable diagnostic while standalone and release parity remain green.
- [ ] Each implementation PR targets `automagik-dev/genie:dev`, starts from then-current dev, attaches exact-head CI and
  independent review evidence, and receives a fresh independent review after fixes.

## Execution Strategy

There is no stacked-PR requirement. Each PR branches from then-current `dev`; a semantic dependency must merge first,
then the dependent branch rebases or is recreated on updated `dev`. A0 is the docs-only commit containing the
canonical DRAFT, DESIGN, WISH, and INDEX entry plus the pending evidence block; fresh independent review and a valid
digest stamp gate its documentation PR and all later work. A1 and A2 can then run in parallel and each be green
against dev independently. A3 is independently green after A2; A4 after A1+A3; A5 after A3+A4; A6 after A4+A5; A7
after A1–A6. The merge graph, not cross-branch imports, supplies required semantics.

### Wave 0 (authoritative plan)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| A0 | wish author + independent reviewer | 1 — documentation contract | engineer-trivial / low | Commit the four canonical pending-review docs; fresh review then stamps the DESIGN digest before any PR or implementation. |

### Wave 1 (parallel after A0 merges)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| A1 | engineer + independent reviewer | 4 — stateful authority boundary | engineer-complex / high | Mode resolver, DB/roadmap barriers, parity fixtures. |
| A2 | engineer + independent reviewer | 4 — security-sensitive process boundary | engineer-complex / high | Closed adapter, schemas, runner, receipts, hermetic tests. |

### Waves 2–6 (semantic merge order)

| Wave | Group | Agent | Complexity | Model | Description |
|------|-------|-------|------------|-------|-------------|
| 2 | A3 | engineer + independent reviewer | 4 — plugin/runtime integration | engineer-complex / high | Plugin payload, compatibility probe, real-runtime smoke. |
| 3 | A4 | engineer + independent reviewer | 5 — lifecycle transitions | engineer-complex / high | Standalone preservation, transitions, ownership, doctor. |
| 4 | A5 | engineer + independent reviewer | 3 — package/release boundary | engineer-standard / high | Manifests, inventory, tarballs, release checks. |
| 5 | A6 | docs engineer + independent reviewer | 2 — cross-surface docs | engineer-standard / medium | Operator/contributor and retirement guidance. |
| 6 | A7 | engineer + independent reviewer + final gate | 5 — retirement/release parity | engineer-complex / high + final-gate | MCP retirement last and full cleanup proof. |

For A1–A7, use TDD: failing focused test, minimum implementation, narrow proof, repository gates, exact-head PR CI.
The implementer cannot provide independent review. Findings are fixed on the same PR and reviewed again; CI and review
evidence attach to the final SHA. Release promotion remains separately authorized and is not performed by these groups.

## Execution Groups

### Group A0: Canonical plan documents pending fresh review

**Goal:** Make the amended Option-A design and executable plan canonical without operational state changes, then
obtain fresh independent design review and digest stamping before approval or implementation.

**Deliverables:**
1. Pending-review candidate `DRAFT.md`, `DESIGN.md`, `WISH.md`, and canonical `INDEX.md` entry; digest-bound evidence
   is added only after fresh independent review of the exact committed four-document set.
2. Docs-only commit containing the current amended four-document candidate; its committed SHA is recorded before
   fresh independent review.

**Acceptance Criteria:**
- [ ] Fresh independent review stamps amended reviewable DESIGN candidate SHA-256
  `1b8b6c034310fab2699214866893658a4c041d9269a971bb685d57bc359f7dfe`; evidence verification then passes and
  all four canonical documents consistently advance from pending.
- [ ] After fresh evidence is stamped, Wish and INDEX linters pass; the candidate diff contains only the four
  canonical planning documents. Before stamping, their evidence-gate failure is expected and recorded.

**Validation:**
```bash
node skills/brainstorm/references/design-review-evidence.mjs verify .genie/brainstorms/genie-dual-mode-orca-plugin/DESIGN.md
bun run wishes:lint
git diff --check
```

**depends-on:** none

---

### Group A1: Mode schema and authority barriers

**Goal:** Make lifecycle authority explicit and make local lifecycle state unreachable in Orca mode before mutation.

**Deliverables:**
1. Global config schema/resolver and stable typed refusal.
2. DB pre-open and roadmap pre-write barriers with complete caller inventory and isolated fixtures.

**Acceptance Criteria:**
- [ ] Standalone default/parity and invalid-mode diagnostics are tested.
- [ ] Orca fixtures prove no DB/WAL/SHM or roadmap creation/change through every direct and indirect entrypoint.

**Validation:**
```bash
bun test src
bun install --frozen-lockfile
bun run check
```

**depends-on:** A0

---

### Group A2: Closed Orca CLI adapter core

**Goal:** Translate validated operations into a finite, safe public Orca CLI grammar with trustworthy results.

**Deliverables:**
1. Per-verb schemas/argv, deterministic runtime resolution, bounded `shell: false` runner, and redacted typed errors.
2. Validated envelopes, receipts/read-backs, capability table, and exhaustive hermetic positive/negative fixtures.

**Acceptance Criteria:**
- [ ] Every design table row emits exactly its documented argv and one final `--json`.
- [ ] Forbidden fields/flags and malformed/boundary inputs fail before spawn; transport/read-back failures are typed.
- [ ] Hermetic post-spawn failure fixtures prove no mutation retry or collection-based identity inference; receipt-only
  mutations and creates without a valid identifying receipt return `ambiguous_after_possible_commit`, while only
  mutations with an independently known identifier may issue their exact allowlisted public read-back.

**Validation:**
```bash
bun test plugins/genie
bun install --frozen-lockfile
bun run check
```

**depends-on:** A0

---

### Group A3: Plugin payload and runtime proof

**Goal:** Package the adapter as a Genie-owned Orca plugin and prove the supported host boundary end to end.

**Deliverables:**
1. Plugin manifests/marketplace, adapter wiring, compatibility declaration, and child-process capability probe.
2. Plugin tests plus supported-real-runtime disposable Run/Task create/read-back smoke and cleanup.

**Acceptance Criteria:**
- [ ] Packaged plugin exposes only approved semantics and carries no lifecycle store or fallback.
- [ ] Real-runtime smoke proves Orca authority/local-state non-mutation; unsupported hosts fail closed.

**Validation:**
```bash
bun test plugins/genie
bun install --frozen-lockfile
bun run check
```

**depends-on:** A2

---

### Group A4: Lifecycle preservation, transitions, and doctor

**Goal:** Make installation and authority transitions safe, idempotent, ownership-aware, and diagnosable.

**Deliverables:**
1. Standalone parity plus install/update/rollback/uninstall and explicit mode-switch flows.
2. Backup/idempotency/ownership fixtures, transactional config commit after probe, and truthful `doctor`.

**Acceptance Criteria:**
- [ ] Failure at every transition boundary preserves prior config, registrations, databases, roadmaps, and Orca records.
- [ ] Uninstall removes only Genie-owned plugin artifacts/registrations and never lifecycle history.

**Validation:**
```bash
bun test src plugins/genie
bun install --frozen-lockfile
bun run check
```

**depends-on:** A1, A3

---

### Group A5: Packaging and release artifacts

**Goal:** Make the complete dual-mode plugin reproducible and verifiable in every supported release artifact.

**Deliverables:**
1. Version-consistent manifests/marketplaces/VERSION/package metadata and release inventory.
2. Build and content/install verification for every supported tarball; stable remains default.

**Acceptance Criteria:**
- [ ] Version/inventory checks fail on drift or missing payload.
- [ ] Every supported tarball builds and verifies from a clean environment.

**Validation:**
```bash
bun install --frozen-lockfile
bun run check
bun test scripts/release-payload-version.test.ts scripts/verify-release.test.ts scripts/release-docs.test.ts
for platform in linux-x64-glibc linux-x64-musl linux-arm64 darwin-arm64; do
  bash scripts/build-binary.sh --platform "$platform" --version "$(tr -d '\n' < VERSION)"
  bash scripts/verify-release.sh --local "dist/genie-$(tr -d '\n' < VERSION)-$platform.tar.gz"
done
```

**depends-on:** A3, A4

---

### Group A6: Operator and contributor documentation

**Goal:** Give users and maintainers complete, testable guidance for dual-mode authority.

**Deliverables:**
1. Operator guidance in `README.md` for mode selection, authority, compatibility, recovery, upgrade, rollback,
   uninstall, unsupported hosts, and the planned MCP-retirement migration.
2. Contributor guidance in `plugins/genie/references/orca-orchestration.md` for the threat boundary and
   verb-amendment process, plus mirrored/plugin links from the operator surface.
3. Extend `scripts/release-docs.test.ts` with a targeted dual-mode documentation contract that reads both files and
   asserts the required operator/contributor topics and public-only examples.

**Acceptance Criteria:**
- [ ] Examples match shipped CLI and contain no private APIs, terminal injection, fallback, or v6 assumptions.
- [ ] The targeted release-docs test fails when either named documentation surface or a required topic disappears;
  links, plugin mirrors, generated docs if any, and recovery rituals also validate.

**Validation:**
```bash
bun test scripts/release-docs.test.ts
bun run wishes:lint
bun run check
```

**depends-on:** A4, A5

---

### Group A7: MCP retirement and lifecycle cleanup

**Goal:** Remove superseded Genie MCP only after dual-mode parity and migration support are proven.

**Deliverables:**
1. Remove MCP server/tools/launchers and proved-owned registrations; keep stable non-zero retired diagnostic.
2. Retirement docs, stale-reference inventory, both-mode regression, tarball, and uninstall cleanup proof.

**Acceptance Criteria:**
- [ ] No Genie MCP runtime ships or registers; unowned config and lifecycle history stay untouched.
- [ ] Full gates, tarballs, both-mode parity, migration docs, and exact-head CI pass after removal.

**Validation:**
```bash
bun install --frozen-lockfile
bun run check
bun test
bun test scripts/release-payload-version.test.ts scripts/verify-release.test.ts scripts/release-docs.test.ts
for platform in linux-x64-glibc linux-x64-musl linux-arm64 darwin-arm64; do
  bash scripts/build-binary.sh --platform "$platform" --version "$(tr -d '\n' < VERSION)"
  bash scripts/verify-release.sh --local "dist/genie-$(tr -d '\n' < VERSION)-$platform.tar.gz"
done
```

**depends-on:** A1, A2, A3, A4, A5, A6

---

## QA Criteria

- [ ] On dev, clean standalone preserves task/board/sync behavior and needs no Orca runtime.
- [ ] On dev, explicit Orca mode completes disposable real-runtime Run/Task proof with no local lifecycle mutation.
- [ ] Install → update → rollback → uninstall and mode transitions preserve user-owned data and recover cleanly.
- [ ] Every supported tarball installs, reports compatible versions/doctor state, and contains no MCP runtime after A7.
- [ ] Legacy `genie mcp` returns the documented stable non-zero retirement diagnostic.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Plugin host forbids child processes. | High | A3 probes it and fails `unsupported_environment`; do not change transport. |
| Public response lacks a required proof field. | High | Treat mutation as unsupported until the public contract proves it. |
| A writable local path bypasses routing. | High | Guard low-level seams and independently review A1's caller inventory. |
| Cleanup removes user-owned config. | High | Ownership markers, backup-first fixtures, and failure injection. |
| Parallelism becomes an accidental stack. | Medium | Merge prerequisites, rebase dependents on dev, never import sibling branches. |
| Release payload drifts. | Medium | Version/inventory assertions and clean-build verification in A5/A7. |

---

## Review Results

- **Current amended candidate — SHIP:** independent reviewer
  `term_fb7838bc-745e-45ba-9d62-becc5d842e07` returned SHIP at `2026-08-29T17:57:45Z` for reviewable DESIGN
  content SHA-256 `1b8b6c034310fab2699214866893658a4c041d9269a971bb685d57bc359f7dfe` and plan SHIP. Evidence: the diff is
  limited to the four canonical planning documents; no stale review grants authorization; P1 remains no-retry with
  recovery reads limited to an exact identifier known before launch; the A1–A7 DAG is unchanged; and the digest and
  diff checks are clean.
- **Earlier superseded plan-review provenance:** on 2026-08-29 at 17:04 UTC, independent reviewer
  `term_62af8174-811d-4720-911e-a2891f6a0698` accepted the prior plan at
  reviewed commit `57a732da11de9d0816afd3e51cb7c05056ec04f4`, including design digest
  `dbc9f025e10ceba93b424fcf7fe0d38203c1fb82f5d94a980b9a8614d67d0c4d`. The P1 contract correction superseded
  that evidence; it does not approve or verify the amended design or this current plan.
- **Historical baseline receipt for the unrelated release-assets timeout:** reviewed commit `57a732da11de9d0816afd3e51cb7c05056ec04f4`
  and its baseline parent `3c17272fc7c9a0f3c85f3feab28f80aec3f5ce06` contain the byte-identical
  `scripts/reconcile-release-assets.test.ts` Git blob `698fdc3334cf5271702d621d533f029775c0021c`. The exact focused command
  `bun test scripts/reconcile-release-assets.test.ts` produced **2 fail / 3 pass / exit 1** on both trees: the empty-draft
  case exceeded its 5,000 ms timeout (the subprocess returned exit code 3 before the assertion), and the selected-channel
  fanout case exceeded its 15,000 ms timeout. Because the failing test bytes and focused outcome were unchanged from the
  immutable baseline, the reviewer classified the timeout as pre-existing/environmental rather than an Option-A
  planning-doc regression.

---

## Files to Create/Modify

```text
A0: .genie/brainstorms/genie-dual-mode-orca-plugin/{DESIGN.md,DRAFT.md}
    .genie/wishes/genie-dual-mode-orca-plugin/WISH.md
    .genie/INDEX.md
A1–A7: exact source/test/plugin/release/doc paths are resolved from then-current dev; each PR records actual files and
       keeps ownership disjoint before execution.
```
