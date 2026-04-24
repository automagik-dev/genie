# Wish: Sec Signature Registry — Multi-Incident Pattern Database

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `sec-signature-registry` |
| **Date** | 2026-04-24 |
| **Author** | Felipe + Genie (product-vision distillation) |
| **Appetite** | large (~2–3 weeks) |
| **Branch** | `wish/sec-signature-registry` |
| **Repos touched** | `automagik-dev/genie`, `automagik-dev/genie-signatures` (new) |
| **Umbrella** | [canisterworm-incident-response/DESIGN.md](../../brainstorms/canisterworm-incident-response/DESIGN.md) |

## Summary

Today `genie sec scan` is hardcoded for **one** incident (CanisterWorm / TeamPCP, April 2026). `COMPROMISED_VERSIONS`, `IOC_STRINGS`, `TEXT_MATCHERS`, and remediation templates all live inline in `scripts/sec-scan.cjs`. Every future npm supply-chain incident would require a code change, a release, and an npm publish to get signatures in front of operators. That cadence is incompatible with the threat model — worms propagate in hours, signature updates need to arrive in minutes.

This wish ships the architectural rework that turns `genie sec` from a single-incident scanner into a **signature-driven npm-ecosystem AV/EDR**:

- **Signature packs** — one YAML per incident, machine-validatable schema, signed by Namastex via cosign keyless, shipped as a separate npm package `@automagik/genie-signatures`
- **Runtime loading** — `genie sec scan` loads all installed + community-added signature packs at startup; every finding is attributed to the exact signature that matched
- **Update pathway** — `genie sec signatures update` fetches the latest pack, verifies cosign signature against the pinned identity, swaps in without restarting the scanner's other machinery
- **Community contributions** — pattern for third-party signatures (with explicit loading + verification warnings), and a Namastex-reviewed upstream path for merging community findings into the canonical pack
- **Operator affordances** — `genie sec signatures list / add / remove / verify / import / search`
- **Per-signature remediation** — each pack ships its own `cleanup_commands`, `remediation_notes`, `scope_of_impact`, so `genie sec print-cleanup-commands` (owned by `sec-scan-progress` G5) knows exactly which commands apply to which finding

Net result: genie becomes the `npm audit` operators actually trust — signed signature delivery, version-gated matches, auditable attribution, community contributions. Signatures update as fast as Namastex can publish, not as fast as `@automagik/genie` can release.

## Preconditions

- ✅ `genie-supply-chain-signing` on dev (#1363) — cosign keyless + `verify-install` + `unsafe-unverify` contract are already landed; signature packs use the same signing infrastructure
- ✅ `sec-scan-temp-hang-hotfix` on dev (#1371) — scanner event loop is non-blocking, so dynamic signature loading doesn't introduce perceptual hang
- Recommended: `sec-scan-av-ui` merged — per-signature attribution in the renderer needs the UI wish's `phase.tick` + findings-counter infrastructure
- Design review + reviewer SHIP on the signature schema before implementation (this wish introduces a public data contract)

## Scope

### IN

**A. Signature pack schema**

New top-level directory in the scanner repo: `signatures/`. Each file:
```yaml
# signatures/canisterworm-2026-04.yaml
schema_version: 1
id: canisterworm-2026-04
name: CanisterWorm / TeamPCP npm worm
reported: 2026-04-21T00:00:00Z
sources:
  - https://blog.namastex.io/canisterworm-disclosure
  - https://github.com/automagik-dev/security-advisories/1
severity: critical
signed_by:
  cosign_identity: https://github.com/automagik-dev/genie-signatures/.github/workflows/publish.yml@refs/heads/main
  public_key_fingerprint: sha256:<pin>
description: |
  TeamPCP-style npm worm that compromised eight @automagik/genie publishes, three pgserve
  publishes, and assorted @fairwords packages between 2026-04-21 and 2026-04-22. Exfils
  credentials via telemetry.api-monitor.com and an ICP canister.
compromise_window:
  start: 2026-04-21T21:28:00Z
  end: 2026-04-22T03:34:42Z
packages:
  - name: '@automagik/genie'
    versions: ['4.260421.33', '4.260421.34', '4.260421.35', '4.260421.36', '4.260421.37', '4.260421.38', '4.260421.39', '4.260421.40']
    registry: npm
  - name: pgserve
    versions: ['1.1.11', '1.1.12', '1.1.13']
    registry: npm
  - name: '@fairwords/websocket'
    versions: ['1.0.38', '1.0.39']
    registry: npm
iocs:
  strings:
    - telemetry.api-monitor.com
    - telemetry.api-monitor.com/v1/telemetry
    - raw.icp0.io/drop
    - cjn37-uyaaa-aaaac-qgnva-cai
    - TEL_ENDPOINT
    - ICP_CANISTER_ID
  file_basenames:
    - env-compat.cjs
    - env-compat.js
    - public.pem
  sha256:
    - 87259b0d1d017ad8b8daa7c177c2d9f0940e457f8dd1ab3abab3681e433ca88e
  network_hosts:
    - telemetry.api-monitor.com
    - raw.icp0.io
detection:
  scopes: [install, live-process, shell-history, temp-artifact, lockfile, npm-cache-metadata, npm-log]
  require_version_match: true                 # only report install/live-process on version match
  self_skip: true                             # never match the scanner's own install
  shell_history_exclusions:                   # extends the global exclusions with signature-specific ones
    - pattern: '^npm uninstall.*@automagik/genie$'
      reason: remediation
      comment: Operator removing a compromised install is not compromise evidence.
remediation:
  description: |
    1. Isolate host from network (firewall egress to telemetry.api-monitor.com / raw.icp0.io).
    2. Remove compromised installs: `npm uninstall -g @automagik/genie` (and pnpm/bun equivalents).
    3. Rotate credentials present during compromise window: npm, GitHub, cloud, AI providers.
    4. Rebuild host or restore from pre-2026-04-21 snapshot if persistence detected.
  cleanup_commands:
    macos:
      - rm -rf ~/.bun/install/global/node_modules/@automagik/genie
      - npm uninstall -g @automagik/genie
      - bun cache rm
    linux:
      - rm -rf ~/.bun/install/global/node_modules/@automagik/genie
      - npm uninstall -g @automagik/genie
      - systemctl --user disable pgserve-compromise.service 2>/dev/null || true
  credential_rotation_order: [npm, github, aws, gcp, azure, anthropic, openai]
  scope_of_impact: |
    Credentials stored on the host during the compromise window. Browser profiles
    (Chrome, Brave, Edge, Chromium) and SSH configs should be assumed readable by
    the adversary.
```

Pack validation: JSON Schema file `.genie/schemas/signature-pack-v1.schema.json`, every field typed, unknown fields rejected.

**B. Loading + matching**

- On scanner startup: glob `signatures/*.yaml` + `~/.genie/sec-scan/signatures/*.yaml` + any path from `GENIE_SEC_SCAN_SIGNATURES` env.
- Parse each pack against the schema; reject + log on malformed packs.
- Merge the loaded IOC strings / basenames / hashes / packages into a single in-memory match table, tagged with the source signature id.
- Every match emits a finding attributed to the source signature id. Findings aggregate per signature in the report summary.
- Version-gated matching per-pack (honours `detection.require_version_match`).
- `detection.self_skip: true` packs pre-resolve the running binary's install root and exclude it.

**C. CLI subcommands**

- `genie sec signatures list [--json]` — loaded packs, id, name, version, source, status (ok / signature-failed / malformed)
- `genie sec signatures verify` — re-runs cosign verification against the pinned identity for every loaded pack; exits non-zero on failure
- `genie sec signatures add <path|url>` — copy pack into `~/.genie/sec-scan/signatures/`; warn + require typed ack for unverified packs
- `genie sec signatures remove <id>` — delete from `~/.genie/sec-scan/signatures/`
- `genie sec signatures update` — fetch latest `@automagik/genie-signatures` via npm, verify cosign, swap in
- `genie sec signatures search <term>` — grep loaded packs for package name / IOC / incident id
- `genie sec signatures import-from-advisory <gh-advisory-url>` — fetch a GitHub security advisory, generate a draft pack for operator review
- `genie sec scan --signatures <id>,<id>` — scope scan to named packs (default: all loaded)
- `genie sec scan --signatures-dir <path>` — override load paths for CI / testing

**D. `@automagik/genie-signatures` npm package** (new repo)

- Separate repo `automagik-dev/genie-signatures`
- Publish cadence: independent of `@automagik/genie` core; publish on every new incident
- Signed via cosign keyless (same OIDC identity as `@automagik/genie` signing wish)
- npm tarball contains `signatures/*.yaml` + signed manifest + per-pack SHA256
- `genie sec signatures update` workflow:
  1. `npm view @automagik/genie-signatures@latest` — get latest version + tarball URL
  2. `cosign verify-blob` against pinned identity
  3. Extract into `~/.genie/sec-scan/signatures/` with mode 0600
  4. Emit audit log entry `signatures.update { from_version, to_version, packs_added, packs_removed }`
- CI in the new repo runs the same schema validation + loads the pack against a hermetic fixture set to verify detection + no regression

**E. Per-finding attribution**

- Every finding object gains a `matched_signatures: [{ id, name, reported, severity }]` array
- Human report groups findings by signature: `CanisterWorm (2026-04): 3 hits · Shai-Hulud (2025): 0 hits`
- JSON envelope adds `summary.signatures[]` with counts per pack
- Snapshot tests lock the grouping format

**F. Default pack bundle**

- Scanner core ships with at least `signatures/canisterworm-2026-04.yaml` committed under `signatures/`
- `@automagik/genie-signatures` is installed as an npm `dependency` of `@automagik/genie`, so default posture is: latest signature pack is available at install time without any explicit `signatures update` call
- Bundled pack is updated via `renovate` / manual PR; emergency updates bump patch version of the signature package and operators get them via `genie sec signatures update`

**G. Community contribution pathway**

- Third-party pack: `genie sec signatures add https://example.com/my-incident.yaml` — requires typed ack `I_ACKNOWLEDGE_UNVERIFIED_SIGNATURE_PACK` because it's not cosign-verified against the Namastex identity
- Community contribution: fork `automagik-dev/genie-signatures`, open PR with new pack + fixtures + detection-parity tests; Namastex security team reviews + merges
- Documented review checklist in `automagik-dev/genie-signatures/CONTRIBUTING.md`

### OUT

- Daemon / worker pool / TUI dashboard (same exclusions as the original scanner wish)
- Real-time telemetry push to a central service (operators keep control of their scan output)
- Cross-ecosystem signatures (pip, cargo, maven, etc.) — this wish is npm-ecosystem only; extending to other ecosystems is a later wish
- Automated signature generation from npm advisories (`import-from-advisory` generates a DRAFT only, not an auto-published pack)
- Signatures for non-supply-chain threats (generic malware, ransomware) — out of scope

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Signatures live in a separate npm package (`@automagik/genie-signatures`), not inline in `@automagik/genie` | Independent publish cadence; minutes-to-ship on a new incident vs. days for a core release |
| 2 | YAML signature format with JSON Schema validation | Human-reviewable + community-friendly; schema enforces structure |
| 3 | Cosign keyless signing of signature packs + verified-only installation by default | Operators must trust signature delivery; attacker who forges a pack signs it with the wrong identity and the loader rejects |
| 4 | Version-gated matching mandatory in the schema (`require_version_match: true` by default) | Prevents the 2026-04-24 `pgserve@1.1.10`-clean-flagged-as-compromised FP from ever happening again |
| 5 | Self-skip enabled by default on the core pack | Scanner binary cannot flag itself |
| 6 | Per-finding attribution in both human report and JSON envelope | Operators know WHICH incident applies; remediation scoped to the right pack |
| 7 | `@automagik/genie-signatures` shipped as a runtime dependency of `@automagik/genie` | Fresh installs have signatures immediately; no silent-no-coverage window |
| 8 | Community packs require typed ack on install | Third-party signatures could contain false positives or deliberate sabotage; explicit consent required |
| 9 | Remediation commands per-signature, not global | CanisterWorm has different cleanup than a future wormlet; operators need correct commands per incident |
| 10 | `genie sec print-cleanup-commands` reads from matched-signature remediation blocks | Closes the loop: scanner finds → signature explains → operator cleans up |

## Success Criteria

- [ ] Signature pack schema file published at `.genie/schemas/signature-pack-v1.schema.json`; every field documented.
- [ ] `signatures/canisterworm-2026-04.yaml` exists at repo root and passes schema validation.
- [ ] `@automagik/genie-signatures` repo created, CI-verified, and first release published + signed.
- [ ] `@automagik/genie` depends on `@automagik/genie-signatures` in `package.json`.
- [ ] `genie sec signatures list` shows `canisterworm-2026-04` loaded, verified, source path printed.
- [ ] `genie sec signatures verify` exits 0 against pinned packs; exits non-zero on a tampered pack.
- [ ] `genie sec signatures add <url>` without `--trust-unverified` requires typed ack.
- [ ] `genie sec signatures update` fetches the latest `@automagik/genie-signatures` release, cosign-verifies, swaps in, logs update to audit log.
- [ ] `genie sec scan --signatures canisterworm-2026-04` produces the same results as today's hardcoded scan (detection parity).
- [ ] `genie sec scan` (no `--signatures` arg) loads ALL available packs and scopes matches per pack.
- [ ] JSON envelope carries `summary.signatures[]` with per-pack finding counts.
- [ ] Human report groups findings under per-signature headers.
- [ ] `genie sec print-cleanup-commands` reads per-finding `matched_signatures` to pick the right remediation block.
- [ ] Removing the bundled CanisterWorm pack and scanning a known-compromised fixture produces 0 findings for that package (confirming pack is the detection source, not the scanner).
- [ ] Adding a hand-crafted `shai-hulud-2025.yaml` pack with a fixture-only IOC (e.g. `SHAI_HULUD_TEST_MARKER`) produces hits in scan output without any scanner code changes.
- [ ] Every detection-parity test from the original CanisterWorm fixture still passes.
- [ ] Loading a malformed YAML pack produces a clear schema-validation error AND the scanner continues to run with the valid packs still loaded.

## Execution Strategy

Two-repo, multi-wave execution. The signature-package repo is created first so the scanner core can depend on it.

### Wave 1 (sequential, across repos)

| Group | Repo | Agent | Description |
|-------|------|-------|-------------|
| 1 | genie-signatures | engineer | New repo bootstrap: package skeleton, cosign signing workflow, first pack (canisterworm-2026-04), publish to npm |
| 2 | genie | engineer | Schema + loader + matcher: `.genie/schemas/signature-pack-v1.schema.json`, loader module, refactor scanner to consume loaded signatures |
| 3 | genie | engineer | CLI surface: `genie sec signatures list / verify / add / remove / update / search` subcommands |
| 4 | genie | engineer | Per-finding attribution: JSON envelope changes, human report grouping, snapshot tests |
| 5 | genie | engineer | `print-cleanup-commands` integration: pull remediation block from matched signature |
| 6 | genie | engineer | Default pack bundling: `@automagik/genie-signatures` as dependency, fresh-install smoke test, audit-log wiring for `signatures update` |

### Wave 2 (sequential, docs)

| Group | Repo | Agent | Description |
|-------|------|-------|-------------|
| 7 | genie-signatures | engineer | CONTRIBUTING.md + schema docs + community pack review checklist |
| 8 | genie | engineer | SECURITY.md + runbook updates: signature-update procedure, verify-install flow extended to signatures |

## Execution Groups

_(Detailed group-by-group deliverables + acceptance + validation blocks will follow the same structure as sibling wishes. Draft-stage wish — groups above are scope outlines; will be expanded after design review + reviewer SHIP on the schema.)_

## QA Criteria

- [ ] Fresh install of `@automagik/genie@<post-wish-version>` has `@automagik/genie-signatures` installed automatically; `genie sec scan` works with bundled CanisterWorm pack with no additional setup.
- [ ] `genie sec signatures update` end-to-end: fetches latest, cosign-verifies, swaps, audit-logs.
- [ ] Tampered pack (mutated bytes or wrong cosign identity) rejected with clear error; scanner continues running with previous packs.
- [ ] Community pack flow: add unverified pack → prompts typed ack → loads → matches → appears in signature list with `verified: false` flag.
- [ ] Detection-parity: every fixture finding today reproduces with the new packs-driven flow.
- [ ] Scanner with zero packs loaded produces clean report with banner "No signature packs loaded — scanner is a no-op. Run `genie sec signatures update`."
- [ ] Per-signature remediation reachable from scan output: `genie sec print-cleanup-commands --scan-report <path>` emits only the relevant pack's cleanup block.

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Signature pack delivery is itself a supply-chain target | Critical | Cosign keyless signing on every pack; default posture rejects unverified packs; pinned OIDC identity published in SECURITY.md; `signatures verify` as CI + on-demand check; operators can always re-pin the identity in `~/.genie/sec-scan/signatures-pinned.json` for air-gap |
| Schema v1 locks out future incidents that need new detection primitives | High | Schema version field; forward-compatible additive changes only in v1.x; a v2 wish when the v1 envelope genuinely blocks a detection class |
| Community contributions introduce false positives | High | Review checklist + Namastex security-team review as merge gate; per-pack detection-parity tests required before merge; fixtures must accompany every new signature |
| Operators pin to a stale signature pack and miss a new worm | High | Banner on every scan reminding of pack age (warning if oldest loaded pack > 90 days); `signatures list` shows "latest available via npm" column |
| `@automagik/genie-signatures` dependency graph introduces a new surface | Medium | The package is pure-data YAML + JSON; zero JS runtime code; reviewed by Namastex security for every release |
| Air-gapped environments can't run `signatures update` | Medium | `signatures update --from-tarball <path>` for offline update; runbook covers air-gap flow |
| Signature pack leaks an internal detail to attackers (what we look for) | Medium | Packs are public (like AV signatures); the threat model already assumes attackers see our detection. Mitigation is version diversity + multi-signature detection, not obscurity. |
| Pack registry version skew across operators | Medium | `genie sec signatures list` shows the pack versions each operator has; Namastex publishes a "recommended minimum pack set" in SECURITY.md for each release |
| Cosign infra down when operator tries to `signatures update` | Medium | Operators can fetch tarball manually + use `signatures add <tarball>` with explicit typed ack; runbook covers this |
| Per-finding attribution changes JSON envelope shape | Low | `reportVersion` bump to 2 (from 1); back-compat layer emits both shapes for 1 release |

## Review Results

_Populated by `/review` after execution completes._

## Files to Create/Modify

```
# In automagik-dev/genie (this repo)
.genie/schemas/signature-pack-v1.schema.json     # create
signatures/canisterworm-2026-04.yaml             # create (ports today's hardcoded CanisterWorm data into pack form)
scripts/sec-scan.cjs                             # modify: refactor to load + match from packs, remove hardcoded IOC / version tables
scripts/sec-scan.test.ts                         # modify: multi-signature fixture tests
src/sec/signature-loader.ts                      # create: pack parsing + schema validation + cosign verification
src/sec/signature-loader.test.ts                 # create
src/sec/signature-matcher.ts                     # create: unified matcher consuming loaded packs
src/sec/signature-matcher.test.ts                # create
src/term-commands/sec.ts                         # modify: add `signatures` subcommands
src/term-commands/sec.test.ts                    # modify
docs/sec-signatures/README.md                    # create: operator-facing docs for signatures subsystem
SECURITY.md                                      # modify: add signature-pack cosign identity pin + update procedure
package.json                                     # modify: add `@automagik/genie-signatures` as dependency

# In new repo automagik-dev/genie-signatures
README.md                                        # create
CONTRIBUTING.md                                  # create: community contribution checklist
.github/workflows/publish.yml                    # create: cosign keyless + SLSA L3 + npm publish
signatures/canisterworm-2026-04.yaml             # create: authoritative pack (duplicated from genie repo for independent publish)
schema/signature-pack-v1.schema.json             # create: copy of genie repo's schema
scripts/validate.ts                              # create: CI schema validator
package.json                                     # create: no dependencies, just data
```
