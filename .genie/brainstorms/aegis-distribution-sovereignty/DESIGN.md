# Design: Aegis Distribution Sovereignty (Umbrella)

| Field | Value |
|-------|-------|
| **Slug** | `aegis-distribution-sovereignty` |
| **Date** | 2026-04-27 |
| **Status** | CRYSTALLIZED (WRS 100/100) |
| **WRS** | 100/100 |
| **Author** | Felipe + Genie (security planning) |
| **Parallel work** | [`security-assessment-roadmap`](../../wishes/security-assessment-roadmap/WISH.md) — passive inventory + findings register, owned separately |
| **Pattern** | Umbrella with 4 sibling wishes, mirrors [`canisterworm-incident-response`](../canisterworm-incident-response/DESIGN.md) split |

## Problem

Genie ships through `npmjs.com`, runs unsandboxed, and trusts every transitive dependency. The April 2026 CanisterWorm/TeamPCP incident weaponized the same `npm install -g @automagik/genie` pipe operators use, and existing security wishes harden the **detection** (`sec-scan-progress`) and **response** (`sec-remediate`, `sec-fix-one-shot`) posture without closing the structural exposure:

1. Operators acquire genie from a registry that has no enforcement of cosign signatures at install time, allows arbitrary `postinstall` scripts in transitive deps, and resolves through a chain that has been compromised before.
2. The running genie binary executes with full host privileges — every skill, plugin, MCP server, and shell tool can read `$HOME`, write anywhere, reach any internet host.
3. Threat-intel definitions (signature packs) are tied to npm's publish cadence and only run when an operator manually invokes `genie sec scan`.

This umbrella defines the program for **distribution sovereignty** (genie ships and updates without depending on `npmjs.com`) and **runtime sovereignty** (Aegis daemon keeps the host sandboxed, observable, and continuously scanned), splitting them into 4 sibling wishes that ship independently in ~6 weeks of wall-time.

## Boundary with existing security work

This umbrella is **prevention/structural**. The canisterworm-incident-response umbrella is **response/operational**. They sit side by side; they do not replace each other.

| Existing wish | Owns | This umbrella does NOT |
|---------------|------|------------------------|
| `security-assessment-roadmap` (in flight, separate agent) | Inventory, findings register, drift checks (passive) | Re-do inventory work — consume their findings |
| `genie-supply-chain-signing` | Cosign keyless + SLSA L3 + verify-install + `--unsafe-unverified` ack contract | Re-do signing primitives — leverage them in distribution channels |
| `sec-signature-registry` | YAML signature pack schema + `@automagik/genie-signatures` npm package | Re-do signature schema — Aegis daemon consumes packs in continuous mode |
| `sec-scan-progress` / `sec-remediate` / `sec-fix-one-shot` | One-shot scan + remediate UX (operator-invoked) | Re-do one-shot UX — Aegis runs scanner *continuously* and feeds into the same `sec-fix` machinery |
| `canisterworm-incident-response` (umbrella) | Incident response playbook | Replace it — this umbrella is **prevention**, that one is **response** |

## Org / Package map

```
automagik-dev (OSS — this umbrella's deliverables land here)
├── genie                 Agent runtime. Sub-projects A + B land here (distribution + self-update).
├── genie-signatures      YAML signature packs (existing repo, separate publish cadence).
└── aegis                 NEW. Rust daemon. Lite-mode protection for the OSS community.
                          Sub-projects C + D land here (network sandbox + continuous scanner).

@khal-os (enterprise, future, NOT in this umbrella)
└── (TBD security suite)  Full agent sandbox where genie runs inside.
                          Prompt-injection detection. PII / data-leak detection.
                          Mission control desktop/web app. Multi-host policy.
                          RBAC, audit-log forwarding, cloud control plane.
                          This umbrella creates the engine the future suite will build on.
```

## OSS / enterprise cut

| Capability | OSS (`automagik-dev/aegis`) | Enterprise (`@khal-os/...`) |
|------------|-----------------------------|------------------------------|
| Continuous workspace scanning | ✅ | ✅ + cloud aggregation |
| Signature pack auto-updates | ✅ | ✅ + private feeds |
| Network observability (passive netflow) | ✅ | ✅ + central forwarding |
| Network policy enforcement (default-deny + allowlist) | ✅ | ✅ + policy distribution |
| Per-skill / per-plugin scope policy | ✅ | ✅ |
| CLI mission control (`aegis status`, `policy`, `netflow tail`, `approve`) | ✅ | ✅ |
| **Prompt-injection content inspection** | ❌ | ✅ |
| **PII / data-leak detection** | ❌ | ✅ |
| **Full agent sandbox (genie runs inside)** | ❌ | ✅ |
| **Mission control desktop / web app** | ❌ | ✅ |
| **Multi-host policy + RBAC + SIEM forwarding** | ❌ | ✅ |

Lite mode lemma: aegis OSS delivers genuine protection (network firewall + continuous scanning) without giving away the enterprise value. Adversaries who compromise an OSS install hit a network wall + a scanner — they don't see prompts, content, or sandbox boundaries.

## Scope

### IN (umbrella-wide; details in sibling wishes)

**Distribution (sub-project A)**
- Single-point bootstrap: `curl -fsSL get.automagik.dev/genie | bash`. Mirrors Claude Code's pattern (`https://claude.ai/install.sh` → `https://downloads.claude.ai/claude-code-releases/bootstrap.sh`).
- CDN: `cdn.automagik.dev/genie/<channel>/<version>/<platform>/genie` + `manifest.json`.
- Verification stack: SHA256 (manifest) + cosign keyless (leveraging `genie-supply-chain-signing`) + SLSA L3 provenance.
- Cosign public-key fingerprint inlined in `install.sh` as the third pinning channel (alongside `SECURITY.md` and `.well-known/security.txt`).
- Static binary build via `bun build --compile` per platform.
- Platform matrix v1: Linux x86_64 (glibc + musl), Linux arm64, macOS x86_64 + arm64 (Rosetta-aware). Windows native deferred to v2.
- Binary's own `install` subcommand wires `~/.local/bin/genie`, `$PATH`, shell completions (zsh/bash/fish), creates `~/.genie/`, optionally bootstraps Aegis daemon.
- Multi-CDN failover (Cloudflare + Fastly) with GitHub Releases as a tertiary mirror serving identical signed artifacts.
- npm package transition: `@automagik/genie` becomes a ≤50-LOC deprecation shim postinstall that runs `install.sh` from CDN with a loud deprecation banner; final-version freeze with hard sunset date.

**Self-update (sub-project B)**
- `genie self-update` fetches new manifest, downloads, verifies SHA256+cosign+SLSA, atomically replaces running binary, exec's restart.
- Channel-aware: `--channel stable|beta|canary` with separate cosign signing identities.
- Rollback: `genie self-update --rollback` reverts to previous version pinned in `~/.genie/state/binary-history.json`.
- Differential updates (zstd-bsdiff) — nice-to-have for v1, lock as v2 follow-up if scope tightens.
- Update audit log: every self-update attempt logged to `~/.genie/audit/self-update.jsonl` with `from_version`, `to_version`, `channel`, `verification_result`, `timestamp`.

**Aegis runtime (sub-project C)**
- New repo `automagik-dev/aegis`. Rust daemon binary `aegis-daemon` distributed via the same CDN with cosign + SLSA, on its own publish cadence.
- Daemon lifecycle: launchd plist (macOS) + systemd-user unit (Linux); `aegis start|stop|status|logs` CLI.
- Daemon is **opt-in** for v1 (genie works without it; Aegis is a strict-upgrade overlay).
- IPC: Unix socket at `~/.genie/aegis/aegis.sock` with operator-only mode 0600. Genie's hook layer detects the socket and routes outbound network calls through the daemon's userspace HTTPS proxy.
- Network sandbox: default policy is **observe-only** for v1 (logs everything, blocks nothing); enforcement opt-in via `aegis policy enforce`. Operator-editable policy file at `~/.genie/aegis/network-policy.yaml`.
- Default allowlist (when enforcement is enabled): `api.anthropic.com`, `api.openai.com`, `github.com`, `cdn.automagik.dev`, `registry.npmjs.org` (until npm exit complete). Detailed list owned by sub-project C wish.
- Per-skill / per-plugin scope-bound policy (extension hooks; v1 default is identical to global policy).
- Netflow observability: `~/.genie/aegis/netflow.jsonl` append-only, mode 0600, fsync-per-event. Schema versioned. Schema mirrors existing `sec-scan` audit-log conventions.
- CLI mission control: `aegis status`, `aegis policy show|edit|reload|enforce|observe`, `aegis netflow tail|search`, `aegis approve <prompt-id>`, `aegis logs`.
- v1 enforcement tactic: userspace HTTPS proxy. v2 graduates to kernel-level (eBPF on Linux, PF on macOS, WFP on Windows) — out of scope here.

**Aegis continuous scanner (sub-project D)**
- Module inside `aegis-daemon` (same Rust binary, separate crate) consuming the existing scanner contract (`scripts/sec-scan.cjs` invocation interface or a Rust port; sub-project D wish chooses).
- FS watcher mode: Linux fanotify, macOS FSEvents, (Windows ReadDirectoryChangesW deferred to v2). Newly written files in workspace + global install + `$HOME/.npm` + browser profiles trigger incremental scans.
- Scheduled deep scan cadence: configurable interval, default 6 hours, owned by sub-project D wish.
- Signature pack auto-update: hourly poll of `@automagik/genie-signatures` via the same cosign-verified pathway already designed in `sec-signature-registry`.
- Critical-finding pipeline: on critical IOC hit, daemon pauses the active genie agent process (via existing genie process manager), emits desktop notification (notify-rust crate or platform-native), writes typed-ack quarantine prompt that feeds into the existing `genie sec fix` interactive flow.
- Audit log: scanner findings written to existing `$GENIE_HOME/sec-scan/audit/<scan_id>.jsonl` (no new format).

### OUT (explicit)

- Build-time supply-chain sovereignty (vendoring or mirroring our own `bun install` inputs). Flagged as follow-up umbrella `genie-build-sovereignty`. Documented as a known gap.
- Native Windows distribution + sandbox (deferred to v2; WSL works via Linux binaries).
- Kernel-level network enforcement (eBPF / PF / WFP). v1 = userspace proxy. v2 graduates.
- Prompt-injection / PII / data-leak content inspection — `@khal-os` enterprise suite owns this.
- Full agent sandbox where genie runs *inside* a containment boundary — `@khal-os` enterprise suite owns this.
- Mission control desktop or web app — `@khal-os` enterprise suite owns this.
- Replacing `sec-scan-progress`, `sec-remediate`, `sec-fix-one-shot`, or any other shipped one-shot UX — Aegis is additive.
- New IOC detection logic — Aegis consumes `sec-signature-registry` packs unchanged.
- Hardware Security Module procurement for cosign signing — operational, not code; covered by `genie-supply-chain-signing`.

## Sibling wishes

| Slug | Repo | Wave | Appetite | Depends on | Description |
|------|------|------|----------|-----------|-------------|
| `distribution-exodus` (A) | genie | 1 | medium (~2 weeks) | `genie-supply-chain-signing` shipped | CDN + signed binaries + `install.sh` bootstrap + binary `install` subcommand + npm soft-deprecate shim + multi-CDN failover |
| `genie-self-update` (B) | genie | 2 (parallel with C) | medium (~2 weeks) | A shipped | `genie self-update` + channels + rollback + audit log + atomic replace |
| `aegis-runtime` (C) | aegis (NEW) | 2 (parallel with B) | medium (~2 weeks) | A shipped (daemon distributed via same CDN) | Rust daemon scaffold + IPC + lifecycle + network sandbox (observe-only default) + CLI mission control |
| `aegis-scanner` (D) | aegis | 3 | medium (~2 weeks) | C shipped | Continuous scanner module + FS watchers + signature auto-update + critical-finding pipeline integrated with `sec-fix` |

**Total wall-time with parallelism:** ~6 weeks (Wave 1: 2 weeks → Wave 2: 2 weeks → Wave 3: 2 weeks).

## Approach

### Wave 1 — Distribution exodus (A only)

Shut the npm door before furnishing the room.

A is sequential and unblocking — every other sibling depends on the CDN + installer + signed-binary infrastructure shipping first. Wave 1 ships:

- `cdn.automagik.dev` configured with multi-CDN, signed-artifact serving, version-channel directory layout.
- `install.sh` hosted at `get.automagik.dev/genie` (or canonical equivalent; sub-project A picks DNS).
- Binary build pipeline emits per-platform `bun build --compile` artifacts.
- Existing `genie-supply-chain-signing` cosign + SLSA pipeline extended to sign the per-platform binaries (today it signs the npm tarball).
- Binary's own `install` subcommand wires shell integration on first run.
- npm `@automagik/genie` package converted to deprecation shim. Final freeze date documented.

Operators after Wave 1: `curl -fsSL get.automagik.dev/genie | bash` works. Existing `npm install -g @automagik/genie` still works but warns + delegates to install.sh under the hood. The structural exposure is closed.

### Wave 2 — Self-update + Aegis runtime (B ‖ C parallel)

Two streams, two reviewers, two PR queues. They share a build pipeline (cosign + SLSA via Wave 1 infra) but no code.

**B: genie-self-update**
- `genie self-update` subcommand. Reuses Wave 1's CDN + manifest + verification primitives.
- Channels: `stable` / `beta` / `canary`. `canary` is the genie team's own dogfood channel; `beta` is opt-in early-access; `stable` is the default.
- Rollback to previous version via `~/.genie/state/binary-history.json` (last 3 versions retained).
- Audit log per update attempt.

**C: aegis-runtime**
- `automagik-dev/aegis` repo created. Rust binary `aegis-daemon`.
- Daemon scaffolding: lifecycle (launchd/systemd-user), Unix-socket IPC, JSON-RPC protocol (or Cap'n Proto — sub-project C picks).
- Network sandbox: userspace HTTPS proxy, observe-only default, operator-editable allowlist.
- CLI: `aegis` binary (separate from `aegis-daemon`) with `status|policy|netflow|approve|logs|start|stop`.
- Distribution: same CDN, same install.sh — `aegis` is a separate binary download triggered when genie's `install` subcommand detects `--with-aegis` or operator opt-in via post-install prompt.

### Wave 3 — Aegis scanner module (D)

Once C's daemon is alive, D plugs in.

- Scanner module inside `aegis-daemon` (same binary, separate Rust crate).
- FS watchers (fanotify/FSEvents) wired to incremental scanning of workspace + global install + browser profiles.
- Signature pack auto-update via hourly poll of `@automagik/genie-signatures` (existing infra from `sec-signature-registry`).
- Critical-finding pipeline: pause genie agent → desktop notification → typed-ack quarantine prompt → handoff to `genie sec fix`.
- Reuses existing scan audit log; no new on-disk format.

### Architectural invariants (every sibling wish must honor)

1. **install.sh is thin; the binary is fat.** Bootstrap script does platform detection + download + verify + handoff. All shell integration, PATH wiring, and update logic lives in the binary's own `install` subcommand. Mirrors Claude Code's split.
2. **Every artifact is cosign-signed.** Binary, daemon, install.sh itself, manifest.json, signature packs. No exceptions. Reuses `genie-supply-chain-signing` keyless OIDC pipeline.
3. **Cosign public-key fingerprint is byte-identical across four channels:** inlined in install.sh, `SECURITY.md`, `.well-known/security.txt`, pinned GH issue. Owner of byte-identity enforcement: `genie-supply-chain-signing` linter (extended in sub-project A wish).
4. **Aegis daemon is opt-in for v1.** Genie works without it. Aegis is a strict-upgrade overlay. Default network sandbox mode is observe-only; enforcement is operator-acknowledged.
5. **No new audit log formats.** Aegis reuses `$GENIE_HOME/sec-scan/audit/<scan_id>.jsonl` and adds `~/.genie/aegis/netflow.jsonl` only. Both are append-only, mode 0600, fsync-per-event.
6. **Two-org boundary is a hard line.** Nothing in `automagik-dev/aegis` does prompt-injection / PII / data-leak inspection. That's `@khal-os` territory. Crossing the line is a P0 review block.
7. **npm soft-deprecate, not hard-exit.** Existing operators on `npm update -g @automagik/genie` get the shim; the shim downloads the canonical binary; the shim itself is a known artifact with a sunset date. Hard-cutover would brick CI pipelines.

### Alternatives considered and rejected

- **Embed Aegis as a TS module inside genie binary** (option β from brainstorm Q2). Rejected: no visibility into spawned subprocesses, dies with genie, mixes security code with application code (bigger TCB), no future path to enterprise sandbox.
- **Native kernel-level enforcement in v1** (eBPF/PF/WFP, option γ). Rejected for v1: triples the engineering, requires platform code-signing certs, demands elevated install. Userspace HTTPS proxy is sufficient for the threat model (HTTPS is already the wire format for every model API + package mirror + telemetry endpoint genie uses). Graduate to kernel-level in v2.
- **Single Aegis monolith with mission-control TUI bundled** (Pattern P1). Rejected: mixes runtime enforcement with UX, no clean graduation to enterprise control plane, locks Aegis to a TUI ceiling.
- **agent-guard MVP shipped in this umbrella** (Pattern P3). Rejected: doubles wall-time to 10–12 weeks; agent-guard is its own design space (cross-platform desktop, IPC protocol, approval UX, policy editor) deserving its own brainstorm. Defer to `@khal-os` future umbrella.
- **Aegis-first sequencing (W1 plan)**. Rejected: leaves the npm door open during the highest-design-risk weeks (Aegis daemon scaffolding). Distribution-first closes the structural exposure on week 2.
- **Hard npm exit immediately** (Q6). Rejected: bricks CI pipelines and existing operators on `npm update -g`. Soft-deprecate via shim is the same security floor (cosign-verified binary either way) without the breakage.
- **Build-time deps in scope for v1**. Rejected: build-time supply-chain sovereignty (vendoring our own `bun install` inputs) is a separate umbrella. This one is runtime + distribution. Flagged as `genie-build-sovereignty` follow-up.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Umbrella with 4 sibling wishes (canisterworm pattern) | Avoids 6–8 week monolithic branch; independent review per sibling; parallel waves halve wall-time |
| 2 | Aegis = sidecar daemon (Rust) | Memory-safe security software; standalone binary independently signable; survives genie crashes; clean graduation path to kernel-level (v2) and enterprise sandbox (`@khal-os`) |
| 3 | Two-org separation — OSS in `automagik-dev`, enterprise in `@khal-os` | Lite-mode feeds community safe; enterprise tier preserves commercial value; clear boundary on what's free vs. paid |
| 4 | Package architecture P2 — three repos: genie + genie-signatures + aegis | Each has its own publish cadence; clean trust boundaries; agent-guard deferred entirely to `@khal-os` |
| 5 | Sequencing W2 — distribution-first | Shuts the npm door before furnishing the room; gives Aegis daemon design extra cook time; raises the install-floor for every operator regardless of Aegis adoption |
| 6 | Single-point bootstrap = `install.sh` (thin shell, fat binary) | Mirrors Claude Code's proven pattern; minimal trusted compute base in shell; binary owns shell integration + updates |
| 7 | Verification = SHA256 + cosign keyless + SLSA L3 | Strictly more than Claude Code's SHA256-only floor; reuses existing `genie-supply-chain-signing` infrastructure |
| 8 | Platform matrix v1: Linux x86_64 (glibc + musl) + Linux arm64 + macOS x86_64 + arm64 | Mirrors Claude Code's exact matrix; Windows deferred to v2; WSL works via Linux binary |
| 9 | npm transition = soft-deprecate via postinstall shim | Avoids bricking CI / existing operators; same security floor as hard-cutover; sunset date locks down the residual surface |
| 10 | Aegis network sandbox v1 = observe-only default; enforcement opt-in | Avoids the worst UX disaster (firewall blocks legitimate traffic). Operators graduate from observe → enforce when their allowlist stabilizes |
| 11 | Aegis daemon is opt-in for v1 | Genie works without it; daemon is a strict-upgrade overlay; fail-soft on daemon crash |
| 12 | Architectural invariants (7 above) are mandatory in every sibling wish | Prevents drift across the four siblings; reviewer rubric gets the same checklist on every PR |

## Risks & Assumptions

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| 1 | install.sh URL is itself a trust anchor — TLS interception or DNS hijack defeats every downstream check | High | Cosign pubkey fingerprint inlined inside install.sh as third pinning channel; document non-pipe install path (`curl -fsSL > install.sh; less install.sh; bash install.sh`) for paranoid operators; multi-CDN with signed manifest cross-check |
| 2 | Self-updater is a new compromise vector | High | Highest review bar; signed-only update channels; channel pinning; atomic replace with rollback; always-verify-before-exec; reuse `genie-supply-chain-signing` primitives |
| 3 | Build-time compromise (`bun install` for genie itself) defeats distribution sovereignty | High | Out of scope for THIS umbrella; flagged as follow-up `genie-build-sovereignty`; documented gap acknowledged in DESIGN.md |
| 4 | Aegis network firewall blocks legitimate traffic → worse UX disaster than the threat | High | v1 ships observe-only by default; enforcement opt-in; staged rollout owned by sub-project C |
| 5 | Cosign / Fulcio / Rekor uptime — Sigstore is a SPOF | Medium | Offline-verify supported (signature-only, no transparency-log); 24-hour cached rekor proofs in manifest; SHA256-only fallback with audit-logged degraded state |
| 6 | CDN itself is a SPOF | Medium | Multi-CDN (Cloudflare + Fastly), DNS failover, GitHub Releases as tertiary mirror serving identical signed artifacts |
| 7 | Aegis daemon crash kills user shell or genie sessions | Medium | Daemon opt-in for v1; fail-soft on crash (genie continues, logs daemon-down warning); supervisor (launchd/systemd-user) auto-restarts |
| 8 | npm soft-deprecate window leaves a residual attack surface for months | Medium | Hard sunset date; final shim is ≤50 LOC; loud deprecation banner; signal CanisterWorm-class incident → emergency unpublish |
| 9 | Linux glibc-vs-musl + macOS Rosetta detection complexity | Medium | Mirror Claude Code's exact platform-detection logic; CI matrix tests every supported triple |
| 10 | Cross-platform daemon packaging (launchd/systemd; Windows deferred) | Medium | Sub-project C details; v1 = launchd plist + systemd-user unit; Windows deferred to v2 |
| 11 | Cosign in install.sh chicken-and-egg (operator needs cosign to verify cosign download) | Low | Static portable verifier (sigstore-rs compiled small) shipped alongside install.sh; SHA256 floor as compatibility fallback; `INSECURE=1` opt-out with loud warning |
| 12 | Aegis daemon binary is a new published artifact = new attack surface | Low | Same signing infra as genie binary; cosign keyless OIDC; SLSA L3 provenance; cosign-verified before daemon launch |
| 13 | Default network policy allowlist is opinionated → operators disagree | Low | Allowlist is operator-editable; first run shows policy + asks for explicit ack; documented defaults but `~/.genie/aegis/network-policy.yaml` is source of truth |

### Assumptions

- `genie-supply-chain-signing` ships before sub-project A starts (cosign keyless OIDC + SLSA L3 + verify-install + `--unsafe-unverified` ack contract are prerequisites).
- `sec-signature-registry` ships before sub-project D starts (`@automagik/genie-signatures` repo + cosign-verified pack pulling).
- `bun build --compile` produces working static binaries for the platform matrix. Validated in sub-project A wish; if not viable, fallback is `pkg` or `nexe` — locked in sub-project A wish.
- Operators are willing to `curl | bash` for install. Mitigation: also document `curl | tee | inspect | bash` flow in SECURITY.md.
- `automagik-dev/aegis` repo will be created. Felipe controls the org; assume permission.
- `@khal-os` org exists and is the destination for enterprise work. Out of scope but referenced.

## Success Criteria (umbrella-level)

- [ ] All 4 sibling wishes exist (`distribution-exodus`, `genie-self-update`, `aegis-runtime`, `aegis-scanner`) with WRS 100/100 each.
- [ ] Every IN bullet from this DESIGN.md maps to exactly one sibling wish — no gaps, no duplicates.
- [ ] `curl -fsSL get.automagik.dev/genie | bash` on a clean Linux x86_64, Linux arm64, macOS x86_64, macOS arm64 host: detects platform, downloads, verifies SHA256 + cosign + SLSA, installs binary to `~/.local/bin/genie`, sets up `~/.genie/`, `genie --version` works.
- [ ] `genie self-update` upgrades to latest stable, atomically replaces binary, restarts; `genie self-update --rollback` reverts.
- [ ] `aegis status` reports daemon running, network-policy loaded, scanner running.
- [ ] `aegis netflow tail` shows live outbound connection events from genie + subprocesses.
- [ ] `aegis policy show` prints active network policy; `aegis policy add <host>` adds an allowed host with operator ack.
- [ ] Aegis scanner runs continuously, polls `@automagik/genie-signatures` hourly with cosign verification, ingests packs without daemon restart.
- [ ] On critical IOC hit, scanner pauses the active genie agent process, emits desktop notification, writes typed-ack quarantine prompt feeding into `genie sec fix`.
- [ ] `@automagik/genie` npm package is converted to deprecation shim (≤50 LOC postinstall) that downloads + verifies + runs install.sh.
- [ ] Every artifact (genie binary, aegis daemon, install.sh, manifest.json, signatures) is cosign-signed via the existing keyless-OIDC pipeline.
- [ ] Cosign public-key fingerprint is byte-identical across four channels: install.sh inlined, SECURITY.md, .well-known/security.txt, pinned GitHub issue.
- [ ] `automagik-dev/aegis` repo exists with published v0.1.0 release; `@khal-os` enterprise suite is referenced but explicitly OUT.

## Spec self-review (4-point checklist)

1. **Placeholder scan** — no TBDs. Items deferred to sibling wishes are explicitly named (e.g., "DNS choice for `get.automagik.dev` deferred to sub-project A wish") rather than left as TODO.
2. **Internal consistency** — `aegis-scanner` (D) lives inside the `aegis` repo (Rust binary, separate crate) and its critical-finding pipeline integrates with the existing `genie sec fix` UX shipped under `sec-fix-one-shot`. Network sandbox v1 is observe-only by default — consistent with Risk #4 mitigation.
3. **Scope check** — umbrella, by design, spans 4 siblings. Each sibling is a single-wish unit (medium appetite, ~2 weeks, single repo). agent-guard is explicitly deferred to `@khal-os` so the umbrella stays shippable.
4. **Ambiguity check** — "soft-deprecate" is defined (≤50 LOC postinstall shim with hard sunset date); "observe-only" is defined (logs everything, blocks nothing); "opt-in" is defined (genie works without aegis); "platform matrix v1" is defined (4 triples). No two-way interpretations remain.

## Cross-references

- [`canisterworm-incident-response/DESIGN.md`](../canisterworm-incident-response/DESIGN.md) — sister umbrella; this one is **prevention**, that one is **response**.
- [`security-assessment-roadmap` WISH](../../wishes/security-assessment-roadmap/WISH.md) — parallel passive inventory; consume their findings, don't redo.
- [`genie-supply-chain-signing` WISH](../../wishes/genie-supply-chain-signing/WISH.md) — prerequisite for sub-project A.
- [`sec-signature-registry` WISH](../../wishes/sec-signature-registry/WISH.md) — prerequisite for sub-project D.
- [`sec-fix-one-shot` WISH](../../wishes/sec-fix-one-shot/WISH.md) — Aegis scanner critical-finding pipeline integrates with this UX.
- Reference pattern studied: Claude Code installer (`https://claude.ai/install.sh` → `https://downloads.claude.ai/claude-code-releases/bootstrap.sh`).
