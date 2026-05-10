# Wish: Collapse release pipeline into single workflow_call chain

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `release-pipeline-collapse` |
| **Date** | 2026-05-10 |
| **Author** | Genie (council-1778388062 synthesis) |
| **Appetite** | medium |
| **Branch** | `wish/release-pipeline-collapse` |
| **Repos touched** | automagik-dev/genie |
| **Design** | _No brainstorm — direct wish_ |

## Summary

Collapse the three-workflow release chain (`build-tarballs.yml` → `sign-attest.yml` → `release-publish.yml`, currently linked by broken `workflow_run` triggers) into a single `release.yml` whose jobs sequence with `needs:`. This eliminates the GITHUB_TOKEN anti-recursion guard that has prevented the chain from ever firing end-to-end since the cutover, without introducing any PAT or GitHub App token. The cosign cert-identity regex stays pinned to one file path forever, so no end-user verifier breaks.

## Scope

### IN

- Extend `release.yml` (which already does build → sign → attest → publish in one workflow run) to consume the per-platform tarball matrix from `build-tarballs.yml`'s logic.
- Delete `sign-attest.yml` and `release-publish.yml` as standalone files; their content becomes jobs inside `release.yml`.
- Update `version.yml`'s `Trigger Build Tarballs` step (#1738) to dispatch `release.yml` instead of `build-tarballs.yml`. The dispatch step name + comment block are updated to reflect the new "dispatch entire release pipeline" framing.
- Audit and update branch-protection required-status-check names — workflow names change from standalone runs to nested job runs (`release / sign (linux-x64-glibc)`), required checks must be re-pointed in the same maintenance window.
- Remove `pull_request` trigger from any release-only job in `release.yml`. PR validation stays in `ci.yml`. Add `if: github.event_name != 'pull_request'` gates on every job that holds OIDC/cosign/attestation write scopes as defense-in-depth.
- Set `concurrency.cancel-in-progress: false` on `release.yml`. Cancelling a partially-published release is the exact "stranded artifacts" failure we're escaping.
- Keep `workflow_dispatch` trigger on `release.yml` with `version` + `run-id` inputs as the manual-recovery escape hatch (operator + architect P1 requirement).
- Document v4.260510.5 abandonment in `CHANGELOG.md` (one-line gap entry). `.well-known/latest.json` advances v4.260510.4 → v4.260510.6 on first chain firing.
- Ship runbook at `docs/_internal/runbooks/release-pipeline.md` (under 200 words, tested by someone who wasn't in this thread). Operator P0 hard requirement.
- Ship alert: `v*` tag pushed but no `release.yml` reaches the `publish` job within 30 min — "tag X is orphaned, here is the runbook link."
- Test the manual-recovery rollback path before next release (rollback test = run `gh workflow run release.yml --ref refs/tags/v<version>` in dry-run mode and confirm it picks up cleanly).

### OUT

- **No PAT, no GitHub App token.** Felipe's hard constraint: `WE DIDNT HAVE ONE BEFORE, WE WONT HAVE ONE NOW`. Any solution requiring credential beyond GITHUB_TOKEN is out of scope.
- **No retroactive rescue of v4.260510.5's stranded build artifacts.** Run 25619912030's tarballs are abandoned; v4.260510.5 is documented as a numbering gap. Do NOT design rescue plumbing into the new architecture for a one-off corpse.
- **No SLSA generator decoupling.** The `slsa-framework/slsa-github-generator/.../generator_generic_slsa3.yml@v2.1.0` reusable workflow stays as-is; `contents: write` permission grant from #1740 transfers to the new chain unchanged.
- **No cosign step relocation.** The cosign step stays in its current file (`release.yml`) so the OIDC SAN URI stays bound to `release.yml@<ref>` and zero verifier-side changes are needed.
- **No new functionality.** Build matrix, signing, attestation, verification, and publish behavior are all unchanged — only the trigger architecture and file boundaries change.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | **Option A (collapse to single workflow), not Option B (orchestrator + workflow_call reusable files)** | Council 3-1 toward A. Cosign cert-identity migration risk dominates: Option B forces SAN URI rename → coordinated cutover across `scripts/verify-release.sh`, `docs/security/`, Mintlify pages, postinstall verifier. Option A keeps cosign step in `release.yml` so SAN URI is unchanged. Architect's only Option B argument (per-file `workflow_dispatch` rescue hatch) is resolved by abandoning v4.260510.5 — the rescue path no longer matters. |
| 2 | **Abandon v4.260510.5; ship v4.260510.6 through new pipeline** | Build run 25619912030's tarballs are stranded (signed and attested by neither the old nor new pipeline). Retrofitting cross-run artifact pickup adds plumbing the new pipeline doesn't otherwise need (deployer R2). Document gap in `CHANGELOG.md`. |
| 3 | **Atomic cutover: workflow file changes + branch-protection updates + version.yml dispatch update + runbook + alert ship in ONE PR** | Operator's hard rule: runbook+alert+rollback test in same PR or "follow-up that never happens." Branch-protection required-check name changes silently break PRs if not coordinated (architect R2). |
| 4 | **`workflow_dispatch` trigger remains on `release.yml`** | Operator + architect P1: manual-recovery escape hatch. Inputs accept `version` (string) and optionally `run-id` (string) for cross-run artifact pickup IF that case ever arises post-cutover. The trigger is the unhappy-path break-glass; the orchestrator's tag-driven path is the happy path. Both must exist day one. |
| 5 | **`concurrency.cancel-in-progress: false` on `release.yml`** | Cancelling a partially-published release leaves the exact stranded-artifact state we're escaping. Build PR validation in `ci.yml` may keep `cancel-in-progress: true` (different workflow, no signing scope). |
| 6 | **`pull_request` trigger removed from `release.yml`** | Leaks OIDC + signing capability to PR authors otherwise. PR-time tarball build smoke test moves to `ci.yml` with no signing/attestation. Defense in depth: also add `if: github.event_name != 'pull_request'` on every release-only job. |
| 7 | **Permissions explicitly declared at every release-only job; `secrets: inherit` not applicable since reusable workflows are eliminated** | Option A removes the `workflow_call` foot-guns architect listed (caller-must-declare permissions, secrets don't auto-inherit). Each job in `release.yml` declares its own `permissions:` block exactly matching what the step needs (`id-token: write`, `attestations: write`, `contents: write` for SLSA reusable). |

## Success Criteria

- [ ] `release.yml` is the only workflow file that build-signs-attests-publishes a release.
- [ ] `sign-attest.yml` and `release-publish.yml` are deleted from the repo.
- [ ] `version.yml`'s dispatch step targets `release.yml` (verified via `grep`).
- [ ] On the next dev push after merge, version.yml bumps to v4.260510.6, dispatches `release.yml`, and within 15 minutes a GitHub Release v4.260510.6 exists with all 4 platform tarballs + signatures + attestations.
- [ ] `.well-known/latest.json` is committed to main pointing at v4.260510.6.
- [ ] `cosign verify-blob` against v4.260510.6 tarballs passes using the EXISTING `release.yml@`-pinned regex (no end-user verifier change).
- [ ] `scripts/verify-release.sh` (line 23 regex) requires no edit — proves cosign cert-identity is unchanged.
- [ ] Branch-protection required-status-checks list contains the new nested job names (`release / sign (linux-x64-glibc)` etc.) and not the old standalone names.
- [ ] `CHANGELOG.md` documents v4.260510.5 abandonment (one-line entry).
- [ ] `docs/_internal/runbooks/release-pipeline.md` exists, is under 200 words, and was reviewed by someone outside this thread.
- [ ] Alert configured: `v*` tag + no `release.yml` reaches `publish` job within 30 min → notify + link to runbook.
- [ ] Manual-recovery dry-run: `gh workflow run release.yml --ref refs/tags/v4.260510.6` (after natural firing already produced the release) is idempotent or correctly skipped — does NOT republish.

## Execution Strategy

### Wave 1 (sequential, single PR)

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Collapse `build-tarballs.yml` matrix into `release.yml` as a `build` job; keep `sign`, `attest`, `verify`, `publish` jobs and chain via `needs:`. |
| 2 | engineer | Delete `sign-attest.yml` + `release-publish.yml`; update `version.yml`'s dispatch target to `release.yml`; remove `pull_request` from release.yml + add per-job pull_request gates; flip concurrency.cancel-in-progress to false. |
| 3 | engineer | Branch-protection required-status-check audit: list current required check names + new nested names, document the cutover in PR description, update via API in same merge window. |
| 4 | engineer | Operations bundle: write `docs/_internal/runbooks/release-pipeline.md`; configure tag-orphan alert; document rollback dry-run procedure. |
| 5 | engineer | `CHANGELOG.md` v4.260510.5 abandonment entry. |

The wish is single-wave because the collapse must be atomic — every change ships in one PR (Decision #3) to avoid the silent branch-protection break + the half-collapsed pipeline failure modes. There's no parallelism to extract since every group touches `release.yml` or its dependencies.

## Execution Groups

### Group 1: Collapse build matrix into release.yml

**Goal:** Make `release.yml` produce per-platform tarballs as a top-level job, replacing what `build-tarballs.yml` does today.

**Deliverables:**
1. New `build` job in `release.yml` with the same 4-platform matrix from `build-tarballs.yml` (linux-x64-glibc, linux-x64-musl, linux-arm64, darwin-arm64).
2. Tarball naming contract preserved: `genie-${VERSION}-<platform>.tar.gz` (Decision 10 of genie-distribution-cutover).
3. `bun build --compile` per-platform binary toolchain, `bun install --frozen-lockfile` step, identical artifact upload via `actions/upload-artifact@v4` with name `genie-${VERSION}-<platform>-tarball`.
4. Existing `sign` / `attest` / `verify` / `publish` jobs in `release.yml` updated to declare `needs: [build]` (or chained), pulling tarballs via `actions/download-artifact@v4` from the SAME run (no run-id parameter needed for the happy path).
5. SLSA generator reusable workflow call's `contents: write` grant from #1740 carries over unchanged.

**Acceptance Criteria:**
- [ ] `release.yml` defines a `build` job with the 4-platform matrix.
- [ ] All 4 jobs (`build`, `sign`, `attest`/SLSA, `publish`) wired via `needs:` in correct order.
- [ ] No `actions/download-artifact@v4` step references `run-id` or `github-token` for the happy path (only the dispatch escape-hatch path).
- [ ] Cosign step still lives in `release.yml` (verified via `grep -l "sigstore/cosign-installer"`).
- [ ] `workflow_dispatch` trigger keeps `version` + `run-id` inputs for the unhappy-path break-glass.

**Validation:**
```bash
yamllint .github/workflows/release.yml
test "$(yq '.jobs | keys | length' .github/workflows/release.yml)" -ge 4
yq '.jobs.build.strategy.matrix.platform | length' .github/workflows/release.yml | grep -q '^4$'
grep -q 'sigstore/cosign-installer' .github/workflows/release.yml
grep -q 'workflow_dispatch:' .github/workflows/release.yml
```

**depends-on:** none

---

### Group 2: Delete obsolete workflows + rewire version.yml dispatch

**Goal:** Remove `sign-attest.yml` and `release-publish.yml`, point version.yml's dispatch step at `release.yml`, and remove pull_request triggers from the release path.

**Deliverables:**
1. Delete `.github/workflows/sign-attest.yml`.
2. Delete `.github/workflows/release-publish.yml`.
3. Update `version.yml:175-189` (the `Trigger Build Tarballs for the new tag` step from #1738) to call `gh workflow run release.yml --ref refs/tags/v${VERSION}` instead of `build-tarballs.yml`. Update the step name to `Trigger release pipeline for the new tag` and the comment block to reflect the new framing.
4. Remove `on.pull_request:` from `release.yml` if currently present.
5. Add `if: github.event_name != 'pull_request'` defense-in-depth gates on every release.yml job that holds `id-token: write`, `contents: write`, or `attestations: write` (defense in depth even though pull_request is removed).
6. Set `concurrency.cancel-in-progress: false` on `release.yml`.
7. Keep `build-tarballs.yml` ONLY if its current `pull_request` trigger is the source of PR-time tarball build smoke tests. Otherwise delete it too. Move PR-time tarball build smoke test to `ci.yml` if it provides value — DECIDE during Group 2.

**Acceptance Criteria:**
- [ ] `.github/workflows/sign-attest.yml` does not exist (`test ! -f .github/workflows/sign-attest.yml`).
- [ ] `.github/workflows/release-publish.yml` does not exist.
- [ ] `version.yml`'s dispatch step targets `release.yml` (`grep -q 'gh workflow run release.yml' .github/workflows/version.yml`).
- [ ] `release.yml` has no `on.pull_request:` block at workflow level.
- [ ] Every job in `release.yml` with `id-token: write` also has the `if: github.event_name != 'pull_request'` defense-in-depth gate.
- [ ] `release.yml` declares `concurrency.cancel-in-progress: false`.
- [ ] No remaining `workflow_run:` trigger anywhere in `.github/workflows/`.

**Validation:**
```bash
test ! -f .github/workflows/sign-attest.yml
test ! -f .github/workflows/release-publish.yml
grep -q 'gh workflow run release.yml' .github/workflows/version.yml
! grep -q 'on:.*pull_request' .github/workflows/release.yml || echo "WARN: review release.yml for pull_request trigger"
grep -q 'cancel-in-progress: false' .github/workflows/release.yml
! grep -rn 'workflow_run:' .github/workflows/ --include='*.yml'
```

**depends-on:** Group 1

---

### Group 3: Branch protection required-check audit + update

**Goal:** Re-point branch-protection required-status-checks from the obsolete standalone workflow names to the new nested job names. Avoid silent PR-merge breakage (architect R2 P1).

**Deliverables:**
1. Inventory current required-status-check names on `main` and `dev` via `gh api /repos/automagik-dev/genie/branches/{main,dev}/protection`.
2. Document the rename map in PR description: `Sign + Attest Tarballs` → does not exist post-merge; `release / sign (linux-x64-glibc)` → required; etc.
3. Apply branch-protection update via `gh api PUT` in the same PR's merge window. The update can be applied immediately AFTER the merge lands, but the PR description must contain the exact `gh` command sequence so on-call can run it.
4. If there are required checks that the new pipeline fundamentally cannot satisfy (e.g., a check that ran on `pull_request` but the new job is gated by `if: github.event_name != 'pull_request'`), explicitly remove them from required and document why in PR description.

**Acceptance Criteria:**
- [ ] PR description contains a "Branch Protection Cutover" section listing OLD required check names → NEW required check names.
- [ ] PR description contains the exact `gh api PUT /repos/.../branches/{main,dev}/protection` JSON body that updates required checks.
- [ ] Post-merge, branch protection on `main` does not contain any reference to the deleted workflow names.
- [ ] Branch protection on `dev` is similarly updated.

**Validation:**
```bash
# Run on the open PR before merge — verifies the cutover plan is documented:
gh pr view <PR#> --json body -q .body | grep -qi "branch protection cutover"
# Run post-merge — verifies cutover happened:
gh api /repos/automagik-dev/genie/branches/main/protection \
  --jq '.required_status_checks.contexts[]' \
  | grep -v 'Sign + Attest Tarballs' \
  | grep -v 'Release Publish'
```

**depends-on:** Group 2

---

### Group 4: Operations bundle — runbook, alert, rollback test

**Goal:** Ship the runbook + alert + tested rollback path in the same PR (operator P0 hard rule).

**Deliverables:**
1. `docs/_internal/runbooks/release-pipeline.md` — under 200 words, tested by someone outside this thread (you can ask Felipe for review or use a /qa agent), structured as: "version.yml dispatched a build → check the release.yml run for version vX.Y.Z → if it failed at job N, here is how to re-dispatch via `gh workflow run release.yml --ref refs/tags/v<version>`."
2. Tag-orphan alert — preferred mechanism: a scheduled GitHub Actions workflow `release-orphan-alert.yml` running every 30 min that checks `gh api /repos/.../tags` against `gh api /repos/.../releases`, and opens a GitHub Issue (label `release-incident`) when a `v*` tag exists with no corresponding Release object older than 30 min. Issue body links to the runbook. (Alternative: external monitoring — out of scope for this wish.)
3. Rollback dry-run test plan documented in PR description: confirms `gh workflow run release.yml --ref refs/tags/v4.260510.6` (after natural firing already created the release) is either idempotent or correctly errors with "release already exists" — does NOT silently republish or duplicate.

**Acceptance Criteria:**
- [ ] `docs/_internal/runbooks/release-pipeline.md` exists, is under 200 words (`wc -w` ≤ 200).
- [ ] `release-orphan-alert.yml` exists and runs on `schedule: cron: '*/30 * * * *'`.
- [ ] PR description contains a "Rollback Dry-Run" section with the exact reproducer command + expected behavior.
- [ ] At least one external reviewer (not Genie, not Felipe) confirms the runbook is comprehensible.

**Validation:**
```bash
test -f docs/_internal/runbooks/release-pipeline.md
test "$(wc -w < docs/_internal/runbooks/release-pipeline.md)" -le 200
test -f .github/workflows/release-orphan-alert.yml
grep -q "schedule:" .github/workflows/release-orphan-alert.yml
grep -q "cron:" .github/workflows/release-orphan-alert.yml
```

**depends-on:** Group 2

---

### Group 5: CHANGELOG v4.260510.5 abandonment entry

**Goal:** Document the version gap so future readers understand why v4.260510.5 has no GitHub Release, no signed tarballs, and no `.well-known/latest.json` advancement.

**Deliverables:**
1. One-line entry in `CHANGELOG.md` at the top of the unreleased section: `- **v4.260510.5 (skipped):** build artifacts existed (run 25619912030) but never received a signed release due to GITHUB_TOKEN workflow_run anti-recursion blocker; superseded by v4.260510.6 via the collapsed release.yml pipeline (this wish).`

**Acceptance Criteria:**
- [ ] `CHANGELOG.md` contains the v4.260510.5 abandonment entry.
- [ ] Entry references the diagnostic run ID 25619912030 for traceability.

**Validation:**
```bash
grep -q '4.260510.5' CHANGELOG.md
grep -q '25619912030' CHANGELOG.md
```

**depends-on:** none (independent)

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] **Functional:** First dev push after merge bumps to v4.260510.6, dispatches `release.yml`, and within 15 minutes produces a GitHub Release v4.260510.6 with 4 platform tarballs + signatures.
- [ ] **Integration:** `.well-known/latest.json` is committed to main with `version: 4.260510.6` and correct asset URLs.
- [ ] **Verifier compatibility:** `scripts/verify-release.sh` (untouched in this wish) successfully verifies v4.260510.6 tarballs end-to-end. This proves the cosign cert-identity regex still matches.
- [ ] **Regression:** `cosign verify-blob` against the most recent PRE-cutover signed release (v4.260509.2 from 2026-05-09) still succeeds — backward verifier compatibility preserved.
- [ ] **Branch protection:** opening a fresh PR against `dev` does not block on missing required-status-checks named `Sign + Attest Tarballs` or `Release Publish`.
- [ ] **Manual recovery:** `gh workflow run release.yml --ref refs/tags/v4.260510.6` after the natural firing produces a clear "release already exists" error or is silently idempotent — never duplicates.
- [ ] **Concurrency:** if a second dev push lands while v4.260510.6's `release.yml` run is mid-pipeline, the second run does NOT cancel the first (cancel-in-progress: false verification).

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Branch-protection cutover causes silent PR-merge breakage if not coordinated with workflow file changes | High | Group 3 requires the cutover plan in PR description + post-merge `gh api PUT` runs in the same maintenance window. PR description gets a CHECKLIST item: "Branch protection updated post-merge." |
| `release.yml` already exists with current build/sign/attest/publish chain — extending it may surface latent bugs in untested code paths | Medium | Group 1 acceptance criteria includes regression checks. The existing `release.yml` has been signing releases successfully through 2026-05-09 (v4.260509.2 was the last one); extension should be additive (add `build` job + matrix), not rewriting the working sign/attest/publish logic. |
| SLSA generator reusable workflow `contents: write` grant from #1740 doesn't transfer cleanly if the calling job restructures | Medium | Carry the entire #1740 reviewer-grade comment block forward to the new caller location. Verify by re-running `cosign verify-blob` on a test artifact post-cutover. |
| v4.260510.5 abandonment is permanent — once .well-known/latest.json advances to v4.260510.6, any operator who ran `genie update` between v4.260510.4 and v4.260510.6 has no upgrade path | Low | This is the cost of abandoning v4.260510.5. CHANGELOG entry documents the gap. genie update is supposed to skip non-existent versions cleanly. Verify via QA: test `genie update` against the gapped CDN. |
| Council was 3-1 toward Option A; architect's Option B preference (preserved per-file workflow_dispatch) was contingent on rescuing v4.260510.5 — abandoning it removes the dissent | Low | Decision #2 (abandon v4.260510.5) is the load-bearing call. If user/Felipe overrides and demands rescue, this entire wish is blocked and Option B is reopened. |
| `if: github.event_name != 'pull_request'` defense-in-depth gates may interfere with manual `workflow_dispatch` recovery | Low | The gate as written excludes `pull_request` only — `workflow_dispatch` is allowed. Verify in Group 2 by running the dispatch recovery dry-run. |

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
# Modified
.github/workflows/release.yml         (Group 1: add build matrix; Group 2: remove pull_request trigger, add per-job gates, flip cancel-in-progress)
.github/workflows/version.yml         (Group 2: dispatch target rename build-tarballs.yml → release.yml)
CHANGELOG.md                          (Group 5: v4.260510.5 abandonment entry)

# Created
docs/_internal/runbooks/release-pipeline.md  (Group 4: <200 word runbook)
.github/workflows/release-orphan-alert.yml   (Group 4: scheduled tag-orphan check)

# Deleted
.github/workflows/sign-attest.yml     (Group 2: collapsed into release.yml)
.github/workflows/release-publish.yml (Group 2: collapsed into release.yml)
.github/workflows/build-tarballs.yml  (Group 2: collapsed into release.yml IF its pull_request smoke test moves to ci.yml; otherwise kept slim)

# Branch-protection (out-of-tree, applied via gh api in same merge window)
gh api PUT /repos/automagik-dev/genie/branches/{main,dev}/protection  (Group 3)
```
