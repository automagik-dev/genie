# Design: Genie cleanup release — standalone contained, native Orca plugin

| Field | Value |
|-------|-------|
| **Slug** | `genie-dual-mode-orca-plugin` |
| **Date** | 2026-08-28 |
| **WRS** | 100/100 |
| **Program dependency** | `stablyai/orca/orca-plugin-orchestration-api` must SHIP and release first |
| **Predecessor evidence** | `origin/v6/corpo-leve@19a016b85f8a2c86afcc0fd280c526b2c57395d7`; recovered rev. 3.3 design SHA-256 `dc761bcad4acf4fbc5f305cc0fa3c4e4c72b37121f65fc21163a3690e259a418`; reviewed-content digest `d91de43a1d03ba55f87652182b2a008ea42246eeae7c8e05aec9b35d2c4d2889` |

## Problem

Genie currently mixes an independent standalone board lifecycle with integration and delivery machinery that should not participate in Orca execution, creating duplicate state, drifting payloads and ambiguous authority. The cleanup release must preserve standalone behavior while making Orca mode a real native Orca plugin whose execution state lives only in Orca and whose installation does not initialize, read, write or mirror the Genie board.

This is not a “Genie v6” product initiative. The eventual version follows the normal release contract after compatibility impact is measured.

## Scope

### IN

- Add an explicit installation choice: `standalone` or `orca`, with non-interactive selection and idempotent reinstall/update behavior.
- Store the project-owned mode in committed `.genie/mode`; resolve `GENIE_MODE` > repository marker anchored at `git-common-dir` > global default > `standalone`, with malformed or unreadable values resolving to `unresolved` and failing closed.
- Preserve the existing standalone board/task runtime and its user-owned state.
- Mechanically prevent Orca mode from opening the write-capable Genie database or creating/mutating `.genie/genie.db` and `.genie/roadmap.json`.
- Keep board/task verbs registered in Orca mode but return a typed explanatory refusal; make hook-driven board sync a silent no-op.
- Retire the Genie MCP command, server, registrations, integration checks and MCP-specific delivery surfaces in both modes.
- Rehome the standalone skills, role templates and supported hooks required after legacy plugin-delivery cleanup; preserve their behavior with parity fixtures before deleting obsolete mirrors/machinery.
- Ship Orca mode as one Genie-owned Orca plugin with a versioned manifest, explicit capabilities, Genie brainstorm/wish/work/review skills, commands, WISH validation and typed calls to native Orca orchestration host APIs.
- Require a released upstream Orca capability contract for Run, Task, Dispatch and gate reads/mutations, lifecycle events, repository/workspace identity and worker result delivery.
- Keep Linear optional and non-authoritative. `Tracker` remains a closed choice of `linear:<ids>`, `#<issue>` or `none`.
- Validate Orca-mode WISHes mechanically: exact base branch + 40-hex SHA, matching Run/Task identifiers, safe worktree name, closed agent/model/effort/tracker enums and bounded validation command fields.
- Record execution provenance append-only in WISH.md after verified transitions; never read provenance back to decide dispatch.
- Provide tested install, update, rollback, uninstall and mode-switch behavior that preserves WISHes and dormant standalone state.
- Publish the first release through a Genie-owned marketplace with no custom panel.

### OUT

- Deleting or rewriting the standalone board/task implementation.
- Treating standalone as frozen legacy; it remains a supported independent mode.
- Synchronizing, importing, exporting, projecting or reconciling Genie board state with Orca.
- Implementing the upstream Orca plugin API in this repository or this WISH.
- Shelling out to `orca orchestration`, invoking the Orca CLI from the plugin worker or shipping a compatibility fallback.
- Making Linear mandatory, authoritative or one-issue-per-execution-group.
- Recreating a Genie board in an Orca panel.
- Shipping a panel in the first plugin release.
- Submitting to the public Orca marketplace before the Genie-owned release has measured adoption and stability.
- Deleting Omni, UI or unrelated standalone features without their own reviewed scope.
- Choosing a marketing or semantic major-version label before compatibility evidence exists.

## Approach

### 1. Two supported modes, resolved once

A committed `.genie/mode` contains exactly `standalone` or `orca`. The repository marker is anchored through `git-common-dir` so all worktrees share the same decision. `GENIE_MODE` remains an explicit operator override. Unknown, malformed, oversized or unreadable values resolve to `unresolved`; no invalid repository value may fall through to a global standalone default.

Standalone installs and runs the existing board/task lifecycle. Orca installs the native plugin and document workflow but no board authority. The same source release may contain both payloads; installation selects one complete payload rather than installing both and hiding half through prose.

### 2. Mechanical board isolation

The write-capable database primitive owns the final gate. In Orca mode it refuses before SQLite is opened. A command-boundary hook translates that typed refusal for human board/task verbs; hook-driven `task sync` exits successfully and silently. `genie context --wish --plan` remains read-only and computes the integration branch/base SHA without persisting board state.

A fresh Orca repository must not create `genie.db` or `roadmap.json`. Switching an existing standalone repository to Orca leaves its database dormant and byte-identical; switching back re-enables it. Mode operations never delete user state.

### 3. Cleanup without degrading standalone

Before removing obsolete integration mirrors or delivery machinery, capture standalone goldens for CLI help, task/board behavior, export shape, hooks and lifecycle tests. Rehome only the assets that standalone still needs into one canonical CLI/skills/templates path. Remove MCP entirely and remove legacy plugin-delivery code only after parity proves the surviving standalone payload.

The cleanup is subtraction, not a board redesign: no new board verbs, schema, UI or synchronization layer.

### 4. Native Orca plugin, blocked on a released API

The plugin contributes the mode-specific skills and commands and uses typed host capabilities only. Its manifest pins the released Orca version and exact capability identifiers delivered by `stablyai/orca/orca-plugin-orchestration-api`. Installation consent names every read, mutation and event capability.

The plugin worker may validate WISH documents and call those host methods. It must have no product path that executes a shell, invokes the Orca CLI, reaches undeclared network services or writes a second lifecycle store. Orca remains the sole owner of Run/Task/Dispatch/gate state.

The Genie WISH is structurally blocked until the upstream Orca WISH has an independently reviewed SHIP result and a released compatibility target. No compatibility plugin ships while the dependency is absent.

### 5. Git-native intent and evidence

The Dispatch plan in WISH.md is upstream input used to create Orca state. Verified outcomes append a bounded provenance record with timestamp, group, Run/Task/Dispatch IDs, effective agent/model/effort, coordinator-verified SHA range, independent verdict and validation summary. Provenance is never a synchronization source and is not consumed to schedule subsequent work.

### 6. Delivery order

1. Freeze standalone parity and add negative Orca-mode lifecycle fixtures.
2. Land mode resolution and the mechanical database boundary.
3. Retire MCP and rehome surviving standalone assets before deleting obsolete mirrors.
4. Wait for the released upstream Orca capability contract; pin its exact version/capabilities.
5. Build and test the native Orca plugin with no CLI fallback.
6. Prove install/update/mode-switch/rollback/uninstall behavior for both modes.
7. Publish through the Genie-owned marketplace and run a real Orca-mode WISH journey.
8. Consider a panel or public marketplace only after measured adoption.

### Alternatives rejected

- **Delete the board:** rejected by Felipe; standalone remains a supported independent product mode.
- **Permanent dual installation with runtime branching:** rejected because it keeps duplicate payloads and makes mode isolation depend on prose.
- **Plugin worker invoking the CLI:** rejected because it bypasses the explicit plugin capability/consent boundary and is not the native integration requested.
- **Skills-only plugin:** rejected because it improves packaging but does not provide typed lifecycle integration.
- **One WISH spanning Orca and Genie:** rejected because the repositories, release authorities and acceptance evidence are independently shippable. The program uses two linked WISHes.
- **Panel in the first release:** rejected by the Simplicity Gate; it adds a projection before the core native workflow is proven.

## Simplicity Case

- **Simplest complete design:** one committed mode marker, one mechanical database gate, one preserved standalone payload and one native Orca plugin pinned to an upstream capability release.
- **Added machinery:** mode resolution is paid for by the need to prevent accidental board writes across clones/worktrees; the plugin capability dependency is paid for by the explicit requirement to avoid shell/CLI fallback; WISH validation is paid for because approved document fields become orchestration input.
- **New durable states:** only committed `.genie/mode`. Orca lifecycle state stays in Orca; standalone task state stays in the existing database; no bridge store, cache or reconciliation ledger is added.
- **Recovery paths:** invalid mode fails closed; mode switching is reversible because standalone data remains dormant; plugin rollback uses Orca’s plugin install/update boundary; missing upstream capabilities block installation rather than degrading behavior.
- **Deferred until measured:** a native panel after at least one real end-to-end Genie plugin workflow proves the host API and users need a visual surface; public marketplace submission after the Genie-owned package demonstrates stable upgrades and consent; no other speculative coordination layer.
- **Complexity removed:** Genie MCP, board↔Orca sync concepts, loose Orca skill drift, CLI-backed plugin fallback, duplicate execution authority and premature panel state.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Support `standalone` and `orca`; standalone keeps the board | Explicit Felipe lock; “end board bullshit” means contain it outside Orca, not delete it |
| 2 | Use committed `.genie/mode` with fail-closed `unresolved` | Mode belongs to the project and must survive clone/worktrees without silently enabling board writes |
| 3 | Gate the write-capable database primitive mechanically | Covers every write path and cannot be bypassed by a skill choosing the wrong prose branch |
| 4 | Remove Genie MCP in both modes | Explicitly retired surface; keeping it would preserve another authority/write route and delivery burden |
| 5 | Orca mode ships as a native Orca plugin | Gives installation, consent, update and rollback one Orca-owned boundary |
| 6 | No shell or Orca CLI fallback | Explicit Felipe lock; typed plugin APIs are the trust boundary |
| 7 | Split delivery into two linked WISHes | Explicit Felipe lock; Orca API and Genie plugin have separate repositories and release evidence |
| 8 | Orca WISH/release blocks Genie plugin SHIP | Prevents pretending the current experimental host API can provide orchestration methods it does not expose |
| 9 | Linear is optional and non-authoritative | Genie and Orca execution must work without tracker credentials or per-group issue noise |
| 10 | Genie-owned marketplace first; no panel | Reversible, lower-risk defaults; neither is required to prove the core product workflow |
| 11 | No unrelated standalone deletions | Cleanup remains bounded to obsolete integration/delivery machinery and MCP, not a hidden product rewrite |
| 12 | Version number follows compatibility evidence | Avoids making “v6” architecture; release semantics come from the actual breaking surface |

## Risks & Assumptions

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| 1 | Upstream Orca refuses or changes the required plugin API | High | Separate blocking WISH with explicit released capability contract; Genie plugin does not ship a fallback |
| 2 | Mode bug opens or mutates standalone state from Orca | High | Gate before SQLite open; clone/worktree/malformed-mode fixtures; hash and row-count invariants on dormant databases |
| 3 | Cleanup removes assets standalone still needs | High | Freeze parity before deletion; rehome first; delete in later groups; full repository/release gate |
| 4 | Plugin worker bypasses consent through Node process authority | High | No shell/CLI/network product path; static and runtime negative tests; explicit manifest capabilities; independent security review |
| 5 | Mode switch destroys or silently migrates existing state | High | Never delete or migrate board data during mode selection; backup-first config writes; exact read-back and rollback fixtures |
| 6 | Plugin and repository skills drift | Medium | One canonical plugin payload with deterministic parity/generation checks and release digest pinning |
| 7 | Experimental Orca API changes after release | Medium | Pin minimum Orca/plugin API versions and exact capabilities; compatibility tests and rollback package |
| 8 | Append-only provenance becomes a second scheduler | Medium | Contract forbids reading provenance to decide dispatch; tests keep Dispatch plan as the only upstream execution input |
| 9 | Public marketplace or panel expands scope early | Low | Both are OUT until measured triggers after the core plugin journey ships |
| 10 | Existing dirty repository state contaminates planning or delivery | Medium | Exact-path staging/commits only; preserve unrelated changes; independent review pins the reviewed artifacts |

## Success Criteria

- [ ] A fresh standalone install exposes the existing `genie task` and `genie board` behavior, installs no Genie MCP surface and requires neither Orca nor Linear.
- [ ] Standalone parity goldens and the repository’s required full gate pass after obsolete delivery cleanup.
- [ ] A fresh Orca install registers exactly one reviewed Genie plugin and creates neither `.genie/genie.db` nor `.genie/roadmap.json` through install, brainstorm, wish, work or review journeys.
- [ ] In Orca mode every board/task human command refuses with the typed mode reason; hook-driven sync exits zero without output; no write-capable database open occurs.
- [ ] Converting an existing standalone fixture to Orca and exercising the plugin leaves the database bytes, task row count and roadmap bytes unchanged; switching back restores standalone operation.
- [ ] Invalid or unreadable mode values fail closed without echoing untrusted bytes and never fall through to standalone.
- [ ] The upstream Orca WISH has a persisted SHIP review and released version/capability identifiers; the Genie plugin manifest pins and consent-tests them.
- [ ] The plugin creates, reads and observes Run/Task/Dispatch/gate lifecycle only through typed host APIs; negative tests prove no Orca CLI, shell, undeclared network or second lifecycle store is used.
- [ ] An approved fixture WISH with `Tracker: none` creates one Orca Run and the planned internal Tasks, survives worker completion/read-back and records bounded provenance without writing board state.
- [ ] Orca-mode WISH validation rejects missing/invalid base SHA, mismatched identifiers, unsafe worktree names, invalid enums and forbidden validation-command content.
- [ ] Linear credentials are absent in the end-to-end fixture and do not block install or execution.
- [ ] Reinstall, update, mode switch, rollback and uninstall are idempotent and preserve WISHes plus dormant standalone data.
- [ ] Removing the Orca plugin removes its contributed commands/skills/worker and leaves standalone Genie data untouched.
- [ ] Release artifacts contain the intended mode-specific payloads, matching versions/digests, and pass supported tarball/plugin verification before promotion.
- [ ] No native panel or public marketplace submission is included in the first release.

## Program Decomposition

### WISH 1 — `orca-plugin-orchestration-api` (repo `stablyai/orca`)

Owns the minimal typed plugin host capabilities, consent labels, events, workspace identity, worker result delivery, compatibility tests and Orca release. It blocks the Genie WISH. It does not contain Genie-specific workflow policy.

### WISH 2 — `genie-dual-mode-orca-plugin` (this repo)

Depends on the released Orca WISH. Owns standalone containment, mode resolution, board isolation, MCP retirement, legacy delivery cleanup, WISH validation, native plugin payload, Genie-owned marketplace package and end-to-end Genie journey.

## Next Step

Run an independent review of this Genie design. After a digest-bound SHIP verdict, create the separate Orca prerequisite design/WISH in a durable Orca checkout, then create this Genie WISH with `depends-on: stablyai/orca/orca-plugin-orchestration-api` and keep it blocked until the upstream release contract is pinned.

<!-- genie-design-review:start -->
## Design Review Evidence

- **Verdict:** PENDING
- **Reviewed content SHA-256:** PENDING
- **Reviewer:** PENDING
- **Reviewed at:** PENDING
<!-- genie-design-review:end -->
