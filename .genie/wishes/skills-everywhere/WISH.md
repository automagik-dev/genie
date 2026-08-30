# Wish: skills-everywhere — Wish A: additive skills.sh channel + host retirement (no deletions)

| Field | Value |
|-------|-------|
| **Status** | IN_PROGRESS |
| **Slug** | `skills-everywhere` |
| **Date** | 2026-08-30 |
| **Author** | Felipe Rosa (orchestrated by Claude Fable 5) |
| **Appetite** | medium |
| **Branch** | `wish/skills-everywhere` |
| **Repos touched** | automagik-dev/genie (base `dev`) |
| **Design** | [DESIGN.md](../../brainstorms/skills-everywhere/DESIGN.md) |

## Summary

First of the three sequenced wishes under the `skills-everywhere` design (umbrella A → B → C; renamed from `codex-skill-installer` on 2026-08-30 — the contract is every agent, not Codex). Wish A ships the new skills channel and the host-side retirement **without deleting anything from the repo**: `genie install`/`update` run a pinned `npx skills add automagik-dev/genie@v<ver> --all --copy`, record what was installed, retire marker-owned legacy plugin assets on existing hosts backup-first, and `genie doctor` reports the new surface. Two new release smokes (`skills-install-smoke`, `release-update-path-smoke`) are added **alongside** the existing Codex dogfood matrix so they are proven on a real release before Wish B makes them the only gates. Lease/atomic-fs primitives are rehomed out of `agent-sync.ts` now so Wish B's deletion is mechanical.

## Scope

### IN

- `src/lib/skills-installer.ts`: pure argv builder for `npx -y skills@<PINNED> add automagik-dev/genie@v<version> --all --copy -g`, node/npx preflight, `run()` with an injected spawner, and reader/writer for `~/.genie/skills-install.json` (`{ref, cliVersion, inventory[], agentDirs[], installedAt}`; inventory = top-level `skills/*/SKILL.md` names from the release tag; `agentDirs` = entries of a genie-owned `KNOWN_AGENT_SKILL_HOMES` table — `codex: ~/.codex/skills`, `claude: ~/.claude/skills`, `cursor: ~/.cursor/skills`, plus the others the pinned CLI documents — filtered to those that exist after the install; the CLI has no `--json`, so its stdout is never parsed).
- One extracted helper `runSkillsChannelConvergence({selection, version})` (in `skills-installer.ts`: skills install → returns whether the record is fresh) called from exactly two seams: `runManualUpdateConvergence` (`update.ts:2824`), which the **new** binary executes in the `update --post-delivery-converge` child after promotion (`update.ts:1732` argv handoff), and `runPermittedPostDeliveryIntegrations` (`install.ts:349-380`) immediately before its `runSync(agentSyncSelection)` call — `install.ts` does not call `runManualUpdateConvergence`. So the pinned ref is always the freshly installed version. Order at the update seam: skills install → existing agent-sync (with the suppressed arms below) → retirement. At the install seam: skills install → `runSync` only — **no retirement call** (`runPermittedPostDeliveryIntegrations` is documented at `install.ts:344-348` as structurally excluding Codex marketplace/plugin/role state, and a fresh host has nothing to retire). Integration consent `none` skips the skills step; every other selection installs to all detected agents (Decision 3, an explicit contract change). A failed skills install prints the exact remedy command and sets exit code 1 — the promoted binary is never rolled back for it. `--sync-only` is **not** changed (its D2 contract at `update.ts:1792-1799` and the tests at `__tests__/update.test.ts:2860-3493` stay as they are).
- **Suppress the legacy writers once the record exists** (small flags in the existing `agent-sync.ts` arms, deleted with the file in Wish B): when `~/.genie/skills-install.json` is present **and its `ref` equals `v<VERSION>` of the running binary** (a stale record from an older version or a `none`-consent skip does not suppress), `syncClaude` skips the council stamp (`stampWorkflow`) and `syncClaudeAgentFiles`, `syncHermes` skips the link + `external_dirs` write, `syncPi` skips the extension link; each reports `suppressed (skills.sh channel active)`. Without this, retirement and agent-sync would fight over the same assets on every `update` (retire → re-create).
- `genie uninstall`: delete the recorded inventory skill dirs from the recorded agent dirs, then the record (deterministic; no dependency on the experimental lockfile).
- `src/lib/legacy-integration-retirement.ts`: one marker-scoped classifier + backup-first remover per legacy surface — Codex `[plugins."genie@automagik"]` table + `hooks.state` rows for `genie@automagik:*` + `~/.codex/plugins/cache/automagik/genie/*` generations; managed `~/.codex/agents/genie-*.toml`; Claude marketplace registration + cache for `genie@automagik`, `~/.claude/workflows/council.js` + `.genie-sync.json` sidecar, managed `~/.claude/agents/genie-*`, managed skill mirrors under `~/.claude/skills`; Hermes `external_dirs` link (marker `# genie:managed:skills.external_dirs`, `hermes-skills-config.ts:130`) + `mcp_servers.genie` block via the existing `retireMcpServersGenie` (`src/lib/hermes-mcp-config.ts`); pi extension link; legacy `.codex/skills/.curated`. The OTel exporter block is already migrated by `migrateDeadGenieOtel` on the same path (`runtime-integrations.ts:3684`) — not duplicated here. Global `~/.codex/config.toml` edits (the `[plugins."genie@automagik"]` table and `hooks.state."genie@automagik:*"` rows) go through a new `removeCodexPluginRegistration()` beside `setCodexPluginEnabled` in `runtime-integrations.ts` with a TOML round-trip test that preserves unrelated tables and comments — `codex-project-mcp.ts` (project-scoped `.codex/config.toml`, OUT) is not used. Only assets carrying a genie ownership marker/digest are removed; unmarked or modified assets are listed and left. Backups under `<GENIE_HOME>/state-backups/integration-retirement-<timestamp>/` (same convention as `legacy-v4.ts`). Compat window: assets written by any release ≥ `5.260711.6`.
- Wire retirement into `genie update` only, strictly last in `runManualUpdateConvergence` (after skills install and the suppressed agent-sync), under the lifecycle lease the update already holds. **Not** into `genie doctor --fix`: doctor is a lease-free read-only observer by test (`doctor.test.ts:2554-2557` forbids `acquireLifecycleLease` in `doctor.ts`); doctor only reports pending assets with the `genie update` remedy. Idempotent — a second run prints `nothing to retire` and changes no bytes.
- `genie doctor`: new checks `skills: <agent> <n>/<n> @ v<ver>` for each known agent home present on the host (`~/.codex`, `~/.claude`, `~/.cursor`, others the CLI names), "not detected" info for absent homes, warn + `genie update` remedy on missing/stale skills; `legacy integrations: retired | <n> marker-owned assets pending` check. Existing plugin checks stay untouched in Wish A (Wish B deletes them).
- Rehome from `agent-sync.ts`, moved not rewritten: `acquireLifecycleLease`, `acquireLifecycleLeaseWithWait`, `LifecycleLease`, `LifecycleLeaseSkip`, `lifecycleLockPath`, `LIFECYCLE_LEASE_OWNER_ENV`, `LIFECYCLE_LEASE_PATH_ENV` → `src/lib/lifecycle-lease.ts`; `publishRegularFileNoClobber`, `atomicRenameDirectoryNoClobber`, `resolveLinuxRenameat2`, `writeAllSync`, `fsyncPathForTest` → `src/lib/atomic-fs.ts`. Their describe blocks are **split out** of `src/lib/agent-sync.test.ts` (`:3801`, `:3869`, `:4023`, `:5498`, `:5524`, `:5644`) into the new test files. `agent-sync.ts` re-exports them for now; every consumer re-points: `install-promote.ts`, `setup.ts`, `ordered-lifecycle-leases.ts`, `install.ts`, `uninstall.ts`, `update.ts`, `runtime-integrations.ts:38`, `scripts/codex-plugin-only-smoke.ts`.
- Release workflow additions to `.github/workflows/release-publish.yml`, **added alongside** the Codex dogfood matrix and required by `publish` in this wish: `skills-install-smoke` (fresh `ubuntu` container with Codex + Claude Code CLIs present, production argv against `automagik-dev/genie@<candidate-sha>`, assert every inventory skill present per agent dir and byte-equal to `skills/`, one non-interactive `codex exec` invoking `$wish`) and `release-update-path-smoke` (download the `codex-dogfood-previous-release` artifact, install previous stable, `genie update` to the candidate on `linux-x64-glibc` natively and `linux-x64-musl` through `scripts/run-musl-dogfood.sh`, cosign/slsa-verifier verification via the existing steps, then `genie --version`, `genie task list --json`, `genie board --json`).
- CI (`ci.yml`): `skills-inventory-parity` step asserting `npx -y skills@<PINNED> add automagik-dev/genie@<sha> --list` names exactly `ls skills/*/SKILL.md` (design C6).
- Amendment notes: append to `.genie/brainstorms/genie-dual-mode-orca-plugin/DESIGN.md` and `.genie/wishes/genie-dual-mode-orca-plugin/WISH.md` a dated "Superseded clause" block stating that the "rehome supported hooks and role templates with parity fixtures" clause is superseded by `skills-everywhere` decision 2; MCP-retirement ownership unchanged.
- `docs/installation.mdx`: add the public two-line install (`genie update` + `npx skills add automagik-dev/genie`) as a section; full docs rewrite stays in Wish C.

### OUT

- Any deletion of plugin code, hooks, `agent-sync.ts` bodies, role profiles, council stamp, Kimi/Hermes/pi payloads, the Codex dogfood matrix, or `check` script surgery — **Wish B**, gated on this wish shipping stable and C3 proven on a real host.
- `scripts/version.ts --check`, toolchain rewrites (`build-binary.sh`, `release-payload-version.ts`, `release-guard.sh`, `build.js`) — Wish B.
- Skills-lint tokens, `work` skill wording, CLAUDE.md/AGENTS.md rewrite, genie-orca skill renames — **Wish C** (and the v6 merge).
- Orca plugin files and tests — untouched.
- MCP server / `.mcp.json` / `codex-project-mcp.ts` — owned by the dual-mode design.
- Project-scoped skill installs, skill signing, per-platform smoke matrix — deferred per the design.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Pin the skills CLI to `1.5.23` (the version verified 2026-08-30: `--list` on `@dev`, `@v5.260830.16`, `@v6/corpo-leve`) in one constant `SKILLS_CLI_VERSION` | Design decision 6; bumps are ordinary dependency PRs. |
| 2 | Inside `runManualUpdateConvergence` (new binary): skills install → agent-sync with suppressed writer arms → retirement, all under the update lease | A host must never pass through a state with neither plugin skills nor skills.sh skills; the writers must not undo retirement; the wiring point is the child, so the ref is the new version. |
| 3 | Consent semantics for skills: `none` → skip; `codex`/`claude`/`all`/`auto` → `--all` (all detected agents) — an explicit, accepted widening of the install-consent contract (`install.ts:330`) for skills only | User direction ("skills.sh already installs to all detected agents"); the pinned CLI does offer `-a <agents>`, so a consent-narrowed argv is possible and is the documented fallback if a user objects; consent still governs the plugin paths in Wish A. |
| 4 | Retirement is marker/digest-scoped, backup-first, never interactive; unmarked assets are reported and left | Design decision 8; same contract as `.codex/config.toml` route handling and `legacy-v4.ts`. |
| 5 | New smokes are added alongside, and required in addition to, the Codex matrix in this wish | They must be proven on a real release before Wish B makes them the only gate (design decision 9). |
| 6 | Lease/atomic-fs primitives move now with re-exports left in `agent-sync.ts` | Zero behavior change in A; Wish B deletes the re-exports with the file. |
| 7 | Doctor derives "detected agents" from present agent homes, not from the record alone | Design M9 resolution: an agent installed after genie must show as missing, not silently unreported. |
| 8 | `genie update` retiring the Codex plugin registration and role profiles is an accepted, deliberate deviation from the CLAUDE.md delivery-vs-activation owner rule (install/update never change Codex enabled state or write roles; `setup --codex` owns them) | The design sanctions update-side retirement. Known loop while `setup --codex` still ships in Wish A: running it after an update re-creates what was retired and the next update retires it again — harmless, idempotent, and gone with Wish B; Wish C rewrites the gotcha. |

## Simplicity Case

- **Simplest complete design:** one pinned `npx skills add` call + a JSON record + marker-scoped retirement + two smoke jobs.
- **Added machinery:** `skills-install.json` (doctor freshness, idempotent update); `legacy-integration-retirement.ts` (time-boxed: deleted two stable releases after Wish B); re-exports in `agent-sync.ts` (deleted in Wish B).
- **Deferred until measured:** project-scoped installs; skill signing; per-platform smokes; `skills-lock.json` use (experimental in 1.5.x).
- **Complexity removed (in this wish):** the interactive activation requirement is bypassed for skills — Codex/Claude sessions get skills without `setup --codex`; nothing else removed yet by design (A is additive).

## Dependencies

**depends-on:** none
**blocks:** none

_Wish B (`skills-everywhere-b`) and Wish C (`skills-everywhere-c`) are sequenced behind this wish by the design; they declare `depends-on: skills-everywhere` when authored._

## Success Criteria

- [ ] C1 Fresh host (no `~/.agents`/`~/.claude` skills), non-interactive `genie install` from the release tarball: every inventory skill present under `~/.agents/skills/` (the home Codex reads — skills.sh 1.5.23 never creates `~/.codex/skills`; amended 2026-08-30 from Group 5's empirical finding) and `~/.claude/skills/`, byte-equal to the tag's `skills/`; `~/.genie/skills-install.json` records the tag, CLI version, inventory and agent dirs; `codex exec` can invoke `$wish`.
- [ ] C2 `genie update` to a newer version re-installs pinned to the new tag with zero prompts; `genie doctor` prints `skills: agents <n>/<n> @ v<ver>` and `skills: claude <n>/<n> @ v<ver>` (wording amended at closure: skills.sh 1.5.23 serves Codex via `~/.agents/skills`), "not detected" for absent homes.
- [x] C3 Real dogfood host (khal-labs, currently on stable 5.260830.16 with the Codex plugin generation, Claude marketplace plugin, council stamp, 7 role agents and the Hermes link present): `genie update` retires every marker-owned asset backup-first, lists unmarked ones, and each skill name appears once per agent; evidence file committed under `.genie/wishes/skills-everywhere/qa/`.
- [x] C4 `bun test src/lib/lifecycle-lease.test.ts src/lib/atomic-fs.test.ts` pass in the new homes; all eight consumers (`install-promote.ts`, `setup.ts`, `ordered-lifecycle-leases.ts`, `install.ts`, `uninstall.ts`, `update.ts`, `runtime-integrations.ts`, `scripts/codex-plugin-only-smoke.ts`) import from them. Proof (import-shape agnostic): in a scratch commit on the group branch, delete the re-export lines from `agent-sync.ts` and run `bun run typecheck` — it must be green; the PR records that commit SHA. `bun run check` green on the real head.
- [ ] C5 A release-candidate run of `release-publish.yml` shows `skills-install-smoke` and `release-update-path-smoke` green and listed in `publish.needs`; the Codex dogfood matrix still runs and passes.
- [x] C6 `ci.yml` `skills-inventory-parity` fails when a skill dir is added without a top-level `SKILL.md` or when a nested SKILL.md is introduced (negative test on a throwaway branch recorded in the PR).
- [x] C7 The dual-mode WISH.md carries the dated supersession block (the DESIGN.md append was dropped during execution: `design-review-evidence.mjs` hashes the whole file minus the evidence block, so any append would invalidate its SHIP digest and only a fresh design review could re-stamp it — recorded 2026-08-30); `bun run wishes:lint` green.
- [ ] C8 (open — QA on the next fresh-host pass) `genie uninstall` on a host installed by C1 leaves no inventory skill dir in any recorded agent dir and no record; foreign skills in the same dirs untouched.

## Execution Strategy

### Wave 1 (parallel)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 1 | engineer | 4 — stateful (+2: record file, install/update ordering), multi-package (+1: install/update/uninstall commands), CI/release adjacent (+1) | `engineer-complex` / high | `skills-installer.ts` + wiring into install/update/uninstall |
| 4 | engineer | 2 — stateful lease semantics (+2), deterministic tests exist (0) | `engineer-standard` / medium | Rehome lease + atomic-fs primitives out of `agent-sync.ts` |
| 6 | engineer | 1 — docs/amendment only (+1 prompt/doc change) | `engineer-trivial` / low | Dual-mode supersession blocks + installation.mdx section |

### Wave 2 (parallel, after Group 1)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 2 | engineer | 6 — stateful (+2), subjective acceptance on "marker-owned" edge cases (+2), prior rework in this area (+1), no deterministic test for real-host layout (+1) | `engineer-complex` / high | `legacy-integration-retirement.ts` + update wiring + writer-arm suppression |
| 3 | engineer | 3 — stateful read of record + agent homes (+2), multi-file doctor (+1) | `engineer-standard` / high | Doctor skills + retirement checks |
| 5 | engineer | 5 — CI/release (+1), orchestration of jobs/artifacts (+2), no local deterministic test (+1), multi-file workflows (+1) | `engineer-complex` / high | `skills-install-smoke`, `release-update-path-smoke`, `skills-inventory-parity` |

### Wave 3 (sequential)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 7 | qa | 3 — real-host stateful (+2), subjective evidence (+1) | `engineer-standard` / high | C3 real-host dogfood after the first dev release containing Groups 1–6; evidence under `qa/` |

## Execution Groups

### Group 1: skills installer + install/update/uninstall wiring

**Goal:** `genie install`/`update` install the release-tag skills through skills.sh and record it; `genie uninstall` removes exactly what was recorded.

**Deliverables:**
1. `src/lib/skills-installer.ts` (+ `.test.ts`): `SKILLS_CLI_VERSION = '1.5.23'`, `buildSkillsAddArgv({version, sha?})`, `preflightNode()`, `runSkillsInstall({spawn})`, `readSkillsInstallRecord()`, `writeSkillsInstallRecord()`, `inventoryFromSkillsDir(root)`; fake-`npx` shim tests for argv, record shape, failure remedy text, `none` consent skip.
2. `runSkillsChannelConvergence` called from `runManualUpdateConvergence` (`update.ts:2824`, the post-delivery child) and from `runPermittedPostDeliveryIntegrations` (`install.ts:349-380`) before `runSync`; exit 1 with remedy on failure; `--sync-only` untouched (D2 contract).
3. `uninstall.ts`: inventory-dir deletion from recorded agent dirs + record removal; foreign files untouched (test).

**Acceptance Criteria:**
- [ ] Argv is exactly `npx -y skills@1.5.23 add automagik-dev/genie@v<ver> --all --copy -g` (snapshot test).
- [ ] Record written only after a zero exit; failure path prints the remedy command and sets exit 1 without touching the promoted binary.
- [ ] Uninstall removes only recorded inventory dirs (tmp-home test with a foreign skill present).

**Validation:**
```bash
bun test src/lib/skills-installer.test.ts src/genie-commands/install.test.ts src/genie-commands/__tests__/update.test.ts src/genie-commands/uninstall.test.ts && bun run typecheck && bun run lint
```
Scope: focused behavior tests on the changed modules plus type/lint for the command boundaries they cross; the full gate runs at the wish level.

**depends-on:** none

---

### Group 2: legacy integration retirement

**Goal:** Existing hosts lose every marker-owned plugin-era asset on `genie update`, backup-first, idempotently.

**Deliverables:**
1. `src/lib/legacy-integration-retirement.ts` (+ `.test.ts`): `classifyLegacyIntegrations(homes) → {surface, path, state: managed-clean|managed-modified|unmanaged}` and `retireLegacyIntegrations(report, {backupRoot}) → {removed[], kept[], backupRoot}` with one classifier per surface listed in Scope IN; tmp-home fixtures for each surface in clean/modified/unmanaged states.
2. Wiring: last step of `runManualUpdateConvergence` after a successful skills install — update seam only, never the install seam; output lines `retired <surface>: <path>` / `kept (unmanaged) <surface>: <path>` / `nothing to retire`.
3. Writer-arm suppression in `agent-sync.ts` (`syncClaude` council stamp `stampWorkflow:5007` + `syncClaudeAgentFiles:4583`, `syncHermes:5738`, `syncPi:5953`): keyed on a fresh record (`ref == v<VERSION>`), each arm reports `suppressed (skills.sh channel active)`. Existing `agent-sync.test.ts` describes that assert the writers fire (`:343` claude agent fan-out, `:2264` hermes linking, `:2347` hermes config, `:2547` stampWorkflow parity) keep their tmp homes **record-free** — that invariant is stated in a comment at the top of the file — and two new describes cover record-present → suppressed / stale-record → fires.
4. Global `~/.codex/config.toml` edits through `removeCodexPluginRegistration()` (new, beside `setCodexPluginEnabled`, TOML round-trip test); Claude `settings.json`/`installed_plugins.json` edits are JSON round-trips preserving unknown keys; Hermes via `retireMcpServersGenie` + the `external_dirs` marker.

**Acceptance Criteria:**
- [ ] Each surface fixture: managed-clean → removed + backed up; managed-modified and unmanaged → kept and listed.
- [ ] Second run on the same home prints `nothing to retire` and changes no bytes.
- [ ] A host fixture with all surfaces present ends with zero duplicate skill names across `~/.codex/skills`, `~/.claude/skills`, and the plugin caches.
- [ ] Pipeline idempotence: run the full `runManualUpdateConvergence` twice on the all-surfaces fixture with a fresh record → second run prints `nothing to retire`, every writer arm prints `suppressed`, and no bytes change under the fixture home; with a stale record (older `ref`) the writers fire and retirement is skipped.

**Validation:**
```bash
bun test src/lib/legacy-integration-retirement.test.ts src/lib/agent-sync.test.ts src/genie-commands/__tests__/update.test.ts src/genie-commands/doctor.test.ts && bun run check
```
Scope: this group mutates user config files across agents — repository full gate plus the focused fixtures.

**depends-on:** 1

---

### Group 3: doctor skills + retirement surface

**Goal:** `genie doctor` tells the truth about skills per detected agent and about pending legacy assets.

**Deliverables:**
1. `checkSkillsChannel()` in `doctor.ts`: per known agent home present → `skills: <agent> <n>/<n> @ v<ver>` (pass) / `<n>/<total>` (warn, remedy `genie update`); absent home → info `not detected`; no record → warn.
2. `checkLegacyIntegrations()`: `retired` (pass) or `<n> marker-owned assets pending` (warn, remedy `genie update`).
3. `--json` fields `checks[].skillsChannel.{agent,present,total,ref}` and `checks[].legacyIntegrations.pending[]`.

**Acceptance Criteria:**
- [ ] Fixture with `~/.codex` + `~/.claude` present and a complete record → two pass lines; remove one skill → warn with `genie update`.
- [ ] Fixture with no `~/.cursor` → `not detected` info, never warn.

**Validation:**
```bash
bun test src/genie-commands/doctor.test.ts && bun run typecheck && bun run lint
```
Scope: doctor is read-only; focused tests plus type/lint suffice.

**depends-on:** 1

---

### Group 4: rehome lifecycle lease + atomic-fs primitives

**Goal:** The primitives Wish B must keep live outside `agent-sync.ts` with zero behavior change.

**Deliverables:**
1. `src/lib/lifecycle-lease.ts` + `src/lib/atomic-fs.ts` with the symbols listed in Scope IN, moved verbatim; the six describe blocks split out of `agent-sync.test.ts` into `lifecycle-lease.test.ts` / `atomic-fs.test.ts` unchanged.
2. `agent-sync.ts` re-exports the moved symbols; all eight consumers listed in Scope IN import from the new modules.

**Acceptance Criteria:**
- [ ] `git diff -M --stat` on the source files shows only removed/added blocks that are byte-identical (reviewer checks with `git diff --color-moved=dimmed-zebra`); test count in `agent-sync.test.ts` + the two new files equals today's total.
- [ ] Concurrent-writer lease tests pass unchanged in the new file.

**Validation:**
```bash
bun test src/lib/lifecycle-lease.test.ts src/lib/atomic-fs.test.ts src/lib/agent-sync.test.ts src/genie-commands/install-promote.test.ts && bun run typecheck && bun run dead-code
```
Scope: pure move; type + dead-code catch a broken re-export, focused tests catch behavior drift.

**depends-on:** none

---

### Group 5: release and CI smokes

**Goal:** The two future-only gates run on real release candidates now, and CI guards the skills inventory contract.

**Deliverables:**
1. `release-publish.yml`: `skills-install-smoke` and `release-update-path-smoke` jobs as specified in Scope IN, both in `publish.needs`; reuse the `codex-dogfood-previous-release` artifact and the existing cosign/slsa-verifier steps; the musl leg goes through `scripts/run-musl-dogfood.sh`.
2. `scripts/workflow-yaml-parse.test.ts`: parses both workflows with `Bun.YAML` (present on bun 1.3.14 locally; `Bun.YAML` shipped before 1.3, so the CI-pinned 1.3.11 has it — Group 5 confirms on its first CI run) and asserts `publish.needs` contains both smoke jobs (no python/PyYAML dependency).
3. `ci.yml`: `skills-inventory-parity` step (`npx -y skills@1.5.23 add automagik-dev/genie@$GITHUB_SHA --list` names == `ls skills/*/SKILL.md`; runs as its own job, not inside the network-free `unit` job), plus a fixture-based unit test of the comparison script in `scripts/skills-inventory-parity.test.ts`.
4. Evidence: link to one green release-candidate run in the PR; negative-test run for C6 on a throwaway branch.

**Acceptance Criteria:**
- [ ] Both smokes green on a dev-channel release candidate; `publish` waits on them.
- [ ] Inventory parity fails on a nested-SKILL.md fixture and on a dir without SKILL.md.

**Validation:**
```bash
bun test scripts/skills-inventory-parity.test.ts scripts/workflow-yaml-parse.test.ts && bun run check
```
Scope: CI/release work → repository full gate plus YAML parse and the unit-tested comparison; the real proof is the linked candidate run.

**depends-on:** 1

---

### Group 6: supersession notes + install docs section

**Goal:** The dual-mode design/wish and the public install docs reflect the new channel.

**Deliverables:**
1. Dated `## Superseded clause (2026-08-30, skills-everywhere)` block appended to `.genie/brainstorms/genie-dual-mode-orca-plugin/DESIGN.md` **below** its review-evidence block (never inside it) and to `.genie/wishes/genie-dual-mode-orca-plugin/WISH.md` under `## Review Results`.
2. `docs/installation.mdx`: "Skills for any agent" section with `npx skills add automagik-dev/genie` and the `genie update` pairing. Sequence per CLAUDE.md: `git submodule update --init .docs-vendor` (it is uninitialized in fresh checkouts), branch inside `.docs-vendor`, docs PR to `automagik-dev/docs`, then a superproject pointer bump commit in this wish's branch after the docs PR merges.

**Acceptance Criteria:**
- [ ] `bun run wishes:lint` green; the dual-mode design's review evidence still verifies (DESIGN.md untouched — see C7 note).
- [ ] Mintlify docs-lint green on the `automagik-dev/docs` PR (the repo-local `lint:docs-links`/`lint:docs-markdown` scripts only cover `SECURITY.md` and the canisterworm runbook, so they are not evidence for this file); docs PR merged and pointer bumped.

**Validation:**
```bash
bun run wishes:lint && node skills/brainstorm/references/design-review-evidence.mjs verify .genie/brainstorms/genie-dual-mode-orca-plugin/DESIGN.md && git submodule update --init .docs-vendor && test -f docs/installation.mdx && grep -q 'npx skills add automagik-dev/genie' docs/installation.mdx
```
Scope: documentation-only group → lint, link, and evidence-digest checks. Ordering: the design-evidence `verify` link passes only after the design's digest is stamped for its current content (done 2026-08-30 after the rename — `fafaef24…`); any later design edit re-blocks this chain until a fresh review re-stamps it.

**depends-on:** none

---

### Group 7: real-host dogfood (C3)

**Goal:** Prove retirement and the skills channel on the host that currently carries every legacy surface. **Post-merge by construction:** this group needs a dev release containing Groups 1–6, so the wish merges with Group 7 open; the execution review verdict gates on Groups 1–6, and Group 7's evidence is the stated pre-condition for Wish B (not for this wish's merge).

**Deliverables:**
1. On khal-labs after the first dev release containing Groups 1–6: `(umask 022 && genie update --dev --yes)`; capture `genie doctor --json` before/after, the retirement lines, `ls ~/.codex/skills ~/.claude/skills`, `~/.codex/config.toml` diff, and one `codex exec` invoking `$wish`.
2. `.genie/wishes/skills-everywhere/qa/real-host-20260XXX.md` with the evidence and the backup root path.

**Acceptance Criteria:**
- [ ] Every C3 assertion holds; any kept-unmanaged asset is explained.

**Validation:**
```bash
f=$(ls .genie/wishes/skills-everywhere/qa/real-host-*.md | tail -1) && test -f "$f" && grep -q "nothing to retire" "$f"
```
Scope: evidence-file existence plus the idempotence line from the second run; the substance is reviewed by the execution review.

**depends-on:** 1, 2, 3, 5

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] Fresh container: `genie install` from the dev tarball → skills present for Codex and Claude, doctor pass lines, `codex exec` `$wish` works (C1).
- [ ] khal-labs host: `genie update --dev` retires the Codex plugin generation, Claude plugin, council stamp, role agents, Hermes link; second run says `nothing to retire` (C3).
- [ ] Existing behavior: board/task commands, Orca plugin ref parity, Omni runner unchanged; the Codex dogfood matrix still green on the same release.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| skills.sh `--all` detection differs between the CI container and real hosts | Medium | `skills-install-smoke` asserts per-agent-dir presence for every `KNOWN_AGENT_SKILL_HOMES` entry whose CLI is installed in the container; doctor compares present homes against the inventory, not the record alone. |
| Retirement misclassifies a user-modified asset as managed | High | Digest + marker required for removal; modified → kept; backups for everything removed; fixtures per surface. |
| Update-path smoke flakes on artifact download or Sigstore TUF (seen 2026-08-30) | Medium | Reuse the existing retry/verify steps; smoke failure blocks publish exactly like the matrix does today. |
| Host has neither node nor npx | Low | Preflight with actionable error; binary already promoted; `genie update` re-runs the skills step next time. |
| Wish B starts before C3 is proven | High | C3 evidence file is a stated pre-condition in Wish B; Group 7 is a wave of its own and post-merge. |
| Legacy writers re-create what retirement removed | High | Writer arms suppressed when the install record is present **and** `ref == v<VERSION>`; retirement runs last; Group 2 pipeline-idempotence AC on a full-surface fixture. |
| Retirement mutates agent config without a lease | High | Retirement lives only in `runManualUpdateConvergence` under the update lease; doctor stays read-only. |
| `--all` writes skills into an agent home the user excluded by consent | Low | Explicit contract change (Decision 3); `-a` fallback documented; skills are inert files. |
| User runs `setup --codex` after an update (re-creates retired plugin/roles until Wish B) | Low | Decision 8; retirement is idempotent; doctor shows `pending` again with the `genie update` remedy. |
| New network dependency in CI (`npx skills`) | Low | Own job with retry; `unit` job stays network-free. |

---

## Review Results

_The read-only reviewer returns evidence; the invoking orchestrator appends a timestamped block here after plan, execution, and PR reviews._

### Execution note — 2026-08-30 — Group 6 spec deviation (orchestrator)
- Engineer reported `blocked` on deliverable 1: appending below `<!-- genie-design-review:end -->` still changes the reviewed digest (`reviewableDesign()` = whole file minus the block). Diagnosis: `ambiguous-spec` in the plan, not an engineering failure; no fix loop consumed.
- Decision: drop the DESIGN.md append; the supersession block in `.genie/wishes/genie-dual-mode-orca-plugin/WISH.md` is the amendment of record. C7 and Group 6 acceptance amended accordingly. Docs PR: https://github.com/automagik-dev/docs/pull/79 (superproject pointer bump after it merges).

### Execution review — 2026-08-30 — Group 6 — FIX-FIRST (round 1)
- Reviewer: genie:reviewer (session e7edce9e/aba6cdd6), engineer ≠ reviewer.
- HIGH: `installation.mdx` shows `npx skills add automagik-dev/genie` as machine-wide — verified project-scoped without `-g --all` (docs PR 79 already merged by a maintainer). MEDIUM: section contradicts Group 1 (`genie update` runs the install itself). MEDIUM: supersession block quotes a Scope IN clause that exists in no `dev` revision of the dual-mode documents (originated as a paraphrase in the skills-everywhere DRAFT). LOW: block is a sibling `##`; submodule pointer at PR head rather than docs `main`. Info for Wish C: the Claude marketplace bootstrap step on the same page.
- Passed: DESIGN.md untouched + verify exit 0; scope exactly three paths; `wishes:lint` green.
- Route: fix loop 1 (fixer) — docs follow-up PR with `-g --all` + reworded section; supersession block reworded as paraphrase, nested `###`.

### Execution review — 2026-08-30 — Group 6 — SHIP (after 2 fix loops)
- Reviewer: genie:reviewer (session e7edce9e/aba6cdd6). Loop 1: docs PR https://github.com/automagik-dev/docs/pull/80 (`-g --all`, project-scope explanation, `genie update` relationship); supersession block paraphrased and nested. Loop 2: version-qualified future tense for the `genie update` behavior, `--all` = `--skill '*' --agent '*' -y`, Eve/PromptScript skip. Reviewer re-ran the empirical probe: `-g --all` in an isolated HOME → 0 cwd files, 57 agent skill dirs × 22 skills.
- Validation (orchestrator): `bun run wishes:lint` OK (80 files); dual-mode DESIGN verify exit 0; `docs/installation.mdx` contains the command.
- Open mechanical items (not engineering): merge PR 80 (human maintainer, outward-facing), then `git submodule update --remote .docs-vendor` and commit the pointer; nit applied post-review: version placeholder replaced by a `genie doctor` self-check sentence.
- Docs PR 80 merged 2026-08-30; `.docs-vendor` pointer bumped to docs `main` (`git submodule update --remote`); `genie task done t_mtg14vxr224f5565`.

### Execution review — 2026-08-30 — Group 4 — SHIP
- Reviewer: genie:reviewer (session e7edce9e/a2accf20), engineer ≠ reviewer. Verbatim-move proof both directions (14 removed blocks → 12 byte-identical, 1 import edit, 1 block split piecewise across both files, all identical); no public symbol lost; no import cycle (`atomic-fs` ← `lifecycle-lease` ← `agent-sync`); singletons moved once; completeness proof reproduced (re-exports deleted → only four test files fail: `__tests__/update.test.ts`, `install-promote.test.ts`, `install.test.ts`, `setup.test.ts` — re-pointed by their owning groups or Wish B); test parity 240 = 212+13+15 (engineer's per-file split 22/9 was misreported; totals 270 pass / 1212 expect correct).
- Quality pass folded into the execution review (pure move: cycles, singleton duplication, knip `/** @public */` precedent at `codex-activation-executor.ts:112`, `v5/global-db.ts:27`, `v5/genie-db.ts:27` all checked); `bun run build` also green.
- Validation (orchestrator): `bun test lifecycle-lease/atomic-fs/agent-sync/install-promote` → 284 pass / 0 fail; `bun run typecheck` OK; `bun run dead-code` clean.
- Scope note for Wish B: ~18 file-private leaf helpers moved down with the 12 named symbols (`acquireFileLock`, `tryInitializeFileLock`, `lockHasLiveOwner`, `lockOwnerIsLive`, `parseLockOwner`, `processStartIdentity`, `sleepSyncMs`, `isStaleOrInvalidLockTime`, `currentSyncLockHostId`, `lstatSafe`, `statSafe`, `rmSyncSafe`, `readTrimmed`, `fsyncPath`, `probeLinuxRenameat2`, `resolveDarwinRenameExclusive`, `selectedNoClobberPlatform`, `ManagedArtifactConflictError`, `NoClobberPublishError`, `publishDirectoryViaNameClaim`) — necessary to avoid a back-import cycle. `computeDirDigest` (used by doctor, runtime-integrations, two scripts, and `atomic-fs.test.ts`) still lives in `agent-sync.ts` and must be rehomed by Wish B.
- `genie task done t_mtg14vn5e0de4dc8`.

### Execution review — 2026-08-30 — Group 1 — FIX-FIRST (round 1)
- Reviewer: genie:reviewer (session e7edce9e/af3f3f9a), engineer ≠ reviewer. All ten contract clauses verified (argv byte-exact + real-spawn proof, record-after-zero-exit, inventory/agentDirs sources, consent `none` skip with decision-3 citation, never-throws, `--sync-only` untouched with a source-scan guard, uninstall record-driven with foreign-skill test). Spawn safety via `runBoundedIntegrationCommand` (no shell, argv, detached group, output cap); zod traversal rejection proven at unit and uninstall level; tests deterministic (npx shim on PATH).
- MEDIUM: skills failure exit 1 overwritten to 2 by `applyConvergenceExitSignal` when a Codex activation is pending (result discarded at `update.ts:2852`). LOW ×8: empty inventory recorded as success; record read lacks the physical-file guard; duplicated skill-name regex; `agentDirs` only checked absolute; channel runs on no-op update paths (accepted — decision 2); `describeFailure` stdout shadows stderr; staging-file leak / no dir fsync; explicit `--integrations` failure throws before the skills step (judged acceptable — loud, fresh-host path unaffected).
- Validation (orchestrator): 402 pass / 0 fail; typecheck clean; lint = 3 pre-existing warnings only.
- Route: fix loop 1 (fixer) — MEDIUM + LOWs 1–4, 6, 7; no-op-path and ordering LOWs accepted as contract.

### Execution review — 2026-08-30 — Group 1 — SHIP (after 1 fix loop)
- Reviewer: genie:reviewer (session e7edce9e/af3f3f9a). MEDIUM closed: `ManualUpdateConvergenceResult.skills` surfaced; `applyConvergenceExitSignal` returns 1 on a failed skills install before the action-required 2 (`__tests__/update.test.ts` reconstructs the masking combination; parent still throws on child status 1). All seven LOWs resolved; `agentDirs` table-membership deliberately kept at point-of-use with recorded reasoning.
- Validation (orchestrator re-run): 416 pass / 0 fail / 1434 expects; typecheck clean; lint = 3 pre-existing; knip clean.
- Cross-group note for G4's ledger: `fsyncPath` (module-private in `agent-sync.ts` at HEAD) is now exported from `atomic-fs.ts` so `skills-installer.ts` can consume it — a deliberate one-symbol widening of G4's verbatim-move contract, body unchanged.
- `genie task done t_mtg14v70f2fb54ba`. Wave 1 checkpointed as a commit on `wish/skills-everywhere`.

### Execution review — 2026-08-30 — Group 3 — FIX-FIRST (round 1)
- Reviewer: genie:reviewer (session e7edce9e/ab014b35), engineer ≠ reviewer. Contract met line-for-line; zero new complexity (27/37 hotspots unchanged); tests isolated.
- HIGH: `await import(LEGACY_RETIREMENT_MODULE)` (non-literal) is not bundled by `bun build` even once the module exists — reviewer proved with an isolated build that the shipped `dist/genie.js` always reports `legacy integrations — classifier unavailable` (pass), i.e. a silent pass masking pending assets; no gate runs `dist/`. MEDIUM-1: the `classifier unavailable` test breaks when G2 lands and invites the wrong repair. MEDIUM-2: record-less host gets a green `@ v<binary>` provenance line. LOW: `HOME=''` falls to cwd (`??` vs `||`); `existsSync` vs `isDirectory` detection; `--json` rider missing on the unavailable path.
- Validation (orchestrator): 158 pass / 0 fail; typecheck clean; lint unchanged.
- Route: fix loop 1 (fixer) after Group 2's module lands — inline the literal specifier, add a source-lock + import guard test, rewrite the unavailable test around an injected null seam, MEDIUM-2 `(unrecorded)` rendering, LOWs.

### Execution note — 2026-08-30 — Group 5 cross-group finding (orchestrator)
- `skills@1.5.23 --all --copy -g` creates `.claude/skills`, `.agents/skills`, `.config/goose/skills`, `.codeium/windsurf/skills` (+53 others) but never `~/.codex/skills` or `~/.cursor/skills`; Codex reads `~/.agents/skills`. C1 amended above. Follow-up assigned to the Group 3 fix loop (touches `KNOWN_AGENT_SKILL_HOMES` in `skills-installer.ts` and doctor's per-agent lines): drop/re-map the `codex` and `cursor` rows so doctor never emits a false `0/N` warn on a Codex host.
- `release-update-path-smoke` cannot run a networked `genie update` before publish (no manifest/release yet): it swaps generations the way the dogfood harness's `installGeneration` does and verifies both N and T with cosign/SLSA + evidence pack + `--version` + task/board; a true networked N→T update is only possible post-publish (recorded as a Wish B candidate). `codex exec` leg is secret-gated on `OPENAI_API_KEY`, which this repo does not have — file-level byte-equality is the unconditional gate.

### Execution review — 2026-08-30 — Group 5 — FIX-FIRST (round 1)
- Reviewer: genie:reviewer (session e7edce9e/a8d670a3), engineer ≠ reviewer. Static wiring verified end-to-end (artifact names vs producers, outputs, flat tarball layout, SHA-pinned actions, actionlint+shellcheck clean on new blocks); `inputs.source_sha` checkout correct; parity job outside `quality-gate` matches repo convention; skills.sh 1.5.23 `~/.agents/skills`-not-`~/.codex/skills` finding confirmed from the on-disk barehome probe; whole-skill-tree copy verified byte-equal (`diff -rq` empty).
- HIGH-1: acceptance (green candidate run) is unprovable pre-merge while both jobs already sit in `publish.needs` — orchestrator decision: keep required per plan decision 5; the dev-channel candidate that fires on merge is the proof and precedes any stable dispatch; recorded as post-merge acceptance like Group 7. MEDIUM-1: update-path job duplicates earlier gates — fix: add `update --publish-local-delivery` exercise per harness. MEDIUM-2: secret at job env. MEDIUM-3: byte-equality on SKILL.md only, not the tree. MEDIUM-4: literal platform matrix (release-docs.test.ts forbids as promotion evidence). LOW-1..6: retry, YAML-guard test structure, `endsWith` over-match, symlink handling, N-capabilities comment, false Claude-CLI comment.
- Validation (orchestrator): 33 pass / 0 fail; typecheck; lint unchanged.
- Route: fix loop 1 (fixer) — all MEDIUM + LOW.

### Execution review — 2026-08-30 — Group 5 — SHIP (after 1 fix loop)
- Reviewer: genie:reviewer (session e7edce9e/a8d670a3). All eight findings closed with reproduced evidence: `release-update-path-smoke` now exercises `update --publish-local-delivery` on a Codex-free host (unique coverage — the Codex matrix only runs it with a fake codex + pre-seeded plugin cache), trailer schema asserted; secret scoped to the codex exec step only; whole-tree `diff -r --no-dereference`; matrix derived from the manifest projection with a 2-entry refusal; retries; YAML-guard test runs; basename anchor; symlinks fail closed; comments corrected. Both legs re-proven locally on real N=5.260830.16→T=5.260830.19 (delivery-record artifacts on disk, incl. musl through the real adapter).
- Residual INFO: trailer grep robustness nit; parity job advisory until added to branch protection. HIGH-1 (green live candidate run) = recorded post-merge acceptance: the dev-channel candidate that fires on merging this wish is the proof and precedes any stable dispatch.
- Validation (orchestrator): 85 pass / 0 fail post-fix; typecheck clean; lint 0 errors.
- `genie task done t_mtg14vsi44350a36`.

### Execution review — 2026-08-30 — Group 2 — FIX-FIRST (round 1)
- Reviewer: genie:reviewer (session e7edce9e/a47fcdd6), engineer ≠ reviewer. Contract met on 12 of 13 clauses; symlink/traversal probes clean at every removable surface (planted managed-looking assets behind symlinks → all kept, targets byte-identical); no-TDZ proof across the 7-module cycle (130 exports dereferenced); role-agent inventory + bare-name mirror decisions upheld.
- MEDIUM-1: removers' `unchanged` status discarded → phantom `retired` lines + fresh backup dirs every update (two repros; breaks AC2). MEDIUM-2: backups not fsynced before unlink (module's own safety story). MEDIUM-3: `known_marketplaces.json` automagik entry + `settings.json` enabledPlugins survive → `inspectRuntimeIntegrationEvidence` still says installed; enabled-but-uninstalled Claude plugin — treated as a scope gap vs the wish's registration clause, fixed as two new surfaces. LOW-1..5 recorded (empty family dirs; misleading summary on failures; TOML multi-line strings; sidecar-less advisory; line-anchored SCAN_EXEMPTIONS → follow-ups).
- Validation (orchestrator): 474 + 110-filtered pass; typecheck/lint/knip clean on G2 files.
- Route: fix loop 1 (fixer) — M1, M2, M3(+LOW-1), LOW-2.

### Execution review — 2026-08-30 — Group 2 — SHIP (after 1 fix loop)
- Reviewer: genie:reviewer (session e7edce9e/a47fcdd6). Both MEDIUM-1 repros now tests (kept-not-removed, `nothing to retire`, zero backup dirs, byte-identical config); backup-before-remove ordering proven via the `onBeforeRemove` seam; MEDIUM-3 symptom gone — `inspectRuntimeIntegrationEvidence` flips `{codex:true,claude:true}` → `{codex:false,claude:false}` after one retirement (15 surfaces incl. `claude-marketplace-registration` with source-containment ownership and `claude-enabled-plugin` one-key removal); marketplace ownership matrix probed (git/dev/traversal/symlink shapes all kept); backup-prune isolation probed (shared-path, mixed-run, sibling-generation cases). Reviewer gate: 482 + 110-filtered + 162 doctor pass; lint 0 errors; build green.
- Follow-ups (non-blocking, for Wish B / later): LOW-6 `writeJsonDocument` in-place write on user JSON (durable backup mitigates); lexical containment vs realpath (fails closed); sidecar backup discard comment; TOML multi-line strings; sidecar-less advisory; stable-token SCAN_EXEMPTIONS.
- `genie task done t_mtg14vc4e18dcc51`. Wave 2 committed and pushed; CI on the branch is the full-gate proxy (this host OOMs on the full suite).

### Final execution gate — 2026-08-30 — SHIP
- Reviewer: genie:final-gate (session e7edce9e/a6e8b619). Cross-group seams verified in code (single `releaseTag()` predicate across G1/G2/G3; G5 smoke reads the shipped homes table; retirement gated on `skills.status === 'installed'`); no overclaims found (its 4 local agent-sync failures proven umask-environmental — green in a clean 022 extract and in CI). Residuals carried: C1/C2/C5 proven by the post-promotion candidate (main's workflow copy runs the smokes); accepted loops (setup --codex re-creation until Wish B; consent-none no-retire; advisory parity job).

### Group 7 — real-host dogfood — evidence 2026-08-30
- Executed by the orchestrator on khal-labs against dev v5.260830.20 (tag 7fd4290eb ⊃ #2868): 17 surfaces retired backup-first, second run `nothing to retire`, doctor `skills: claude/agents/goose/windsurf 22/22 @ v5.260830.20` + `legacy integrations: retired`, config.toml diff = genie rows only. Evidence: [qa/real-host-20260830.md](qa/real-host-20260830.md). Evidence review round 1 FIX-FIRST (reviewer session e7edce9e/af3a68af): count 17 not 18; **57** homes written vs four recorded (HIGH-1, round 2 measurement — the CLI's registry names 77 agents; 53 unrecorded homes = 1,166 would-be-orphaned dirs; `into 4 agent dir(s)` is an operator-facing misreport → Wish B pre-condition re-scoped: genie must record what the CLI actually wrote, a fixed candidate table cannot track a self-discovering CLI; plus the Hermes external_dirs duplication decision)

### Group 7 — evidence review — SHIP (round 3, 2026-08-30)
- Reviewer: genie:reviewer (session e7edce9e/af3a68af) re-measured every figure at 3efbbb3bc: 57 homes / 77-agent registry / 53 unrecorded / 1,166 would-be orphans all confirmed; retirement half of C3 proven decisively (backups restorable, diffs surgical, idempotent); skills half honestly scoped. Non-blocking addition to the Wish B recording pre-condition: a name-collision check for foreign skills in unrecorded homes (not realized on this host — zero overlaps sampled).
- `genie task done t_mtg14w35c3ea69d2`. All seven groups complete.; doctor 4→7 warn delta and three residues now recorded in the evidence; `codex exec $wish` probe run post-hoc (exit 0, correct answer from the skills.sh copy); grep fixed. C3 stays ticked with its "once per agent" clause scoped to the recorded homes.

### Execution review — 2026-08-30 — Group 3 — SHIP (after 1 fix loop)
- Reviewer: genie:reviewer (session e7edce9e/ab014b35). HIGH closed decisively: static import bundles (`grep -c classifyLegacyIntegrations dist/genie.js` = 3 vs 0 before); `DEFAULT_LEGACY_CLASSIFIER: LegacyClassifier = classifyLegacyIntegrations` turns seam drift into a compile error; source-lock test asserts import present + old pattern gone + module resolves. MEDIUM-1 null-seam rewrite; MEDIUM-2 `(unrecorded)` + `recorded:false`; LOWs closed. Cross-group `KNOWN_AGENT_SKILL_HOMES` narrowing traced: no uninstall regression (persisted `agentDirs` honored), CLI pin asserted repo-wide.
- Validation (orchestrator): doctor+skills-installer 192 pass / 0 fail post-fix; typecheck clean; full lint 0 errors / 3 pre-existing warnings; budget intact.
- Non-blocking notes: tie `SKILLS_CLI_VERSION` bumps to a homes-table re-verify (comment); stale-record + zero-detected yields no warn (accepted); legacy warn packs paths in one detail line (cosmetic). Worktree file modes 0600 from a fixer shell — git normalizes on commit.
- `genie task done t_mtg14vhpa6d08b44`.

### Plan review — 2026-08-30T16:41:04Z — FIX-FIRST
- Reviewer: genie:reviewer (claude-opus-5[1m]) session e7edce9e/plan-review-wish-a
- Reviewed SHA-256: `07f47957892605b6362b9854b7ae57a5d5c69e02b834dcbfd3dc819afaf90fda`
- HIGH: H1 retirement vs agent-sync re-create; H2 doctor --fix lease invariant; H3 wiring point must be the post-delivery child. MEDIUM: M1 --sync-only contract; M2 rehome symbol/consumer list + test split; M3 update.test.ts path; M4 docs lint scripts + submodule; M5 consent widening; M6 agentDirs source; M7 config.toml helper; M8 Group 7 post-merge. LOW: L1–L5.
- Disposition: all applied in rev. 2.

### Plan review — 2026-08-30T16:45:41Z — FIX-FIRST (rev. 2)
- Reviewer: genie:reviewer (claude-opus-5[1m]) session e7edce9e/plan-review-wish-a-rev2
- Reviewed SHA-256: `966e000409027fd7aeaa0f2c85bd4afcff5159f4e3094eedeb1ba836f2435a35`
- HIGH: H1-R suppression owned by no group; H2-R install.ts does not run runManualUpdateConvergence. MEDIUM: M1-R/M2-R/M3-R/M4-R stale rows contradicting Scope. LOW: L1-R docs lint scope; L2-R Groups 1–6; L3-R stale-record suppression hole; L4-R Bun.YAML on 1.3.11.
- Disposition: all applied in rev. 3: shared `runSkillsChannelConvergence` at both seams; suppression assigned to Group 2 with AC + agent-sync.test.ts in validation and the record-free fixture invariant; suppression keyed on `ref == v<VERSION>`.

### Plan review — 2026-08-30T16:52:18Z — FIX-FIRST (rev. 3, narrow)
- Reviewer: genie:reviewer (claude-opus-5[1m]) session e7edce9e/plan-review-wish-a-rev3
- Reviewed SHA-256: `017b9dd162d075fea6963d1254d0969ec42df62e344a418a2bc217c91f901fff`
- MEDIUM: M1-R3 retirement seam contradiction (install seam crosses `runPermittedPostDeliveryIntegrations` ownership); M2-R3 C4 grep misses `scripts/codex-plugin-only-smoke.ts` specifier. LOW: L1-R3 deliverable numbering; L2-R3 stale risk row; L3-R3 citation off-by-one; L4-R3 record the `setup --codex` loop as an accepted deviation.
- Disposition: all applied in rev. 4, together with the slug rename `codex-skill-installer` → `skills-everywhere`.

### Plan review — 2026-08-30T16:52:42Z — FIX-FIRST (rev. 4, narrow)
- Reviewer: genie:reviewer (claude-opus-5[1m]) session e7edce9e/plan-review-wish-a-rev4
- Reviewed SHA-256: `1e3e50fae51753aee42c09c1d13e8bc9b16da6a8cb2f7a15d1f205cdfe3e3f7d`
- MEDIUM: M1-R4 C4 grep blind to multi-line imports → replaced by the delete-re-exports + typecheck proof; M2-R4 INDEX entry / board card missing → INDEX entry restored under Ready (it had been overwritten in the shared working tree), 8 cards exist in genie.db under `skills-everywhere` (roadmap.json materializes on commit via the pre-commit sync hook). LOW: L1-R4 decision order; L2-R4 Group 6 ordering clause (design re-stamped `fafaef24…`, lint green).
- Disposition: all applied in rev. 5 (this document).

### Plan review — 2026-08-30T16:54:59Z — SHIP (rev. 5)
- Reviewer: genie:reviewer (claude-opus-5[1m]) session e7edce9e/plan-review-wish-a-rev5
- Reviewed SHA-256: `10495bc52125a724c70960dede5e9d5239402096627b08649a3aa5699388d26b` (rev. 5 bytes; re-derived byte-exact after the shared-tree deletion and verified against this digest before this block was appended)
- Residual LOW: L1-R5 C4's typecheck proof cannot see `scripts/codex-plugin-only-smoke.ts` (outside tsconfig/knip) — accepted, that file is deleted in Wish B; L2-R5 umbrella card title still says `codex-skill-installer` — cosmetic.
- Status set to APPROVED by the orchestrator on this evidence.

---

## Files to Create/Modify

```
src/lib/skills-installer.ts (+ .test.ts)
src/lib/legacy-integration-retirement.ts (+ .test.ts)
src/lib/lifecycle-lease.ts (+ .test.ts, moved)
src/lib/atomic-fs.ts (+ .test.ts, moved)
src/lib/agent-sync.ts (re-exports + writer-arm suppression flags)
src/lib/agent-sync.test.ts (describe blocks split out)
src/lib/runtime-integrations.ts (removeCodexPluginRegistration + import re-point)
src/lib/hermes-mcp-config.ts (reused)
scripts/workflow-yaml-parse.test.ts
scripts/codex-plugin-only-smoke.ts (import re-point)
src/genie-commands/install.ts, update.ts, uninstall.ts, doctor.ts (+ tests)
src/genie-commands/install-promote.ts, setup.ts, src/lib/ordered-lifecycle-leases.ts (imports)
scripts/skills-inventory-parity.ts (+ .test.ts)
.github/workflows/release-publish.yml, ci.yml
.genie/brainstorms/genie-dual-mode-orca-plugin/DESIGN.md, .genie/wishes/genie-dual-mode-orca-plugin/WISH.md (appended blocks)
docs/installation.mdx (submodule PR)
.genie/wishes/skills-everywhere/qa/real-host-*.md
```
