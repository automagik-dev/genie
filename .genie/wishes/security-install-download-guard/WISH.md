# Wish: Security Install Download Guard

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `security-install-download-guard` |
| **Date** | 2026-04-27 |
| **Author** | Codex security planning agent |
| **Appetite** | small |
| **Branch** | `wish/security-install-download-guard` |
| **Repos touched** | `automagik-dev/genie` |
| **Design** | [DESIGN.md](../../brainstorms/security-roadmap-microprs/DESIGN.md) |

## Summary

Genie currently downloads install-time binaries and can execute remote Bun install scripts without a local integrity gate. This wish ships the first security microPR: checksum verification for tmux downloads, safe handling for custom `GENIE_TMUX_URL`, and explicit opt-in for remote Bun bootstrap execution.

The goal is a narrow, reviewable supply-chain hardening step that reduces install/setup risk without redesigning Genie's release system.

## Scope

### IN

- Add a committed tmux asset integrity manifest for every supported `TMUX_VERSION=3.6a` platform asset: `linux-x64`, `linux-arm64`, `darwin-arm64`, and `darwin-x64`.
- Verify the downloaded tmux tarball SHA256 before extraction/copy in `scripts/postinstall-tmux.js`.
- Verify the downloaded tmux tarball SHA256 before extraction/copy in `src/lib/ensure-tmux.ts`.
- Require an expected SHA256 when `GENIE_TMUX_URL` points at a non-default tmux asset URL.
- Provide an explicit unsafe override for custom tmux URLs, with loud stderr/stdout logging and no default enablement.
- Stop `scripts/smart-install.js` from executing Bun remote install scripts automatically unless an explicit opt-in environment variable is set.
- Add offline tests or fixtures proving tampered bytes and wrong SHA256 values are rejected before extraction.
- Add a short security note documenting the install-time download trust boundary and the new environment variables.

### OUT

- Cosign, SLSA, or full release provenance implementation; `genie-supply-chain-signing` owns that track.
- Brain release artifact verification; task `#59` / MicroPR 5 owns that follow-up.
- Replacing the installer, package manager, or tmux auto-provisioning UX.
- Network-backed CVE scanning or dependency update automation.
- Runtime authorization changes for worker services, agent launch, or event streams.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Start with tmux/Bun setup paths | These paths run during install/setup and are isolated enough for one microPR. |
| 2 | Verify tarball bytes before any extraction | Extraction is the first unsafe boundary; tampered bytes must fail before `tar` runs. |
| 3 | Keep a small committed SHA256 manifest | A manifest is auditable, testable, and easier to update when `TMUX_VERSION` changes. |
| 4 | Custom `GENIE_TMUX_URL` requires digest pinning by default | Custom binary sources are useful for testing but should not silently bypass integrity. |
| 5 | Unsafe override remains possible but loud | Incident/debug workflows may need it; the operator must see the exact risk-bearing env var. |
| 6 | Remote Bun install script execution becomes opt-in | Piping remote scripts to a shell is too powerful to happen automatically in a hardening track. |

## Success Criteria

- [ ] `scripts/postinstall-tmux.js` rejects tampered tmux archive bytes before extraction.
- [ ] `src/lib/ensure-tmux.ts` rejects tampered tmux archive bytes before extraction.
- [ ] Every supported default tmux asset for `TMUX_VERSION=3.6a` has an expected SHA256 in a committed manifest or constant.
- [ ] `GENIE_TMUX_URL` without a matching expected SHA256 refuses by default.
- [ ] `GENIE_TMUX_URL` with a wrong SHA256 refuses with an error that names both expected and actual digest prefixes.
- [ ] The explicit unsafe custom-url override works only when its env var is set and logs an unsafe warning.
- [ ] `scripts/smart-install.js` prints manual Bun install instructions by default instead of running `curl | bash` or `irm | iex`.
- [ ] `scripts/smart-install.js` remote Bun bootstrap execution only runs when the opt-in env var is set.
- [ ] Validation can run without network access.

## Dependencies / Related Work

| Relationship | Item | Reason |
|--------------|------|--------|
| parent task | `#55` | Genie Security board task selected as first ready microPR. |
| related wish | `genie-supply-chain-signing` | Full release signing/provenance remains separate. |
| related task | `#59` | Brain artifact verification is a later microPR. |
| blocks | `#55` completion | This wish should move `#55` through `micropr` and `review` once implementation starts. |

## Execution Strategy

### Wave 1 (sequential)

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Add tmux integrity manifest/helper and enforce SHA256 verification in both tmux download paths. |

### Wave 2 (after Group 1)

| Group | Agent | Description |
|-------|-------|-------------|
| 2 | engineer | Gate remote Bun bootstrap execution, document env vars, and add final validation coverage. |

## Execution Groups

### Group 1: Tmux Download Integrity Gate

**Goal:** Ensure downloaded tmux archives are verified before extraction in both install-time and runtime auto-provisioning paths.

**Deliverables:**
1. A committed tmux asset SHA256 manifest or equivalent constant set for `TMUX_VERSION=3.6a` and all supported platform assets.
2. Digest verification in `scripts/postinstall-tmux.js` before writing/extracting the archive.
3. Digest verification in `src/lib/ensure-tmux.ts` before writing/extracting the archive.
4. Safe `GENIE_TMUX_URL` behavior:
   - Default URL uses the committed manifest.
   - Custom URL requires an expected SHA256 env var unless explicit unsafe override is set.
   - Wrong SHA256 refuses before extraction.
5. Tests covering default asset hash lookup, tampered bytes, missing custom-url hash, wrong custom-url hash, and unsafe override warning.

**Acceptance Criteria:**
- [ ] Tampered fixture bytes fail before `tar`/copy is invoked in `scripts/postinstall-tmux.js`.
- [ ] Tampered fixture bytes fail before `tar`/copy is invoked in `src/lib/ensure-tmux.ts`.
- [ ] Hash manifest covers `tmux-3.6a-linux-x86_64.tar.gz`, `tmux-3.6a-linux-arm64.tar.gz`, `tmux-3.6a-macos-arm64.tar.gz`, and `tmux-3.6a-macos-x86_64.tar.gz`.
- [ ] Custom `GENIE_TMUX_URL` without expected SHA256 fails closed.
- [ ] Custom `GENIE_TMUX_URL` with wrong SHA256 fails closed.
- [ ] Unsafe override prints a warning that includes the override env var name and the phrase `unverified`.

**Validation:**
```bash
/home/genie/.bun/bin/bun test scripts/postinstall-tmux.test.ts src/lib/ensure-tmux.test.ts
/home/genie/.bun/bin/bun run typecheck
/home/genie/.bun/bin/bunx biome check scripts/postinstall-tmux.js src/lib/ensure-tmux.ts
```

**depends-on:** none

---

### Group 2: Bun Bootstrap Opt-In and Security Note

**Goal:** Prevent automatic remote Bun install-script execution by default and document the new install-time trust boundary.

**Deliverables:**
1. `scripts/smart-install.js` behavior change:
   - Missing Bun prints manual install guidance by default.
   - Remote script execution only runs when an explicit opt-in env var is present.
   - Windows PowerShell and POSIX shell paths both obey the same opt-in rule.
2. Tests or script-level validation proving default missing-Bun behavior does not call `execSync('curl ... | bash')` or PowerShell `irm ... | iex`.
3. A short security note documenting:
   - tmux default asset hash verification.
   - custom `GENIE_TMUX_URL` digest requirement.
   - unsafe override purpose and risk.
   - Bun remote installer opt-in variable.
4. Package/script validation updated if a new manifest/test file needs to be included.

**Acceptance Criteria:**
- [ ] With Bun missing and no opt-in env var, `scripts/smart-install.js` prints manual install instructions and exits/fails without executing a remote script.
- [ ] With the opt-in env var set, existing remote Bun bootstrap behavior is reachable and visibly logged.
- [ ] Windows and non-Windows command branches are both covered by tests or explicit validation seams.
- [ ] Security note includes every new environment variable and states the default safe behavior.
- [ ] Group 1 validation still passes after smart-install changes.

**Validation:**
```bash
/home/genie/.bun/bin/bun test scripts/smart-install.test.ts scripts/postinstall-tmux.test.ts src/lib/ensure-tmux.test.ts
/home/genie/.bun/bin/bun run typecheck
/home/genie/.bun/bin/bunx biome check scripts/smart-install.js scripts/postinstall-tmux.js src/lib/ensure-tmux.ts docs/security
```

**depends-on:** Group 1

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] Fresh install path with system tmux already present still skips download.
- [ ] Fresh install path without tmux verifies default tmux asset digest before extraction.
- [ ] Runtime `ensureTmux()` path verifies default tmux asset digest before extraction.
- [ ] Custom tmux URL refuses without expected SHA256 and refuses with wrong SHA256.
- [ ] Unsafe custom tmux URL override is visibly warned and not enabled by default.
- [ ] Missing Bun no longer triggers automatic remote script execution unless opt-in env var is set.
- [ ] All new tests run offline.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Published tmux 3.6a asset bytes differ by platform or are republished | High | Commit digest manifest and fail closed; updating `TMUX_VERSION` requires updating hashes in the same PR. |
| Checksum-only verification does not prove publisher identity | Medium | This is a first guardrail; release signing/provenance remains a separate wish. |
| Postinstall script packaging misses a new manifest/helper file | High | Keep manifest under an already shipped `scripts/` path or update `package.json` `files` allowlist in this wish. |
| Bun bootstrap opt-in breaks first-run convenience | Medium | Print exact manual commands and a clearly named opt-in env var for users who accept the risk. |
| Tests touch the network and become flaky | Medium | Use fixture bytes and injected fetch/spawn seams; validation must pass offline. |
| Duplicate verification logic drifts between JS script and TS helper | Medium | Prefer a shared manifest and parallel tests that assert both paths use the same asset names and expected hashes. |

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
scripts/postinstall-tmux.js
scripts/postinstall-tmux.test.ts
src/lib/ensure-tmux.ts
src/lib/ensure-tmux.test.ts
scripts/smart-install.js
scripts/smart-install.test.ts
scripts/tmux/tmux-sha256.json
docs/security/install-downloads.md
package.json
```
