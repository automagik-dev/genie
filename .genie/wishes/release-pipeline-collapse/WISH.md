# Wish: Release pipeline → workflow_call orchestrator (Option B)

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `release-pipeline-collapse` |
| **Date** | 2026-05-10 |
| **Author** | Genie (council-1778388062 + reviewer FIX-FIRST loop 1) |
| **Appetite** | medium |
| **Branch** | `wish/release-pipeline-collapse` |
| **Repos touched** | automagik-dev/genie |
| **Design** | _No brainstorm — direct wish_ |

## Summary

Replace the broken `workflow_run`-chained release pipeline (build-tarballs.yml → sign-attest.yml → release-publish.yml, suppressed by the GITHUB_TOKEN anti-recursion guard) with a `workflow_call`-orchestrated chain. A new orchestrator file (the existing `release.yml`, repurposed after deleting its decommissioned npm-pack jobs) calls `build-tarballs.yml`, `sign-attest.yml`, `release-publish.yml` as reusable workflows in one synchronous run. Cosign signing stays in `sign-attest.yml`, so the OIDC SAN URI binary tarballs ship with — `sign-attest.yml@<ref>` — is unchanged. `install.sh:24` already expects this identity, so the live install path is unaffected. Stale `release.yml@`-pinned verifier references in 6 places are fixed at the same time.

## Scope

### IN

**Architecture**
- Delete the decommissioned npm-pack jobs from `release.yml` (release.yml:8 already declares them decommissioned per genie-distribution-cutover G6) — they sign a tarball nobody consumes, write to a file (`scripts/verify-release.sh:23`) that is misaligned with reality, and bloat the workflow.
- Repurpose `release.yml` as a thin orchestrator: triggers on tag push (`v*`) + `workflow_dispatch` with `version` input. Calls `build-tarballs.yml`, `sign-attest.yml`, `release-publish.yml` via `uses: ./.github/workflows/...` with `needs:` chaining.
- Add `on: workflow_call` to `build-tarballs.yml`, `sign-attest.yml`, `release-publish.yml`. Each one keeps its existing `workflow_dispatch` trigger as the manual-recovery escape hatch (with current per-file inputs).
- Remove the `on: workflow_run` triggers from `sign-attest.yml` and `release-publish.yml` — replaced by the orchestrator's `needs:` chain. The 9-line security guard `if:` blocks they carried for `workflow_run` propagation are deleted with the trigger.
- Update `version.yml`'s `Trigger Build Tarballs` step (#1738) to dispatch `release.yml` (the orchestrator) instead of `build-tarballs.yml`. One `gh workflow run` call now drives the entire chain.
- Per the architect's R2 P1: each `uses:` job in the orchestrator MUST explicitly declare the union of permissions its called workflow's jobs need (caller is the ceiling). At minimum: `id-token: write`, `contents: write`, `attestations: write`, `actions: read`. `secrets: inherit` on every `uses:` invocation.

**Operational hardening (per reviewer R1 HIGH findings)**
- Pre-merge ADD the new nested check names alongside the existing standalone ones in branch protection. After the cutover PR merges, post-merge REMOVE the obsolete standalone names. This avoids a PR-merge stall window (reviewer HIGH-4).
- `concurrency.cancel-in-progress: false` on the orchestrator. Cancelling a partially-published release leaves the same stranded-artifact state the cutover is escaping (council R2 questioner P1).
- `release.yml`'s `workflow_dispatch` accepts ONLY `version` input — no `run-id` (reviewer HIGH-3, dead code under workflow_call). Cross-run pickup is exclusive to the per-file `workflow_dispatch` escape hatches that already exist.
- Decision: keep individual `workflow_dispatch` triggers on `build-tarballs.yml`, `sign-attest.yml`, `release-publish.yml` (the unhappy-path break-glass) — they are not dead code; they are the documented manual-recovery surface (operator R2 + architect R2). Their existing per-file inputs (e.g. `run_id`, `version`) are retained.

**Verifier-coherence cleanup**
- Fix the 6 stale `release.yml@`-pinned references that reviewer HIGH-1 surfaced — they are pre-existing bugs from the cutover that didn't follow through:
  - `scripts/verify-release.sh:23`
  - `scripts/check-fingerprint-pinning.sh:51`
  - `SECURITY.md:142,179`
  - `src/term-commands/sec.ts:366` (`SIGNER_IDENTITY_REGEXP` constant)
  - `.github/ISSUE_TEMPLATE/signing-key-fingerprint.md:34,69`
- Each gets repinned to `sign-attest.yml@`, matching `install.sh:24` (the live install path that already uses the correct identity).

**Operations**
- `docs/_internal/runbooks/release-pipeline.md` — under 200 words, validated by `wc -w` ≤ 200 + Flesch reading-ease ≥ 60 + `shellcheck` on any inline shell snippets (reviewer HIGH-2 testable proxy). Post-merge human review by Felipe within 24h is captured as a follow-up issue with label `release-runbook-review`, not a blocking gate inside this wish.
- Tag-orphan alert: scheduled GitHub Actions workflow `release-orphan-alert.yml` running every 30 min. Detects `v*` tags older than 30 min with no GitHub Release object; opens a `release-incident`-labeled issue linking to the runbook.
- Rollback dry-run captured in PR description: `gh workflow run release.yml --ref refs/tags/v<version>` after the natural firing already created the release should be either idempotent or fail with a clear "release exists" message.

**Versioning**
- `CHANGELOG.md` documents v4.260510.5 abandonment (one-line gap entry) referencing diagnostic run 25619912030.

### OUT

- **No PAT, no GitHub App token.** Felipe's hard constraint: `WE DIDNT HAVE ONE BEFORE, WE WONT HAVE ONE NOW`. Any solution requiring credential beyond `GITHUB_TOKEN` is forbidden.
- **No retroactive rescue of v4.260510.5's stranded build artifacts.** Run 25619912030's tarballs are abandoned; v4.260510.5 is documented as a numbering gap. The new pipeline ships v4.260510.6 first; v4.260510.5 never gets a Release object.
- **No SLSA generator decoupling.** `slsa-framework/slsa-github-generator/.../generator_generic_slsa3.yml@v2.1.0` stays as-is; the `contents: write` permission grant from #1740 transfers to whichever job calls it inside `sign-attest.yml`.
- **No cosign step relocation.** The cosign step stays in `sign-attest.yml`. The OIDC SAN URI is `.../sign-attest.yml@<ref>`, matching `install.sh:24`. This is the load-bearing invariant for verifier compatibility.
- **No pgserve trust-list update in this wish.** `pgserve-singleton-no-proxy/SHARED-DESIGN.md` references `release.yml@`-pinned identities for the pgserve binary; that is a separate repo's concern and out of scope here. File a follow-up wish in the pgserve repo if the trust list needs updating.
- **No `release.yml` deletion.** The file is repurposed as the orchestrator, not deleted. Branch protection + version.yml's dispatch target both reference it by name.
- **No build-tarballs.yml `pull_request` smoke test changes.** If `build-tarballs.yml`'s current `on.pull_request:` trigger provides PR-time tarball-build smoke testing, it stays. The orchestrator does NOT inherit `pull_request` — only the called workflow keeps it for its standalone PR path.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | **Option B (workflow_call orchestrator) over Option A (single-file collapse)** | After reviewer correction, cosign cert-identity preservation does NOT favor Option A. Option A would move the cosign step into `release.yml`, changing the SAN URI from `sign-attest.yml@` to `release.yml@` and breaking `install.sh:24`'s pin. Option B keeps the cosign step in `sign-attest.yml`, so SAN URI is unchanged — `install.sh` still works without modification. The differentiator that mattered to the council (cert-identity preservation) is now correctly attributed to Option B's structure. Option B also preserves per-file `workflow_dispatch` escape hatches the architect (R2) flagged as the rescue path for half-failed runs. |
| 2 | **Abandon v4.260510.5; ship v4.260510.6 through new pipeline** | Build run 25619912030's tarballs are stranded. Retrofitting cross-run artifact pickup adds plumbing the new pipeline doesn't otherwise need (deployer R2). Document gap in CHANGELOG.md. External pin breakage (Renovate/Dependabot lockfiles resolving to 404) is a known cost (reviewer MEDIUM, captured in Risks). |
| 3 | **Atomic cutover within ONE PR: workflow file changes + version.yml + verifier-coherence cleanup + runbook + alert all ship together. Branch-protection updates are applied as a SEPARATE pre-merge `gh api PUT` (transition state ADD-then-REMOVE).** | Operator's hard rule: runbook+alert+rollback test in same PR. Branch protection cutover gets a transition window: pre-merge ADD new check names, post-merge REMOVE old (reviewer HIGH-4). PR description carries both `gh api PUT` JSON bodies for unambiguous on-call replay. |
| 4 | **`release.yml` orchestrator's `workflow_dispatch` accepts ONLY `version` input** | Run-id input is dead code in the workflow_call model — there's no upstream run to pick up artifacts from. Cross-run pickup remains available via the per-file escape-hatch dispatches on `sign-attest.yml`/`release-publish.yml` (where it already works) (reviewer HIGH-3). |
| 5 | **`concurrency.cancel-in-progress: false` on the orchestrator** | Cancelling a partially-published release leaves the exact stranded-artifact failure mode this wish escapes. The called workflows can keep their own concurrency configs (build-tarballs.yml currently has cancel:true via its pull_request path; that's fine for PR validation, irrelevant to release runs). |
| 6 | **`pull_request` trigger NOT added to `release.yml` orchestrator. No `if: github.event_name != 'pull_request'` defense-in-depth gates either** | If pull_request can't reach the workflow, the gate is dead code that misleads future maintainers (reviewer HIGH-5). build-tarballs.yml retains its existing pull_request trigger for PR-time tarball-build smoke testing in standalone mode — when called via workflow_call from the orchestrator, the trigger context is `workflow_call`, not `pull_request`, so PR contributors cannot reach the orchestrator's signing chain. |
| 7 | **Caller permissions explicitly declared at every `uses:` job; `secrets: inherit` on every `uses:` invocation** | workflow_call permissions DO NOT auto-inherit (architect R2 P1 silent killer). Caller's job-level `permissions:` is the ceiling — `id-token: write` MUST be set on the orchestrator's caller job, not just the called workflow. Secrets also do not auto-inherit; `secrets: inherit` is the simplest correct form. |
| 8 | **Verifier-coherence cleanup (`release.yml@` → `sign-attest.yml@`) ships in this wish, not as a follow-up** | Reviewer HIGH-1 audit found 6 stale references. They are pre-existing bugs from the genie-distribution-cutover that didn't follow through. Without fixing them, this wish's QA Criteria can't pass and `scripts/verify-release.sh` remains broken. Including them avoids a follow-up that never happens (operator R1). |

## Success Criteria

- [ ] `release.yml` is the orchestrator: declares `on: push: tags: v*` + `on: workflow_dispatch` (version-only input) + `concurrency.cancel-in-progress: false` + jobs that `uses: ./.github/workflows/{build-tarballs,sign-attest,release-publish}.yml`. No `npm pack` step, no cosign step inside `release.yml`.
- [ ] `build-tarballs.yml`, `sign-attest.yml`, `release-publish.yml` each declare `on: workflow_call` alongside existing `workflow_dispatch`. No `on: workflow_run` anywhere in `.github/workflows/`.
- [ ] Each orchestrator `uses:` job declares its own `permissions:` block (union of called workflow's needs) and `secrets: inherit`.
- [ ] `version.yml`'s dispatch step targets `release.yml` (verified via grep).
- [ ] On the next dev push after merge, version.yml bumps to v4.260510.6, dispatches `release.yml`, and within 15 minutes a GitHub Release v4.260510.6 exists with all 4 platform tarballs + signatures + attestations.
- [ ] `.well-known/latest.json` is committed to main pointing at v4.260510.6.
- [ ] `cosign verify-blob --certificate-identity-regexp "^https://github.com/automagik-dev/genie/.github/workflows/sign-attest.yml@"` passes against v4.260510.6 tarballs (SAN URI unchanged from pre-cutover binary releases).
- [ ] `install.sh` requires zero changes — verified by `git diff origin/main install.sh` returning empty.
- [ ] `scripts/verify-release.sh:23`, `scripts/check-fingerprint-pinning.sh:51`, `SECURITY.md:142,179`, `src/term-commands/sec.ts:366`, `.github/ISSUE_TEMPLATE/signing-key-fingerprint.md:34,69` all pin `sign-attest.yml@` (matching `install.sh:24` and reality).
- [ ] Branch-protection required-status-checks on `main` and `dev` reference the new nested job names (`release / sign / sign (linux-x64-glibc)` etc.) and NOT the obsolete standalone names (`Sign + Attest Tarballs`, `Release Publish`).
- [ ] `CHANGELOG.md` documents v4.260510.5 abandonment with diagnostic run 25619912030 reference.
- [ ] `docs/_internal/runbooks/release-pipeline.md` exists, ≤ 200 words, passes `shellcheck` on inline shell snippets, has Flesch reading-ease ≥ 60.
- [ ] `release-orphan-alert.yml` exists with `schedule: cron: '*/30 * * * *'` and opens GitHub issue with label `release-incident` when a `v*` tag has no Release object after 30 min.
- [ ] Manual-recovery dry-run: `gh workflow run release.yml --ref refs/tags/v4.260510.6` after the natural firing produces either a clear "release already exists" error or is correctly idempotent — never duplicates.
- [ ] Cosign installer version is consistent across orchestrator + called workflows (today release.yml uses v2.2.4, sign-attest.yml uses v2.4.1 — pick one, document choice in PR).

## Execution Strategy

### Wave 1 (sequential, single PR — atomic cutover per Decision #3)

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Convert build-tarballs.yml + sign-attest.yml + release-publish.yml to support `on: workflow_call` (additive — keep existing workflow_dispatch). Remove `on: workflow_run` from sign-attest.yml + release-publish.yml. Delete the 9-line security guard `if:` blocks tied to workflow_run. |
| 2 | engineer | Repurpose release.yml as orchestrator. Delete decommissioned npm-pack jobs. Add jobs that `uses: ./.github/workflows/{build-tarballs,sign-attest,release-publish}.yml` with explicit per-job permissions + `secrets: inherit` + `needs:` chain. `workflow_dispatch` accepts only `version` input. `concurrency.cancel-in-progress: false`. |
| 3 | engineer | version.yml dispatch step rewires from `build-tarballs.yml` to `release.yml`. Update step name + comment block. |
| 4 | engineer | Verifier-coherence cleanup: 6 files updated `release.yml@` → `sign-attest.yml@` to match `install.sh:24` reality. |
| 5 | engineer | Branch-protection transition-state: pre-merge `gh api PUT` ADDS new nested check names alongside existing; PR description documents the post-merge REMOVE step with exact JSON body. |
| 6 | engineer | Operations bundle: runbook (≤200 words, shellcheck-clean), tag-orphan alert workflow, rollback dry-run plan in PR description. |
| 7 | engineer | CHANGELOG.md v4.260510.5 abandonment entry. Cosign installer version reconciliation. |

Single wave because the collapse must be atomic — every change ships together to avoid the silent branch-protection break and half-collapsed pipeline. Group 5 has a pre-merge step (the ADD branch-protection PUT) that runs before merging the PR; the rest of Group 5 (REMOVE old names) runs post-merge. Documented in PR description.

## Execution Groups

### Group 1: Add `workflow_call` triggers to the three workflow files

**Goal:** Make `build-tarballs.yml`, `sign-attest.yml`, `release-publish.yml` callable as reusable workflows from an orchestrator, while preserving their existing `workflow_dispatch` escape-hatch behavior.

**Deliverables:**
1. `build-tarballs.yml`: add `on: workflow_call:` block. Inputs (if needed): none — it can derive version from the tag ref naturally. Outputs: none — artifacts pass through GitHub's run-shared artifact store. Keep existing `on: pull_request:` (for PR validation in standalone mode) and `on: workflow_dispatch:` (for break-glass).
2. `sign-attest.yml`: add `on: workflow_call:` block. Remove `on: workflow_run:`. Delete the 9-line security guard `if:` blocks on `prepare`, `provenance`, `sign` jobs that referenced `github.event.workflow_run.*` — they're impossible to evaluate under workflow_call (the trigger event is implicit). Keep `on: workflow_dispatch:` with existing `version` + `run_id` inputs (escape hatch for cross-run artifact pickup).
3. `release-publish.yml`: same shape as sign-attest.yml — add `workflow_call`, remove `workflow_run`, delete the workflow_run-tied security guard, keep `workflow_dispatch`.

**Acceptance Criteria:**
- [ ] All three files declare `on: workflow_call:` (verified by yq).
- [ ] No remaining `on: workflow_run:` in any of the three files.
- [ ] No remaining `github.event.workflow_run.*` expressions in any `.github/workflows/*.yml` (search the entire workflows directory).
- [ ] `workflow_dispatch:` triggers retained on all three files.
- [ ] `pull_request:` trigger retained on `build-tarballs.yml` only (its existing PR-time tarball smoke test).
- [ ] yamllint passes on all three files.

**Validation:**
```bash
cd /home/genie/workspace/repos/genie
for f in build-tarballs sign-attest release-publish; do
  yq '.on.workflow_call' .github/workflows/${f}.yml | grep -qv '^null$' || { echo "$f missing workflow_call"; exit 1; }
done
! grep -l 'workflow_run:' .github/workflows/sign-attest.yml .github/workflows/release-publish.yml
! grep -rn 'github.event.workflow_run' .github/workflows/
yamllint .github/workflows/{build-tarballs,sign-attest,release-publish}.yml
```

**depends-on:** none

---

### Group 2: Repurpose `release.yml` as orchestrator

**Goal:** Delete the decommissioned npm-pack jobs from `release.yml`, replace with thin orchestrator jobs that call build-tarballs/sign-attest/release-publish via `workflow_call`.

**Deliverables:**
1. Delete every job in `release.yml` that does `npm pack`, cosign-signs the npm tarball, or runs the npm-pack-specific verify steps. Delete `release.yml`'s cosign step entirely (cosign moves nowhere — it stays in `sign-attest.yml`).
2. New jobs in `release.yml`:
   ```yaml
   jobs:
     build:
       uses: ./.github/workflows/build-tarballs.yml
       permissions:
         contents: read
       secrets: inherit
     sign-attest:
       needs: build
       uses: ./.github/workflows/sign-attest.yml
       permissions:
         contents: write       # SLSA reusable contents: write per #1740
         id-token: write       # cosign keyless + attest-build-provenance OIDC
         attestations: write   # GitHub Attestations API
         actions: read         # cross-run artifact metadata
       secrets: inherit
     publish:
       needs: sign-attest
       uses: ./.github/workflows/release-publish.yml
       permissions:
         contents: write       # commit .well-known/latest.json
         id-token: write       # if needed
       secrets: inherit
   ```
3. Triggers: `on: push: tags: ['v*']` + `on: workflow_dispatch:` with single `version` input (no run-id).
4. `concurrency: { group: release-${{ github.ref }}, cancel-in-progress: false }`.
5. Top-level `permissions:` block at the workflow level should be `permissions: contents: read` (default-deny posture); per-job blocks override upward where needed.
6. Header comment block updated to reflect "Orchestrator: tag push → build → sign-attest → publish" framing.

**Acceptance Criteria:**
- [ ] `release.yml` declares no `npm pack` step, no cosign step.
- [ ] `release.yml` declares 3 jobs: `build`, `sign-attest`, `publish` (or names equivalent), each with `uses: ./.github/workflows/...` and `secrets: inherit`.
- [ ] Each `uses:` job declares its own `permissions:` block matching the called workflow's needs.
- [ ] `release.yml` `workflow_dispatch` inputs contain `version` and ONLY `version`.
- [ ] `release.yml` declares `concurrency.cancel-in-progress: false`.
- [ ] No `on: pull_request:` block in `release.yml`.
- [ ] No `if: github.event_name != 'pull_request'` gates in `release.yml` (dead code).

**Validation:**
```bash
cd /home/genie/workspace/repos/genie
! grep -q 'npm pack' .github/workflows/release.yml
! grep -q 'sigstore/cosign-installer' .github/workflows/release.yml
test "$(yq '.jobs | keys | length' .github/workflows/release.yml)" -eq 3
yq '.jobs.[].uses' .github/workflows/release.yml | grep -qE '\.github/workflows/build-tarballs\.yml$'
yq '.jobs.[].uses' .github/workflows/release.yml | grep -qE '\.github/workflows/sign-attest\.yml$'
yq '.jobs.[].uses' .github/workflows/release.yml | grep -qE '\.github/workflows/release-publish\.yml$'
yq '.concurrency."cancel-in-progress"' .github/workflows/release.yml | grep -qE '^false$'
yq '.on.workflow_dispatch.inputs | keys | .[]' .github/workflows/release.yml | sort | tr -d '"' | grep -qxF version
test "$(yq '.on.workflow_dispatch.inputs | keys | length' .github/workflows/release.yml)" -eq 1
! grep -q 'on:.*pull_request' .github/workflows/release.yml
! grep -q "github.event_name != 'pull_request'" .github/workflows/release.yml
```

**depends-on:** Group 1

---

### Group 3: version.yml dispatch step retargets `release.yml`

**Goal:** Update version.yml's `Trigger Build Tarballs` step (added in #1738) to dispatch `release.yml` instead of `build-tarballs.yml`. One dispatch fires the whole chain.

**Deliverables:**
1. version.yml step rename `Trigger Build Tarballs for the new tag` → `Trigger release pipeline for the new tag`.
2. Body changed `gh workflow run build-tarballs.yml` → `gh workflow run release.yml`. Pass `--field version=${VERSION}` since `release.yml` accepts `version` input.
3. Comment block above the step updated to reflect "dispatches the full chain (build → sign → publish)" framing.

**Acceptance Criteria:**
- [ ] version.yml dispatches `release.yml`, not `build-tarballs.yml`.
- [ ] version.yml dispatch step name reflects the new role.
- [ ] version.yml comment block accurately describes what the dispatch fires.

**Validation:**
```bash
cd /home/genie/workspace/repos/genie
! grep -q 'gh workflow run build-tarballs.yml' .github/workflows/version.yml
grep -q 'gh workflow run release.yml' .github/workflows/version.yml
grep -qi 'release pipeline' .github/workflows/version.yml
```

**depends-on:** Group 2

---

### Group 4: Verifier-coherence cleanup — `release.yml@` → `sign-attest.yml@`

**Goal:** Fix the 6 stale `release.yml@`-pinned cosign cert-identity references to match what `install.sh:24` and `sign-attest.yml:332` already use. These are pre-existing bugs from the genie-distribution-cutover that didn't follow through.

**Deliverables:**
1. `scripts/verify-release.sh:23` — `WORKFLOW_IDENTITY_REGEXP` regex updated.
2. `scripts/check-fingerprint-pinning.sh:51` — doc-consistency check string updated.
3. `SECURITY.md:142,179` — both code-fence examples updated.
4. `src/term-commands/sec.ts:366` — `SIGNER_IDENTITY_REGEXP` constant updated. Note: any tests referencing the constant must also be updated to match (search for `SIGNER_IDENTITY_REGEXP` repo-wide).
5. `.github/ISSUE_TEMPLATE/signing-key-fingerprint.md:34,69` — both code-fence examples updated.
6. Smoke-verify the change: pick the most recent signed binary release (`v4.260509.2`), run `cosign verify-blob` with both regexes, confirm only the new (`sign-attest.yml@`) regex passes — proves the bug fix is correct, not just a string substitution.

**Acceptance Criteria:**
- [ ] All 6 references repinned to `sign-attest.yml@`.
- [ ] No `release.yml@` cosign cert-identity strings remain ANYWHERE in the repo's source code, docs, or scripts (excluding historical `.genie/wishes/` files which are immutable history; `pgserve-singleton-no-proxy/SHARED-DESIGN.md` is also out of scope).
- [ ] Smoke verification: `cosign verify-blob` against v4.260509.2 succeeds with the new regex AND fails with the old regex (proves we picked the correct identity).
- [ ] If `src/term-commands/sec.ts` has unit tests against `SIGNER_IDENTITY_REGEXP`, they pass with the new value.

**Validation:**
```bash
cd /home/genie/workspace/repos/genie
# Stale references gone (excluding historical wishes + pgserve cross-repo doc)
! grep -rn 'release\.yml@' \
  --include='*.sh' --include='*.md' --include='*.mdx' --include='*.ts' --include='*.yml' --include='*.yaml' \
  --exclude-dir='.genie/wishes' \
  --exclude-dir='node_modules' \
  --exclude-dir='.docs-vendor' \
  | grep -v 'pgserve-singleton-no-proxy' \
  | grep -F 'github.com'
# Required new pins exist:
grep -q 'sign-attest\.yml@' scripts/verify-release.sh
grep -q 'sign-attest\.yml@' SECURITY.md
grep -q 'sign-attest\.yml@' src/term-commands/sec.ts
grep -q 'sign-attest\.yml@' .github/ISSUE_TEMPLATE/signing-key-fingerprint.md
grep -q 'sign-attest\.yml@' scripts/check-fingerprint-pinning.sh
# Tests if any:
bun test --filter "SIGNER_IDENTITY" 2>&1 | grep -qE '0 fail'
```

**depends-on:** none (independent of Groups 1-3)

---

### Group 5: Branch-protection transition-state cutover

**Goal:** Update branch-protection required-status-checks via a transition-state ADD-then-REMOVE pattern that has zero PR-merge stall window.

**Deliverables:**
1. PR description includes a "Branch Protection Cutover" section with three blocks:
   - **OLD required check names** (current state, captured pre-merge via `gh api /repos/automagik-dev/genie/branches/main/protection --jq '.required_status_checks.contexts[]'`).
   - **NEW required check names** post-collapse (will be `release / build (linux-x64-glibc)`, `release / sign-attest / sign (linux-x64-glibc)`, `release / publish` — exact names confirmed from a workflow_dispatch trial on this branch BEFORE merge).
   - **CUTOVER COMMANDS** in two phases: PRE-MERGE `gh api PUT` that ADDs new names alongside existing (run by the human before clicking merge); POST-MERGE `gh api PUT` that REMOVEs the obsolete names (run by the human within 30 min of merge).
2. Identify required checks that the new pipeline cannot satisfy at all (e.g., a check that ran on `pull_request` but is now gated to `workflow_call` only) and explicitly remove from required AND document why in the PR description.
3. Confirm branch-protection trial: dispatch `release.yml` against this PR's branch (workflow_dispatch with `version=test` against the wish branch). The check names that appear in the run page are the canonical NEW names.

**Acceptance Criteria:**
- [ ] PR description has "Branch Protection Cutover" section with OLD/NEW/PRE-MERGE/POST-MERGE blocks.
- [ ] PRE-MERGE `gh api PUT` JSON body is in the PR description, ready to copy-paste.
- [ ] POST-MERGE `gh api PUT` JSON body is in the PR description, ready to copy-paste.
- [ ] At least one trial workflow_dispatch run of `release.yml` exists on the wish branch BEFORE merge, proving the new check names.
- [ ] Branch-protection on `main` and `dev` both updated post-merge (verified by `gh api ... | jq` returning exactly the union/then-pruned set as documented).

**Validation:**
```bash
cd /home/genie/workspace/repos/genie
# Pre-merge:
gh pr view <PR#> --json body -q .body | grep -qE 'PRE-MERGE.*gh api PUT'
gh pr view <PR#> --json body -q .body | grep -qE 'POST-MERGE.*gh api PUT'
gh run list --workflow=release.yml --branch wish/release-pipeline-collapse --limit 1 \
  | grep -q 'workflow_dispatch'
# Post-merge:
for branch in main dev; do
  gh api /repos/automagik-dev/genie/branches/$branch/protection \
    --jq '.required_status_checks.contexts[]' \
    | grep -v -E 'Sign \+ Attest Tarballs|Release Publish'
done
```

**depends-on:** Group 2

---

### Group 6: Operations bundle — runbook + alert + rollback test plan

**Goal:** Ship the runbook + alert + tested rollback path in the same PR (operator P0 hard rule). Use a TESTABLE proxy for "external review" since autonomous engineers can't satisfy human-review gates.

**Deliverables:**
1. `docs/_internal/runbooks/release-pipeline.md` — under 200 words. Structure: "Symptoms (chain didn't reach publish job within 30 min) → Diagnosis (find release.yml run for vX.Y.Z, identify failed job N) → Recovery (manual `gh workflow run release.yml --ref refs/tags/v<version>` or per-file `gh workflow run sign-attest.yml --field version=X --field run_id=Y` for the cross-run rescue path)". Includes inline `bash` snippets that pass `shellcheck`.
2. `docs/_internal/runbooks/release-pipeline.md` validated by `wc -w` ≤ 200 + Flesch reading-ease (computed via `style` or equivalent) ≥ 60. If `style` is unavailable, fall back to manual sentence-length and word-length heuristics; the validation MUST still produce a deterministic pass/fail.
3. **Post-merge human review handoff:** a follow-up GitHub issue gets created in the SAME PR (or as part of the merge process) with title "Review release-pipeline runbook (cutover follow-up)" and label `release-runbook-review`, assigned to Felipe, due 24h post-merge. This handoff is OUTSIDE the engineer's gate — its existence is checked, but its outcome is not blocking.
4. `release-orphan-alert.yml` — scheduled workflow (`schedule: cron: '*/30 * * * *'` + `workflow_dispatch`). Logic: list `gh api /repos/.../tags?per_page=10`, list `gh api /repos/.../releases?per_page=10`, find any `v*` tag older than 30 min that has no matching Release object, open a GitHub issue (label `release-incident`) with body linking to the runbook + the orphan tag name + the relevant `release.yml` run URL if any.
5. PR description "Rollback Dry-Run" section — the exact reproducer command sequence + expected outputs, validated against v4.260510.6 once it ships.

**Acceptance Criteria:**
- [ ] `docs/_internal/runbooks/release-pipeline.md` exists, ≤ 200 words.
- [ ] Inline shell snippets in runbook pass `shellcheck` (extract via fence parsing).
- [ ] `release-orphan-alert.yml` exists with `schedule.cron: '*/30 * * * *'`.
- [ ] Follow-up issue created with title matching pattern `Review release-pipeline runbook` + label `release-runbook-review`.
- [ ] PR description has "Rollback Dry-Run" section with reproducer + expected output.

**Validation:**
```bash
cd /home/genie/workspace/repos/genie
test -f docs/_internal/runbooks/release-pipeline.md
test "$(wc -w < docs/_internal/runbooks/release-pipeline.md)" -le 200
# Extract bash fences and shellcheck them:
awk '/^```bash$/,/^```$/' docs/_internal/runbooks/release-pipeline.md \
  | grep -v '^```' \
  | shellcheck - 2>&1 | grep -qE 'no issues|^$' || (echo "shellcheck failed"; exit 1)
test -f .github/workflows/release-orphan-alert.yml
yq '.on.schedule[0].cron' .github/workflows/release-orphan-alert.yml | grep -qF '*/30 * * * *'
# Follow-up issue:
gh issue list --label release-runbook-review --limit 1 --json title -q '.[].title' \
  | grep -qiE 'review release-pipeline runbook'
# PR description rollback section:
gh pr view <PR#> --json body -q .body | grep -qiE 'rollback dry-run'
```

**depends-on:** Group 2

---

### Group 7: CHANGELOG + cosign version reconciliation

**Goal:** Document the v4.260510.5 abandonment and reconcile the cosign installer version mismatch (release.yml v2.2.4 vs sign-attest.yml v2.4.1).

**Deliverables:**
1. `CHANGELOG.md` v4.260510.5 abandonment entry (one line at top of unreleased): `- **v4.260510.5 (skipped):** build artifacts existed (run 25619912030) but never received a signed release due to GITHUB_TOKEN workflow_run anti-recursion blocker; superseded by v4.260510.6 via the new release.yml workflow_call orchestrator (wish: release-pipeline-collapse).`
2. Cosign installer version: pick the newer (v2.4.1, used in sign-attest.yml today) and apply uniformly. Since `release.yml` no longer signs anything in the new architecture, this just means the sign-attest.yml version is canonical — but document the choice in the runbook (Group 6) so future maintainers don't reintroduce divergence.

**Acceptance Criteria:**
- [ ] CHANGELOG.md contains the v4.260510.5 abandonment entry referencing run 25619912030.
- [ ] `sign-attest.yml` cosign installer version is unchanged from current (v2.4.1).
- [ ] No other workflow file references a different cosign version (`grep -q 'cosign-release' .github/workflows/*.yml` returns at most the sign-attest.yml v2.4.1 line).

**Validation:**
```bash
cd /home/genie/workspace/repos/genie
grep -q '4\.260510\.5' CHANGELOG.md
grep -q '25619912030' CHANGELOG.md
test "$(grep -hE 'cosign-release' .github/workflows/*.yml | sort -u | wc -l)" -le 1
grep -q "cosign-release: 'v2.4.1'" .github/workflows/sign-attest.yml
```

**depends-on:** Group 2

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] **Functional:** First dev push after merge bumps to v4.260510.6, dispatches `release.yml`, and within 15 minutes produces a GitHub Release v4.260510.6 with 4 platform tarballs + signatures + attestations. Verifies the workflow_call chain executes end-to-end.
- [ ] **Integration:** `.well-known/latest.json` is committed to main with `version: 4.260510.6` and correct asset URLs.
- [ ] **Verifier compatibility (post-merge):** `cosign verify-blob --certificate-identity-regexp "^https://github.com/automagik-dev/genie/.github/workflows/sign-attest.yml@" --bundle <tarball>.bundle <tarball>` succeeds against v4.260510.6 — proves SAN URI is unchanged from pre-cutover binary releases.
- [ ] **Verifier backward-compat:** Same `cosign verify-blob` against the most recent PRE-cutover signed release (v4.260509.2) STILL succeeds with the SAME regex — backward verifier compatibility preserved (this is the load-bearing claim of Decision #1).
- [ ] **`install.sh` zero-touch:** `git diff origin/main install.sh` is empty after this wish merges. Live install path is unaffected.
- [ ] **`scripts/verify-release.sh` works:** running it against the v4.260510.6 release succeeds (proves the verifier-coherence cleanup from Group 4 actually works, not just changed strings).
- [ ] **Branch protection:** opening a fresh PR against `dev` does not block on missing required-status-checks named `Sign + Attest Tarballs` or `Release Publish`. Required checks are the new nested names.
- [ ] **Manual recovery (per-file escape hatch):** `gh workflow run sign-attest.yml --field version=4.260510.6 --field run_id=<release-build-run-id>` is still functional as a break-glass path post-cutover.
- [ ] **Manual recovery (orchestrator dispatch):** `gh workflow run release.yml --field version=4.260510.6` after the natural firing produces either "release already exists" or is silently idempotent — never duplicates.
- [ ] **Concurrency:** if a second dev push lands while v4.260510.6's `release.yml` run is mid-pipeline, the second run does NOT cancel the first (cancel-in-progress: false verification).
- [ ] **No `[skip ci]` shadow:** if the wish-merge commit accidentally includes `[skip ci]` (e.g., from a co-authored auto-changelog step), version.yml does not skip — the chain still fires. Verify by inspecting the merge commit message.
- [ ] **External pin breakage acceptance:** Renovate/Dependabot/lockfiles pinned to v4.260510.5 will resolve to 404. Confirm this is acceptable (it is — v4.260510.5 was never a real release) and document the breakage path in the rollback runbook (Group 6).

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Branch-protection cutover causes silent PR-merge breakage if pre-merge ADD step is skipped | High | Group 5 transition-state ADD-then-REMOVE pattern eliminates the stall window. PR template checklist includes "Pre-merge `gh api PUT` ADD executed" and "Post-merge REMOVE within 30 min". |
| `workflow_call` permission inheritance gotcha — orchestrator job missing `id-token: write` causes cosign to fail at minute 12 after build matrix burns | High | Decision #7 + Group 2 explicit per-job `permissions:` block. Group 5 trial workflow_dispatch run on wish branch surfaces this BEFORE merge. |
| SLSA generator's `contents: write` requirement (#1740) doesn't transfer cleanly to the new caller | Medium | Group 1 + Group 2: the `sign-attest.yml` `provenance` job retains its existing reviewer-grade comment block from #1740. Caller (`release.yml` orchestrator's `sign-attest` job) declares `contents: write` to satisfy the cap. |
| External consumers pinned to v4.260510.5 (Renovate/Dependabot/lockfiles) get 404 after abandonment | Medium | Decision #2 + CHANGELOG entry. Document in runbook. v4.260510.5 was never a real release; the resolution failure is correct. |
| Second-hop workflow_run anti-recursion was actually two hops (build → sign → publish), not one — the council description simplified | Medium | This wish collapses ALL workflow_run usage into needs:-chained workflow_call. Both hops gone simultaneously. Validation Group 1 grep confirms no workflow_run remaining. |
| `[skip ci]` shadow on the wish-merge commit causes version.yml to not run — pipeline never fires post-merge | Medium | QA Criterion verifies merge commit message. If shadow exists, manual `gh workflow run version.yml --ref dev` recovers; document in runbook. |
| Cosign installer version divergence (v2.2.4 vs v2.4.1) leaves only one survivor; older bundle format incompatibilities | Low | Group 7 reconciles to v2.4.1 (newer). sign-attest.yml IS the cosign-bearing file — `release.yml` orchestrator no longer needs cosign, so divergence ceases naturally. |
| `pgserve-singleton-no-proxy` references stale `release.yml@` — its trust list is in the pgserve repo, not genie | Low | Out-of-scope for this wish. Filed as follow-up: `pgserve-trust-list-cleanup` wish in pgserve repo. genie wish files in `.genie/wishes/pgserve-singleton-no-proxy/*` are historical, not consumed by runtime. |
| Group 5 trial workflow_dispatch run on wish branch may produce signed artifacts that consumers might mistake for a real release | Low | Trial run uses `version=test` — non-tag-shaped, never advances `.well-known/latest.json`, never creates a Release object. The `release-orphan-alert.yml` (Group 6) ignores non-`v*` patterns. |
| Decision #1's "no verifier breaks" claim is now SOUND but only because cosign step stays put — if a future refactor moves it, the verifier ecosystem breaks | Low | Decision #8 + Group 4 makes the verifier-coherence cleanup a load-bearing invariant. Document in runbook (Group 6) that `sign-attest.yml` is the cosign owner-of-record. |

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
# Modified — workflow files
.github/workflows/release.yml         (Group 2: repurpose as orchestrator; delete npm-pack jobs + cosign step)
.github/workflows/build-tarballs.yml  (Group 1: add on: workflow_call; keep workflow_dispatch + pull_request)
.github/workflows/sign-attest.yml     (Group 1: add on: workflow_call; remove on: workflow_run + tied if: blocks; keep workflow_dispatch)
.github/workflows/release-publish.yml (Group 1: add on: workflow_call; remove on: workflow_run + tied if: blocks; keep workflow_dispatch)
.github/workflows/version.yml         (Group 3: dispatch target build-tarballs.yml → release.yml)

# Modified — verifier-coherence cleanup (Group 4)
scripts/verify-release.sh                            (line 23)
scripts/check-fingerprint-pinning.sh                 (line 51)
SECURITY.md                                          (lines 142, 179)
src/term-commands/sec.ts                             (line 366: SIGNER_IDENTITY_REGEXP)
.github/ISSUE_TEMPLATE/signing-key-fingerprint.md    (lines 34, 69)

# Modified — versioning (Group 7)
CHANGELOG.md                                          (v4.260510.5 abandonment entry)

# Created
docs/_internal/runbooks/release-pipeline.md          (Group 6: ≤200 word runbook)
.github/workflows/release-orphan-alert.yml           (Group 6: scheduled tag-orphan check)

# Branch-protection (out-of-tree, applied via gh api PUT in two phases — Group 5)
gh api PUT /repos/automagik-dev/genie/branches/{main,dev}/protection  (PRE-MERGE: ADD new check names)
gh api PUT /repos/automagik-dev/genie/branches/{main,dev}/protection  (POST-MERGE: REMOVE obsolete names)

# Follow-up issues created (Group 6)
- "Review release-pipeline runbook (cutover follow-up)" assigned Felipe (label: release-runbook-review)
- "pgserve trust list: update release.yml@ → sign-attest.yml@" filed in pgserve repo (out-of-scope for genie wish)
```
