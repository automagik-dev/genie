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
| 6 | **`pull_request` trigger NOT added to `release.yml` orchestrator. No `if: github.event_name != 'pull_request'` defense-in-depth gates either.** `build-tarballs.yml` retains its existing standalone `pull_request` trigger. | If pull_request can't reach the orchestrator, the gate is dead code that misleads future maintainers (reviewer HIGH-5). The standalone `build-tarballs.yml` PR-time path is independent of the orchestrator path: standalone mode runs with `permissions: contents: read` only (no signing scope reachable by PR contributors); the workflow_call-invoked path inside the orchestrator runs under the caller's permission grants (with full signing scope). The trigger context (`pull_request` vs `workflow_call`) is checked by GitHub Actions itself — PR contributors cannot escalate from the standalone path into the orchestrator's signing chain. Verify: Group 1 acceptance does NOT change `build-tarballs.yml` standalone permissions. |
| 7 | **Caller permissions explicitly declared at every `uses:` job; `secrets: inherit` on every `uses:` invocation. The effective permission set is the INTERSECTION of caller's grant and called-workflow's per-job declarations — not just a one-way ceiling.** | workflow_call permissions DO NOT auto-inherit (architect R2 P1 silent killer). The caller's job-level `permissions:` block sets the maximum; the called workflow's per-job `permissions:` blocks set their own (which the runtime caps to the caller's max). Therefore: (a) the orchestrator's `sign-attest` caller job MUST declare `id-token: write` + `contents: write` + `attestations: write` + `actions: read` (the union of `sign-attest.yml`'s inner per-job needs), AND (b) `sign-attest.yml`'s inner per-job blocks must ALSO declare what each job needs (which they already do today). Editing only the orchestrator side is INSUFFICIENT — the called-workflow declarations are independent and must already exist or be added. Group 1 acceptance verifies the inner declarations are unchanged from current state (since they already exist for the standalone workflow_dispatch path). Secrets: `secrets: inherit` is the simplest correct form for forward-compat. |
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
- [ ] `docs/_internal/runbooks/release-pipeline.md` exists, ≤ 200 prose words, max 20 words/sentence, max 5 sentences/paragraph, no prose word > 18 chars, passes `shellcheck` per-fence on inline shell snippets.
- [ ] `release-orphan-alert.yml` exists with `schedule: cron: '*/30 * * * *'` and opens GitHub issue with label `release-incident` when a `v*` tag has no Release object after 30 min.
- [ ] Manual-recovery dry-run: `gh workflow run release.yml --ref refs/tags/v4.260510.6` after the natural firing produces either a clear "release already exists" error or is correctly idempotent — never duplicates.
- [ ] Cosign installer is invoked from exactly one workflow file (`sign-attest.yml`) at v2.4.1; `release.yml` has no cosign step post-Group-2.

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

1. **`build-tarballs.yml`**: add `on: workflow_call:` block.
   - **workflow_call inputs:** none — version is derived at build time from the package.json being built; no caller-supplied input needed.
   - **workflow_call outputs:** none — artifacts pass through GitHub's run-shared artifact store; no value-passing required.
   - Keep existing `on: pull_request:` (for PR validation in standalone mode — confirmed safe per Decision #6 since standalone path has `permissions: contents: read` only, no signing scope reachable by PR contributors).
   - Keep existing `on: workflow_dispatch:` (break-glass).

2. **`sign-attest.yml`**: add `on: workflow_call:` block.
   - **workflow_call inputs:** `version` (string, optional — can be derived from artifact filenames if not supplied; preserves the existing `inputs.version` semantics from the workflow_dispatch path).
   - **workflow_call outputs:** `version` (string — the resolved version, useful for the orchestrator's `publish` job that follows).
   - Remove `on: workflow_run:`. Delete the 9-line security guard `if:` blocks on `prepare`, `provenance`, `sign` jobs that reference `github.event.workflow_run.*` — they evaluate to false under workflow_call (the workflow_run context object is null) and would short-circuit every job.
   - Keep `on: workflow_dispatch:` with existing `version` + `run_id` inputs (cross-run artifact pickup escape hatch).

3. **`release-publish.yml`**: add `on: workflow_call:` block.
   - **workflow_call inputs:** `version` (string, REQUIRED), `channel` (string, optional, default `'stable'`), `draft` (boolean, optional, default `false` for the orchestrator path — this is the production release path; the standalone `workflow_dispatch` path keeps its existing `default: true` for safety).
   - **workflow_call outputs:** none.
   - **Important:** the `draft` default for workflow_call MUST be `false` (production publish), but workflow_dispatch keeps `default: true` (drafts are safer for manual replay). Implementation: declare separately under `on.workflow_call.inputs.draft.default` and `on.workflow_dispatch.inputs.draft.default` — they are independent declarations.
   - Remove `on: workflow_run:`. Delete the workflow_run-tied security guard `if:` blocks.
   - Keep `on: workflow_dispatch:`.

**Acceptance Criteria:**
- [ ] All three files declare `on: workflow_call:` (verified by yq).
- [ ] No remaining `on: workflow_run:` in any of the three files.
- [ ] No remaining `github.event.workflow_run.*` expressions in any `.github/workflows/*.yml`.
- [ ] `workflow_dispatch:` triggers retained on all three files.
- [ ] `pull_request:` trigger retained on `build-tarballs.yml` only.
- [ ] `sign-attest.yml.on.workflow_call.inputs.version` exists (string, optional).
- [ ] `sign-attest.yml.on.workflow_call.outputs.version` exists.
- [ ] `release-publish.yml.on.workflow_call.inputs.version` exists (string, REQUIRED).
- [ ] `release-publish.yml.on.workflow_call.inputs.draft.default` is `false` AND `release-publish.yml.on.workflow_dispatch.inputs.draft.default` is `true` (asymmetric defaults — production-safe via workflow_call, replay-safe via workflow_dispatch).
- [ ] yamllint passes on all three files.

**Validation:**
```bash
cd /home/genie/workspace/repos/genie
for f in build-tarballs sign-attest release-publish; do
  test "$(yq '.on.workflow_call' .github/workflows/${f}.yml)" != "null" \
    || { echo "$f missing workflow_call"; exit 1; }
done
! grep -lE '^\s*workflow_run:' .github/workflows/sign-attest.yml .github/workflows/release-publish.yml
! grep -rnE 'github\.event\.workflow_run' .github/workflows/
test "$(yq '.on.workflow_call.inputs.version.required' .github/workflows/release-publish.yml)" = "true"
test "$(yq '.on.workflow_call.inputs.draft.default' .github/workflows/release-publish.yml)" = "false"
test "$(yq '.on.workflow_dispatch.inputs.draft.default' .github/workflows/release-publish.yml)" = "true"
test "$(yq '.on.workflow_call.outputs.version' .github/workflows/sign-attest.yml)" != "null"
# Decision #6 anchor: build-tarballs.yml standalone path retains contents:read only —
# no signing scope reachable by PR contributors via the standalone PR-time path.
test "$(yq '.permissions.contents' .github/workflows/build-tarballs.yml)" = "read"
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
5. Top-level `permissions:` block at the workflow level: `permissions: contents: read`. Per GitHub Actions semantics, declaring any explicit scope sets all unmentioned scopes to `none`, which is effectively default-deny for write/elevated scopes; per-job blocks declare their elevated needs.
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
# Comment-aware: ignore lines whose first non-whitespace char is '#'
! grep -E '^[[:space:]]*[^#[:space:]].*npm pack' .github/workflows/release.yml
! grep -E '^[[:space:]]*[^#[:space:]].*sigstore/cosign-installer' .github/workflows/release.yml
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
# Stale references gone (path-based prune; --exclude-dir matches basename, which is misleading)
LEFTOVER=$(find . \
  \( -path './node_modules' -o -path './.docs-vendor' -o -path './.genie/wishes' -o -path './.git' \) -prune \
  -o -type f \( -name '*.sh' -o -name '*.md' -o -name '*.mdx' -o -name '*.ts' -o -name '*.yml' -o -name '*.yaml' \) \
  -print 2>/dev/null \
  | xargs grep -l 'release\.yml@' 2>/dev/null \
  | grep -v 'pgserve-singleton-no-proxy' || true)
test -z "$LEFTOVER" || { echo "stale release.yml@ references in: $LEFTOVER"; exit 1; }
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

### Group 5: Branch-protection transition-state cutover (static, no live trial)

**Goal:** Update branch-protection required-status-checks via a transition-state ADD-then-REMOVE pattern that has zero PR-merge stall window. Use **static prediction** of the new check names — NO live trial workflow_dispatch (it would mint Sigstore Rekor entries + a real GitHub Release object + possibly advance `.well-known/latest.json`, all of which are append-only or hard to reverse).

**Predicted NEW check names** (derived from the GitHub Actions naming contract `<orchestrator-job-name> / <called-workflow-job-name> [/ <matrix-strategy>]`):
- `release / build / build (linux-x64-glibc)`
- `release / build / build (linux-x64-musl)`
- `release / build / build (linux-arm64)`
- `release / build / build (darwin-arm64)`
- `release / sign-attest / prepare`
- `release / sign-attest / provenance / generator_generic_slsa3` (SLSA reusable workflow's nested job — name may vary slightly; confirm via post-merge inspection)
- `release / sign-attest / sign (linux-x64-glibc)` (and 3 other platforms)
- `release / publish`

The orchestrator job names (`build`, `sign-attest`, `publish` — from Group 2) MUST be locked at exactly these values so the predicted names match. Group 2's acceptance criterion already pins this.

**Deliverables:**

1. **Static validation pre-merge** (replaces the live trial):
   - Run `actionlint .github/workflows/release.yml` to verify the orchestrator's YAML is structurally valid.
   - Run `actionlint .github/workflows/{build-tarballs,sign-attest,release-publish}.yml` to verify each called workflow accepts workflow_call.
   - Run `gh workflow view release.yml --ref wish/release-pipeline-collapse` to confirm GitHub Actions has registered the workflow on the branch (does NOT execute it).
   - Run `bun run -e "..."` (or equivalent yq pipeline) to verify the predicted check names CAN be derived from the orchestrator's `jobs` keys + each called workflow's `jobs` keys + each matrix strategy. If the names diverge from what's predicted, halt and update the prediction list.

2. **PR description** includes a "Branch Protection Cutover" section with five blocks:
   - **OLD required check names** (current state on `main` and `dev`, captured pre-merge via `gh api /repos/.../branches/{main,dev}/protection --jq '.required_status_checks.contexts[]'`).
   - **NEW required check names** (the predicted list above).
   - **PRE-MERGE COMMAND**: `gh api PUT /repos/.../branches/{main,dev}/protection` JSON body that ADDs new names alongside existing — `required_status_checks.contexts` becomes `[OLD ∪ NEW]`. Run by a human BEFORE clicking merge.
   - **POST-MERGE COMMAND**: `gh api PUT /repos/.../branches/{main,dev}/protection` JSON body that REMOVES obsolete names — `required_status_checks.contexts` becomes `[NEW]` only. Run by a human within 30 min of merge.
   - **NAME-DRIFT FALLBACK**: if the actual run-page check names after the first real chain firing (v4.260510.6) diverge from the predicted ones, the human runs a third `gh api PUT` to reconcile. Documented as a 30-line snippet in the PR.

3. Identify required checks the new pipeline cannot satisfy at all (e.g., a check that ran on `pull_request` but is now gated to `workflow_call` only) and explicitly remove from required AND document why in the PR description.

**Acceptance Criteria:**
- [ ] `actionlint` passes on `release.yml` and the three called workflow files.
- [ ] `gh workflow view release.yml --ref wish/release-pipeline-collapse` returns successfully (workflow registered, not executed).
- [ ] PR description has "Branch Protection Cutover" section with OLD/NEW/PRE-MERGE/POST-MERGE/NAME-DRIFT-FALLBACK blocks.
- [ ] PRE-MERGE `gh api PUT` JSON body is in the PR description, ready to copy-paste, with `required_status_checks.contexts` set to the union `[OLD ∪ NEW]`.
- [ ] POST-MERGE `gh api PUT` JSON body is in the PR description with `required_status_checks.contexts` set to `[NEW]` only.
- [ ] Branch-protection on `main` and `dev` both updated post-merge (verified by `gh api ... | jq` confirming presence of new names AND absence of old names).
- [ ] **No live `workflow_dispatch` run of `release.yml` on the wish branch.** If any exists pre-merge, it's a process violation; cancel + delete its outputs.

**Validation:**
```bash
cd /home/genie/workspace/repos/genie
# Static checks pre-merge:
actionlint .github/workflows/release.yml \
           .github/workflows/build-tarballs.yml \
           .github/workflows/sign-attest.yml \
           .github/workflows/release-publish.yml
gh workflow view release.yml --ref wish/release-pipeline-collapse > /dev/null
# PR description checks:
gh pr view <PR#> --json body -q .body | grep -qE 'PRE-MERGE.*gh api PUT'
gh pr view <PR#> --json body -q .body | grep -qE 'POST-MERGE.*gh api PUT'
gh pr view <PR#> --json body -q .body | grep -qiE 'NAME-DRIFT FALLBACK'
# No live trial workflow_dispatch on wish branch (process violation if present):
test "$(gh run list --workflow=release.yml --branch wish/release-pipeline-collapse \
        --event workflow_dispatch --limit 5 --json databaseId | jq 'length')" -eq 0
# Post-merge — both positive AND negative assertions:
for branch in main dev; do
  CONTEXTS=$(gh api /repos/automagik-dev/genie/branches/$branch/protection \
    --jq '.required_status_checks.contexts')
  test "$(echo "$CONTEXTS" | jq 'length')" -gt 0
  echo "$CONTEXTS" | jq -r '.[]' | grep -qE '^release / (build|sign-attest|publish)' \
    || { echo "NEW names missing on $branch"; exit 1; }
  if echo "$CONTEXTS" | jq -r '.[]' | grep -qE 'Sign \+ Attest Tarballs|Release Publish'; then
    echo "OLD names still present on $branch"; exit 1
  fi
done
```

**depends-on:** Group 2

---

### Group 6: Operations bundle — runbook + alert + rollback test plan

**Goal:** Ship the runbook + alert + tested rollback path in the same PR (operator P0 hard rule). Use a TESTABLE proxy for "external review" since autonomous engineers can't satisfy human-review gates.

**Deliverables:**
1. `docs/_internal/runbooks/release-pipeline.md` — ≤ 200 words. Structure: "Symptoms (chain didn't reach publish job within 30 min) → Diagnosis (find release.yml run for vX.Y.Z, identify failed job N) → Recovery (manual `gh workflow run release.yml --ref refs/tags/v<version>` or per-file `gh workflow run sign-attest.yml --field version=X --field run_id=Y` for the cross-run rescue path)". Includes inline `bash` snippets.

2. **Mechanical readability proxy** (replacing the non-deterministic Flesch criterion). The runbook MUST satisfy ALL of:
   - `wc -w` ≤ 200 (excluding code-fence content).
   - Max sentence length ≤ 20 words (split prose into sentences on `.!?`; ignore code fences).
   - Max paragraph length ≤ 5 sentences.
   - No prose word > 18 chars (excluding code fences, URLs, file paths, identifiers in backticks).
   - Each acceptance check has a deterministic awk/grep/wc-based validation script in the validation block — no manual judgment.

3. **Post-merge human review handoff:** a follow-up GitHub issue with title "Review release-pipeline runbook (cutover follow-up)", label `release-runbook-review`, assigned to Felipe. Created automatically as part of Group 6's deliverable (via `gh issue create` in the engineer's flow). This handoff is OUTSIDE the engineer's gate — existence is verified, outcome is non-blocking.

4. `release-orphan-alert.yml` — scheduled workflow (`schedule: cron: '*/30 * * * *'` + `workflow_dispatch`). Logic: enumerate `gh api /repos/.../tags?per_page=10`, enumerate `gh api /repos/.../releases?per_page=10`, find any `v*` tag older than 30 min that has no matching Release object, open a GitHub issue (label `release-incident`) with body linking to the runbook + the orphan tag name + the relevant `release.yml` run URL if any.

5. PR description "Rollback Dry-Run" section — the exact reproducer command sequence + expected outputs, validated against v4.260510.6 once it ships post-merge.

6. **Internal architecture note** (NOT in the user-facing runbook — Decision-#1-load-bearing invariant): create or update `docs/_internal/release-architecture.md` with one section: "**`sign-attest.yml` is the cosign owner-of-record.** The OIDC SAN URI for binary tarballs is bound to this file path. Cosign installer version: v2.4.1 (canonical). Future workflow files MUST NOT introduce another cosign step — duplicate cosign callers would fork the trust root. If you need to verify or test cosign behavior outside the release pipeline, do it in a script consuming this workflow's signed outputs, not by adding a parallel signing call."

**Acceptance Criteria:**
- [ ] `docs/_internal/runbooks/release-pipeline.md` exists.
- [ ] `wc -w` ≤ 200 (script extracts prose only, excludes code fences).
- [ ] Max sentence length ≤ 20 words (computed by extract-prose + sentence-split awk script).
- [ ] Max paragraph length ≤ 5 sentences.
- [ ] No prose word > 18 chars.
- [ ] Inline bash snippets pass `shellcheck` (per-fence file mode, exit-code based — see validation).
- [ ] `release-orphan-alert.yml` exists with `schedule.cron: '*/30 * * * *'`.
- [ ] `docs/_internal/release-architecture.md` exists with cosign owner-of-record note.
- [ ] Follow-up issue exists with title matching `Review release-pipeline runbook` + label `release-runbook-review`.
- [ ] PR description has "Rollback Dry-Run" section.

**Validation:**
```bash
cd /home/genie/workspace/repos/genie
RUNBOOK=docs/_internal/runbooks/release-pipeline.md
test -f "$RUNBOOK"

# 1) Word count (prose only — strip code fences first):
PROSE=$(awk 'BEGIN{in_fence=0} /^```/{in_fence=1-in_fence; next} !in_fence{print}' "$RUNBOOK")
WORDS=$(echo "$PROSE" | wc -w)
test "$WORDS" -le 200 || { echo "runbook prose has $WORDS words (>200)"; exit 1; }

# 2) Sentence-length cap (max 20 words per sentence):
echo "$PROSE" | tr -s '\n' ' ' | grep -oE '[^.!?]+[.!?]' \
  | awk '{ if (NF > 20) { print "long sentence (" NF " words):", $0; exit 1 } }'

# 3) Paragraph-length cap (max 5 sentences per paragraph; paragraph = blank-line separated):
echo "$PROSE" | awk -v RS='' '{ n = gsub(/[.!?]/, "&"); if (n > 5) { print "paragraph >5 sentences"; exit 1 } }'

# 4) Word-length cap (no prose word > 18 chars; URLs and backticked identifiers stripped):
echo "$PROSE" | sed -E 's|https?://[^ ]+| |g; s|`[^`]*`| |g' | tr -s ' \n' '\n' \
  | awk 'length > 18 { print "long word:", $0; exit 1 }'

# 5) Per-fence shellcheck (exit-code based, one fence per file):
mkdir -p /tmp/runbook-fences && rm -f /tmp/runbook-fences/*.sh
awk -v out=/tmp/runbook-fences '
  /^```bash$/ { capturing=1; n++; close(file); file=sprintf("%s/fence-%d.sh", out, n); print "#!/usr/bin/env bash" > file; next }
  /^```$/ && capturing { capturing=0; next }
  capturing { print > file }
' "$RUNBOOK"
for f in /tmp/runbook-fences/*.sh; do
  shellcheck -s bash "$f" || { echo "shellcheck failed on $f"; exit 1; }
done

# 6) Alert workflow:
test -f .github/workflows/release-orphan-alert.yml
test "$(yq '.on.schedule[0].cron' .github/workflows/release-orphan-alert.yml)" = "*/30 * * * *"

# 7) Architecture note:
test -f docs/_internal/release-architecture.md
grep -q 'cosign owner-of-record' docs/_internal/release-architecture.md
grep -q 'v2.4.1' docs/_internal/release-architecture.md

# 8) Follow-up issue:
gh issue list --label release-runbook-review --limit 1 --json title -q '.[].title' \
  | grep -qiE 'review release-pipeline runbook'

# 9) PR description rollback section:
gh pr view <PR#> --json body -q .body | grep -qiE 'rollback dry-run'
```

**depends-on:** Group 2

---

### Group 7: CHANGELOG + cosign single-owner verification

**Goal:** Document the v4.260510.5 abandonment. Verify cosign installer version is single-sourced post-Group-2 (since `release.yml`'s npm-pack jobs — which carried the divergent v2.2.4 — are deleted, no reconciliation work is actually required; this Group just confirms the natural consequence held).

**Deliverables:**
1. `CHANGELOG.md` v4.260510.5 abandonment entry (one line at top of unreleased): `- **v4.260510.5 (skipped):** build artifacts existed (run 25619912030) but never received a signed release due to GITHUB_TOKEN workflow_run anti-recursion blocker; superseded by v4.260510.6 via the new release.yml workflow_call orchestrator (wish: release-pipeline-collapse).`
2. Confirm `sign-attest.yml` is the only workflow file that calls `sigstore/cosign-installer`. The cosign owner-of-record note belongs in `docs/_internal/release-architecture.md` (created by Group 6, not in the user-facing runbook).

**Acceptance Criteria:**
- [ ] CHANGELOG.md contains the v4.260510.5 abandonment entry referencing run 25619912030.
- [ ] `sign-attest.yml` cosign installer is unchanged at v2.4.1.
- [ ] Exactly ONE workflow file references `cosign-installer` post-Group-2 (it must be `sign-attest.yml`).
- [ ] `docs/_internal/release-architecture.md` (from Group 6) names `sign-attest.yml` as the cosign owner-of-record.

**Validation:**
```bash
cd /home/genie/workspace/repos/genie
grep -q '4\.260510\.5' CHANGELOG.md
grep -q '25619912030' CHANGELOG.md
test "$(grep -lE 'sigstore/cosign-installer' .github/workflows/*.yml | wc -l)" -eq 1
grep -lE 'sigstore/cosign-installer' .github/workflows/*.yml | grep -qF '.github/workflows/sign-attest.yml'
grep -q "cosign-release: 'v2.4.1'" .github/workflows/sign-attest.yml
grep -q 'sign-attest.yml.*cosign owner-of-record' docs/_internal/release-architecture.md
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
| `workflow_call` permission inheritance gotcha — orchestrator job missing `id-token: write` causes cosign to fail at minute 12 after build matrix burns | High | Decision #7 + Group 2 explicit per-job `permissions:` block on the orchestrator side; Decision #7 INTERSECTION model + Group 1 acceptance confirm `sign-attest.yml`'s inner per-job permissions are unchanged from current state (which already declares all needed scopes for the standalone workflow_dispatch path). |
| SLSA generator's `contents: write` requirement (#1740) doesn't transfer cleanly to the new caller | Medium | Group 1 + Group 2: the `sign-attest.yml` `provenance` job retains its existing reviewer-grade comment block from #1740. Caller (`release.yml` orchestrator's `sign-attest` job) declares `contents: write` to satisfy the cap. |
| External consumers pinned to v4.260510.5 (Renovate/Dependabot/lockfiles) get 404 after abandonment | Medium | Decision #2 + CHANGELOG entry. Document in runbook. v4.260510.5 was never a real release; the resolution failure is correct. |
| Second-hop workflow_run anti-recursion was actually two hops (build → sign → publish), not one — the council description simplified | Medium | This wish collapses ALL workflow_run usage into needs:-chained workflow_call. Both hops gone simultaneously. Validation Group 1 grep confirms no workflow_run remaining. |
| `[skip ci]` shadow on the wish-merge commit causes version.yml to not run — pipeline never fires post-merge | Medium | QA Criterion verifies merge commit message. If shadow exists, manual `gh workflow run version.yml --ref dev` recovers; document in runbook. |
| Cosign installer version divergence (v2.2.4 vs v2.4.1) leaves only one survivor; older bundle format incompatibilities | Low | Group 7 reconciles to v2.4.1 (newer). sign-attest.yml IS the cosign-bearing file — `release.yml` orchestrator no longer needs cosign, so divergence ceases naturally. |
| `pgserve-singleton-no-proxy` references stale `release.yml@` — its trust list is in the pgserve repo, not genie | Low | Out-of-scope for this wish. Filed as follow-up: `pgserve-trust-list-cleanup` wish in pgserve repo. genie wish files in `.genie/wishes/pgserve-singleton-no-proxy/*` are historical, not consumed by runtime. |
| (Reviewer L2 CRITICAL — RESOLVED) Group 5 trial would have produced real Sigstore Rekor entries (append-only) + real Release object + possibly advance latest.json | (resolved) | Group 5 redesigned to use static checks only (`actionlint` + `gh workflow view`) + predicted check names. NO live `workflow_dispatch` of `release.yml` on the wish branch is permitted; validation explicitly asserts zero such runs exist. Real chain firing is deferred to v4.260510.6 post-merge. NAME-DRIFT FALLBACK in PR description handles the case where predicted names don't match actual names. |
| Decision #1's "no verifier breaks" claim is now SOUND but only because cosign step stays put — if a future refactor moves it, the verifier ecosystem breaks | Low | Decision #8 + Group 4 make the verifier-coherence cleanup a load-bearing invariant. The cosign owner-of-record fact is documented in `docs/_internal/release-architecture.md` (Group 6 deliverable 6) — internal-facing, not in the user-facing runbook. |

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
