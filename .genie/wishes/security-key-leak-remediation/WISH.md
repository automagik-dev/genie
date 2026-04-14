# Wish: security-key-leak-remediation — Contain, rotate, purge, and prevent `.genie/snapshot.sql.gz` leak

| Field | Value |
|-------|-------|
| **Status** | DRAFT — P0 / security incident |
| **Slug** | `security-key-leak-remediation` |
| **Date** | 2026-04-14 |
| **Severity** | CRITICAL |
| **depends-on** | none (starts immediately) |
| **blocks** | any new `npm publish` until Group B ships |

## Summary

A 44.4 MB `pg_dump` (`.genie/snapshot.sql.gz`) was committed on 2026-04-01 by local git user `Test <test@test.com>` in commit `04026bd58` and has been shipped in every `@automagik/genie` npm release since — including `4.260402.2` and at least through `4.260413.5`. Because `package.json` has no `files` allow-list and the repo has no `.npmignore`, npm packs the full working tree minus `.gitignore`, which excluded other `.genie/*` paths but not this dump. The dump contains Google API keys (`AIzaSy...`), many `paperclip-api` JWT bearer tokens for multiple `company_id` tenants, a `pg_dump` restrict token, and 6,378 secret-shaped rows. We must (1) stop the bleed, (2) rotate every credential in the dump, (3) purge the blob from git history and npm, (4) put guardrails in place so this class of leak cannot reach npm again.

## Scope

### IN
- Immediate containment of further publishes.
- Full secret rotation for every credential class present in the dump.
- Deprecation / unpublish of every affected npm version; user-facing security advisory.
- History rewrite (BFG / git-filter-repo) on `main`, `dev`, and every still-live branch/tag.
- npm publish hardening: `files` allow-list, `.npmignore`, `prepack` size/secret guard, CI publish gate.
- Pre-commit + pre-push hooks to block committing large binaries and known secret shapes.
- Post-incident docs: advisory, runbook, `SECURITY.md`.
- Audit of other published packages under the `@automagik` scope for the same failure mode.

### OUT
- Migrating the legitimate dev DB off Postgres.
- Building a generic secret-scanning SaaS.
- Rewriting the full release pipeline — only the minimum to gate publish.
- Notifying every downstream consumer individually (covered by the GHSA / npm deprecation message).

## Decisions

| Decision | Rationale |
|----------|-----------|
| Treat every secret in the dump as compromised regardless of TTL | Dump was public on npm for ~12 days; scraping is automated and fast |
| Use `git filter-repo` (not BFG) for history purge | Better UX, official recommendation, handles tags and refs atomically |
| Add `files` allow-list **and** `.npmignore` (defense in depth) | `files` is authoritative but `.npmignore` protects local `npm pack` experiments |
| Block `npm publish` from anywhere except CI with OIDC | Prevents a repeat from a dev laptop with a dirty working tree |
| Do **not** attempt to retroactively "delete" the tarballs from npm mirrors | Impossible — assume permanent disclosure; focus on rotation |
| Publish a GHSA + npm deprecate message on every affected version | Standard OSS incident-response expectation |

## Success Criteria
- [ ] `npm view @automagik/genie versions` shows every affected version marked deprecated with a link to the advisory
- [ ] `git log --all -- .genie/snapshot.sql.gz` returns empty on the public repo after the rewrite
- [ ] `npm pack --dry-run` on `HEAD` does **not** list anything under `.genie/` except explicitly whitelisted paths, and package size drops below 10 MB
- [ ] CI refuses to publish if tarball > 10 MB or if a secret-shape regex matches tarball contents
- [ ] Every credential class listed in the Credential Inventory has a rotation commit/ticket marked done
- [ ] GHSA published on GitHub and linked from `SECURITY.md`
- [ ] Pre-commit hook blocks `.sql`, `.sql.gz`, `.dump`, `.pgdump`, and any file > 1 MB not explicitly allow-listed
- [ ] Post-mortem document merged to `.genie/incidents/2026-04-14-npm-key-leak.md`

## Execution Strategy — 4 waves

Wave 1 (contain) and Wave 2 (rotate) run in parallel immediately. Wave 3 (purge) starts once Wave 2 is complete enough to be safe. Wave 4 (prevent + document) lands before the next scheduled release.

## Execution Groups

### Group A — Contain (wave 1, starts now)
**Goal:** stop any new leak within the hour.

Deliverables:
- Freeze `npm publish`: disable publish workflow, rotate npm automation token, set `"private": true` temporarily or add a `prepublishOnly` script that `exit 1`s until Group D is merged.
- Revoke the existing `NPM_TOKEN` in GitHub Actions + any dev machines; issue a new token with OIDC trust only.
- Remove `.genie/snapshot.sql.gz` from the working tree on `dev` and `main` in a single commit that also adds a placeholder `.gitkeep` and extends `.gitignore` with `.genie/snapshot.sql*`, `*.sql.gz`, `*.dump`, `*.pgdump`.
- Post a pinned GitHub issue and a `SECURITY.md` stub acknowledging the incident with a rotation ETA.

Validation:
- `npm publish` from a clean checkout exits non-zero.
- `git ls-files | grep snapshot` returns empty on `dev`.

### Group B — Rotate credentials (wave 2, parallel with A)
**Goal:** every key in the dump becomes non-functional.

Deliverables:
- **Credential inventory**: run a scan on the decompressed dump and produce `.genie/incidents/2026-04-14-credential-inventory.md` listing every unique:
  - Google API keys (`AIza...`)
  - `paperclip-api` JWTs (and the signing secret that produced them — the JWTs themselves expire in hours but the signing secret does not)
  - `pg_dump` restrict token `XQCXNOg...`
  - any `omni_sk_`, `sk-`, `xox[abp]-`, `ghp_`, `github_pat_`, Stripe `sk_live_`, AWS `AKIA`, Azure, GCP service-account JSON, private-key PEM blocks
  - database passwords / DSNs, SMTP creds, webhook signing secrets
- Rotate each one at its source of truth; record rotation timestamp and operator initials in the inventory.
- **Rotate the JWT signing secret** for `paperclip-api` — this is the important one, because the issued JWTs are forgeable indefinitely otherwise; invalidate all outstanding sessions.
- Rotate the Postgres role whose password is implied by the dump's `GRANT`/`ROLE` statements; rotate any replication slot credentials.
- Notify affected tenants (`company_id` UUIDs visible in JWT claims) privately per their contract.

Validation:
- Automated re-scan of the dump: for each extracted secret, an integration test confirms the secret no longer authenticates (HTTP 401/403 expected) — see `scripts/verify-rotated.ts`.
- Zero entries in the inventory without a rotation timestamp.

### Group C — Purge (wave 3, after B is at ≥95% rotated)
**Goal:** remove the blob from git history and npm listings.

Deliverables:
- Rewrite history with `git filter-repo --path .genie/snapshot.sql.gz --invert-paths` on a fresh mirror clone; force-push `main`, `dev`, and every feature branch that contains the blob.
- Delete and re-create every tag in the leaked range so the tagged tree no longer contains the blob (document that tarballs on npm are **not** altered by this — rotation in Group B is the real mitigation).
- For each affected npm version, run `npm deprecate @automagik/genie@<version> "SECURITY: see GHSA-XXXX-YYYY-ZZZZ; rotate credentials and upgrade to >=X.Y.Z"`.
- File a GHSA with CVSS, affected range, and remediation steps; request npm security team review (they can unpublish within 72h of publish; outside that window, deprecate is the tool).
- Invalidate and re-issue any signing keys that are derivable from the repo history (GPG commit signing keys if they were on the compromised laptop).

Validation:
- `git log --all --full-history -- .genie/snapshot.sql.gz` returns empty on the public repo.
- `npm view @automagik/genie@<affected-version> deprecated` returns the advisory string for every listed version.
- GHSA is `PUBLISHED` and linked from `README.md` + `SECURITY.md`.

### Group D — Prevent (wave 4, must merge before the next release)
**Goal:** make this class of leak mechanically impossible.

Deliverables:
- `package.json` gains a minimal `files` allow-list covering only what the CLI needs to run: `dist/`, `skills/`, `templates/`, `scripts/postinstall-tmux.js`, `README.md`, `LICENSE`. Explicitly excludes `.genie/`, `src/`, tests, brainstorms, qa fixtures.
- Add `.npmignore` as belt-and-braces — redundantly deny `.genie/`, `*.sql`, `*.sql.gz`, `*.dump`, `*.pgdump`, `*.env*`, `*.pem`, `*.key`, `secrets/`.
- Add `scripts/prepack-guard.ts` invoked from `prepack`:
  - fails if tarball size > 10 MB,
  - fails if tarball contains any file larger than 1 MB outside `dist/`,
  - runs `gitleaks detect --no-git` against the packed contents,
  - fails if a secret-shape regex matches.
- Replace `npm publish` in CI with Trusted Publishing (npm provenance + OIDC from GitHub Actions only); remove long-lived `NPM_TOKEN` entirely.
- Pre-commit hook (husky):
  - rejects files > 1 MB unless `.gitattributes` marks them `vendored=true`,
  - runs `gitleaks protect --staged`,
  - rejects paths matching `.genie/snapshot*`, `*.sql`, `*.sql.gz`, `*.dump`, `*.pgdump`, `.env*`, `*.pem`, `*.key`.
- Pre-push hook: same `gitleaks` scan against the push range; block push on finding.
- CI job `guard-publish.yml` on every PR: runs `npm pack --dry-run`, uploads tarball listing as artifact, fails if size/secret thresholds exceeded.
- Convert suspicious local git user `Test <test@test.com>` into an identity-guard hook (refuse commits with that author email).
- `CODEOWNERS` requires a security reviewer on any change to `package.json`, `.gitignore`, `.npmignore`, CI publish workflows.

Validation:
- Deliberately stage a 2 MB fake `snapshot.sql.gz` on a scratch branch — commit is blocked, push is blocked, and CI `guard-publish` fails.
- `npm pack --dry-run` on `HEAD` lists only allow-listed paths; total size < 10 MB.
- `npm publish` attempts from a non-CI machine are rejected (no valid token + provenance required).

### Group E — Document (wave 4, parallel with D)
**Goal:** post-mortem, advisory, runbook.

Deliverables:
- `.genie/incidents/2026-04-14-npm-key-leak.md` — timeline, root cause, blast radius, contributing factors, remediation, prevention, lessons learned.
- `SECURITY.md` at repo root — how to report, scope, response SLA, rotation policy.
- GHSA body authored and reviewed.
- `docs/runbooks/npm-publish-incident.md` — future-you runbook for this exact class.
- Update `CLAUDE.md` "Gotchas" section to call out `files`-allow-list / `.npmignore` as required, with a link to the incident doc.

Validation:
- Links resolve; docs reviewed by at least one person outside the authoring agent.
- Runbook is exercised against a scratch package as a tabletop.

## Dependencies

```
A (contain)  ─┐
              ├─→  C (purge)  ─┐
B (rotate)  ─┘                 ├─→  D (prevent)  ─→  next release
                               └─→  E (document)
```

Group C must not start until Group B is ≥95% done: purging history before rotation is finished gives a false sense of security while exposed secrets remain valid.

## QA Criteria
- Automated: `scripts/prepack-guard.ts` unit tests, `guard-publish.yml` on a PR that intentionally violates each rule.
- Manual: tabletop with the on-call engineer simulating a re-occurrence; pre-commit and CI both stop the violation at distinct layers.
- Secret rotation verification: each entry in the credential inventory has a test or manual-check log proving the old credential now fails.

## Assumptions / Risks

- **Assumption:** npm's 72-hour unpublish window has closed for early versions. Verify per-version before defaulting to `deprecate`.
- **Assumption:** Tenants represented by JWT `company_id` claims are our customers. If any belong to third-party integrations, legal-disclosure obligations apply (GDPR/LGPD 72h).
- **Risk:** Force-pushing history rewrites breaks open PRs and local clones. Mitigation: freeze merges for 4h, announce cutover, provide `git fetch --prune && git reset --hard origin/<branch>` one-liner.
- **Risk:** Someone re-introduces the same dump path out of muscle memory. Mitigation: Group D hooks explicitly blocklist `snapshot.sql*`.
- **Risk:** Other `@automagik` packages use the same no-`files` pattern. Mitigation: Group D includes an audit across the org with the same checks.
- **Risk:** The dump may contain PII beyond keys (emails, phone numbers, message bodies). Treat Group B inventory as also a PII inventory; notify tenants accordingly.

## Review Results
*(to be filled by `/review` after Group D + E merge)*

## Files to Create/Modify

Create:
- `.npmignore`
- `SECURITY.md`
- `.genie/incidents/2026-04-14-npm-key-leak.md`
- `.genie/incidents/2026-04-14-credential-inventory.md`
- `scripts/prepack-guard.ts`
- `scripts/verify-rotated.ts`
- `.github/workflows/guard-publish.yml`
- `.husky/pre-commit` (extend), `.husky/pre-push` (new)
- `docs/runbooks/npm-publish-incident.md`
- `CODEOWNERS`

Modify:
- `package.json` — add `files` allow-list, replace `prepack` to invoke `prepack-guard`, remove any direct `npm publish` scripts
- `.gitignore` — add `.genie/snapshot.sql*`, `*.sql`, `*.sql.gz`, `*.dump`, `*.pgdump`, `*.pem`, `*.key`, `.env*`
- `.github/workflows/*publish*.yml` — switch to Trusted Publishing / OIDC, drop `NPM_TOKEN`
- `CLAUDE.md` — Gotchas section: link to incident + rules
- `README.md` — link to `SECURITY.md` and GHSA

Delete from tree and history:
- `.genie/snapshot.sql.gz`
