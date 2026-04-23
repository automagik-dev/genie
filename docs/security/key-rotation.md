# Signing-Identity Rotation Runbook

<!--
  Owned by the `genie-supply-chain-signing` wish. SECURITY.md references this
  doc from the top-level; the incident runbook (`sec-incident-runbook`) wraps
  it with operational prose. Keep examples executable — the dry-run recipe at
  the end is exercised by CI.

  Release signing for `@automagik/genie` is cosign KEYLESS ONLY. There is no
  long-lived private key, no hardware-backed offline key, no public-key
  fingerprint to pin. "Rotation" in this doc means rotating the
  certificate-identity pin (workflow-path@ref, OIDC issuer, and provenance
  source-uri) that operators cross-check in three independent channels.
-->

## When to rotate

Rotate the pinned certificate identity when — and ONLY when — one of these
happens. Routine releases do NOT require rotation.

1. **Workflow path moves.** `.github/workflows/release.yml` is renamed or
   split. The Fulcio certificate SAN embeds the workflow path, so a move
   changes the certificate identity verifiers must accept.
2. **Repository is renamed.** `automagik-dev/genie` becomes something else.
   Both the signer identity regexp and the SLSA provenance `source-uri` must
   move atomically.
3. **OIDC issuer changes.** GitHub Actions' OIDC token issuer URL changes
   (rare; announced upstream). The pinned
   `certificate-oidc-issuer` must change with it.
4. **Keyless trust-root incident.** Sigstore / Fulcio announces a trust-root
   rotation that requires consumers to re-verify against a new root. Operators
   follow the cosign upstream rotation advisory in addition to this runbook.

There is no routine calendar rotation. Rotation is driven by events, not time.

## Rotation contract (summary)

| Constraint        | Detail                                                                                          |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| Minimum approvers | Two Namastex security officers (independent GitHub accounts)                                    |
| Pinning channels  | `SECURITY.md`, `/.well-known/security.txt`, pinned GitHub issue                                 |
| Grace period      | Minimum 72 hours in which the OLD and NEW identities both verify                                |
| Retirement test   | `genie sec verify-install` against a post-rotation release MUST exit 0                          |
| Audit trail       | Rotation PR signed by both officers; the pinned issue records the `Filed by (GPG fingerprint)`. |

If any of the five constraints above cannot be met, the rotation does not
ship. Do NOT reduce the grace period to "fix" a broken window.

## Step-by-step rotation procedure

### Phase 1 — Pre-rotation (before touching anything)

1. Open a tracking issue in `automagik-dev/genie` titled
   `SIGNING_CERT_IDENTITY_<YYYYMMDD>` using the
   `.github/ISSUE_TEMPLATE/signing-key-fingerprint.md` template.
2. Draft the new values:
    - `certificate-identity-regexp`
    - `certificate-oidc-issuer`
    - provenance `source-uri`
3. Confirm the CURRENT values are byte-identical across all three pinning
   channels. If they already drift, stop and open an incident — rotation
   cannot overlay a broken baseline.

### Phase 2 — Two-officer ceremony

1. Two Namastex security officers (distinct GitHub identities, distinct
   hardware keys for commit signing) co-author the rotation PR. The PR MUST:
    - Update `.github/workflows/release.yml` (if workflow path changes).
    - Update `src/term-commands/sec.ts` `SIGNER_IDENTITY_REGEXP` /
      `SIGNER_OIDC_ISSUER` / `PROVENANCE_SOURCE_URI` constants.
    - Update `SECURITY.md` so its pinned values match the new identity
      byte-for-byte.
    - Update `/.well-known/security.txt` on the project site (or file the
      site-repo PR in parallel).
    - Update (or open) the tracking issue created in Phase 1 with the final
      values.
2. Both officers sign the PR via `git commit -S` with a GPG key that appears
   on their GitHub profile. CI checks for exactly two distinct co-authors
   with verified signatures; a single-officer PR must be refused.
3. After merge, a tagged release runs the real signing workflow against the
   new certificate identity. The post-release verify job
   (`.github/workflows/release.yml` `verify` job) MUST pass; if it fails, the
   rotation is aborted and rolled back.

### Phase 3 — Grace-period dual-verification

1. For at least 72 hours after the rotation lands, verification tooling MUST
   accept BOTH the old and new certificate identities. In practice that means
   keeping the old entry in `SECURITY.md` under a `## Previous pinning`
   heading so operators running the previous release do not fail
   `genie sec verify-install`.
2. The pinned issue is updated with the old value under its
   `## Previous pinning` section — never deleted.
3. Operators running `genie sec verify-install --offline` during the grace
   period should see `verified_at` timestamps newer than the rotation epoch.
   Any operator whose `verified_at` predates the rotation is instructed to
   pull the new release.

### Phase 4 — Retirement of the old identity

1. 72 hours after Phase 3 begins, and AFTER the post-rotation release has
   been verified end-to-end at least once by each of the three channels, the
   old identity is retired:
    - `SECURITY.md` drops the `## Previous pinning` section.
    - The tracking issue is marked RESOLVED (but never deleted).
    - Verification tooling stops accepting the old identity.
2. Retirement is a separate PR. It is NOT bundled with the rotation PR — a
   bundled retirement eliminates the grace window.

## Test-key dry-run recipe

The rotation procedure MUST be practiced at least once per quarter using
throwaway test identities. A successful dry-run ends with
`genie sec verify-install` returning exit 0 against a test-release bundle
signed by the rehearsed identity.

### Goal

Simulate Phases 1–4 end-to-end in under one hour, against a disposable
`automagik-dev/genie-signing-drill` repo (or a local fork pointing at a
fixture workflow), without touching the production signing identity.

### Steps

```bash
# 1. Stand up a disposable fixture directory under /tmp. No production repos.
export DRILL=$(mktemp -d -t genie-signing-drill-XXXXXX)
cd "${DRILL}"

# 2. Produce a fake signed release bundle using cosign against a throwaway
#    Fulcio identity. `cosign sign-blob --yes` will mint an ephemeral cert
#    from the drill operator's OIDC login (GitHub OAuth, short-lived).
echo "drill tarball" > drill.tgz
cosign sign-blob \
  --yes \
  --output-signature drill.tgz.sig \
  --output-certificate drill.tgz.cert \
  drill.tgz

# 3. Fabricate a minimal SLSA provenance file. Real provenance is generated
#    by slsa-github-generator; the dry-run uses a hand-rolled fixture to
#    exercise the local verify path, NOT to validate provenance contract.
cat > provenance.intoto.jsonl <<'EOF'
{"drill": true}
EOF

# 4. Exercise the verify-install command. Expected: exit 4 (provenance
#    invalid) because the drill provenance is intentionally invalid. Good —
#    that proves the failure mode works. The cosign step should succeed.
genie sec verify-install --bundle-dir "${DRILL}" --json || echo "exit=$?"

# 5. Flip one byte in the tarball and re-run. Expected: exit 2 (signature
#    invalid). Good — tamper detection works end-to-end.
printf '\x01' | dd of=drill.tgz bs=1 count=1 conv=notrunc
genie sec verify-install --bundle-dir "${DRILL}" --json || echo "exit=$?"

# 6. Clean up.
rm -rf "${DRILL}"
```

### Acceptance

A dry-run is successful when every expected exit code in the recipe above
appears. If any step deviates, file an issue tagged `signing-rotation-drill`
and do not ship the rotation PR until the deviation is understood.

## Anti-patterns

The following have bitten prior rotations and MUST NOT be repeated:

- **Rotating without updating all three channels.** The three-channel pin
  exists so an attacker must compromise three distribution points to
  invalidate. Dropping one channel defeats the invariant.
- **Single-officer rotation.** A rotation touched by one human account means
  a single compromise can move the pin. CI blocks single-officer PRs.
- **Grace-period shortcuts.** Reducing the 72-hour window to "speed up" a
  rotation makes operators on older releases fail `verify-install`. If a
  rotation is urgent enough to skip the grace window, it is an incident — file
  it as such, don't rotate.
- **Bundling retirement with rotation.** Retirement collapses the grace
  window. Always two PRs.
- **"Just amend" fixups.** Rotation history is load-bearing. Fix via a new PR
  that explicitly references the broken rotation; do not rewrite history.

## References

- `.github/cosign.pub` — the documented NO-KEY sentinel (keyless-only).
- `.github/workflows/release.yml` — the signing + verify pipeline.
- `.github/ISSUE_TEMPLATE/signing-key-fingerprint.md` — pinned-issue template.
- `src/sec/unsafe-verify.ts` — the `--unsafe-unverified` contract that
  operators fall back on if a rotation goes sideways.
- `scripts/verify-release.sh` — the local verification script that mirrors
  `genie sec verify-install`.
