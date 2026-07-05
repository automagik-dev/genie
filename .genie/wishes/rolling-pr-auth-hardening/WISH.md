# Wish: Harden rolling-pr.yml Auth (Fail-Fast + Token Split)

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `rolling-pr-auth-hardening` |
| **Date** | 2026-07-05 |
| **Author** | Felipe (dogfooding the revamped v5 lifecycle) |
| **Appetite** | small |
| **Branch** | `wish/rolling-pr-auth-hardening` |
| **Repos touched** | `automagik-dev/genie` → `/home/feliperosa/vm-home/workspace/worktrees/genie-skills-revamp` |
| **Design** | _No brainstorm — direct wish_ |

## Summary

**Problem:** `rolling-pr.yml` fails every hour with a raw unauthenticated-gh error ("Try authenticating with: gh auth login") because `secrets.RELEASE_PLEASE_TOKEN` is present but dead — runs show `HTTP 401: Bad credentials` with the token masked `***` (expired/revoked PAT), verified in run logs; the failure forced two manual promotion-PR creations tonight. Repo workflow permissions are `read`-only with PR-approval disabled, so `github.token` genuinely cannot create PRs — the PAT is required for creation, but the workflow should say so instead of dying cryptically.

Harden the workflow: fail fast with an actionable `::error` when the secret is absent, and scope the PAT to the one step that needs it (PR creation) so the read-only existence check runs on `github.token`.

## Scope

### IN

- `.github/workflows/rolling-pr.yml` only: explicit guard step that fails when the secret is empty OR fails a cheap validity probe (`gh api user` with the PAT, read-only, ~1s), with `::error::RELEASE_PLEASE_TOKEN missing or invalid (HTTP 401) — mint a PAT with contents:read + pull-requests:write and add it to repo secrets` when the secret is empty; `gh pr list` (read-only) runs with `GH_TOKEN: ${{ github.token }}`; only `gh pr create` uses the PAT; cadence, concurrency, and PR body preserved.

### OUT

- Minting/refreshing the PAT itself — human action item for Felipe (repo Settings → Secrets → `RELEASE_PLEASE_TOKEN`).
- Any other workflow; any change to the rolling-PR cadence or merge policy (§19 humans-only main merges unchanged).

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Fail-fast guard instead of silent PAT fallback to `github.token` for creation | Repo setting `default_workflow_permissions: read`, `can_approve_pull_request_reviews: false` (verified via API) — creation with `github.token` would fail anyway; a loud, actionable error beats an hourly cryptic one |
| 2 | Split tokens: `github.token` for list, PAT for create | Least privilege; the workflow keeps working read-only (and reports clearly) even while the secret is dead |

## Success Criteria

- [ ] With the secret absent or dead (current reality: present, 401): `workflow_dispatch` run fails in seconds with the actionable `::error` text, not a raw gh auth message.
- [ ] `gh pr list` step authenticates via `github.token` (no PAT dependency on the read path).
- [ ] YAML parses; workflow diff touches only `rolling-pr.yml`.
- [ ] Once Felipe refreshes the PAT: the hourly run creates/confirms the rolling PR again (post-merge QA item).

## Execution Strategy

### Wave 1 (single group, sequential)

| Group | Agent | Description |
|-------|-------|-------------|
| harden | engineer | Guard + token split in rolling-pr.yml |

## Execution Groups

### Group harden: Guard + token split

**Goal:** The workflow self-diagnoses a missing PAT and needs it only where GitHub policy requires it.

**Deliverables:**
1. Guard step (first): if `secrets.RELEASE_PLEASE_TOKEN` is empty OR the validity probe (`gh api user` under the PAT) fails → same actionable `::error` mint/refresh text → exit 1.
2. Existence check (`gh pr list`) on `GH_TOKEN: ${{ github.token }}`; creation step keeps the PAT env; stale comment updated to explain the split + the verified repo policy.

**Acceptance Criteria:**
- [ ] YAML valid; only rolling-pr.yml modified.
- [ ] Guard precedes any gh call; error text names the secret, required scopes, and where to add it.
- [ ] PR body/title/cadence/concurrency byte-preserved.

**Validation:**
```bash
cd "$(git rev-parse --show-toplevel)" && python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/rolling-pr.yml')); print('yaml-ok')" && \
  grep -q "::error" .github/workflows/rolling-pr.yml && grep -q "api user" .github/workflows/rolling-pr.yml && grep -q "github.token" .github/workflows/rolling-pr.yml && echo HARDEN-OK
```

**depends-on:** none

---

## QA Criteria

- [ ] Post-merge `workflow_dispatch` (secret still absent) → clear actionable failure in the Actions UI.
- [ ] After Felipe adds the PAT → next hourly run green, rolling PR exists.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Org policy also blocks PAT-created PRs from Actions | Low | Tonight's evidence: PRs #2516/#779 previously auto-created via the same secret when it was valid |

---

## Review Results

_Populated by `/review`._

---

## Files to Create/Modify

```
.github/workflows/rolling-pr.yml   (modify — guard + token split + comment)
```
