# Wish: Genie Supply-Chain Signing

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `genie-supply-chain-signing` |
| **Date** | 2026-04-23 |
| **Author** | Genie Council (split from sec-scan-progress monolith per reviewer verdict) |
| **Appetite** | medium |
| **Branch** | `wish/genie-supply-chain-signing` |
| **Repos touched** | `automagik-dev/genie` |
| **Umbrella** | [canisterworm-incident-response/DESIGN.md](../../brainstorms/canisterworm-incident-response/DESIGN.md) |
| **Council** | [../sec-scan-progress/COUNCIL.md](../../brainstorms/sec-scan-progress/COUNCIL.md) |

## Summary

`@automagik/genie` was weaponized as part of the CanisterWorm/TeamPCP compromise. The scanner that detects the compromise ships through the same npm pipe. Until every release is signed and the running binary can prove its identity, `genie sec remediate --apply` cannot be trusted to mutate a compromised host. This wish ships: cosign-signed release tarballs with SLSA Level 3 provenance, public-key pinning in three independent channels, the `genie sec verify-install` subcommand, and the exact contract for `--unsafe-unverified <INCIDENT_ID>` that `sec-remediate` refuses-without. This wish runs parallel to `sec-remediate` under the umbrella.

## Preconditions

- **Umbrella committed:** `canisterworm-incident-response/DESIGN.md` exists and was approved.
- **Release engineering surface:** access to GitHub Actions + npm publish pipeline + repo secrets store.
- **Key management pre-decision:** Namastex security owner signs off on initial keypair generation ceremony (offline, hardware-backed) before Group 1 starts.

## Scope

### IN

**Signing pipeline**
- GitHub Release workflow signs published tarball + npm package with cosign keyless (OIDC-via-Actions) signing.
- SLSA Level 3 provenance attestation via `slsa-github-generator` reusable workflow.
- Signing key material: cosign keyless (Sigstore + Fulcio) as primary; long-lived fallback key (hardware-backed, offline) for disaster recovery documented in SECURITY.md by the runbook wish.
- Release tag format unchanged; signing artifacts (`.sig`, `.cert`, `provenance.intoto.jsonl`) attached alongside the release tarball.

**Public-key pinning (three independent channels)**
- `SECURITY.md` at repo root contains the pinned public key fingerprint + verification instructions (owned by `sec-incident-runbook` wish for prose; this wish ships the raw key file and fingerprint).
- `/.well-known/security.txt` at the project site contains the same fingerprint (may be empty placeholder if project site doesn't exist yet; documented in the runbook wish).
- **Out-of-band channel**: pinned GitHub issue (title `SIGNING_KEY_FINGERPRINT_<YYYYMMDD>`) in `automagik-dev/genie` repo, updated on every key rotation. Template under `.github/ISSUE_TEMPLATE/signing-key-fingerprint.md` for operators to create.

**Verify-install subcommand**
- `genie sec verify-install` subcommand reads the running binary's manifest + cosign signature + attached provenance, verifies signature against pinned public key, prints signer identity + verification result.
- Exit `0` on verified; non-zero with specific codes on mismatch (`2` = signature-invalid, `3` = signer-identity-mismatch, `4` = provenance-invalid, `5` = no signature material found).
- Verification is offline-capable: pinned key travels with the package; cosign verify runs without network if `--offline` is passed (degrades to signature-only, no transparency-log check).

**`--unsafe-unverified <INCIDENT_ID>` exact contract**
- `INCIDENT_ID` must match regex `^[A-Z]+_[0-9]{4}_[0-9]{2}_[0-9]{2}(_[A-Za-z0-9_]+)?$` (e.g., `BURNED_KEY_2026_04_23`, `CI_PRE_SIGNING_2026_04_23_TEST_HARNESS`).
- Typed ack string: `I_ACKNOWLEDGE_UNSIGNED_GENIE_<INCIDENT_ID>` (operator types this verbatim on prompt).
- `sec-remediate` and any future mutating subcommand must import and enforce this contract from a shared helper `src/sec/unsafe-verify.ts`.
- Audit log records the INCIDENT_ID + typed-ack verbatim when override used.
- Helper exports documented legitimate contexts: `BURNED_KEY_<date>` (public key compromise confirmed by Namastex security), `CI_PRE_SIGNING_<date>_<job>` (CI pipeline before signing ships), `TEST_HARNESS_<date>` (integration tests).

**Key rotation runbook (skeleton in this wish; full prose in sec-incident-runbook)**
- Key rotation procedure documented in `docs/security/key-rotation.md` (created in this wish; referenced from SECURITY.md by the runbook wish).
- Procedure covers: new key generation (offline, hardware-backed), signing ceremony with at least two Namastex officers, fingerprint publication in all three channels, grace period during which both old and new keys verify, retirement of old key.

### OUT

- Scanner observability (`sec-scan-progress`).
- Remediation command surface (`sec-remediate`).
- SECURITY.md prose + incident runbook (`sec-incident-runbook`).
- Hardware Security Module procurement / key ceremony logistics (operational, not code).
- Third-party transparency-log integration beyond what cosign provides by default.
- Package-registry mirroring or cryptographic binding to specific registries.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Cosign keyless (Sigstore + Fulcio) as primary signing mechanism | Industry standard; OIDC-via-Actions means no long-lived signing key in repo secrets; transparency log + Rekor provide public auditability |
| 2 | SLSA Level 3 via `slsa-github-generator` reusable workflow | Council convergence; ships provenance attestation with minimal custom CI code |
| 3 | Three independent pinning channels (SECURITY.md + security.txt + pinned GH issue) | Reviewer validated the sentinel three-channel requirement; attacker must compromise three distribution points to invalidate |
| 4 | `--unsafe-unverified <INCIDENT_ID>` with strict regex contract + typed ack | Reviewer upgraded M2 to HIGH; undefined ack = implementation guess and eroded friction |
| 5 | `src/sec/unsafe-verify.ts` helper imported by every mutating subcommand | Prevents divergent interpretations across `sec-remediate` and any future command |
| 6 | Offline verification supported (no transparency-log call needed) | Incident responders may be on a host with restricted network |
| 7 | Key rotation procedure requires two-officer signing ceremony | Prevents single-officer key compromise from propagating |

## Success Criteria

- [ ] CI workflow publishes cosign-signed tarball + `.sig` + `.cert` + `provenance.intoto.jsonl` on every tagged release.
- [ ] SLSA verifier accepts the provenance attestation against the release artifact.
- [ ] Public key fingerprint is byte-identical in `SECURITY.md`, `/.well-known/security.txt`, and the pinned GH issue.
- [ ] `genie sec verify-install` passes on a signed release.
- [ ] `genie sec verify-install` fails with exit code `2` on a tampered binary (mutation-detection test in CI).
- [ ] `genie sec verify-install --offline` succeeds without network on a signed release.
- [ ] `--unsafe-unverified` regex contract: valid INCIDENT_IDs accept; invalid strings reject.
- [ ] Typed-ack string enforcement: `I_ACKNOWLEDGE_UNSIGNED_GENIE_BURNED_KEY_2026_04_23` accepts; partial variants reject.
- [ ] `src/sec/unsafe-verify.ts` is the only place the ack logic lives; grep audit shows no duplicate contract strings in other files.
- [ ] `docs/security/key-rotation.md` exists with the full procedure.
- [ ] Key-rotation dry-run (test-only keys) can be walked end-to-end in <1 hour.

## Execution Strategy

### Wave 1 (parallel-safe; runs alongside sec-remediate)

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Signing CI pipeline: cosign + SLSA reusable workflow + release artifact signing. |
| 2 | engineer | `genie sec verify-install` subcommand + `src/sec/unsafe-verify.ts` helper + key-rotation docs. |

## Execution Groups

### Group 1: Signing CI Pipeline

**Goal:** Every tagged release ships with cosign signature + SLSA provenance attestation; CI fails a release if signing step fails.

**Deliverables:**
1. `.github/workflows/release.yml` modification: after build + test, invoke cosign keyless signing on the published tarball + npm pack artifact.
2. `slsa-github-generator` reusable workflow integration for Level 3 provenance.
3. Signing artifacts attached to GitHub Release: `<artifact>.sig`, `<artifact>.cert`, `provenance.intoto.jsonl`.
4. `.github/cosign.pub` committed to the repo (public key; the signing is keyless via OIDC so no private key in secrets).
5. CI step that runs `cosign verify` + `slsa-verifier verify-artifact` against the just-built artifact as a sanity check before the release publishes.
6. Signing failure blocks release (workflow exits non-zero; GitHub Release not created).

**Acceptance Criteria:**
- [ ] Tagged release on test branch produces `.sig`, `.cert`, `provenance.intoto.jsonl` as release assets.
- [ ] `cosign verify-blob --certificate-identity <actions-OIDC-identity> <artifact>` succeeds against the signed artifact using the public key.
- [ ] `slsa-verifier verify-artifact <artifact> --provenance-path provenance.intoto.jsonl` succeeds.
- [ ] Tamper test: modify the tarball by one byte, re-run verify — both cosign and SLSA verifiers reject.
- [ ] Signing-step failure test: mock a cosign error in CI; release workflow exits non-zero; no GitHub Release created.

**Validation:**
```bash
# In CI:
cosign verify-blob --certificate-identity "https://github.com/automagik-dev/genie/.github/workflows/release.yml@refs/tags/v*" --signature <artifact>.sig --certificate <artifact>.cert <artifact>
slsa-verifier verify-artifact <artifact> --provenance-path provenance.intoto.jsonl --source-uri github.com/automagik-dev/genie
# Locally (after release):
gh release download v<next> --pattern '*.tgz' --pattern '*.sig' --pattern '*.cert' --pattern 'provenance.intoto.jsonl'
cosign verify-blob --certificate-identity '*' --signature *.sig --certificate *.cert *.tgz  # accepts
```

**depends-on:** none

---

### Group 2: verify-install Subcommand, Unsafe-Verify Helper, Key-Rotation Docs

**Goal:** Ship the client-side verification path and the exact `--unsafe-unverified` contract that `sec-remediate` depends on.

**Deliverables:**
1. `src/sec/unsafe-verify.ts` helper module:
   - Exports `INCIDENT_ID_REGEX` = `/^[A-Z]+_[0-9]{4}_[0-9]{2}_[0-9]{2}(_[A-Za-z0-9_]+)?$/`.
   - Exports `buildTypedAck(incidentId: string): string` returning `I_ACKNOWLEDGE_UNSIGNED_GENIE_<INCIDENT_ID>`.
   - Exports `validateUnsafeUnverified(flag: string | undefined, typedAck: string): Result` used by any mutating subcommand.
   - Exports documented `LEGITIMATE_CONTEXTS` array naming allowed prefixes (`BURNED_KEY_`, `CI_PRE_SIGNING_`, `TEST_HARNESS_`).
2. `genie sec verify-install` subcommand in `src/term-commands/sec.ts`:
   - Reads bundled manifest + signature + cert + provenance.
   - Runs `cosign verify-blob` against `.github/cosign.pub` (embedded into the binary at build time).
   - Optional `--offline` flag skips transparency-log check.
   - Exit codes: `0` verified, `2` signature-invalid, `3` signer-identity-mismatch, `4` provenance-invalid, `5` no signature material found.
   - Human output shows signer identity + verification path + timestamps.
   - `--json` output shape: `{verified: boolean, exit_code, signer_identity, signature_source, verified_at, pinned_key_fingerprint}`.
3. `docs/security/key-rotation.md` covering: offline key generation, two-officer signing ceremony, publication to three pinning channels, grace-period dual-key verification, retirement of old key. Includes a test-key dry-run recipe.
4. Unit tests in `src/sec/unsafe-verify.test.ts` covering regex acceptance/rejection + typed-ack construction + validate-function round-trip.
5. Integration test: verify against a test-release artifact built in CI; also against a deliberately-mutated copy (asserts `exit 2`).

**Acceptance Criteria:**
- [ ] `INCIDENT_ID_REGEX` accepts `BURNED_KEY_2026_04_23`, `CI_PRE_SIGNING_2026_04_23`, `TEST_HARNESS_2026_04_23_JOB_ABC`; rejects `foo`, `burned-key-2026-04-23`, empty string.
- [ ] `buildTypedAck("BURNED_KEY_2026_04_23")` returns `I_ACKNOWLEDGE_UNSIGNED_GENIE_BURNED_KEY_2026_04_23`.
- [ ] `validateUnsafeUnverified` returns success only when flag value passes regex AND typedAck matches exact expected string.
- [ ] `genie sec verify-install` on signed test-release exits `0`; on 1-byte-mutated copy exits `2`.
- [ ] `--offline` mode skips Rekor transparency-log call (network mocked in test; assertion: zero outbound requests).
- [ ] `--json` output shape asserted against JSON Schema fixture.
- [ ] `docs/security/key-rotation.md` link-check passes; test-key dry-run completes in <1 hour in CI.
- [ ] Grep audit: no other file in the repo defines its own unsafe-verify contract.

**Validation:**
```bash
bun test src/sec/unsafe-verify.test.ts src/term-commands/sec.test.ts
bun run typecheck
bunx biome check src/sec/unsafe-verify.ts src/sec/unsafe-verify.test.ts src/term-commands/sec.ts src/term-commands/sec.test.ts
bunx markdownlint-cli2 docs/security/key-rotation.md
genie sec verify-install
genie sec verify-install --offline --json | jq .verified
```

**depends-on:** Group 1

---

## QA Criteria

- [ ] Tagged release on dev branch produces cosign-signed + SLSA-attested artifacts.
- [ ] `cosign verify-blob` + `slsa-verifier verify-artifact` both succeed against the signed release in CI.
- [ ] Tamper test: byte-modified artifact rejected by both verifiers.
- [ ] `genie sec verify-install` passes on signed release; fails with correct exit code on mutated binary.
- [ ] `--unsafe-unverified <INCIDENT_ID>` contract regex + typed ack enforced.
- [ ] Grep audit confirms `src/sec/unsafe-verify.ts` is sole ack definition.
- [ ] Public-key fingerprint byte-identical across three pinning channels (post-publication check).
- [ ] `docs/security/key-rotation.md` exists + link-check passes.

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Cosign keyless infrastructure (Sigstore + Fulcio) goes down mid-release | Medium | Retain long-lived hardware-backed fallback key; release workflow documents the fallback path; runbook covers manual signing ceremony |
| Signing private key compromised | Critical | Cosign keyless means no long-lived private key; ephemeral certs tied to OIDC identity; fallback key is hardware-backed and offline |
| Attacker publishes a malicious release via npm before signing lands | High | Release workflow requires signing to succeed before publish; CI fails closed |
| Public-key channels drift (different fingerprints in different places) | Medium | Post-publication check in release workflow greps all three channels and fails if fingerprints diverge |
| Operator's cosign binary is itself compromised | Medium | Runbook (sec-incident-runbook wish) documents verifying cosign via a separate package manager or prebuilt checksum |
| `--unsafe-unverified` regex too lax or too strict | Medium | Legitimate-context prefixes documented; regex covers only well-formed strings; new contexts require PR + council sign-off |
| Offline-verify mode skips transparency log and misses revoked certs | Medium | Online mode is default; `--offline` is explicit with loud warning; runbook documents when to use |
| Key-rotation ceremony skipped or single-officer-signed | High | Procedure requires two-officer sign-off; CI checks for two co-author signatures on rotation PR |
| Cross-wish drift: `sec-remediate` imports `src/sec/unsafe-verify.ts` before it exists | Medium | Umbrella DESIGN.md documents ship order: this wish ships before `sec-remediate` enters apply-mode testing; pre-ship uses interim constant strings |

## Review Results

_Populated by `/review` after execution completes._

## Files to Create/Modify

```
.github/workflows/release.yml               # modify: add cosign + SLSA signing steps
.github/cosign.pub                          # create: pinned public key
.github/ISSUE_TEMPLATE/signing-key-fingerprint.md  # create: template for out-of-band channel
src/sec/unsafe-verify.ts                    # create: INCIDENT_ID regex + typed-ack helper
src/sec/unsafe-verify.test.ts               # create: regex + typed-ack tests
src/term-commands/sec.ts                    # modify: add verify-install subcommand
src/term-commands/sec.test.ts               # modify: subcommand dispatch test
docs/security/key-rotation.md               # create: rotation procedure + two-officer ceremony
package.json                                # modify: add cosign binary dependency in devDeps for local verification
```
