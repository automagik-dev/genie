# Wish: Aegis Runtime — sandbox daemon + network observability

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `aegis-runtime` |
| **Date** | 2026-04-27 |
| **Author** | Felipe + Genie (security planning) |
| **Appetite** | medium-large (~2.5 weeks) |
| **Branch** | `wish/aegis-runtime` |
| **Repos touched** | `automagik-dev/aegis` (NEW), `automagik-dev/genie` (integration hooks only) |
| **Design** | [DESIGN.md](../../brainstorms/aegis-distribution-sovereignty/DESIGN.md) |
| **Umbrella** | [aegis-distribution-sovereignty](../../brainstorms/aegis-distribution-sovereignty/DESIGN.md) (Wave 2, sub-project C) |

## Summary

Genie runs unsandboxed: every skill, plugin, MCP server, and shell tool can reach any internet host without operator visibility. This wish creates the new `automagik-dev/aegis` repo and ships `aegis-daemon` (Rust) — a userspace HTTPS proxy + network observer + CLI mission-control surface that genie subprocesses route through. v1 is **observe-only by default**: every outbound connection logged to a structured audit trail; enforcement (default-deny + operator allowlist) is opt-in via `aegis policy enforce`. Aegis is **opt-in**, distributed via the same CDN as genie (sibling A), and signed via the same cosign-keyless pipeline. After this wish, operators have eyes on what genie is doing on the network — without giving up control to a third-party EDR.

## Preconditions

- ✅ `genie-supply-chain-signing` shipped — cosign keyless OIDC + SLSA L3 reused for Aegis signing.
- ✅ `distribution-exodus` shipped — Aegis daemon binaries distribute via `cdn.automagik.dev/aegis/<channel>/<version>/<platform>/`, parallel to genie binaries; manifest schema v1 reused; `~/.genie/` directory layout exists.
- This wish creates the `automagik-dev/aegis` repo from scratch — no Aegis code exists yet. Felipe owns the org and provisions the repo.
- Architectural baseline: sidecar Rust daemon, JSON-RPC IPC over Unix socket, tokio async runtime, tracing for structured logs, SNI-based filtering (no TLS MITM in v1).

## Scope

### IN

**Aegis repo bootstrap + daemon scaffold + IPC (Group 1)**
- New repo `automagik-dev/aegis` with Cargo workspace layout:
  ```
  aegis/
  ├── Cargo.toml                     # workspace root
  ├── crates/
  │   ├── aegis-daemon/              # the long-lived daemon binary
  │   ├── aegis-cli/                 # the operator-facing `aegis` binary
  │   ├── aegis-protocol/            # shared IPC types (JSON-RPC schemas)
  │   ├── aegis-proxy/               # network proxy (Group 2)
  │   ├── aegis-policy/              # policy parsing + evaluation (Group 2)
  │   └── aegis-netflow/             # netflow log writer (Group 3)
  ├── README.md
  ├── SECURITY.md                    # cross-references genie/SECURITY.md
  ├── LICENSE                        # Apache 2.0 (matches genie)
  └── .github/workflows/             # CI: build, test, sign, release
  ```
- Two binaries shipped per platform: `aegis-daemon` + `aegis` (CLI).
- IPC protocol: JSON-RPC 2.0 over Unix socket at `~/.genie/aegis/aegis.sock` (mode 0600, owner-only). Schema versioned (v1) at `crates/aegis-protocol/schemas/v1/`. Methods: `daemon.status`, `daemon.shutdown`, `policy.get`, `policy.reload`, `policy.set_mode`, `netflow.subscribe`, `netflow.search`, `prompt.approve`, `prompt.list_pending`.
- Lifecycle: launchd plist (`~/Library/LaunchAgents/dev.automagik.aegis.plist`) on macOS + systemd-user unit (`~/.config/systemd/user/aegis.service`) on Linux. CLI commands `aegis start|stop|restart|status` wrap the platform supervisor.
- Cargo workspace targets: `cargo build --release --target=<triple>` for the same matrix as genie (Linux x86_64 glibc/musl, Linux arm64, macOS x86_64/arm64). musl static builds via `cargo zigbuild` or equivalent.
- Distribution: GitHub Actions release workflow signs all 5 platform binaries via cosign keyless (same OIDC identity pattern as genie); SLSA L3 provenance attached; artifacts pushed to `cdn.automagik.dev/aegis/<channel>/<version>/<platform>/` with manifest.json v1.
- Independent versioning: Aegis evolves on its own publish cadence; not coupled to genie release train.

**Userspace HTTPS proxy + network policy core (Group 2)**
- `aegis-proxy` crate: TCP listener on `127.0.0.1:<auto-port>`, port written to `~/.genie/aegis/proxy.port` for clients. Genie subprocesses route through it via `HTTPS_PROXY=http://127.0.0.1:<port>` env var injected by genie's hook layer (Group 4).
- Proxy strategy: **SNI-based observation + filtering, no TLS MITM**. The proxy parses the TLS ClientHello to extract SNI hostname; logs (host, port, process metadata via SO_PEERCRED on Linux / LOCAL_PEERPID on macOS); decides allow/observe/deny based on policy; if allow, transparently splices bytes between client and origin without inspecting payloads.
- v1 modes (per policy file):
  - `mode: observe` (default) — log all SNI metadata; allow all connections; no enforcement.
  - `mode: enforce` — log all SNI metadata; allow only hosts in `allow_list`; deny everything else with structured audit event + helpful client-side error message.
  - `mode: prompt` (future v2 stub — schema reserved, not implemented in v1).
- `network-policy.yaml` schema (v1, JSON-Schema validated):
  ```yaml
  schema_version: 1
  mode: observe | enforce
  allow_list:
    - host: api.anthropic.com
      reason: "Claude API endpoint"
    - host: api.openai.com
      reason: "OpenAI API endpoint"
    - host: github.com
      reason: "GitHub API + repo operations"
    - host: cdn.automagik.dev
      reason: "Genie + Aegis self-update"
    - host: registry.npmjs.org
      reason: "npm registry — REMOVE after npm sunset"
      sunset: "2026-10-27"
  per_process_overrides: []  # v1 stub; v2 expands
  ```
- Default `network-policy.yaml` shipped at first run includes the 5 hosts above + the existing genie operator's expected endpoints (Sentry, Datadog, etc. — TBD by Group 2 author from operator survey).
- Policy reload: `aegis policy reload` re-reads YAML; in-flight connections grandfather under the prior policy until they close. Audit event `policy.reloaded` records the diff.
- Refusal behavior: blocked connection emits `403 Forbidden` HTTP error to the client (since clients see this as an HTTP proxy) with a JSON body explaining the block + how to add the host to the allowlist. Audit event `connection.blocked` recorded.

**Netflow observability + CLI mission control (Group 3)**
- `aegis-netflow` crate: append-only writer to `~/.genie/aegis/netflow.jsonl` (mode 0600, fsync-per-event). Schema v1:
  ```json
  {
    "schema_version": 1,
    "event_type": "connection.observed | connection.allowed | connection.blocked | connection.error",
    "timestamp": "...",
    "client_pid": ...,
    "client_process_name": "...",
    "client_parent_pid": ...,
    "client_parent_process_name": "...",
    "sni_host": "api.anthropic.com",
    "destination_port": 443,
    "policy_decision": "observe | allow | deny",
    "policy_match": "allowlist:api.anthropic.com",
    "tls_version": "1.3",
    "elapsed_ms": ...,
    "bytes_sent": ...,
    "bytes_received": ...,
    "skill_context": "..."   // populated when genie hook layer tags the call
  }
  ```
- CLI mission control (`aegis-cli` binary):
  - `aegis status` — daemon health, mode, policy summary, netflow event count last 24h.
  - `aegis policy show [--json]` — current policy YAML or JSON.
  - `aegis policy edit` — opens `$EDITOR` on the policy file; runs schema validation + reload on save.
  - `aegis policy add <host> [--reason <text>]` — adds a host to allowlist with operator ack.
  - `aegis policy remove <host>` — removes a host.
  - `aegis policy reload` — manual reload after external edit.
  - `aegis policy enforce` / `aegis policy observe` — switches mode.
  - `aegis netflow tail [--filter <expr>]` — live tail of netflow events; supports filtering on host, process, pid, decision.
  - `aegis netflow search --since 1h --host github.com` — historical search over netflow.jsonl.
  - `aegis logs [--since 1h] [--follow]` — daemon stderr / tracing output.
  - `aegis approve <prompt-id>` — typed-ack approval for pending operator prompts (forward-looking — `aegis-scanner` Wave 3 sibling D produces these prompts on critical findings; v1 ships the surface).
  - `aegis prompts list [--pending]` — pending operator prompts.
- All CLI commands proxy to the daemon via JSON-RPC over the Unix socket; daemon-down state shows a helpful "daemon not running; run `aegis start`" message with exit code 11.

**Genie integration + opt-in install (Group 4)**
- Genie hook layer modification (in `automagik-dev/genie` repo, NOT aegis): detect `~/.genie/aegis/aegis.sock` on startup. If present + daemon healthy, set `HTTPS_PROXY=http://127.0.0.1:<port>` from `~/.genie/aegis/proxy.port` for genie subprocesses (skills, plugins, MCP servers, spawned shells).
- Genie passes per-call context to the daemon via a new HTTP header `X-Aegis-Context: <skill-id>:<turn-id>` (proxy parses + tags netflow events with `skill_context`).
- New top-level genie command `genie aegis` (proxies to `aegis` CLI binary if installed). Subcommands `genie aegis install|status|policy|netflow|...` exactly mirror `aegis ...` for discoverability.
- `genie aegis install` opt-in flow:
  1. Detects platform.
  2. Downloads `aegis-daemon` + `aegis` from CDN (`cdn.automagik.dev/aegis/stable/latest/<platform>/`).
  3. Verifies SHA256 + cosign + SLSA via `distribution-exodus` static portable verifiers.
  4. Installs binaries to `~/.local/bin/aegis-daemon` + `~/.local/bin/aegis`.
  5. Writes launchd plist / systemd-user unit.
  6. Starts daemon.
  7. Writes default `~/.genie/aegis/network-policy.yaml` (mode: observe).
  8. Prints first-run summary: "Aegis observing; switch to enforce with `aegis policy enforce`".
- First-run prompt: when an operator runs `genie install` (sibling A), final step asks "install Aegis for network observability? [Y/n]". `n` skips; `Y` runs `genie aegis install`.
- Fail-soft: if daemon dies mid-genie-session, genie logs a warning and continues without proxy (network calls go direct). Genie does NOT refuse to operate without Aegis. Audit event `aegis.daemon-down` recorded by the next aegis CLI invocation.

### OUT

- **Kernel-level enforcement** (eBPF on Linux, PF on macOS, WFP on Windows). v1 is userspace HTTPS proxy only. Subprocesses that bypass `HTTPS_PROXY` (e.g., explicitly using a SOCKS proxy or raw sockets) escape v1 enforcement. v2 graduates to kernel-level.
- **TLS MITM / payload inspection**. v1 sees only SNI hostname — never plaintext bodies. Payload inspection (prompt-injection / PII / data-leak detection) is `@khal-os` enterprise territory.
- **Continuous workspace scanner**. Owned by sibling D (`aegis-scanner`). v1 of `aegis-runtime` ships the daemon scaffold; D plugs the scanner module into it.
- **Native Windows daemon**. Deferred to v2; mirror's `distribution-exodus` Windows-deferred decision.
- **Multi-host policy distribution / centralized control plane**. `@khal-os` enterprise tier owns this. v1 is single-host self-managed.
- **`mode: prompt` interactive policy enforcement**. Schema reserved in v1; implementation deferred to v2.
- **Aegis self-update verb**. `aegis self-update` ships in a future Aegis-side wish; v1 distribution flow is via `genie aegis install --reinstall` for upgrades. Aegis updates are infrequent until v2.
- **Per-skill / per-plugin scope-bound policy enforcement**. v1 schema includes `per_process_overrides` field but the field is a stub; v2 implements per-process granular policy.
- **Audit log forwarding to SIEM / external endpoints**. Local jsonl only in v1; forwarding is `@khal-os` territory.
- **Web / desktop dashboard**. CLI is the only mission-control surface in v1. Desktop app is `@khal-os` work.
- **Replacement of existing `genie sec` workflow**. Aegis is additive; `genie sec scan` / `sec-fix` continue to work unchanged.
- **Network policy enforcement on the daemon's own outbound calls**. The daemon must reach Sigstore + CDN for verification; these are unconditionally allowed (hardcoded; documented in code). Operators who block these via OS firewall will see degraded daemon behavior.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Rust for the daemon | Memory-safe, fast, cross-platform, low overhead; matches industry expectations for security-critical software (cosign, sigstore-rs, slsa-verifier are all Rust) |
| 2 | New repo `automagik-dev/aegis` (separate from genie) | Independent publish cadence, separate trust boundary, clean dependency graph; lets Aegis evolve without coupling to genie's release train |
| 3 | Two binaries: `aegis-daemon` (long-lived) + `aegis` (CLI) | Standard sysadmin pattern (cf. `dockerd` + `docker`, `systemd` + `systemctl`); CLI starts/stops/talks-to daemon over IPC |
| 4 | JSON-RPC 2.0 over Unix socket for IPC | Smallest TCB; no codegen; widely supported; debug-friendly with `socat` + `jq`; mode-0600 socket prevents unprivileged access |
| 5 | tokio as the async runtime | Industry standard for Rust; rich ecosystem; performance-proven for high-connection-count proxies |
| 6 | SNI-based filtering, no TLS MITM in v1 | Avoids the cert-distribution + browser-trust-root nightmare; matches operator expectation of "see what host genie is calling, don't see what genie is sending"; defers content inspection to `@khal-os` enterprise tier |
| 7 | `mode: observe` is the default after install | Avoids the worst UX disaster (firewall blocks legitimate traffic on day 1); operators graduate to enforce when their allowlist stabilizes |
| 8 | Daemon is opt-in, not auto-installed | Genie works without Aegis; opt-in respects operator agency; first-run prompt offers install but does not force |
| 9 | Genie fail-soft on daemon down | Daemon crash should never kill a genie session; degrades gracefully to direct network calls + audit-log entry on next aegis CLI invocation |
| 10 | Aegis distributed via the same CDN as genie | Reuses sibling A's CDN + manifest + verification pipeline; consistent install + verification UX; one cosign signing identity per channel |
| 11 | Independent Aegis versioning (not coupled to genie semver) | Aegis evolves on security cadence (signature schema, policy schema); genie evolves on agent-runtime cadence; coupling them creates artificial release pressure on both |
| 12 | Cargo workspace with feature-gated crates | Clean separation: daemon, CLI, proxy, policy, netflow each as their own crate; tests + reviews scoped to single crate; future open-source contributions easier to scope |
| 13 | musl static binaries for Linux distribution | Matches `distribution-exodus` pattern; eliminates glibc-version compatibility issues across distros |
| 14 | launchd (macOS) + systemd-user (Linux) for daemon supervision | Native platform tooling; auto-restart on crash; survives reboots; familiar to ops teams |
| 15 | Daemon's own outbound calls (CDN + Sigstore) are hardcoded-allowed | Daemon must verify its own updates + signature packs; making these policy-controlled creates bootstrap circular dependency; documented in code with rationale |
| 16 | `genie aegis ...` mirrors `aegis ...` subcommands | Discoverability: operators familiar with genie CLI can manage Aegis without context switch; both commands are thin wrappers over the same JSON-RPC surface |
| 17 | First-run install prompt during `genie install` (sibling A) integration | Adoption funnel: operators encounter Aegis at install-time, not later; opt-in default `Y` (with clear `n` path) makes Aegis the easy choice without forcing |
| 18 | Netflow audit log mode-0600 + fsync-per-event matches existing genie audit-log conventions | Consistency across genie + Aegis security audit trails; forensic tools written once work everywhere |
| 19 | `aegis approve <prompt-id>` ships in v1 even though no producer exists yet | Forward-looking surface for sibling D scanner; locked-in CLI shape avoids subsequent renames; empty pending-prompts list is a valid v1 state |

## Success Criteria

- [ ] `automagik-dev/aegis` repo exists with v0.1.0 tagged release; cargo workspace builds 5 platform binaries; CI green.
- [ ] All 5 platform binaries cosign-signed via keyless OIDC; SLSA L3 provenance attached; published to `cdn.automagik.dev/aegis/stable/0.1.0/<platform>/`.
- [ ] `genie aegis install` on a clean Linux + macOS host: downloads, verifies, installs, starts daemon, writes default policy, exits 0; `aegis status` reports `mode: observe, healthy`.
- [ ] Daemon process supervision: launchd (macOS) restarts daemon on crash within 5 seconds; systemd-user (Linux) does the same.
- [ ] IPC: `aegis status` round-trips JSON-RPC over the Unix socket in <50ms p99.
- [ ] Unix socket mode is 0600 (owner-only) on both platforms.
- [ ] Network proxy: genie subprocess making `https://api.anthropic.com/v1/messages` call goes through proxy; netflow.jsonl records `connection.observed` event with SNI=api.anthropic.com, correct PID, correct skill_context.
- [ ] `aegis policy enforce` switch: blocked host `https://example.com` returns HTTP 403 to client with helpful body; netflow records `connection.blocked` event.
- [ ] `aegis policy add example.com --reason "manual test"` adds host; reload picks it up; subsequent calls allowed; audit event `policy.reloaded` recorded.
- [ ] `aegis netflow tail` shows live events; `aegis netflow search --since 1h --host api.anthropic.com` returns historical events; both work without daemon restart.
- [ ] Policy schema validation: malformed YAML refused with line-number error; daemon continues serving prior policy.
- [ ] Fail-soft: kill daemon mid-genie-session; genie continues with a warning; subsequent `aegis status` reports daemon-down; `aegis start` brings it back; netflow resumes.
- [ ] First-run install prompt during `genie install` integration: choosing `Y` runs `genie aegis install`; choosing `n` skips; both paths are tested.
- [ ] `aegis approve <fake-prompt-id>` returns "no pending prompt with id <fake-prompt-id>" gracefully (forward-looking surface intact).
- [ ] netflow.jsonl mode is 0600; fsync-per-event verified by stress test.
- [ ] Aegis daemon's own outbound calls (CDN, Sigstore) succeed even in `mode: enforce` (hardcoded-allowed paths).
- [ ] Reproducible builds: same source commit produces byte-identical Rust binaries across two CI runs (modulo timestamps / build-id).

## Dependencies / Related Wishes

| Relationship | Wish | Reason |
|--------------|------|--------|
| depends-on | `genie-supply-chain-signing` (shipped) | Cosign + SLSA primitives reused for Aegis signing |
| depends-on | `distribution-exodus` | CDN + manifest schema + static portable verifiers + `~/.genie/` layout are prerequisites |
| umbrella | `aegis-distribution-sovereignty` | Sibling C (Wave 2) of the umbrella |
| related | `genie-self-update` | Sibling B runs in parallel; both consume sibling A's CDN + verification stack; both add new audit log surfaces |
| blocks | `aegis-scanner` | Sibling D ships scanner module *inside* aegis-daemon; this wish creates the daemon scaffold + IPC + CLI it plugs into |
| related | `sec-signature-registry` (shipped) | Aegis's network-policy schema borrows YAML + JSON-Schema patterns from signature packs |
| related | `sec-fix-one-shot` (shipped) | `aegis approve` CLI surface is forward-compatible with sec-fix typed-ack flow |

## Execution Strategy

### Wave 1 — Repo bootstrap + daemon scaffold + IPC (sequential)

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | New automagik-dev/aegis repo; cargo workspace; aegis-daemon + aegis-cli binaries; JSON-RPC over Unix socket; launchd + systemd-user units; CI release pipeline with cosign + SLSA. |

### Wave 2 — Network proxy + policy engine (sequential after Wave 1)

| Group | Agent | Description |
|-------|-------|-------------|
| 2 | engineer | aegis-proxy crate (SNI parsing, splice, HTTPS forward proxy); aegis-policy crate (YAML schema, evaluation, reload); observe + enforce modes; default policy shipping. |

### Wave 3 — Netflow + CLI ‖ Genie integration (parallel after Wave 2)

| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer | aegis-netflow crate (append-only jsonl writer); CLI mission control (status, policy, netflow, logs, approve, prompts); JSON output mode for scripting. |
| 4 | engineer | Genie hook layer: socket detection, HTTPS_PROXY injection, X-Aegis-Context header tagging, fail-soft on daemon-down; `genie aegis install` opt-in flow + first-run prompt. |

## Execution Groups

### Group 1: Repo bootstrap + daemon scaffold + IPC

**Goal:** `automagik-dev/aegis` exists as a working cargo workspace; `aegis-daemon` runs and accepts JSON-RPC over a Unix socket; `aegis status` round-trips; CI publishes signed binaries to the CDN.

**Deliverables:**
1. New repo `automagik-dev/aegis` provisioned by Felipe with branch protection, CODEOWNERS, MIT/Apache-2.0 license.
2. Cargo workspace at the repo root with crates listed in scope IN. `cargo build --workspace --release` succeeds on local dev host.
3. `aegis-daemon` binary: tokio main loop; Unix socket listener at `~/.genie/aegis/aegis.sock` (mode 0600); structured tracing-crate logs to stderr + a future audit log; graceful shutdown on SIGTERM.
4. `aegis-cli` binary: subcommands `start | stop | restart | status` invoking platform supervisor + JSON-RPC `daemon.status`.
5. JSON-RPC schema crate `aegis-protocol` with v1 method definitions + serde-derived request/response types. Every JSON-RPC response from the daemon includes a top-level `protocol_version: 1` field. CLI invokes `daemon.status` on every connect and refuses with exit code 12 + message `"Aegis daemon reports protocol v<X>; this CLI expects v1. Run: genie aegis install --reinstall (or aegis self-update if available)"` on mismatch. Sibling D (`aegis-scanner`) extends this crate with a `v1/scanner-notification.json` method group — this wish reserves the namespace `scanner.*` (`scanner.status`, `scanner.trigger`, `scanner.history`, `scanner.cancel`, `scanner.notify-critical-finding`, `scanner.notify-resolved`) so sibling D extends without breaking versioning.
6. Platform supervisor units:
   - `aegis-cli` writes `~/Library/LaunchAgents/dev.automagik.aegis.plist` on macOS first-launch.
   - `aegis-cli` writes `~/.config/systemd/user/aegis.service` on Linux first-launch.
   - Both restart-on-failure with 5s backoff; logs to `~/.genie/aegis/daemon.log`.
7. CI release workflow: matrix build (5 platform triples) → cosign keyless sign → SLSA generator attestation → upload to `cdn.automagik.dev/aegis/<channel>/<version>/<platform>/` with manifest.json v1 (reusing `distribution-exodus` schema).
8. README.md + SECURITY.md cross-referenced to genie equivalents.
9. Tests: `aegis-daemon` integration tests (start, accept JSON-RPC, status round-trip, graceful shutdown) — uses tmpdir-mocked HOME.

**Acceptance Criteria:**
- [ ] `cargo build --workspace --release` succeeds on Linux x86_64 + macOS arm64 dev hosts.
- [ ] `cargo test --workspace` passes; ≥80% line coverage on aegis-daemon + aegis-cli.
- [ ] `aegis start` launches daemon via supervisor; `aegis status` returns JSON-RPC response with version + uptime + mode.
- [ ] Unix socket mode is 0600; verified via `stat -c %a` on Linux + `stat -f %A` on macOS.
- [ ] CI release on a tagged version produces 5 cosign-signed binaries + SLSA provenance + manifest.json on the CDN.
- [ ] `aegis stop` issues `daemon.shutdown` JSON-RPC; daemon flushes logs + exits cleanly within 2 seconds.
- [ ] Reproducibility: two CI runs of the same source commit produce byte-identical binaries (modulo build timestamps).

**Validation:**
```bash
git clone git@github.com:automagik-dev/aegis.git && cd aegis
cargo build --workspace --release && cargo test --workspace
./target/release/aegis start && ./target/release/aegis status | jq .version
stat -c '%a' ~/.genie/aegis/aegis.sock  # 600
gh workflow run release.yml --ref v0.1.0-test
gh run watch
```

**depends-on:** none

---

### Group 2: Userspace HTTPS proxy + policy engine

**Goal:** `aegis-daemon` proxies HTTPS connections (SNI-based observation + filtering); `network-policy.yaml` is the source of truth; observe + enforce modes work end-to-end.

**Deliverables:**
1. `aegis-proxy` crate: TCP listener on `127.0.0.1:<auto-port>`; port written to `~/.genie/aegis/proxy.port`. SNI parser for TLS ClientHello (no MITM). Connection splicing via tokio::io::copy_bidirectional. Per-connection metadata tagging via SO_PEERCRED (Linux) / LOCAL_PEERPID (macOS).
2. `aegis-policy` crate: YAML loader with JSON-Schema validation against `crates/aegis-policy/schemas/network-policy-v1.schema.json`. Policy evaluation function `evaluate(host, port, client_pid, mode) -> Decision`. File watcher (notify crate) for hot reload on save.
3. Default `network-policy.yaml` shipped at first run: mode `observe`, allow_list with the 5 baseline hosts (api.anthropic.com, api.openai.com, github.com, cdn.automagik.dev, registry.npmjs.org with sunset date). Operator-survey for additional defaults documented in `docs/network-policy-defaults.md`.
4. `daemon.set_mode(observe|enforce)` JSON-RPC method; CLI subcommand `aegis policy enforce` / `aegis policy observe`. If `network-policy.yaml` contains `mode: prompt` (reserved-but-unimplemented in v1), the loader refuses with the exact error: `"mode: prompt is reserved for Aegis v2; use mode: observe or mode: enforce in v0.1.x. See docs/network-policy-defaults.md."` Daemon retains prior policy in memory; CLI `aegis policy reload` exit code 13. Other unknown modes get the same refusal with the offending value substituted.
5. Refusal behavior: blocked connection returns HTTP 403 with JSON body `{error, host, suggestion}`; client sees a clear error.
6. Hardcoded-allowed paths (daemon's own outbound): `cdn.automagik.dev`, `objects.githubusercontent.com` (Sigstore), `rekor.sigstore.dev`, `fulcio.sigstore.dev`, `tuf-repo-cdn.sigstore.dev`. Documented in `crates/aegis-proxy/src/hardcoded_allowed.rs` with rationale comments.
7. Tests:
   - `aegis-proxy` unit tests: SNI parsing on real ClientHello bytes, splicing correctness on small + large payloads.
   - Integration tests against a local TLS server fixture: observe mode allows + logs; enforce mode allows allowlisted + denies others.
   - Policy schema tests: every example in default config validates; common malformations reject with line numbers.

**Acceptance Criteria:**
- [ ] `aegis-daemon` running with default policy; HTTP client routing through `127.0.0.1:<port>` to `https://api.anthropic.com` succeeds; netflow event recorded with SNI=api.anthropic.com.
- [ ] Observe mode: connection to `https://example.com` succeeds; netflow event `connection.observed` recorded.
- [ ] Enforce mode: connection to `https://example.com` fails with HTTP 403; netflow event `connection.blocked` recorded; client sees structured error JSON.
- [ ] `aegis policy add example.com --reason "test"` updates YAML; reload picks it up; subsequent connection succeeds in enforce mode.
- [ ] Schema validation: malformed YAML (missing `schema_version`) refused with helpful error; prior policy retained in memory.
- [ ] Hardcoded-allowed: in enforce mode with no allowlist, connection from daemon to `cdn.automagik.dev` succeeds (verified via tracing log).
- [ ] Per-process metadata: PID + parent PID + process names appear in netflow events.
- [ ] Performance: 1000 concurrent HTTPS connections through the proxy maintain ≥50 MB/s aggregate throughput on a developer laptop.

**Validation:**
```bash
cargo test -p aegis-proxy
cargo test -p aegis-policy
./target/release/aegis-daemon &
HTTPS_PROXY=http://127.0.0.1:$(cat ~/.genie/aegis/proxy.port) curl -fsSL https://api.anthropic.com/  # observe mode allows
./target/release/aegis policy enforce
HTTPS_PROXY=http://127.0.0.1:$(cat ~/.genie/aegis/proxy.port) curl -v https://example.com 2>&1 | grep '403'
./target/release/aegis policy add example.com --reason test
HTTPS_PROXY=http://127.0.0.1:$(cat ~/.genie/aegis/proxy.port) curl -fsSL https://example.com  # now allowed
```

**depends-on:** Group 1

---

### Group 3: Netflow observability + CLI mission control

**Goal:** Operators can see exactly what genie + subprocesses do on the network, and manage Aegis end-to-end via the `aegis` CLI.

**Deliverables:**
1. `aegis-netflow` crate: append-only writer to `~/.genie/aegis/netflow.jsonl` with schema v1. Mode 0600. Fsync-per-event. Rotating log support (gzip after 100 MB, retain last 10).
2. JSON-RPC methods `netflow.subscribe` (live stream) + `netflow.search(filter, since, until)` (historical query).
3. CLI subcommands: `aegis status`, `aegis policy show|edit|add|remove|reload|enforce|observe`, `aegis netflow tail|search`, `aegis logs`, `aegis approve`, `aegis prompts list`.
4. `--json` flag on every subcommand for machine-readable output (consumers: shell scripts, dashboards).
5. `aegis status` health check: daemon running, mode, policy hash, netflow event count last 24h, last error if any.
6. Schema: `crates/aegis-netflow/schemas/netflow-v1.schema.json` (JSON Schema), reused by sibling D scanner.
7. Tests:
   - `aegis-netflow` writer tests: schema validation, fsync ordering, rotating log behavior.
   - CLI integration tests: every subcommand against a running daemon (tmpdir-mocked HOME).
   - JSON output stability: snapshot tests on every `--json` mode.

**Acceptance Criteria:**
- [ ] `aegis netflow tail` streams live events as connections happen; SIGINT cleanly exits.
- [ ] `aegis netflow search --since 1h --host api.anthropic.com --json | jq '.events | length'` returns event count matching independent grep over jsonl.
- [ ] `aegis status --json` returns valid JSON with `version`, `uptime_s`, `mode`, `policy_hash`, `netflow_events_24h`, `last_error`.
- [ ] `aegis logs --since 1h` prints daemon stderr captured from supervisor logs.
- [ ] `aegis prompts list` returns empty array when no producer exists (forward-looking surface).
- [ ] netflow.jsonl mode is 0600 (verified); fsync interleave stress test passes.
- [ ] Rotating log: write 105 MB of events; verify previous file gzipped + new file started; verify retention cap of 10 files.
- [ ] All `--json` outputs validate against published schemas.

**Validation:**
```bash
cargo test -p aegis-netflow
cargo test -p aegis-cli
./target/release/aegis netflow tail &
HTTPS_PROXY=http://127.0.0.1:$(cat ~/.genie/aegis/proxy.port) curl -s https://api.anthropic.com/ &
sleep 2; ./target/release/aegis status --json | jq .netflow_events_24h
./target/release/aegis netflow search --since 1m --host api.anthropic.com --json | jq '.events | length'
stat -c '%a' ~/.genie/aegis/netflow.jsonl  # 600
```

**depends-on:** Group 2

---

### Group 4: Genie integration + opt-in install flow

**Goal:** Genie detects Aegis when present, routes its subprocess network through it, and offers Aegis as an opt-in during `genie install`.

**Deliverables:**
1. Modification in `automagik-dev/genie` repo (NOT aegis): `src/lib/aegis-detect.ts` (new) — detects `~/.genie/aegis/aegis.sock` + reads `~/.genie/aegis/proxy.port` + sets `HTTPS_PROXY` for genie subprocesses.
2. `src/lib/aegis-context.ts` (new) — injects `X-Aegis-Context: <skill-id>:<turn-id>` header into outbound HTTPS calls (via process env or per-request hook depending on call site).
3. `src/term-commands/aegis.ts` (new): `genie aegis` top-level subcommand that proxies to `aegis` CLI binary if installed; helpful "run `genie aegis install`" message if not.
4. `genie aegis install` opt-in flow:
   - Detects platform (reuses `distribution-exodus` platform-detection helpers).
   - Downloads `aegis-daemon` + `aegis` from `cdn.automagik.dev/aegis/stable/latest/<platform>/`.
   - Verifies SHA256 + cosign + SLSA via `distribution-exodus` static portable verifiers.
   - Installs binaries to `~/.local/bin/aegis-daemon` + `~/.local/bin/aegis`.
   - Writes default `~/.genie/aegis/network-policy.yaml` if absent.
   - Runs `aegis start`.
   - Prints first-run summary with policy mode, key fingerprint, mission-control commands.
5. First-run prompt during `genie install` (sibling A integration): final step asks "install Aegis for network observability? [Y/n]". Default `Y`. `n` skips; `Y` runs `genie aegis install`. Skip is audit-logged in `~/.genie/audit/install.jsonl` so operators who later opt in don't lose context.
6. Fail-soft daemon-down handling — two detection paths:
   - **Proactive (startup):** genie checks daemon health via `aegis status` once at session start. If unreachable, logs a single stderr warning + writes `aegis.daemon-down` event to `~/.genie/audit/aegis.jsonl` (creates file if absent) and skips proxy injection for the session.
   - **Reactive (per-call):** when a genie subprocess HTTPS call to `127.0.0.1:<proxy-port>` fails with `ECONNREFUSED` (daemon died mid-session), the call retries once *without* the proxy; on success, logs `aegis.daemon-down-reactive` audit event (rate-limited to once per session); on failure, propagates the original error to the caller.
   - Detection mechanism is layered into `src/lib/aegis-detect.ts` (proactive) + a per-process retry helper in `src/lib/aegis-context.ts` that wraps outbound `fetch`/HTTPS calls. Subprocess shell-outs (curl, wget, gh, etc.) do NOT get reactive fallback — they see the daemon-down state via the same retry chain only if the genie hook layer wraps them.
7. Tests:
   - `src/lib/aegis-detect.test.ts` — socket detection happy path, missing-socket fallback, daemon-down fallback.
   - `src/lib/aegis-context.test.ts` — header injection.
   - `src/term-commands/aegis.test.ts` — proxy-to-CLI behavior, install flow against tmpdir-mocked CDN.
   - Integration test: `bash scripts/integration/genie-with-aegis.sh` — install genie, install aegis, verify HTTPS_PROXY env propagation.

**Acceptance Criteria:**
- [ ] Genie subprocess (e.g., a skill that fetches `https://api.anthropic.com`) goes through Aegis proxy when daemon is running; netflow records the event with correct skill_context.
- [ ] Daemon-down fallback: kill daemon mid-genie-session; subsequent skill HTTPS calls succeed (direct, no proxy); warning logged to stderr; `~/.genie/audit/aegis.jsonl` records `aegis.daemon-down`.
- [ ] `genie aegis install` on clean Linux + macOS host: downloads, verifies, installs, starts, prints summary; `aegis status` succeeds.
- [ ] `genie aegis install --reinstall` (reuses pattern from `genie install --reinstall`) wipes prior install + re-runs cleanly.
- [ ] First-run prompt: integration test in `scripts/integration/genie-install-with-aegis-prompt.sh` covers `Y` (Aegis installed) + `n` (Aegis skipped, audit log entry created).
- [ ] `genie aegis status` output matches `aegis status` byte-for-byte (proxy is transparent).
- [ ] X-Aegis-Context header on outbound HTTPS calls: visible in netflow events as `skill_context` field.
- [ ] Idempotency: `genie aegis install` run twice produces identical end-state.

**Validation:**
```bash
bun test src/lib/aegis-detect.test.ts src/lib/aegis-context.test.ts
bun test src/term-commands/aegis.test.ts
bash scripts/integration/genie-with-aegis.sh
bash scripts/integration/genie-install-with-aegis-prompt.sh
genie aegis status --json | jq .mode  # observe
```

**depends-on:** Group 3

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] `automagik-dev/aegis` v0.1.0 release published; `cdn.automagik.dev/aegis/stable/0.1.0/<platform>/` serves cosign-signed binaries on all 5 triples.
- [ ] `genie aegis install` on clean Linux x86_64 (glibc + musl), Linux arm64, macOS x86_64 + arm64 succeeds end-to-end.
- [ ] Daemon supervision: SIGKILL daemon; supervisor restarts within 5 seconds; netflow resumes; no socket leak.
- [ ] Network policy enforce mode: blocks unlisted host with HTTP 403; allows allowlisted host; reload picks up file edits without daemon restart.
- [ ] Netflow integrity: 10 000 connections through proxy produce 10 000 netflow events; no drops; mode-0600 preserved; jsonl remains valid.
- [ ] Genie integration: skill making `https://api.anthropic.com/v1/messages` call shows up in netflow with correct skill_context tag.
- [ ] Fail-soft: kill daemon during genie session; session continues; no test failures; audit event recorded.
- [ ] Cross-platform IPC: socket round-trip <50ms p99 on Linux + macOS.
- [ ] Reproducible Aegis builds: 2 CI runs produce byte-identical binaries.
- [ ] `bun run check` (genie repo) passes after Aegis integration hooks land.
- [ ] `cargo test --workspace` (Aegis repo) passes; ≥80% line coverage on critical crates.
- [ ] Documentation: SECURITY.md cross-references; aegis README explains observe-vs-enforce; default policy `docs/network-policy-defaults.md` enumerated.
- [ ] Hardcoded-allowed audit: every entry in `aegis-proxy/src/hardcoded_allowed.rs` has a rationale comment + linked issue.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Userspace HTTPS proxy bypass: subprocess explicitly ignores HTTPS_PROXY (uses raw sockets, SOCKS proxy, hardcoded IPs) | High | Documented as known v1 gap; netflow flags subprocesses that DON'T appear in expected proxy traffic; v2 graduates to kernel-level enforcement (eBPF/PF/WFP) which closes the gap |
| Daemon crash kills genie session because operator misconfigured | High | Fail-soft contract: genie continues with direct network on daemon-down; warning + audit event; daemon supervisor auto-restarts in <5s; integration test asserts this path |
| SNI-only filtering misses domain fronting / hostname mismatches | High | v1 documented gap — SNI matches what TLS handshake claims; CONNECT-tunnel inspection or content fingerprinting deferred to `@khal-os` enterprise tier |
| Operator allowlist is too permissive → de-facto observe mode under enforce | High | Default allowlist is minimal (5 hosts); `aegis policy show` highlights wildcards + warns on operator-added hosts without `reason` field; SECURITY.md best-practices documented |
| Cargo workspace + Rust toolchain version drift across 5 platform triples | Medium | Toolchain pinned via `rust-toolchain.toml`; CI matrix tests every triple; `cargo zigbuild` for musl static builds; documented in `docs/build.md` |
| Hardcoded-allowed paths leak operator out to Sigstore even when they want full air-gap | Medium | Documented; `aegis policy fully-isolated` flag deferred to v2 — would require an offline-verify mode for daemon's own updates |
| Default policy ships hosts that operators legitimately want to block | Medium | Operator reviews + edits `network-policy.yaml` on first run; first-run prompt mentions the file; sunset entry for npm shows pattern |
| `mode: prompt` schema reserved but not implemented → operators expect interactive prompts and don't get them | Medium | v1 docs explicitly say "prompt mode is reserved for v2"; CLI rejects `mode: prompt` with helpful error if set in YAML |
| netflow.jsonl grows unbounded on busy hosts | Medium | Rotating log: 100 MB cap, gzip rotated, retain last 10; total disk ceiling ~1 GB; `aegis netflow gc` (deferred to v2) for explicit cleanup |
| Aegis daemon binary itself is a new attack surface | Medium | Same cosign-keyless OIDC signing as genie binary; SLSA L3 provenance; cosign-verified before daemon launch; daemon code review at the highest bar |
| First-run install prompt's `Y` default coerces operators who don't want Aegis | Low | Default is opt-in, not auto-install; `n` is a single keystroke; install can be undone via `genie aegis uninstall` (forward-compatible CLI shape) |
| JSON-RPC schema incompatibility between aegis-cli and aegis-daemon if versions drift | Low | Schema versioned (v1); CLI checks daemon `daemon.status` response for matching `protocol_version`; mismatch refuses with helpful upgrade message |
| Genie hook layer modification breaks existing skill HTTPS behavior | Low | Aegis-detect runs only when socket exists; absent socket → unchanged genie behavior; integration test asserts no regression on Aegis-not-installed hosts |
| Operator on a corporate network where HTTPS_PROXY env var conflicts with company proxy | Low | Aegis prepends to proxy chain; documented in `SECURITY.md` corporate-deployment section; fallback: `aegis policy mode observe` + corporate proxy unchanged |

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
# NEW REPO: automagik-dev/aegis
Cargo.toml                                       create — workspace root
crates/aegis-daemon/Cargo.toml                   create
crates/aegis-daemon/src/main.rs                  create — tokio main loop, IPC, supervisor
crates/aegis-daemon/src/ipc.rs                   create — Unix socket JSON-RPC server
crates/aegis-cli/Cargo.toml                      create
crates/aegis-cli/src/main.rs                     create — clap parser + JSON-RPC client
crates/aegis-cli/src/cmds/                       create — per-subcommand modules
crates/aegis-protocol/Cargo.toml                 create
crates/aegis-protocol/src/lib.rs                 create — JSON-RPC types
crates/aegis-protocol/schemas/v1/                create — JSON-Schema files
crates/aegis-proxy/Cargo.toml                    create
crates/aegis-proxy/src/lib.rs                    create — TCP listener, SNI parser, splice
crates/aegis-proxy/src/sni.rs                    create — TLS ClientHello parsing
crates/aegis-proxy/src/hardcoded_allowed.rs      create — daemon outbound allowlist
crates/aegis-policy/Cargo.toml                   create
crates/aegis-policy/src/lib.rs                   create — YAML loader, evaluator, watcher
crates/aegis-policy/schemas/network-policy-v1.schema.json  create
crates/aegis-netflow/Cargo.toml                  create
crates/aegis-netflow/src/lib.rs                  create — append-only jsonl writer + rotator
crates/aegis-netflow/schemas/netflow-v1.schema.json        create
README.md                                        create
SECURITY.md                                      create
LICENSE                                          create — Apache 2.0
rust-toolchain.toml                              create — pin Rust + targets
.github/workflows/ci.yml                         create — build, test, lint
.github/workflows/release.yml                    create — matrix build + cosign + SLSA + CDN upload
docs/build.md                                    create — toolchain + cross-compile
docs/network-policy-defaults.md                  create — default allowlist rationale
docs/architecture.md                             create — daemon lifecycle + IPC + crate boundaries

# MODIFY: automagik-dev/genie (integration only)
src/lib/aegis-detect.ts                          create — socket detection + HTTPS_PROXY injection
src/lib/aegis-detect.test.ts                     create
src/lib/aegis-context.ts                         create — X-Aegis-Context header injection
src/lib/aegis-context.test.ts                    create
src/term-commands/aegis.ts                       create — `genie aegis` subcommand (proxies to aegis CLI)
src/term-commands/aegis.test.ts                  create
src/term-commands/install.ts                     modify — first-run Aegis prompt during `genie install`
src/genie.ts                                     modify — register `aegis` subcommand
scripts/integration/genie-with-aegis.sh          create — end-to-end test
scripts/integration/genie-install-with-aegis-prompt.sh  create — install-prompt path test
SECURITY.md                                      modify — link to aegis SECURITY.md + corporate-deployment notes
```
