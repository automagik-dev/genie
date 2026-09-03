# Wish: Genie board for DSH Web

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `dsh-genie-board` |
| **Date** | 2026-09-03 |
| **Author** | Sofia with Felipe |
| **Appetite** | medium |
| **Branch** | `wish/dsh-genie-board` |
| **Repos touched** | genie |
| **Design** | [DESIGN.md](../../brainstorms/dsh-genie-board/DESIGN.md) |

## Summary

Ship a dual-face DSH Web plugin that displays and operates the authoritative Genie board through supported Genie CLI commands. The plugin lives with Genie, never opens `genie.db`, and keeps browser state subordinate to Host-confirmed snapshots.

## Scope

### IN

- `plugins/dsh-genie-board/`: Host adapter, same-origin routes, browser kanban, DSH manifest, package build, tests, and install docs.
- Workspace/board discovery, board rendering, and supported create/move/comment/block/unblock/checkout/release/done mutations.
- Fixed executable and action-to-argv mappings with no shell, plus deadlines, aggregate subprocess/output budgets, JSON validation, and bounded errors.
- Release-payload integration, reference attribution, linked-profile smoke, and topic publication only after validation.

### OUT

- Direct SQLite access; revival of `genie mcp` or `genie ui-bridge`; plugin ledgers, watchers, polling, SSE, cron, or autonomous execution.
- Hard delete, dependency editing, wish authoring, deploy controls, production promotion, and announcements beyond the requested GitHub topic.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Co-locate the package in public Genie. | Adapter and CLI compatibility ship together without exposing the private DSH monorepo. |
| 2 | Use only current CLI commands and validated JSON. | SQLite is private and former protocol surfaces are retired. |
| 3 | Resolve DSH workspace ids on the Host and map a strict action union to argv. | Browser input never becomes a path, executable, raw command, or arbitrary argv. |
| 4 | Use board JSON as the canonical snapshot; enrich only from structured data. | Human-formatted `task status` is not a compatibility contract. |
| 5 | If needed, add the smallest `genie task status <id> --json` contract. | Supplies liveness/comments without reviving a resident protocol; plugin pins its Genie version floor. |
| 6 | Refresh the selected board after every mutation. | The browser never displays optimistic state. |

## Simplicity Case

- **Simplest complete design:** one dual-face plugin, one strict Host adapter, and the existing Genie CLI as sole authority.
- **Added machinery:** route fencing, action validation, process/output caps, and optional structured status enrichment are required by browser-triggered mutations and requested card detail.
- **Deferred until measured:** polling, SSE, caches, deltas, batching, autonomous execution, cron, and resumable requests require explicit demand or measured refresh latency.
- **Complexity removed:** no durable state, daemon, socket, synchronization protocol, human-output parser, duplicate ledger, or configurable command surface.

## Dependencies

**depends-on:** none
**blocks:** none

## Success Criteria

- [ ] DSH Web selects an eligible workspace/board and renders lanes/cards matching validated CLI JSON, including structured assignment, block, liveness, and comment data.
- [ ] All supported mutations map to fixed Genie argv and return a fresh confirmed snapshot.
- [ ] Unsafe workspace/action/input, timeout, aggregate limit, malformed JSON, missing executable, and non-zero exit fail visibly without out-of-scope mutation.
- [ ] No shell, browser-provided path/executable/argv, direct SQLite access, human-output parser, plugin ledger, watcher, or daemon exists.
- [ ] Plugin tests/typecheck/build, security tests, linked-profile smoke, Genie full gate, and release verification pass.
- [ ] Install/compatibility docs and attribution are complete; only then the repository gains the `dsh-plugin` topic.

## Execution Strategy

### Wave 1 (sequential)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 1 | implementor | 3 — CLI contract plus multi-module surface | implementor-mid / high | Freeze structured reads and compatibility floor. |

### Wave 2 (after Wave 1)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 2 | implementor | 5 — DSH integration plus subprocess/security boundaries | implementor-high / high | Build and test the dual-face plugin. |

### Wave 3 (after Wave 2)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 3 | implementor | 3 — release payload and external topic gate | implementor-mid / high | Package, smoke, document, and publish discoverability. |

## Execution Groups

### Group 1: Structured CLI contract

**Goal:** Freeze the smallest stable JSON surface the plugin needs without parsing human output.

**Deliverables:**
1. Fixtures for board-list and lane-board JSON, including assignment and enforced blocks.
2. Bounded enrichment: at most 20 card-detail subprocesses per refresh, concurrency 4, total deadline 10 seconds, aggregate stdout/stderr 4 MiB.
3. If required fields are absent, additive `genie task status <id> --json` with success/not-found/stderr/exit/idempotent-read tests; otherwise document why it is unnecessary.
4. Compatibility floor pinned to the first Genie release providing all consumed fields.

**Acceptance Criteria:**
- [ ] No human CLI output is parsed; every consumed JSON key has a fixture/schema assertion.
- [ ] The 20-card, concurrency-4, 10-second, and 4-MiB bounds are deterministic and tested.

**Validation:**
```bash
bun test src/term-commands/v5-board.test.ts src/term-commands/v5-task.test.ts && bun run check
```

Full gate is required because this changes a shared CLI contract.

**depends-on:** none

---

### Group 2: DSH Host adapter and kanban

**Goal:** Deliver the secure, Host-confirmed DSH Web board experience.

**Deliverables:**
1. Package/manifest/build scaffold using locally proven official DSH injections and attributed reference schematics.
2. Workspace discovery and fixed CLI runner with `shell: false`, bounded environment, strict actions, process/output limits, validation, and same-origin routes.
3. Browser selectors, lanes/cards/details/errors, mutation controls, refresh, and visibility recovery without optimistic state.
4. Unit/component/security tests, including hostile identifiers and no-command-injection assertions.

**Acceptance Criteria:**
- [ ] Rendering matches fixture-backed Host snapshots; mutations use fixed argv and refresh.
- [ ] Every unsafe/failure case is bounded and cannot invoke an out-of-scope command.
- [ ] No database access, persistence, watcher, poller, shell, or browser-supplied executable/path/argv exists.

**Validation:**
```bash
bun run check && bun run build:plugin && bun test plugins/dsh-genie-board
```

Full gate plus plugin build covers runtime and trust-boundary risk.

**depends-on:** Group 1

---

### Group 3: Install, release, and discoverability

**Goal:** Prove the packaged plugin can be installed locally before advertising it.

**Deliverables:**
1. Install/compatibility docs, provenance/NOTICE, and release manifest inclusion with version parity.
2. Linked-profile smoke covering install, restart/read-back, board load, and reversible create/move in an isolated fixture repo.
3. Final clean-checkout release verification; only after it passes, add the GitHub topic.

**Acceptance Criteria:**
- [ ] Artifact contains the plugin/manifests/docs with matching versions.
- [ ] Linked install/read-back and reversible smoke pass without changing a user repository.
- [ ] Topic publication occurs last and is verified by read-back.

**Validation:**
```bash
bun install --frozen-lockfile && bun run check && bun run build:plugin && bun run verify:release
```

Repository full/release gates cover distribution and external compatibility claims.

**depends-on:** Group 2

---

## QA Criteria

- [ ] Fixture repository loads workspace, board, lanes, details, and errors correctly in DSH Web.
- [ ] Every supported mutation round-trips and only confirmed refreshed state renders.
- [ ] Adversarial route/action/path/identifier cases cannot escape fixed command/workspace boundaries.
- [ ] Existing Genie CLI output and non-DSH release behavior remain compatible.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| DSH APIs drift from installed `0.1.1-rc.2`. | Medium | Use locally proven injections, linked smoke, and tested engine floor. |
| Per-card detail creates subprocess pressure. | Medium | Hard cap count/concurrency/bytes/time and expose partial-detail warnings. |
| Additive JSON becomes a public contract. | Medium | Fixture every key and pin plugin compatibility floor. |
| Release payload omits co-located files. | High | Update manifests and verify final tarballs from a clean checkout. |

---

## Review Results

_The read-only reviewer returns evidence; the invoking orchestrator appends a timestamped block here._

---

## Files to Create/Modify

```
plugins/dsh-genie-board/**
src/term-commands/v5-task.ts
src/term-commands/v5-task.test.ts
scripts/build.js
scripts/sync.js
scripts/verify-release.sh
package.json
README.md
.genie/brainstorms/dsh-genie-board/**
.genie/wishes/dsh-genie-board/WISH.md
.genie/INDEX.md
```
