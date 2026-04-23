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

## Past Incidents

### 2026-04 — CanisterWorm supply-chain compromise

Between 2026-04-21 (~22:14 UTC) and 2026-04-22 (~14:00 UTC), versions `4.260421.33` through `4.260421.40` were published to npm by a threat actor after a developer GitHub OAuth token was exfiltrated. The malicious versions contained a credential harvester that executed via `postinstall`.

- **Exposure window:** ~16 hours
- **Detection-to-containment:** under 20 hours
- **Estimated base affected:** ≤ 0.5% of monthly download volume
- **Current status:** malicious versions `npm unpublish`-ed and no longer installable

**If you installed any version in that range between April 21–22, 2026, assume your machine is compromised.** Follow the remediation guide linked below.

**Resources:**
- 📖 [Full incident response manual](https://github.com/automagik-dev/genie/blob/main/docs/incident-response/canisterworm.md)
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
