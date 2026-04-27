# Brainstorm: Genie Security Roadmap, One MicroPR at a Time

| Field | Value |
|-------|-------|
| **Slug** | `security-roadmap-microprs` |
| **Date** | 2026-04-27 |
| **WRS** | 100/100 |
| **Board** | `Genie Security` (`board-321b2548`) |
| **Seed Wish** | `.genie/wishes/security-assessment-roadmap/WISH.md` |

## Current Intent

Build a dedicated Genie security program that produces real assessment findings and then hardens the product slowly, as small reviewable PRs. The board tracks the daily security queue; each microPR should reduce one measurable risk, add one guardrail, or turn an unknown into a documented assessment artifact.

## Scope Size Check

This spans multiple independent subsystems: package supply chain, release signing, local service exposure, shell/process execution, agent prompt/tool boundaries, filesystem persistence, database/task metadata, and documentation/runbooks. It should not become one monolithic wish. The right shape is an umbrella brainstorm/design plus many microPR wishes.

## Preliminary Findings

These are first-pass findings from direct repo inspection on 2026-04-27. They are actionable leads, not final exploit proofs.

### F1: Install-Time Network Execution Is a Supply-Chain Hotspot

- **Severity:** High
- **Evidence:** `package.json` runs `scripts/postinstall-tmux.js` on install. `scripts/postinstall-tmux.js` downloads a tmux tarball from GitHub and extracts it. `scripts/smart-install.js` can install Bun via `curl -fsSL https://bun.com/install | bash` or PowerShell `irm ... | iex`.
- **Risk:** A compromised network path, GitHub release asset, install script, or `GENIE_TMUX_URL` override could execute or install untrusted code during setup.
- **MicroPR:** Add checksum/signature verification for downloaded tmux assets and make remote install-script execution opt-in with a clear environment flag.
- **Validation:** Unit test rejects a tampered tmux tarball; install path prints manual instructions unless opt-in flag is present.

### F2: `GENIE_TMUX_URL` Is an Unsigned Binary Override

- **Severity:** High
- **Evidence:** `scripts/postinstall-tmux.js` and `src/lib/ensure-tmux.ts` allow `process.env.GENIE_TMUX_URL` to override the tmux download URL.
- **Risk:** Environment-controlled binary source is useful for testing, but dangerous in production install/update paths if no checksum pin or explicit unsafe acknowledgement is required.
- **MicroPR:** Gate custom tmux URLs behind `GENIE_TMUX_ALLOW_UNVERIFIED=1` and require a matching SHA256 env var for non-default URLs.
- **Validation:** Default URL still works; custom URL without SHA256 refuses; custom URL with wrong SHA256 refuses.

### F3: Local Worker Service Allows Cross-Origin Writes

- **Severity:** Medium/High pending confirmation
- **Evidence:** `plugins/genie/scripts/worker-service.cjs` binds to `127.0.0.1:48888` but responds with `Access-Control-Allow-Origin: *` and accepts POST updates to workflow state and admin restart.
- **Risk:** Localhost binding reduces exposure, but a browser page can still send requests to localhost services. With permissive CORS and no token/origin check, local workflow state mutation and restart may be reachable from hostile web content.
- **MicroPR:** Add a local bearer token or origin check for mutating endpoints; keep `/health` unauthenticated.
- **Validation:** POST without token returns 401; `/health` remains 200; existing CLI service calls pass with token.

### F4: Shell Command Construction Is Widespread and Needs an Inventory Gate

- **Severity:** Medium/High depending on call site
- **Evidence:** Many `execSync` string commands exist under `src/term-commands`, `src/lib`, and scripts. Examples include `src/term-commands/brain.ts` update/install flow, `src/term-commands/state.ts` git operations, `src/term-commands/agents.ts` tmux operations, and `src/lib/db.ts` process cleanup.
- **Risk:** Some calls quote values carefully, but the repo lacks a central inventory distinguishing safe static commands, quoted dynamic commands, and unsafe shell interpolation.
- **MicroPR:** Add `scripts/security/audit-shell.ts` that lists shell/process execution call sites and fails CI only for new unclassified call sites.
- **Validation:** Baseline file exists; adding a new `execSync(\`...\${x}...\`)` without metadata fails.

### F5: Agent Launch Uses `sh -c` for Provider Commands

- **Severity:** High pending source-of-command review
- **Evidence:** `src/term-commands/agents.ts` runs `spawnSync('sh', ['-c', ctx.launch.command], ...)`.
- **Risk:** If any untrusted profile/config/task data can reach `ctx.launch.command`, shell metacharacters become code execution. This may be intentional for configurable launchers, but it needs a narrow trust boundary and tests.
- **MicroPR:** Document the launch-command trust boundary and add validation/tests that untrusted task/wish/user input cannot modify `ctx.launch.command`.
- **Validation:** Tests cover profile-controlled command allowed; task title, agent name, wish slug, and workspace content cannot inject shell tokens into the launch command.

### F6: Brain Update Path Downloads and Extracts Release Tarballs Without Local Verification

- **Severity:** High
- **Evidence:** `src/term-commands/brain.ts` calls `gh release download`, replaces `BRAIN_DIR` with `rm -rf`, extracts a `.tgz`, then runs `bun install`.
- **Risk:** Authenticated GitHub access helps but does not replace local artifact verification. A compromised release, tag, or downloaded archive can execute install scripts after extraction.
- **MicroPR:** Verify brain release artifacts by digest or cosign/SLSA metadata before replacing `BRAIN_DIR` or running install.
- **Validation:** Tampered archive is rejected before `rm -rf`; valid artifact proceeds.

### F7: Auto-Approval Has Good Baseline Controls but Needs Drift Protection

- **Severity:** Medium
- **Evidence:** `src/lib/auto-approve.ts` normalizes whitespace, strips binary path prefixes, detects shell metacharacters, and has ReDoS-conscious regex matching.
- **Risk:** This is a strong control area, but it is critical enough that future changes need regression gates and review metadata.
- **MicroPR:** Add a security-control manifest for auto-approval invariants and require tests for new allow/deny behavior.
- **Validation:** Existing bypass tests remain; manifest check fails if auto-approve logic changes without a test/control entry.

### F8: Event Stream Token Enforcement Is Opt-In

- **Severity:** Medium
- **Evidence:** `src/term-commands/events-stream.ts` only requires `GENIE_EVENTS_TOKEN` when `GENIE_EVENTS_TOKEN_REQUIRED=1`; otherwise streams can run without token checks.
- **Risk:** This may be fine for local developer mode, but production/daemon mode needs an explicit default posture.
- **MicroPR:** Add `genie events doctor` or startup warning when streaming/event APIs run without token enforcement outside local test mode.
- **Validation:** Warning appears when token-required env is absent in daemon-like mode; tests can suppress it explicitly.

## MicroPR Roadmap Draft

1. **Board and Assessment Grounding**
   - Create `Genie Security` board.
   - Move tasks `#49` through `#54` to the board.
   - Add this brainstorm draft and keep findings evidence-linked.

2. **MicroPR 1: Install-Time Download Guard**
   - Board task: `#55`
   - Add checksum verification for tmux download path.
   - Refuse custom `GENIE_TMUX_URL` without SHA256.

3. **MicroPR 2: Worker Service Local Write Protection**
   - Board task: `#56`
   - Require token/origin check for local mutating endpoints.
   - Preserve unauthenticated health endpoint.

4. **MicroPR 3: Shell Execution Inventory**
   - Board task: `#57`
   - Add baseline shell/process execution inventory.
   - CI fails on new unclassified call sites.

5. **MicroPR 4: Agent Launch Trust Boundary**
   - Board task: `#58`; depends on `#57`
   - Document and test `ctx.launch.command` authority.
   - Prove untrusted task/wish/workspace values cannot alter provider launch shell.

6. **MicroPR 5: Brain Artifact Verification**
   - Board task: `#59`
   - Verify downloaded brain release artifacts before replacement/extraction/install.

7. **MicroPR 6: Auto-Approval Control Manifest**
   - Board task: `#60`
   - Lock down allow/deny invariants and require matching tests for changes.

8. **MicroPR 7: Event Token Posture Warning**
   - Board task: `#61`
   - Warn or fail in daemon-like contexts when event token enforcement is disabled.

## Decisions So Far

| Decision | Rationale |
|----------|-----------|
| Security work gets a dedicated board | Keeps security separate from ordinary feature backlog and makes slow hardening visible. |
| One microPR per risk/control | Smaller PRs are easier to review and safer to merge. |
| Findings start as evidence-linked leads | Avoids overstating exploitability before each risk gets a focused review. |
| CI gates should start as drift checks | Prevents new risk while avoiding a giant initial remediation branch. |

## Open Decision

Resolved: crystallize **MicroPR 1: Install-Time Download Guard** first, because install-time network execution is high-impact, relatively isolated, and easy to validate. Keep the rest of the microPR queue in triage until this first guard lands and teaches us the review cadence.

## Success Criteria for This Brainstorm

- [x] Dedicated board exists.
- [x] Existing assessment tasks are moved onto the board.
- [x] Preliminary findings have file-backed evidence and microPR actions.
- [x] First microPR is selected.
- [x] DESIGN.md is written for the first microPR.

## WRS

WRS: ██████████ 100/100
Problem ✅ | Scope ✅ | Decisions ✅ | Risks ✅ | Criteria ✅
