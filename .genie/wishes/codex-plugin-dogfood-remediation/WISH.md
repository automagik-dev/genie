# Wish: Codex Dogfood Remediation — Exact Task CWD and Trustworthy Delivery

| Field | Value |
|-------|-------|
| **Status** | IN_PROGRESS |
| **Slug** | `codex-plugin-dogfood-remediation` |
| **Date** | 2026-07-22 |
| **Author** | Felipe Rosa + Codex dogfood investigation |
| **Appetite** | large |
| **Branch** | `wish/codex-plugin-dogfood-remediation` |
| **Repos touched** | genie |
| **Design** | _No brainstorm — direct wish_ |

## Summary

Make Genie in Codex observe the exact working directory of the Codex task instead of the installed
plugin cache, and make missing repository context fail explicitly rather than masquerade as a healthy
empty board. Close the dogfood-discovered activation, doctor, role-agent, installed-state, and release
evidence gaps so an update cannot retire a generation it cannot activate or report success from
contradictory state.

## Problem Statement

A newly started Codex thread in repository A can currently launch Genie from the plugin-cache CWD,
return a healthy empty board instead of A's seeded state, and let setup mutate activation before a
missing delivery record is rejected.

## Investigation Evidence

- Codex 0.144.4 resolves the delivered `plugins/genie/.mcp.json` entry's `cwd: "."` to the versioned
  plugin cache. A disposable launch observed that cache as `process.cwd()` and found no task CWD in
  `PWD`; the launcher cannot reconstruct the original context.
- `src/lib/v5/mcp-server.ts` captures `process.cwd()` as repository context. Opening a database where
  none exists currently yields valid empty task output, so the wrong cache context passes health
  probes.
- Codex's official MCP configuration reference defines `cwd` as an optional server-start override and
  supports trusted project `.codex/config.toml` layers. The existing marker-owned project entry already
  has an absolute command and arguments and omits `cwd`.
- The delivered generation can exist without a readable delivery record. Setup permits activation far
  enough to retire the prior generation, then final revalidation discovers the absent record; an
  already-current update returns before repairing it.
- Doctor executes two Codex observations with different stderr rules. Codex's sandbox PATH advisory can
  therefore produce a plugin PASS together with a `query-failed` integration summary.
- Live role agents have no managed inventory, one delivered profile is stale, duplicate managed
  surfaces are visible, and the legacy `~/.genie/.install-version` disagrees with canonical `VERSION`.
- The live evidence validator expects a synthetic flat `integrationSummary.state`; real doctor JSON
  nests this under `integrationSummary.codexPlugin.state`. Current smoke tests accept an unseeded empty
  MCP board and do not exercise a real previous-release-to-candidate handoff.

## Scope

### IN

- Replace Codex plugin-owned Genie MCP routing with one marker-owned, project-scoped
  `mcp_servers.genie` entry whose stable `GENIE_HOME/bin/genie` executable and arguments are absolute
  and which has no effective `cwd` override (the source omits it; host JSON may serialize it as absent
  or `null`).
- Preserve the Codex effective launch CWD through process launch. Capture raw `thread/start.cwd` only in
  black-box `CodexCwdEvidence`; production `CodexHostObservation` is limited to facts observable from
  the spawned runtime/plugin process.
- Resolve worktree/config, absolute Git-common-directory, and Genie-storage roots without changing the
  server process CWD; reject unsupported Git layouts explicitly instead of falling outward or to cache.
- Detect nested configuration shadowing, untrusted project configuration, missing project context, and
  missing repository database as explicit diagnostic/error states, including nested-repository and
  linked-worktree boundaries.
- Remove Codex MCP capability advertisement and cache-root health assumptions from the plugin payload
  while preserving the separate Claude plugin MCP launch contract.
- Reconcile the plugin-independent project route during trusted `genie init`; require a matching
  authenticated delivery record before any setup/activation-owned prompt or mutation.
- Add provenance-verified, same-version delivery repair owned only by update/install, including the
  old-parent/current-target missing-record recovery path and tamper-resistant immutable target binding.
- Collapse doctor and activation reporting onto one bounded Codex observation and one consistent typed
  result; make setup banners/config writes reflect this invocation rather than historical config.
- Converge delivered Codex role agents safely when inventory is missing, remove only proven
  Genie-managed duplicate surfaces, and preserve personal/modified/symlinked collisions byte-for-byte.
- Retire orphaned `.install-version` metadata only after successful install/update convergence and keep
  canonical `VERSION` as the v5 authority.
- Gate release promotion on seeded repository MCP identity, real nested doctor JSON, every supported
  artifact named by the release manifest, and a provenance-bound previous-release-to-candidate
  lifecycle.
- Prove migration behavior for one reconciled repository and one untouched repository after the global
  plugin MCP route disappears; the untouched repository has no fallback and receives a one-command
  per-repository reconciliation instruction.

### OUT

- Changing Codex host behavior, project-trust policy, task-resume/cache-retention semantics, or the
  meaning of `--add-dir`.
- Automatically trusting repositories, approving hooks, or silently selecting a secondary repository
  passed through `--add-dir`.
- Recovering a task CWD from `PWD`, stamping an absolute versioned plugin-cache launcher, or installing a
  user-global Genie MCP server.
- Making setup or doctor mint delivery records, hand-writing the live missing record, deleting the live
  activation journal, or otherwise bypassing the delivery/activation boundary.
- Rewriting a user-owned project/global `mcp_servers.genie` route, guessing ownership from a damaged
  marker, or silently crossing an uninitialized nested Git repository to use an outer database.
- Supporting bare repositories, submodules, or external/separate-Git-dir layouts in this iteration;
  these receive a typed `unsupported-project-layout` failure and never an outer/cache fallback.
- Overwriting unknown or user-modified role-agent files, or treating filename equality alone as Genie
  ownership.
- A general MCP protocol/UI-bridge redesign, broad marketplace redesign, or upstream suppression of the
  Codex CLI PATH advisory.
- Replacing the independent `stable-release-security-gate`; both gates remain required for stable
  promotion.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | A trusted initialized project owns one marker-managed Genie MCP route. Plugin availability never creates or removes it. | Repository state is scoped by the task, while a global versioned plugin cache has no trustworthy repository identity. |
| 2 | The project route uses the canonical absolute stable `GENIE_HOME/bin/genie` facade with `args = ["mcp"]` and no effective `cwd` override. Source TOML omits `cwd`; host JSON may represent that as absent or `null`. | A stable install path survives plugin version changes, and no override lets Codex select the child launch CWD without making a serialization spelling part of the contract. |
| 3 | Group B must receive independent execution-review SHIP for its pinned long-lived app-server black-box proof before Group A may begin, merge, activate, or remove the plugin MCP route. Failure blocks route migration; there is no cache/global fallback. | Documentation is not sufficient evidence for sequential, concurrent, symlinked, and multi-repository thread behavior, and route removal must not outrun its replacement proof. |
| 4 | Exact child CWD means string equality with a control process's effective `process.cwd()` plus equality of OS directory identity. Raw `thread/start.cwd` exists only in black-box `CodexCwdEvidence`; production `CodexHostObservation` never claims to receive it. | This separates host-request evidence from observable production runtime facts while testing symlink/case normalization honestly. |
| 5 | The MCP server never calls `chdir`. It keeps effective launch CWD and a separate `worktreeConfigRoot`; for supported ordinary/linked non-bare worktrees it resolves absolute `gitCommonDir` using `git rev-parse --path-format=absolute --git-common-dir`, sets `genieStorageRoot = dirname(gitCommonDir)`, and selects `<genieStorageRoot>/.genie/genie.db`. | Linked worktrees need their own config while sharing repository task state; the exact Git common directory and its parent are different identities. |
| 6 | A nested initialized Git repository is a hard lookup boundary. If it has no Genie database, return a structured error rather than walking through it to an outer repository. | Falling through would silently expose the wrong board. |
| 7 | Remove the Codex manifest's MCP declaration and Codex-only `.mcp.json`; keep Claude's separate inline launcher. | It prevents cache-root launch and accidental double registration without regressing the sibling integration. |
| 8 | Marker ownership is required for automatic route edits. Unowned project/global same-key routes, damaged markers, and shadowing are preserved and reported; no command overwrites them. | A route name is not proof of ownership. |
| 9 | A matching authenticated delivery record is checked before setup/activation's first prompt or mutation and again inside `beginActivation` immediately before its first write. | The current flow discovers a missing record only after retiring the prior generation; defense in depth makes stale permits harmless. |
| 10 | Only update/install can publish delivery facts. Same-version repair pins channel, immutable target version/platform, release tag/name, and fetched manifest bytes/digest before downloading the exact named asset; it computes SHA-256 afterward, authenticates that digest with the existing GitHub attestation/cosign trust anchors, and rechecks the channel under the lifecycle lease. | The current manifest does not provide an artifact digest, installed bytes cannot attest to themselves, and a moving channel must route to ordinary upgrade rather than redefine an in-flight repair. |
| 11 | Doctor consumes one bounded host observation. Exit 0 plus exactly one bounded schema-valid JSON stdout value succeeds with bounded advisory stderr retained only as sanitized metadata. | This handles the real sandbox warning while rejecting timeout, overflow, nonzero exit, malformed/duplicate JSON, or unsafe state. |
| 12 | Setup persists and prints success from a typed per-invocation outcome. | A historical `configured: true` flag cannot truthfully describe a failed or pending run. |
| 13 | Plugin-namespaced role agents are authoritative when enabled. Historical fanned files are adopted or removed only by exact frozen profile identity, committed consent, and backup-first inventory creation. | This converges missing inventory and duplicates without claiming personal files. |
| 14 | Canonical `VERSION` is the sole v5 installed-version authority. Group D exclusively owns the `.install-version` retirement API and its install/update/uninstall wiring; successful install/update convergence retires the marker, while failures preserve prior bytes. | Synchronizing orphan metadata creates another authority; keeping install-lifecycle writes out of role convergence removes overlap and retires drift transactionally. |
| 15 | Group F owns a parameterized evidence harness/validator plus representative local end-to-end proof; Group G derives and runs the complete native artifact/platform matrix from the release manifest in build/release workflows. | Local harness completion cannot stand in for native-platform promotion evidence, while empty, synthetic, or stale evidence must not authorize release. |

## State and Path Contracts

An **authenticated delivery record** is a deep-delivery-store record created only after signature,
attestation, and release-manifest verification. It binds the immutable target version,
platform/architecture triple, channel snapshot, release tag/name, fetched release-manifest digest, the
computed and authenticated downloaded-artifact digest, installed binary digest, plugin payload tree
digest, delivery root/ID, and publication time. A record is `matching` only when all bound values equal
the installed target and current activation intent; absent fields, parse/schema failures, byte changes,
wrong platform/version/channel snapshot, digest changes, or intent mismatch classify it as
`absent | invalid | mismatch`. Setup and doctor never create or repair this record.

The production repository path model has four explicit values:

1. `effectiveLaunchCwd`: the MCP child's observable `process.cwd()`, compared in the black-box harness
   to a Codex-launched control process by exact string and OS directory identity and never changed by
   Genie.
2. `worktreeConfigRoot`: the nearest containing Git worktree root where trusted project Codex config is
   inspected or marker-owned config is reconciled.
3. `gitCommonDir`: the absolute result of
   `git rev-parse --path-format=absolute --git-common-dir` for a supported ordinary or linked non-bare
   worktree.
4. `genieStorageRoot = dirname(gitCommonDir)`, with the only task database at
   `<genieStorageRoot>/.genie/genie.db`.

`CodexCwdEvidence` is a black-box harness record, not a production observation. It alone may pair raw
`thread/start.cwd` with control/child effective CWD, OS directory identities, PID, and sentinel. The
production `CodexHostObservation` contains only runtime/plugin facts it can observe and never carries or
infers raw requested CWD.

For a linked worktree, the exact assertion is: the child remains in the linked-worktree directory,
`worktreeConfigRoot` is that linked worktree, `gitCommonDir` is the main repository's absolute common
Git directory, `genieStorageRoot` is exactly its parent, and the sentinel is read only from
`<genieStorageRoot>/.genie/genie.db`; no config or DB lookup may substitute the outer repository,
plugin cache, or silently switch the child CWD. Bare repositories, submodules, and external/separate-
Git-dir layouts return typed `unsupported-project-layout` before DB lookup.

## Command and State Authority

| Surface | Allowed writes | Delivery precondition | Missing-record behavior |
|---------|----------------|-----------------------|-------------------------|
| `genie init` in a trusted initialized repository | Create/reconcile only an intact marker-owned project route and its backup; it may update that marker's stable absolute command after a `GENIE_HOME` relocation | None, because the project route is plugin- and activation-independent | Reconcile the route normally; never prompt for activation or touch delivery, journal, plugin state, enabled flags, agents, or caches |
| Ordinary `genie update` / `genie install` | Stage, verify, install, and deep-publish the selected release under existing transactional semantics | Verified signed release artifact | Follow ordinary upgrade/install; never perform activation-owned prompt, journal, plugin-enabled, project-route, or role-agent mutation |
| Same-version update/install repair | Re-fetch, stage, verify, and deep-publish only the pinned installed target's missing record | Pin channel, immutable version/platform, release tag/name, and fetched manifest bytes/digest before download; authenticate the post-download SHA-256 under the existing attestation/cosign anchors | Recheck the channel under lease, publish once, and return the activation handoff; a channel advance routes to ordinary upgrade without minting a same-version record |
| `genie setup --codex` / activation | After a matching record: consent prompt, journal, plugin registration/removal, enabled-state restoration, marker-owned project-route reconciliation, parity/H3, and managed-role convergence | Matching authenticated record checked before the first prompt/mutation and again in `beginActivation` | Exit `delivery-incomplete`, `deliveryComplete: false`, with one update/install recovery command; zero activation-owned mutation |
| `genie doctor` and evidence collection | None; all config, delivery, plugin, cache, journal, role, and DB access is read-only | None | Report `delivery-incomplete` plus recovery command consistently; never heal or mint state |

When the plugin-global MCP route disappears, an untouched repository has an explicitly absent project
route and no fallback. Doctor reports the repository path and the single reconciliation command
`cd <repo> && genie init`; only that command may create the marker-owned route. A user-owned
`mcp_servers.genie`, damaged marker, or higher-precedence shadowing layer is preserved and reported as a
collision requiring user resolution rather than rewritten by this command.

## Dependencies

**depends-on:** codex-plugin-update-handoff
**blocks:** none

## Success Criteria

- [x] An app-server black-box test proves `process.cwd()` in the MCP child exactly equals
      a Codex control process's effective `process.cwd()` by string and OS directory identity for a
      repository root, nested directory, linked worktree, symlink/case-normalized path, and two repos;
      raw `thread/start.cwd` remains separately visible only in `CodexCwdEvidence`, not production
      `CodexHostObservation`.
- [x] One pinned long-lived Codex app-server runs sequential and concurrent threads in two repositories,
      records raw request plus child PID/CWD per harness case, and proves a child PID is never reused
      when the effective CWD string or OS identity differs. Reuse is allowed when both effective-CWD
      values match, irrespective of case labels; tagged sentinels still detect cross-talk.
- [x] The linked-worktree case keeps the child and marker config in the linked worktree while
      `gitCommonDir` is the absolute main-repository Git directory,
      `genieStorageRoot = dirname(gitCommonDir)`, and `resolveDbPath` reads exactly
      `<genieStorageRoot>/.genie/genie.db`; neither main-worktree CWD nor plugin cache appears as launch
      context.
- [ ] `codex mcp get genie --json` reports the marker-owned absolute project command with no effective
      CWD override, accepting either absent or `null` host serialization, and the installed Codex plugin
      contributes no second Genie MCP route.
- [x] Group B's black-box proof receives independent execution-review SHIP before any Group A route
      migration merges, activates, or removes the plugin MCP route; a failed proof leaves the old route
      intact and blocks migration.
- [x] Enabled, disabled, absent, malformed, and upgraded plugin fixtures retain exactly one owned project
      route, preserve unrelated TOML byte-for-byte, and converge idempotently; user-owned project/global
      same-key routes, damaged markers, and shadowing are never overwritten.
- [x] A two-repository 5.260722.1 migration leaves reconciled A healthy, untouched B explicitly route
      absent with no cache fallback, and makes `cd B && genie init` the only one-command reconciliation;
      afterward B returns only B's sentinel.
- [x] The marker uses the canonical stable absolute `GENIE_HOME/bin/genie` facade across plugin updates
      and symlinked invocation; explicit home relocation is reconciled only by trusted init, and uninstall
      leaves an inert/actionable missing executable rather than a versioned-cache fallback.
- [x] Nested config shadowing and untrusted project config are reported distinctly; untrusted config is
      left intact and doctor says trust is required rather than claiming MCP health.
- [x] A nested initialized repository uses its own common/storage root; a nested Git repository without
      Genie initialization fails at that boundary and never reads an outer database.
- [x] Bare repositories, submodules, and external/separate-Git-dir layouts return
      `unsupported-project-layout` before config/DB success and never use an outer repository or plugin
      cache as fallback.
- [x] Missing Git/Genie context or `.genie/genie.db` returns a stable structured MCP error and can never
      serialize a healthy empty board.
- [x] Upgrade messaging requires a new Codex task after route changes; no claim is made that an existing
      task's already-started MCP process was rebound.
- [x] Outside trusted `genie init`, missing/invalid/mismatched attestation causes zero prompt or
      activation-owned journal, plugin, enabled-state, project-route, role-agent, or cache mutation and
      reports `deliveryComplete: false`; doctor remains read-only in every state.
- [x] A provenance-verified current-version repair handles both an old registered parent and the live
      target-current/removal-observed intent, publishes once, preserves the parent until activation,
      and remains idempotent with a matching record.
- [x] Same-version repair pins channel, immutable target version/platform, release tag/name, and fetched
      manifest bytes/digest before download; downloads that exact named asset, computes SHA-256 only
      afterward, authenticates the digest for repository `automagik-dev/genie`, predicate
      `https://github.com/automagik-dev/genie/release-tarballs/v1`, workflow identity
      `https://github.com/automagik-dev/genie/.github/workflows/sign-attest.yml@refs/heads/main`, and
      issuer `https://token.actions.githubusercontent.com`, then persists the authenticated digest.
- [x] Under the lifecycle lease, same-version repair rechecks the pinned channel and routes an advance to
      ordinary upgrade; it never claims the release manifest supplied an artifact digest or relabels
      installed bytes.
- [x] Setup finalization after repair performs no second plugin add, restores enabled state, completes
      parity/H3, clears the journal normally, and ends with doctor state `current`.
- [x] Doctor spawns exactly one Codex plugin query and never reports PASS together with a query-failed
      integration summary; the real bounded PATH advisory does not corrupt JSON stdout or force failure.
- [x] Failed or pending standalone `setup --codex` preserves config bytes and prints no green saved
      banner, including on a historically configured machine.
- [x] Missing-inventory migration ends with all delivered role agents current, including the reviewer,
      with one managed surface per role and every unrelated/personal agent byte- and mode-identical.
- [x] Group D's successful install/update convergence leaves no `.install-version`; interrupted/failed
      install/update preserves the prior marker and installed trees, uninstall tolerates both layouts,
      and every path is safe to rerun without Group C role writes.
- [ ] Live evidence validation accepts only real nested doctor JSON, rejects the obsolete flat fixture,
      and binds previous/candidate versions, hashes, provenance, delivery identities, and ordered stages.
- [ ] Group F's parameterized harness/validator passes representative host-native/local seeded MCP and
      real N→T cases; Group G then runs every artifact/platform entry named by the candidate release
      manifest natively. Missing/unavailable matrix entries, empty-board response, or inconsistent
      setup/doctor/trailer block promotion jointly with the independent security gate.

## Execution Strategy

### Mandatory preflight

Work begins only after `codex-plugin-update-handoff` is merged into the implementation base and its
focused validation is green. The worker must refresh the branch, map moved anchors, and preserve the
behavioral contracts in this wish rather than copying stale line-level patches from another worktree.
All home/config/plugin/cache fixtures isolate `HOME`, `GENIE_HOME`, `CODEX_HOME`, `TMPDIR`, and Git
repositories before importing stateful modules or spawning subprocesses, then assert no writes escape
the fixture root.

Group B's black-box proof and independent execution-review SHIP are a hard migration prerequisite. No
Group A implementation may be claimed or merged, no activation may select the project-route migration,
and the plugin MCP route must not be removed before that verdict. A failed or blocked proof leaves the
existing route intact and blocks A rather than enabling an outer, cache, or global fallback.

### Wave 1 (host proof and independent role contract)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| B | engineer-complex | 5 — host process proof (+2), delivery attestation (+2), prior incident (+1) | high | host-observation-attestation: pinned app-server CWD proof, one observation result, and pre-mutation attestation guard |
| C | engineer-complex | 4 — stateful migration (+2), multi-surface assets (+1), prior drift (+1) | high | managed-assets-convergence: role inventory, adoption, duplicate policy, and personal-file preservation only |

### Wave 2 (parallel route and delivery work after B SHIP)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| A | engineer-complex | 4 — config ownership (+2), repository-root model (+2) | high | project-route-context: marker-owned route, exact Git/storage resolver, fail-closed DB context, and gated plugin route removal |
| D | engineer-complex | 5 — immutable artifact verification (+2), stateful publication (+2), prior incident (+1) | high | immutable-delivery-repair: signed current-version recovery plus install-marker lifecycle in update/install only |

### Wave 3 (lifecycle integration after A, B, and D)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| E | engineer-complex | 5 — lifecycle orchestration (+2), multi-command truth (+2), PTY integration (+1) | high | lifecycle-truth-integration: wire route/context, observation, repair handoff, setup, and doctor |

### Wave 4 (artifact evidence after C and E)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| F | engineer-complex | 5 — cross-version harness (+2), artifact identity (+2), schema migration (+1) | high | dogfood-harness-validator: parameterized harness/schema plus representative host-native/local N→T proof |

### Wave 5 (promotion after F)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| G | engineer-complex + independent final-gate | 4 — release wiring (+2), docs/final review (+2) | highest justified | promotion-docs-final-gate: manifest-derived matrix, joint promotion gates, operator docs, and independent evidence review |

The explicit DAG is `B -> A`, `B -> D`, `{A, B, D} -> E`, `{C, E} -> F`, and `F -> G`. Groups B and C
run first in parallel isolated worktrees. After B receives independent execution-review SHIP, A and D
may run in parallel. A exclusively owns project route/config and repository/storage context. B
exclusively owns production host observation, black-box CWD evidence, delivery-attestation
classification, and the inner activation guard; it does not edit project configuration or context
resolution. C exclusively owns role-agent profiles, inventory, adoption, and duplicate policy. D
exclusively owns install/update command changes, delivery publication, the `.install-version` lifecycle
module/API, and install/update/uninstall wiring and validation. Role cleanup therefore stays off the CWD
and delivery-repair critical paths. E wires A, B, and D into setup/doctor without changing their
contracts. F waits for both lifecycle truth and asset convergence; G owns the native release matrix,
promotion/docs, and final review.

Task-row group tags plus the WISH slug are authoritative. The current CLI cannot rename the existing D
and E task titles, so those historical titles are not claimed to match this refinement; task comments
persist the refined Group D/E scope. Task rows do not encode dependencies, so the work orchestrator
claims groups only when these edges and prior execution-review SHIP verdicts permit it.

## Execution Groups

### Group A: project-route-context

**Goal:** Make the project-owned route and repository/storage identities explicit, safe to reconcile,
and incapable of returning an outer/cache-root empty board.

**Deliverables:**
1. Only after Group B's independent execution-review SHIP, remove the Codex plugin manifest's MCP
   declaration/capability and Codex-only `.mcp.json`; retain Claude's separate inline launcher and
   regression coverage. No pre-SHIP merge, activation, or removal is permitted.
2. Make trusted `genie init` create or reconcile one intact marker-owned project entry using the stable
   canonical absolute `GENIE_HOME/bin/genie`, `args = ["mcp"]`, and no effective CWD override (source
   `cwd` absent; host serialization absent or `null`), independent of plugin and delivery state.
   Preserve unrelated TOML, comments, ordering, mode, and backups atomically.
3. Classify marker-owned, absent, user-owned same-key, damaged marker, malformed TOML, untrusted config,
   global same-key, and effective-layer shadowing without rewriting anything unowned.
4. Implement the four-value production path result: `effectiveLaunchCwd`, separate
   `worktreeConfigRoot`, absolute `gitCommonDir` from
   `git rev-parse --path-format=absolute --git-common-dir`, and
   `genieStorageRoot = dirname(gitCommonDir)`. The only DB candidate is
   `<genieStorageRoot>/.genie/genie.db`; the resolver never calls `chdir` or considers the plugin cache.
5. Stop lookup at the nearest nested Git repository. In linked worktrees, keep config under the linked
   root but make `resolveDbPath` follow absolute `gitCommonDir` to the DB under its parent.
6. Return typed `project-context-unavailable`, `project-database-unavailable`, `route-collision`,
   `route-shadowed`, `project-trust-required`, and `unsupported-project-layout` states before any MCP
   tool can serialize empty success. Bare repositories, submodules, and external/separate-Git-dir
   layouts are unsupported in this iteration and never fall outward or to cache.
7. Define stable-command behavior: version updates retain the facade path; symlinked invocation writes
   the canonical facade; explicit `GENIE_HOME` relocation is reconciled only by init; uninstall leaves an
   inert actionable marker, never a cache path.

**Acceptance Criteria:**
- [x] Root, ordinary nested directory, initialized nested repository, uninitialized nested repository,
      and linked-worktree fixtures resolve the specified config root, absolute `gitCommonDir`, and exact
      `dirname(gitCommonDir)` storage root without changing effective launch CWD.
- [x] Linked worktree config is read from the linked root and its sentinel from the common-root DB;
      the DB path is exactly `<dirname(gitCommonDir)>/.genie/genie.db`, and neither outer,
      main-worktree-CWD, nor cache storage is substituted.
- [ ] `codex mcp list/get --json` shows one owned project route with a stable absolute command and
      no effective CWD override (accepting absent or `null` serialization); no Codex plugin route remains
      and Claude's launcher remains covered.
- [x] User-owned project/global same-key routes, damaged markers, malformed config, trust boundaries,
      and shadowing are byte-identical after inspection/reconciliation attempts and receive distinct
      actionable states.
- [x] Bare, submodule, and external/separate-Git-dir fixtures return `unsupported-project-layout` before
      DB/tool success and never probe an outer repository or plugin-cache database.
- [x] Two-repo migration proves reconciled A works, untouched B has explicit absence/no fallback, and
      `cd B && genie init` safely reconciles only B.
- [x] Stable command fixtures cover plugin update, symlinked launch, explicit home relocation, and
      uninstall without writing a versioned plugin-cache path or overwriting an unowned route.

**Validation:**
```bash
bun test src/lib/codex-project-mcp.test.ts \
  src/lib/v5/mcp-tools.test.ts \
  src/term-commands/init.test.ts \
  src/term-commands/mcp.test.ts \
  tests/integration/codex-project-route-migration.test.ts
```

**depends-on:** B (including independent execution-review SHIP)

---

### Group B: host-observation-attestation

**Goal:** Prove omitted-`cwd` behavior at the Codex host boundary, expose one bounded observation result,
and refuse activation before mutation without a matching authenticated record.

**Deliverables:**
1. Create production `CodexHostObservation` as one immutable result containing only facts observable
   from the runtime/plugin query: effective child CWD/identity when emitted by the probe, child PID,
   parsed plugin facts, bounded sanitized advisory stderr, cache-family witness, and typed failure. It
   neither receives nor infers raw `thread/start.cwd` or control-process facts.
2. Define separate harness-only `CodexCwdEvidence` around one pinned long-lived Codex app-server. Run
   sequential and concurrent threads in two repositories through an absolute fake MCP command with no
   effective CWD override; pair raw `thread/start.cwd` with control/child effective CWD identities, PID,
   and tagged sentinel. A PID may be reused only when effective CWD string and OS identity both match;
   differing effective CWD forbids reuse, while repository/case labels alone do not.
3. Compare child CWD with a Codex-launched control process by exact string and OS directory identity,
   retaining raw `thread/start.cwd` only in `CodexCwdEvidence`. Cover symlink and case normalization
   where the host filesystem supports it. If any invariant fails, mark the group BLOCKED; Group A may
   not begin, merge, activate, or remove the plugin route.
4. Add the pure authenticated-record assessment (`matching | absent | invalid | mismatch`) and stable
   `delivery-incomplete` result with `authority: none`, exit 1, and `deliveryComplete: false`.
5. Apply that assessment to activation pending, registration absent, downgrade, planned/post-command
   recovery, and target-current intent; revalidate inside `beginActivation` immediately before its first
   write while retaining callback-scoped final delivery-root validation.
6. Parse one bounded Codex subprocess observation: accept advisory stderr only with exit 0 and exactly
   one schema-valid bounded JSON stdout value; reject timeout, overflow, nonzero exit, malformed/duplicate
   JSON, invalid versions, duplicate registration, or unsafe cache roots.
7. Add mutation spies and record-tampering fixtures for every bound record field and stale permits.

**Acceptance Criteria:**
- [x] One app-server proves root/nested/linked/symlink-normalized launch behavior and both sequential and
      concurrent two-repo threads; each harness case records raw request, child PID/effective CWD, and a
      tagged sentinel. A child PID never crosses differing effective-CWD strings or OS identities;
      same-effective-CWD reuse is allowed, and no cross-talk or cache-root context occurs.
- [x] Child and control effective CWDs have exact string and directory-identity equality; evidence keeps
      the potentially different raw requested spelling rather than normalizing it away, while production
      `CodexHostObservation` contains neither raw request nor control-only fields.
- [x] No non-matching record path prompts or performs activation-owned journal, registration, enabled,
      project-route, role, or cache mutation; a stale permit cannot bypass the inner guard.
- [x] Matching records preserve downgrade binding and final callback revalidation; tampering with any
      version/platform/manifest/artifact/binary/payload/delivery/intent binding becomes invalid/mismatch.
- [x] One bounded result supplies all downstream projections; the real PATH advisory succeeds only with
      valid exit/stdout, and every failure remains one ANSI-free typed result.

**Validation:**
```bash
bun test src/lib/codex-host-observation.test.ts \
  src/lib/codex-activation.test.ts \
  src/lib/codex-activation-executor.test.ts \
  tests/integration/codex-app-server-cwd.test.ts
```

**depends-on:** none

---

### Group C: managed-assets-convergence

**Goal:** Converge delivered role agents and inventory without claiming or damaging user-owned files.

**Deliverables:**
1. Define a frozen, versioned historical profile allowlist containing name, content digest, file type,
   and mode for every legitimately fanned Genie Codex role.
2. When inventory is missing, adopt a legacy file only after committed Codex consent and an exact
   allowlist match; backup first, write inventory atomically, then refresh stale canonical profiles.
3. Make plugin-namespaced agents authoritative while enabled and remove only inventory-owned or exact
   historical duplicates. Preserve unknown, modified, symlinked, and personal TOMLs byte- and
   mode-identically; restore required fallback roles only when the plugin is disabled/absent.
4. Update agent inventory/doctor output to distinguish managed, adoptable historical, collision,
   stale, and personal states and report the expected delivered total and reviewer digest.
5. Add fixtures for the observed 0/7-inventory state, stale reviewer, duplicate surfaces, seven
   unrelated personal agents, interrupted role migration, and repeated role convergence.

**Acceptance Criteria:**
- [x] The live-shape missing-inventory fixture converges every delivered role and the current reviewer
      while unrelated/personal files retain exact bytes, type, permissions, and timestamps where
      supported.
- [x] Enabled plugin state exposes one managed surface per role; disabled/absent state has the intended
      fallback, and reruns create no duplicates.
- [x] Modified, unknown, symlinked, or profile-lookalike collisions are reported and never overwritten,
      adopted, or deleted.

**Validation:**
```bash
bun test src/lib/runtime-integrations.test.ts \
  src/lib/agent-sync.test.ts
```

**depends-on:** none

---

### Group D: immutable-delivery-repair

**Goal:** Let update/install repair a missing record for the installed target exactly once without
performing activation or redefining that target from a moving channel.

**Deliverables:**
1. Before an already-current return, consume Group B's assessment; pin channel, immutable target
   version/platform, release tag/name, and fetched release-manifest bytes/digest before asset download.
   The release manifest is not treated as a source of artifact digest.
2. Download the exact named asset, compute its SHA-256 afterward, and authenticate that digest using the
   existing GitHub attestation/cosign anchors: repository `automagik-dev/genie`, predicate
   `https://github.com/automagik-dev/genie/release-tarballs/v1`, workflow identity
   `https://github.com/automagik-dev/genie/.github/workflows/sign-attest.yml@refs/heads/main`, and OIDC
   issuer `https://token.actions.githubusercontent.com`. Persist that computed authenticated digest.
3. Extract privately, prove candidate VERSION/binary/plugin tree against canonical installed bytes,
   acquire the lifecycle lease, and recheck the pinned channel before publication. A channel advance
   executes ordinary upgrade; otherwise reobserve and publish through the existing deep delivery store.
4. Keep a no-network fast path for matching records. Leave all state unchanged on provenance,
   signature, digest, platform, extraction, lease, installed-byte, intent, or reobservation failure.
5. Cover old-parent→current-target/no-record and target-current/removal-observed/no-record. Publish while
   preserving the old registered generation and return the setup activation handoff; update/install do
   not prompt, reconcile project config, mutate journal/enabled/plugin state, or converge roles.
6. Create one `.install-version` lifecycle module/API owned by D and wire only install/update/uninstall
   paths to it. Canonical `VERSION` is authoritative; retire the legacy marker only after successful
   install/update convergence, preserve its exact prior bytes/tree on failure, and make uninstall
   idempotent with either layout. Group C never imports or mutates this API.
7. Ensure deferred install publishes its matching record before its existing exit-2 handoff and that
   repeated repair neither downloads nor republishes.

**Acceptance Criteria:**
- [x] The old-parent fixture publishes one record bound to the pinned tuple, keeps N registered, and exits
      2 with the exact next action; a matching rerun performs no download/publication.
- [x] The live target-current/removal-observed fixture repairs without any plugin command or other
      activation-owned mutation.
- [x] A channel advance routes to ordinary upgrade and never mints a record for stale installed bytes.
- [x] Repair pins channel/version/platform/release tag/name plus manifest bytes/digest before download,
      downloads the exact named asset, computes SHA-256 afterward, authenticates it against every stated
      repository/predicate/workflow/OIDC anchor, and persists the computed authenticated digest.
- [x] Field, artifact, manifest, payload, platform, installed-byte, and intent tampering plus lease or
      reobservation failure leave record/journal/plugin/cache/config/roles unchanged and report
      `deliveryComplete: false`.
- [x] Successful install/update retires `.install-version`; injected failures preserve its prior bytes
      and installed tree, reruns converge safely, and uninstall accepts present/absent markers without
      any role-agent/inventory mutation.

**Validation:**
```bash
bun test src/genie-commands/codex-delivery.test.ts \
  src/genie-commands/__tests__/update.test.ts \
  src/genie-commands/install.test.ts \
  src/genie-commands/install-promote.test.ts \
  src/lib/install-version-marker.test.ts \
  src/genie-commands/uninstall.test.ts \
  tests/integration/codex-delivery-bootstrap.test.ts
```

**depends-on:** B

---

### Group E: lifecycle-truth-integration

**Goal:** Wire project context, one host observation, and immutable delivery handoff into truthful setup,
activation, and doctor surfaces.

**Deliverables:**
1. Enforce the authority matrix at command boundaries: init's route-only path remains independent;
   setup/activation check a matching record before their first prompt/mutation; doctor is read-only.
2. Make setup consume Group A's route/context result, Group B's single observation/attestation, and Group
   D's handoff. After a matching record it may reconcile the intact owned route and execute consented
   activation, parity/H3, enabled-state restoration, and normal journal clearing.
3. Return one typed per-invocation setup outcome. Failed or pending standalone setup preserves config
   bytes and prints no green saved banner; the full wizard may save unrelated completed sections without
   claiming Codex success.
4. Make doctor derive check list, nested `integrationSummary.codexPlugin`, human text, suggestions, JSON,
   trailer, and exit from the same observation/context facts. Advisory stderr is diagnostic metadata,
   never a second policy decision or stdout contaminant.
5. Add a real-PTY flow for repair handoff → setup consent/finalization → explicit new-task instruction →
   doctor current, including PATH advisory, stale historical config, route collision, and context errors.

**Acceptance Criteria:**
- [x] Missing/invalid/mismatched record reaches neither prompt nor activation-owned mutation and produces
      one consistent `delivery-incomplete` result with the update/install recovery command.
- [x] After target-current repair, setup performs zero second plugin add, completes parity/H3, restores
      enabled state, and clears the journal only through normal protocol.
- [x] Failed/pending standalone setup preserves config bytes and omits the green banner even when
      historical config says configured; only this invocation's current success persists that state.
- [x] Doctor spawns exactly one plugin observation and cannot combine PASS/current with query-failed,
      unhealthy project context, route collision/shadowing, or missing delivery.
- [x] Real PATH advisory yields one ANSI-free JSON object and consistent human/trailer/exit; timeout,
      overflow, malformed/duplicate JSON, and nonzero exit fail consistently.

**Validation:**
```bash
bun test src/genie-commands/setup.test.ts \
  src/genie-commands/doctor.test.ts \
  src/lib/codex-activation-executor.test.ts \
  tests/integration/codex-lifecycle-pty.test.ts
```

**depends-on:** A, B, D

---

### Group F: dogfood-harness-validator

**Goal:** Produce a parameterized tamper-evident harness/validator for exact repository identity and a
real previous-release-to-candidate lifecycle, with representative local proof using the production
doctor schema.

**Deliverables:**
1. Build a parameterized harness that accepts an explicit platform/artifact/manifest entry and replaces
   empty-directory smoke fixtures with initialized repositories containing unpredictable unique
   wish/task sentinels. Require exact repository/CWD identity, never empty-board or cache-root success.
2. Build a provenance-bound N→T path using a verified previous stable binary as parent and exact
   candidate artifact as child. Record version, platform, binary/artifact/manifest hashes, commit/channel,
   delivery ID/root, child PID/CWD identity, exits, trailers, and ordered lifecycle stages.
3. Prove N remains active until consented activation; T's repair and setup finalize in order; route and
   roles converge; a newly started thread sees the exact sentinel; doctor exits 0/current.
4. Version the live evidence schema around the real nested
   `integrationSummary.codexPlugin.state`. Reject the obsolete flat shape, missing/duplicate/out-of-order
   stages, inconsistent human/JSON/trailer state, unavailable artifacts, unseeded/empty boards, stale
   tasks, and identity/digest mismatch.
5. Run representative host-native/local seeded and N→T cases to prove the parameterized harness and
   validator. Emit reusable per-entry pass/fail evidence for Group G; do not claim all native platforms
   were exercised locally.

**Acceptance Criteria:**
- [ ] Representative host-native/local candidate cases return only their repository's exact seeded
      sentinel; empty, cross-repository, cache-root, stale-task, missing, or unavailable evidence fails.
- [ ] A verified N parent hands off to exact T, N remains active before consent, repair/activation/assets
      complete in order, and all process/artifact/delivery identities are evidence-bound.
- [ ] Validator fixtures are captured from real doctor output topology, accept only nested consistent
      state, and reject the prior flat synthetic object and every tampered binding/stage.
- [ ] The two-repo harness includes an untouched-B migration state with no fallback before init and
      successful B-only reconciliation afterward.

**Validation:**
```bash
bun test tests/integration/codex-cross-version-update.test.ts \
  tests/integration/codex-task-cwd-mcp.test.ts \
  scripts/validate-live-dogfood-evidence.test.ts \
  scripts/verify-codex-activation-payload.test.ts \
  scripts/fresh-install-smoke.test.ts
bun run smoke:codex
```

**depends-on:** C, E

---

### Group G: promotion-docs-final-gate

**Goal:** Make the manifest-derived dogfood evidence and independent security evidence joint promotion
requirements, then document and independently review the shipped operator experience.

**Deliverables:**
1. Derive the complete native artifact/platform matrix from the candidate release manifest and wire/run
   Group F's parameterized harness for every entry in build/release workflows. Emit explicit failure for
   every missing/unavailable entry; a hand-written or representative-only matrix cannot promote.
2. Wire the full-matrix result into homolog and stable promotion as a mandatory gate alongside the
   independent `stable-release-security-gate`; neither gate satisfies or bypasses the other.
3. Publish setup/update/doctor/plugin and troubleshooting documentation for project trust, exact/effective
   task CWD, linked/nested roots, route collisions/shadowing, untouched-repo reconciliation, new-task
   requirement, immutable repair, and non-destructive role migration.
4. Build and verify every release-manifest artifact, run the complete repository gate, and persist the
   evidence schema/version and candidate identities used by promotion.
5. Dispatch an independent highest-effort final-gate reviewer over exact artifacts and persisted evidence
   only after Groups A–F receive independent execution-review SHIP verdicts.

**Acceptance Criteria:**
- [ ] Homolog/stable cannot proceed unless both the Codex dogfood gate and
      `stable-release-security-gate` pass for the same candidate; neither unavailable nor skipped is pass.
- [ ] Manifest entries and natively executed harness results match one-for-one across the complete
      supported matrix; representative Group F evidence alone cannot satisfy this criterion.
- [ ] Documentation gives one command for untouched-repo reconciliation and precise recovery for trust,
      collision, damaged-marker, delivery-incomplete, relocation/uninstall, and stale-task states.
- [ ] Candidate manifest entries equal tested evidence entries one-for-one, and all artifacts plus full
      repository validation pass.
- [ ] Independent final-gate review returns SHIP without weakening CWD, mutation-authority, provenance,
      seeded-state, role-ownership, or nested-doctor-schema criteria.

**Validation:**
```bash
bun test scripts/fresh-install-smoke.test.ts \
  scripts/validate-live-dogfood-evidence.test.ts \
  scripts/verify-codex-activation-payload.test.ts
bun run smoke:codex
bun run check
```

**depends-on:** F

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] From root, nested directory, linked worktree, and two simultaneous repositories, a newly started
      Codex task's child matches the control effective CWD by string/directory identity, retains the raw
      requested CWD separately only in `CodexCwdEvidence`, and returns only that repository's seeded
      Genie task state.
- [ ] Upgrade from delivered 5.260722.1 removes Codex cache-root MCP routing, writes/retains one
      marker-managed project route, preserves unrelated project TOML, and tells the user to start a new
      task.
- [ ] Missing trust/config/root/database and nested shadowing are actionable failures, never green empty
      state.
- [ ] The live missing-delivery-record state is recoverable through signed update then consented setup,
      without manual record/journal edits or premature retirement.
- [ ] Setup, doctor JSON/human output, result trailer, and process exit agree under current, pending,
      delivery-incomplete, warning-on-stderr, and query-failure cases.
- [ ] Role-agent convergence fixes the stale reviewer and duplicates while every personal collision is
      unchanged; repeat runs are idempotent.
- [ ] Fresh install, same-version repair, failed install, and uninstall prove canonical `VERSION` and
      safe legacy-marker retirement.
- [ ] Exact candidate artifacts pass seeded MCP plus real N→T evidence for every manifest-derived
      platform/artifact entry, and both promotion gates remain mandatory.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Codex may not give an omitted-`cwd` child the thread's effective directory. | High | Group B's app-server proof is a hard gate. If it fails, mark BLOCKED and obtain a host-supported task-CWD channel; never fall back to cache root, `PWD`, or global MCP. |
| Existing Codex tasks retain an already-started cache-root MCP after files change. | High | Migration output requires a new task and release QA proves the new task only; do not claim in-place rebinding. |
| Nested project config can shadow the root marker block. | High | Inspect the root-to-CWD config chain, report the nearer owner/path, and refuse a health claim until resolved without editing user-owned nested config. |
| Same-version repair could let installed bytes attest to themselves. | High | Re-fetch and verify the exact signed/channel artifact, compare it to canonical bytes, and restrict publication to update/install under the lifecycle lease. |
| Historical role profiles could collide with personal files. | High | Require exact frozen identity, committed consent, regular-file/type/mode checks, backup-first inventory, and byte-preservation assertions; otherwise report only. |
| Parallel groups could edit shared lifecycle files. | Medium | Enforce the stated ownership boundaries, use isolated worktrees, and require execution-review SHIP before Group E integrates the contracts. |
| Retiring `.install-version` could regress legacy uninstall behavior. | Medium | Update uninstall to tolerate both layouts, delete only after successful convergence, and cover fresh/legacy/failure/dry-run cases. |
| Cross-version tests could accidentally use the source checkout for both N and T. | High | Bind absolute binaries and artifacts to independently verified hashes/provenance and fail if parent/child identity aliases or candidate evidence is unavailable. |
| Seeded health could still pass through a cached response. | Medium | Use per-run unpredictable sentinels and two repositories, bind timestamps/paths, and require no cross-repository observation. |

---

## Review Results

_The read-only reviewer returns evidence; the invoking orchestrator appends a timestamped block here after plan, execution, and PR reviews._

### 2026-07-22T04:59:02Z — Plan review loop 1

- **Context:** pre-work plan review
- **Target SHA-256:** `5ae24d53b3006c80a4fe051b4ba2b7cb6ac1773b02cda32f233e1581138e7d72`
- **Repository HEAD:** `b7a6da54af0154e3722ceec7d57226091689c753`
- **Validation:** `rtk bun run wishes:lint` — PASS (61 files, 0 broken brainstorm links)
- **Verdict:** **FIX-FIRST**
- **Blocking gaps:** project-route writes contradicted delivery gating; linked-worktree CWD/config/storage
  identities were conflated. The reviewer also requested smaller lifecycle/release groups, `blocks: none`,
  and a one-sentence problem statement.
- **Fix-loop response:** added the command/state authority matrix, authenticated-record definition,
  effective-CWD/worktree/Git-common/storage identities, linked-worktree and untouched-repository proofs,
  disjoint ownership, immutable repair binding, and a seven-group DAG.
- **Questioner advisory incorporated:** long-lived app-server concurrency, same-name/unowned route and
  damaged-marker cases, nested-repository boundaries, stable executable lifetime, channel-advance
  handling, real nested doctor evidence, and manifest-derived artifact coverage.

### Plan re-review loop 1 — FIX-FIRST

- **Target SHA-256:** `5774c2d84b5ac659a3ea47994e103e4839cbc126eee101c1e5a06c8c095025f1`
- **Validation:** reviewed SHA matched locally; post-fix `rtk bun run wishes:lint` — PASS (61 files,
  0 broken brainstorm links); semantic verdict remains **FIX-FIRST** pending independent re-review.
- **Governing HIGH gaps:** (1) route migration/removal was not gated by Group B execution-review SHIP;
  (2) Git common-directory, worktree config, and shared DB identities were not exact for linked layouts;
  (3) Group C and D overlapped on `.install-version` plus install/update ownership.
- **Fix-loop response:** reordered waves/DAG to `B -> {A, D}` then `{A, B, D} -> E`, made B SHIP a hard
  precondition for A, defined absolute `gitCommonDir` and `genieStorageRoot = dirname(gitCommonDir)`,
  moved install-marker lifecycle exclusively to D, and recorded historical D/E task-title handling.
  The questioner counterexamples were also encoded by separating harness-only `CodexCwdEvidence` from
  production observation, correcting post-download attested digest provenance, splitting F/G local vs
  native-matrix authority, accepting absent/null no-override serialization, and permitting reuse only
  for the same effective CWD.

### 2026-07-22T05:31:12Z — Plan re-review loop 2

- **Context:** fresh independent final plan gate after fix loop 2/2
- **Reviewed SHA-256:** `4581b7a0080d95ec2d5debda0512302bfd64ad305bdc9a07a06bf6d11b41c541`
- **Repository HEAD:** `b7a6da54af0154e3722ceec7d57226091689c753`
- **Validation:** exact SHA matched before/after review; `rtk bun run wishes:lint` — PASS (61 files,
  0 broken brainstorm links); seven ready A–G task rows and durable D/E scope comments verified;
  placeholder, dependency, acceptance, validation, and source-anchor checks passed.
- **Governing gaps:** CRITICAL none; HIGH none; MEDIUM none; LOW none.
- **Verdict:** **SHIP** — Group B's independently reviewed host proof gates route removal; the path,
  authority, ownership, provenance, evidence, and promotion contracts are testable and executable.
- **Advisory lens follow-through:** Group D execution review should verify the signed attestation's
  subject/predicate semantics rather than only blob identity, and Group G execution review should prove
  that its pre-promotion candidate inventory is immutable, complete, digest-bound, and regenerated from
  the final workflow commit. These are pressure tests for execution evidence, not changes to the
  governing SHIP verdict.

### 2026-07-22T05:43:57Z — Explicit fresh plan review

- **Context:** user-requested independent plan review before work
- **Reviewed SHA-256:** `75a3a851787b8c965565cace0c1c8c725b45a7ae5b60bc0bf271c86d01217bd1`
- **Repository HEAD:** `b7a6da54af0154e3722ceec7d57226091689c753`
- **Dependency branch HEAD:** `dddc35609626f6656b52e9c5b2812d4d66c352b9`
- **Validation:** exact SHA matched before/after review; `rtk bun run wishes:lint` — PASS (61 files,
  0 broken brainstorm links); seven ready A–G task rows and durable D/E scope comments verified; the
  focused dependency baseline passed 161 tests with 0 failures. Reviewers made no repository changes.
- **Dependency diagnosis:** repository `blocked=true` is the declared upstream preflight, not a plan
  defect. `codex-plugin-update-handoff` has execution-review SHIP evidence but its final merge/handoff
  row remains ready and the activation protocol is not yet on dev, so this wish must not execute yet.
- **Governing gaps:** CRITICAL none; HIGH none; MEDIUM none; LOW none.
- **Verdict:** **SHIP** — status remains **APPROVED**; execution becomes eligible only after the upstream
  merge/preflight and then follows the internal `B -> {A, D} -> E -> F -> G` gates.
- **Questioner advisory:** before any checkout, keep the prose-only DAG and Group-B-SHIP prerequisite
  explicit in orchestrator state; Group B should run its no-production-mutation host proof first;
  attested setup must test the current-repository absent-route case without touching other repositories;
  Group G must materialize a pre-publish, digest-bound candidate inventory rather than treating the
  post-publish channel pointer as that inventory.
- **Supply-chain advisory:** Group D execution review must prove that direct or `INSECURE=1` install can
  never mint a delivery record; distinguish native-predicate semantic verification from cosign
  blob-signature fallback and persist the accepted proof profile/evidence identity. Group G must keep
  candidate execution read-only and secretless, pass one trusted candidate-inventory digest through
  dogfood/publication/channel advancement, and prevent write-capable jobs from executing candidate code.
  The advisory audit passed 258 focused tests with 0 failures and made no profile changes.

### 2026-07-23T01:55:00Z — Group E execution review

- **Context:** Group E (lifecycle-truth-integration) execution review, PR #2630 (`wish/dogfood-E` → dev)
- **Branch commits:** fc96d3ee (handoff doc), f660d902 (doctor single observation), 51374f2c (setup
  delivery gate + typed outcome), c73850cb (post-activation route fix + real-PTY flow), ed75b432
  (uninstall-marker retirement), 6878189 (review LOW fixes: dotted-key route detection, typed
  context-state PTY assertion)
- **Reviewer:** independent adversarial execution reviewer (not the author); verdict **SHIP** —
  CRITICAL none; HIGH none; MEDIUM two (both confirmed intended: doctor `deliveryComplete` now
  requires a matching authenticated record per the authority matrix, so pre-record installs report
  `delivery-incomplete` until one `genie update`; `project-trust-required` warns for never-trusted
  projects per "never claim health for an untrusted project"); LOW three (two fixed in 6878189, one
  noted: collision-after-activation throw is pre-existing polish debt)
- **Reviewer validation (self-run):** 277/0 across the seven touched suites; 194/0 adjacent
  executor/project-mcp/activation/host-observation suites; typecheck and lint exit 0; A/B/D contract
  files byte-identical to origin/dev (empty diffstat)
- **Orchestrator validation (own runs):** full `bun test` 2528 tests with the sole failure being the
  pre-existing Linux-only `ss`-based ui-bridge socket test (green in CI); CI condition (codex stripped
  from PATH) 277/0 including the real-PTY flow; `bun run smoke:codex` exit 0; PR CI rollup all
  SUCCESS, merge state CLEAN
- **Defect found by the new PTY flow and fixed in-wave:** setup's post-activation reconcile used the
  pre-Group-A synthetic usable-plugin probe whose documented behavior removed the project fallback,
  leaving a repository with NO Codex route after successful activation (Decision 1 violation); the
  post-activation probe now declares route-unusability and reconciles the stable absolute
  `GENIE_HOME/bin/genie` facade route exactly as trusted init writes it (Decision 2)
- **Carry-forwards resolved:** A's deferred typed config-layer states shipped as the route-layer
  classifier (`route-collision`, `route-shadowed`, `global-route-same-key`, `untrusted-config`,
  `project-trust-required`) with doctor JSON riders; D's `uninstallInstallVersionMarker` retired with
  documented digest-window rationale and both legacy layouts pinned through the real digest-verified
  batch path; A's live-QA item (AC3 `codex mcp get genie --json`) remains reserved for the operator's
  post-merge ritual
- **Verdict:** **SHIP** — Group E awaits operator merge of PR #2630; durable wish status unchanged
  until merge

### 2026-07-23T05:30:00Z — Ledger maintenance: waves 1+2 execution evidence + live-QA follow-through

- **Context:** the H3 SessionStart line surfaced ledger drift (status still APPROVED, 5/67 criteria,
  waves 1+2 evidence never recorded here). This block backfills the durable record; no code changed.
- **Status:** APPROVED → **IN_PROGRESS** (execution began 2026-07-22; upstream
  `codex-plugin-update-handoff` code merged to dev, its WISH→SHIPPED remains gated on the operator's
  homolog ritual, so the dependency-derived `blocked` flag persists by design).
- **Waves 1+2 (merged to dev 2026-07-22, per-group execution review SHIP, validations reproduced by
  the invoking orchestrator before merge):**
  - Group B host-observation-attestation — PR #2625, 165/0 including the live pinned app-server
    black-box proof; B SHIP preceded any Group A route change (Decision 3 honored).
  - Group C managed-assets-convergence — PR #2626, 403/0; byte-identical preservation of
    modified/unknown/symlinked/personal files; R3 intact.
  - Group A project-route-context — PR #2629, 94/0; empty-board masquerade closed; plugin Codex MCP
    route removed; marker-owned project route authoritative.
  - Group D immutable-delivery-repair — PR #2628, 397/0; one-shot pinned repair + `.install-version`
    retirement module.
- **Wave 3 (Group E):** PR #2630 SHIP evidence recorded in the 2026-07-23T01:55Z block above; the
  operator merge that block awaited landed as dev commit `4be6917f` (2026-07-23T02:22Z), which is
  the merge the Group-E criterion ticks rest on.
- **Live-QA follow-through (operator dogfood on two hosts, seven defects found and fixed same-day,
  all merged to dev):** #2631 journal-quarantine permit consumption; #2632 `$HOME`
  trusted-executable false positive + dead-end already-current recovery + codex-only recovery text
  on a claude failure; #2633 post-A manifest false-warns in doctor; #2634 absent-N delivery-record
  publication (fresh host); #2636 stale-record republication when a verified delivery lands on a
  current generation.
- **Open follow-up (deferred by #2633, previously tracked only in that PR body):** the route
  probe's `usable`/`activeManifestError` semantics still encode the pre-A manifest expectation;
  retiring those pre-A plugin-route arms wholesale needs its own reviewed pass (naively flipping
  `usable` would resurrect route-conflict/fallback-removal behavior). Queued behind Group F.
- **Checkbox policy applied:** ticked only criteria owned by merged groups with CI-reproduced or
  PTY-flow evidence. Deliberately NOT ticked: the two live `codex mcp get genie --json` proofs (the
  operator's AC3 ritual — output never captured), Group F/G criteria, and all post-merge QA rows.

---

## Files to Create/Modify

```text
plugins/genie/.codex-plugin/plugin.json
plugins/genie/.mcp.json (remove Codex-only route)
plugins/genie/.claude-plugin/plugin.json (regression validation only unless contract changes)
plugins/genie/scripts/mcp-launcher.cjs (Claude regression coverage only)
plugins/genie/agents/**
src/lib/codex-project-mcp.ts
src/lib/codex-project-mcp.test.ts
src/lib/codex-host-observation.ts (new)
src/lib/codex-host-observation.test.ts (new)
tests/support/codex-cwd-evidence.ts (new; harness-only raw-request evidence)
src/lib/codex-mcp-health-session.ts
src/lib/codex-mcp-health-session.test.ts
src/lib/v5/genie-db.ts
src/lib/v5/genie-db.test.ts
src/lib/v5/mcp-server.ts
src/lib/v5/mcp-tools.ts
src/lib/v5/mcp-tools.test.ts
src/lib/codex-activation.ts
src/lib/codex-activation.test.ts
src/lib/codex-activation-executor.ts
src/lib/codex-activation-executor.test.ts
src/lib/runtime-integrations.ts
src/lib/runtime-integrations.test.ts
src/lib/agent-sync.ts
src/lib/agent-sync.test.ts
src/lib/install-version-marker.ts (new; Group D ownership)
src/lib/install-version-marker.test.ts (new)
src/genie-commands/codex-delivery.ts
src/genie-commands/codex-delivery.test.ts
src/genie-commands/update.ts
src/genie-commands/__tests__/update.test.ts
src/genie-commands/install.ts
src/genie-commands/install.test.ts
src/genie-commands/install-promote.test.ts
src/genie-commands/setup.ts
src/genie-commands/setup.test.ts
src/genie-commands/doctor.ts
src/genie-commands/doctor.test.ts
src/genie-commands/uninstall.test.ts
src/term-commands/init.ts
src/term-commands/init.test.ts
src/term-commands/mcp.ts
src/term-commands/mcp.test.ts
scripts/uninstall.js
scripts/codex-plugin-only-smoke.ts
scripts/fresh-install-smoke.ts
scripts/fresh-install-smoke.test.ts
scripts/validate-live-dogfood-evidence.ts
scripts/validate-live-dogfood-evidence.test.ts
scripts/verify-codex-activation-payload.test.ts
tests/integration/codex-task-cwd-mcp.test.ts (new)
tests/integration/codex-app-server-cwd.test.ts (new)
tests/integration/codex-project-route-migration.test.ts (new)
tests/integration/codex-delivery-bootstrap.test.ts (new)
tests/integration/codex-lifecycle-pty.test.ts (new)
tests/integration/codex-cross-version-update.test.ts (new)
.github/workflows/build-tarballs.yml
.github/workflows/release.yml
.github/workflows/release-publish.yml
.github/workflows/sign-attest.yml
.github/workflows/version.yml
docs/** selected during implementation mapping
```
