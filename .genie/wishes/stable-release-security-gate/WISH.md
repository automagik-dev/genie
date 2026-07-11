# Wish: Stable release security gate

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
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

- [ ] Stable artifacts can originate only from the approved protected ref/tag SHA after required CI.
- [ ] Manual recovery inputs are grammar-validated and bound to the expected repository, workflow, conclusion, ref, and SHA.
- [ ] External Actions are SHA-pinned; installs are frozen; permissions and secrets are least-privilege.
- [ ] Production Environment approval requires an independent maintainer and is evidenced without exposing secrets.
- [ ] Swap/promotion rollback and current artifact verification pass destructive-failure fixtures.

## Execution Strategy

### Wave 1 (sequential)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 1 | security engineer + independent reviewer | 8 — privileged CI, provenance, external settings | inherit active Ultra model + human gate | Design and implement protected release chain |

## Execution Groups

### Group 1: Protected stable publication

**Goal:** Bind build, signing, publication, and verification to an independently approved release identity.

**Deliverables:**
1. Harden workflow inputs, refs, provenance, actions, permissions, secrets, and environments.
2. Make binary promotion/rollback and consumer verification transactional.
3. Capture repository-ruleset and Environment reviewer evidence.

**Acceptance Criteria:**
- [ ] All success criteria are independently reviewed with a dry-run/non-production release fixture.

**Validation:**
```bash
bun run check
bun test
# Plus protected-environment and provenance evidence on an approved test tag.
```

**depends-on:** none

---

## QA Criteria

- [ ] An arbitrary branch/ref cannot reach stable publication.
- [ ] A mismatched/failed upstream run cannot be signed or published.
- [ ] A second maintainer must approve the protected production environment.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Repository settings are external to Git | High | Require exported/screenshot/API evidence and human approval before SHIP. |
| Recovery paths become unusable | Medium | Keep a protected, provenance-bound manual recovery path and test it. |

---

## Review Results

Not executed. Created as the explicit blocking disposition for inherited findings F16–F18 and F31 from the PR #2545 Ultra review.

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
