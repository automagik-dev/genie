# Release pipeline collapse — workflow_call orchestrator

Closes wish [`release-pipeline-collapse`](.genie/wishes/release-pipeline-collapse/WISH.md).

## Summary

Replaces the broken `workflow_run`-chained release pipeline (`build-tarballs.yml` → `sign-attest.yml` → `release-publish.yml`, suppressed by the GITHUB_TOKEN anti-recursion guard) with a `workflow_call`-orchestrated chain. `release.yml` is repurposed as a thin orchestrator that calls the three reusable workflows in one synchronous run. Cosign signing stays in `sign-attest.yml` (Decision #1) so the OIDC SAN URI binary tarballs ship with — `sign-attest.yml@<ref>` — is unchanged; `install.sh:24` keeps working without modification. 7 stale `release.yml@`-pinned verifier references are repinned to `sign-attest.yml@` in the same PR (G4).

## Commits in this PR

| Group | Subject |
|-------|---------|
| G1 | `feat(release): add workflow_call triggers to build-tarballs/sign-attest/release-publish (G1)` |
| G2 | `feat(release): repurpose release.yml as workflow_call orchestrator (G2)` |
| G3 | `feat(release): version.yml dispatches release.yml orchestrator (G3)` |
| G4 | `fix(security): repin cosign cert identity to sign-attest.yml@ (G4 — verifier-coherence cleanup)` |
| G7 | `docs(changelog): document v4.260510.5 abandonment + verify cosign single-owner (G7)` |
| G6 | `docs(release): runbook + tag-orphan alert + cosign owner-of-record arch note (G6)` |
| G5 | `docs(release): static branch-protection cutover plan + PR description (G5)` |

## Static validation status

- **actionlint:** clean on `.github/workflows/release.yml`, `build-tarballs.yml`, `sign-attest.yml`, `release-publish.yml`, `release-orphan-alert.yml`.
- **`gh workflow view release.yml --ref wish/release-pipeline-collapse`:** workflow registered.
- **No live `workflow_dispatch` runs on the wish branch:** confirmed via `gh run list --workflow=release.yml --branch wish/release-pipeline-collapse --event workflow_dispatch --limit 5` → `[]`.

## Branch-protection cutover

**Current state (captured 2026-05-10):** Neither `main` nor `dev` has branch protection enabled — `gh api /repos/automagik-dev/genie/branches/{main,dev}/protection` returns `404 Branch not protected` on both. There is no OLD set of `required_status_checks.contexts` to preserve.

This simplifies the cutover. The wish anticipated an ADD-then-REMOVE transition window (reviewer HIGH-4) that mitigated a PR-merge stall risk when transitioning between OLD and NEW required check names. With no protection enabled, that risk doesn't exist for this PR.

### OLD (pre-cutover required check names — empty)

```
[]
```

### NEW (post-cutover required check names)

Derived from the orchestrator's job topology — `release.yml` has 3 `uses:` jobs (`build`, `sign-attest`, `publish`) which expand to the inner workflows' job matrices under workflow_call. GitHub renders nested check names as `<caller-job> / <called-workflow-job> / <called-workflow-matrix-instance>`.

Predicted NEW context names:

```
release / build / build (linux-x64-glibc)
release / build / build (linux-x64-musl)
release / build / build (linux-arm64)
release / build / build (darwin-arm64)
release / sign-attest / prepare
release / sign-attest / provenance
release / sign-attest / sign (linux-x64-glibc)
release / sign-attest / sign (linux-x64-musl)
release / sign-attest / sign (linux-arm64)
release / sign-attest / sign (darwin-arm64)
release / publish
```

The `provenance` name may drift to `release / sign-attest / provenance / generator_generic_slsa3` because the nested SLSA generator reusable workflow registers its own check name when triggered through workflow_call. The NAME-DRIFT-FALLBACK below handles this case.

### PRE-MERGE `gh api PUT` body (when branch protection is enabled)

This step is **a no-op today** since neither branch has protection. If branch protection is enabled before the cutover lands, run this once per branch (`main` and `dev`) before merging the PR to install the new check names alongside any existing ones:

```bash
BRANCH=main  # then repeat for dev
gh api -X PUT "/repos/automagik-dev/genie/branches/${BRANCH}/protection/required_status_checks" \
  -F strict=true \
  -f 'contexts[]=release / build / build (linux-x64-glibc)' \
  -f 'contexts[]=release / build / build (linux-x64-musl)' \
  -f 'contexts[]=release / build / build (linux-arm64)' \
  -f 'contexts[]=release / build / build (darwin-arm64)' \
  -f 'contexts[]=release / sign-attest / prepare' \
  -f 'contexts[]=release / sign-attest / provenance' \
  -f 'contexts[]=release / sign-attest / sign (linux-x64-glibc)' \
  -f 'contexts[]=release / sign-attest / sign (linux-x64-musl)' \
  -f 'contexts[]=release / sign-attest / sign (linux-arm64)' \
  -f 'contexts[]=release / sign-attest / sign (darwin-arm64)' \
  -f 'contexts[]=release / publish'
```

### POST-MERGE `gh api PUT` body (when branch protection is enabled)

If OLD check names had been added to the protection set pre-cutover, run this once per branch after the PR merges to drop the obsolete standalone names. Today this PUT body is identical to PRE-MERGE since there is no OLD set; keep this section as the canonical NEW set for any future re-baseline.

```bash
BRANCH=main  # then repeat for dev
gh api -X PUT "/repos/automagik-dev/genie/branches/${BRANCH}/protection/required_status_checks" \
  -F strict=true \
  -f 'contexts[]=release / build / build (linux-x64-glibc)' \
  -f 'contexts[]=release / build / build (linux-x64-musl)' \
  -f 'contexts[]=release / build / build (linux-arm64)' \
  -f 'contexts[]=release / build / build (darwin-arm64)' \
  -f 'contexts[]=release / sign-attest / prepare' \
  -f 'contexts[]=release / sign-attest / provenance' \
  -f 'contexts[]=release / sign-attest / sign (linux-x64-glibc)' \
  -f 'contexts[]=release / sign-attest / sign (linux-x64-musl)' \
  -f 'contexts[]=release / sign-attest / sign (linux-arm64)' \
  -f 'contexts[]=release / sign-attest / sign (darwin-arm64)' \
  -f 'contexts[]=release / publish'
```

### NAME-DRIFT-FALLBACK

GitHub renders nested workflow_call check names from the actual job IDs at runtime. If a job ID we predicted above doesn't match the rendered name once `release.yml` fires for real (e.g. the SLSA reusable workflow registers a longer path like `release / sign-attest / provenance / generator_generic_slsa3`), the protection PUT will accept the prediction but the merge will block on a check that never reports. Recovery:

1. Run `gh run list --workflow=release.yml --branch <next-tag> --json databaseId,name --limit 1` to find the firing run.
2. Then `gh run view <id> --json jobs --jq '.jobs[].name'` to enumerate the exact rendered names.
3. Re-PUT `required_status_checks.contexts` with the corrected names.

The runbook (`docs/_internal/runbooks/release-pipeline.md`) covers the same Symptoms → Diagnosis → Recovery flow for general orchestrator failures.

## Rollback dry-run

After the natural firing has produced the v4.260510.6 GitHub Release, an operator dry-run of:

```bash
gh workflow run release.yml --ref refs/tags/v4.260510.6 --field version=4.260510.6 --repo automagik-dev/genie
```

…should either be idempotent (re-upload + clobber existing assets) or fail with a clear "release already exists" message from `gh release create` — never duplicate assets. Operator verifies via `gh release view v4.260510.6 --json assets --jq '.assets | length'` returning 12 before and after.

## Outstanding concerns (carried over from per-group reports)

- **Orchestrator passes v-prefixed version to sign-attest under tag push.** `release.yml`'s `version: ${{ github.ref_type == 'tag' && github.ref_name || inputs.version }}` evaluates to `v4.260510.6` on tag push. `sign-attest.yml`'s prepare step parses bare `4.260510.6` from artifact filenames and validates equality. Two acceptable resolutions: (a) strip `v` inside sign-attest's prepare step; (b) drop `with.version` from the orchestrator and let sign-attest derive it. The current code as written will hard-fail on the first real tag-push firing — operators must work around via `workflow_dispatch` until either fix lands.
- ~~**sign-attest and release-publish prepare bodies still require `run_id`.**~~ **RESOLVED** in fix-loop commit (this PR): both files now default `RUN_ID="${{ github.run_id }}"` when `inputs.run_id` is empty (workflow_call path). workflow_dispatch break-glass path still consumes the operator-supplied `inputs.run_id` for cross-run rescue.
- ~~**release.yml passes v-prefixed version to sign-attest on tag push.**~~ **RESOLVED**: `with.version:` removed from the orchestrator's sign-attest call entirely. sign-attest.yml derives bare version from artifact filenames (line 124), eliminating the prefix mismatch.
- **CHANGELOG.md v4.260510.5 entry uses an "Unreleased > Skipped" heading.** Final shipping section may move it to the version-specific section once v4.260510.6 cuts.
- ~~**G4 didn't include `.well-known/security.txt:28` or `.github/cosign.pub:12`.**~~ **RESOLVED** in fix-loop commit: both repinned to `sign-attest.yml@`. `scripts/check-fingerprint-pinning.sh` now exits 0 across all 4 witnesses.
- ~~**`.genie/runbooks/release-pipeline.md` lives in-repo, not in the docs submodule.**~~ **RESOLVED**: runbook + arch doc moved into the `automagik-dev/docs` submodule and reach the genie repo via the `docs/` symlink at `docs/_internal/runbooks/release-pipeline.md` + `docs/_internal/release-architecture.md`. Companion PR: [automagik-dev/docs#71](https://github.com/automagik-dev/docs/pull/71). This wish PR bumps the `.docs-vendor` submodule pointer to the commit on that branch — once #71 lands on docs main, the pointer remains valid (the commit is reachable from main).
- **Follow-up review issue (`release-runbook-review`) was NOT auto-created.** Claude Code's auto-mode classifier blocked the `gh issue create` call because the assignee identity was inferred from a tool lookup (`Felipe` → `filipexyz`) rather than user-specified. The reviewer or team-lead can create it with the body drafted in G6's commit message.

🤖 Wish execution: G1 → G2 → G3 → G4 → G7 → G6 → G5 (atomic-per-group commits).
