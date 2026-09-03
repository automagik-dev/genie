# Design: Genie board for DSH Web

| Field | Value |
|-------|-------|
| **Slug** | `dsh-genie-board` |
| **Date** | 2026-09-03 |
| **WRS** | 100/100 |

## Problem

DSH users cannot inspect or operate the authoritative Genie board from DSH Web. The integration must render Genie's real lifecycle lanes without turning `genie.db` into a cross-repository API or reviving the retired `genie mcp` / `genie ui-bridge` surfaces.

## Scope

### IN

- A dual-face DSH Web plugin at `plugins/dsh-genie-board/`, using `dsh-task-board` only as licensed UI, build, and plugin-loading schematics.
- Host-side execution of supported `genie board --json` and `genie task ...` commands in a DSH workspace selected by stable workspace id.
- A Genie-branded kanban that renders board-defined lanes, card metadata, and Host-confirmed mutations.
- Board selection plus task create, move, comment, block/unblock, checkout/release, and done actions supported by the current CLI.
- Fail-closed executable, workspace, argv, timeout, output-size, and JSON validation; same-origin Host routes; focused tests and a local linked-plugin smoke.
- Public installation documentation, reference attribution, release packaging, and the `dsh-plugin` GitHub topic after verification.

### OUT

- Direct reads or writes to `.genie/genie.db`.
- Reintroducing `genie mcp`, `genie ui-bridge`, a daemon, a plugin-owned ledger, or another Genie protocol.
- The reference plugin's cron scheduler, execution runner, continuation cards, handover bundles, or sleep inhibitor.
- Automatic task execution by DSH sessions, hard delete, task dependency editing, wish authoring, or promotion/deploy controls in v1.
- Homolog, production, stable release, or external announcement beyond the requested repository topic without a separate gate.

## Approach

Co-locate `@automagik/genie-dsh-board` under `plugins/dsh-genie-board/` in the public Genie repository. Its Host half receives a DSH workspace id, resolves that id through `workspaceRegistry`, requires a physical repository containing `.genie`, and invokes the installed `genie` executable with a fixed command allowlist, argv arrays, `shell: false`, a bounded environment, deadline, and output cap. Reads parse and validate `genie board list --json`, `genie board --board <ref> --json`, and `genie task status <id>` outputs; writes map a strict discriminated action union to current `genie task` commands and then return a fresh board snapshot.

The browser half follows the reference plugin's Cordis manifest, client injection, sidebar mount, CSS, and kanban component patterns while keeping Genie authoritative. It discovers eligible DSH workspaces from a Host endpoint, lets the user choose a workspace and board, re-fetches on explicit refresh, successful mutation, and page visibility recovery, and never applies optimistic task state. Host errors are bounded and visible.

Alternatives considered: `namastexlabs/dsh-plugins` would reuse DSH tooling but is private and publishing it would expose unrelated packages; a new public repository would add release/version-skew policy immediately; reviving MCP/ui-bridge contradicts their explicit retirement; direct SQLite access freezes a private schema. All lose to co-location plus the supported CLI.

## Simplicity Case

- **Simplest complete design:** one dual-face package, one in-memory request mapping, and the existing Genie CLI as the only state authority; browser state is replaced from confirmed snapshots.
- **Added machinery:** a Host route fence, strict action union, child-process deadline/output cap, and schema validation are required because a browser-triggered long-lived Host is crossing into repository mutations.
- **Deferred until measured:** SSE/file watchers, polling, caches, batch mutations, autonomous card execution, cron, and resumable requests stay out until explicit user demand or measured refresh latency makes manual/visibility refresh inadequate.
- **Complexity removed:** no new durable state, migration, socket, daemon, synchronization protocol, duplicate task ledger, or cross-repository compatibility matrix.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Package lives in `automagik-dev/genie` at `plugins/dsh-genie-board/`. | The adapter and the CLI contract ship together; the existing public repository can carry the requested topic without exposing unrelated private code. |
| 2 | Only current public CLI commands cross the boundary. | `genie mcp` and `genie ui-bridge` are explicit refusal stubs; SQLite is private. |
| 3 | Resolve workspace ids through DSH and never accept arbitrary browser paths. | Keeps path authority on the Host and prevents traversal or mutation of an unselected repository. |
| 4 | Mutations are strict action-to-argv mappings and refresh before response. | Prevents command injection and ensures the browser never displays unconfirmed state. |
| 5 | Copy only MIT-licensed plugin/UI schematics with attribution. | Reuses proven DSH mount mechanics without importing the reference ledger, scheduler, runner, or security assumptions. |
| 6 | v1 is a human board surface, not an execution orchestrator. | Meets the requested Genie-board integration while avoiding a second agent lifecycle and permission model. |
| 7 | Add the `dsh-plugin` topic only after build, tests, and linked-profile smoke succeed. | The topic is an external discoverability claim and should point to a working install path. |

## Risks & Assumptions

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| 1 | Current CLI output omits data or stable JSON for a desired action. | Medium | Freeze only observed documented JSON reads; make unsupported actions visible and add Genie-side JSON only when a concrete UI criterion requires it. |
| 2 | Browser-triggered CLI processes hang or emit excessive/malformed output. | High | Abort deadline, terminate child, cap stdout/stderr, validate JSON and exit code, and test every failure path. |
| 3 | DSH package APIs differ between local `0.1.1-rc.2` and the newer reference package. | Medium | Target and smoke the installed profile first; use only official injected services available locally and declare the proven engine floor. |
| 4 | Co-locating a DSH package silently breaks Genie's release payload. | Medium | Extend package/build/release manifests intentionally and run the repository's full check plus release verification for the affected platform contract. |
| 5 | Reference code is copied without attribution or drifts into unrelated behavior. | Medium | Preserve MIT attribution in package documentation/NOTICE and use a file-by-file provenance inventory in review. |
| 6 | Topic publication precedes a usable install. | Low | Topic mutation is the final, separately evidenced action after linked-plugin read-back. |

## Success Criteria

- [ ] In DSH Web, a user selects an eligible workspace and Genie board and sees lanes/cards semantically matching the same CLI JSON snapshot, including status, assignment, liveness, blocks, and comments where the CLI exposes them.
- [ ] Create and move round-trip through `genie task`, and every supported mutation returns a fresh confirmed snapshot with no optimistic browser state.
- [ ] An unknown workspace id, non-physical or non-Genie directory, missing executable, disallowed action, invalid input, timeout, oversized output, malformed JSON, or non-zero exit produces a bounded visible error and no out-of-scope mutation.
- [ ] The Host never invokes a shell, accepts an executable path or raw argv from the browser, reads SQLite directly, or persists a second task ledger.
- [ ] Package typecheck, unit tests, build, focused security tests, local `dsh plugin --profile web add link:...` smoke, and the Genie full gate pass against the final commit.
- [ ] Installation and compatibility are documented, copied reference portions are attributed, the plugin is included in the supported release payload, and `automagik-dev/genie` has the `dsh-plugin` topic.

## Next Step

After an independent design review returns SHIP, persist the evidence below and verify its content digest before running `wish`.

<!-- genie-design-review:start -->
## Design Review Evidence

- **Verdict:** PENDING
- **Reviewed content SHA-256:** PENDING
- **Reviewer:** PENDING
- **Reviewed at:** PENDING
<!-- genie-design-review:end -->
