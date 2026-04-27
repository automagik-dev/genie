# Design: MicroPR 1 — Install-Time Download Guard

| Field | Value |
|-------|-------|
| **Slug** | `security-roadmap-microprs` |
| **Date** | 2026-04-27 |
| **WRS** | 100/100 |
| **Board** | `Genie Security` (`board-321b2548`) |
| **Primary Task** | `#55` MicroPR 1: Verify install-time downloads |

## Problem

Genie currently downloads or executes install-time network content without a local integrity gate, so install and setup paths are a high-leverage supply-chain risk.

## Scope

### IN

- Add local integrity verification for tmux binary downloads used by `scripts/postinstall-tmux.js` and the equivalent runtime helper in `src/lib/ensure-tmux.ts`.
- Require an explicit SHA256 for non-default `GENIE_TMUX_URL` usage, or an explicit unsafe override that is visible in logs.
- Make remote Bun install-script execution in `scripts/smart-install.js` explicit opt-in rather than automatic execution.
- Add tests or validation fixtures that prove tampered downloads are rejected before extraction/copy.
- Document the install-time download trust boundary in the security assessment draft or a small security note.

### OUT

- Full release-signing or SLSA implementation; existing `genie-supply-chain-signing` work owns release provenance.
- Brain package update verification; that is tracked separately as MicroPR 5 (`#59`).
- Replacing the installer UX or package manager.
- Network-backed CVE scanning.

## Approach

Use the smallest guardrail that materially improves install safety: verify bytes before extraction and refuse custom binary sources unless they provide an expected digest. Keep the default tmux asset path working, but make its expected hashes explicit in code or a small manifest. For Bun bootstrapping, stop executing remote install scripts silently; print manual instructions unless an explicit opt-in environment variable is present.

Alternatives considered:

- **Do nothing until full signing lands:** too slow; install-time execution is an immediate high-impact surface.
- **Remove all auto-download behavior:** safest but likely too disruptive for Genie onboarding.
- **Add checksum-only guard now:** pragmatic first microPR; later signing/provenance can replace or strengthen it.

## Decisions

| Decision | Rationale |
|----------|-----------|
| Start with tmux/Bun installer paths | These run during setup/install and have clear file boundaries. |
| Require SHA256 before extraction/copy | Prevents using tampered archives even if fetch succeeds. |
| Treat custom `GENIE_TMUX_URL` as unsafe unless digest-pinned | Environment overrides are useful for testing but should not silently bypass integrity. |
| Keep unsafe override possible but loud | Incident/debug workflows may need it; logs and flag names should make risk explicit. |
| Keep this as one microPR | It can be reviewed and validated without touching broader agent/runtime security. |

## Risks & Assumptions

| Risk | Severity | Mitigation |
|------|----------|------------|
| Default tmux asset hashes drift when `TMUX_VERSION` changes | Medium | Put version and hash data in one manifest/object and fail tests if asset lacks a hash. |
| Checksum-only verification does not prove publisher identity | Medium | This microPR is a bridge; signing/provenance remains separate roadmap work. |
| Opt-in Bun install script breaks first-run convenience | Medium | Print exact manual command and document the opt-in flag. |
| Tests accidentally hit the network | Medium | Use local fixture bytes and injected fetch/dependency seams where possible. |
| Duplicate tmux download logic diverges between script and helper | High | Share a small verification helper or duplicate only a tiny hash-check function with matching tests. |

## Success Criteria

- [ ] Tampered tmux archive bytes are rejected before extraction in the postinstall path.
- [ ] Tampered tmux archive bytes are rejected before extraction in the runtime ensure-tmux path.
- [ ] Default tmux asset selection has an expected SHA256 for every supported platform asset.
- [ ] `GENIE_TMUX_URL` without a matching expected SHA256 refuses by default.
- [ ] Wrong SHA256 for `GENIE_TMUX_URL` refuses with a clear error.
- [ ] Explicit unsafe override for custom URL is logged with the exact env var name and never enabled by default.
- [ ] `scripts/smart-install.js` does not execute remote Bun install scripts unless explicit opt-in is set.
- [ ] Validation runs without network access.

## Suggested Wish

Create a focused wish for task `#55` only:

- Slug: `security-install-download-guard`
- Branch: `wish/security-install-download-guard`
- Files likely touched:
  - `scripts/postinstall-tmux.js`
  - `src/lib/ensure-tmux.ts`
  - `scripts/smart-install.js`
  - Tests near install/tmux helper coverage
  - A small security note or the assessment draft
