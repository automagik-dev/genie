# Wish: Remove known production dependency vulnerabilities

| Field | Value |
|-------|-------|
| **Status** | IN_PROGRESS |
| **Slug** | `mikro-dependency-security` |
| **Date** | 2026-08-30 |
| **Author** | Felipe |
| **Appetite** | small |
| **Branch** | `wish/mikro-dependency-security` |
| **Repos touched** | automagik-dev/mikro |
| **Design** | _No brainstorm — direct wish_ |

## Summary

Refresh only the dependency floors and lockfile entries needed to remove the three production vulnerabilities currently reported by `npm audit --omit=dev`: `js-yaml`, `hono`, and `fast-uri`. Preserve Mikro's runtime/API behavior and prove the resulting install, build, tests, and production audit from a clean dependency tree.

## Scope

### IN

- Raise the direct `js-yaml` floor to a non-vulnerable release.
- Refresh the lockfile first; add a transitive override only if a clean lock-only resolution still remains below the patched floor.
- Regenerate `package-lock.json` from the declared manifest and verify the exact resolved versions.
- Run the full repository gate and production dependency audit from `npm ci`.

### OUT

- Major-version upgrades, dependency substitutions, or unrelated package refreshes.
- Changes to Mikro runtime behavior, public APIs, providers, or documentation beyond a changelog note if required.
- Suppressing advisories or lowering the audit threshold.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Apply targeted safe floors/overrides instead of blind `npm audit fix` | The dry run proposed broad node_modules removals while leaving the lockfile vulnerabilities unresolved; explicit floors are auditable and bounded. |
| 2 | Keep the existing SDK/provider versions unless their declared ranges cannot resolve patched transitives | Avoids unrelated runtime change while allowing patched `hono` and `fast-uri` versions already compatible with current parent ranges. |
| 3 | Treat `npm audit --omit=dev --audit-level=moderate` as a release gate | All three findings are in the production lock graph; zero known moderate-or-higher production advisories is the accepted outcome. |

## Simplicity Case

- **Simplest complete design:** change the minimum safe direct/transitive versions, regenerate one lockfile, and run the existing full gate.
- **Added machinery:** only npm `overrides` when a transitive safe floor cannot otherwise be made deterministic; each override must name the advisory it closes.
- **Deferred until measured:** automated dependency-update tooling is deferred until repeated manual security refreshes create measurable maintenance cost.
- **Complexity removed:** no blanket upgrade, alternate package manager, advisory waiver, or custom vulnerability scanner.

## Dependencies

**depends-on:** none
**blocks:** none

## Success Criteria

- [ ] `package-lock.json` resolves `js-yaml >= 4.3.1`, `hono >= 4.12.34`, and `fast-uri >= 3.1.5` with no duplicate vulnerable copy.
- [ ] `npm audit --omit=dev --audit-level=moderate` exits 0 with zero moderate-or-higher production vulnerabilities.
- [ ] `npm ci`, `npm run check`, `npm run build`, `npm test`, and the install/update contract smoke all pass from the updated lockfile.
- [ ] No unrelated direct dependency or public runtime contract changes.

## Execution Strategy

### Wave 1 (sequential)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 1 | engineer | 3 — dependency/lockfile supply-chain judgment +2, shared build surface +1 | engineer-standard / high | Apply targeted patched floors, regenerate the lockfile, and prove the clean production graph. |

Complexity scoring rubric: score each group independently and record the total plus a short rationale in **Complexity**. Add:

- **+2** each for orchestration / agent-lifecycle / routing; cost / model / escalation; stateful work; subjective acceptance.
- **+1** each for multi-package work; OTel-label dependency; no deterministic test; prior rework; prompt-skill change; CI / release work.

Route the total in **Model** by portable role and reasoning effort: **0–1** →
`engineer-trivial` / low; **2–3** → `engineer-standard` / medium or high;
**4–6** → `engineer-complex` / high; **7+** → `engineer-complex` plus an
independent `final-gate` at the highest justified effort. Each runtime maps
these to its matching native roles. Keep model and effort in runtime
session/agent configuration, never skill frontmatter.

## Execution Groups

### Group 1: Patched dependency graph

**Goal:** Produce a minimal lockfile/manifest diff that removes all known moderate-or-higher production dependency advisories without changing Mikro behavior.

**Deliverables:**
1. `package.json` safe direct floor; no transitive override unless a clean lock-only refresh is proven unable to resolve the patched floor.
2. Regenerated `package-lock.json` with one safe resolved version per affected package.
3. `CHANGELOG.md` security note is mandatory if any override is added, naming the affected GHSA and why the parent range alone was insufficient.
4. Evidence recording exact resolved versions, full gate, and zero-advisory audit.

**Acceptance Criteria:**
- [ ] `npm ls js-yaml hono fast-uri` shows only patched versions and exits 0.
- [ ] The production audit exits 0 without `--force`, ignores, or audit-level reduction.
- [ ] Full typecheck, build, 680+ test suite, and `scripts/smoke-install-update.sh` pass after a clean `npm ci`.
- [ ] Diff contains no unrelated package upgrades beyond lockfile convergence required by npm.
- [ ] The executor attempted and recorded a lock-only safe resolution before adding any override; any override has the mandatory GHSA changelog note.

**Validation:**
```bash
npm ci && \
npm ls js-yaml hono fast-uri && \
npm run check && \
npm run build && \
npm test && \
bash scripts/smoke-install-update.sh && \
npm audit --omit=dev --audit-level=moderate
```

This is the repository's full runtime gate plus the exact supply-chain assertion because manifest/lockfile changes affect every install and release.

**depends-on:** none

---

## QA Criteria

_What must be verified on main after merge._

- [ ] A fresh `npm ci` installs the patched graph without lockfile drift.
- [ ] Mikro CLI/MCP tests remain green.
- [ ] GitHub dependency/security checks report no new blocking finding.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| A transitive override is outside its parent's supported range | Medium | Use only versions satisfying the current semver range; prove with `npm ls` and full tests. |
| Lockfile refresh pulls unrelated versions | Medium | Inspect `package-lock.json` diff and revert unrelated convergence where npm allows. |
| Install-script packages execute during clean validation | Medium | Keep existing package provenance, avoid new dependencies, and review `npm ci` output before accepting. |

---

## Review Results

### Plan review — SHIP — 2026-08-30T05:05:44Z

- **Reviewer:** `sa-0-bacee34b` (`hermes-agent:gpt-5.6-sol-900k`)
- **Reviewed content SHA-256:** `18559a59cfb013f213b87b8a03ff9dfcf8576cfd28a0df8f05a5eb40c73afce2`
- **Target base:** `86328c1087930d3341ee1336265da5f6005e54a3`
- **Verdict:** SHIP — zero CRITICAL/HIGH gaps after the correction loop.
- **Verified:** exact patched floors; lock-only-first override rule; moderate-or-higher audit semantics; full check/build/test plus install/update smoke; bounded one-group scope.
- **Pre-execution baseline:** `npm audit --omit=dev --audit-level=moderate` exits 1 with two high and one moderate finding at `js-yaml 4.3.0`, `hono 4.12.32`, and `fast-uri 3.1.4`.

### Group 1 execution review — SHIP — 2026-08-30T06:07:01Z

- **Engineer:** `sa-0-b292796a`; **fixer:** `sa-0-34e7cc99`; **reviewer:** `sa-0-f9a6f8e3`.
- **Verdict:** SHIP after one fix loop; no CRITICAL/HIGH/MEDIUM findings remain.
- **Diff:** direct `js-yaml` floor `^4.3.2`; lock resolves one copy each of `js-yaml 4.3.2`, `hono 4.13.5`, and `fast-uri 3.1.6`; no new override or unrelated dependency/runtime change.
- **Verified independently:** clean isolated `npm ci --include=dev`; `npm ls`; check/build; full 682-test suite; install/update smoke; production audit with zero vulnerabilities; registry integrity matches; `git diff --check` passes.

---

## Files to Create/Modify

```
package.json
package-lock.json
CHANGELOG.md (only if required by convention)
.genie/wishes/mikro-dependency-security/WISH.md
```
