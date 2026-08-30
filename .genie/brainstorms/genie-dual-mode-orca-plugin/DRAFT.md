# Genie cleanup release — standalone contido + plugin Orca

**Status:** Simmering
**Date:** 2026-08-28
**Owner:** Felipe Rosa
**WRS:** 100/100 — Problem ✅ · Scope ✅ · Decisions ✅ · Risks ✅ · Criteria ✅

## Correction / supersession

This direction supersedes the 2026-08-22 `genie v6 corpo leve` council recommendation to delete the standalone Genie state plane. Genie remains an independent product and does not require Linear.

This is **not a “Genie v6” product initiative**. Versioning follows the ordinary release contract after scope and compatibility are measured. “End the board bullshit” means strict containment: the board remains a standalone implementation detail, while Orca mode has zero board/database/roadmap dependency or synchronization path.

Locked product decision (explicitly approved by Felipe in this brainstorm):

1. Installation offers `standalone` and `orca` modes.
2. `standalone` preserves the current Genie board/task runtime and independent lifecycle; the Genie MCP surface is retired.
3. `orca` installs a Genie edition dedicated to the Orca workflow; it does not use or mirror the standalone Genie board.
4. Linear is optional integration, never a Genie authority or installation prerequisite.
5. Orca mode ships as a native Orca plugin rather than loose, separately installed skills.
6. Existing standalone installations keep executing the board. Orca installations never initialize, read, write, import, export, mirror or reconcile that state.
7. The plugin never shells out to `orca orchestration`. It depends on explicit, consented Orca host APIs for Run/Task/Dispatch/gate reads, mutations and lifecycle events. This boundary was explicitly approved by Felipe in this brainstorm.
8. Delivery is one program with two linked WISHes: an Orca WISH owns and releases the plugin orchestration contract; the Genie WISH depends on that released version and owns cleanup, mode isolation and the native plugin.
9. Reversible defaults: publish through a Genie-owned marketplace first; omit a panel from the first plugin release. Public marketplace submission and a native panel require measured adoption after the core plugin ships.

## Problem

Genie must support its independent standalone lifecycle while offering an Orca-native workflow without duplicating task state, drifting skill installs, or forcing Linear into Genie's product boundary.

## Live recovered evidence

- Genie checkout: `/home/genie/workspace/repos/genie`, branch `v6/corpo-leve`.
- Prototype commits: `49afc7a58` and `a0fa6fb55`.
- Prototype files: `skills/genie-orca/{wish,work,review}`, migration and retro scripts.
- Orca host `felipe-mac` has no registered Genie repo/worktree. Orca host `server` has two Genie checkouts; the clean `/home/namastex/workspace/repos/genie` checkout contains the advanced source at `origin/v6/corpo-leve@19a016b85f8a2c86afcc0fd280c526b2c57395d7`.
- That source was recovered byte-for-byte into `.genie/brainstorms/genie-v6-corpo-leve/`: 19 files, including a 40,563-byte rev. 3.3 `DESIGN.md`, two council rounds and four reviews. Verification: 19/19 SHA-256 matches, `git diff --check` green.
- Rev. 3.3 has an independently verified `SHIP` stamp. Reviewable-design digest: `d91de43a1d03ba55f87652182b2a008ea42246eeae7c8e05aec9b35d2c4d2889`. No `genie-v6-corpo-leve/WISH.md` was materialized on that host.
- The old Brain council and retro were also recovered from Git history (`9b4fa87`, `2977538`). The recovered rev. 3.3 design is the mature technical predecessor; its product framing and packaging decisions are selectively superseded below rather than discarded wholesale.
- Orca plugin system is experimental and consent-gated. Marketplace plugins can contribute skills, commands, panels, events, language packs, keybindings, VM recipes, agent profiles and an out-of-process Node worker.
- Orca plugin host API v1 currently exposes only focused-worktree context, terminal text, notifications, plugin storage/secrets/settings and three host events (`worktree.created`, `worktree.removed`, `agent.status.changed`). It does not expose orchestration Runs, Tasks, Dispatches, gates, task events, Linear context or panel↔worker RPC.

## Recovered rev. 3.3 contract carried forward

The new plugin direction inherits these reviewed decisions, with `classic` renamed to `standalone`:

1. **Project-owned mode marker:** committed `.genie/mode`, exactly `standalone` or `orca`; resolution is `GENIE_MODE` > repository marker anchored at `git-common-dir` > global config > `standalone`. Invalid, malformed or unreadable values resolve to `unresolved` and fail closed rather than falling through.
2. **Mechanical board boundary:** the write-capable database primitive refuses to open in Orca mode. Human board/task verbs remain registered and return an explanatory refusal; hook-driven sync becomes a silent no-op. This—not skill prose—is the authority preventing board writes.
3. **Reversible switching without deletion:** a fresh Orca-mode repo creates no `genie.db` or `roadmap.json`. Switching an existing standalone repo to Orca retains its state dormant and byte-unchanged; switching back re-enables it. Mode selection never deletes standalone data.
4. **Wave base without task state:** `genie context --wish --plan` computes the integration branch and exact base SHA read-only; Orca-mode WISH validation requires the pinned branch + 40-hex SHA in the document.
5. **No dual-write:** Orca owns active Run/Task/Dispatch state. Genie records only Git-native intent, review gates and append-only execution provenance. Provenance is evidence and must never be read back to decide dispatch; the Dispatch plan is upstream input, not a mirror.
6. **Mechanical Orca WISH validation:** closed enums for agent/model/effort/tracker, safe worktree naming, bounded validation commands, matching Run/Task identifiers and explicit base pins. Tracker remains `linear:<ids> | #<issue> | none`; Linear is optional.
7. **Mode-specific skill boundary:** Orca wish/work/review remain autonomous payloads with tests proving they never call Genie board/task APIs. The plugin replaces the predecessor's skills.sh packaging, not the reviewed workflow contracts.
8. **Parity-first delivery:** freeze standalone goldens before mode work; add a negative Orca lifecycle fixture; land mode/gates before subtractive packaging work; prove update, rollback and uninstall independently.

Explicitly superseded from rev. 3.3:

- Orca as the sole “happy path” and standalone as frozen legacy. Both are supported product modes; standalone remains independent.
- Deleting every plugin and using skills.sh as the Orca installation boundary. Orca mode is now evaluated as a Genie-owned Orca plugin.
- Any assumption that Linear owns Genie status or requires one issue per execution group.
- Broad deletion of Omni, UI or unrelated standalone surfaces merely because the predecessor proposed it. MCP retirement remains the only independently locked subtraction here.

## Simplest complete approach

### Standalone mode

- Install the existing Genie CLI, hooks and skills required by the current standalone lifecycle.
- Preserve `.genie/genie.db`, `genie task`, and `genie board` semantics.
- Remove/stop installing the Genie MCP server and MCP-specific integration surfaces.
- No Orca or Linear dependency.

### Orca mode — native plugin

Ship one Genie-owned Orca plugin with:

- `orca-plugin.json`, pinned minimum Orca version and explicit capabilities;
- Genie `brainstorm`, `wish`, `work`, and `review` skills adapted to Orca;
- commands such as **Genie: Brainstorm**, **Genie: Create Wish**, **Genie: Execute Wish**, and **Genie: Review**;
- an out-of-process plugin worker that validates WISH documents and calls only typed Orca host APIs for Run/Task/Dispatch/gate operations;
- no Genie task database, no board mirroring, no Linear requirement;
- optional notifications and plugin-owned settings/secrets only;
- no hidden process execution or CLI fallback;
- no custom lifecycle panel until the same native API can provide authoritative orchestration state and worker results.

The plugin is the installation, consent, update and rollback boundary. Orca remains the sole execution-state owner in Orca mode; WISH.md remains Genie's durable technical contract.

### Upstream Orca prerequisite

Add and release upstream Orca plugin capabilities before the Genie plugin can SHIP:

- `orchestration:read` and `orchestration:write` host methods;
- Run/Task/Dispatch/gate event subscriptions;
- panel↔plugin-worker RPC or panel command invocation;
- safe current-workspace/repository identity beyond branch/display name;
- optionally a first-class orchestration panel mount.

Until those exist, do not bypass the plugin host API to build a fake native dashboard. The Genie plugin remains blocked; there is no CLI-driven compatibility release.

## Scope

### IN

- Installer mode selection and idempotent reinstall/update.
- Standalone preservation with MCP retirement.
- Orca plugin manifest, marketplace/install flow, skills, commands and worker.
- Mode-specific payload composition and negative cross-mode tests.
- One exact WISH SHA → at most one active Orca Run in Orca mode.
- Upgrade, rollback, uninstall and mode-switch data-preservation contract.
- Private/Genie-owned marketplace publication initially; public marketplace later after API stabilizes.

### OUT

- Deleting standalone Genie or its board.
- Making Linear mandatory or authoritative for Genie.
- Mirroring Orca Tasks into Genie cards.
- Recreating the Genie board inside an Orca panel.
- Forking Orca merely to bypass missing plugin APIs.
- Maintaining Genie MCP compatibility.

## Decisions still open

None for the Genie design. The separate Orca WISH must define the exact capability schema, consent labels and compatibility/versioning contract it owns.

## Risks

- Experimental Orca plugin APIs may change; pin `engines.orca`, plugin API and tested host versions, with rollback.
- A plugin worker has Node process authority beyond the capability facade; the design forbids shell/CLI fallback and tests the host capability boundary negatively.
- Shipping a panel before orchestration APIs exist would create another projection/state bridge and repeat board drift.
- Mode selection can accidentally delete or mutate standalone state; switching must be backup-first and reversible.
- The current prototype assumes Linear parent + child per group; that contract must be removed from Orca mode because Linear is optional.
- The old `genie-orca` README points to deleted Brain decision records and must be replaced by repository-local reviewed design evidence.

## Initial acceptance criteria

- Fresh standalone install exposes working `genie task`/`genie board`, installs no Genie MCP server, and needs neither Orca nor Linear.
- Fresh Orca install registers one reviewed Genie plugin, installs no standalone task/board runtime authority, and needs no Linear credential.
- Executing an approved fixture WISH through Orca mode creates one Orca Run and its internal Tasks, with zero writes to `.genie/genie.db` or `.genie/roadmap.json`.
- Reinstall/update/rollback are idempotent and preserve user-owned WISHes and dormant standalone state.
- Removing the plugin removes its commands/skills/worker without changing standalone Genie data.
- Negative tests prove standalone code never imports Orca and Orca mode never calls Genie task/board APIs.
- Plugin v1 declares and consent-tests every capability it uses; negative tests prove it cannot execute the Orca CLI or undeclared network/process behavior.

## Next step

Crystallize the Genie design, run independent design review, then create the linked Orca prerequisite design/WISH before materializing the blocked Genie WISH.
