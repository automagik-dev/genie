---
name: Signing Certificate Identity (pinned)
about: Out-of-band channel for the @automagik/genie release-signing certificate identity + OIDC issuer. Under cosign KEYLESS ONLY there is no public key fingerprint — operators cross-check the certificate-identity regexp and OIDC issuer against SECURITY.md and /.well-known/security.txt before trusting a release.
title: "SIGNING_CERT_IDENTITY_YYYYMMDD"
labels: ["security", "pinned", "signing-identity"]
assignees: []
---

<!--
  Instructions for the Namastex security officer filing this issue:

  1. File whenever the cosign keyless contract changes: workflow file path
     moves, repository is renamed, OIDC issuer changes, or source URI is
     re-anchored. Routine releases do NOT require a new issue.
  2. Title MUST match: SIGNING_CERT_IDENTITY_<YYYYMMDD>  (UTC date of the change).
  3. Fill in every field below. Do NOT remove sections.
  4. After publishing, pin the issue in the repo (Issues > this issue > ... > Pin).
  5. The values MUST be byte-identical to:
       - SECURITY.md (root of this repo)
       - /.well-known/security.txt (project site)
     If any of the three drift, operators treat ALL three as compromised.
  6. Never delete or edit a historical issue — open a new one per change and
     reference the previous issue in the "Previous pinning" field.

  Note: release signing is cosign KEYLESS ONLY. There is NO long-lived
  fallback key, NO hardware-backed offline key, NO public-key fingerprint
  to pin. The pinning anchors are the certificate identity + OIDC issuer
  below.
-->

## Current Certificate-Identity Pin

```
certificate-identity-regexp: ^https://github.com/automagik-dev/genie/.github/workflows/release.yml@
certificate-oidc-issuer:     https://token.actions.githubusercontent.com
provenance source-uri:       github.com/automagik-dev/genie
```

## Contract Metadata

- **Signing mechanism:** cosign keyless (Sigstore + Fulcio) — NO long-lived key
- **Workflow file:** `.github/workflows/release.yml`
- **Change effective (UTC):** `YYYY-MM-DD`
- **Filed by (GPG fingerprint):** `TBD`
- **Reason for change:** `workflow-move | repo-rename | issuer-change | initial-pin`

## Three-Channel Cross-Check

Operators MUST verify the values above match all three channels:

- [ ] `SECURITY.md` at repo root
- [ ] `/.well-known/security.txt` on the project site
- [ ] This pinned issue

If any channel diverges, treat the release as unsigned and follow the
`--unsafe-unverified <INCIDENT_ID>` contract documented in
`src/sec/unsafe-verify.ts`.

## Previous Pinning

- Previous issue: `#<issue-number>` (or `N/A` for initial pin)
- Prior contract retired (UTC): `YYYY-MM-DD`

## Verification Quickstart

```bash
# Cosign keyless verification (sole verification path)
cosign verify-blob \
  --certificate-identity-regexp "^https://github.com/automagik-dev/genie/.github/workflows/release.yml@" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  --signature <artifact>.sig \
  --certificate <artifact>.cert \
  <artifact>

# SLSA provenance verification
slsa-verifier verify-artifact <artifact> \
  --provenance-path provenance.intoto.jsonl \
  --source-uri github.com/automagik-dev/genie

# End-to-end
genie sec verify-install
```

## Reporting a Suspected Compromise

If the certificate-identity or OIDC issuer appears altered, or a release
verifies under an identity that does NOT appear here, email
`security@namastex.com` immediately. Do NOT run `genie sec remediate --apply`
against any host until a new pinning issue is filed and the three channels
re-converge.
