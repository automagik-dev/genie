# Wish: Genie board for DSH Web

| Field | Value |
|-------|-------|
| **Status** | FIX-FIRST |
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
| 4 | Use board JSON as the canonical lane snapshot and unconditionally enrich rendered cards with `genie task status <id> --json`. | Assignment, heartbeat/liveness, enforced blocks, dependencies, timeline, and comments are all machine-readable; human output is never a compatibility contract. |
| 5 | Add and freeze the exact status JSON contract in Group 1, then enforce its first released Genie version in the plugin manifest and at runtime. | Compatibility fails closed before a board command when the installed Genie is too old; documentation is not the enforcement boundary. |
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
1. Additive, unconditional `genie task status <id> --json` support with success, unknown-id, stderr/exit-code, exact-key, nullability, and idempotent-read tests. Human `task status` output remains unchanged.
2. Freeze this versioned response and reject additional/missing keys in fixtures:

   ```ts
   {
     schemaVersion: 1,
     task: {
       id: string, boardId: string | null, title: string,
       status: 'blocked' | 'ready' | 'in_progress' | 'done',
       claimedBy: string | null, claimedAt: number | null,
       wish: string | null, group: string | null,
       assignedAgent: string | null, assignedReason: string | null,
       createdAt: number, updatedAt: number, lane: string | null,
       agentKind: string | null, heartbeatAt: number | null,
       liveness: 'running' | 'idle' | 'stale' | null,
       blockedBy: string | null, blockedReason: string | null,
       enforcedBlock: { reason: string, kind: 'work' | 'hold' } | null
     },
     dependencies: Array<{ id: string, title: string, status: 'blocked' | 'ready' | 'in_progress' | 'done' }>,
     timeline: Array<{
       id: number, kind: string, note: string | null,
       authorKind: string | null, author: string | null, createdAt: number
     }>,
     comments: Array<{
       id: number, note: string, authorKind: string | null,
       author: string | null, createdAt: number
     }>
   }
   ```

   `liveness` is null when `claimedBy` is null and otherwise is derived from `heartbeatAt`; `comments` is the ordered `kind === 'comment'` projection of `timeline` with non-null comment text.
3. Retain exact fixtures for `genie board list --json` (`id`, `name`, `laneCount`, `cardCount`) and lane-board JSON (`scope`; ordered lanes with `name`, `label`, `action`, and exact card keys). Record the first Genie release containing status schema version 1 as the compatibility floor consumed by Group 2.

**Acceptance Criteria:**
- [ ] `genie task status <id> --json` is always implemented and returns the exact schema above, including heartbeat/liveness, assignment, enforced block/provenance, dependencies, timeline, and structured comments.
- [ ] No human CLI output is parsed; every consumed board/status JSON key has an exact fixture/schema assertion.

**Validation:**
```bash
bun test src/term-commands/v5-board.test.ts src/term-commands/v5-task.test.ts && bun run check
```

Full gate is required because this changes a shared CLI contract.

**depends-on:** none
**blocks:** Group 2

---

### Group 2: DSH Host adapter and kanban

**Goal:** Deliver the secure, Host-confirmed DSH Web board experience.

**Deliverables:**
1. Create `plugins/dsh-genie-board/package.json`, `agent.cordis.yml`, `cordis.patch.yml`, TypeScript/build configuration, source/tests, and the package-local `build` script; add root `build:plugin` as `bun --cwd plugins/dsh-genie-board run build`.
2. Put the exact first compatible Genie release from Group 1 in the plugin manifest/package metadata and enforce the same floor at Host startup by running the fixed executable as `genie --no-interactive --version`; an older/unparseable version serves no board route.
3. Resolve a workspace id only through DSH `workspaceRegistry`; canonicalize the registry result with `realpath`, require a physical repository containing `.genie`, and use that canonical path as `cwd`. Never accept a browser path. Resolve the Genie executable once from the Host-owned installation, canonicalize it to an absolute executable regular file, and never search for or override it per request.
4. Spawn with `shell: false` and an exact Host-owned environment allowlist: `PATH`, `HOME`, `GENIE_HOME`, `NO_COLOR=1`, `GENIE_AGENT_NAME=<host-derived-identity>`, and `GENIE_AGENT_KIND=dsh`; drop every other variable and accept no environment value from the browser.
5. Implement this normative action table; every argv vector includes `--no-interactive` and no action may synthesize another vector:

   | Action | Fixed executable argv |
   |--------|-----------------------|
   | List boards | `genie --no-interactive board list --json` |
   | Read board | `genie --no-interactive board --board <validated-ref> --json` |
   | Read card detail | `genie --no-interactive task status <id> --json` |
   | Create | `genie --no-interactive task create --title <title> --board <ref>` |
   | Move | `genie --no-interactive task move <id> --to <lane>` |
   | Comment | `genie --no-interactive task comment <id> <text>` |
   | Block | `genie --no-interactive task block <id> --reason <text> [--hold]` |
   | Unblock | `genie --no-interactive task unblock <id>` |
   | Checkout | `genie --no-interactive task checkout <id> --worker <host-derived-identity>` |
   | Release | `genie --no-interactive task release <id>` |
   | Done | `genie --no-interactive task done <id>` |

6. Validate `workspaceId` by exact registry membership; accept `boardRef` only when it equals an id returned by validated board-list JSON; require task ids matching `^t_[a-z0-9]+$`; require lane to equal a lane name from the selected validated board; trim and bound title to 1–200 UTF-8 bytes, comment text to 1–4000, and block reason to 1–1000; reject NUL/control characters, unknown object keys, non-boolean `hold`, and all browser-supplied worker/path/executable/environment/command/argv fields.
7. Bound each request to at most 20 Genie processes total, concurrency 4, a 10-second aggregate deadline, and 4 MiB aggregate stdout plus stderr. Kill remaining children on the first timeout/limit/error; validate exit code and closed JSON schemas before use; return an explicit partial-detail warning when the process cap leaves cards unenriched. Test every bound deterministically, including hostile identifiers and command-injection attempts.
8. Implement browser selectors, lanes/cards/details/errors, mutations, refresh, and visibility recovery; each mutation response re-reads the board and status JSON and never applies optimistic state.
9. Add `scripts/dsh-genie-board-smoke.ts`: create isolated fixture repo/profile state, run `dsh plugin --profile web add link:<absolute-plugin-dir>`, launch `dsh web --no-open --host 127.0.0.1 --port 0`, stop/relaunch it after install, prove `dsh plugin --profile web list --depth 0` reports `@automagik/genie-dsh-board`, read back the plugin health/compatibility route, perform board list/load plus reversible create/move through the Host route, and in `finally` stop the server, run `dsh plugin --profile web remove @automagik/genie-dsh-board`, and delete only the temporary profile/repository.

**Acceptance Criteria:**
- [ ] Rendering matches fixture-backed Host snapshots; mutations use fixed argv and refresh.
- [ ] Every unsafe/failure case is bounded and cannot invoke an out-of-scope command.
- [ ] The manifest and runtime reject every Genie version below the first release containing status schema version 1.
- [ ] Package build and the linked-profile install/restart/read-back/board-operation/cleanup smoke pass against DSH `0.1.1-rc.2` or a newer explicitly proven floor.
- [ ] No database access, persistence, watcher, poller, shell, or browser-supplied executable/path/argv exists.

**Validation:**
```bash
bun run check && bun run build:plugin && bun test plugins/dsh-genie-board && bun scripts/dsh-genie-board-smoke.ts
```

Full gate plus plugin build covers runtime and trust-boundary risk.

**depends-on:** Group 1
**blocks:** Group 3

---

### Group 3: Install, release, and discoverability

**Goal:** Prove the packaged plugin can be installed locally before advertising it.

**Deliverables:**
1. Install/compatibility docs and provenance/NOTICE with the manifest-enforced Genie floor from Group 2.
2. Include `plugins/dsh-genie-board/` in `scripts/build-binary.sh`; extend `scripts/release-payload-version.ts` so package/manifest versions are stamped and verified in staged and extracted payloads; update `scripts/release-payload-version.test.ts`, `scripts/release-docs.test.ts`, `scripts/version-format.test.ts`, `scripts/version-ci-staging.test.ts`, and payload inventory/parity tests. Do not replace or modify the existing `scripts/verify-release.sh` interface.
3. From a clean checkout, build and inspect `linux-x64-glibc`, `linux-x64-musl`, `linux-arm64`, and `darwin-arm64`; each tarball must contain the built plugin, manifest/patch, docs/NOTICE, and matching root/plugin versions.
4. After the candidate has a signed tag and all four tarballs plus `.bundle` and `.intoto.jsonl` sidecars, run the existing verifier against that concrete tag. Only after all checks pass, add the GitHub topic and verify it by read-back.

**Acceptance Criteria:**
- [ ] Artifact contains the plugin/manifests/docs with matching versions.
- [ ] All four supported artifacts contain the plugin and pass inventory/version inspection; the linked smoke from Group 2 changes no user repository.
- [ ] Topic publication occurs last and is verified by read-back.

**Validation:**
```bash
bun install --frozen-lockfile
bun run check
bun run build:plugin
VERSION="$(jq -r .version package.json)"
for PLATFORM in linux-x64-glibc linux-x64-musl linux-arm64 darwin-arm64; do
  bun run build:binary -- --platform "$PLATFORM" --version "$VERSION"
  tar -tzf "dist/genie-$VERSION-$PLATFORM.tar.gz" | grep -E '^\./plugins/dsh-genie-board/(package.json|agent.cordis.yml|cordis.patch.yml|dist/)'
done
bun run verify:release -- "v$VERSION"
```

The final command is intentionally post-publication: `v$VERSION` must be the concrete signed candidate tag. The live verifier downloads every platform artifact and requires each adjacent `.bundle` and `.intoto.jsonl`; a merely local unsigned build does not satisfy this gate.

**depends-on:** Group 2
**blocks:** release/topic publication

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

### Plan review round 2 — FIX-FIRST (2026-09-03T14:28:27Z)

- **Reviewed commit:** `a886373a1cca05578ffd3c5ff503e89801f4ada9`
- **Reviewer:** `agent:steve:dashboard:8dc1921d-9f6b-41d0-9095-8ac7ee731afb`
- **Mode:** independent, read-only, detached snapshot
- **Validation:** `wishes:lint`, design-evidence verification, diff check, shell syntax, CLI/source contract checks all passed; snapshot remained clean.
- **Verdict:** **FIX-FIRST** — 0 CRITICAL, 3 HIGH.

Remaining HIGH gaps after the second review round:

1. **Detail hydration is contradictory.** The plan promises unconditional complete detail while also allowing partial/on-demand enrichment under a 20-process cap. Choose either one aggregate complete JSON read or a fully specified partial/on-demand contract, including deterministic ordering and mutation-budget accounting.
2. **Compatibility-floor sequencing is circular.** Group 2 depends on a “first released version” that Group 3 has not released. Define a candidate/version-stamping contract produced by the same release, then prove that exact version in Group 3, or add and reconcile an explicit earlier release gate.
3. **Published-release proof is incomplete.** The tar membership check can pass with only one required member; the verifier does not itself require the four named artifacts or inspect plugin contents, and no executable step creates or identifies the signed candidate and sidecars. Specify the authorized candidate workflow and independently assert every required member in each exact artifact before publication.

Fix-loop budget is exhausted (`2/2`). Cause: `ambiguous-spec` for the hydration contract and `missing-context` for the release-candidate workflow. Owner: Sofia/Felipe. Next gate: resolve those product/release decisions, amend the plan, and obtain a fresh independent plan review. Implementation, release work, and external publication remain blocked.

---

## Files to Create/Modify

```
plugins/dsh-genie-board/**
src/term-commands/v5-task.ts
src/term-commands/v5-task.test.ts
scripts/dsh-genie-board-smoke.ts
scripts/build-binary.sh
scripts/release-payload-version.ts
scripts/release-payload-version.test.ts
scripts/release-docs.test.ts
scripts/version-format.test.ts
scripts/version-ci-staging.test.ts
scripts/orca-manifest-parity.test.ts
package.json
README.md
.genie/brainstorms/dsh-genie-board/**
.genie/wishes/dsh-genie-board/WISH.md
.genie/INDEX.md
```
