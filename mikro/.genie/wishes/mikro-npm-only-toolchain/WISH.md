# Wish: npm-only reproducible toolchain (NMSTX-690)

| Field | Value |
|-------|-------|
| **Status** | IN_PROGRESS |
| **Slug** | `mikro-npm-only-toolchain` |
| **Date** | 2026-09-07 |
| **Author** | Codex dispatched planner; coordinator owns approval |
| **Appetite** | medium |
| **Branch** | `wish/mikro-npm-only-toolchain` |
| **Repos touched** | automagik-dev/mikro |
| **Design** | [DESIGN.md](../../brainstorms/mikro-npm-only-toolchain/DESIGN.md) |

## Summary

Make npm and the committed package lock the single reproducible dependency authority for Mikro checkouts, with one dependency-free guard before every owned installation mutation. Preserve the reviewed design's exact contract and prove rejection, coherent installation, clean generated output, audit, smoke, and exact remote-dev identity before the user-controlled main merge. The independently reviewed plan is APPROVED; implementation still waits for accepted NMSTX-689 and immutable seam reconciliation recorded by the coordinator.

## Scope

### IN

- Delete tracked `bun.lock`, retain `package-lock.json`, add `scripts/check-npm-authority.mjs`, and expose `npm run deps:ci` with exact script value `node scripts/check-npm-authority.mjs && npm ci`.
- Guard the local wrapper, CI install, canonical installer, source and committed updater, and launcher repair before npm installation or any dependency-tree mutation, including recovery and parking.
- Frozen cross-seam invalid matrix, coherent controls, focused regression tests, clean build-owned output, full gate, production audit, real install/update smoke, and exact remote-dev installation/read-back evidence.
- Directly affected local/consumer documentation and bounded integration reconciliation with the completed NMSTX-689 shared installer lock.

### OUT

- Dependency version/range/resolution changes, Node/npm version changes, Bun support, action pinning, publishing, attestations, new lifecycle hooks, and installer redesign.
- `.github/workflows/release.yml` changes or adding installation there; release evidence comes from candidate-SHA CI.
- Raw `npm ci` interception or pre-mutation protection of `npm install github:automagik-dev/mikro`; consumer manifests/locks govern consumer projects.
- NMSTX-688 Python host work, NMSTX-689 lock implementation, other portfolio children, other lifecycle documents, Genie DB tasks, or worker-owned Linear/gate changes.
- Old B0/P0 bootstrap replay, dev recreation, invented prerequisite SHAs, autonomous main merge, or approval before independent evidence is persisted.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | One built-in-only Node guard, one npm authority | Smallest implementation of the verified design. |
| 2 | Exact script and explicit six-file competing-lock set | Avoids hidden precedence and expanded validation semantics. |
| 3 | All owned seams share guard semantics, including recovery | An npm-only check after parking cannot preserve the previous tree. |
| 4 | Freeze the completed-689 dependency graph | No upgrades or incidental lock resolution drift belong to 690. |
| 5 | Preserve 689 lock ownership; reconcile only its actual interface | Lock file location, acquire/release ordering, stale-owner behavior and recovery APIs do not yet exist as verified implementation facts. |
| 6 | Existing dev integrates released main plus 688 plus 689 before 690 | Supersedes only the design's historical B0/P0 delivery assumption under the current explicit instruction; no design edit or restamp. |
| 7 | One non-draft dev→main PR, native Fable Harness 4888 final-head review, user main merge | Approval and release remain coordinator/user gates. |

### Verified evidence and baseline

Before consuming DESIGN, `node /home/genie/.agents/skills/wish/references/design-review-evidence.mjs verify .genie/brainstorms/mikro-npm-only-toolchain/DESIGN.md` exited 0 on 2026-09-07. Persisted evidence is SHIP, reviewer `openai-codex:gpt-5.6-sol-900k`, reviewed at `2026-08-31T21:35:05Z`, content SHA-256 `341755ca5beb2e8e73892ebfbb303b1e840e3acaf57421d8c865f45f6d953f03`; this digest is read from verified evidence, not newly minted.

Read-only installed baseline: `/home/genie/.local/bin/mikro` resolves to `/home/genie/.mikro/mikro/bin/mikro.mjs`; installed checkout HEAD is `35f03a1b1cc9937eee28a4cf6aa4edaabc126b23`, manifest version `1.260907.1`, with empty `git status --short`. Working checkout began on `nmstx/688-python-host-survival` at that SHA with concurrent 688 changes; it is not clean integration evidence. Local dev exists; cached remote refs are not live remote proof.

### Exact guard contract (verbatim from verified DESIGN)

The guard runs from the repository root and exits nonzero with the offending path/field and npm-only remediation when any rule fails:

1. `package.json` and `package-lock.json` both exist and parse as JSON objects.
2. `package-lock.json.lockfileVersion` is exactly `3`, and `package-lock.json.packages[""]` exists as an object.
3. Manifest/lock coherence is key-order-independent and exact for these fields only:
   - `package.json.name` equals both `package-lock.json.name` and `package-lock.json.packages[""].name`;
   - `package.json.version` equals both `package-lock.json.version` and `package-lock.json.packages[""].version`;
   - `dependencies`, `devDependencies`, and `engines` in `package.json` deeply equal the corresponding objects in `package-lock.json.packages[""]` (an absent field is normalized to `{}` on both sides).
4. None of this explicit competing-lock set exists at repository root: `bun.lock`, `bun.lockb`, `yarn.lock`, `pnpm-lock.yaml`, `pnpm-lock.yml`, `npm-shrinkwrap.json`.

No other manifest fields, transitive package entries, lockfiles outside the repository root, or consumer-project state are part of this guard.


### Owned install-path ordering (verbatim from verified DESIGN)

| Journey | Production seam | Required ordering |
|---|---|---|
| Local development | `package.json` script `npm run deps:ci` | guard, then `npm ci`; README uses this wrapper instead of raw `npm ci` |
| CI | `.github/workflows/ci.yml` quality-gate install step | invoke `npm run deps:ci`; no separate unguarded `npm ci` |
| Canonical installer | `scripts/install.sh` (also reached by `npm run install:local`) | after checkout selection but before its `npm ci` and before any `node_modules` mutation |
| In-place updater | `src/cli.ts` and build-owned `dist/src/cli.js` | guard before parking/removing `node_modules`, then run `npm ci` |
| Launcher self-heal | `bin/mikro.mjs` | guard after detecting an incomplete install but before spawning repair `npm ci` or mutating `node_modules` |

`README.md:438`'s direct local `npm ci` is replaced by `npm run deps:ci`; an operator can still bypass repository wrappers, but that bypass is explicitly unsupported by the guard-before-mutation invariant. `README.md:51` and `docs/release-contract.md` retain the consumer git-dependency command while stating that it is consumer-side npm behavior, not a Mikro-checkout install path and not covered by that invariant.


### Integration with NMSTX-689

After 689 completes, before any 690 implementation, the coordinator records the exact 688/689 integrated SHAs and a bounded seam map for the delivered shared installer lock: its production path, caller API, ownership lifetime, recovery entry points, and generated/test ownership. Record where each actual dependency mutation happens and where this guard executes on the selected checkout. Every restore, deletion, creation, rename/park and npm install must follow a successful guard; no lock-driven recovery may precede it. Preserve 689 serialization and failure cleanup; determine guard placement relative to lock acquisition from actual code, not an invented protocol, and repeat the guard under ownership if validation would otherwise become stale before mutation. Lock bookkeeping does not excuse dependency mutation.

If satisfying this ordering needs editing a new shared module outside the frozen production allowlist, or changes 689's lock semantics, stop at FIX-FIRST for coordinator reconciliation and independent review of the scope amendment before implementation. Do not silently expand the allowlist. No unresolved lock-interface choice may pass this prerequisite gate.

### Current 689 seam reconciliation (provisional until its final commit is accepted)

NMSTX-688 is committed as `3e709222ee361ea43bcee597179c74aa84aabb35`. The active689 implementation has moved dependency mutations from `src/cli.ts` and `bin/mikro.mjs` into dependency-free `bin/install-state.mjs`. Its `repair(root, reinstall)` function runs under the shared exclusive lock: it restores/deletes legacy or sibling parked trees, parks current dependencies, invokes npm, rolls back failed installs, builds and clears pending state. `update` selects/reset/cleans the target then invokes repair; normal `launch` checks completeness under lock and invokes a repair worker if needed; the canonical installer acquires the same transaction before checkout selection and calls its token-verified `finish` entry, which invokes repair. Guard invocation belongs at the start of needed repair under ownership, before the first legacy/sibling recovery mutation. Root selection and lock bookkeeping precede it; dependency mutation does not. A successful pre-check outside ownership cannot replace that call.

**Bounded scope amendment for independent review:** add `bin/install-state.mjs` to690's production allowlist solely for the common authority guard call/import and any minimal callable seam needed to test that production call. Preserve689's locking, journal, process ownership, rollback and timeout semantics. The original design allowlist is retained below as historical reviewed text; this explicit amendment relocates its updater/self-heal guard insertion to the module689 now owns. Add `tests/install-coordination.test.ts` and its normal generated output solely to make its valid fixture manifests/locks coherent and copy the required authority guard into those fixture checkouts. Do not weaken or remove any689 concurrency/recovery assertion. All unrelated production scope remains excluded, especially release workflow and dependency upgrades. If final689 changes the described interface or needs any other file, reconcile and independently review before implementation.

The fixture's existing package.json has no lock and copies only installer/bin files;690 must preserve its collision assertions while supplying a matching v3 root lock and guard. The canonical invalid-fixture matrix still exercises actual installer/update/launcher paths; common repair tests cannot replace entry-point assertions. This map is not accepted689 evidence until coordinator records its final SHA and tests and reviewer checks the resulting immutable source.

**Legacy migration ordering correction:** `scripts/install.sh` also moves `$HOME/.rlmx` to `$HOME/.mikro` and its nested `rlmx` checkout to `mikro`. These moves can relocate node_modules and are reachable with a custom installation prefix. Move that existing migration block after destination checkout selection and before `finish`; invoke the same dependency-free authority guard on the selected `MIKRO_INSTALL_DIR` under the already-held installer transaction before either legacy rename. The common repair guard then validates that selected root again before recovery/npm. Do not move legacy dependency trees during preflight/bootstrap or before the selected-root guard; if the selected root cannot be validated, return its actionable guard error without either rename or any npm call. This changes ordering within the existing installer path, not lock ownership or migration semantics. Add a custom-prefix fixture with an existing legacy checkout dependency sentinel and absent new home: corrupt selected metadata must leave legacy/current/parked dependency bytes and legacy/destination migration paths unchanged with no npm; a coherent control must prove both legacy renames and canonical install remain reachable. The original default-prefix test alone is insufficient. Inspect final689 source for any additional pre-guard mutation and reconcile before execution.

**Concrete graph/audit comparator:** coordinator-owned evidence tool `/home/genie/.codex/worktrees/7747/sofia/evidence/mikro-690-compare.mjs` reads manifest/lock from full immutable Git SHAs, requires every transitive record and manifest dependency/engine/override field equal, and compares full/production advisory identities and impact fields. Invocation: `node /home/genie/.codex/worktrees/7747/sofia/evidence/mikro-690-compare.mjs "$PWD" "$INTEGRATION_BASE" "$CANDIDATE_SHA" "$BASE_AUDIT_DIR" "$CANDIDATE_AUDIT_DIR"`. Each directory contains full.json, production.json and receipt.json with matching sha, timestamp, node, npm, registry and full/production command+exitCode. Capture independent fresh baseline/candidate reports; malformed/error reports or unknown exits fail. Receipt verification requires exact full/production commands, supported audit report schema with consistent severity/inventory counts, all advisory record shapes, immutable manifest/lock hashes, stdout report hashes and retained stderr hashes, typed timestamp/runtime/registry context and equal baseline/candidate contexts. Hashes bind bytes but do not replace schema validation; negative fixtures must recompute hashes when testing malformed content. Historical baseline receipts are controls only, never accepted689/candidate proof. Baseline-on-itself positive control and raised-severity negative control passed on releasedmain; these controls are not candidate acceptance. Reviewer must inspect this tool before relying on it. Any changed advisory requires triage (the comparator conservatively rejects changed impact even if it might be an improvement); removed findings are permitted. No tool code is added to Mikro production.

## Simplicity Case

- **Simplest complete design:** one committed npm lock, one dependency-free guard, one documented wrapper, four additional owned journeys calling the same guard.
- **Added machinery:** table-driven temporary checkout fixtures with filesystem and npm tripwires prove the required pre-mutation property; 689's existing shared lock is reused only to preserve its delivered concurrency contract.
- **Deferred until measured:** version pinning, attestations and alternative managers require a separate reproducibility/security finding and authorization; new recovery/locking abstractions require a concrete failure that cannot fit the delivered 689 interface.
- **Complexity removed:** dual-lock precedence, package-manager selection, new lifecycle hooks, and unsupported promises about consumer npm.

## Dependencies

**depends-on:** none
**blocks:** none

These machine-readable fields contain only known wish slugs; no 688/689 wish slug is established in the inspected checkout, so none is fabricated. Mandatory external Orca/Linear edges are **NMSTX-688 → NMSTX-689 → NMSTX-690 implementation**, plus the independently verified/persisted plan-review gate. Coordinator must map actual wish slugs if subsequently created, without removing those external blockers. This plan may be reviewed while 689 is active; production implementation cannot overlap those prerequisites.

Baseline is **released main 35f03a1 + completed 688 (`3e709222ee361ea43bcee597179c74aa84aabb35`) + committed 689 (`0eb3b7307a582a45040f5a35706feadee0ee0fb2`; aggregate acceptance waits the Prime fixture repair)** integrated into **existing dev**. Record the resulting clean integration SHA before execution; never replay old bootstrap or treat the dirty shared checkout as that baseline. Coordinator alone owns Orca state, Linear, approval persistence and integration.

## Success Criteria

- [x] `package-lock.json` is the sole supported repository lock authority; the exact structural and five manifest-field checks pass, and all six declared competing locks are absent.
- [x] Every frozen invalid fixture fails with actionable npm-only guidance before npm launch or any `node_modules` mutation across the local wrapper, CI, canonical installer, source/committed updater, and launcher self-heal; the coherent fixture reaches npm once.
- [x] Documentation replaces raw local `npm ci` with `npm run deps:ci` and accurately excludes both deliberate raw npm bypass and consumer git-dependency installation from the repository-owned pre-mutation guarantee.
- [ ] Clean wrapped install, typecheck, build, full tests, real install/update smoke and generated-output equality pass on the exact integrated dev SHA; audit evidence acceptance follows the explicit unchanged-graph/no-new-or-worsened-findings policy below, without claiming a clean npm audit.
- [ ] GitHub remote `refs/heads/dev`, the matching Actions workflow-runs API `.head_sha`, and installed checkout HEAD equal the candidate SHA before and after install/read-back proving npm-only repository behavior; release metadata remains a no-install workflow.
- [x] Diff is confined to the production path allowlist, with no dependency version changes.

- [x] Completed-689 seam reconciliation is recorded and independently cleared before 690 implementation; guard precedes all dependency recovery/parking without weakening lock ownership.
- [ ] Final evidence identifies one non-draft dev→main PR, zero main-only commits, native Fable Harness 4888 review of its exact final head, and user-owned main merge.
- [x] Plan remains DRAFT until coordinator verifies independent plan evidence and persists its verdict; design verification is not wish approval.

## Execution Strategy

### Wave 1 (sequential prerequisite reconciliation)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 1 | engineer | 2 — stateful installer interface +2 | engineer-standard / high | Confirm completed 689, integration SHA, and exact mutation/guard seam map. |

### Wave 2 (sequential implementation)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 2 | engineer | 3 — stateful mutation ordering +2; CI boundary +1 | engineer-standard / high | Implement guard, owned seams, frozen matrix and documentation as one coherent change. |

### Wave 3 (sequential candidate validation and review)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 3 | final-gate | 3 — independent acceptance judgment +2; CI/release +1 | engineer-standard / high | Prove integrated dev identity, clean gates, remote installation and native final-head review. |

Scores use the template rubric: +2 for orchestration/lifecycle/routing, cost/model/escalation, stateful work or subjective acceptance; +1 for multi-package, OTel-label dependency, nondeterministic test, prior rework, prompt-skill or CI/release work. Totals 0–1 route to engineer-trivial/low, 2–3 to engineer-standard/medium or high, 4–6 to engineer-complex/high, and 7+ add independent final-gate at highest justified effort. Native Fable review is mandatory regardless of score; coordinator resolves runtime routing. No sub-dispatch or Genie DB tasks are created by this planning worker.

Each wave waits for its predecessor's accepted evidence. Group 2 is intentionally atomic because the new guard rejects the tracked Bun lock and partial wiring would leave supported install paths inconsistent. All downstream receipts become stale when candidate HEAD changes.

## Execution Groups

### Group 1: Reconcile completed prerequisites and lock seams

**Goal:** Establish an executable mutation-order map against the completed 689 integration before changing production code.

**Deliverables:**
1. Coordinator evidence identifying clean existing dev baseline, full released-main/688/689 SHAs and their ancestry, completed 689 and approved independent plan review.
2. Bounded map described in Decisions: actual lock interface, all recovery/mutation paths, exact guard call sites, and proof they fit the allowlist.
3. Frozen manifest dependency/devDependency/engine/override values and full lock package resolution/integrity baseline from that integration SHA.

**Acceptance Criteria:**
- [x] No pending prerequisite SHA/interface or unreviewed scope expansion; no bootstrap replay or dirty-checkout execution.
- [x] Baseline has 688 and 689 accepted, and 689's lock tests/contract remain applicable unchanged.
- [x] Public documentation/help search finds no supported Bun installation workflow; historical internal comments alone do not introduce Bun support.

**Validation:**
```bash
set -eu
node /home/genie/.agents/skills/wish/references/design-review-evidence.mjs verify .genie/brainstorms/mikro-npm-only-toolchain/DESIGN.md
: "${NMSTX688_SHA:?coordinator must provide completed full SHA}"
: "${NMSTX689_SHA:?coordinator must provide completed full SHA}"
: "${INTEGRATION_BASE:?coordinator must provide clean integrated dev SHA}"
test "$(git rev-parse HEAD)" = "$INTEGRATION_BASE"
test -z "$(git status --porcelain)"
git merge-base --is-ancestor 35f03a1b1cc9937eee28a4cf6aa4edaabc126b23 HEAD
git merge-base --is-ancestor "$NMSTX688_SHA" HEAD
git merge-base --is-ancestor "$NMSTX689_SHA" HEAD
```
This read-only ancestry/cleanliness gate fits a reconciliation group. In addition, independent review must accept the concrete seam map and public-doc search; command success alone cannot establish the unimplemented lock API.

**depends-on:** none

### Group 2: Implement npm authority across every owned seam

**Goal:** Enforce the exact verified contract before every owned dependency mutation and prove it through real seam entry points.

**Deliverables:**
1. Guard and exact wrapper, Bun lock deletion, wiring at every listed production seam; preserve npm flags, lock coordination, and successful install/update behavior.
2. Focused `tests/npm-authority.test.ts`, clean-build-owned generated files, and directly affected documentation. Modify package lock only if necessary for exact root coherence, never dependency versions/resolutions/integrity.
3. Complete matrix evidence and full runtime gate plus real smoke. No release-workflow changes.

**Acceptance Criteria:**
- [x] Exact guard contract and all seam ordering requirements in Decisions pass, including actionable offending path/field plus npm-only remediation.
- [x] Frozen fixture matrix and coherent controls below execute every seam, with source and committed updater independently covered.
- [x] Successful recovery/serialization from 689 remains intact, while invalid authority prevents recovery and parking alike.
- [x] Dependency graph equals the Group 1 baseline; final diff is strictly allowlisted and generated output is reproducible.

#### Frozen pre-mutation matrix (verbatim from verified DESIGN)

A table-driven test creates a fresh temporary checkout for each invalid fixture and runs each owned seam (local wrapper, CI install command, installer, source updater/committed updater behavior, and launcher self-heal) with a fake `npm` first on `PATH`. Before invocation it writes a sentinel under `node_modules` and clears both the fake-npm invocation marker and `node_modules.prev`. Every case must exit nonzero with actionable guidance while the sentinel bytes remain identical, the fake-npm marker remains absent, and `node_modules.prev` remains absent. This proves rejection happened before npm launch and, for updater, before parking the existing tree.

The fixture set is frozen to:
- missing `package.json`; malformed `package.json`;
- missing `package-lock.json`; malformed `package-lock.json`;
- non-`3` `lockfileVersion`; missing/non-object `packages[""]`;
- one mismatch at a time for `name` at lock top level, `name` at root package, `version` at lock top level, `version` at root package, `dependencies`, `devDependencies`, and `engines`;
- one root file at a time for each rejected lock: `bun.lock`, `bun.lockb`, `yarn.lock`, `pnpm-lock.yaml`, `pnpm-lock.yml`, and `npm-shrinkwrap.json`.

A coherent fixture must reach fake npm exactly once per owned seam, so a test cannot pass merely because the seam never attempts installation. The existing real `scripts/smoke-install-update.sh` remains the happy-path integration proof for canonical install and updater behavior.


#### Executable fixture controls and reachability

Use the Cartesian product of **every frozen invalid fixture** with six seam adapters: local wrapper body, actual CI install command, canonical installer, source updater behavior, committed updater behavior, and launcher self-heal. Expand non-object root package cases into null/array/scalar; additionally test non-object manifest/lock JSON, missing fields versus empty objects, nested key reordering, and excluded fields/nested competing locks so the exact boundary is demonstrated. Each case uses a fresh isolated checkout, a fixed sentinel byte string, fake-npm tripwire, isolated configuration and Git state, and no real network/npm installation.

The `npm run` dispatcher itself is not the dependency-install tripwire: real npm cannot dispatch a script from missing/malformed package.json. For those fixtures, obtain the committed wrapper command from a valid control manifest before corruption and run that exact shell body in the invalid fixture. For CI, read/assert the actual workflow install command resolves to that exact wrapper, then exercise its body. Assert literal command equality so adapters cannot silently drift; also run a coherent fixture through real npm's `run deps:ci` dispatch with fake child npm first on PATH. Clearly label dispatcher bypass as a test adapter for invalid manifests, not a new supported production entry point or a raw npm guarantee.

Canonical installer fixtures must preserve corrupt candidate metadata through checkout selection (temporary Git remote or bounded fake-Git adapter) and reach the actual installer guard with a pre-existing sentinel. Updater adapters must use production reinstall/recovery behavior from source and committed output, avoiding a dirty-tree refusal or import failure as a false pass; reconcile their callable seam with 689 in Group 1. If bounded extraction is required, keep it inside the allowed `src/cli.ts` and corresponding generated output, and assert the actual update entry path calls it after target selection. Do not substitute a direct guard-only test for updater coverage.

Force launcher repair by omitting completeness markers while retaining sentinel and a harmless fixture CLI. Coherent controls permit precisely one fake **installation** invocation per seam; supply fixture dist/CLI and bounded fake build responses where a happy path also builds, recording build calls separately rather than conflating them with install. Invalid cases require no fake npm invocation of any kind. Test harness reports seam/fixture identity and ensures the guard's specific error was observed, not merely any nonzero exit.

Keep the frozen matrix's `node_modules.prev` absent initially and assert absent afterward. Add separate recovery cases with byte snapshots of pre-existing current and parked trees for incomplete-current and complete-current branches: invalid authority must leave both trees identical and must not call npm. Re-run 689 concurrency/recovery tests and add focused ordering coverage at its delivered seam without redefining its protocol. Coherent recovery controls prove these paths remain reachable.

**Validation:**
```bash
set -eu
node scripts/check-npm-authority.mjs
npm run deps:ci
npm run clean
npm run build
node --test dist/tests/npm-authority.test.js
npm run check
npm test
mkdir -p /tmp/nmstx-690-audit
production_audit_status=0
npm audit --omit=dev --audit-level=moderate --json > /tmp/nmstx-690-audit/production.json 2> /tmp/nmstx-690-audit/production.stderr || production_audit_status=$?
full_audit_status=0
npm audit --json > /tmp/nmstx-690-audit/full.json 2> /tmp/nmstx-690-audit/full.stderr || full_audit_status=$?
export production_audit_status full_audit_status
node --input-type=module -e 'import fs from "node:fs"; fs.writeFileSync("/tmp/nmstx-690-audit/exits.json", JSON.stringify({production:Number(process.env.production_audit_status),full:Number(process.env.full_audit_status)})); for (const name of ["production","full"]) {const r=JSON.parse(fs.readFileSync(`/tmp/nmstx-690-audit/${name}.json`)); if(r.error || !r.metadata?.vulnerabilities || !r.vulnerabilities) throw Error(`${name}: audit evidence unavailable`);}'
bash scripts/smoke-install-update.sh
```
Use the repository's full runtime gate because lock authority, CI, source/generated executable and every install path change. The capture commands retain nonzero npm results and reject malformed/error reports; they do not alone establish audit acceptance. Production and full audit reports and exit statuses must be collected for the immutable accepted-689 baseline and exact candidate, with commit SHA, manifest/lock hashes, Node/npm/registry context, timestamp, stdout and stderr. Audit acceptance requires exact dependency graph identity and no new or worsened advisory findings, separately for production and full reports. Compare package/version/path, advisory identifiers, severity and relevant affected range/impact metadata, not counts. Reject missing evidence and registry/auth/network errors; triage changed registry data rather than silently resetting the baseline. The two known moderate production qs@6.15.3 advisories GHSA-x5fp-wj9c-mxmx and GHSA-4mjr-xmp4-gh2g remain tracked by NMSTX-693 if fresh baseline/candidate reports confirm they are unchanged. Production npm audit still exits1 for this baseline and is not clean. Full/dev findings need their own enumerated baseline review; they are not implicitly covered by693. No npm audit fix or dependency upgrades belong to690. Record a concrete evidence-comparison command and its result in Group1 before acceptance. This defines the DESIGN's unspecified audit gate consistently with its explicit no-dependency-upgrades requirement; it supersedes the planner-added moderate/no-waivers policy, not an explicit user requirement. After normal generated files are committed by the implementation owner, repeat clean build in a clean candidate checkout and require `git diff --exit-code -- dist package.json package-lock.json`, plus no unexpected untracked generated files. Compare baseline and candidate full dependency/resolution/integrity objects, not just direct version strings. Inspect allowlist diff relative to the completed-689 base, not the released-main parent that includes 688/689 work.

**depends-on:** 1

### Group 3: Integrated dev reproducibility and final promotion gate

**Goal:** Attest the exact remote-dev candidate and its installed behavior before the user's main merge.

**Deliverables:**
1. Candidate SHA, full clean-install/build/check/test/audit/smoke logs, baseline-vs-candidate dependency graph and allowlist checks, clean-build equality report.
2. GitHub remote dev ref read before and after installation, matching Actions workflow-runs API object, installed HEAD before and after CLI read-back, resolved launcher path and version.
3. One non-draft dev→main PR and actual native Fable Harness 4888 review receipt tied to its final head, with all findings resolved or blocking; coordinator persists final evidence.

**Acceptance Criteria:**
- [ ] CI quality-gate at candidate SHA invokes the guarded install and real smoke and passes declared build/check/test gates; source build precedes compiled tests, and all required checks are green. Release workflow remains unchanged and has no added install.
- [ ] Remote `refs/heads/dev`, installed checkout HEAD, candidate SHA and matching CI workflow-runs API `.head_sha` are identical. Green CI from an older head or a PR merge pseudo-ref is insufficient.
- [ ] Existing dev includes all main commits (zero main-only commits), PR is open and non-draft with base main/head dev and exact candidate head.
- [ ] Native Fable Harness 4888 final-head review actually ran and is available for independent inspection; a generic agent review or fabricated receipt cannot substitute.
- [ ] User performs main merge; coordinator owns PR/gate operations. Any candidate change reruns affected gates and final-head evidence.

**Validation:**
```bash
set -eu
: "${CANDIDATE_SHA:?exact published dev SHA}"
: "${CI_RUN_ID:?matching completed CI workflow run}"
: "${PROMOTION_PR:?single dev-to-main PR number}"
test "$(git ls-remote https://github.com/automagik-dev/mikro.git refs/heads/dev | cut -f1)" = "$CANDIDATE_SHA"
gh api "repos/automagik-dev/mikro/actions/runs/$CI_RUN_ID" > /tmp/nmstx-690-plan/ci-run.json
node --input-type=module -e 'import fs from "node:fs"; import assert from "node:assert/strict"; const r=JSON.parse(fs.readFileSync("/tmp/nmstx-690-plan/ci-run.json")); assert.equal(r.head_sha,process.env.CANDIDATE_SHA); assert.equal(r.head_branch,"dev"); assert.equal(r.path,".github/workflows/ci.yml"); assert.equal(r.status,"completed"); assert.equal(r.conclusion,"success");'
gh pr view "$PROMOTION_PR" --json state,isDraft,baseRefName,headRefName,headRefOid > /tmp/nmstx-690-plan/pr.json
node --input-type=module -e 'import fs from "node:fs"; import assert from "node:assert/strict"; const p=JSON.parse(fs.readFileSync("/tmp/nmstx-690-plan/pr.json")); assert.equal(p.state,"OPEN"); assert.equal(p.isDraft,false); assert.equal(p.baseRefName,"main"); assert.equal(p.headRefName,"dev"); assert.equal(p.headRefOid,process.env.CANDIDATE_SHA);'
```
Export receipt variables before running Node assertions. Coordinator executes the remote installation in a dedicated temporary prefix using `MIKRO_REPO_URL=https://github.com/automagik-dev/mikro.git MIKRO_BRANCH=dev MIKRO_INSTALL_DIR=<absolute-test-prefix>/checkout MIKRO_BIN_DIR=<absolute-test-prefix>/bin bash scripts/install.sh` from the exact candidate checkout. Disable fallback by setting `MIKRO_FALLBACK_REPO_URL` to the same canonical URL. Record selected remote URL and candidate ref before invocation; after install assert `git -C <prefix>/checkout rev-parse HEAD` equals candidate, run `<prefix>/bin/mikro --version`, resolve symlink target, run the installed guard, compare manifest version, verify clean installed state and generated equality, and assert installed HEAD and live remote dev again. Resolve `<absolute-test-prefix>` concretely before execution and retain its receipt; do not replace the user's installed main baseline during planning. Do not use `mikro update` as dev read-back: current update targets main; real canonical/update happy paths are proven by the smoke's controlled main remote.

Coordinator refreshes exact main/dev remote refs and requires `git rev-list --count <dev-sha>..<main-sha>` to equal zero, plus exact PR head. Collect required status-check evidence and native Fable Harness 4888 run identity, input head and verdict via its actual installed interface (discover it; no invented command). Absence of that runtime/receipt blocks the final gate. These remote/PR/native-review assertions supplement, never replace, Group 2's full gate rerun on the integrated candidate. No production release workflow edits are authorized.

**depends-on:** 2

---

## QA Criteria

- [ ] Every invalid fixture rejects before installation, parking, restoration or deletion; coherent fixtures install exactly once at every owned seam.
- [ ] 689 lock serialization and recovery tests remain green, and new authority checks run before its dependency mutations.
- [ ] Wrapped clean install, typecheck, clean build, full tests, real install/update smoke and generated equality pass on integrated dev; production/full audit evidence is captured and passes the explicit comparison policy, with nonzero baseline findings reported.
- [ ] README local command uses the wrapper; raw local npm is explicitly outside the guarantee, and consumer git-dependency installation remains supported with an honest consumer-owned boundary.
- [ ] Remote dev, CI API head and installed HEAD match exactly before/after read-back; final PR/native review evidence is fresh and user main merge remains pending.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| 689 shared lock interface is not implemented/verified yet | High | Mandatory bounded Group 1 reconciliation after completion; scope amendment/review if frozen allowlist is insufficient. |
| Guard is inserted after lock-triggered recovery | High | Map every mutation and test pre-existing parked/current trees separately from frozen matrix. |
| Invalid fixtures pass due to dispatcher/import/dirty-check failures | High | Exact-command adapters, specific guard errors and coherent controls at all six seams. |
| Concurrent implementation writes contaminate evidence | High | Planning changes only this new WISH; full gates run only after clean approved prerequisite integration. |
| CI or remote branch moves during evidence collection | High | Read live ref before/after; bind all receipts to exact SHA; rerun on movement. |
| New audit finding requires a dependency change | High | Block and escalate separately; do not weaken audit or violate no-version-change scope. |
| Clean build changes files outside allowlist | Medium | Identify cause, preserve clean generated equality and stop for reconciliation rather than hand-edit generated code. |
| Native Fable Harness 4888 unavailable | High | Final gate remains blocked until actual native final-head review runs. |

---

## Review Results

**FIX-FIRST — amended audit policy awaits independent review.** Initial independent plan review at 2026-09-07T20:00:48Z bound SHA256 320634757cc68b72ada2a01ba0a7f84f3a118cc9ca44251f5ae78828bb5d7e06 and returned SHIP. Audit addendum at 20:03:39Z superseded that acceptance with FIX-FIRST for the planner-added policy that rejected the unchanged baseline. Coordinator applied its bounded recommendation; the previous digest does not approve these amended bytes. Evidence: /tmp/nmstx-690-plan/independent-review.md, /tmp/nmstx-690-plan/audit-addendum.md and /tmp/nmstx-690-plan/amended-review.md. The 20:18 amended review returned FIX-FIRST for incomplete comparator schema/provenance and missing legacy rename ordering; coordinator corrected those requirements, with independent re-review still pending. Design verifier exited0; no amended wish approval is asserted here. Coordinator must verify the independent review artifact and persist its verdict before implementation; completed 689 and cleared reconciliation are separate required gates. Planning worker does not create Genie DB tasks, record a wave base, invoke implementation, modify Linear or self-approve.


### Corrected plan acceptance — 2026-09-07T20:30:13.650854Z

**SHIP; coordinator persisted APPROVED.** Independent reviewer task `task_440985377d94`, dispatch `ctx_e7c10894794d`, reviewed exact pre-persistence WISH SHA256 `1c44cfff769652e33d9ea93c4d4e66fb4608cbe3bf8c0a1924c1c7ba53d801f0` and comparator SHA256 `8e8b84e6bc0af669e48e8e4d7a2058abf837b45a46904110ff1290aab07bae69`. Report `/tmp/nmstx-690-plan/corrected-review.md` supersedes the pending corrected-plan verdict above. Prior schema/provenance and legacy-rename findings are resolved; positive and all ten negative/removal comparator controls, scoped wish lint, design verifier and syntax checks passed. This persistence changes status and records the verdict only; it does not claim the reviewer reviewed this appended receipt.

Accepted-689 immutable source and tests remain a separate execution prerequisite. Reviewed provisional hashes: install-state `36d843485509f4209883ac481fee2334a37f0f3f2346d77533c0d8eac4a4a69c`; launcher `00dfac07ec4e0209967bc4c29f96b7a96fb5dc98c9d39c4051b582215be062a9`; installer `dcf734c82d7b6677c978179c25dee36e0cf8ba91c608fb6d3f26dc2af1e18ad7`; source CLI `04a2fd8802ba019b740318063b65b9060363d6b038c03e146165d53fa2a9cc87`; generated CLI `8aba19d50e8622096c91872d26305bca88d5ea57868c8a3b82fa95de71502ec6`. Compare accepted commit bytes and inspect differences before Group 1 clears. Native Fable final-head approval is still required; this is plan approval only.

---

## Files to Create/Modify

Production/documentation allowlist is frozen to the following verified DESIGN text:

Only these production/documentation seams may change for this child wish:

- `package.json`, `package-lock.json`, and deletion of `bun.lock`;
- new `scripts/check-npm-authority.mjs`;
- `.github/workflows/ci.yml`;
- `scripts/install.sh` and `scripts/smoke-install-update.sh`;
- `bin/mikro.mjs`;
- `src/cli.ts` and its build-owned `dist/src/cli.js` (plus only the corresponding generated map/declaration files if a clean build changes them);
- focused `tests/npm-authority.test.ts` and only its clean-build-owned files under `dist/tests/`;
- directly affected `README.md` and `docs/release-contract.md`.

No `.github/workflows/release.yml` edit is needed or allowed by this design. Generated files may change only when reproduced by the normal clean build and must equal the committed output.


Planning-only artifact: `.genie/wishes/mikro-npm-only-toolchain/WISH.md`; planner report/check artifacts: `/tmp/nmstx-690-plan/`. No other lifecycle document is changed. Build output belongs only to a clean normal build of the listed source/test files; the concurrent 688 worker's Python source/tests/output remain exclusively theirs.


### Immutable 689 seam readback — 2026-09-07

Committed689 is `0eb3b7307a582a45040f5a35706feadee0ee0fb2`, descended from688 `3e709222ee361ea43bcee597179c74aa84aabb35` and releasedmain35f03a1. Coordinator compared immutable git-show bytes to corrected-review.md: common module, launcher, source CLI and generated CLI exactly match all reviewed hashes. Installer SHA256 is now `93cd50f870800de42bbc7c121a70787ab8fbc6075bdcd4c9ea623d2d3085af1b`; its only post-review source addition is an early default-prefix/legacy-only refusal, before destination creation, emitting explicit manual migration guidance and leaving both trees/symlinks unchanged. Coordinator inspected that18-line addition. It adds no dependency mutation, lock or recovery path; the reviewed690 guard locations and custom-prefix migration correction still apply. Preserve this refusal/fixture in690; automatic default-prefix legacy migration is separately tracked as NMSTX-694 and is not claimed preserved.

689's final14 focused fixtures and real install/update smokes pass on Node22/26. Node22 final full918/918 passes. Initial final Node26 fails only the recurring Prime250ms PID startup fixture; one repeat918/918 passes but does not close that reliability defect. Aggregate689 acceptance and clean690 integration baseline still wait for task `task_67ff0031ecf1` to repair that existing test and produce final green full gates. No690 implementation or accepted baseline is asserted by this immutable source readback alone.


### Prerequisite acceptance and execution handoff — 2026-09-07T20:59Z

Coordinator accepted688 `3e709222ee361ea43bcee597179c74aa84aabb35`,689 `0eb3b7307a582a45040f5a35706feadee0ee0fb2`, and tests-only Prime repair `4ce97a689a3a6792ae703a5c4f25e7b2ba3a35c6`. Final Prime source/generated hashes match its report; focused39/39 and full918/918 default-concurrency suites, build and typecheck pass on Node22.19.0/npm10.9.3 and Node26.7.0/npm11.19.0 after the last code change. A750ms fixture-only startup delay reproduces the old ENOENT and passes the repaired test on both. Reports: /tmp/nmstx-688-evidence/report.md, /tmp/nmstx-689-evidence/report.md and /tmp/mikro-prime-deadline-evidence/report.md. All initial failures remain retained; retries are not substituted for the deterministic repair.

The immutable689 seam gate above is cleared with its explicitly inspected early-refusal delta. Actual fetchedmain35f03a1 is an ancestor; source/dependency/generated state is clean. Coordinator commits this approved plan/acceptance record, fast-forwards existing dev to that integration, and pins the full resulting INTEGRATION_BASE in the Orca implementation task and owner evidence. The execution checkout is a clean Orca child to preserve unrelated primary-checkout runtime databases; those files are never cleaned or staged. No source writer remains in the primary checkout. This lifecycle transition authorizes only the previously reviewed690 scope. Final native Fable review, remote candidate CI/install identity and user main merge gate remain open.


## Aggregate Daily review corrections — 2026-09-07

Native Claude Fable (`claude-fable-5-1`, session `1fe0603d-b98f-4ee0-9903-334ee68a4944`) reviewed baseline `578d047a36c8a29e3622f9c32f4680636b3fc390` against released main `35f03a1b1cc9937eee28a4cf6aa4edaabc126b23` through Sofia Harness port4888, room session `01a07db7-9e05-7670-bd85-54c8cf27f78c`. Baseline verdict is FIX-FIRST, not aggregate acceptance.

The coordinator routed two bounded NMSTX-689 correctness repairs to the existing sole engineer in the690 child. They are separate689 fixes included in this aggregate Daily; the frozen npm-authority design and dependency graph remain unchanged:

- Canonicalize both helper entry paths so Mac `/tmp` and `/var` directory aliases execute the helper instead of silently returning success. Preserve inert import/eval/stdin behavior; regression must execute the actual installer through a directory symlink. Separate fix commit `3ab044830ee47fdfa9207dafccd2707b9afa66d3` awaits integration and final review.
- Separate CLI startup readiness from long-lived ACP/query execution. Retain mutex ownership through actual asynchronous preparation and all dependency mutations, then release for ordinary command work. Relevant `src/cli.ts`, generated CLI output, and install-coordination regression coverage are explicitly in this689 correction scope. Require real ACP initialize plus concurrent version/MCP initialization while ACP stays alive, alongside the existing delayed-startup exclusion fixture. Final Fable review must assess other command paths as well.

These repairs do not authorize a second lock protocol, dependency upgrades, release workflow changes, or mutations of the installed user prefix. Earlier pre-fix full-suite and smoke passes are retained as historical evidence and cannot substitute for final combined-byte gates. Final all-files/all-commits Fable SHIP on the immutable promotion head remains mandatory.

Reviewer-assessed nonblocking follow-ups: NMSTX-696 fixed Mac TCP coordination-port conflict; NMSTX-697 pre-mutation installer fetch failure creating unnecessary recovery; NMSTX-694 coordinated automatic legacy-only migration; NMSTX-693 existing dependency advisories. Known limitations must be disclosed in the final PR; tracking alone is not the reason for nonblocking classification.


Clean-build correction: deleting `dist` before TypeScript compilation recreates `dist/src/cli.js` with mode0644 instead of the tracked0755, inherited from released main; the content is identical. The coordinator authorized deterministic executable-mode restoration in the normal `package.json` build script, preserving the CLI contract. Validate clean/build/generated equality and real install/update smoke on Node22/26 after that script-only change. Prior full-suite passes may be bound by exact equality of all production, test and generated contents, with the manifest build-script delta stated explicitly; final integrated-dev CI still reruns the full suite at its exact head. Candidate audit provenance must be refreshed for the changed manifest/SHA. Never mask mode differences through Git configuration or manual post-test restoration.


## Implementation evidence accepted for integration

Implementation candidate `2c48f5cf48c05c84ea1d42cd4cec6cffea332099` follows npm-authority commit `25d1eb229b7aaf0cc4595a365804506b3a40b3a7`, F2 correction `c5eb9dec5fb9e8b277b44f703213580ecf4ccee7`, and F1 correction `3ab044830ee47fdfa9207dafccd2707b9afa66d3`. Both Node22.19.0 and26.7.0 passed235 focused and1139 full tests, wrapped installation, build, typecheck and real install/update smoke. The final script-only mode correction passed clean/build/generated equality and real smoke on both runtimes. Root independently verified1514 tested tracked-file hashes and that the only subsequent delta is the build-script chmod; all production/test/generated contents are unchanged.

Evidence on the execution host: `/tmp/nmstx-690-implementation/report.md`, `final-node22/receipt.json`, `final-node26/receipt.json`, `mode-corrected-node22/receipt.json`, `mode-corrected-node26/receipt.json`, `node26-immutable-mapping.json`, and `mode-fix-content-identity.json`. Root verification: `/home/genie/workspace/tmp/mikro-daily-688-690/root-content-verification.json`.

The reviewed comparator was independently rerun against baseline578d047 and final2c48f5c using fresh `base-audit/` and `final-candidate-audit/` receipts: unchanged graph, no new/changed findings, only the two existing qs advisories in each inventory; both raw audits still exit1. The dependency lock is byte-identical to baseline. This accepts implementation evidence only. Integrated-dev exact-head CI, dedicated remote-dev install identity, final all-head native Fable review and the single non-draft promotion PR remain open gates recorded by the coordinator outside the immutable implementation handoff.
