# Draft: Genie board for DSH Web

| Field | Value |
|-------|-------|
| **Slug** | `dsh-genie-board` |
| **Date** | 2026-09-03 |
| **WRS** | 100/100 |

## Problem

DSH users cannot inspect or operate the authoritative Genie board from DSH Web. The integration must render Genie's real lifecycle lanes without turning `genie.db` into a cross-repository API or reviving the retired `genie mcp` / `genie ui-bridge` surfaces.

## Scope

### IN

- A dual-face DSH Web plugin using the `dsh-task-board` package only as UI and plugin-loading schematics.
- Host-side execution of the supported `genie board --json` and `genie task ...` CLI contracts in an explicitly selected DSH workspace.
- A kanban UI that renders Genie's board-defined lanes and refreshes after confirmed Host mutations.
- Focused task actions supported by the current CLI: create, move, comment, block/unblock, checkout/release, and done.
- Fail-closed repository, executable, output-size, timeout, and argument validation.
- Install, build, test, and topic-based discovery documentation.

### OUT

- Direct reads or writes to `.genie/genie.db`.
- Reintroducing `genie mcp`, `genie ui-bridge`, a daemon, or a new Genie protocol.
- Copying the reference plugin's independent ledger, cron scheduler, execution runner, continuation cards, or sleep inhibitor.
- Automatic execution of cards by DSH agents in the first release.
- Homolog or production promotion before separate human approval.

## Candidate Approaches

1. **Co-located package in `automagik-dev/genie` (chosen).** Keep the DSH adapter next to the CLI contract it consumes, install from the public GitHub repository, and add the `dsh-plugin` topic to that repository. This avoids a second release authority and version-skew policy.
2. **Package in private `namastexlabs/dsh-plugins`.** Reuses its DSH monorepo tooling, but public discoverability would require publishing an existing private repository whose other contents were not placed in scope.
3. **New standalone public repository.** Gives the cleanest marketplace identity, but immediately creates cross-repository release/version-skew work and conflicts with the current registered-project list.

## Simplest Complete Design

The DSH Host resolves one workspace root, runs a fixed allowlist of `genie` argv arrays with `shell: false`, parses bounded JSON for reads, and returns confirmed snapshots/actions over same-origin Host routes. The browser mounts a Genie-branded board and re-fetches after each mutation. No plugin-owned task database and no background synchronization state are introduced.

## Decisions

- Settled: Genie CLI is the only task-state boundary; SQLite is private.
- Settled: DSH task-board code is a schematic/reference, not a state model to fork wholesale.
- Settled: v1 is human-operated board management, not scheduled autonomous execution.
- Settled: the package lives at `plugins/dsh-genie-board/` in `automagik-dev/genie`; the repository receives the `dsh-plugin` topic after the plugin is verified.

## Risks

- CLI JSON/exit contracts may be incomplete for some UI actions; freeze only current documented commands and surface unsupported actions rather than inventing writes.
- DSH Host is long-lived while Genie is zero-daemon; every child process needs timeout, output caps, abort cleanup, and no shell.
- A broad copy of `dsh-task-board` would import an unrelated ledger and security model; copy only mount/build/UI patterns.
- The installed DSH is `0.1.1-rc.2`, while the reference task-board targets newer alpha packages; compatibility must be proven against the local profile.

## Success Criteria

- A DSH Web user selects a Genie repository and sees the same boards, lanes, cards, status, assignment, liveness, block, and comment information represented by the CLI JSON output.
- Create and move actions round-trip through `genie task` and the UI shows only Host-confirmed state.
- Invalid workspace paths, missing Genie, timeouts, malformed/oversized output, and non-zero CLI exits produce bounded visible errors and no state mutation outside the selected repository.
- Package typecheck, unit tests, build, a local linked-plugin smoke, and the Genie repository's required validation gates pass.
- The public installation path is documented and its public GitHub repository has the `dsh-plugin` topic.

## Next Step

Crystallize the design, obtain an independent cross-family review, and only then scaffold the executable wish.
