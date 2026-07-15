# Wish: Stable release security gate

| Field | Value |
|-------|-------|
| **Status** | IN_PROGRESS |
| **Slug** | `stable-release-security-gate` |
| **Date** | 2026-07-10 |
| **Author** | Codex PM, from PR #2545 Ultra supply-chain review |
| **Appetite** | medium — separate protected-release hardening |
| **Branch** | `wish/stable-release-security-gate` |
| **Repos touched** | `automagik-dev/genie` plus GitHub repository settings |
| **Design** | Inherited CRITICAL/HIGH findings SEC1–SEC3 and QA6 |

## Summary

Close inherited stable-publication risks that are unchanged by PR #2545 but still block production authorization. This wish is deliberately separate from Codex integration remediation so a PR-scope SHIP cannot be mistaken for approval to publish stable artifacts.

## Scope

### IN

- Remove arbitrary-ref stable build/sign/publish paths and bind artifacts to an approved protected ref/SHA with successful CI.
- Validate manual version/run inputs and upstream workflow provenance before privileged shell or artifact use.
- Pin third-party Actions/reusable workflows, freeze installs, minimize permissions/secrets, and protect signing/publishing with a second-maintainer environment approval.
- Make binary rollback, promotion, and consumer verification transactional and consistent with current `.tar.gz`/bundle/per-artifact provenance assets.

### OUT

- Codex hook, plugin-skill, or agent-sync remediation owned by `pr-2545-ultra-release-gate`.
- Production deployment or main merge without a separate human approval.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Stable authorization is a protected release gate, not a workflow input | A dispatcher must not turn an arbitrary ref into a signed stable release. |
| 2 | Repository code and GitHub Environment/ruleset evidence are both required | Code alone cannot prove the documented second-maintainer approval. |

## Dependencies

**depends-on:** none
**blocks:** none

## Success Criteria

- [x] Stable artifacts can originate only from the approved protected ref/tag SHA after required CI. *(G1 SHIP 2026-07-14; guard jobs load-bearing at all 4 entry points)*
- [x] Manual recovery inputs are grammar-validated and bound to the expected repository, workflow, conclusion, ref, and SHA. *(`scripts/release-guard.sh` + 18 fixtures; MEDIUM follow-up: head_branch-vs-null API shape)*
- [x] External Actions are SHA-pinned; installs are frozen; permissions and secrets are least-privilege. *(All remote dependencies are commit-pinned except the SLSA generator's mandatory exact `v2.1.0` builder-identity reference; that exception is explicit and regression-tested.)*
- [ ] Production Environment approval requires an independent maintainer and is evidenced without exposing secrets. *(The live environment now admits only `main`, requires either `namastex888` or `vasconceloscezar`, prevents self-review, and forbids admin bypass; an end-to-end two-maintainer demonstration is still required.)*
- [x] Swap/promotion rollback and current artifact verification pass destructive-failure fixtures. *(7 fixtures; verify-release.sh realigned to real asset scheme)*
- [ ] Dev/homolog channel releases continue to publish without manual approval throughout and after this work. *(The main-controlled `version.yml` path remains reviewer-free, but manifest publication is intentionally blocked while the organization-wide deploy-key policy prevents provisioning the narrow `release-manifests` credential. Confirm live after separately approved credential setup and the first post-merge dev release.)*

## Execution Strategy

Split 2026-07-14 (operator decision, brainstorm disposition): code hardening is agent-executable now; external GitHub settings are human-owned and gated on Felipe.

### Wave 1

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 1 | security engineer + independent reviewer | 7 — privileged CI workflows, provenance, transactional swap | engineer-complex + reviewer | Repo-code protected release chain (F16–F18, F31 code side) |
| 2 | Felipe (human) + evidence capture | 2 — external repo settings + exported proof | human gate | GitHub Environment/ruleset configuration and evidence |

## Execution Groups

### Group 1: Protected stable publication — repository code

**Goal:** In repository code alone, make it impossible for an arbitrary ref or unvalidated input to reach stable build/sign/publish, and make promotion/rollback transactional.

**Deliverables:**
1. **F16:** Every standalone `workflow_dispatch` entry point that can reach stable artifacts is guarded — all four: `release.yml`, `build-tarballs.yml`, `sign-attest.yml`, and `release-publish.yml` (whose standalone dispatch currently defaults `channel` to `stable` and takes an operator `run_id`, bypassing the orchestrator entirely). Stable requires a protected `v*` tag SHA that passed required CI; dispatch recovery is bound to that same identity, never a free-form ref.
2. **F17:** Extract the ref/tag guard and the run-id provenance validation (expected repository, workflow file, run conclusion, ref, head SHA, plus version-grammar check) into testable shell or TS helpers invoked by the workflows, with unit fixtures — inline `${{ }}` expressions alone are not acceptable since CI has no workflow simulator.
3. **F18:** SHA-pin all third-party Actions and reusable workflows (including `ggshield-action` in `ci.yml`); retain only the SLSA generator's mandatory exact-semver builder reference as an explicit exception because replacing it with a commit SHA changes the SLSA builder identity; freeze the still-unfrozen installs in `version.yml` and `ci.yml`; add the missing least-privilege `permissions:` blocks (`ci.yml` has none); replace blanket `secrets: inherit` in `release.yml` with explicitly scoped secrets.
4. **F31:** Transactional binary promotion/rollback in `install.sh` / `src/genie-commands/update.ts`, with destructive-failure fixtures (kill mid-swap, corrupt artifact, mismatched provenance). **Constraint:** must preserve the durable `.steal` lifecycle-lock recovery protocol in `install.sh` and its shell/TS parity (F42/F45–F47/F50 hardening) — add a regression check, do not rework that contract.
5. **F31:** Realign `scripts/verify-release.sh` to the real asset scheme (`*.tar.gz`, `.bundle`, per-tarball `*.intoto.jsonl`, bundle-based cosign verification) with a fixture — it currently cannot verify any real release.
6. `environment: production` scoped to the **stable channel only** (channel-conditional expression or a split stable-publish job) so Group 2's required-reviewer gate attaches to stable without touching dev/homolog flow.

**Acceptance Criteria:**
- [x] A non-tag ref dispatched at any of the four stable-capable entry points fails closed (guard jobs load-bearing via `needs:` at all four; 18 helper fixtures incl. negatives).
- [x] A mismatched/failed upstream run cannot be signed or published (`release-guard.sh` binds repo/workflow/status/conclusion/ref/SHA/version-grammar; injection fixtures pass).
- [x] A dev-channel release publishes end-to-end **without** environment approval (dev dispatch is isolated from the stable-only `approve-stable` job and traced through every guard).
- [x] `install.sh` steal-guard protocol unchanged (reviewer independently recomputed digest `c6d5c4bd…` on both trees; pinned in `install-swap.test.ts`); 7 destructive-failure fixtures pass.
- [x] Final `bun run check` and full `bun test` are green on the exact rebased PR tree (1,961 tests / 6,955 assertions; zero failures).
- [x] Independent review of the final exact PR tree returns SHIP. *(Overall and release-chain reviews returned SHIP; the transaction specialist's VERSION-binding follow-up and the remote-CI musl/Linux portability fixes were independently re-reviewed before the final evidence amendment.)*

**Validation:**
```bash
bun run check
bun test
# Dry-run/non-production release fixture for the workflow-level guards.
```

**depends-on:** none

### Group 2: Protected environment + ruleset evidence (human-owned)

**Goal:** Prove the documented second-maintainer approval with external GitHub state.

**Deliverables:**
1. GitHub Environment `production` with an independent required reviewer **and "Prevent self-review" enabled** — without that toggle, a required reviewer can approve their own triggered deployment, which would void the independence claim.
2. Ruleset/branch-tag protection for `v*` stable tags.
3. Exported evidence (GitHub API JSON or settings export, no secrets) committed under `qa/` in this wish — must capture the reviewer set **and** the prevent-self-review setting explicitly.
4. Deployment branch policy permits the protected `main` control ref used by `release.yml`; bot-authored automation cannot initiate stable, and a live two-maintainer run proves the initiating maintainer cannot approve it.
5. The `release-manifests` environment remains reviewer-free and restricted to `main`; its write credential is provisioned only after separate approval to change the organization-wide deploy-key policy, without adding a broader Actions or user-token bypass.

**Acceptance Criteria:**
- [ ] Environment approval demonstrably requires an independent maintainer: current evidence shows reviewers `namastex888` + `vasconceloscezar`, `prevent_self_review: true`, `can_admins_bypass: false`, and an exact `main` deployment policy; no live two-maintainer run has yet been captured.
- [x] Evidence file present in `qa/` and referenced from Review Results. *(`qa/github-settings-evidence-20260714.json`; it is retained as dated evidence, not treated as proof of the pending cutover.)*

**depends-on:** Group 1 (the `environment: production` reference must exist in the workflow before the gate is observable end-to-end)

---

## QA Criteria

- [x] An arbitrary branch/ref cannot reach stable publication. *(G1 SHIP: fails closed at all 4 dispatch entry points; release-publish standalone default flipped stable→dev)*
- [x] A mismatched/failed upstream run cannot be signed or published. *(provenance binding + negative fixtures)*
- [ ] A second maintainer must approve the protected production environment.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Repository settings are external to Git | High | Require exported/screenshot/API evidence and human approval before SHIP. |
| Bot-initiated stable runs make prevent-self-review exclude the bot instead of the change initiator | High | Never auto-dispatch stable; require a fresh human dispatch and reject bot/rerun identities before the environment gate. |
| Enabling immutable releases while predecessor workflow runs are active | Critical | Seal and drain old-main Version/Release runs before enablement; reject predecessor releases and cut a fresh version under merged draft-first control. |
| Recovery paths become unusable | Medium | Keep a protected, provenance-bound manual recovery path and test it. |

---

## Review Results

**PR #2587 final hardening 2026-07-15: repository remediation, exact rebased-tree gates, and independent review complete — SHIP.** Overall exact-SHA and dedicated release-chain reviews returned SHIP with no CRITICAL, HIGH, or MEDIUM release defect. A transaction specialist then identified one MEDIUM integrity follow-up: the authenticated physical `VERSION` member was not textually bound to `expectedVersion`. Promotion and admission now require the expected version and reject any stamp other than exact canonical `<version>\n` bytes through a stable, owned, single-link, no-follow descriptor read capped at 256 bytes; stale, whitespace, CRLF, extra-line, oversized, and hard-link fixtures prove failure before transaction or live mutation. Independent re-review of that delta returned SHIP with no remaining medium-or-higher finding. The first remote CI run on `24f50043d7749f6217c53e625a801f8586fa9e8d` exposed two platform gaps: Alpine musl exports `syscall` but not a `renameat2` wrapper, and Linux reports non-authoritative symlink mode bits as `0777`. Native no-clobber resolution now prefers versioned glibc, then an architecture-matched absolute musl loader, and uses the exact x64/arm64 `SYS_renameat2` number through a C-`long` FFI signature; unknown architectures fail closed. Symlink ownership/link identity remains enforced while meaningless symlink permission bits are ignored consistently in physical and journal validation; staged symlinks remain forbidden. The Alpine 3.19 multiarch image is digest-pinned. Bun 1.3.11 Linux tests and the compiled x64-musl binary's pinned-Alpine version/help/native-collision smoke pass. The remaining LOW follow-up is to unify same-UID external temporary-root cleanup with the native identity-bound internal cleanup; it requires a broader native guard and is not a cross-principal boundary. The earlier Group 1 SHIP below is historical evidence only. The final code emits a human-initiation handoff for stable, rejects bot-authored or rerun stable attempts, and admits dev/homolog only through a local reusable-workflow call whose top-level caller is the exact `version.yml@main` control commit; the source must also remain on authoritative dev's first-parent chain. Install and update now share one exact-generation promotion engine: it validates the fixed release payload, captures the prior `genie` before `VERSION`, publishes `VERSION` before `genie`, executes the live binary before commit, rolls active transactions back with `genie` restored last, and retains ambiguous objects without clobbering. Downloads and extraction stay in protected mode-0700 temporary roots; a held `mkdirat`/`openat` staging capability admits length-framed digest-matched payloads without writing through replaced `GENIE_HOME/bin` or staging paths. Adversarial fixtures preserve symlink victims, reject post-admission mutation, and recover interrupted final publication. The unsafe duplicate updater swap/recovery authority was removed; legacy binary-only rollback and pending-delivery journals are read-only and fail closed with signed-reinstall guidance. The live `production` policy is corrected to `main`, immutable releases are enabled, and no-bypass main/tag rulesets are active. Exact rebased-tree gates are green (`bun run check` and full `bun test`: 1,961 tests / 6,955 assertions; installer/updater transaction focus: 314 tests / 1,018 assertions; zero failures or skips in the updater focus). Repository code is SHIP; wish closure still requires separately approved narrow manifest-write credential setup and an end-to-end two-maintainer demonstration.

**PR #2585 bot-comment triage 2026-07-14 (verified against code, per PR Review Rules):** Codex P1 **confirmed real and merge-blocking** — release.yml's `publish` caller granted only `contents: write`/`id-token: write` while the called release-publish.yml guard job requests `actions: read`; a called workflow cannot elevate past its caller, so every orchestrated release (dev included) would have failed at workflow init. Missed by the execution review; uncatchable by PR CI (release workflows don't run on PRs). Fixed by granting `actions: read` on the caller. Codex P2 (run_id validated before gh presence probe) and Gemini mktemp-leak (severity inflated; fixed via `${tmp:-}` EXIT trap) also applied. Codex P2 sidecar-rollback = the already-recorded LOW follow-up. Gemini subshell-exit rejected: `set -euo pipefail` propagates the subshell's exit 5 and the exit-code contract is fixture-tested.

**Group 1 execution review 2026-07-14 (reviewer aca929030341671c0, adversarial, independent of the engineer): SHIP.** Branch `wish/stable-release-security-gate`, commits `d4b4b31b` + `7bd90757` + `b3593c4b` (13 files, +1128/−80). All 7 verification legs PASS with the reviewer re-deriving evidence itself (guard `needs:` wiring at all 4 entry points, provenance-binding negatives, dev-flow trace, `.steal` digest recomputation, fingerprint-witness contract, upstream SHA-pin resolution, gates re-run). Three advisory non-blocking follow-ups recorded:
- **MEDIUM:** break-glass recovery binds `head_branch == v<version>`, but the runs API may return `head_branch: null` for tag events — fails closed (no security hole) but the operator recovery path is unproven against real API shape; prefer `head_sha` binding or an integration probe.
- **LOW:** rollback restores only the binary, not sidecars (VERSION/plugins) — practically unreachable, documented in-code.
- **LOW:** first-party `actions/*` remain tag-pinned (wish scoped pinning to third-party).

**Group 2 external state refreshed 2026-07-15 (operator-directed, executed via `gh api` as namastex888; approver set named by the operator):** GitHub Environment `production` requires reviewers `namastex888` + `vasconceloscezar`, has `prevent_self_review: true` and `can_admins_bypass: false`, and admits only the protected `main` control branch. Immutable releases are enabled. Ruleset `main-protection` (id 9203218, active, no bypass actors) requires one last-push-independent approval, resolved threads, strict exact `Quality Gate (typecheck + lint + test)`, merge-only history, and blocks deletion/non-fast-forward updates on `refs/heads/main`. Ruleset `v-tags-immutable` (id 18938286, active, no bypass actors) blocks deletion/update/non-fast-forward on `refs/tags/v*`. The reviewer-free `release-manifests` environment is restricted to `main` and has no secrets, so its current `can_admins_bypass: true` setting grants no manifest authority; set it to `false` before separately approving and provisioning the deploy-key secret. The secret is deliberately absent because the organization currently disables deploy keys; no broader bypass was introduced. Version and Release workflows remain disabled during the cutover. Evidence: [`qa/github-settings-evidence-20260714.json`](qa/github-settings-evidence-20260714.json). G2 remains open until narrow credential setup receives separate approval and the human-initiation/two-maintainer gate is observed end to end.

**Plan re-review 2026-07-14 (reviewer agent aca929030341671c0): SHIP — all six gaps resolved, coverage complete (6 SC / 3 QA / 4 IN jointly owned by G1+G2), status persisted APPROVED by the invoking orchestrator.** One LOW non-blocking observation: the dev-flow regression AC exercises dev only, acceptable because the guard is a single `channel == 'stable'` exemption and the homolog branch is dormant.

**Plan review 2026-07-14 (reviewer agent aca929030341671c0): FIX-FIRST → fixes applied, re-review returned SHIP above.**
Confirmed all four findings real in current code (release-publish.yml standalone dispatch defaults to stable with unvalidated run_id; verify-release.sh cannot verify any real release). Gaps fixed in this plan: (1) HIGH — `environment: production` now channel-scoped to stable only + dev-flow regression AC added; (2) MEDIUM — F16 enumerates all four dispatch entry points; (3) MEDIUM — guards required as testable helpers with fixtures, not inline `${{ }}`; (4) MEDIUM — steal-guard preservation constraint added to F31; (5) LOW-MED — Group 2 evidence must capture prevent-self-review + reviewer set; (6) LOW — verify-release.sh realignment made an explicit deliverable.

Created as the explicit blocking disposition for inherited findings F16–F18 and F31 from the PR #2545 Ultra review.

---

## Files to Create/Modify

```text
.github/workflows/{release,version,build-tarballs,sign-attest,release-publish,ci}.yml
install.sh
scripts/verify-release.sh
src/genie-commands/update.ts
SECURITY.md
GitHub Environment/ruleset configuration (human-approved external state)
```
