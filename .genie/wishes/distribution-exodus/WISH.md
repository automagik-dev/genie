# Wish: Distribution Exodus — own the install channel

> [!IMPORTANT]
> SUPERSEDED by [genie-distribution-cutover](../genie-distribution-cutover/WISH.md) (2026-05-09). Threat-model + 4-channel fingerprint pinning carry forward; CDN/multi-tier execution path does not.


| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `distribution-exodus` |
| **Date** | 2026-04-27 |
| **Author** | Felipe + Genie (security planning) |
| **Appetite** | medium (~2 weeks) |
| **Branch** | `wish/distribution-exodus` |
| **Repos touched** | `automagik-dev/genie` |
| **Design** | [DESIGN.md](../../brainstorms/aegis-distribution-sovereignty/DESIGN.md) |
| **Umbrella** | [aegis-distribution-sovereignty](../../brainstorms/aegis-distribution-sovereignty/DESIGN.md) (Wave 1, sub-project A) |

## Summary

Genie ships through `npmjs.com`, a registry that has no enforcement of cosign signatures at install time and allows arbitrary `postinstall` scripts in transitive deps — the same pipe that was weaponized in the April 2026 CanisterWorm/TeamPCP incident. This wish closes the structural exposure by shipping genie via our own CDN with cosign + SLSA + SHA256 verification, mirroring Claude Code's `curl -fsSL https://claude.ai/install.sh | bash` pattern. After this wish, every install (including the deprecated npm path) flows through cosign-verified pipes; the npm package becomes a ≤50-LOC deprecation shim with a hard sunset date.

## ⚠️ Council Amendment 2026-05-04 — Single-CDN day-1 (Fastly deferred)

**Council deliberation (deployer + operator + sentinel + simplifier, unanimous, 2026-05-04) amends this wish from "Cloudflare primary + Fastly secondary + GitHub Releases tertiary" to "Cloudflare primary + GitHub Releases tertiary; defer Fastly."**

Key reasoning (sentinel, novel finding): multi-CDN closes ZERO security attack classes that cosign+SLSA doesn't already close. **Worse**, multi-CDN as currently specified introduces a downgrade-attack class — Cloudflare serves binary-A (signed, valid), Fastly serves binary-B (signed, valid, but stale-with-CVE) due to a publish race or Fastly-only credential compromise; cosign verifier passes both. Mitigations exist (Rekor transparency log monitoring with alerts on unexpected entries, TUF-style timestamped version metadata so install.sh refuses stale-but-valid artifacts) but are NOT in this wish. Multi-CDN without downgrade defenses is net-negative for security.

Per simplifier + operator: Fastly is fictional today (no account), Cloudflare's anycast across 250+ PoPs is itself the redundancy story, and Cloudflare + GitHub Releases is already a 2-provider story across uncorrelated failure domains.

**Real ROI lives elsewhere (added to scope by this amendment):**
- **Secondary DNS provider** with zone replication (Cloudflare DNS + NS1 or Route53). Protects against the failure mode multi-CDN can't fix (DNS provider outage, registrar takeover).
- **Rekor transparency log monitoring** with alerts on unexpected entries — defends against the cosign-key-compromise attack class that multi-CDN cannot.
- **Cosign signing key hardening** — least-privilege scope, required reviewers on publish workflow, audit on key access.
- **Tested CF-down → GitHub Releases runbook** — quarterly DR drills.

**Trigger to revisit Fastly:** A real Cloudflare outage that demonstrably blocks real genie users — measure first, build second. When Fastly is added, downgrade defenses (Rekor + TUF) ship FIRST.

References below to "Fastly secondary," "Multi-CDN failover," "Cloudflare with Fastly origin pull failover," etc., are SUPERSEDED by this amendment. Read them as "Cloudflare + GitHub Releases" until the body is rewritten in Wave 1 final draft.

---

## Preconditions

- ✅ `genie-supply-chain-signing` shipped — cosign keyless OIDC + SLSA L3 + verify-install + `--unsafe-unverified` ack contract are landed and provide the signing primitives this wish extends to per-platform binaries.
- DNS control over `automagik.dev` — required for `cdn.automagik.dev` and `get.automagik.dev` subdomains.
- **Cloudflare account provisioned** — already operated by the genie team. (~~Fastly~~ deferred per Council Amendment 2026-05-04.)
- **Secondary DNS provider** with zone replication (e.g., Cloudflare DNS + NS1 or Route53) — added by Council Amendment as the high-ROI redundancy layer that multi-CDN cannot replace.
- **GitHub repository releases enabled** — fallback path; no new credential surface (uses existing GitHub org auth).
- `bun build --compile` validated as the static-binary toolchain on all 5 platform targets (Linux x86_64 glibc/musl, Linux arm64, macOS x86_64/arm64). Sub-project A Group 1 includes a feasibility gate; if `bun build --compile` cannot produce working binaries on any target, fallback is `pkg` or `nexe` (decision in Group 1).

## Scope

### IN

**Static binary build pipeline (Group 1)**
- CI matrix produces per-platform binaries via `bun build --compile`:
  - Linux x86_64 glibc, Linux x86_64 musl, Linux arm64, macOS x86_64, macOS arm64
- Each artifact is a single static executable; runs `genie --version` on a clean container with no Bun install.
- Build reproducibility: same source commit produces byte-identical binaries across CI runs (ignoring timestamps).

**CDN + manifest + signed publishing pipeline (Group 2)**
- DNS: `cdn.automagik.dev` (CNAME → Cloudflare primary), `get.automagik.dev` (CNAME → CDN edge for installer hosting).
- Path layout: `cdn.automagik.dev/genie/<channel>/<version>/<platform>/{genie,manifest.json,genie.sig,genie.cert,provenance.intoto.jsonl}`.
- Channels: `stable`, `beta`, `canary` — each with separate cosign signing identities; channel directory selects which identity verifies.
- `manifest.json` schema (versioned): `{schema_version: 1, channel, version, platform, binary_url, sha256, cosign_sig_url, slsa_provenance_url, released_at, supersedes}`. JSON Schema committed at `docs/security/manifest.schema.json`.
- Release workflow extends existing `genie-supply-chain-signing` cosign pipeline to sign per-platform binaries — today it signs the npm tarball; this wish adds 5 binary signatures + SLSA attestations per release.
- **CDN posture (post Council Amendment 2026-05-04):** Cloudflare primary + GitHub Releases tertiary serving byte-identical cosign+SLSA-signed artifacts. install.sh falls through to GitHub Releases on connect-failure or HTTP 5xx from Cloudflare. ~~Fastly secondary~~ deferred until a real CF outage demonstrably blocks real users; downgrade defenses (Rekor monitoring + TUF timestamps) ship before Fastly is added.
- GitHub Releases attaches the same artifacts (`<platform>-genie`, `<platform>-genie.sig`, `<platform>-genie.cert`, `<platform>-provenance.intoto.jsonl`, `manifest.json`) to every tagged release.

**install.sh bootstrap script (Group 3)**
- Hosted at `get.automagik.dev/genie` (canonical) — 302 redirects to `cdn.automagik.dev/genie/install.sh`.
- Platform detection: `uname -s` (Darwin/Linux/reject Windows-without-WSL with helpful message), `uname -m` (x86_64→x64, arm64/aarch64), `sysctl.proc_translated` (Rosetta 2), libc detection (musl vs glibc via `ldd --version` parse).
- Download flow: latest `manifest.json` → parse → fetch binary → verify SHA256 → verify cosign signature → atomic move to `~/.genie/downloads/genie-<version>` → handoff to binary's own `install` subcommand.
- Verification stack: SHA256 (always); cosign keyless via static portable verifier shipped alongside (`sigstore-rs` compiled to ≤2MB static binary); SLSA L3 attestation via `slsa-verifier` (also static, ≤3MB).
- Cosign public-key fingerprint inlined in `install.sh` as third pinning channel (alongside `SECURITY.md`, `.well-known/security.txt`, pinned GitHub issue from `genie-supply-chain-signing`). Linter enforces byte-identity across all 4 channels.
- Non-pipe install path documented at top of script (`curl -fsSL get.automagik.dev/genie > install.sh; less install.sh; bash install.sh`).
- `INSECURE=1` opt-out for cosign verification (SHA256 floor only) with loud red-text warning to stderr.
- Storage: `$HOME/.genie/downloads/<version>/` for temporary binaries; `~/.local/bin/genie` for the canonical symlink.

**Binary `install` subcommand (Group 4)**
- New top-level subcommand `genie install` — distinct from the `install.sh` bootstrap; the bootstrap downloads the binary, the binary's subcommand wires up the host.
- Symlink `~/.local/bin/genie` → `~/.genie/downloads/<version>/genie` (atomic via `ln -sf` + temp-rename).
- Detects active shell (`$SHELL` + parent process), edits the appropriate rc file (`~/.bashrc`, `~/.zshrc`, `~/.config/fish/config.fish`) to ensure `~/.local/bin` is on `$PATH`. Idempotent: detects pre-existing PATH entry and skips.
- Installs shell completions: `~/.local/share/bash-completion/completions/genie`, `~/.local/share/zsh/site-functions/_genie`, `~/.config/fish/completions/genie.fish`.
- Creates `~/.genie/` directory structure: `~/.genie/state/`, `~/.genie/audit/`, `~/.genie/downloads/`, `~/.genie/config.json` (default).
- First-run UX: prints version, channel, cosign key fingerprint, "verify with `genie sec verify-install`" hint, "join the security mailing list" link.
- Idempotent: safe to re-run; detects existing install, prompts before overwriting `~/.local/bin/genie` if it exists and points elsewhere.

**npm package deprecation shim (Group 5)**
- `@automagik/genie` npm package reduced to ≤50 LOC: `package.json` + `postinstall.js`.
- `postinstall.js`:
  1. Detects platform via `process.platform` + `process.arch`.
  2. Downloads `install.sh` from `get.automagik.dev/genie` via Node's `https` module (no shell-out yet).
  3. Verifies the downloaded `install.sh` against an inlined SHA256 (rotated per package version) — defense-in-depth against attacker who controls neither npm nor the CDN but might intercept either.
  4. Spawns `bash install.sh` with the platform pre-detected via env vars to skip re-detection.
  5. Prints a loud deprecation banner to stdout: "⚠ @automagik/genie via npm is DEPRECATED. Install directly: curl -fsSL get.automagik.dev/genie | bash. Sunset: 2026-10-27." (90-day window from v1 GA).
- Final-version freeze: `package.json` documents the sunset date in `description` field; npm `deprecate` API called on every published version starting from v1 GA.
- Hard sunset action documented (operational): on sunset date + 30 days, all npm versions are `deprecate`-flagged with the install.sh URL; package is NOT unpublished (preserves dependency-graph integrity for forensic tools), but install becomes loud-failure: "this package no longer installs; run: curl -fsSL get.automagik.dev/genie | bash".

### OUT

- **Self-update logic** (`genie self-update`) — owned by sibling wish `genie-self-update` (Wave 2 of the umbrella). The bootstrap installs the latest manifest version on first run; subsequent updates flow through self-update.
- **Aegis daemon distribution** — owned by sibling wish `aegis-runtime` (Wave 2). The same CDN serves Aegis binaries via a parallel directory `cdn.automagik.dev/aegis/<channel>/<version>/<platform>/`, but Aegis distribution mechanics (opt-in install prompt, daemon lifecycle) are out of this wish.
- **Aegis continuous scanner** — owned by sibling wish `aegis-scanner` (Wave 3).
- **Native Windows distribution** — deferred to v2; WSL works via Linux x86_64 binary. install.sh exits with a helpful "use WSL" message on native Windows shells.
- **Kernel-level network enforcement** — out of this umbrella entirely; v2 of `aegis-runtime`.
- **Build-time supply-chain sovereignty** (vendoring our own `bun install` inputs) — separate future umbrella `genie-build-sovereignty`. This wish leaves `bun install` for build-time deps unchanged.
- **Replacing existing `npm install -g @automagik/genie` UX immediately** — soft-deprecate via shim is the chosen transition; hard-cutover would brick existing operators.
- **Differential updates / zstd-bsdiff** — defer to `genie-self-update` wish if it ships; not required for distribution.
- **Runtime telemetry** — install.sh and the binary's install subcommand emit no telemetry; opt-in counters land later if at all.
- **Hardware Security Module procurement / cosign key rotation ceremony** — operational, owned by `genie-supply-chain-signing`'s key-rotation runbook. This wish reuses the existing keypair.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Mirror Claude Code's bootstrap pattern (`https://claude.ai/install.sh` → `https://downloads.claude.ai/claude-code-releases/bootstrap.sh`) | Thin shell + fat binary is industry-proven; minimal trusted compute base in shell; binary owns shell integration + updates |
| 2 | Verification stack = SHA256 + cosign keyless + SLSA L3 (not just SHA256 like Claude Code) | We have the signing infrastructure already (`genie-supply-chain-signing`); strictly more verification raises the floor for every operator |
| 3 | Cosign public-key fingerprint inlined in `install.sh` as the fourth pinning channel | Operators who read the script see the trust anchor before piping to bash; cross-checks against SECURITY.md + .well-known/security.txt + pinned GH issue |
| 4 | Static portable verifier (`sigstore-rs` compiled small) shipped alongside `install.sh` | Solves the chicken-and-egg of "operator needs cosign to verify cosign download" without requiring a system cosign install |
| 5 | `INSECURE=1` SHA256-only fallback path | Compatibility floor for environments where the static verifier fails (corporate proxies, exotic platforms); loud warning prevents silent degradation |
| 6 | Multi-CDN failover with GitHub Releases tertiary | CDN itself is a SPOF; multi-CDN + GitHub Releases as a publicly-auditable mirror raises availability + trust |
| 7 | Channel-aware CDN paths (`stable`/`beta`/`canary`) | Sets up the schema `genie-self-update` will consume; canary lets the genie team dogfood; beta is opt-in early access |
| 8 | npm package = ≤50 LOC deprecation shim with 90-day sunset | Avoids bricking existing operators on `npm update -g`; same security floor as hard cutover (cosign-verified binary either way); loud banner + sunset date locks down the residual surface |
| 9 | Platform matrix v1 = Linux x86_64 (glibc + musl) + Linux arm64 + macOS x86_64 + arm64 (Rosetta-aware) | Mirrors Claude Code's exact matrix; covers >95% of real genie operators; native Windows deferred to v2 (WSL works via Linux binary) |
| 10 | `bun build --compile` as the binary toolchain (with `pkg`/`nexe` as fallback gate in Group 1) | Native to the existing genie build pipeline; produces single static executables; fallback path locks down risk if `bun build --compile` cannot meet platform matrix |
| 11 | Binary's `install` subcommand wires shell integration, NOT install.sh | Keeps the trusted shell-script TCB minimal; binary can do platform-specific shell detection more reliably; mirrors Claude Code split |
| 12 | Idempotent `genie install` (safe to re-run) | Operators who run `install.sh` twice (or who run `genie install` after upgrade) should not get broken state; idempotency is non-negotiable for a new attack surface |
| 13 | `manifest.json` schema versioned (v1) | Future schema changes (Aegis bundling, differential updates) need a forward-compatible field discipline from day 1 |
| 14 | npm package final-version frozen, NOT unpublished, on sunset | Preserves dependency-graph integrity for forensic tools; loud-failure beats history-erasure |

## Success Criteria

- [ ] `bun build --compile` produces working static binaries for all 5 platform targets (Linux x86_64 glibc, Linux x86_64 musl, Linux arm64, macOS x86_64, macOS arm64); each artifact runs `genie --version` on a clean Docker container or fresh macOS host.
- [ ] CI release workflow on a tagged release pushes per-platform binaries, manifests, cosign signatures, and SLSA provenance to `cdn.automagik.dev/genie/stable/<version>/<platform>/` for all 5 targets.
- [ ] `manifest.json` validates against `docs/security/manifest.schema.json`; missing or extra fields fail validation.
- [ ] `cosign verify-blob --certificate-identity <actions-OIDC-identity> <binary> --signature <sig>` succeeds against every published per-platform binary.
- [ ] `slsa-verifier verify-artifact <binary> --provenance-path <provenance>` succeeds against every published binary.
- [ ] Tamper test: modify a binary by 1 byte, re-run verify; both cosign and SLSA verifiers reject; install.sh refuses to proceed.
- [ ] `curl -fsSL get.automagik.dev/genie | bash` on a clean Docker container for each Linux target installs a working `genie` to `~/.local/bin/genie`; `genie --version` matches the channel's latest manifest version.
- [ ] `curl -fsSL get.automagik.dev/genie | bash` on a clean macOS host (x86_64 + arm64) installs a working `genie`; Rosetta detection picks the right arm64 binary on Apple Silicon under Rosetta.
- [ ] `INSECURE=1 curl -fsSL get.automagik.dev/genie | bash` runs SHA256-only with a loud red warning to stderr; cosign verification skipped; banner audit-logged in `~/.genie/audit/install.jsonl`.
- [ ] Cosign public-key fingerprint is byte-identical across 4 channels: `install.sh` inlined comment, `SECURITY.md`, `.well-known/security.txt`, pinned GitHub issue. New linter `scripts/check-fingerprint-pinning.sh` (already exists per repo state — extend it) enforces.
- [ ] `genie install` (binary subcommand) on a clean home: creates `~/.local/bin/genie` symlink, edits shell rc to add `~/.local/bin` to `$PATH` (detects bash/zsh/fish), installs completions, creates `~/.genie/` structure. Idempotent.
- [ ] CDN failover test: simulated Cloudflare 5xx; install.sh transparently falls through to Fastly; subsequent failover to GitHub Releases; all paths cosign-verify identically.
- [ ] `npm install -g @automagik/genie` produces a working `genie` binary via shim → install.sh delegation; deprecation banner visible on stdout; postinstall script ≤50 LOC.
- [ ] Postinstall shim verifies its own downloaded `install.sh` against an inlined SHA256; mismatch fails install with a clear error.
- [ ] All artifacts (per-platform binaries, manifest.json, install.sh, postinstall.js, static verifier) are cosign-signed via the existing `genie-supply-chain-signing` keyless-OIDC pipeline.
- [ ] Documentation: `SECURITY.md` updated with install instructions + 4-channel fingerprint pinning; `docs/security/distribution-sovereignty.md` explains the threat model and verification flow.

## Dependencies / Related Wishes

| Relationship | Wish | Reason |
|--------------|------|--------|
| depends-on | `genie-supply-chain-signing` (shipped) | Cosign keyless + SLSA L3 + verify-install primitives reused for per-platform binary signing |
| umbrella | `aegis-distribution-sovereignty` | This is sibling A (Wave 1) of the umbrella |
| blocks | `genie-self-update` | Self-updater consumes this wish's CDN + manifest + verification stack |
| blocks | `aegis-runtime` | Aegis daemon binaries distributed via the same CDN created in this wish |
| blocks | `aegis-scanner` | Indirectly — depends on aegis-runtime |
| related | `sec-incident-runbook` (shipped) | SECURITY.md prose for distribution-sovereignty install flow lands here |
| related | `security-assessment-roadmap` (in flight) | Distribution sovereignty is a finding in their roadmap; this wish executes the remediation |

## Execution Strategy

### Wave 1 — Build pipeline foundation (sequential)

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Static binary build pipeline: CI matrix + `bun build --compile` for all 5 platform targets, with feasibility gate. |

### Wave 2 — Signed CDN publishing (sequential after Wave 1)

| Group | Agent | Description |
|-------|-------|-------------|
| 2 | engineer | CDN + manifest + signed publishing pipeline: DNS, multi-CDN, GitHub Releases mirror, manifest schema, signing pipeline extension. |

### Wave 3 — Bootstrap + binary install (parallel after Wave 2)

| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer | install.sh bootstrap: platform detection, verification, static verifier bundling, fingerprint inlining, INSECURE=1 fallback. |
| 4 | engineer | Binary `install` subcommand: shell-rc editing, completions, `~/.genie/` scaffolding, idempotency. |

### Wave 4 — npm transition (sequential after Waves 2 + 3)

| Group | Agent | Description |
|-------|-------|-------------|
| 5 | engineer | npm package deprecation shim + sunset documentation + final-version freeze process. |

## Execution Groups

### Group 1: Static binary build pipeline

**Goal:** CI produces working static genie binaries for all 5 platform targets via `bun build --compile`, with a feasibility gate that locks in the toolchain choice.

**Deliverables:**
1. `.github/workflows/release-binaries.yml` (new): matrix build over `[linux-x86_64-glibc, linux-x86_64-musl, linux-arm64, macos-x86_64, macos-arm64]`. Each matrix leg runs `bun build --compile --target=<triple> src/genie.ts --outfile dist/genie-<triple>` and uploads the artifact.
2. Feasibility gate: each artifact runs `genie --version` on a clean container/host matching the target triple. If any target fails, gate flags as BLOCKED and decision shifts to `pkg` or `nexe` fallback (documented in DEC-10).
3. `scripts/build-binaries.sh` (new): local equivalent of the CI matrix for engineers reproducing the build.
4. Documentation: `docs/security/binary-build.md` explains the toolchain, reproducibility caveats (timestamps, build-id), and how to verify artifact integrity locally.
5. Artifact size budget documented: each binary ≤80 MB compressed (`gzip -9`); flag in CI if exceeded.

**Acceptance Criteria:**
- [ ] CI matrix produces 5 working binaries per release tag.
- [ ] `genie --version` exits 0 on a clean Docker container (Linux targets) or fresh macOS host (Darwin targets) for each triple.
- [ ] Reproducibility check: same source commit produces byte-identical binaries (modulo embedded timestamps/build-id) across two CI runs.
- [ ] Each binary ≤80 MB compressed.
- [ ] If `bun build --compile` fails on any target, fallback path documented in `docs/security/binary-build.md`.

**Validation:**
```bash
# CI matrix (in GitHub Actions)
gh workflow run release-binaries.yml --ref wish/distribution-exodus
gh run watch  # all 5 legs green

# Local reproduction
bash scripts/build-binaries.sh --target linux-x86_64-glibc
docker run --rm -v $PWD/dist:/dist alpine /dist/genie-linux-x86_64-musl --version  # exits 0
```

**depends-on:** none

---

### Group 2: CDN + manifest + signed publishing pipeline

**Goal:** Tagged releases push per-platform binaries + manifests + cosign signatures + SLSA provenance to a multi-CDN with GitHub Releases mirror; manifest schema versioned and validated.

**Deliverables:**
1. DNS configuration: `cdn.automagik.dev` (CNAME → Cloudflare with Fastly origin pull failover), `get.automagik.dev` (CNAME → CDN edge for installer hosting). Documented in `docs/security/dns.md`.
2. `docs/security/manifest.schema.json` (new): JSON Schema for `manifest.json` v1 with fields `{schema_version, channel, version, platform, binary_url, sha256, cosign_sig_url, cosign_cert_url, slsa_provenance_url, released_at, supersedes}`.
3. `.github/workflows/release.yml` modification: extends existing `genie-supply-chain-signing` cosign step to sign all 5 per-platform binaries; emits `manifest.json` per platform; uploads to Cloudflare R2 (or equivalent) at `cdn.automagik.dev/genie/<channel>/<version>/<platform>/`.
4. Multi-CDN replication: same artifacts mirrored to Fastly origin shield + GitHub Releases assets (identical bytes). Replication latency budget: ≤60s post-publish.
5. `scripts/verify-cdn.ts` (new): post-release verification script that fetches each platform's manifest + binary + signatures from each CDN, runs `cosign verify-blob` and `slsa-verifier`, fails CI on any mismatch.
6. `SECURITY.md` extension: documents the 4-channel fingerprint pinning + CDN URLs + verification commands operators can run.

**Acceptance Criteria:**
- [ ] Tagged release on `wish/distribution-exodus` test branch publishes 5 binaries + 5 manifests + 15 signature artifacts (5 × `.sig`, `.cert`, `provenance.intoto.jsonl`) to all three CDN tiers.
- [ ] `cosign verify-blob --certificate-identity <oidc-identity> <binary> --signature <sig>` succeeds for every published binary on every CDN tier.
- [ ] `slsa-verifier verify-artifact <binary> --provenance-path <provenance>` succeeds for every published binary.
- [ ] `manifest.json` validates against `docs/security/manifest.schema.json` for every published release; missing/extra fields fail.
- [ ] Tamper test: byte-flip a binary on Cloudflare; verification rejects; failover to Fastly serves the canonical (unmodified) artifact.
- [ ] Replication latency: artifact published to primary → fetchable from secondary + tertiary in ≤60s (95th percentile across 10 publishes).
- [ ] `scripts/verify-cdn.ts` exits 0 on a healthy release; non-zero with specific error code on signature mismatch (`2`), missing artifact (`3`), schema violation (`4`).

**Validation:**
```bash
bun test scripts/verify-cdn.test.ts
git tag v-test-$(date +%s) && git push --tags
gh workflow run release.yml --ref v-test-<ts>
gh run watch  # all green
bun run scripts/verify-cdn.ts --version v-test-<ts> --channel canary
```

**depends-on:** Group 1

---

### Group 3: install.sh bootstrap script

**Goal:** A thin, auditable `install.sh` that platform-detects, downloads, verifies, and hands off to the binary's own `install` subcommand — mirroring Claude Code's pattern with cosign + SLSA verification on top.

**Deliverables:**
1. `scripts/installer/install.sh` (new): bash script ≤300 LOC. Platform detection logic mirrors Claude Code (`uname -s`, `uname -m`, `sysctl.proc_translated`, `ldd --version` for libc).
2. Static portable verifiers bundled at `cdn.automagik.dev/genie/installer/verifiers/<platform>/{sigstore-verify,slsa-verify}` — compiled from `sigstore-rs` and `slsa-verifier` to ≤2 MB each. install.sh downloads the platform-appropriate pair before the main binary.
3. Cosign public-key fingerprint inlined as a comment block at the top of `install.sh` plus a runtime variable `EXPECTED_COSIGN_FINGERPRINT`. Deployment process: same fingerprint inserted into `SECURITY.md`, `.well-known/security.txt`, pinned GitHub issue (existing 3-channel pinning from `genie-supply-chain-signing` becomes 4-channel).
4. Verification flow:
   - SHA256 always (`shasum -a 256` macOS / `sha256sum` Linux).
   - Cosign signature verification via bundled static verifier — refuses on mismatch.
   - SLSA provenance via bundled `slsa-verifier` — refuses on mismatch.
   - `INSECURE=1` env var bypasses cosign + SLSA, prints a 5-line red banner to stderr, and audit-logs the bypass to `~/.genie/audit/install.jsonl`.
5. Storage: `$HOME/.genie/downloads/<version>/genie` for the verified binary; `~/.local/bin/genie` for the canonical symlink (created by binary's `install` subcommand in Group 4).
6. CDN failover: install.sh tries Cloudflare → Fastly → GitHub Releases on connect/HTTP-5xx; logs each attempt to stderr with `[fallback]` prefix.
7. Non-pipe install path documented at the top of the script: `# Audit the script: curl -fsSL get.automagik.dev/genie > install.sh; less install.sh; bash install.sh`.
8. `scripts/installer/install.test.sh` (new): bats-based tests covering platform detection, verification refuse paths, INSECURE=1 audit log, CDN failover (mocked), idempotency.

**Acceptance Criteria:**
- [ ] `curl -fsSL get.automagik.dev/genie | bash` on a clean Docker container for each of `[ubuntu:22.04, ubuntu:22.04 arm64, alpine:3.19 (musl)]` installs a working `genie`; `genie --version` matches expected channel manifest.
- [ ] `curl -fsSL get.automagik.dev/genie | bash` on a clean macOS x86_64 + macOS arm64 (with and without Rosetta) installs a working `genie`; correct binary picked.
- [ ] Tamper test: byte-flip the binary on the CDN; install.sh refuses; exit code 4 (signature-mismatch); error message names the failed verification.
- [ ] `INSECURE=1` flow prints loud red 5-line warning to stderr; SHA256 verified; cosign + SLSA skipped; bypass logged to `~/.genie/audit/install.jsonl` with timestamp + version + cosign-fingerprint-of-record.
- [ ] CDN failover: simulated Cloudflare 503; install.sh transparently falls through to Fastly; eventually to GitHub Releases; all 3 verification paths succeed identically.
- [ ] Cosign fingerprint linter (`scripts/check-fingerprint-pinning.sh` extension) enforces byte-identity across `install.sh`, `SECURITY.md`, `.well-known/security.txt`, pinned GH issue. Mismatch fails CI.
- [ ] `bash scripts/installer/install.test.sh` passes (bats suite).
- [ ] Native Windows shell (cmd / PowerShell) shows a helpful "use WSL: wsl curl -fsSL ... | bash" message and exits 0 (not a failure).

**Validation:**
```bash
bash scripts/installer/install.test.sh
docker run --rm -it ubuntu:22.04 bash -c 'apt update && apt install -y curl && curl -fsSL https://get.automagik.dev/genie | bash && genie --version'
docker run --rm -it alpine:3.19 sh -c 'apk add curl bash && curl -fsSL https://get.automagik.dev/genie | bash && genie --version'
INSECURE=1 bash scripts/installer/install.sh 2>&1 | grep -E '⚠.*cosign'
bash scripts/check-fingerprint-pinning.sh  # exits 0 (4-channel byte-identity)
```

**depends-on:** Group 2

---

### Group 4: Binary `install` subcommand

**Goal:** Once the binary is on disk, `genie install` wires up shell integration, completions, and `~/.genie/` scaffolding — idempotent, safe to re-run.

**Deliverables:**
1. `src/term-commands/install.ts` (new): top-level `genie install` subcommand registered in `src/genie.ts`.
2. Shell-rc detection + editing:
   - Detects active shell via `$SHELL` and parent-process check.
   - Edits the appropriate file (`~/.bashrc`, `~/.zshrc`, `~/.config/fish/config.fish`) to add `~/.local/bin` to `$PATH` if not already present.
   - Idempotent: detects pre-existing PATH entry by exact-match guard line `# >>> genie PATH >>>` ... `# <<< genie PATH <<<`; never duplicates.
3. Shell completions:
   - `~/.local/share/bash-completion/completions/genie`
   - `~/.local/share/zsh/site-functions/_genie`
   - `~/.config/fish/completions/genie.fish`
   - Generated from existing commander metadata; refreshed on every `genie install`.
4. `~/.genie/` directory scaffolding:
   - `~/.genie/state/`
   - `~/.genie/audit/`
   - `~/.genie/downloads/`
   - `~/.genie/config.json` (default content; not overwritten if exists).
5. Symlink management: `~/.local/bin/genie` → `~/.genie/downloads/<version>/genie` via atomic `ln -sfn` + temp-file rename.
6. First-run UX:
   - Prints version, channel, cosign fingerprint, "verify with `genie sec verify-install`" hint.
   - Banner mentions Aegis daemon (via `genie aegis install` future entrypoint — sibling wish C).
7. `--dry-run` flag: prints what would be modified without modifying.
8. `--reinstall` flag: wipes `~/.local/bin/genie` symlink + completions + rc-edits, then re-runs install. For clean reinstalls.
9. `src/term-commands/install.test.ts` (new): test matrix covers bash/zsh/fish detection, idempotency, dry-run, reinstall, missing `~/.local/bin` (created), pre-existing `genie` symlink (prompts confirmation).

**Acceptance Criteria:**
- [ ] `genie install` on a clean home creates `~/.local/bin/genie`, edits shell rc to add `~/.local/bin` to `$PATH` (correct shell detected), installs completions for the active shell, scaffolds `~/.genie/`.
- [ ] Idempotent: `genie install` run twice in a row produces identical end-state; second run reports "already installed, no changes".
- [ ] `--dry-run` prints planned modifications; touches no files.
- [ ] `--reinstall` wipes prior install, then re-runs; safe even if prior install is partial/broken.
- [ ] Pre-existing `~/.local/bin/genie` pointing elsewhere prompts: `[K]eep existing / [O]verwrite / [A]bort`. Default abort on non-TTY.
- [ ] First-run UX prints the cosign fingerprint matching the inlined value in `install.sh`.
- [ ] Shell-rc edits use exact guard markers (`# >>> genie PATH >>>` / `# <<< genie PATH <<<`); `genie install --reinstall` removes the marked block cleanly without touching unrelated content.
- [ ] Bash completion: `genie <TAB>` lists all top-level commands; works in a fresh bash shell after `source ~/.bashrc`.

**Validation:**
```bash
bun test src/term-commands/install.test.ts
# Manual: docker run -it --rm ubuntu:22.04 bash -c '...install genie...; genie install; source ~/.bashrc; genie sp<TAB>'  # completes to genie spawn
genie install --dry-run | grep '~/.bashrc'  # planned edit visible
```

**depends-on:** Group 2 (binary must exist on CDN to land via Group 3 first; but Group 4's `install` subcommand can be developed in parallel against a local binary)

---

### Group 5: npm package deprecation shim + sunset

**Goal:** `@automagik/genie` npm package becomes a tiny shim that delegates to install.sh and warns operators; final-version freeze documented; sunset date enforced.

**Deliverables:**
1. New npm package layout (replaces current `dist/` distribution):
   - `package.json` — name, version (final), description with sunset date, postinstall script.
   - `postinstall.js` — ≤50 LOC: detects platform, downloads `install.sh` from CDN, verifies inlined SHA256, spawns `bash install.sh` with platform pre-set, prints loud deprecation banner.
   - `README.md` — deprecation notice + canonical install instructions.
2. `package.json` `files` allowlist reduced to `["postinstall.js", "README.md"]` only — removes the multi-MB `dist/` shipping path.
3. Deprecation banner exact text:
   ```
   ⚠️  @automagik/genie via npm is DEPRECATED.
   Install directly:  curl -fsSL https://get.automagik.dev/genie | bash
   Sunset date:       2026-10-27 (90 days post v1 GA)
   See SECURITY.md for the full distribution-sovereignty rationale.
   ```
4. `npm deprecate` API call as part of the release pipeline starting from v1 GA — every published version is flagged with the install.sh URL.
5. Sunset enforcement script (`scripts/npm-sunset.ts`, new): runs on the sunset date, calls `npm deprecate` with a stronger message: "this package no longer installs; postinstall will fail. Run: curl -fsSL get.automagik.dev/genie | bash". Does NOT unpublish (preserves dependency-graph integrity).
6. `docs/security/npm-deprecation.md` (new): explains the soft-deprecate strategy, sunset timeline, and operational steps for the npm sunset.

**Acceptance Criteria:**
- [ ] `postinstall.js` is ≤50 LOC (verified by linter assertion in CI).
- [ ] `npm install -g @automagik/genie` on a clean container produces a working `genie` via shim → install.sh delegation.
- [ ] Deprecation banner visible on stdout during `npm install -g @automagik/genie` (exact text matches deliverable 3).
- [ ] Postinstall verifies its downloaded `install.sh` against an inlined SHA256; mismatch fails install with clear error and exits non-zero.
- [ ] `npm view @automagik/genie deprecated` returns the deprecation message starting from v1 GA.
- [ ] `package.json` `files` allowlist contains exactly `["postinstall.js", "README.md"]` — no `dist/`, no `scripts/`, no `src/`.
- [ ] Tarball size on `npm pack` is ≤10 KB (was multi-MB before).
- [ ] Sunset script `scripts/npm-sunset.ts --dry-run` prints the planned deprecate API call without executing.
- [ ] Documentation: `docs/security/npm-deprecation.md` explains the timeline; linked from `SECURITY.md`.

**Validation:**
```bash
bun run scripts/wish-validate-npm-shim.ts  # asserts postinstall.js ≤ 50 LOC
docker run --rm -it node:20 bash -c 'npm install -g @automagik/genie@<test-tag> 2>&1 | grep "DEPRECATED"'
docker run --rm -it node:20 bash -c 'npm install -g @automagik/genie@<test-tag> && genie --version'
npm pack --dry-run @automagik/genie 2>&1 | awk '/Total files:/ || /package size:/'  # ≤10 KB
bun run scripts/npm-sunset.ts --dry-run
```

**depends-on:** Group 2 (CDN must serve install.sh + binaries), Group 3 (install.sh exists)

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] End-to-end: `curl -fsSL get.automagik.dev/genie | bash` on a clean container per platform target produces a working `genie`; verifications pass; `genie --version` matches latest stable manifest; `~/.local/bin/genie` exists; PATH edit visible in shell rc.
- [ ] Tamper detection: byte-flip a published binary on Cloudflare; install.sh refuses on next install; exit code 4; auditable error.
- [ ] CDN failover: simulated Cloudflare 503; install.sh falls through to Fastly to GitHub Releases; all 3 verify identically; install succeeds.
- [ ] INSECURE=1 audit log: bypass attempt produces a `~/.genie/audit/install.jsonl` entry with timestamp + version + fingerprint-of-record.
- [ ] 4-channel fingerprint pinning: `bash scripts/check-fingerprint-pinning.sh` (extended) exits 0; intentionally mismatching `SECURITY.md` makes it exit non-zero.
- [ ] Idempotent reinstall: `genie install --reinstall` on an existing install produces identical end-state to a fresh install.
- [ ] npm shim path: `npm install -g @automagik/genie` works; deprecation banner visible; `genie --version` matches install.sh path; tarball ≤10 KB.
- [ ] Existing `genie sec verify-install` (from `genie-supply-chain-signing`) reports VERIFIED on a binary acquired via install.sh.
- [ ] Existing tests in `scripts/sec-scan.test.ts`, `src/term-commands/sec.test.ts` continue to pass — no regression in shipped security flows.
- [ ] `bun run check` (typecheck + lint + dead-code + skills:lint + wishes:lint + lint:emit + tests) passes on the wish branch.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| `bun build --compile` cannot produce working static binaries on one or more platform targets | High | Group 1 includes a feasibility gate; if any target fails, fallback to `pkg` or `nexe` is documented; release blocked until either fix or fallback resolves |
| `install.sh` URL itself becomes a TLS interception target | High | Cosign fingerprint inlined as comment + runtime check; documented non-pipe install path; multi-CDN with health-checked failover; 4-channel pinning enforces byte-identity |
| Static portable verifier (sigstore-rs / slsa-verifier) bundled with installer = new attack surface | High | Same cosign-keyless OIDC pipeline signs the verifiers; SHA256 of verifiers inlined in `install.sh`; CDN serves verifiers signed identically to the main binary |
| CDN replication lag → operator hits stale manifest pointing at non-existent binary | Medium | 60s replication budget; manifest references checked by `scripts/verify-cdn.ts` post-publish; install.sh tolerates `binary_url` 404 by falling through to next CDN tier |
| npm shim mishandles platform detection in Node.js (vs install.sh) | Medium | Shim pre-detects platform and passes via env vars to install.sh, which validates and fails fast on mismatch; covered by integration tests in Group 5 |
| Operator's existing `~/.local/bin/genie` is a different artifact (e.g., from a manual download) | Medium | `genie install` prompts on conflict (Keep/Overwrite/Abort, default abort); `--reinstall` flag for clean wipe |
| CDN provider-side compromise (Cloudflare / Fastly account takeover) | Medium | Multi-CDN reduces single-provider risk; cosign + SLSA verification rejects tampered artifacts; GitHub Releases tertiary acts as a public-auditable mirror |
| Native Windows operators see "use WSL" message and conclude genie is broken | Low | Helpful message links to WSL install instructions + roadmap timeline for native Windows v2; `--version` exits 0 on Windows so CI scripts that test for presence still work |
| npm deprecate API behavior changes (or npm bans dynamic postinstall network calls) | Low | Sunset date is enforceable independent of npm-API behavior; if npm bans postinstall network, sunset script can pre-emptively flip to "no installs" state; existing operators on prior versions still get the cosign-signed binary via install.sh |
| Cosign keyless requires Sigstore + Fulcio + Rekor uptime | Low | Offline verification mode supported (signature-only, no transparency-log call); 24-hour cached rekor proofs in manifest; degraded-state audit-logged |
| `bun build --compile` artifact size exceeds 80 MB budget | Low | Group 1 enforces budget in CI; if exceeded, scope reduction (e.g., dropping unused locale data) before increasing budget |
| Operator-installed genie via `npm` and via `install.sh` simultaneously creates conflicting `~/.local/bin/genie` symlinks | Low | npm shim post-install spawns `install.sh` which uses idempotent `genie install`; conflict prompt covers the case |

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
# CI / release pipeline
.github/workflows/release-binaries.yml          create — per-platform bun build --compile matrix
.github/workflows/release.yml                   modify — extend cosign signing to per-platform binaries

# Build pipeline
scripts/build-binaries.sh                       create — local equivalent of CI matrix
scripts/installer/install.sh                    create — bootstrap script (≤300 LOC)
scripts/installer/install.test.sh               create — bats tests
scripts/verify-cdn.ts                           create — post-release CDN verification
scripts/verify-cdn.test.ts                      create — unit tests
scripts/check-fingerprint-pinning.sh            modify — extend to 4-channel pinning (was 3)
scripts/wish-validate-npm-shim.ts               create — assert postinstall.js ≤50 LOC
scripts/npm-sunset.ts                           create — sunset day deprecate-API runner

# Genie binary
src/term-commands/install.ts                    create — `genie install` subcommand
src/term-commands/install.test.ts               create — install subcommand tests
src/genie.ts                                    modify — register `install` subcommand

# npm shim
package.json                                    modify — files allowlist + final-version metadata + postinstall
postinstall.js                                  rewrite — ≤50 LOC shim (was multi-line tmux setup; tmux setup migrates to install.sh)
README.md                                       modify — deprecation notice at top

# Documentation
SECURITY.md                                     modify — install instructions + 4-channel fingerprint pinning
docs/security/manifest.schema.json              create — manifest v1 JSON schema
docs/security/distribution-sovereignty.md       create — threat model + verification flow
docs/security/binary-build.md                   create — toolchain + reproducibility
docs/security/dns.md                            create — CDN DNS configuration reference
docs/security/npm-deprecation.md                create — soft-deprecate strategy + sunset timeline
.well-known/security.txt                        modify — add cosign fingerprint (4-channel pinning)
```
