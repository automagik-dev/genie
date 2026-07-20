# Security Policy

`@automagik/genie` is maintained by [Automagik](https://automagik.dev). We take the security of this package seriously and appreciate responsible disclosure from the community.

---

## Reporting a Vulnerability

**Please do not open public issues for security reports.**

Send private reports to one of the following channels:

| Channel | Address | Best for |
|---------|---------|----------|
| Security email | `privacidade@namastex.ai` | Anything security-related, including coordinated disclosure |
| DPO (privacy + security officer) | `dpo@namastex.ai` | Privacy, LGPD, data protection concerns |
| Private GitHub advisory | [Report via GitHub](https://github.com/automagik-dev/genie/security/advisories/new) | Preferred for CVE assignment and coordinated release |

**PGP** available on request.

### Response SLA

- Acknowledgement: **within 2 business hours** (UTC-3).
- Initial triage and severity assessment: **within 24 hours**.
- Fix or mitigation plan: **within 7 days** for critical/high severity.
- Public disclosure: coordinated with reporter, typically within 30 days of fix.

We will credit reporters publicly (with their permission) in the released advisory.

---

## Supported Versions

| Version line | Status |
|--------------|--------|
| `5.x` | ✅ Supported — current GitHub Releases line |
| `4.260421.33` – `4.260421.40` | ❌ **COMPROMISED — do not use** |
| All other `4.x` releases | ❌ End of life — npm distribution is retired |
| `3.x` | ❌ End of life |
| `0.x` | ❌ End of life |

Install the current stable 5.x line through the repository installer. The repository-hosted stable manifest, not an npm tag or GitHub's `/releases/latest` route, selects the stable version.

---

## Host triage

The current Genie CLI does not contain a host-compromise scanner. If a host may have executed a compromised version, isolate it, preserve volatile and filesystem evidence, consult the current public advisory or GitHub Security Advisory, and rotate exposed credentials from a separate trusted host. Do not install another Genie build on the affected host as a substitute for incident-response tooling.

---

## Past Incidents

### 2026-04 — CanisterWorm supply-chain compromise

Between 2026-04-21 (~22:14 UTC) and 2026-04-22 (~14:00 UTC), versions `4.260421.33` through `4.260421.40` were published to npm by a threat actor after a developer GitHub OAuth token was exfiltrated. The malicious versions contained a credential harvester that executed via `postinstall`.

- **Exposure window:** ~16 hours
- **Detection-to-containment:** under 20 hours
- **Estimated base affected:** ≤ 2% of weekly download volume
- **Current status:** malicious versions `npm unpublish`-ed and no longer installable

**If you installed any version in that range between April 21–22, 2026, treat the host as potentially affected.** Isolate it, preserve evidence, and follow the current public advisory or contact the security team above from a separate trusted host.

**Resources:**

- 🌐 [Public advisory (English)](https://automagik.dev/security)
- 🌐 [Aviso público (Português)](https://automagik.dev/seguranca)
- 🛡️ [GitHub Security Advisories](https://github.com/automagik-dev/genie/security/advisories) for this repository

A full public post-mortem will be published within 30 days of containment.

---

## Acknowledgments

We thank the researchers and organizations that identified and tracked this incident:

- [**Socket Research Team**](https://socket.dev/blog/namastex-npm-packages-compromised-canisterworm) — primary discovery and continued tracking at [socket.dev/supply-chain-attacks/canistersprawl](https://socket.dev/supply-chain-attacks/canistersprawl).
- **Endor Labs**, **Kodem Security**, **BleepingComputer**, **The Register**, **CSO Online**, **GBHackers**, **Cybersecurity News** — for coverage, analysis, and technical breakdowns that helped defenders respond quickly.

We also thank the Automagik team that ran the end-to-end response during the incident window, and the broader open-source community whose scrutiny, tools, and unfiltered feedback keep this ecosystem healthy. We will keep earning it.

---

## Our Commitments

Current 5.x GitHub Releases are governed by:

- **Per-platform verification material** — every tarball has a cosign keyless bundle, SLSA provenance, and a GitHub-native attestation bound to the release source and trusted workflow control.
- **OIDC signing** — release signing uses GitHub Actions OIDC; there is no long-lived signing key.
- **Environment protection** — stable publication requires the protected production environment approval described below.
- **Immutable publication** — published asset bytes are never replaced; repository-hosted channel manifests advance only after exact remote verification.

---

## Host remediation

The current Genie CLI does not ship a `genie sec` command. Do not treat older roadmap text, copied commands, or a successful Genie install as host-compromise clearance. Verify release artifacts with the repository script below; for incident investigation or remediation, preserve evidence and follow the current public advisory or contact the security address above. There is no supported flag that bypasses failed release verification.

---

## Release Signing — Pinned Identity (cosign keyless)

`@automagik/genie` releases are signed with **cosign keyless** via GitHub Actions OIDC. There is no long-lived public key to pin — no private key in repo secrets, no hardware-backed offline key, no two-officer key-custody ceremony. What operators pin instead is the **certificate identity + OIDC issuer + provenance source-uri** tuple that `cosign verify-blob` and `slsa-verifier` must accept. If all three values match across all three pinning channels, the release was signed by the repo's own Actions workflow and by nothing else.

Release-channel authority comes from the repository-hosted `.well-known/latest.json`, `homolog.json`, and `dev.json` manifests. GitHub's `/releases/latest` route and prerelease label are non-authoritative. Promotion advances only the eligible monotonic manifest after exact remote asset verification; it never replaces published bytes or edits published draft/prerelease/latest state. A fixed migration caveat may be appended to human-authored release notes. This separation permits repository-level immutable releases while retaining one verified version across dev, homolog, and stable channels.

Immutable-release cutover order is security-critical. Seal the candidate and drain every Version and Release run started under the old `main` workflows before enabling repository immutability; enable it before the separately approved merge to `main`. Immutability protects only releases created after enablement, so any release published by the mutable predecessor must fail closed and must not advance a channel manifest. The first version eligible for stable promotion after cutover must be freshly built and published by the merged draft-first release control.

<!-- BEGIN SIGNING_IDENTITY_PIN -->

```
certificate-identity-regexp: ^https://github\.com/automagik-dev/genie/\.github/workflows/sign-attest\.yml@refs/heads/main$
certificate-oidc-issuer:     https://token.actions.githubusercontent.com
provenance source-uri:       github.com/automagik-dev/genie
```

<!-- END SIGNING_IDENTITY_PIN -->

**These three lines are byte-identical across three independent channels.** If any channel drifts, treat all three as compromised and escalate per the runbook.

| Channel | Path / URL | Purpose |
|---------|------------|---------|
| In-repo canonical | [`SECURITY.md`](./SECURITY.md) (this file) | Ships with every release tarball; read-only after tag |
| Project site | [`/.well-known/security.txt`](./.well-known/security.txt) | RFC 9116 discovery path served at the project site |
| Out-of-band | [Pinned issue: `SIGNING_CERT_IDENTITY_*`](https://github.com/automagik-dev/genie/issues?q=is%3Aissue+label%3Apinned+label%3Asigning-identity) | Independent mirror for cross-checking identity changes |

A fourth in-repo witness — [`.github/cosign.pub`](./.github/cosign.pub) — carries the same values inside a NO-PINNED-KEY sentinel so tooling that naively reads a PEM file fails closed rather than trusting a fabricated key. The shipped verifier and installer are the fifth and sixth required in-repo witnesses. The CI gate (`scripts/check-fingerprint-pinning.sh`) asserts all six required in-repo witnesses agree on every PR that touches any of them.

### Verify a release locally

The canonical verification entry point is `scripts/verify-release.sh`, which wraps `cosign verify-blob` + `slsa-verifier` using the pinned identity above.

```bash
# End-to-end: downloads release assets from GitHub, verifies cosign signature
# + SLSA provenance against the pinned identity.
scripts/verify-release.sh v5.260715.1

# If you already downloaded one tarball and its adjacent .bundle and
# .intoto.jsonl sidecars:
scripts/verify-release.sh --local /path/to/genie-5.260715.1-darwin-arm64.tar.gz
```

If you cannot run the wrapper — for example, a locked-down incident-response host — the underlying cosign invocation is the ground truth:

```bash
# Cosign keyless signature verification (sole verification path).
# Paste the three pinned lines above into your check; never accept a
# value from any other source.
cosign verify-blob \
  --certificate-identity-regexp "^https://github\.com/automagik-dev/genie/\.github/workflows/sign-attest\.yml@refs/heads/main$" \
  --certificate-oidc-issuer     "https://token.actions.githubusercontent.com" \
  --bundle genie-5.260715.1-darwin-arm64.tar.gz.bundle \
  genie-5.260715.1-darwin-arm64.tar.gz

# SLSA provenance verification.
slsa-verifier verify-artifact genie-5.260715.1-darwin-arm64.tar.gz \
  --provenance-path genie-5.260715.1-darwin-arm64.tar.gz.intoto.jsonl \
  --source-uri github.com/automagik-dev/genie
```

Exit codes:

- `0` — verified: signature + provenance both pass against the pinned identity
- `2` — cosign signature verification failed
- `4` — SLSA provenance verification failed
- `5` — `.bundle` or `.intoto.jsonl` verification material is missing
- `64` — invalid arguments
- `127` — a required verifier is unavailable

### Cross-check the three channels match

Before trusting a release during incident response, confirm the pin has not drifted:

```bash
# Run from a clone of automagik-dev/genie on a trusted host.
scripts/check-fingerprint-pinning.sh
```

The script greps each of the six required in-repo witnesses (`SECURITY.md`, `.well-known/security.txt`, `.github/ISSUE_TEMPLATE/signing-key-fingerprint.md`, `.github/cosign.pub`, `scripts/verify-release.sh`, and `install.sh`) for the three canonical lines above and exits non-zero if any witness is missing a line or carries a divergent value. The same script runs as a GitHub Actions gate (`.github/workflows/signing-identity-pin.yml`) on every PR that touches any of the pinning channels.

One-liner for operators without the repo cloned (checks the in-repo canonical + the project-site copy):

```bash
diff <(curl -fsSL https://raw.githubusercontent.com/automagik-dev/genie/main/SECURITY.md \
        | awk '/BEGIN SIGNING_IDENTITY_PIN/,/END SIGNING_IDENTITY_PIN/' \
        | grep -E 'certificate-identity-regexp|certificate-oidc-issuer|provenance source-uri') \
     <(curl -fsSL https://automagik.dev/.well-known/security.txt \
        | awk '/BEGIN SIGNING_IDENTITY_PIN/,/END SIGNING_IDENTITY_PIN/' \
        | grep -E 'certificate-identity-regexp|certificate-oidc-issuer|provenance source-uri')
# Empty output = channels agree. Any output = escalate.
```

### If the pin has drifted

1. **Do not install or execute the suspect release** — you cannot distinguish a legitimate rotation from a compromise until the out-of-band channel is reconciled.
2. Check the pinned `SIGNING_CERT_IDENTITY_<YYYYMMDD>` GitHub issue for an independently published replacement identity.
3. Email `privacidade@namastex.ai` with the diverging channel, the observed value, and the expected value. Response SLA is two business hours (see [Reporting a Vulnerability](#reporting-a-vulnerability)).
4. Preserve the suspect artifacts and affected-host evidence while triage is in flight. There is no supported verification bypass.

---

## Hardening Recommendations for Consumers

- Install only through the repository installer and authoritative stable manifest; npm distribution is retired.
- Verify a downloaded tarball with `scripts/verify-release.sh` before manual execution.
- Preserve the adjacent `.bundle` and `.intoto.jsonl` sidecars with any archived tarball.
- Monitor advisories: subscribe to GitHub security alerts for this repository.

---

## Contact

- **Security & incidents:** `privacidade@namastex.ai`
- **Data Protection Officer (DPO):** Cezar Vasconcelos — `dpo@namastex.ai`
- **Security disclosure page:** [automagik.dev/security](https://automagik.dev/security)

Namastex Labs Serviços em Tecnologia Ltda · CNPJ 46.156.854/0001-62

*Last updated: 2026-04-23 · v1.0*
