# Brainstorm: stable-release-security-gate (disposition review)

**Date:** 2026-07-14
**Mode:** retroactive — a WISH.md already exists at `.genie/wishes/stable-release-security-gate/WISH.md` (DRAFT, authored 2026-07-10 by Codex PM). This brainstorm exists because the human operator found the wish and asked "what is this?"; goal is comprehension + disposition (refine / approve / split / discard), not greenfield design.

## Origin (verified against repo evidence)

- PR #2545 got a multi-agent Ultra supply-chain review. Most findings were remediated in `pr-2545-ultra-release-gate` (IN_PROGRESS).
- Four findings were **inherited pipeline risks, not caused by the PR**, and were spun out here instead of blocking the PR:
  - **F16 / SEC1 — CRITICAL:** stable build/sign/publish reachable from an arbitrary ref via `workflow_dispatch` (confirmed: `release.yml:24` has operator dispatch + inputs).
  - **F17 / SEC2 — HIGH:** manual version/run-id inputs not validated or bound to the expected repo/workflow/conclusion/ref/SHA.
  - **F18 / SEC3 — HIGH:** third-party Actions not SHA-pinned, installs not frozen, permissions/secrets not least-privilege.
  - **F31 / QA6 — HIGH:** binary promotion/rollback not transactional; consumer verification not matched to current artifacts.
- `REVIEW-DISPOSITION.md` (pr-2545 wish) marks all four rows "Blocking": **stable promotion is BLOCKED until this wish ships.** Dev-channel releases still flow.

## Why it exists as a separate wish

So a SHIP verdict on the PR-scope remediation can't be misread as authorization to publish stable artifacts. This wish IS the stable-channel gate.

## Known constraints

- Requires external GitHub state (Environment with independent required reviewer, rulesets) — human-owned, code can't prove it; wish demands exported/API evidence.
- Complexity rated 8; single sequential group; security engineer + independent reviewer + human gate.

## WRS

WRS: ██████████ 100/100
 Problem ✅ | Scope ✅ | Decisions ✅ | Risks ✅ | Criteria ✅

## Disposition (RESOLVED 2026-07-14)

Operator chose **split & execute**: WISH.md restructured into
- **Group 1** — repo-code hardening (F16 ref binding, F17 input/provenance validation, F18 pinning/permissions, F31 transactional swap, `environment: production` wiring) — agent-executable now, complexity 7.
- **Group 2** — human-owned GitHub Environment/ruleset configuration + exported evidence (depends-on Group 1).

No separate DESIGN.md: the wish pre-exists this brainstorm (authored from the Ultra review findings); the wish itself is the design artifact and goes through plan review directly.
