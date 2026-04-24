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
| `4.260422.x` and later | ✅ Supported — current |
| `4.260421.1` – `4.260421.32` | ⚠️ Legacy — security patches only |
| `4.260421.33` – `4.260421.40` | ❌ **COMPROMISED — do not use** |
| `4.260420.x` and earlier 4.x releases | ❌ End of life |
| `3.x` | ❌ End of life |
| `0.x` | ❌ End of life |

Always install from the current stable line. Pin explicit versions in your `package.json` and avoid `latest` for supply-chain sensitive packages.

---

## Self-Service Host Triage

If you installed a compromised version or need to assess a workstation, developer VM, CI runner, or WSL environment, start with:

```bash
genie sec scan --all-homes --root "$PWD"
```

Add one `--root` per repository or application directory you want scanned. Use `--json` for machine-readable output.

Interpretation:

- `LIKELY COMPROMISED` — execution, persistence, `.pth`, dropped payload, or live-process evidence exists.
- `LIKELY AFFECTED` — compromised versions were installed or fetched and the host should be treated as exposed.
- `OBSERVED ONLY` — logs, caches, or lockfiles reference the malicious versions, but stronger execution evidence was not found.
- `NO FINDINGS` — no incident-specific evidence was found in the scanned scope.

The scanner inventories:

- compromised versions in npm and bun caches plus installed package directories
- shell history, shell startup files, persistence locations, Python `.pth` injection paths, temp drops, and suspicious live processes
- `at-risk local material present on host` so operators can see which secret stores, browser profiles, wallets, and local app files were present and should be considered during rotation

If `genie` is not available, use the manual procedure in the incident response guide below.

---

## Past Incidents

### 2026-04 — CanisterWorm supply-chain compromise

Between 2026-04-21 (~22:14 UTC) and 2026-04-22 (~14:00 UTC), versions `4.260421.33` through `4.260421.40` were published to npm by a threat actor after a developer GitHub OAuth token was exfiltrated. The malicious versions contained a credential harvester that executed via `postinstall`.

- **Exposure window:** ~16 hours
- **Detection-to-containment:** under 20 hours
- **Estimated base affected:** ≤ 2% of weekly download volume
- **Current status:** malicious versions `npm unpublish`-ed and no longer installable

**If you installed any version in that range between April 21–22, 2026, run `genie sec scan --all-homes --root "$PWD"` immediately.** If the host shows `LIKELY COMPROMISED` or `LIKELY AFFECTED`, follow the remediation guide linked below.

**Resources:**

- 📖 [Incident response manual](./docs/incident-response/canisterworm.md)
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

Effective 2026-04-23, all `@automagik/genie` releases are governed by:

- **Provenance attestation** — every publication is signed with `npm --provenance` and verifiable via Sigstore.
- **OIDC trusted publishing** — migrating to GitHub Actions OIDC publish, eliminating long-lived npm tokens. (in progress)
- **Mandatory 2FA** on every maintainer account with publish rights.
- **Environment protection** — production publishes require manual approval from a second maintainer.
- **Quarterly token audit** — scope and permission review.
- **External pentest** — scheduled ahead of the original roadmap.

---

## Scanner and Remediation Invariants

The security-tooling surface shipped with `@automagik/genie` is governed by four architectural invariants. Any change that weakens an invariant requires a security-reviewed PR and a SECURITY.md entry documenting the regression.

- **The scanner is read-only by design.** `genie sec scan`, `genie sec print-cleanup-commands`, and `genie sec quarantine list` inspect the host and emit findings — they never mutate state on the scanned target. `GENIE_SEC_SCAN_DISABLED=1` is honored as a global opt-out; the scanner never bypasses it.
- **`genie sec remediate` is the only mutating verb.** Any future mutating subcommand MUST obey the same six-part contract: (1) dry-run default — `--apply` is opt-in; (2) frozen plan manifest — actions are materialized once and consented to once; (3) typed per-action consent — the operator acknowledges each mutation class verbatim, not a blanket yes/no; (4) quarantine-by-move — nothing is deleted without a recoverable copy under `$GENIE_SEC_QUARANTINE_DIR`; (5) signed-channel verification — `genie sec verify-install` must pass before `--apply` proceeds, or the invocation must use the `--unsafe-unverified <INCIDENT_ID>` escape hatch with a typed ack; (6) audit-log append-only — every action lands in `$GENIE_SEC_AUDIT_LOG` with a monotonic sequence number and cannot be rewritten in place.
- **Distribution-channel risk is declared, not hidden.** `@automagik/genie` appears on the scanner's own IOC list for the CanisterWorm compromise window (see [Supported Versions](#supported-versions)). Operators are advised to (a) pin to a post-incident release from the current stable line, (b) run `genie sec verify-install` after install to confirm the binary matches the signed release identity, and (c) treat any `--unsafe-unverified` invocation as an incident — it must be recorded in the audit log with a typed `I_ACKNOWLEDGE_UNSIGNED_GENIE_<INCIDENT_ID>` ack and a matching post-mortem. "The prompt is annoying" is explicitly not a legitimate context for `--unsafe-unverified` — see [`docs/incident-response/canisterworm.md`](./docs/incident-response/canisterworm.md) for the allow-list.
- **IOC-list freshness is tied to release cadence.** The scanner's IOC catalogue is baked into the shipped binary; there is no mutable online IOC feed to race against. Operators responding to a fresh advisory must upgrade to a release whose CHANGELOG references the new IOC set, then re-run `genie sec scan --all-homes --root /`. The incident runbook tells operators when to pin to a specific post-incident release.

These invariants apply to every release from `4.260422.x` forward. Legacy lines (`4.260421.x`) predate the invariants and are listed under Supported Versions with appropriate status.

---

## Release Signing — Pinned Identity (cosign keyless)

`@automagik/genie` releases are signed with **cosign keyless** via GitHub Actions OIDC. There is no long-lived public key to pin — no private key in repo secrets, no hardware-backed offline key, no two-officer key-custody ceremony. What operators pin instead is the **certificate identity + OIDC issuer + provenance source-uri** tuple that `cosign verify-blob` and `slsa-verifier` must accept. If all three values match across all three pinning channels, the release was signed by the repo's own Actions workflow and by nothing else.

<!-- BEGIN SIGNING_IDENTITY_PIN -->

```
certificate-identity-regexp: ^https://github.com/automagik-dev/genie/.github/workflows/release.yml@
certificate-oidc-issuer:     https://token.actions.githubusercontent.com
provenance source-uri:       github.com/automagik-dev/genie
```

<!-- END SIGNING_IDENTITY_PIN -->

**These three lines are byte-identical across three independent channels.** If any channel drifts, treat all three as compromised and escalate per the runbook.

| Channel | Path / URL | Purpose |
|---------|------------|---------|
| In-repo canonical | [`SECURITY.md`](./SECURITY.md) (this file) | Ships with every release tarball; read-only after tag |
| Project site | [`/.well-known/security.txt`](./.well-known/security.txt) | RFC 9116 discovery path served at the project site |
| Out-of-band | [Pinned issue: `SIGNING_CERT_IDENTITY_*`](https://github.com/automagik-dev/genie/issues?q=is%3Aissue+label%3Apinned+label%3Asigning-identity) | Independent mirror; rotated via two-officer PR per [`docs/security/key-rotation.md`](./docs/security/key-rotation.md) |

A fourth in-repo witness — [`.github/cosign.pub`](./.github/cosign.pub) — carries the same values inside a NO-PINNED-KEY sentinel so tooling that naively reads a PEM file fails closed rather than trusting a fabricated key. The CI gate (`scripts/check-fingerprint-pinning.sh`) asserts all four witnesses agree on every PR that touches any of them.

### Verify a release locally

The canonical verification entry point is `scripts/verify-release.sh`, which wraps `cosign verify-blob` + `slsa-verifier` using the pinned identity above. Exit codes mirror `genie sec verify-install` (Group 2 of `genie-supply-chain-signing`).

```bash
# End-to-end: downloads release assets from GitHub, verifies cosign signature
# + SLSA provenance against the pinned identity.
scripts/verify-release.sh v4.260422.4

# If you already downloaded the tarball + .sig + .cert + provenance.intoto.jsonl:
scripts/verify-release.sh --local /path/to/automagik-genie-4.260422.4.tgz
```

If you cannot run the wrapper — for example, a locked-down incident-response host — the underlying cosign invocation is the ground truth:

```bash
# Cosign keyless signature verification (sole verification path).
# Paste the three pinned lines above into your check; never accept a
# value from any other source.
cosign verify-blob \
  --certificate-identity-regexp "^https://github.com/automagik-dev/genie/.github/workflows/release.yml@" \
  --certificate-oidc-issuer     "https://token.actions.githubusercontent.com" \
  --signature  automagik-genie-4.260422.4.tgz.sig \
  --certificate automagik-genie-4.260422.4.tgz.cert \
  automagik-genie-4.260422.4.tgz

# SLSA provenance verification.
slsa-verifier verify-artifact automagik-genie-4.260422.4.tgz \
  --provenance-path provenance.intoto.jsonl \
  --source-uri github.com/automagik-dev/genie
```

On a host that already has `@automagik/genie` installed from a release channel, the shortest check is:

```bash
genie sec verify-install
```

Exit codes:

- `0` — verified: signature + provenance both pass against the pinned identity
- `2` — cosign signature verification failed
- `3` — signer identity does not match the pinned regex
- `4` — SLSA provenance verification failed
- `5` — signature material missing (no `.sig` / `.cert` / provenance found)

### Cross-check the three channels match

Before trusting a release during incident response, confirm the pin has not drifted:

```bash
# Run from a clone of automagik-dev/genie on a trusted host.
scripts/check-fingerprint-pinning.sh
```

The script greps each of the four in-repo witnesses (`SECURITY.md`, `.well-known/security.txt`, `.github/ISSUE_TEMPLATE/signing-key-fingerprint.md`, `.github/cosign.pub`) for the three canonical lines above and exits non-zero if any witness is missing a line or carries a divergent value. The same script runs as a GitHub Actions gate (`.github/workflows/signing-identity-pin.yml`) on every PR that touches any of the pinning channels.

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

1. **Do not run `genie sec remediate --apply`** on any host — you cannot distinguish a legitimate rotation from a compromise until the out-of-band channel is reconciled.
2. Check the pinned GitHub issue: a legitimate rotation lands a new `SIGNING_CERT_IDENTITY_<YYYYMMDD>` issue co-authored by two Namastex security officers (verified GPG signatures). The rotation procedure lives in [`docs/security/key-rotation.md`](./docs/security/key-rotation.md).
3. Email `privacidade@namastex.ai` with the diverging channel, the observed value, and the expected value. Response SLA is two business hours (see [Reporting a Vulnerability](#reporting-a-vulnerability)).
4. While triage is in flight, operators who must mutate a compromised host use the `--unsafe-unverified <INCIDENT_ID>` escape hatch documented in [`docs/incident-response/canisterworm.md`](./docs/incident-response/canisterworm.md). Every invocation lands in the audit log.

---

## Hardening Recommendations for Consumers

- Pin explicit versions, not `latest`: `"@automagik/genie": "4.260422.4"`.
- Use `npm ci` in CI. It enforces lockfile-based installs by default.
- Evaluate `--ignore-scripts` per-package for untrusted dependencies. Note: `@automagik/genie` relies on a `postinstall` step to download the bundled `tmux` binary; if you disable scripts, run `node scripts/postinstall-tmux.js` manually after install.
- Verify package provenance: `npm view @automagik/genie --json | jq '.dist.attestations'`.
- Monitor advisories: subscribe to GitHub security alerts for this repository.

---

## Contact

- **Security & incidents:** `privacidade@namastex.ai`
- **Data Protection Officer (DPO):** Cezar Vasconcelos — `dpo@namastex.ai`
- **Security disclosure page:** [automagik.dev/security](https://automagik.dev/security)

Namastex Labs Serviços em Tecnologia Ltda · CNPJ 46.156.854/0001-62

*Last updated: 2026-04-23 · v1.0*
