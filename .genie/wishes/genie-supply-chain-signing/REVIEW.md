# Review — genie-supply-chain-signing

Verdict: **SHIP**

Date: 2026-04-23
Reviewer: supply-chain-signing (branch self-review, pre-PR)
Scope: full branch (G1 + G2), three wip commits on top of `c54053e0`.

## Verification gates

| Gate | Command | Result |
|------|---------|--------|
| Unit tests — verify contract | `bun test src/sec/unsafe-verify.test.ts` | 35 pass / 0 fail (61 expect calls) |
| Unit tests — verify-install | `bun test src/term-commands/sec.test.ts` | 18 pass / 0 fail (38 expect calls) |
| Typecheck | `bun run typecheck` | clean |
| Lint | `bun run lint` (biome) | 670 files checked, no fixes needed |

## Deliverables (reconciled against WISH.md)

### G1 — Signing CI pipeline (commits `0b791d06` + `3950605e`)
- `.github/workflows/release.yml` — cosign KEYLESS signing + SLSA Level 3 provenance, signs before release publish, self-verify + tamper-detection self-test gate the release.
- `.github/cosign.pub` — explicit **no-pinned-key sentinel** (not a PEM). Documents the keyless contract inline and names `genie sec verify-install` as the tool that must fail-closed on the sentinel.
- `.github/ISSUE_TEMPLATE/signing-key-fingerprint.md` — operator-facing template redirecting pinned-key questions toward certificate-identity + OIDC-issuer verification (the real contract).
- `scripts/verify-release.sh` — offline-capable verification script used by operators and by the runbook; pins `cert-identity-regexp` + `cert-oidc-issuer` + provenance `source-uri` (never a key fingerprint).

### G2 — verify-install + --unsafe-unverified contract (commit `43e1bced`)
- `src/sec/unsafe-verify.ts` — single source of truth for the `--unsafe-unverified <INCIDENT_ID>` escape hatch: `INCIDENT_ID_REGEX`, `TYPED_ACK_PREFIX`, `LEGITIMATE_CONTEXTS`, and `validateUnsafeUnverified`. Council-mandated (M2→HIGH) to prevent divergent implementations eroding friction.
- `src/sec/unsafe-verify.test.ts` — 35 tests covering regex edge cases, acknowledgement format, and the documented legitimate contexts.
- `src/term-commands/sec.ts` — `genie sec verify-install` subcommand: cosign `verify-blob` + `slsa-verifier verify-artifact`, pinned identity regexp + OIDC issuer, `--offline`, `--json`, `--tarball`, `--bundle-dir`. Exit codes VERIFIED(0) / SIGNATURE_INVALID(2) / SIGNER_IDENTITY_MISMATCH(3) / PROVENANCE_INVALID(4) / NO_SIGNATURE_MATERIAL(5) / MISSING_BINARY(127) — treated as a public contract.
- `src/term-commands/sec.test.ts` — 18 tests, including the sentinel→exit-5 guarantee that prevents false positives on the no-key sentinel.
- `docs/security/key-rotation.md` — operator runbook for cosign keyless; documents that there is no "key" to rotate, only certificate-identity or OIDC-issuer changes, and how to run `genie sec verify-install` / `scripts/verify-release.sh`.

## Integration notes

- **sec-remediate (merged #1361) consumes a stub.** That PR lands the `--unsafe-unverified` flag on remediate/restore/rollback but with a placeholder validator. A follow-up integration PR will wire those subcommands to `validateUnsafeUnverified` from `src/sec/unsafe-verify.ts`. Deliberately out of scope here — keeps this PR reviewable.
- **Scripts untouched.** `scripts/sec-scan.cjs` and `scripts/sec-remediate.cjs` are not modified in this PR, per teammate direction.
- **Unblocks sec-incident-runbook** — the last wish in the canisterworm umbrella (#1360) depends on the verify-install subcommand + `--unsafe-unverified` contract landing.

## Severity findings

None. No FIX-FIRST or BLOCKED gaps.

## Ship checklist

- [x] All relevant tests pass on branch HEAD.
- [x] typecheck + lint clean.
- [x] WISH.md acceptance criteria covered (G1 pipeline + G2 contract).
- [x] No modifications to `scripts/sec-scan.cjs` / `scripts/sec-remediate.cjs`.
- [x] Follow-up integration work explicitly called out in PR body, not hidden.
