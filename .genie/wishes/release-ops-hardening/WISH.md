# Wish: release-ops-hardening — enforce the rules the outage taught us

| Field | Value |
|-------|-------|
| **Status** | DRAFT — not plan-reviewed (2026-07-26); needs Felipe approval + a plan gate before execution |
| **Slug** | `release-ops-hardening` |
| **Date** | 2026-07-26 |
| **Author** | Genie (roadmap triage session, from the 2026-07-20→26 outage post-mortem + stable-path study) |
| **Appetite** | small-medium (fix wave over existing surfaces, no redesign) |
| **Branch** | `wish/release-ops-hardening` |
| **Repos touched** | `automagik-dev/genie` |
| **Design** | _No brainstorm — direct wish_ |

## The problem

The 2026-07-20→26 release outage produced three hardening follow-ups (#2669, #2674, #2675) plus two structural findings from the stable-promotion study. Each is currently a *remembered* rule — enforced by handoff documents and operator discipline, not by the pipeline. Rules that live in prose get relearned the expensive way.

Evidence base: issues #2669, #2674, #2675; the stable-path promotion study of 2026-07-26 (findings R6/R7); the operator runbook at `~/workspace/genie-stable-release-runbook.md`.

## Groups

### G1 — Mechanically refuse re-dispatch of published versions (#2674)

The publish `admit` path must refuse a version whose tag already carries a published Release. Today a re-dispatch of a published version dies deep in `reconcile-release-assets.sh` with exit 3 ("refusing to mutate an incomplete published immutable release") — unrecoverable, after minutes of wasted pipeline and a burned human approval. The check is one `gh release view` in admit, failing fast with a message that names the rule and points at #2674.

Criteria:
- [ ] `admit` (release-publish.yml) fails within its first steps when `gh release view v<version>` finds an existing release, with an error naming #2674 and instructing "allocate a fresh version"
- [ ] The failure path is tested (workflow-inline shell extracted or covered per repo convention)
- [ ] Runbook (`docs/_internal/runbooks/release-pipeline.md`) references the mechanical guard instead of the remembered rule

### G2 — Orphan-alert: exempt pending stable candidates (stable-path finding R7)

Every dev→main promotion mints a tag that deliberately has no Release until a human dispatches stable (`release_ready=false`). After 30 minutes, `release-orphan-alert.yml` files a release-incident issue — a structural false positive that recurs on **every** future promotion (#2681 for v5.260726.6 is the live example). Teach the alert to skip tags whose version.yml run emitted `release-trigger.stable_manual_approval_required` (or an equivalent detectable marker of a pending manual candidate).

Criteria:
- [ ] The alert does not file an incident for a promotion tag awaiting manual stable dispatch
- [ ] The alert STILL files when a stable dispatch ran and died between tag-push and Release (the alarm's real purpose)
- [ ] #2681 dispositioned accordingly (closed by the stable release, or closed as structural false positive once the exemption lands)

### G3 — #2675 cleanups + #2669 pin-checker

- Delete the dead/unreachable `CHANNEL="stable"` fallback in release-publish.yml's publish job (and fix its stale "workflow_run defaults to stable" comment); make finalize/manifests/publish read the channel from one source.
- Pin the multi-attestation shape in `reconcile-release-assets.test.ts` (GitHub returns two attestations per tarball; the fake gh emits exactly one).
- Cover the manifests job's inline CAS loop (fetch/detach/reconcile/add/commit/push + 403-vs-non-fast-forward classification) with a test.
- #2669: `check-action-pins.sh` must match quoted `uses:` scalars and anchor the SHA at scalar end.

Criteria:
- [ ] Dead channel default removed; single channel source; comment corrected
- [ ] Multi-attestation fixture shape pinned in tests
- [ ] CAS-loop covered by a test (or extracted into a tested script)
- [ ] check-action-pins.sh handles quoted scalars + anchored SHA, with regression cases

### G4 — Dogfood fixture tracks real N (stable-path finding R6)

`tests/support/codex-dogfood-fixture.ts` hard-codes `FIXTURE_N = '5.260720.10'`. Test-only and harmless at runtime, but it goes stale the moment stable advances `latest.json`, and a shim-shaped N is exactly how defects 6–9 of the outage hid from CI. Model N from the manifest (or assert fixture/manifest agreement) so the fixture fails loudly when N advances.

Criteria:
- [ ] Fixture derives N from (or asserts against) `.well-known/latest.json` instead of a hard-coded literal
- [ ] A stable release that advances latest.json causes a visible, attributable test signal — not silent staleness

## Dependencies

**depends-on:** stable-release-security-gate
**blocks:** none

## Execution Strategy

### Wave 1 (parallel — disjoint surfaces)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| G1 admit-refuse | engineer | 2 (+1 twin-PR workflow choreography) | engineer-standard / high | Publish admit fails fast on already-published versions (#2674) |
| G4 fixture-N | engineer | 1 | engineer-trivial / medium | Dogfood fixture derives N from latest.json instead of a literal |

### Wave 2 (after Wave 1 merges — same workflow files)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| G2 orphan-exempt | engineer | 2 (+1 alarm-semantics validation) | engineer-standard / high | Orphan-alert exempts pending stable candidates |
| G3 cleanups | engineer | 2 (+1 test-harness shapes) | engineer-standard / medium | #2675 dead default + multi-attestation/CAS-loop tests + #2669 pin-checker |

## Non-goals

- No redesign of the release chain, the guard, or the manifest reconciler — every change is a bounded hardening of an existing surface.
- The dev-channel latent risk in #2675 (published-but-unfinalized on a dev run) is covered by G3's single-channel-source change; no broader publish refactor.

## Sequencing

Twin-PR choreography applies to G1–G3 (workflow surfaces): main PR first, human merge, then dev twin. G4 is test-only → dev first. Execute after the first stable release completes, so G2's exemption can be validated against the real promotion cadence.
