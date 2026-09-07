# Wish: Genie board for DSH Web

| Field | Value |
|-------|-------|
| **Status** | IN_PROGRESS |
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
| 4 | Make `genie board --board <ref> --json` the one complete aggregate read for lanes, cards, assignment, liveness, blocks, dependencies, timeline, and comments. | Every board response is complete and deterministic; there is no per-card, partial, or on-demand hydration path. |
| 5 | Derive one immutable candidate version before release build/sign/publish, then stamp the staged plugin version and minimum Genie version from that same candidate. | Group 2 implements and tests the comparator without depending on an already-published release; every shipped artifact binds compatibility to its own candidate. |
| 6 | Refresh the selected board with the complete aggregate after every mutation. | The browser never displays optimistic or partially hydrated state. |
| 7 | Use the authorized stable Release workflow and its protected human approval, then fail closed unless exactly four platform tarballs individually pass digest, signature, provenance, version, and plugin-member verification. | Publication and the GitHub topic cannot outrun release identity or artifact proof. |

## Simplicity Case

- **Simplest complete design:** one dual-face plugin, one strict Host adapter, and the existing Genie CLI as sole authority.
- **Added machinery:** route fencing, action validation, process/output caps, and one complete aggregate schema are required by browser-triggered mutations and requested card detail.
- **Deferred until measured:** polling, SSE, caches, deltas, batching, autonomous execution, cron, and resumable requests require explicit demand or measured refresh latency.
- **Complexity removed:** no durable state, daemon, socket, synchronization protocol, human-output parser, duplicate ledger, or configurable command surface.

## Dependencies

**depends-on:** none
**blocks:** none

## Success Criteria

- [ ] DSH Web selects an eligible workspace/board and renders lanes/cards from one complete aggregate CLI read, including structured assignment, block, liveness, dependency, timeline, and comment data.
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

### Group 1: Complete aggregate CLI contract

**Goal:** Freeze one complete, deterministic board JSON read without parsing human output or hydrating cards separately.

**Deliverables:**
1. Extend `genie board --board <ref> --json` additively so one invocation returns `schemaVersion: 1`, board scope, ordered lanes, and every card's complete detail. Keep human board/task output unchanged and retain the exact `genie board list --json` contract (`id`, `name`, `laneCount`, `cardCount`).
2. Freeze this exact per-card aggregate shape and reject additional/missing keys and invalid nullability in fixtures:

   ```ts
   {
     id: string, boardId: string | null, title: string,
     status: 'blocked' | 'ready' | 'in_progress' | 'done',
     claimedBy: string | null, claimedAt: number | null,
     wish: string | null, group: string | null,
     assignedAgent: string | null, assignedReason: string | null,
     createdAt: number, updatedAt: number, lane: string | null,
     agentKind: string | null, heartbeatAt: number | null,
     liveness: 'running' | 'idle' | 'stale' | null,
     blockedBy: string | null, blockedReason: string | null,
     enforcedBlock: { reason: string, kind: 'work' | 'hold' } | null,
     dependencies: Array<{
       id: string, title: string,
       status: 'blocked' | 'ready' | 'in_progress' | 'done'
     }>,
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

   Lanes keep their existing order; cards keep the board's existing order; dependencies sort by task id; timeline sorts by `createdAt` then `id`; comments are the ordered `kind === 'comment'` projection of that timeline with non-null text. `liveness` is null when `claimedBy` is null and otherwise derives from `heartbeatAt`.
3. Fetch and join the aggregate in one repository read transaction/query path so every card belongs to the same snapshot. Missing or malformed detail fails the entire command non-zero; the JSON contract has no `partial`, `truncated`, cursor, hydration, or on-demand state. Add success, unknown-board, empty-board, multi-card ordering, stderr/exit-code, exact-key, nullability, and idempotent-read tests.

**Acceptance Criteria:**
- [ ] One `genie board --board <ref> --json` invocation returns every rendered card and all required assignment, block, liveness, dependency, timeline, and comment data from one complete snapshot.
- [ ] No human CLI output or per-card `task status` call is consumed; every aggregate key, ordering rule, and fail-closed case has an exact fixture/schema assertion.

**Validation:**
```bash
bun test src/term-commands/v5-board.test.ts && bun run check
```

Full gate is required because this changes a shared aggregate CLI contract.

**depends-on:** none
**blocks:** Group 2

---

### Group 2: DSH Host adapter and kanban

**Goal:** Deliver the secure, Host-confirmed DSH Web board experience.

**Deliverables:**
1. Create `plugins/dsh-genie-board/package.json`, `agent.cordis.yml`, `cordis.patch.yml`, `README.md`, `NOTICE`, TypeScript/build configuration, source/tests, and the package-local `build` script. Freeze `dist/index.js` as the Host bundle and `dist/client.js` as the browser bundle; add root `build:plugin` as `bun --cwd plugins/dsh-genie-board run build`.
2. Implement a `minimumGenieVersion` plugin field and strict semver comparator without hard-coding a not-yet-published release. Source and linked-profile tests use the checkout root version; Group 3 stamps both the shipped plugin version and `minimumGenieVersion` from its already-derived immutable candidate. At Host startup run the fixed executable as `genie --no-interactive --version`; an older/unparseable version serves no board route.
3. Resolve a workspace id only through DSH `workspaceRegistry`; canonicalize the registry result with `realpath`, require a physical repository containing `.genie`, and use that canonical path as `cwd`. Never accept a browser path. Resolve the Genie executable once from the Host-owned installation, canonicalize it to an absolute executable regular file, and never search for or override it per request.
4. Spawn with `shell: false` and an exact Host-owned environment allowlist: `PATH`, `HOME`, `GENIE_HOME`, `NO_COLOR=1`, `GENIE_AGENT_NAME=<host-derived-identity>`, and `GENIE_AGENT_KIND=dsh`; drop every other variable and accept no environment value from the browser.
5. Implement this normative action table; every argv vector includes `--no-interactive` and no action may synthesize another vector:

   | Action | Fixed executable argv |
   |--------|-----------------------|
   | List boards | `genie --no-interactive board list --json` |
   | Read board | `genie --no-interactive board --board <validated-ref> --json` |
   | Create | `genie --no-interactive task create --title <title> --board <ref>` |
   | Move | `genie --no-interactive task move <id> --to <lane>` |
   | Comment | `genie --no-interactive task comment <id> <text>` |
   | Block | `genie --no-interactive task block <id> --reason <text> [--hold]` |
   | Unblock | `genie --no-interactive task unblock <id>` |
   | Checkout | `genie --no-interactive task checkout <id> --worker <host-derived-identity>` |
   | Release | `genie --no-interactive task release <id>` |
   | Done | `genie --no-interactive task done <id>` |

6. Validate `workspaceId` by exact registry membership; accept `boardRef` only when it equals an id returned by validated board-list JSON; require task ids matching `^t_[a-z0-9]+$`; require lane to equal a lane name from the selected validated board; trim and bound title to 1–200 UTF-8 bytes, comment text to 1–4000, and block reason to 1–1000; reject NUL/control characters, unknown object keys, non-boolean `hold`, and all browser-supplied worker/path/executable/environment/command/argv fields.
7. Use exactly one Genie process for board list/load and at most two sequential processes for a mutation plus its complete aggregate refresh, with a 10-second aggregate deadline and 4 MiB aggregate stdout plus stderr. Kill the active child on timeout/limit/error; validate exit code and the closed aggregate schema before use; any missing/oversized/malformed detail fails the whole response. Test every bound deterministically, including hostile identifiers and command-injection attempts.
8. Implement browser selectors, lanes/cards/details/errors, mutations, refresh, and visibility recovery; each mutation response performs one complete board aggregate re-read and never applies optimistic or partially hydrated state.
9. Add `scripts/dsh-genie-board-smoke.ts`: create isolated fixture repo/profile state, run `dsh plugin --profile web add link:<absolute-plugin-dir>`, launch `dsh web --no-open --host 127.0.0.1 --port 0`, stop/relaunch it after install, prove `dsh plugin --profile web list --depth 0` reports `@automagik/genie-dsh-board`, read back the plugin health/compatibility route, perform board list/load plus reversible create/move through the Host route, and in `finally` stop the server, run `dsh plugin --profile web remove @automagik/genie-dsh-board`, and delete only the temporary profile/repository.

**Acceptance Criteria:**
- [ ] Rendering matches one complete fixture-backed Host aggregate; mutations use fixed argv and perform one complete refresh.
- [ ] Every unsafe/failure case is bounded and cannot invoke an out-of-scope command.
- [ ] The manifest and runtime reject every Genie version below the immutable candidate value stamped by Group 3, while source/linked tests prove the comparator against the checkout version without depending on a prior publication.
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

### Group 3: Immutable candidate, release proof, and discoverability

**Goal:** Publish only a human-approved stable candidate whose four platform artifacts prove the complete plugin payload.

**Deliverables:**
1. Add install/compatibility docs and provenance/NOTICE. Source and linked builds use the checkout root version; no source file guesses a future release number.
2. Extend `scripts/release-payload-version.ts` and its tests so the release workflow's already-resolved `VERSION` stamps and verifies all version-bearing staged and extracted members: root `VERSION`, existing Genie manifests, `plugins/dsh-genie-board/package.json.version`, and the DSH manifest's plugin version and `minimumGenieVersion`. Stamping happens before tarball creation, and any missing/divergent field fails the build.
3. Preserve the repository's authorized release identity sequence:
   - `.github/workflows/version.yml` derives a single candidate `VERSION`, binds it to an immutable tag/source SHA and successful source CI before any release build, and never reuses that identity;
   - the final stable release is started by a maintainer through `.github/workflows/release.yml` with that exact version/tag SHA/CI run;
   - the protected `production` environment approval must succeed before `authorize`, build, sign/attest, or publish can run.
   The same candidate value flows unchanged through build, signature, provenance, release asset names, plugin version, and `minimumGenieVersion`.
4. Add `scripts/verify-dsh-genie-board-release.ts` plus tests with two explicit modes: `--unsigned-artifact-dir` proves local tar inventory/member/version completeness, while `--signed-artifact-dir` and `--release` additionally require cryptographic sidecars and digest binding. Wire signed-artifact mode into `.github/workflows/release-publish.yml` after signed artifacts are downloaded but before draft reconciliation/publication. For the supplied candidate and channel, signed-artifact/release mode must fail closed unless:
   - the tarball stem set is exactly `linux-x64-glibc`, `linux-x64-musl`, `linux-arm64`, and `darwin-arm64`, with one nonempty `.bundle` and `.intoto.jsonl` beside each;
   - each tarball's recomputed SHA-256 equals its channel delivery descriptor's `artifactSha256`;
   - `scripts/verify-release.sh --local <tarball>` passes independently for each tarball, proving its cosign identity and SLSA provenance;
   - each extracted tarball contains every required plugin member: `package.json`, `agent.cordis.yml`, `cordis.patch.yml`, `README.md`, `NOTICE`, `dist/index.js`, and `dist/client.js`;
   - each extracted root/plugin/manifest version and `minimumGenieVersion` equals the immutable candidate exactly.
5. After the stable release is published, run the same verifier in release-download mode against `v$VERSION` and read back the release tag/source binding. Only that green post-publication proof permits adding the `dsh-plugin` GitHub topic; read the topic back afterward. A dev release, local build, unsigned tarball, missing platform, OR-style member check, or approval from the release initiator does not satisfy this gate.

**Acceptance Criteria:**
- [ ] Candidate version/tag/source/CI identity exists before build and flows unchanged through all four tarballs, plugin metadata, signatures, provenance, descriptors, and the published stable release.
- [ ] The protected human approval precedes build/sign/publish, and the pre-publication verifier rejects any missing/extra platform stem, digest mismatch, missing/invalid sidecar, missing required plugin member, or version mismatch.
- [ ] All four exact published tarballs independently pass SHA-256, cosign, SLSA, complete-member, and version/floor checks; the linked smoke from Group 2 changes no user repository.
- [ ] Topic publication occurs last and is verified by read-back.

**Validation:**
```bash
bun install --frozen-lockfile
bun run check
bun run build:plugin
VERSION="$(jq -r .version package.json)"
for PLATFORM in linux-x64-glibc linux-x64-musl linux-arm64 darwin-arm64; do
  bun run build:binary -- --platform "$PLATFORM" --version "$VERSION"
done
bun scripts/verify-dsh-genie-board-release.ts --unsigned-artifact-dir dist --version "$VERSION"
# Final gate after the separately approved stable Release workflow publishes:
bun scripts/verify-dsh-genie-board-release.ts --release "v$VERSION" --channel stable
```

The unsigned verifier mode proves only locally built inventory and member/version completeness and cannot authorize publication. Signed-artifact mode is mandatory inside the approved release workflow; the final release-download run is mandatory after publication and proves exactly four published platform tarballs individually against their digest, signature, provenance, complete plugin inventory, and immutable candidate identity before topic publication.

**depends-on:** Group 2
**blocks:** stable release/topic publication

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
| Complete aggregate detail increases one response's size. | Medium | Bound one snapshot by bytes/time and fail the whole response rather than expose partial state. |
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

### Decision resolution — direct Felipe approval (2026-09-03)

Felipe directly authorized the bounded plan amendment: complete aggregate views from one structured read; one immutable candidate version derived before build/sign/publish; and the authorized, human-approved stable workflow with fail-closed proof of exactly four platform artifacts and every required plugin member. The amended plan removes partial hydration, makes candidate stamping non-circular, and adds per-artifact digest/signature/provenance/member verification. No implementation, release, push, or topic publication was authorized by this amendment.

### Plan review round 3 — SHIP (2026-09-03T19:48:26Z)

- **Reviewed commit:** `9c5ba2714c52be97ad1742d7f2f3d1bd6c65a0c0`
- **Reviewer:** Steve, `juice/GLM-5.3` (full non-Flash GLM family; cross-family from Sofia/OpenAI GPT)
- **Mode:** independent, read-only, detached snapshot; runtime exposed no separate reasoning control, so maximum deliberation was required in the brief
- **Validation:** exact HEAD and detached state confirmed; `git status --porcelain` empty before/after; `wishes:lint` passed (86 files); amendment diff and live board/release interfaces inspected
- **Verdict:** **SHIP** — 0 CRITICAL, 0 HIGH; all three prior blockers closed

Closure evidence:
1. Complete aggregate board detail is one deterministic read with no partial/on-demand hydration and whole-response failure on missing detail.
2. Candidate identity is derived and bound before build; Group 2 tests the comparator without a published-version dependency; Group 3 stamps the same candidate into every shipped compatibility/version field.
3. The protected stable approval precedes build/sign/publish; signed and post-publication verification require exactly four platform stems, per-artifact SHA-256/cosign/SLSA proof, explicit plugin members, and exact candidate versions.

Non-blocking review notes: document that `minimumGenieVersion` intentionally equals the co-shipped plugin release, and record the exact DSH binary path/version in smoke output. Plan status advances to `APPROVED`; implementation and every release/publication gate remain separately authorized.

### Group 1 execution review round 1 — FIX-FIRST (2026-09-03T20:44:39Z)

- **Reviewed base:** `7c8b5afef` plus the uncommitted Group 1 diff
- **Diff SHA-256:** `5de022e12e2fbf51c4c99c96b5c0edb304e326598e04be5aa95c189e85c03300`
- **Reviewer:** independent native execution reviewer; read-only working-tree review
- **Validation:** `git diff --check` passed; focused board suite passed (50 tests); `bun run check` reached 1955 pass / 1 skip / 9 fail in untouched release/update/local-delivery tests.
- **Verdict:** **FIX-FIRST** — 0 CRITICAL, 2 HIGH, 2 MEDIUM.

Blocking gaps:
1. Malformed persisted lane metadata could serialize an invalid lane object with exit 0 instead of failing the whole aggregate.
2. Tests did not prove the constant set-query/single-transaction snapshot contract or the required range of malformed/nullability failures.

Non-blocking gaps: make equal-timestamp ordering and all liveness states discriminating, and strengthen byte-level compatibility fixtures for unchanged CLI surfaces. Fix loop 1 is active; the task remains `in_progress`.

### Group 1 execution review round 2 — BLOCKED (2026-09-03T20:59:04Z)

- **Reviewed base:** `7c8b5afef` plus the corrected uncommitted Group 1 diff
- **Diff SHA-256:** `a1b323b4073221ddb77eed59a8a64a7169837906b4fab66773d5f191498b003d`
- **Reviewer:** independent native execution reviewer; read-only working-tree review
- **Code verdict:** no remaining Group 1 findings; every round-one gap is closed.
- **Validation:** `git diff --check`, focused board suite (70 tests), typecheck, and scoped Biome passed. `bun run check` reached 1975 pass / 1 skip / 9 fail.
- **Verdict:** **BLOCKED** — the wish requires a green full gate, and the same nine release/update/local-delivery failures reproduce on untouched detached `HEAD`.

Corrective route: resolve or formally clear the repository-baseline failures, then rerun `bun run check`. No further Group 1 code fix is indicated; task `t_mtlkd9ad80ce9781` remains `in_progress`.


### Group 1 execution review round 3 — code SHIP (2026-09-07)

- **Reviewer:** independent Codex native reviewer `/root/g1_review`; not the original GLM implementation author.
- **Reviewed HEAD:** `fef77105405991b2f316626b664abdbcdeb7bd08` plus preserved G1 changes, replayed on current dev without conflict.
- **Full diff SHA-256 before this ledger entry:** `a422d2b135fe31ac9fb1507c8c523c95221cf142f4fb2e0735f2d5abdef3e554`.
- **Code/test diff SHA-256:** `57019e9daf27c7ca212000c8976ce41c4b604a363ab75fc088aac4260a61ae2c`.
- **Verdict:** code **SHIP**, no actionable findings. Snapshot consistency, indexed task-scoped JSON-set reads, 33k-card behavior, ordering/nullability, malformed-detail rejection, sanitized identifiers and unchanged output contracts reviewed.
- **Validation:** independent focused suite 76 pass / 0 fail, 382 assertions; diff check passed. Full repository gate is separate and remains pending recovery of reproduced release-test failures. No task-done or release claim.

### Group 1 acceptance — full gate green (2026-09-07)

- Baseline repairs independently reviewed **SHIP** by `/root/g1_review`; three-file diff digest `6c03b3e23eb59098b7554256dfd5d1cf741811a79e1a889204b389dc6cc57cf9`, committed as `4928e3988`.
- Root causes: release integration scenarios exceeded implicit test deadlines; Bun preserved a test-owned exit code when restored to undefined; a descendant-cleanup fixture could interpret empty stdout as PID zero. Assertions remain intact; subprocesses are bounded and cleanup validates a positive PID.
- **Full gate:** `bun run check` exited 0; **1990 pass / 1 skip / 0 fail**, 8407 assertions across 96 test files, 262.56 seconds. Frozen dependency install and build passed.
- **Dogfood:** built `dist/genie.js` against an isolated HOME and repository; board creation, task creation, comment, move and aggregate read returned the expected lane, comment and timeline. No personal profile or repository changed.
- G1 code review, full validation and built-CLI smoke are accepted. G2/G3 and stable publication remain pending; this is not whole-wish release acceptance.

---

## Files to Create/Modify

```
plugins/dsh-genie-board/**
src/term-commands/v5-board.ts
src/term-commands/v5-board.test.ts
scripts/dsh-genie-board-smoke.ts
scripts/verify-dsh-genie-board-release.ts
scripts/verify-dsh-genie-board-release.test.ts
scripts/build-binary.sh
scripts/release-payload-version.ts
scripts/release-payload-version.test.ts
scripts/release-docs.test.ts
scripts/version-format.test.ts
scripts/version-ci-staging.test.ts
scripts/orca-manifest-parity.test.ts
.github/workflows/release-publish.yml
package.json
README.md
.genie/brainstorms/dsh-genie-board/**
.genie/wishes/dsh-genie-board/WISH.md
.genie/INDEX.md
```
