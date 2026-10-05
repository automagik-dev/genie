# Design: npm-only reproducible toolchain

| Field | Value |
|---|---|
| **Slug** | `mikro-npm-only-toolchain` |
| **Date** | 2026-08-31 |
| **WRS** | 100/100 |

## Problem

Mikro advertises two lock authorities even though repository-owned installation uses npm and the stale Bun lock cannot reproduce the tree. One fail-fast npm contract is needed so every repository-owned installer resolves the same dependency state. Raw package-manager commands and installation of Mikro as a git dependency must be classified separately because the repository cannot execute code before npm starts those operations.

## Scope

### IN
- Delete tracked `bun.lock`; retain `package-lock.json` as the sole lock authority for the Mikro repository.
- Add one dependency-free Node guard that implements the exact authority checks below.
- Run the guard before any dependency-tree mutation in every repository-owned install path: the documented local wrapper, CI, `scripts/install.sh`, `mikro update` in source and committed build output, and launcher self-heal.
- Replace the documented raw local `npm ci` command with the owned wrapper and align the git-dependency documentation with its honest boundary.
- Prove clean wrapped install, audit, typecheck, build, tests, generated-output equality, install/update smoke, and remote-dev install/read-back.

### OUT
- Intercepting an operator who deliberately runs raw `npm ci`; that command starts npm before repository code can enforce a pre-mutation check and is no longer a documented supported install path.
- Claiming pre-mutation protection for `npm install github:automagik-dev/mikro`. This remains a supported consumer-side git dependency path, but npm controls and may mutate the consumer project before Mikro lifecycle code can run. The consumer's manifest and lock govern that tree; Mikro's repository guard governs only a Mikro checkout.
- Adding a lifecycle hook to simulate “before npm,” dependency upgrades, Bun support, Node/npm version changes, action pinning, installer redesign, attestations, package publishing, or changes owned by the other six child designs.

## Approach

Use npm plus the committed package lock as the repository's only dependency state. Add `scripts/check-npm-authority.mjs`, using Node built-ins only, and expose the documented local command as `npm run deps:ci` (`node scripts/check-npm-authority.mjs && npm ci`). Repository-owned paths must invoke that guard directly or through this wrapper before spawning npm or moving, deleting, or creating `node_modules`.

### Exact guard contract

The guard runs from the repository root and exits nonzero with the offending path/field and npm-only remediation when any rule fails:

1. `package.json` and `package-lock.json` both exist and parse as JSON objects.
2. `package-lock.json.lockfileVersion` is exactly `3`, and `package-lock.json.packages[""]` exists as an object.
3. Manifest/lock coherence is key-order-independent and exact for these fields only:
   - `package.json.name` equals both `package-lock.json.name` and `package-lock.json.packages[""].name`;
   - `package.json.version` equals both `package-lock.json.version` and `package-lock.json.packages[""].version`;
   - `dependencies`, `devDependencies`, and `engines` in `package.json` deeply equal the corresponding objects in `package-lock.json.packages[""]` (an absent field is normalized to `{}` on both sides).
4. None of this explicit competing-lock set exists at repository root: `bun.lock`, `bun.lockb`, `yarn.lock`, `pnpm-lock.yaml`, `pnpm-lock.yml`, `npm-shrinkwrap.json`.

No other manifest fields, transitive package entries, lockfiles outside the repository root, or consumer-project state are part of this guard.

### Owned install-path ordering

| Journey | Production seam | Required ordering |
|---|---|---|
| Local development | `package.json` script `npm run deps:ci` | guard, then `npm ci`; README uses this wrapper instead of raw `npm ci` |
| CI | `.github/workflows/ci.yml` quality-gate install step | invoke `npm run deps:ci`; no separate unguarded `npm ci` |
| Canonical installer | `scripts/install.sh` (also reached by `npm run install:local`) | after checkout selection but before its `npm ci` and before any `node_modules` mutation |
| In-place updater | `src/cli.ts` and build-owned `dist/src/cli.js` | guard before parking/removing `node_modules`, then run `npm ci` |
| Launcher self-heal | `bin/mikro.mjs` | guard after detecting an incomplete install but before spawning repair `npm ci` or mutating `node_modules` |

`README.md:438`'s direct local `npm ci` is replaced by `npm run deps:ci`; an operator can still bypass repository wrappers, but that bypass is explicitly unsupported by the guard-before-mutation invariant. `README.md:51` and `docs/release-contract.md` retain the consumer git-dependency command while stating that it is consumer-side npm behavior, not a Mikro-checkout install path and not covered by that invariant.

### Release gate

“Release journey” means the candidate-SHA quality gate, not an install added to `.github/workflows/release.yml`. On the exact commit published at the GitHub remote ref `refs/heads/dev`, `.github/workflows/ci.yml` must run the guarded install and `scripts/smoke-install-update.sh`, followed by the declared build/check/test gates; the matching GitHub Actions workflow-runs API object's `.head_sha` field must equal that candidate SHA. That green candidate is the install/reproducibility evidence required before merge into the `main` release boundary. `.github/workflows/release.yml` performs release-metadata/version work without dependency installation and remains outside the install-path edits; it must not acquire `npm ci` for this wish.

### Pre-mutation fixture matrix

A table-driven test creates a fresh temporary checkout for each invalid fixture and runs each owned seam (local wrapper, CI install command, installer, source updater/committed updater behavior, and launcher self-heal) with a fake `npm` first on `PATH`. Before invocation it writes a sentinel under `node_modules` and clears both the fake-npm invocation marker and `node_modules.prev`. Every case must exit nonzero with actionable guidance while the sentinel bytes remain identical, the fake-npm marker remains absent, and `node_modules.prev` remains absent. This proves rejection happened before npm launch and, for updater, before parking the existing tree.

The fixture set is frozen to:
- missing `package.json`; malformed `package.json`;
- missing `package-lock.json`; malformed `package-lock.json`;
- non-`3` `lockfileVersion`; missing/non-object `packages[""]`;
- one mismatch at a time for `name` at lock top level, `name` at root package, `version` at lock top level, `version` at root package, `dependencies`, `devDependencies`, and `engines`;
- one root file at a time for each rejected lock: `bun.lock`, `bun.lockb`, `yarn.lock`, `pnpm-lock.yaml`, `pnpm-lock.yml`, and `npm-shrinkwrap.json`.

A coherent fixture must reach fake npm exactly once per owned seam, so a test cannot pass merely because the seam never attempts installation. The existing real `scripts/smoke-install-update.sh` remains the happy-path integration proof for canonical install and updater behavior.

### Production path allowlist

Only these production/documentation seams may change for this child wish:

- `package.json`, `package-lock.json`, and deletion of `bun.lock`;
- new `scripts/check-npm-authority.mjs`;
- `.github/workflows/ci.yml`;
- `scripts/install.sh` and `scripts/smoke-install-update.sh`;
- `bin/mikro.mjs`;
- `src/cli.ts` and its build-owned `dist/src/cli.js` (plus only the corresponding generated map/declaration files if a clean build changes them);
- focused `tests/npm-authority.test.ts` and only its clean-build-owned files under `dist/tests/`;
- directly affected `README.md` and `docs/release-contract.md`.

No `.github/workflows/release.yml` edit is needed or allowed by this design. Generated files may change only when reproduced by the normal clean build and must equal the committed output.

## Simplicity Case

- **Simplest complete design:** one lock, one dependency-free guard, one documented local wrapper, with the same guard called at four other owned seams.
- **Added machinery:** one guard and focused table-driven coverage; no durable state, package-manager abstraction, or lifecycle trick.
- **Deferred until measured:** runtime pinning and supply-chain attestations require a separate threat or reproducibility finding.
- **Complexity removed:** dual package-manager state and ambiguous lock precedence.

## Decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | npm/`package-lock.json` is sole repository authority | All repository-owned install paths already use npm. |
| 2 | The pre-mutation invariant covers repository-owned wrappers only | Raw local npm and consumer npm begin outside repository control. |
| 3 | The explicit six-file competing-lock set hard-fails | Silent precedence recreates drift; a closed set is testable. |
| 4 | No dependency versions change | This wish repairs authority, not the dependency set. |
| 5 | Release evidence is candidate-SHA CI plus install/update smoke | The metadata release workflow performs no install. |
| 6 | Delivery begins only from expected clean dev tip after B0/P0 bootstrap | The dirty checkout cannot attest reproducibility. |

## Risks & Assumptions

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | An owned install seam invokes npm or parks `node_modules` first | High | Run the frozen invalid-fixture matrix against every enumerated seam with sentinel and fake-npm tripwires. |
| 2 | Users mistake raw local or consumer npm for guarded paths | Medium | Document the local wrapper and state the consumer boundary beside the git-dependency command. |
| 3 | Deleting Bun lock breaks a hidden supported workflow | Medium | Public docs/help search must show no supported Bun install; otherwise scope blocks. |
| 4 | Generated output drifts | Medium | Clean build and source/dist equality gate on the exact candidate SHA. |

## Success Criteria

- [ ] `package-lock.json` is the sole supported repository lock authority; the exact structural and five manifest-field checks pass, and all six declared competing locks are absent.
- [ ] Every frozen invalid fixture fails with actionable npm-only guidance before npm launch or any `node_modules` mutation across the local wrapper, CI, canonical installer, source/committed updater, and launcher self-heal; the coherent fixture reaches npm once.
- [ ] Documentation replaces raw local `npm ci` with `npm run deps:ci` and accurately excludes both deliberate raw npm bypass and consumer git-dependency installation from the repository-owned pre-mutation guarantee.
- [ ] Clean wrapped install, audit, typecheck, build, full tests, real install/update smoke, and generated-output equality pass on the exact integrated dev SHA.
- [ ] GitHub remote `refs/heads/dev`, the matching Actions workflow-runs API `.head_sha`, and installed checkout HEAD equal the candidate SHA before and after install/read-back proving npm-only repository behavior; release metadata remains a no-install workflow.
- [ ] Diff is confined to the production path allowlist, with no dependency version changes.

## Next Step

After an independent review of this DESIGN returns SHIP and its evidence verifies, run `wish` for `mikro-npm-only-toolchain` only.

<!-- genie-design-review:start -->
## Design Review Evidence

- **Verdict:** SHIP
- **Reviewed content SHA-256:** `341755ca5beb2e8e73892ebfbb303b1e840e3acaf57421d8c865f45f6d953f03`
- **Reviewer:** `openai-codex:gpt-5.6-sol-900k`
- **Reviewed at:** `2026-08-31T21:35:05Z`
<!-- genie-design-review:end -->
