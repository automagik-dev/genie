# Brainstorm: Aegis Distribution Sovereignty

| Field | Value |
|-------|-------|
| **Slug** | `aegis-distribution-sovereignty` |
| **Date** | 2026-04-27 |
| **Status** | DRAFTING |
| **Author** | Felipe + Genie (security planning) |
| **Parallel work** | `security-assessment-roadmap` (passive inventory + findings register, owned by Codex agent) |

## Origin

Felipe directive (2026-04-27):

> Start security review on this project. You're the first agent to create any sort of security assessment for genie. Focus in a new wish (another agent is covering other ground) specifically on how we can move away from npmjs entirely, owning the install and update process (and security scan, by leveraging genie sec we implemented) to make sure our users are always safe. We created https://github.com/automagik-dev/aegis which will evolve into a protection suite that will protect at network level (allowing users to allow telemetry calls for instance, keeping the network sandboxed and observable) to automatically updating definitions and scanning the workspace for malicious attacks, especially those related to supply chain — which is why we want to move away from npm environment as soon as possible, finding out a way to stay immune from this kind of attacks.

## Problem (rough)

Genie ships through `npmjs.com`, runs unsandboxed, and trusts every transitive dependency. The April 2026 CanisterWorm/TeamPCP incident weaponized the same `npm install -g @automagik/genie` pipe that operators use. Existing security wishes harden the **detection** and **response** posture (sec-scan, sec-remediate, supply-chain-signing, signature-registry), but they leave the structural exposure intact:

1. Operators still acquire genie from a registry that:
   - Has no enforcement of cosign signatures at install time
   - Allows arbitrary `postinstall` scripts in transitive deps
   - Resolves through the same DNS/CDN that has been compromised before
2. The running genie binary executes with **full host privileges** — every skill, plugin, MCP server, and shell tool can read $HOME, write anywhere, and reach any internet host.
3. Threat-intel definitions (signature packs) are tied to npm's publish cadence and only run when an operator manually invokes `genie sec scan`.

This wish (umbrella) defines the program for **distribution sovereignty** (genie ships and updates without depending on npmjs) and **runtime sovereignty** (Aegis keeps the host sandboxed, observable, and continuously scanned).

## Boundary with existing security wishes

| Wish | Owns | This wish does NOT |
|------|------|---------------------|
| `security-assessment-roadmap` | Inventory, findings register, drift checks (passive) | Re-do inventory work — consume their findings |
| `genie-supply-chain-signing` | Cosign + SLSA + verify-install + `--unsafe-unverified` ack | Re-do signing — leverage their primitives in distribution channels |
| `sec-signature-registry` | YAML signature packs, `@automagik/genie-signatures` repo, version-gated matching | Re-do signature schema — Aegis consumes packs in daemon mode |
| `sec-scan-progress` / `sec-remediate` / `sec-fix-one-shot` | One-shot scan + remediate UX | Re-do one-shot UX — Aegis runs scanner continuously instead |
| `canisterworm-incident-response` (umbrella) | Incident response playbook | Replace it — this wish is **prevention**, that one is **response** |

This umbrella's value-add is the structural exit from npm + the Aegis runtime sandbox. Everything else is glue.

## Sub-projects (preliminary decomposition)

This is **umbrella-sized**. Felipe asked for "a new wish" but the work spans 4 independent subsystems with different blast radii, different reviewers, and different shipping cadences. Mirrors the `canisterworm-incident-response` split pattern.

### A. Distribution exodus
- Stop publishing primary releases to `npmjs.com`. Ship via:
  - Own CDN (`cdn.automagik.dev/genie/<channel>/<version>/...`) with cosign-signed tarballs + SLSA provenance
  - GitHub Releases with the same artifacts (mirror)
  - Static binary distribution (compiled with `bun build --compile`) for x86_64/arm64 on macOS/Linux/Windows
  - `npx` parity through a thin shim that downloads-and-verifies, never via npm registry
- Bootstrap installers per platform: `curl -fsSL get.automagik.dev/genie | sh` (cosign-verified before exec), Homebrew tap, Scoop bucket, AUR, deb/rpm
- npm package becomes a **deprecated mirror** that just downloads + verifies the canonical artifact (transition strategy)

### B. Self-update channel
- Built-in `genie self-update` that fetches signed bundle from genie's release server, verifies cosign + SLSA, replaces the running binary atomically
- Channel-aware: `stable`, `beta`, `canary` with separate signing identities
- Differential updates (zstd-bsdiff) to keep update payloads small
- Update rollback (`genie self-update --rollback` reverts to previous version pinned in `~/.genie/state/binary-history.json`)

### C. Aegis runtime sandbox (network)
- New repo: `automagik-dev/aegis` (already created by Felipe, evolves into protection suite)
- Network firewall integration:
  - Default-deny egress for genie subprocesses
  - Operator-defined allowlist (`~/.genie/aegis/network-policy.yaml`) — telemetry endpoints, model APIs, package mirrors, etc.
  - Per-skill / per-plugin / per-MCP-server scope-bound network policy
  - Implementation tactic options: (1) eBPF/cgroup egress filter on Linux, (2) PF anchor on macOS, (3) Tauri native helper on Windows, (4) lightweight userspace SOCKS proxy as a portable fallback
- Network observability: every outbound connection logged (host, port, process, parent skill/plugin) into `~/.genie/aegis/netflow.jsonl`
- Audit log integrity: append-only, `0600`, fsync per event (matches existing sec-scan audit log contract)

### D. Aegis continuous scanner + auto-IOC updates
- Daemon mode for `sec-scan` — `genie aegis watch` launches a long-lived process that re-scans the workspace + global install + `$HOME/.npm` + browser profiles on a configurable cadence
- Pulls signature packs from `@automagik/genie-signatures` (existing `sec-signature-registry` wish) on a poll interval (default hourly), cosign-verified
- File-system-watcher mode (Linux fanotify / macOS FSEvents / Windows ReadDirectoryChangesW) so newly written files are scanned in real time, not just on cadence
- Critical-finding pipeline: on critical IOC hit, pause the genie agent process, emit a desktop notification, write a typed-ack quarantine prompt
- Integrates with existing `sec-fix` UX — daemon detection feeds the same plan-and-apply machinery

## Open questions

| # | Question | Status |
|---|----------|--------|
| 1 | Wish shape — umbrella vs single wish? | ✅ Resolved: umbrella |
| 2 | Aegis runtime architecture — sidecar / embedded / native? | ✅ Resolved: sidecar daemon (Rust) |
| 3 | Package architecture — monolith / suite / suite+agent-guard MVP? | ✅ Resolved: suite (P2) |
| 4 | Two-org separation + OSS/enterprise cut | ✅ Resolved by Felipe's two-org clarification (table in Org/Package map) |
| 5 | Sibling wish sequencing | ✅ Resolved: W2 distribution-first |
| 6 | npm transition strategy | ✅ Resolved: soft-deprecate as postinstall-shim |
| 7 | Network sandbox v1 implementation tactic — userspace proxy vs. kernel-level | 🟡 Proposed: userspace proxy v1, kernel-level v2 (deferred to sub-project C wish) |
| 8 | Build-time deps — vendor/mirror our own build inputs, or out of scope for v1? | 🟡 Proposed: OUT for v1 (build-time supply chain is its own future umbrella; this one is runtime/distribution) |
| 9 | Default network policy out-of-box allowlist — which endpoints? | 🟡 Proposed: api.anthropic.com, api.openai.com, github.com, registry.npmjs.org (until exit complete), cdn.automagik.dev. Defer detailed list to sub-project C wish. |

## Scope-Size Detection

✅ **TRIGGERED** — request touches 4 independent subsystems (distribution channel, self-updater, network sandbox, continuous scanner) that could ship in any order without blocking each other. Per the brainstorm playbook, decomposition required before deep refinement.

## Confirmed decisions

| # | Decision | Date |
|---|----------|------|
| 1 | **Wish shape: umbrella with 4 sibling wishes** (canisterworm pattern) | 2026-04-27 |
| 2 | **Aegis runtime architecture: sidecar daemon (Rust)**, option α from Q2 | 2026-04-27 |
| 3 | **Two-org separation**: `automagik-dev` for OSS lite tier, `@khal-os` for enterprise suite | 2026-04-27 |
| 4 | **Package architecture: Pattern P2** — three independent repos: `genie-signatures` (exists) + `aegis` (NEW, OSS) + enterprise suite deferred entirely to `@khal-os` future work (NOT in this umbrella) | 2026-04-27 |
| 5 | **Sequencing: Plan W2 (Distribution-first)** — Wave 1: A. Wave 2: B ‖ C. Wave 3: D. Total ~6 weeks. | 2026-04-27 |
| 6 | **Single point of initialization: `install.sh`** — `curl -fsSL get.automagik.dev/genie \| bash` mirrors Claude Code's bootstrap pattern (`https://claude.ai/install.sh` → `https://downloads.claude.ai/claude-code-releases/bootstrap.sh`). Thin shell script, fat binary, binary's own `install` subcommand owns shell integration + updates. | 2026-04-27 |
| 7 | **Verification stack** — SHA256 (manifest) + cosign (keyless OIDC, leveraging `genie-supply-chain-signing`) + SLSA Level 3 provenance. Cosign pubkey fingerprint inlined in `install.sh` as out-of-band trust anchor (third pinning channel — first two are SECURITY.md + .well-known/security.txt). | 2026-04-27 |
| 8 | **Platform matrix v1**: Linux x86_64 (glibc + musl), Linux arm64, macOS x86_64 + arm64 (with Rosetta detection). Native Windows deferred to v2 (mirror Claude Code's reject-Windows pattern; WSL works via Linux binary). | 2026-04-27 |
| 9 | **npm transition: soft-deprecate**, not hard-exit. `@automagik/genie` npm package becomes a thin postinstall shim that runs `install.sh` from our CDN with a deprecation banner. Eventually frozen at a final version that just delegates. Avoids bricking existing operators on `npm update -g`. | 2026-04-27 |

## Org / Package map

```
automagik-dev (OSS)
├── genie                      Agent runtime (this repo, distribution exodus + self-updater land here)
├── genie-signatures           YAML signature packs (existing, separate repo, free community intel)
└── aegis                      Rust daemon. Free protection: network sandbox + continuous scanner + observability.
                               "Lite mode" feeding the community safe. NEW repo.

@khal-os (enterprise, future, NOT in this umbrella)
└── (TBD — security product suite)   Full agent sandbox where genie runs inside.
                                     Prompt injection detection. PII / data leak detection.
                                     Mission control desktop/web app. Multi-host policy.
                                     Audit log forwarding. RBAC. Cloud control plane.
                                     Design TBD; this umbrella creates the engine they will build on.
```

## OSS / enterprise cut (proposed, awaiting confirmation)

| Capability | OSS (`automagik-dev/aegis`) | Enterprise (`@khal-os/...`) |
|------------|-----------------------------|------------------------------|
| Continuous workspace scanning | ✅ included | ✅ (with cloud-hosted aggregation) |
| Signature pack auto-updates | ✅ included | ✅ (with private signature feeds) |
| Network observability (passive netflow logs) | ✅ included | ✅ (with central forwarding) |
| Network policy enforcement (default-deny egress + allowlist) | ✅ included | ✅ (with policy distribution) |
| Per-process / per-skill scope-bound policy | ✅ included | ✅ |
| CLI mission control (`aegis status`, `aegis policy`, `aegis netflow tail`) | ✅ included | ✅ |
| **Content inspection: prompt injection detection** | ❌ enterprise only | ✅ |
| **Content inspection: PII / data leak detection** | ❌ enterprise only | ✅ |
| **Full agent sandbox (genie runs *inside* the sandbox)** | ❌ enterprise only | ✅ |
| **Mission control desktop / web app** | ❌ enterprise only | ✅ |
| **Multi-host policy distribution + RBAC + audit forwarding** | ❌ enterprise only | ✅ |

Lite mode lemma: aegis OSS delivers genuine protection (firewall + continuous scanning) without giving away the enterprise value. Adversaries who compromise an OSS install hit a network wall + a scanner — they don't see prompts, content, or sandbox boundaries.

## Success Criteria (umbrella-level)

The umbrella ships when:

- [ ] All 4 sibling wishes exist (`A: distribution-exodus`, `B: genie-self-update`, `C: aegis-runtime`, `D: aegis-scanner`) with WRS 100/100 each.
- [ ] Every IN bullet from this DESIGN.md maps to exactly one sibling wish — no gaps, no duplicates.
- [ ] `curl -fsSL get.automagik.dev/genie | bash` (or canonical equivalent) on a clean Linux x86_64, Linux arm64, macOS x86_64, macOS arm64 host: detects platform, downloads, verifies SHA256 + cosign + SLSA, installs binary to `~/.local/bin/genie`, sets up `~/.genie/`, `genie --version` works.
- [ ] `genie self-update` upgrades to latest stable, atomically replaces binary, restarts; `genie self-update --rollback` reverts.
- [ ] `aegis status` reports daemon running, network-policy loaded, scanner running.
- [ ] `aegis netflow tail` shows live outbound connection events from genie + subprocesses.
- [ ] `aegis policy show` prints the active network policy; `aegis policy add <host>` adds an allowed host with operator ack.
- [ ] Aegis scanner runs continuously, polls `@automagik/genie-signatures` hourly with cosign verification, ingests packs without daemon restart.
- [ ] On critical IOC hit, scanner pauses the active genie agent process, emits desktop notification, writes typed-ack quarantine prompt feeding into existing `genie sec fix` machinery.
- [ ] `@automagik/genie` npm package is converted to a deprecation shim (≤50 LOC postinstall) that downloads + verifies + runs install.sh and prints a deprecation banner.
- [ ] Every artifact (genie binary, aegis daemon, install.sh, manifest.json, signatures) is cosign-signed via the existing keyless-OIDC pipeline shipped by `genie-supply-chain-signing`.
- [ ] Cosign public-key fingerprint is byte-identical in: (1) `install.sh` inlined, (2) `SECURITY.md`, (3) `.well-known/security.txt`, (4) pinned GitHub issue per existing wish.
- [ ] `automagik-dev/aegis` repo exists with published v0.1.0 release; `@khal-os/...` enterprise suite is referenced but explicitly OUT of this umbrella.

## WRS

```
WRS: ██████████ 100/100
 Problem ✅ | Scope ✅ | Decisions ✅ | Risks ✅ | Criteria ✅
```

- ✅ **Problem** — structural npm exposure + unsandboxed runtime; existing wishes harden detection/response, this one closes the structural gap
- ✅ **Scope** — 4 siblings (A/B/C/D) + OSS/enterprise cut + two-org split + `agent-guard` deferred + npm soft-deprecate
- ✅ **Decisions** — 9 decisions locked (wish shape, Aegis stack, suite P2, two-org, W2 sequencing, install.sh-as-bootstrap, verification stack, platform matrix, npm transition)
- ✅ **Risks** — 13 risks ranked with mitigations; 3 H-severity items have explicit mitigations
- ✅ **Criteria** — 12 testable acceptance criteria for umbrella-level completeness

→ **Crystallize.**

## Claude Code install.sh study (reference pattern)

Felipe directive: "study your own install and inspire `curl -fsSL https://claude.ai/install.sh | bash`."

**URL chain:** `https://claude.ai/install.sh` → 302 → `https://downloads.claude.ai/claude-code-releases/bootstrap.sh`

**Architecture (Claude Code):**

| Layer | Behavior |
|-------|----------|
| Platform detection | `uname -s` (Darwin/Linux/reject Windows), `uname -m` (x86_64→x64, arm64/aarch64), `sysctl.proc_translated` (Rosetta), libc detection (musl vs glibc) |
| Download source | `https://downloads.claude.ai/claude-code-releases/<version>/<platform>/` + `manifest.json` (SHA256 checksums) |
| Verification | SHA256 via `shasum -a 256` (macOS) or `sha256sum` (Linux). **No cosign in the public Claude Code installer.** |
| Storage | `$HOME/.claude/downloads` for temporary binary |
| Bootstrap → binary handoff | Downloaded binary runs its own `install` subcommand — shell script is intentionally thin; binary owns PATH wiring, shell integration, updates |
| Update logic | NOT in shell script. Binary's `install` subcommand handles. `install.sh` always fetches "latest" manifest. |
| Env vars | `$HOME` for download dir. No other documented customization. |

**Genie's variant** (extending the pattern, not copying):

| Layer | Genie behavior | Delta from Claude Code |
|-------|----------------|------------------------|
| URL | `curl -fsSL get.automagik.dev/genie \| bash` (302 → `cdn.automagik.dev/genie/install.sh`) | Same shape |
| Platform detection | Linux x86_64 (glibc + musl), Linux arm64, macOS x86_64 + arm64 (Rosetta-aware) | Same matrix; Windows deferred to v2 |
| Download | `cdn.automagik.dev/genie/<channel>/<version>/<platform>/genie` + `manifest.json` | Same |
| Verification | SHA256 + **cosign keyless** + **SLSA L3 provenance** | Strictly more verification |
| Trust anchor | Cosign public-key fingerprint inlined in `install.sh` as third pinning channel (alongside SECURITY.md and .well-known/security.txt) | New |
| Storage | `$HOME/.genie/downloads` | Same shape |
| Binary `install` subcommand | Wires `~/.local/bin/genie` symlink, `$PATH`, shell integration (zsh/bash/fish completions), creates `~/.genie/`, optionally bootstraps `aegis` daemon | Adds aegis bootstrap + Genie's `~/.genie/` lifecycle |
| Self-update | `genie self-update` (sub-project B) — fetches manifest, verifies, atomically replaces running binary, exec's restart | Same semantic, more verification |
| Channels | `stable` / `beta` / `canary` with separate signing identities | Beyond Claude Code's "latest only" |
| Rollback | `genie self-update --rollback` reverts to previous version pinned in `~/.genie/state/binary-history.json` | New |

**Implementation tactic for cosign in install.sh:**
- Option (a): bundle a tiny static `cosign` binary (~5MB) at the same CDN, install.sh downloads it as a prerequisite. Feasible but adds a chicken-and-egg trust step.
- Option (b): embed a portable Rust verifier (`sigstore-rs`) compiled to a tiny static binary, distribute alongside install.sh.
- Option (c): operator can opt out of cosign verification via `INSECURE=1 curl ... | bash` (with loud warning) and rely on SHA256 only (matches Claude Code's current floor). Production operators get cosign by default.

Concrete tactic deferred to sub-project A wish; v1 likely lands as (c) with (b) as a fast-follow. The umbrella locks the *requirement* of cosign, not the *mechanism*.

## Risks (ranked, with mitigations)

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| 1 | `install.sh` URL itself is a trust anchor — TLS interception or DNS hijack defeats every downstream check | High | Pin cosign pubkey fingerprint **inside the script** so operators reading it can verify against three independent channels; document a non-pipe install path (`curl -fsSL > install.sh; less install.sh; bash install.sh`) for the paranoid |
| 2 | Self-updater is a new compromise vector | High | Updater code path = highest review bar; signed-only update channels; channel pinning; atomic replace with rollback; always-verify-before-exec; reuse existing `genie-supply-chain-signing` primitives |
| 3 | Build-time compromise (`bun install` for genie itself) defeats distribution sovereignty | High | Out of scope for THIS umbrella by decision; flag as follow-up umbrella `genie-build-sovereignty`; document as known gap in DESIGN.md |
| 4 | Aegis network firewall blocks legitimate traffic → worse UX disaster than the threat | High | Ship **observe-only** mode by default in v1; enforcement opt-in; sub-project C wish details staged rollout |
| 5 | Cosign / Fulcio / Rekor uptime — Sigstore is a SPOF | Medium | Offline-verify mode supported (signature-only, no transparency-log call); 24-hour cached rekor proofs in manifest; fallback to SHA256-only with audit-logged degraded state |
| 6 | CDN itself is a SPOF | Medium | Multi-CDN (Cloudflare + Fastly), DNS failover, GitHub Releases as a tertiary mirror with identical signed artifacts |
| 7 | Aegis daemon crash kills the user's shell or genie sessions | Medium | Daemon is opt-in for v1; fail-soft on crash (genie continues, logs daemon-down warning); supervisor (launchd/systemd-user) auto-restarts |
| 8 | npm soft-deprecate window leaves a residual attack surface for months | Medium | Set hard sunset date; `@automagik/genie` final npm version is a 50-line postinstall shim that ONLY downloads + verifies + runs install.sh; loud deprecation banner; signal CanisterWorm-class incident → emergency unpublish |
| 9 | Linux glibc-vs-musl + macOS Rosetta detection complexity | Medium | Mirror Claude Code's exact platform-detection logic; CI matrix tests every supported triple |
| 10 | Cross-platform daemon packaging (launchd/systemd/Windows-deferred) | Medium | Sub-project C wish details; v1 = launchd plist + systemd-user unit; Windows deferred to v2 with native Windows distribution |
| 11 | Cosign in install.sh chicken-and-egg (operator needs cosign to verify cosign download) | Low | Tactic (c) + (b) above; static portable verifier shipped alongside; SHA256 floor as compatibility fallback |
| 12 | Aegis daemon binary itself is a new published artifact = new attack surface | Low | Same signing infra as genie binary; cosign keyless via OIDC; SLSA L3 provenance; cosign verify in install.sh before daemon launch |
| 13 | Telemetry default policy is opinionated → operators disagree with allowlist | Low | Allowlist is operator-editable; Aegis ships with documented defaults but `~/.genie/aegis/network-policy.yaml` is the source of truth; first run shows the policy + asks for explicit ack |

## Next move

Ask Felipe one focused question about wish shape (umbrella vs. focused), then refine the highest-priority sub-project. Persist this draft after every exchange.
