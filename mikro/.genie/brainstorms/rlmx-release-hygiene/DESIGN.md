# Design: rlmx release hygiene

| Field | Value |
|-------|-------|
| **Slug** | `rlmx-release-hygiene` |
| **Date** | 2026-07-25 |
| **WRS** | 100/100 |

## Problem

rlmx's shipped surface has outrun its release metadata: the production
dependency tree carries a **high-severity `js-yaml` DoS advisory** in a tool
whose job is parsing user-supplied YAML (`agent.yaml`, `rlmx.yaml`), the
CHANGELOG's `[Unreleased]` block never mentions the ACP agent, the recursion
event stream, pi-ai 0.80.10, or the station provider, and
`docs/release-contract.md` describes a `dev` → `main` release boundary and a
`drogo/<topic>` branch convention that **no longer exist**. Anyone following
the repo's own documented release process today would follow it into a wall,
and anyone installing it inherits a known advisory.

This matters now because it is the only part of the stable-release program that
is unblocked: it depends on no benchmark, no README, and no new feature.

## Scope

### IN

- **Security.** Resolve the two production-tree advisories — `js-yaml`
  (high, GHSA-h67p-54hq-rp68 / GHSA-52cp-r559-cp3m) and `protobufjs`
  (moderate) — via `npm audit fix`, then re-run the full gate.
- **Release-contract correction.** Rewrite the stale portions of
  `docs/release-contract.md` to match verified reality: `wish/*` and `fix/*`
  merge directly to `main` (no `dev` branch), correct the production checkout
  path, and resolve the `drogo/prod-rlmx` contradiction (the doc forbids a
  long-lived branch that exists on origin).
- **Version-scheme stale context.** Replace the `CHANGELOG.md:6` Semantic
  Versioning claim with an accurate description of the `0.YYMMDD.N` calendar
  scheme (owner decision D1: calendar stays).
- **`scripts/version.mjs` UTC fix.** Its header documents `YYMMDD` as UTC but
  it computes with local-time `getFullYear()/getMonth()/getDate()`. Switch to
  UTC getters so a near-midnight release cannot contradict the contract.
- **CHANGELOG backfill.** Document the ACP agent (#112), the `RecurseEvent`
  stream / `rlmLoop({emitter})` seam, pi-ai 0.80.10 Models runtime, the station
  provider (#110), the station fetch timeout (#111), and the event-stream QA
  fixes (#109); then cut a dated release section.
- **ACP experimental labeling** (owner decision D2) in `README.md`,
  `rlmx --help`, and the ACP docs.
- **npm dist-tag hygiene.** `next` (`0.260528.1`) is older than `latest`
  (`0.260528.2`) and misleads anyone installing `@next`. Repoint it.
- **Cut the release** per the corrected contract: `npm run bump-version`
  (calendar), merge to `main`, tag, GitHub release metadata, npm **SDK-only**
  publish.
- **Repo-root cleanliness.** `HANDOFF.md` is untracked at the repo root —
  relocate under `.genie/` or gitignore it.
- **Issue triage** of #29, #13, #6, #2, including verifying whether #6
  (explicit TTL cache control) is already delivered by `feat-cache-ttl-control`
  + `docs/TTL_CONTROL.md`.

### OUT

- **All benchmark work** — model matrix, Aider polyglot integration,
  checkpoint/resume, running the 4 arms. That is wish 2 (`rlmx-proof`).
- **README rewrite, microagent recipes, demo recording, rtk reciprocity.**
  Wish 3 (`rlmx-launch`) — it cannot start before wish 2 produces numbers.
- **Adopting semver.** Explicitly rejected by D1; calendar versioning stays.
- **SWE-bench Verified.** Deferred post-release.
- **Any new feature or behavior change.** This wish only changes metadata,
  docs, dependency versions, and one date-computation bug.

## Approach

One short-lived `fix/release-hygiene` branch → PR → `main`, following the
*corrected* contract, with work ordered so that value lands even if the wish is
interrupted:

1. **Security first.** `npm audit fix`, then the full gate
   (`npm ci && npm run build && npm test` + `node scripts/smoke-acp.mjs`).
   Independently valuable and the highest-severity item.
2. **Truth second.** Correct `docs/release-contract.md`, `CHANGELOG.md:6`, and
   `scripts/version.mjs`, because step 3 *executes* the process these documents
   describe — fixing them first means the release is performed against an
   accurate contract rather than a fictional one.
3. **Narrative third.** CHANGELOG backfill and ACP experimental labeling.
4. **Release last.** Version bump, merge, tag, GitHub release, npm SDK publish,
   dist-tag repoint, then a post-release install smoke.

**Alternatives considered.** *One combined release train carrying hygiene and
benchmarks* — rejected (D6): it holds a high-severity advisory hostage to a
multi-day benchmark campaign. *Skip the audit fix and ship* — rejected: a YAML
DoS in a tool that parses user-authored YAML is squarely in the threat model,
and the fix is already available. *Adopt semver for a 1.0.0 launch moment* —
rejected by the owner (D1); the calendar scheme was a deliberate migration.

Ordering rationale for step 2 before step 4 is the load-bearing design choice
here: performing a release against a contract known to be wrong is how the
`drogo/prod-rlmx` contradiction arose in the first place.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Keep calendar versioning `0.YYMMDD.N`; correct every doc that claims semver | Owner (D1): the calendar migration was deliberate. `scripts/version.mjs` already implements it; only `CHANGELOG.md:6` still lies. |
| 2 | Label `rlmx acp` **experimental**; everything else stable | Owner (D2). ACP v1 is single-session serialized; labeling it honestly costs little and protects credibility at launch. |
| 3 | Ship hygiene as its own wish, first | Owner (D6). Decouples a high-severity security fix from a multi-day benchmark campaign. |
| 4 | Fix `docs/release-contract.md` **before** executing the release | The release steps are defined by that document; running them against a stale contract is how the current drift happened. |
| 5 | Replace the `npx rlmx` post-install check with an `install.sh` / `rlmx update` smoke | Verified: `package.json` has **no `bin`**, and the contract states npm is SDK-only. The handoff's original check tests something that cannot work by design. |
| 6 | Repoint the `next` dist-tag rather than delete it | Deleting a published tag breaks anyone pinning `@next`; repointing removes the "older than latest" trap without breaking installs. |
| 7 | Investigate `drogo/prod-rlmx` before removing it | The doc forbids it but it exists on origin; it may still be an install authority for a live checkout. Verify, then delete or re-document — never delete blind. |

## Risks & Assumptions

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| 1 | `npm audit fix` bumps a transitive dep and changes runtime behavior | Medium | Full gate after the fix: 420-test suite + `scripts/smoke-acp.mjs`. Any regression → pin the direct dep instead of a blanket fix. |
| 2 | Deleting `drogo/prod-rlmx` breaks a live production checkout that still tracks it | High | Decision 7: verify what (if anything) tracks it before touching. Prefer re-documenting over deleting when uncertain. |
| 3 | `npm audit fix` cannot resolve without a breaking major bump | Medium | Fall back to a scoped override/resolution for `js-yaml` only, and record the residual `protobufjs` exposure explicitly rather than silently. |
| 4 | Publishing the npm SDK is misread as a CLI release | Low | Contract invariant: "npm publishing must not create or imply a CLI release." Release notes state the git-merge boundary explicitly. |
| 5 | Issue #6 closed as delivered when TTL control is only partially implemented | Low | Verify against `docs/TTL_CONTROL.md` and the `feat-cache-ttl-control` wish before closing; if partial, record what remains instead of closing. |
| 6 | Version bumped near midnight yields a date inconsistent with the documented UTC contract | Low | Fixed within this wish (UTC getters) *before* the release step runs. |

**Assumptions.** `origin/main` @ `d7f1878` stays the release base for the
duration of this wish. The owner is the sole publisher (npm + GitHub release
credentials available). No consumer currently depends on the `next` dist-tag
resolving to `0.260528.1` specifically.

## Success Criteria

- [ ] `npm audit --omit=dev` reports **0 vulnerabilities**; any residual dev-only
      advisory is recorded in the PR body with rationale.
- [ ] `npm ci && npm run build && npm test` is green with **≥420 passing, 0
      failing**.
- [ ] `node scripts/smoke-acp.mjs` passes on the release commit.
- [ ] `grep -n "Semantic Versioning" CHANGELOG.md` returns nothing, and the
      CHANGELOG states the `0.YYMMDD.N` calendar scheme.
- [ ] `docs/release-contract.md` contains no reference to a `dev` branch, the
      `drogo/<topic>` convention, or `/home/genie/`, and its described branch
      flow matches the actual merge history of PRs #107–#112.
- [ ] `scripts/version.mjs` uses UTC getters, and the version it generates
      matches `date -u +%y%m%d`.
- [ ] The CHANGELOG has a dated release section naming, at minimum: the ACP
      agent, the recursion event stream, pi-ai 0.80.10, and the station provider.
- [ ] `README.md` and `rlmx --help` both mark `rlmx acp` as experimental.
- [ ] `npm view @automagik/rlmx dist-tags` shows `next` **not older than**
      `latest`.
- [ ] A git tag exists whose target commit's `package.json` and `src/version.ts`
      both equal the tag version (release-contract coherence invariant, line 49).
- [ ] A post-release install smoke passes via `scripts/install.sh` /
      `rlmx update` — **not** via `npx rlmx`, which cannot work (no `bin`).
- [ ] `git status --porcelain` is clean at the repo root (HANDOFF.md relocated
      or ignored).
- [ ] Each of issues #29, #13, #6, #2 is either closed with a verifying
      reference or annotated with why it stays open.

## Next Step

After an independent design review returns SHIP, persist the evidence below and
verify its content digest before running `wish`.

<!-- genie-design-review:start -->
## Design Review Evidence

- **Verdict:** PENDING
- **Reviewed content SHA-256:** PENDING
- **Reviewer:** PENDING
- **Reviewed at:** PENDING
<!-- genie-design-review:end -->
