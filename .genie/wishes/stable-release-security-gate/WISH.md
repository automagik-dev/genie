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
- [x] External Actions are SHA-pinned; installs are frozen; permissions and secrets are least-privilege. *(5 pins verified upstream; documented SLSA-generator tag-pin exception)*
- [x] Production Environment approval requires an independent maintainer and is evidenced without exposing secrets. *(2026-07-14: `qa/github-settings-evidence-20260714.json` — end-to-end gate demo still pending Group 1's `environment: production` wiring)*
- [x] Swap/promotion rollback and current artifact verification pass destructive-failure fixtures. *(7 fixtures; verify-release.sh realigned to real asset scheme)*
- [x] Dev/homolog channel releases continue to publish without manual approval throughout and after this work. *(dev dispatch traced through all guards; confirm live on first post-merge dev release)*

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
3. **F18:** SHA-pin all third-party Actions and reusable workflows (including `ggshield-action` in `ci.yml` and the tag-pinned SLSA reusable in `sign-attest.yml`); freeze the still-unfrozen installs in `version.yml` and `ci.yml`; add the missing least-privilege `permissions:` blocks (`ci.yml` has none); replace blanket `secrets: inherit` in `release.yml` with explicitly scoped secrets.
4. **F31:** Transactional binary promotion/rollback in `install.sh` / `src/genie-commands/update.ts`, with destructive-failure fixtures (kill mid-swap, corrupt artifact, mismatched provenance). **Constraint:** must preserve the durable `.steal` lifecycle-lock recovery protocol in `install.sh` and its shell/TS parity (F42/F45–F47/F50 hardening) — add a regression check, do not rework that contract.
5. **F31:** Realign `scripts/verify-release.sh` to the real asset scheme (`*.tar.gz`, `.bundle`, per-tarball `*.intoto.jsonl`, bundle-based cosign verification) with a fixture — it currently cannot verify any real release.
6. `environment: production` scoped to the **stable channel only** (channel-conditional expression or a split stable-publish job) so Group 2's required-reviewer gate attaches to stable without touching dev/homolog flow.

**Acceptance Criteria:**
- [x] A non-tag ref dispatched at any of the four stable-capable entry points fails closed (guard jobs load-bearing via `needs:` at all four; 18 helper fixtures incl. negatives).
- [x] A mismatched/failed upstream run cannot be signed or published (`release-guard.sh` binds repo/workflow/status/conclusion/ref/SHA/version-grammar; injection fixtures pass).
- [x] A dev-channel release publishes end-to-end **without** environment approval (dev dispatch traced through every guard; `environment: ${{ inputs.channel == 'stable' && 'production' || '' }}` confirmed as the documented no-environment idiom).
- [x] `install.sh` steal-guard protocol unchanged (reviewer independently recomputed digest `c6d5c4bd…` on both trees; pinned in `install-swap.test.ts`); 7 destructive-failure fixtures pass.
- [x] `bun run check` green (typecheck 0, biome 0, tests 0 fail across chunks; knip exit-1 is the documented pre-existing carve-out with zero new findings vs dev).
- [x] Independent review of the group returns SHIP (execution review 2026-07-14, reviewer aca929030341671c0).

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

**Acceptance Criteria:**
- [x] Environment approval demonstrably requires an independent maintainer: evidence shows the reviewer set and `prevent_self_review: true`, without exposing secrets. *(reviewers namastex888 + vasconceloscezar, `prevent_self_review: true`, `can_admins_bypass: false`)*
- [x] Evidence file present in `qa/` and referenced from Review Results. *(`qa/github-settings-evidence-20260714.json`)*

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
| Recovery paths become unusable | Medium | Keep a protected, provenance-bound manual recovery path and test it. |

---

## Review Results

**Group 1 execution review 2026-07-14 (reviewer aca929030341671c0, adversarial, independent of the engineer): SHIP.** Branch `wish/stable-release-security-gate`, commits `d4b4b31b` + `7bd90757` + `b3593c4b` (13 files, +1128/−80). All 7 verification legs PASS with the reviewer re-deriving evidence itself (guard `needs:` wiring at all 4 entry points, provenance-binding negatives, dev-flow trace, `.steal` digest recomputation, fingerprint-witness contract, upstream SHA-pin resolution, gates re-run). Three advisory non-blocking follow-ups recorded:
- **MEDIUM:** break-glass recovery binds `head_branch == v<version>`, but the runs API may return `head_branch: null` for tag events — fails closed (no security hole) but the operator recovery path is unproven against real API shape; prefer `head_sha` binding or an integration probe.
- **LOW:** rollback restores only the binary, not sidecars (VERSION/plugins) — practically unreachable, documented in-code.
- **LOW:** first-party `actions/*` remain tag-pinned (wish scoped pinning to third-party).

**Group 2 external state configured 2026-07-14 (operator-directed, executed via `gh api` as namastex888; approver set named by the operator):** GitHub Environment `production` — required reviewers `namastex888` + `vasconceloscezar`, `prevent_self_review: true`, `can_admins_bypass: false`, deployment refs restricted to `v*` tags; repository ruleset `v-tags-immutable` (id 18938286, active, no bypass actors) blocks deletion/update/non-fast-forward on `refs/tags/v*` while leaving tag creation untouched (continuous dev releases unaffected). Evidence: [`qa/github-settings-evidence-20260714.json`](qa/github-settings-evidence-20260714.json). Remaining for G2 closure: observe the gate end-to-end once Group 1 wires `environment: production` into the stable publish job.

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
