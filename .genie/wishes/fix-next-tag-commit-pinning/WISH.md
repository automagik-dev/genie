# Wish: Pin @next npm publish to triggering commit, not branch HEAD

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `fix-next-tag-commit-pinning` |
| **Date** | 2026-04-28 |
| **Author** | Felipe Rosa (housekeep pass) |
| **Appetite** | small |
| **Branch** | `wish/fix-next-tag-commit-pinning` |
| **Repos touched** | `automagik-dev/genie` |
| **Linked issue** | [#1303](https://github.com/automagik-dev/genie/issues/1303) |
| **Design** | _No brainstorm — direct wish_ |

## Summary

`.github/workflows/version.yml` checks out `dev` (or `main`) by branch name when triggered by `workflow_run`, so back-to-back merges race: a slow Version run can publish PR A's bundle but tag PR B's commit, leaving `npm view @automagik/genie@next version` advertising a commit that no longer matches the build users actually install. This wish pins the checkout to `github.event.workflow_run.head_sha`, keeps the concurrency group per-branch with `cancel-in-progress: true` so newer Version runs supersede older in-flight runs, keeps `workflow_dispatch` working, and adds a post-merge audit so future `@next`-vs-tag drift is caught automatically rather than via 10-minute blind dogfood debugging.

**Invariant chosen:** Invariant A (correctness over completeness). `@next` always points at the commit that just passed CI. Version runs are serialized per branch; when dev advances during a Version run (back-to-back merges), the older run is cancelled or skips publish, and the newer merge's run catches up and publishes. The git-tag ledger is 1:1 with `@next`-published builds, not 1:1 with merges.

## Scope

### IN

- Change `actions/checkout@v4` `with: ref:` in `.github/workflows/version.yml` from the resolved branch (`steps.context.outputs.branch`) to `github.event.workflow_run.head_sha`, with a sane fallback for `workflow_dispatch` (default to current branch HEAD when no `head_sha` is available).
- Keep `concurrency.group` per-branch (`version-${{ github.event.workflow_run.head_branch OR 'manual' }}`) and add `cancel-in-progress: true` so a newer Version run cancels the older in-flight run for the same branch. This serializes Version runs per branch and prevents stale builds from publishing.
- Confirm the version-derivation, commit, tag, and push steps still work when checkout is pinned to a SHA: `git push --atomic origin "HEAD:refs/heads/${BRANCH}" "refs/tags/v${VERSION}"` will fail fast if `dev` advanced past the SHA — that is the desired behavior (skip rather than misattribute).
- Detector + post-merge audit script for `release-race.next-tag-mismatch.detected`: a v2 detector that resolves the parent commit of the latest `vX.Y.Z` tag, compares against `gh pr view --json mergeCommit` for the most recent merged PR on dev, and fires when they diverge.

### OUT

- Full release-pipeline rewrite (release.yml, marketplace publish flow, GitHub Release authoring) — only `version.yml` is in play here.
- npm provenance / sigstore / signing changes — separate scope, tracked under `distribution-sovereignty`.
- Reworking the dev→main merge-commit detection logic in the `if:` guard — only the checkout ref and concurrency group change.
- Auto-rollback or auto-deprecation of mistagged `@next` releases — out of band; this wish is observability + prevention only.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Checkout `head_sha` instead of branch name | Branch HEAD is a moving target during back-to-back merges; the SHA that triggered CI is the only commit we know passed. Pinning eliminates the race at its source. |
| 2 | Concurrency group keyed on **branch** with `cancel-in-progress: true` (newer runs supersede older). NOT per-SHA. | Per-SHA concurrency allows cross-commit parallel publish that can collide on the same next version (Codex flag). Per-branch with cancellation serializes Version runs per branch and lets a back-to-back merge cancel the in-flight older run, so we never publish a stale build. Trade-off: rare merges with overlapping CI windows mean the older run's `@next` publish is skipped — acceptable, since the build is identical to or strictly before the newer one. |
| 3 | `workflow_dispatch` keeps current behavior (HEAD of dispatched branch) | Manual dispatch is rare and operator-driven; falling back to `github.sha` (the dispatched ref's HEAD) preserves today's UX without adding new flags. |
| 4 | Pick Invariant A (correctness): `@next` always points at the commit that just passed CI; older runs supersede when dev advances. Drop Invariant B (every merge gets a tag). | The bug being fixed is `@next` misadvertising a sibling commit's build. Serialization fixes that directly. "Every merge gets a distinct tag" is a niceness, not a correctness requirement — the git-tag ledger has to be 1:1 with `@next`-published builds, not 1:1 with merges. |
| 5 | Detector is required, not optional, and ships independently of Group 1 | The detector audits live state regardless of how `@next` got there, so it's meaningful before the workflow fix lands too. Making it independent makes it cheap and lets it document the regression we're trying to prevent. |

## Success Criteria

- [ ] `.github/workflows/version.yml` checkout step uses `ref: ${{ github.event.workflow_run.head_sha || github.sha }}` (or equivalent expression that pins to the triggering commit).
- [ ] `concurrency.group` stays per-branch (`version-${{ github.event.workflow_run.head_branch OR 'manual' }}`) and `cancel-in-progress: true` is set so newer Version runs cancel older in-flight runs.
- [ ] Manual `workflow_dispatch` on dev still successfully bumps + tags + publishes `@next` (validated on a throwaway commit).
- [ ] When dev advances during a Version run (back-to-back merges), the run skips publish (no bump, no tag, no `@next` change). The next merge's run catches up and publishes. Validated by inspecting that `@next` always resolves to a tag whose parent equals the latest dev SHA at publish time.
- [ ] Detector script exits non-zero (or emits the v2 event) when `npm view @automagik/genie@next version` resolves to a tag whose parent ≠ the latest dev merge commit.

## Execution Strategy

### Wave 1 (parallel)

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Workflow change: pin checkout + per-branch concurrency with `cancel-in-progress: true` + manual-dispatch fallback. |
| 2 | engineer | Detector + audit script for `release-race.next-tag-mismatch.detected`. |

Both groups can run in parallel; detector ships first if cheaper.

## Execution Groups

### Group 1: Workflow change + verification

**Goal:** Eliminate the back-to-back-merge race by pinning Version-workflow checkout to the triggering commit's SHA and serializing Version runs per branch with cancel-in-progress.

**Deliverables:**
1. `.github/workflows/version.yml`: `actions/checkout@v4` `with.ref` updated to `${{ github.event.workflow_run.head_sha || github.sha }}` — see exact diff below.
2. `.github/workflows/version.yml`: `concurrency.group` stays as `version-${{ github.event.workflow_run.head_branch || 'manual' }}` (per-branch, NOT per-SHA), but flip `cancel-in-progress` from `false` to `true` so a newer Version run cancels the older in-flight run for the same branch — see exact diff below.
3. `.github/workflows/version.yml`: top-of-file comment block extended with the SHA-pin invariant ("Version always tags the commit that passed CI, never branch HEAD; per-branch concurrency with cancel-in-progress means older runs supersede when dev advances") so future edits don't regress.
4. `.github/workflows/version.yml`: the `Commit and tag` step's `git push --atomic` failure path emits a structured, grep-able log line (`::notice ::release-race.next-tag-pin-skipped.detected dev advanced past triggering SHA <SHORT_SHA>; @next publish skipped — next merge will republish`) so the skip path is visible in CI logs and can be detected by Group 2's audit script. Wrap the push in `if ! git push --atomic ...; then echo "::notice ..."; exit 0; fi` so the workflow exits success (the skip is intentional, not a failure).
5. Non-destructive validation FIRST (see Validation block): `actionlint` (or python yaml fallback) + grep checks + a `workflow_dispatch` dry-run on the wish branch (`wish/fix-next-tag-commit-pinning`) where the bump commit + tag stay on the wish branch and are NOT merged. Only after green: optional manual smoke `gh workflow run version.yml --ref dev` on a known-quiet dev tip.

**Exact YAML diffs (apply these literally):**

```diff
 concurrency:
   group: version-${{ github.event.workflow_run.head_branch || 'manual' }}
-  cancel-in-progress: false
+  cancel-in-progress: true
```

```diff
       - uses: actions/checkout@v4
         with:
-          ref: ${{ steps.context.outputs.branch }}
+          # Pin to the SHA that triggered CI, not the moving branch HEAD,
+          # so back-to-back merges never publish a sibling commit's build.
+          # workflow_dispatch has no workflow_run.head_sha — fall back to
+          # github.sha (the dispatched ref's HEAD).
+          ref: ${{ github.event.workflow_run.head_sha || github.sha }}
           fetch-depth: 0
           token: ${{ secrets.GITHUB_TOKEN }}
```

```diff
       - name: Commit and tag
         if: steps.context.outputs.should_bump == 'true'
         run: |
           VERSION="${{ steps.version.outputs.version }}"
           BRANCH="${{ steps.context.outputs.branch }}"

           git add -A '*.json' 'src/lib/version.ts'
           if git diff --cached --quiet; then
             echo "No version changes to commit"
           else
             git commit -m "chore(version): bump to ${VERSION} [auto-version]"
           fi

           git tag "v${VERSION}"
-          git push --atomic origin "HEAD:refs/heads/${BRANCH}" "refs/tags/v${VERSION}"
+          # If dev advanced past the SHA we checked out, --atomic rejects
+          # the push. That's the desired Invariant A behavior: skip publish
+          # rather than mis-tag. Emit a structured notice so the skip is
+          # visible in CI logs and detector-greppable.
+          SHORT_SHA="${GITHUB_SHA:0:7}"
+          if ! git push --atomic origin "HEAD:refs/heads/${BRANCH}" "refs/tags/v${VERSION}"; then
+            echo "::notice ::release-race.next-tag-pin-skipped.detected dev advanced past triggering SHA ${SHORT_SHA}; @next publish skipped — next merge will republish"
+            # Tag locally so subsequent steps know to skip publish.
+            echo "PUBLISH_SKIPPED=true" >> "$GITHUB_ENV"
+            exit 0
+          fi
```

The `Build CLI`, `Resolve publish version`, and `Publish to npm via OIDC` steps must each gain `if: env.PUBLISH_SKIPPED != 'true'` so the workflow short-circuits cleanly after a skip.

**Acceptance Criteria:**
- [ ] Static check 1a: checkout `ref:` is pinned to `head_sha` (separate grep from concurrency).
- [ ] Static check 1b: `concurrency:` block contains `cancel-in-progress: true` (separate grep from ref).
- [ ] Static check 1c: skip path emits `release-race.next-tag-pin-skipped.detected` notice (grep for the literal event name in `version.yml`).
- [ ] YAML/expression validation passes: `actionlint .github/workflows/version.yml` if available locally, otherwise `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/version.yml'))"` as fallback (actionlint is NOT installed by default — do not block on it).
- [ ] Non-destructive dispatch: `gh workflow run version.yml --ref wish/fix-next-tag-commit-pinning` succeeds, tag `vX.Y.Z` is created on the wish branch (not dev), tag's parent SHA equals the dispatched SHA. Tag is deleted post-validation (`git tag -d` + `git push --delete origin v...`).
- [ ] Optional destructive smoke (only if non-destructive passed): `gh workflow run version.yml --ref dev` on a quiet dev tip; new tag's parent SHA equals dispatched SHA; `npm view @automagik/genie@next version` matches the new tag within ~60s.

**Validation:**
```bash
# 1a. Static check: ref pinned to head_sha
grep -E "ref:\s*\\\${{\s*github\.event\.workflow_run\.head_sha" .github/workflows/version.yml || \
  { echo "FAIL: checkout ref is not pinned to head_sha"; exit 1; }

# 1b. Static check: concurrency keys on branch with cancel-in-progress: true
grep -A 1 "concurrency:" .github/workflows/version.yml | grep -q "cancel-in-progress:\s*true" || \
  { echo "FAIL: cancel-in-progress not set"; exit 1; }

# 1c. Static check: skip path emits structured notice
grep -q "release-race.next-tag-pin-skipped.detected" .github/workflows/version.yml || \
  { echo "FAIL: skip path notice missing"; exit 1; }

# 2. YAML/expression lint (best-effort; actionlint NOT installed locally,
# so always fall back to python yaml parse — never fail the gate on a
# missing actionlint binary).
if command -v actionlint >/dev/null 2>&1; then
  actionlint .github/workflows/version.yml
else
  python3 -c "import yaml; yaml.safe_load(open('.github/workflows/version.yml'))" && \
    echo "actionlint unavailable; YAML parse OK (fallback)"
fi

# 3a. NON-DESTRUCTIVE dispatch on the wish branch first.
# This bumps + tags on `wish/fix-next-tag-commit-pinning` only, NOT dev.
# Cleanup: delete the synthetic tag locally + remotely after asserting parent.
git fetch origin wish/fix-next-tag-commit-pinning
DISPATCHED_SHA=$(git rev-parse origin/wish/fix-next-tag-commit-pinning)
gh workflow run version.yml --ref wish/fix-next-tag-commit-pinning
# wait for completion (poll `gh run list --workflow=version.yml --limit=1`), then:
git fetch --tags
NEW_TAG=$(git tag --sort=-creatordate --list 'v4.*' | head -1)
TAG_PARENT=$(git rev-parse "${NEW_TAG}^")
[ "${TAG_PARENT}" = "${DISPATCHED_SHA}" ] || \
  { echo "FAIL: tag ${NEW_TAG} parent ${TAG_PARENT} != dispatched ${DISPATCHED_SHA}"; exit 1; }
echo "PASS (non-destructive): ${NEW_TAG} pinned to ${DISPATCHED_SHA}"
# Cleanup the synthetic tag (do NOT leave it advertised on @next).
# Note: the workflow will have published it as @next — operator must
# manually `npm dist-tag` rollback or accept the temporary blip on a
# wish branch test. Document this trade-off when running the test.
git tag -d "${NEW_TAG}"
git push origin --delete "${NEW_TAG}"

# 3b. OPTIONAL destructive smoke (only after 3a green, only on a quiet dev tip).
# DISPATCHED_SHA=$(git rev-parse origin/dev)
# gh workflow run version.yml --ref dev
# (same parent-assertion as above)
```

**depends-on:** none

---

### Group 2: `release-race.next-tag-mismatch.detected` detector

**Goal:** Add a post-merge audit that catches `@next`-vs-tag drift if the workflow regression returns or a new race emerges, without blocking releases. Independent of Group 1 — the detector audits live state regardless of how `@next` got there, so it documents the regression we're trying to prevent and ships first if cheaper.

**Deliverables:**
1. Detector spec / event type registered (v2 detector convention) named `release-race.next-tag-mismatch.detected` with severity Medium. Also document the companion event `release-race.next-tag-pin-skipped.detected` (Group 1 emits this from the workflow).
2. Audit script (location: `scripts/audit-next-tag-pinning.sh`) that:
   - Validates required tools at startup (`npm`, `gh`, `git`, `jq`) and exits with a clear `MISSING_TOOL` message + exit code 2 (distinct from drift exit code 1) if any are absent. CI must install them explicitly.
   - Queries `npm view @automagik/genie@next version` to resolve the currently advertised version → corresponding `vX.Y.Z` tag. On `npm view` network/registry error: exit 0 with a `SKIP: npm registry unreachable` notice (audit is non-blocking).
   - Resolves that tag's parent commit via `git rev-parse <tag>^`.
   - Resolves the most recent merged PR on dev via `gh pr list --state merged --base dev --limit 1 --json mergeCommit`.
   - Fires the v2 event `release-race.next-tag-mismatch.detected` (writes a JSON line to stdout matching the v2 schema, including npm-advertised version, tag parent SHA, and most-recent merge SHA) and exits 1 when the two diverge. Exits 0 with a `PASS` line when they match.
   - Synthetic regression hook: when env vars `FAKE_NEXT_TAG` + `FAKE_NEXT_PARENT` are set, skip live npm/gh queries and use those values instead, so the script's drift path is testable without touching the registry.
3. Wire-up: invoke the audit in a non-blocking nightly workflow (new file `.github/workflows/audit-next-tag.yml`) AND as a post-publish step in `version.yml` (informational only — does not fail the publish). The nightly workflow MUST install dependencies explicitly:

   ```yaml
   - uses: actions/setup-node@v4
     with: { node-version: '22' }
   - run: sudo apt-get update && sudo apt-get install -y jq
   # gh is preinstalled on GitHub runners
   - run: bash scripts/audit-next-tag-pinning.sh
     continue-on-error: true
   ```

**Acceptance Criteria:**
- [ ] Audit script runs locally with `bash scripts/audit-next-tag-pinning.sh` and exits 0 on a healthy state.
- [ ] Missing-tool path: temporarily renaming `jq` (or simulating absence via `PATH=`) produces exit code 2 with a `MISSING_TOOL: jq` message.
- [ ] Network-error path: `bash scripts/audit-next-tag-pinning.sh` with a non-routable npm registry (`NPM_REGISTRY=https://localhost:1` env override) exits 0 with `SKIP: npm registry unreachable`.
- [ ] Synthetic regression (`FAKE_NEXT_TAG=v4.999999.1 FAKE_NEXT_PARENT=$(git rev-parse HEAD~5) bash scripts/audit-next-tag-pinning.sh`) produces exit code 1 with a `release-race.next-tag-mismatch.detected` JSON event line naming both SHAs.
- [ ] Detector documented in `docs/_internal/detectors/release-race.md` alongside other v2 detectors (if that directory exists; otherwise a comment block at the script head suffices).
- [ ] Nightly workflow `.github/workflows/audit-next-tag.yml` exists and includes explicit `apt-get install -y jq` + `setup-node` steps; uses `continue-on-error: true`.

**Validation:**
```bash
# Healthy path (current state, post Group 1)
bash scripts/audit-next-tag-pinning.sh && echo "PASS: no drift"

# Synthetic regression: point a fake @next-equivalent at a wrong SHA and confirm the script catches it.
# (Run inside a throwaway branch; do not push.)
EXPECTED_FAIL=1 \
  FAKE_NEXT_TAG="v4.999999.1" \
  FAKE_NEXT_PARENT="$(git rev-parse HEAD~5)" \
  bash scripts/audit-next-tag-pinning.sh; \
  [ $? -ne 0 ] && echo "PASS: detector fired" || { echo "FAIL: detector silent"; exit 1; }
```

**depends-on:** none

> _The detector audits live state and is meaningful before the workflow fix lands too — it documents the regression we're trying to prevent._

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] **Functional:** A `workflow_dispatch` of `version.yml` on dev produces a new `vX.Y.Z` tag whose parent commit equals the dispatched SHA, and `npm view @automagik/genie@next version` reflects the new version within ~1 minute.
- [ ] **Integration (Invariant A):** When two PRs merge to dev within ≤2 minutes (overlapping CI windows), the older Version run is cancelled or skips publish (no bump, no tag, no `@next` change), and the newer merge's run publishes a `vX.Y.Z` tag whose parent equals the newer merge commit. Verified by inspecting `@next` version → tag → parent SHA against the latest dev merge commit.
- [ ] **Regression:** `main`-branch behavior (no bump, publish current `package.json` as `@latest`) is unchanged — verified by triggering a dev→main merge and confirming `package.json` version is the value published as `@latest` and matches the GitHub Release tag.
- [ ] **Detector:** Audit script exits 0 on healthy state; synthetic mismatch test exits non-zero and the v2 event payload includes both the npm-advertised version and the actual most-recent merge SHA.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Pinning checkout to `head_sha` makes `git push --atomic origin "HEAD:refs/heads/dev"` reject when dev advanced during the run. | Medium | Desired outcome (Invariant A): skip the publish rather than mis-tag. Add explicit error-path messaging so the failure is legible in CI logs ("dev advanced past triggering SHA; @next publish skipped — next merge will republish"). |
| `workflow_dispatch` has no `workflow_run.head_sha`, only `github.sha`. | Low | See note below the table — the fallback chain covers both trigger types. |
| Detector adds a network dependency on `npm view`. | Low | Make the audit non-blocking (informational), retry with timeout, and skip on registry errors — never fail a release for an audit hiccup. |
| Workflow YAML expression typo silently disables the pin. | Medium | Add `grep`-based assertion in the validation step (Group 1) that fails if `ref:` is not pinned to `head_sha` and that `cancel-in-progress: true` is not present. Use separate static checks (1a + 1b) to avoid false negatives. |
| Group 1 manual smoke (`gh workflow run`) bumps the version on dev | Low | Run on a quiet dev tip; back-out by force-pushing the bump commit if rejected during review. Default validation path is non-destructive on `wish/fix-next-tag-commit-pinning` first; destructive smoke on dev is OPTIONAL and only after non-destructive passes. |
| Skip-on-stale-push is silent — operator can't tell whether a missing publish is a skip or a workflow failure. | Medium | Group 1 emits a structured `::notice ::release-race.next-tag-pin-skipped.detected ...` log line in version.yml when `git push --atomic` rejects, AND short-circuits the publish steps via `PUBLISH_SKIPPED=true`. Group 2 documents the event alongside `release-race.next-tag-mismatch.detected`. |
| `actionlint` is not installed locally and not on default GitHub runners. | Low | Validation gate uses `actionlint` only if available (`command -v actionlint`); falls back to `python3 -c "import yaml; yaml.safe_load(...)"` which is universally available. Never block on actionlint. |
| Audit script (Group 2) silently fails in CI if `jq`/`gh`/`npm` missing. | Medium | Tool-check at script startup exits with distinct exit code 2 + `MISSING_TOOL:` message; nightly workflow installs `jq` explicitly and uses `setup-node` for `npm`. `gh` is preinstalled on GitHub runners. |

**Note on the `workflow_dispatch` fallback:** the expression `${{ github.event.workflow_run.head_sha OR github.sha }}` (literal `||` in YAML) covers both `workflow_run` and `workflow_dispatch` triggers. Written here as `OR` to avoid corrupting the markdown table parser.

---

## Review Results

### Codex Review - 2026-04-28 (Plan)

**Verdict:** BLOCKED

**Evidence:**
- `genie wish parse fix-next-tag-commit-pinning` exited 0 and parsed 2 execution groups, but parser output truncated a risk-table mitigation around `github.event.workflow_run.head_sha` because of unescaped `||`.
- `genie wish lint fix-next-tag-commit-pinning` exited 0 with no structural violations.
- `gh issue view 1303` confirmed issue #1303 is open and matches the `@next` sibling-commit/tag drift problem.

**Blocking gaps:**
- HIGH: The plan is internally inconsistent. It says a stale pinned run should fail fast when `dev` advanced, but success/QA criteria require two back-to-back merges to each receive distinct tags. Choose one invariant: older stale runs skip and only the latest dev merge publishes, or redesign the workflow so every merge can be tagged without pushing a detached version-bump commit over an advanced branch.
- HIGH: The concurrency plan does not align with issue #1303's queued version-run option. Per-SHA concurrency allows cross-commit parallel version derivation/publish and can collide on the same next version. Serialize release/version runs with one queue and `cancel-in-progress: false`, or add retry/re-fetch/recompute behavior for version collisions before claiming back-to-back merges each get distinct tags.

**Non-blocking gaps:**
- MEDIUM: Group 1 static validation can false-fail because it expects `head_sha` and `ref:`/`concurrency` on the same line. Use separate checks for checkout ref and concurrency group.
- MEDIUM: Escape `||` in markdown table cells or move that expression out of the risk table so `genie wish parse` preserves the mitigation.
- MEDIUM: Group 2 is optional in scope/success criteria but listed as Wave 1 work and in the file list. Mark it explicitly as stretch or make it required.

---

### Claude Code Review - 2026-04-28 (Plan)

**Verdict:** AGREE with Codex BLOCKED. The wish has a structural design conflict it doesn't resolve.

**Agreement with Codex:** Yes on both HIGH gaps. The plan tries to solve two competing invariants and doesn't pick:
- **Invariant A (correctness)**: `@next` always points at the commit that just passed CI. → forces serialization (older runs skip if dev advanced).
- **Invariant B (completeness)**: every merge gets its own version tag. → forces parallel-friendly publishing (concurrent commits each tag independently).

The wish picks A in the "fail fast" risk row but requires B in the success/QA criteria. That's irreconcilable as written.

**My recommendation: pick Invariant A explicitly. Drop the "every merge gets a tag" criterion.**

Rationale:
1. The bug being fixed is *@next misadvertising a sibling commit's build*. Serialization fixes that directly.
2. "Every merge gets a distinct tag" is a niceness, not a correctness requirement. If two PRs merge in the same Version-run window, having only the latest tagged on @next is fine — the earlier merge's bundle is identical to or strictly before the later one, and `@next` advertises *latest tested build*, not *every build*.
3. The git-tag ledger doesn't have to be 1:1 with merges; it has to be 1:1 with @next-published builds.

Concrete plan changes:
- Drop the "two back-to-back merges each receive a distinct tag" success criterion.
- Add: *"When dev advances during a Version run, the run skips publish (no bump, no tag, no `@next` change). The next merge's run will catch up and publish."*
- Concurrency group: `version-${{ head_branch }}` with `cancel-in-progress: true` (newer runs supersede older). NOT per-SHA — that re-creates the parallel-publish problem Codex flagged.

**Additional refinements:**

- **MEDIUM — separate the detector (Group 2) into its own ship-able chunk.** The detector is *more useful* than the workflow fix because it catches future regressions even if Group 1's pin is reverted. Currently Group 2 depends-on Group 1 — but it shouldn't. The detector audits the live state regardless of how `@next` got there. Recommendation: ship Group 2 first (cheap, additive), then Group 1 (workflow change). The detector then validates Group 1's correctness.
- **LOW — manual validation in Group 1 requires a `gh workflow run` against dev.** That's a destructive action on a shared resource. Consider adding `--dry-run` or testing on a fork branch.

**Next:** /fix — pick Invariant A, simplify the concurrency group, swap Group 1/Group 2 ordering. Then re-review.

---

## Files to Create/Modify

```
.github/workflows/version.yml                        # MODIFY: checkout ref + cancel-in-progress: true + skip-path notice + PUBLISH_SKIPPED guards + comment block
.github/workflows/audit-next-tag.yml                 # CREATE (Group 2): nightly non-blocking audit; installs jq + setup-node, continue-on-error
scripts/audit-next-tag-pinning.sh                    # CREATE (Group 2): drift detector; tool-check, synthetic-regression env hooks, distinct exit codes (0=healthy/skip, 1=drift, 2=missing-tool)
docs/_internal/detectors/release-race.md             # CREATE/UPDATE (Group 2): documents both `release-race.next-tag-mismatch.detected` (drift) and `release-race.next-tag-pin-skipped.detected` (intentional skip)
.genie/wishes/fix-next-tag-commit-pinning/WISH.md    # this file
```

**Cross-workflow safety check:** `grep -l "npm publish" .github/workflows/*.yml` returns ONLY `version.yml`. Confirmed no second publisher exists; the SHA-pin + concurrency change is sufficient to eliminate the race.
