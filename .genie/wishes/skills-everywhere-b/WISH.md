# Wish: skills-everywhere — Wish B: honest install recording, then delete every non-Orca integration

| Field | Value |
|-------|-------|
| **Status** | APPROVED |
| **Slug** | `skills-everywhere-b` |
| **Date** | 2026-08-31 |
| **Author** | Felipe Rosa (orchestrated by Claude Fable 5) |
| **Appetite** | large |
| **Branch** | `wish/skills-everywhere-b` |
| **Repos touched** | automagik-dev/genie (base `dev`) |
| **Design** | [DESIGN.md](../../brainstorms/skills-everywhere/DESIGN.md) |

## Summary

Second of the three sequenced wishes under the `skills-everywhere` design (umbrella A → B → C). Wish A shipped the additive skills channel; Wish B first **repairs** what the real-host dogfood proved that channel gets wrong — it installs into 57 agent homes and reports 4, and `skills@1.5.23` silently ignores the `@<ref>` pin and serves the default branch instead of the release — and then **deletes** the Codex plugin subsystem, all six hook handlers and the hook runtime, the Claude/Kimi/Hermes/pi integrations, `agent-sync.ts`, the plugin half of `runtime-integrations.ts`, six `check` gates, the Codex dogfood matrix, and the build/release toolchain's plugin coupling. What remains under `plugins/genie` is the Orca tree; what remains as the delivery channel is the signed binary plus `skills/`. Target: ≥ 20,000 non-test lines out of `src/`, with `bun run check` green at every group boundary.

## Pre-conditions (wave 0 gate — verified before any group is dispatched)

| # | Pre-condition | State at authoring (2026-08-31) | Gates |
|---|---------------|--------------------------------|-------|
| P1 | Wish A merged to `dev` | ✔ PR #2868, merge commit `18b85341b`; ledger closure #2869 `66c0e7bf0`; `dev` head `df45bde28` (v5.260830.21) | all waves |
| P2 | Wish A released **stable** | ✘ **not yet** — needs rolling PR #2866 → `main` plus a stable dispatch. Design decision 9: retirement must be proven on real hosts before the code that produced their assets is deleted | **waves 2–6 (every deletion)**. Wave 1 is additive and may land before the cut — preferably *into* it, so the stable that carries the retirement also carries an honest, genuinely pinned install |
| P3 | v6 merge PR #2870 merged into `dev` | ✔ merged 2026-08-31, merge commit `1b34d7d4b`; `dev` head `67be5c46d` (v5.260831.1). It carries the top-level `genie-orca` skill move (design Risk 12) and the `skills-inventory-parity` local-path fix G1 mirrors, and it is what takes the inventory from 22 to **25** (`skills/genie-orca-{wish,work,review}/`) | all waves |
| P4 | C3 real-host evidence | ✔ [`qa/real-host-20260830.md`](../skills-everywhere/qa/real-host-20260830.md) — khal-labs on dev v5.260830.20 (tag `7fd4290eb` ⊃ `18b85341b`): 17 surfaces retired backup-first, second run `nothing to retire`, `config.toml` diff = genie rows only | waves 2–6 |
| P5 | dual-mode `dev`→`main` promotion merged | ✔ #2817 lineage on `main` (design Risk 15) | waves 2–6 |
| P6 | C9 branch-protection evidence captured | ✔ [`ruleset-main.json`](./ruleset-main.json) — see Decision 9 | wave 3 (the group that deletes `branch-guard`) |
| P7 | Every wave branch is rebased onto `dev` at or after `1b34d7d4b` | **Waves open only on a branch whose merge-base with `dev` is ≥ `1b34d7d4b` (#2870).** This is not hygiene, it is a correctness floor: `knip.json`'s `entry` array is `["src/hooks/dispatch-command.ts"]` before that merge and `["skills/genie-orca-work/scripts/*.ts", "src/hooks/dispatch-command.ts"]` after it, so G4's removal of the hooks entry leaves an **empty** `entry` array (a knip configuration error) on a pre-#2870 base and a valid one-element array on a post-#2870 base. The 22-vs-25 inventory, `SHIPPED_SKILL_NAMES` and `release-docs.test.ts:986` move on the same commit. | all waves |

## Scope

### IN

- **G1 — the install channel tells the truth and is actually pinned.** Two operator-facing defects the Wish A dogfood proved:
  - *The ref pin is fiction.* `skills@1.5.23` ignores the `@<ref>` suffix and always serves the repository's **default branch**. Proven 2026-08-31 three ways: `--list` against a feature-branch head, against a bare SHA, and against tag `v5.260712.1` (whose tree carries `pm` and `wizard` and no `quick`) all return the identical 22 names *including* `quick` — i.e. `main`'s tree. A **local path** source is discovered correctly. So `buildSkillsAddArgv` (`src/lib/skills-installer.ts:279-290`) switches from `automagik-dev/genie@v<ver>` to the **local delivered tree** under `$GENIE_HOME`: genuinely pinned (it is the signed tarball's own bytes), network-free for content, and the ref problem disappears. The record gains `source: 'local:<abs path>'` beside `ref: v<VERSION>`.
  - *The recording is wrong, not merely incomplete.* `agentDirs` is `existingAgentSkillHomes()` — the 4-row `KNOWN_AGENT_SKILL_HOMES` (`skills-installer.ts:89-95`) filtered to what exists — while the CLI wrote every skill in the inventory into **57** homes on the dogfood host (its registry names 77 agents), printing `skills: installed 22 skill(s) … into 4 agent dir(s)` (22 was the inventory on the dogfood date; it is **25** at `dev` head after #2870). A record-driven `genie uninstall` would orphan 25 × 53 = **1,325** directories at today's inventory (1,166 at the 22-skill inventory the dogfood measured). Fix: a bounded post-install **discovery scan** produces `agentDirs`; the report prints the real N; a **pre-install collision snapshot** records and backs up every foreign same-named skill dir that `--copy` is about to overwrite.
- **G2 — rehomes and retirement hardening, no deletions.** `computeDirDigest`/`computeFileDigest` move to `atomic-fs.ts`; the eight remaining `agent-sync.ts` symbols the surviving retirement module imports are absorbed into `legacy-integration-retirement.ts`; the four generic fs primitives `codex-activation-persistence.ts` lends to callers that survive Wish B (`fsyncParentDir`, `readBoundedRegularFile`, `unlinkWithParentFsync`, `atomicWriteFileSync`) move to `atomic-fs.ts` too; `scripts/validate-wish.ts` (+ `wish-template-text.d.ts`) is created beside its only surviving consumer `scripts/wishes-lint.ts:12`; `writeJsonDocument` becomes a staged, fsynced, renamed publish; two retirement surfaces are added (`~/.codex/agents/.genie-role-agents.json` and `~/.claude/plugins/marketplaces/automagik/`); `planCodexPluginRegistrationRemoval` handles TOML multi-line strings; the sidecar-less skill-dir advisory lands; `SCAN_EXEMPTIONS` becomes content-anchored.
- **G3 — the Codex plugin subsystem is deleted**: `setup --codex`, `codex-activation*.ts`, `codex-lifecycle-lease.ts`, `codex-lifecycle-truth.ts`, `codex-delivery*.ts`, `codex-rollback.ts`, `codex-doctor-observation.ts`, `codex-host-observation.ts`, `codex-release-version.ts`, `src/fixtures/codex-*.json`, `plugins/genie/.codex-plugin/`, `plugins/genie/codex-agents/`, `.agents/plugins/marketplace.json`, the Codex role-agent transaction engine inside `runtime-integrations.ts`, the `codex-smoke` CI job with its three smoke scripts, `tests/integration/codex-lifecycle-pty.test.ts` — plus **all** `doctor.ts` plugin / hook / Kimi / `agent sync:` check deletions and the `genie uninstall` rewrite. **Three surfaces on the deletion path are NOT deleted**, because surviving `publish.needs` release gates invoke them: `src/genie-commands/local-delivery-repair.ts` (351) + `.test.ts` (457), which implement `genie update --publish-local-delivery` (`release-publish.yml:1336`, asserted at `scripts/workflow-yaml-parse.test.ts:173`); `scripts/verify-delivery-evidence-pack.ts` + `.test.ts`, invoked at `release-publish.yml:556` and `:1198`; and `update.ts`'s binary-promotion proof (`:2054-2076`, `:3150`). G3 rehomes their primitives into two new surviving leaf modules and runs a mandatory importer sweep instead (deliverables 10-13).
- **G4 — hooks and the Claude/Kimi plugin are deleted**: `src/hooks/**` (all six handlers, the fail-closed envelope, `genie hook dispatch`); `plugins/genie/{.claude-plugin,.kimi-plugin,agents,hooks,workflows,rules,scripts,skills,settings.json,genie.ts,index.ts}`; `plugins/genie/references/**` except `orca-orchestration.md`; root `.claude-plugin/marketplace.json`; `scripts/{council-workflow-lint,hook-bundle-parity,hook-budgets-lint,hook-content-binding,plugin-executables-check,sync-plugin-skills}.ts`; and the `package.json` surgery those deletions force — the six gates `lint:council-workflow`, `lint:hook-bundles`, `lint:hook-budgets`, `lint:hook-content`, `lint:plugin-executables`, `lint:plugin-skills` (plus `hooks:bind`) leave **both** `check` and `check:fast`.
- **G5 — Hermes, pi, `agent-sync.ts`, and the plugin half of `runtime-integrations.ts`**: `plugins/hermes-genie/**`, `plugins/pi-genie/**`, `src/lib/hermes-skills-config.ts`, `src/lib/agent-sync.ts` (+ its 5,305-line test), `scripts/generate-codex-fallback-allowlist.ts`, the Codex-fallback / managed-skill-tree machinery in `runtime-integrations.ts`, and the agent-sync half of `ordered-lifecycle-leases.ts`.
- **G6 — build/release toolchain and the release workflow (criterion C11)**: `build-binary.sh` stages only the Orca tree plus `skills/`; `release-payload-version.ts` / `version.ts` / `version.yml` / `release-guard.sh` stamp only `package.json` + `plugins/genie/{package.json,orca-plugin.json}`; `scripts/build.js` and `scripts/sync.js` are deleted with their npm scripts; `fresh-install-smoke.ts` loses its whole plugin-layout half and derives its inventory from `skills/*/SKILL.md`; `scripts/version.ts` gains a `--check` read-only mode; `scripts/verify-codex-activation-payload.ts` leaves `build-binary.sh` and `build-tarballs.yml`; the `Codex standalone task/board dogfood` matrix, its completeness job and its harness/validators/matrix scripts leave `release-publish.yml`, leaving `skills-install-smoke` + `release-update-path-smoke` as the only added gates.
- **G7 — proof**: C4 line-count delta, the repo-wide `plugins/genie` grep, the Orca no-diff proof, a full `bun run check`, and a fresh-host install/uninstall smoke.
- **Minimum CLAUDE.md / AGENTS.md edits only** — the ones a test or a lint forces (see Decision 12). The rewrite is Wish C.
- **Wish A closure**: `.genie/wishes/skills-everywhere/WISH.md` Status `IN_PROGRESS` → `SHIPPED` in G1's PR, with a dated correction note.

### OUT

- **Orca**, in every form: `plugins/genie/{orca-plugin.json,orca-entrypoint.ts,orca-entrypoint.min.js,orca-runtime.ts,orca-runtime.test.ts,orca-real-runtime-smoke.test.ts}`, `plugins/genie/references/orca-orchestration.md`, **`plugins/genie/plugin.json`** (it carries `extensions."dev.orca.compatibility"`, `minimumRuntimeVersion: 1.4.192` — Orca metadata, not the Claude manifest), **`plugins/genie/package.json`** and **`plugins/genie/README.md`** (both version-stamped and asserted by `scripts/release-docs.test.ts`; the README is rewritten to Orca-only content, not deleted), `orca-marketplace.json`, `scripts/orca-*.ts`, `src/lib/orca-*.ts` — including **`src/lib/orca-orchestration-adapter.ts`, which is bundled into the Orca entrypoint** (`plugins/genie/orca-entrypoint.ts:1-2`, `orca-runtime.ts:7`) — `.github/workflows/orca-plugin-ref.yml`, `lint:orca-bundle`, and the `inspectOrcaPluginLifecycle` / `switchOrchestrationMode` / `refreshOwnedOrcaPluginMetadata` call sites in `doctor.ts` / `setup.ts` / `update.ts`. C8 proves it.
- **MCP**: `src/term-commands/mcp.ts`, `src/lib/codex-project-mcp.ts`, `.mcp.json` reconcile, and the doctor checks `Codex Genie MCP registration` / `Codex project context` / `Codex Genie MCP capability` — retirement is owned by `genie-dual-mode-orca-plugin`.
- **`src/lib/legacy-integration-retirement.ts` itself** — deleted two stable releases after this wish ships, not here. `src/lib/hermes-mcp-config.ts` (its `retireMcpServersGenie`) and `src/lib/codex-config.ts` (its `migrateDeadGenieOtel` / `getCodexHome`) survive with it.
- **Wish C**: `skills-lint` tokens, `skills/work/SKILL.md` wording, the genie-orca skill renames, and the CLAUDE.md / AGENTS.md / README / `docs/` rewrite — including the public `npx skills add automagik-dev/genie` caveat this wish discovers.
- Restoring a foreign skill dir that `--copy` overwrote. G1 detects, backs up, records and reports it; putting it back is a `genie uninstall` behavior nobody has asked for.
- `scripts/run-musl-dogfood.sh` and `.github/workflows/musl-adapter-smoke.yml` — binary-level, kept and proven byte-unchanged (see the last risk row for the one forward-looking break).

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | The skills install source becomes the **local delivered tree** under `$GENIE_HOME`, not `automagik-dev/genie@v<ver>` | `skills@1.5.23` ignores `@<ref>` and serves the default branch — measured three ways on 2026-08-31. The signed tarball's own `skills/` is the only source actually pinned to the running binary, and it needs no network for content. |
| 2 | The record's new fields are **optional** in the zod schema | `readSkillsInstallRecord` returns `null` for a schema-invalid record (`skills-installer.ts:181-186`). A required new field would invalidate every 5.260830.x record on disk, turning doctor into `(unrecorded)` and `genie uninstall` into a silent no-op over 22 × N live directories — the exact failure this wish exists to prevent. |
| 3 | `agentDirs` comes from a bounded **post-install discovery scan**, unioned with the known-home floor | A fixed 4-row table cannot track a self-discovering CLI whose registry names 77 agents and which wrote 57 homes on one host. The union guarantees the record never shrinks below today's behavior. |
| 4 | Keep `--all`; do not narrow to `-a <agents>` | User direction (design decision 4), and the release smoke must exercise production argv. The cost — writing into homes the operator never asked for — is paid by honest recording and the collision snapshot, not by silently installing less than we report. |
| 5 | Collisions are **detected, backed up, recorded and reported** — never refused | `--all` gives no per-home veto, so "refuse for that home" is unimplementable without abandoning decision 4. Backup-first plus a recorded `collisions[]` matches the contract every other destructive path in this repo already keeps (`legacy-v4.ts`, retirement). |
| 6 | The **eight** agent-sync symbols the retirement module still needs are **absorbed into that module**; only the two digest functions get a shared home (`legacy-integration-retirement.ts:71-81` imports **nine** symbols; `computeFileDigest` is the one that leaves for `atomic-fs.ts`, so eight are absorbed) | `legacy-integration-retirement.ts` is their only consumer that survives this wish, and it is itself deleted two stable releases later — a new `src/lib/*.ts` home would outlive its only user. `computeDirDigest`/`computeFileDigest` go to `atomic-fs.ts`, where `atomic-fs.test.ts:27` already uses the former as its verification primitive. |
| 7 | Every group leaves `bun run check` green, and **no group deletes a file a `.github/workflows/**` job invokes unless it removes that job in the same commit** | Design Risk 10. `check` cannot see workflow breakage: `codex-plugin-only-smoke.ts` is invoked only by `ci.yml:207-208`, `validate-live-dogfood-evidence.ts` only by `release-publish.yml:729`, `verify-codex-activation-payload.ts` by `build-binary.sh:223` on every tarball build. Deleting any of them without the job is green locally and red in CI. |
| 8 | Waves 2–6 are strictly sequential | G3/G4/G5 all edit `src/genie.ts`, `package.json` and `src/genie-commands/{install,update,doctor,uninstall}.ts`; a 25k-line deletion has too many shared-import seams to merge in parallel. Disjoint file ownership is enforced *within* a wave; across waves, sequencing is the guarantee. |
| 9 | The `branch-guard` actor gap is accepted and recorded, not mitigated | Design Risk 3. `ruleset-main.json` (ruleset 9203218, `active`) proves `main` requires a pull request with 1 approving review, `dismiss_stale_reviews_on_push`, `require_last_push_approval`, `required_review_thread_resolution`, **`require_extra_approval_for_unattributed_changes: true`**, merge-commit-only (`allowed_merge_methods: ["merge"]`), the `Quality Gate (typecheck + lint + test)` status check (integration 15368), and blocks `deletion` + `non_fast_forward`. It cannot prove reviewer ≠ agent: bypass actors are `RepositoryRole 5` (admin) and one Integration, and an agent uses the human's `gh` credentials. `.husky/pre-push` still blocks direct pushes to `main`; the PR-merge path loses client-side enforcement entirely and rests on this ruleset plus `AGENTS.md` §19 as policy. |
| 10 | All `doctor.ts` surgery happens in G3, including the Kimi and `agent sync:` checks whose payloads G4/G5 delete later | Deleting a caller never requires deleting the callee first, and one owner for a 2,711-line command file is worth more than surface-aligned grouping. |
| 11 | **Each payload-deletion group removes its own manifests from the five toolchain lists in the same commit**; G6 owns the structural toolchain rewrite | `build-binary.sh:127-139` hard-requires each manifest to exist, and `release-payload-version.ts:16-22`, `version.ts:198-208`, `version.yml:194-202`, `release-guard.sh:161-172` each enumerate them. A group that deletes a manifest without delisting it breaks every tarball build — invisibly to `check`. G6 then does the structural half: stage only Orca + `skills/`, delete `build.js`/`sync.js`, rewrite `fresh-install-smoke`, add `--check`, and run C11 in full. |
| 12 | Wish B makes the **minimum** CLAUDE.md / AGENTS.md edits that a test or lint forces; Wish C owns the rewrite | `src/__tests__/claude-md-drift.test.ts:61` binds AGENTS.md to `plugins/genie/references/native-surfaces.md` (deleted in G4), and `scripts/release-docs.test.ts:77` binds the workflow's "expected exactly nine version files" literal (changed in G6). Leaving either broken to preserve a scope line would be a red gate, not a clean boundary. |

## Simplicity Case

- **Simplest complete design:** delete the code; keep exactly the primitives the time-boxed retirement module, the surviving release gate (`--publish-local-delivery`) and the Orca plugin still consume; fix the one channel defect that would otherwise turn `genie uninstall` into a 1,325-directory orphan-maker.
- **Added machinery:** the discovery scan and the collision snapshot in `skills-installer.ts` — both demanded by the dogfood measurement, both bounded (depth ≤ 6, entry cap, wall clock, no symlink escape); `scripts/version.ts --check` — required by C11 because the bare command performs a real bump (`version.ts:249-260` reads no argv at all) and can never be run as verification. Nothing else is added; every other deliverable is a deletion or a move.
- **Deferred until measured:** restoring overwritten foreign skills (on a reported incident); `-a <agents>` bounding (if a user objects to the `--all` widening); parsing the CLI's own summary instead of scanning (it truncates — `copy → AiderDesk, Amp, … +72 more` — and writes no lockfile under `-g`); re-adding any hook (design Simplicity Case: only with a concrete incident a skill cannot prevent).
- **Complexity removed:** the Codex plugin (authenticated delivery, generations, fallback lanes, repair/rollback, TTY activation, role profiles, the 4-platform dogfood matrix with its harness and two validators), the Claude marketplace plugin (hooks, role agents, council stamp, `LENS_ROOT`), Kimi, Hermes, pi, all six hook handlers and the hook runtime, `agent-sync.ts` (6,733 lines, with a 5,305-line test), the plugin half of `runtime-integrations.ts` (4,348 today), six `check` gates, two `smoke:codex*` scripts and their CI job, ~15 doctor checks, `build:plugin`, `sync`, and the nine-manifest version-stamping fan-out.

## Dependencies

**depends-on:** skills-everywhere
**blocks:** none

## Success Criteria

- [ ] **C-R1 (recording, G1)** On a host where the CLI writes into more homes than `KNOWN_AGENT_SKILL_HOMES`, `skills-install.json.agentDirs` equals the measured set — reproduced with the dogfood evidence command `find "$HOME" -maxdepth 6 -type d -name skills`, filtered to dirs whose `<inventory[0]>/SKILL.md` is byte-equal to `$GENIE_HOME/skills/<inventory[0]>/SKILL.md` and whose birth/mtime ≥ the install start — and the operator line reports that same N, not 4.
- [ ] **C-R2 (pin, G1)** The production argv names the local delivered tree and contains no `automagik-dev/genie@` GitHub source; the set the CLI installs equals `inventoryFromSkillsDir($GENIE_HOME/skills)`; a record written by 5.260830.x (no `source`, 4 `agentDirs`) still parses and still drives `removeSkillsChannelInstall`.
- [ ] **C-R3 (collision, G1)** A candidate home holding a foreign, non-byte-equal directory named like one of ours is snapshotted and backed up before the install, recorded in `collisions[]`, and reported by path, skill name and backup root; the foreign-dir, byte-equal-dir and absent-home cases are unit-tested.
- [ ] **C-R4 (uninstall, G7)** `genie uninstall` on a host installed by the fixed channel leaves **zero** genie skill directories anywhere under `$HOME` (`find "$HOME" -maxdepth 6 -type d -name skills` cross-checked against the inventory) and removes the record; foreign skills in the same dirs are untouched.
- [ ] **C4** `git ls-files src | grep '\.ts$' | grep -v '\.test\.ts$' | xargs wc -l | tail -1` ≤ **40,189**, i.e. a ≥ 20,000-line drop from the Wish-A merge baseline of **60,189** lines across 97 files, measured at `18b85341b` and re-verified identical at `dev` head `67be5c46d` after #2870 merged (`1b34d7d4b`) — that PR added no `src/**` non-test TypeScript, so the baseline is unchanged.
- [ ] **C5-lite** `git grep -nE 'CLAUDE_PLUGIN_ROOT|LENS_ROOT' -- skills` returns nothing — it does today, so this is the regression guard that Wish B does not leave `skills/**` pointing at a deleted plugin root. The remaining Decision-7 tokens are enumerated into Review Results as the Wish C worklist: 5 files under `skills/` currently match `\$genie:|genie_(engineer|reviewer|fixer|final_gate|scout)|engineer-(trivial|standard|complex)` at `dev` head `67be5c46d` — `skills/README.md`, `skills/genie-hacks/references/catalog.md`, `skills/trace/SKILL.md`, `skills/wish/templates/wish-template.md`, `skills/work/SKILL.md`. Add to that worklist the **mirror sentence at `skills/README.md:37`** ("`plugins/genie/skills/` is a committed physical mirror of this directory … Never edit the mirror directly"), which G4 makes false the moment it deletes the mirror; the lint itself is Wish C.
- [ ] **C7 (partial)** `.github/workflows/release-publish.yml` contains no `codex-native-dogfood` (`:562`) or `codex-dogfood-completeness` (`:741`) job and no `needs:` edge into them; `publish.needs` drops from seven edges to **six** — only `codex-dogfood-completeness` (`:1621`) leaves, and `admit`, `attest-delivery-evidence`, `delivery-evidence-compatibility`, `skills-install-smoke` (`:1622`), `release-update-path-smoke` (`:1623`) and `stable-release-security-gate` (`:1624`) all remain, each with its `if:` guard intact; `git diff --exit-code origin/dev -- .github/workflows/musl-adapter-smoke.yml scripts/run-musl-dogfood.sh` is empty.
- [ ] **C8** `git diff --stat origin/dev -- plugins/genie/orca-* plugins/genie/plugin.json plugins/genie/references/orca-orchestration.md orca-marketplace.json scripts/orca-*.ts src/lib/orca-*.ts .github/workflows/orca-plugin-ref.yml` is empty, and `bun test plugins/genie/orca-runtime.test.ts scripts/orca-manifest-parity.test.ts scripts/orca-bundle-parity.test.ts src/lib/orca-plugin-lifecycle.test.ts` is green.
- [ ] **C9** `ruleset-main.json` is committed beside this wish and Decision 9 records both what it proves and the accepted actor gap.
- [ ] **C11** `bun run build:binary` green on all four platforms via the CI matrix; `bun scripts/release-payload-version.ts --verify-source .` green; `bash scripts/release-guard.sh` green in its CI job; `bun scripts/fresh-install-smoke.ts` green; the new `bun scripts/version.ts --check` exits 0 and names only `package.json`, `plugins/genie/package.json` and `plugins/genie/orca-plugin.json`; `bun test scripts/version-format.test.ts scripts/version-ci-staging.test.ts scripts/release-docs.test.ts` green. **Deviation from the design's literal C11** ("only `package.json` + `orca-plugin.json`"): `plugins/genie/package.json` is a third stamp target because it is enumerated in all four version lists (`release-payload-version.ts:17,38`, `version.ts:204`, `version.yml:200`, `release-guard.sh:166`), listed in the workflow version-file assertion at `release-docs.test.ts:67`, and license-asserted at `release-docs.test.ts:720-723`, and it belongs to the surviving Orca payload. Deleting it instead would be a fourth toolchain rewrite for no gain; if a reviewer prefers the design's literal wording, that is the alternative.
- [ ] **C-G** `git grep -n "plugins/genie" -- src scripts .github package.json` returns only Orca-owned lines, and `bun run check` is green on the wish head.
- [ ] **C-A** `.genie/wishes/skills-everywhere/WISH.md` Status is `SHIPPED` with the dated C1/C2 correction note.

## Execution Strategy

Wave 0 is the pre-condition table above, not a group. Wave 1 is additive and may land before the Wish A stable cut; **waves 2–6 must not open until P2 and P3 hold**, and **no wave of any kind opens on a branch whose merge-base with `dev` is older than `1b34d7d4b`** (P7).

### Wave 1 (parallel — additive, no deletions)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 1 | engineer | 5 — stateful record + host scan (+2), no deterministic test for the real-host home set (+1), CI/release argv (+1), prior rework on this exact surface (+1) | `engineer-complex` / high | Local-path install source, discovery scan, collision snapshot, honest N; Wish A closure |
| 2 | engineer | 4 — stateful retirement + atomic write (+2), multi-package src/scripts/plugins (+1), prior rework from Wish A's G2 follow-up list (+1) | `engineer-complex` / high | Rehomes, `writeJsonDocument` durability, two new retirement surfaces, TOML multi-line, stable-token exemption |

### Wave 2 (sequential, after wave 1)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 3 | engineer | 6 — stateful lifecycle/uninstall (+2), subjective acceptance on what each doctor check depends on (+2), multi-package (+1), prior rework (+1) | `engineer-complex` / high | Delete the Codex plugin subsystem; all doctor surgery; rewrite `genie uninstall` |

### Wave 3 (sequential, after Group 3)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 4 | engineer | 4 — multi-package (+1), CI/release `check` recomposition (+1), prompt/skill payload change (+1), prior rework (+1) | `engineer-complex` / high | Delete `src/hooks/**` and the Claude/Kimi plugin payload; remove the six gates from `check`/`check:fast` |

### Wave 4 (sequential, after Group 4)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 5 | engineer | 5 — stateful lease/sync semantics (+2), subjective acceptance on the `runtime-integrations.ts` keep-set (+2), multi-package (+1) | `engineer-complex` / high | Delete Hermes/pi and `agent-sync.ts`; slim `runtime-integrations.ts` |

### Wave 5 (sequential, after Group 5)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 6 | engineer | 6 — stateful release/version stamping (+2), CI/release (+1), multi-package (+1), no local deterministic test for the workflow (+1), prior rework from the 2026-07-11 downgrade lineage (+1) | `engineer-complex` / high | Toolchain rewrite, `version.ts --check`, delete the Codex dogfood matrix and its scripts |

### Wave 6 (sequential, after Group 6)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 7 | qa | 4 — subjective evidence (+2), no deterministic test for the fresh-host pass (+1), CI/release (+1) | `engineer-complex` / high | C4 / C-G / C8 / C-R4 measurement, full gate, fresh-host smoke evidence |

After Group 7, an independent `genie:final-gate` pass at the highest justified effort: the aggregate risk of a 25k-line deletion across five sequential waves (design Risk 10) is not covered by any single group review.

Complexity scoring rubric: score each group independently and record the total plus a short rationale in **Complexity**. Add:

- **+2** each for orchestration / agent-lifecycle / routing; cost / model / escalation; stateful work; subjective acceptance.
- **+1** each for multi-package work; OTel-label dependency; no deterministic test; prior rework; prompt-skill change; CI / release work.

Route the total in **Model** by portable role and reasoning effort: **0–1** →
`engineer-trivial` / low; **2–3** → `engineer-standard` / medium or high;
**4–6** → `engineer-complex` / high; **7+** → `engineer-complex` plus an
independent `final-gate` at the highest justified effort. Each runtime maps
these to its matching native roles (such as the `genie_*` profiles where
installed). Keep
model and effort in runtime session/agent configuration, never skill frontmatter.

## Execution Groups

### Group 1: honest, genuinely pinned skills install

**Goal:** the skills channel installs from a source that is actually pinned to the running binary, records every directory it wrote, reports that real number, and never silently destroys a foreign skill.

**Deliverables:**
1. **Local-path source.** `buildSkillsAddArgv` (`src/lib/skills-installer.ts:279-290`) emits `npx -y skills@1.5.23 add <local source root> --all --copy -g`, and the source root is pinned to **`$GENIE_HOME/skills`**.

   **Why the root must be named explicitly, and why the 25-vs-22 probe is now resolved.** A delivered `$GENIE_HOME` holds *two* physical skill trees: `build-binary.sh:76-77` stages `cp -R plugins` and `cp -R skills` side by side, so the extracted install carries both `$GENIE_HOME/skills/` and `$GENIE_HOME/plugins/genie/skills/`. The two are byte-identical today — the committed mirror is enforced by `sync-plugin-skills.ts --check` at `build-binary.sh:57` and re-verified here at `dev` head `67be5c46d`: 72 blobs on each side with identical object hashes. Pointing the CLI at `$GENIE_HOME` (rather than `$GENIE_HOME/skills`) therefore risks a two-root discovery whose behavior nobody has specified. Pin `$GENIE_HOME/skills`, assert it in the argv test, and require the installed set to equal `inventoryFromSkillsDir($GENIE_HOME/skills)` (`skills-installer.ts:243-257`).

   The earlier "local-path probe returned **25** where the top-level inventory is 22" is **not** a discrepancy: 25 *is* the inventory at `dev` head. #2870 (`1b34d7d4b`) added `skills/genie-orca-{wish,work,review}/`, taking `skills/*/` from 22 to 25, `SHIPPED_SKILL_NAMES` (`sync-plugin-skills.ts:36-62`) to 25 entries, and `release-docs.test.ts:986` to `toHaveLength(25)`. That PR's own parity evidence (`npx -y skills@1.5.23 add "$PWD" --list` against the checkout → 25 names) agrees with `inventoryFromSkillsDir` at the same commit. Nothing remains to explain; the group still asserts the equality rather than assuming it.

   **G4 ordering.** G4 deletes the `plugins/genie/skills/` mirror. That is safe only because G1 has already pinned the source to `$GENIE_HOME/skills`; G4's acceptance re-runs the argv test to prove the pinned root is the surviving one. `skillsInstallRemedy` follows the same argv.
2. **Record schema.** Add `source: z.string().min(1).optional()` (and the `collisions` array of deliverable 5, also optional) to `skillsInstallRecordSchema`, and write `source: 'local:<abs root>'` while keeping `ref: releaseTag(VERSION)` as the delivered binary version. **Optional is load-bearing** (Decision 2). Add a test that a 5.260830.x-shaped record parses and still drives `removeSkillsChannelInstall`.
3. **Discovery scan.** After a zero-exit install, walk `$HOME` for directories named `skills` at depth ≤ 6. Prune `node_modules`, `.cache`, `.npm`, `.git`, and `$GENIE_HOME/skills` (the source). Keep a candidate iff `<candidate>/<inventory[0]>/SKILL.md` exists and is byte-equal to `$GENIE_HOME/skills/<inventory[0]>/SKILL.md` **and** its birthtime (falling back to mtime) ≥ the timestamp captured immediately before the spawn. Bound it: an entry cap, a wall-clock cap, `lstat`-based traversal that never follows a symlink out of `$HOME`, and every recorded path must satisfy the existing `isTraversalFreeAbsolutePath`. `agentDirs` = scan ∪ `existingAgentSkillHomes()` (Decision 3). On scan failure or cap exhaustion, fall back to the union floor and emit a warn line; never fail the install for it.
4. **Honest report.** `skills: installed <n> skill(s) from <source> into <N> agent dir(s)` where `N === record.agentDirs.length`, plus a `scan capped` / `scan failed` warn line when the fallback fired.
5. **Collision snapshot.** *Before* the spawn, for every candidate home that already exists, find directories named like one of our inventory names whose `SKILL.md` is not byte-equal to ours and which carry no genie provenance. Copy each into `<GENIE_HOME>/state-backups/skills-collision-<timestamp>/<mirrored relative path>` before the install runs, record them as `collisions: [{dir, skill}]`, and report `collision: <path> (<skill>) — backed up to <root>`. Restoration is explicitly OUT.
6. **Gate argv.** Mirror the local-path source into `.github/workflows/release-publish.yml`'s `skills-install-smoke` job (`:839`), whose install line is `:894` (`npx -y skills@1.5.23 add "automagik-dev/genie@${SKILLS_REF}" --all --copy -g`) with the surrounding comment at `:887` — it must exercise production argv (design decision 4) — and confirm `skills-inventory-parity` in `ci.yml` already lists the local checkout after #2870; if it does not, fix it here.
7. **Wish A closure.** Flip `.genie/wishes/skills-everywhere/WISH.md` Status `IN_PROGRESS` → `SHIPPED` and append a dated block under `## Review Results` recording (a) the closure rationale — merged to `dev`, C3 proven, stable pending is the documented contract — and (b) that C1/C2's release-tag pin was factually wrong because `skills@1.5.23` ignores `@<ref>`, naming this group as the owner of the correction. Record an upstream follow-up against `vercel-labs/skills` for the ignored ref, and note that the public `npx skills add automagik-dev/genie` documented in `docs/installation.mdx` serves `main` — acceptable for the public path, wording owned by Wish C.

**Acceptance Criteria:**
- [ ] C-R1, C-R2 and C-R3 above.
- [ ] A test asserts the production argv byte-for-byte, and `git grep -n "automagik-dev/genie@" -- src` returns nothing.
- [ ] The discovery scan is injectable (a `home` seam and a clock seam already exist) and unit-tested against a fake `$HOME` carrying: a matching home created inside the window, a matching home created *before* it, a byte-differing home, a `node_modules` decoy, a symlink pointing outside `$HOME`, and a depth-7 home.
- [ ] `runSkillsChannelConvergence`'s `installed` line prints the scanned N in an end-to-end test whose fake `npx` shim writes into 6 homes while `KNOWN_AGENT_SKILL_HOMES` matches 2.
- [ ] No behavior change to the `consent: none` skip, the never-throws contract, the `process.exitCode = 1` on failure, or `--sync-only`.
- [ ] `.genie/wishes/skills-everywhere/WISH.md` Status is `SHIPPED` and `bun run wishes:lint` is green.

**Validation:**
```bash
# Full gate: this group changes the shared install/update runtime and a required
# release-workflow job's argv, so nothing narrower sees the blast radius.
bun run check
bun test src/lib/skills-installer.test.ts src/genie-commands/doctor.test.ts src/genie-commands/uninstall.test.ts
```

**depends-on:** none

---

### Group 2: rehomes and retirement hardening

**Goal:** move every primitive the surviving retirement module needs out of `agent-sync.ts`, and close the durability and coverage follow-ups Wish A's G2/G3 reviews carried into this wish — with zero deletions, so `agent-sync.ts` can be deleted mechanically in Group 5.

**Deliverables:**
1. **Re-derive the surviving-consumer set first.** Classify every `agent-sync` importer as *survives Wish B* or *deleted by G3/G4/G5*. Today the only surviving non-test importer is `src/lib/legacy-integration-retirement.ts:71-81`, which pulls **nine** symbols — `MANIFEST_NAME`, `TARGET_NAME`, `WORKFLOW_MANIFEST_NAME`, `codexLegacyCuratedDir`, `computeFileDigest`, `inspectManagedSkillTree`, `inspectManagedWorkflow`, `readAgentFilesManifestState`, `resolveHermesConfigPath`. If the re-derivation finds a symbol with a surviving consumer this plan does not name, put that symbol in `atomic-fs.ts` and say so in the PR — **do not guess, and do not widen `agent-sync.ts`'s public surface.**
2. **`computeDirDigest` (`agent-sync.ts:553`) and `computeFileDigest` (`:696`) move verbatim to `src/lib/atomic-fs.ts`**, whose test already uses the former as its verification primitive (`atomic-fs.test.ts:27`). `agent-sync.ts` re-exports both — the Wish A pattern — so no other consumer changes this wave. Move their describe blocks (`agent-sync.test.ts:1950-2010`) to `atomic-fs.test.ts`.
3. **The remaining eight symbols are absorbed into `legacy-integration-retirement.ts` as module-private** (Decision 6) — `MANIFEST_NAME`, `TARGET_NAME`, `WORKFLOW_MANIFEST_NAME`, `codexLegacyCuratedDir`, `inspectManagedSkillTree`, `inspectManagedWorkflow`, `readAgentFilesManifestState`, `resolveHermesConfigPath` (the ninth, `computeFileDigest`, goes to `atomic-fs.ts` per deliverable 2) — with whatever file-private leaf helpers they need. Wish A's G4 review recorded that a rehome of this shape drags ~18 leaf helpers to avoid a back-import cycle, so budget for that and prove no cycle (`atomic-fs` ← `lifecycle-lease` ← `agent-sync`, with retirement importing neither upward).
4. **Rehome the generic fs primitives that `codex-activation-persistence.ts` (214) lends to survivors.** G3 deletes that module, but two of its consumers are **not** Codex-plugin code and survive Wish B:
   - `src/lib/install-version-marker.ts:42` — `import { fsyncParentDir, readBoundedRegularFile, unlinkWithParentFsync } from './codex-activation-persistence.js'`
   - `src/lib/update-capabilities.ts:29` — `import { atomicWriteFileSync } from './codex-activation-persistence.js'`

   (The other four importers — `codex-rollback.ts:59`, `codex-activation.ts:40`, `codex-delivery-evidence.ts:20`, `codex-lifecycle-lease.ts:52` — all die in G3, and the `genie-home-permissions.test.ts:192` `SCAN_EXEMPTIONS` entry dies with the file.)

   All four symbols are generic filesystem primitives with nothing Codex-specific in them, so they **move verbatim to `src/lib/atomic-fs.ts`** alongside deliverable 2's digests, and `codex-activation-persistence.ts` re-exports them for the wave (the Wish A pattern) so no G3-doomed caller changes here. G3 then deletes the shim and re-points those two survivors at `atomic-fs.js`. Move the corresponding describe blocks into `atomic-fs.test.ts`, and keep `install-version-marker.test.ts` / `update-capabilities.test.ts` green unchanged.
5. **`writeJsonDocument` (`legacy-integration-retirement.ts:1065-1067`) becomes crash-safe**: stage beside the target, `writeAllSync` + `fsyncPath` the staging file, rename, fsync the directory, unlink the staging file on every failure path. It rewrites the user's `known_marketplaces.json` (`:1045`) and `settings.json` (`:1061`) in place today; a truncating crash there is exactly the destruction the module's backup-first story promises never happens. Test: a write that throws mid-flight leaves the original bytes byte-identical and no `*.staging-*` residue.
6. **Two new retirement surfaces**, each with classify + backup-first remove + `kept` reporting for the modified/unmanaged cases:
   - `codex-role-agent-inventory` — `~/.codex/agents/.genie-role-agents.json` (`CODEX_AGENT_INVENTORY_NAME`, `runtime-integrations.ts:709`) plus leftover `.genie-role-agents.{txn,conflict,prepare,committed-cleanup}-*` directories (`runtime-integrations.ts:1123-1126`). The existing `codex-role-agent` surface classifies only `genie-*.toml`, so the inventory sidecar and its transaction debris survive every retirement today.
   - `claude-marketplace-cache` — `~/.claude/plugins/marketplaces/automagik/`. `claude-plugin-cache` resolves `pluginCacheFamilyDir` = `<home>/plugins/cache/automagik/genie` (`legacy-integration-retirement.ts:564-566`), which does not cover the marketplace bundle tree that `inspectRuntimeIntegrationEvidence` still reads as installed evidence (`runtime-integrations.ts:4110`).
   - Acceptance: on a fixture carrying both, one retirement run flips `inspectRuntimeIntegrationEvidence` to `{codex:false, claude:false}` and a second run prints `nothing to retire` with zero new backup roots.
7. **TOML multi-line strings** in `planCodexPluginRegistrationRemoval` (`runtime-integrations.ts:2137`): a `"""…"""` value whose body contains a line that looks like a table header must not terminate `[plugins."genie@automagik"]` early or swallow the following table. Test both shapes, asserting unrelated tables and comments round-trip byte-identically.
8. **Sidecar-less skill-dir advisory**: a managed-looking skill directory with no `.genie-sync.json` sidecar is reported by path as `kept` with a reason, never removed.
9. **Stable-token `SCAN_EXEMPTIONS`** (`src/lib/genie-home-permissions.test.ts:239-253`): the key `src/lib/agent-sync.ts:4962` is line-anchored and its own comment records that it already had to move once. Re-key it on a content token so it cannot silently stop matching — or match the wrong call site — while Wish B moves and then deletes that file. Group 5 removes the entry entirely.
10. **`scripts/validate-wish.ts` + `scripts/wish-template-text.d.ts`** created from `plugins/genie/scripts/src/`, and `scripts/wishes-lint.ts:12` re-pointed (it currently imports `../plugins/genie/scripts/src/validate-wish.js` — a hard break the moment G4 lands). The plugin-side original and its built `.cjs` stay untouched this wave; `build:plugin` and `lint:plugin-executables` still reference them and both leave in Group 4.

    **The two copies cannot be byte-identical, and must not be asserted to be.** `plugins/genie/scripts/src/validate-wish.ts` sits four directories below the repo root and reaches its two cross-tree dependencies with four-level relative specifiers (`:42` `import { readBoundedWishFile, extractLegacyStatusValue, extractStatusCell } from '../../../../src/lib/wish-status.js'`; `:43` `import wishTemplate from '../../../../skills/wish/templates/wish-template.md' with { type: 'text' }`). The `scripts/` copy sits one level below the root, so those two specifiers become `../src/lib/wish-status.js` and `../skills/wish/templates/wish-template.md`. The contract is therefore an **exact two-line import delta and nothing else**: `diff plugins/genie/scripts/src/validate-wish.ts scripts/validate-wish.ts` must show exactly those two changed lines and no other hunk, with the diff pasted in the PR. `wish-template-text.d.ts` has no relative imports and **is** byte-identical.
11. **Hermes marker source-lock**: `legacy-integration-retirement.test.ts:534-539` asserts the two Hermes marker literals still exist in `hermes-skills-config.ts` and `hermes-mcp-config.ts`. Group 5 deletes the former. Make the retirement module the single source of truth for `# genie:managed:skills.external_dirs` and drop that half of the assertion; keep the `hermes-mcp-config.ts` half, since that file survives.

**Acceptance Criteria:**
- [ ] Verbatim-move proof in both directions for deliverables 2, 3 and 4 (removed blocks vs. added blocks, byte-identical except import lines), and no public symbol lost from `agent-sync.ts`'s or `codex-activation-persistence.ts`'s surface this wave.
- [ ] `atomic-fs.ts` exports `fsyncParentDir`, `readBoundedRegularFile`, `unlinkWithParentFsync` and `atomicWriteFileSync`; `codex-activation-persistence.ts` re-exports all four; `bun test src/lib/install-version-marker.test.ts src/lib/update-capabilities.test.ts src/lib/codex-activation.test.ts src/lib/codex-lifecycle-lease.test.ts` green with no source change to those four consumers.
- [ ] `bun run dead-code` clean — a rehome that leaves an unreferenced export is a knip failure, not a style nit.
- [ ] `LEGACY_INTEGRATION_SURFACES` grows to 17 entries and every new one has a `managed-clean` / `managed-modified` / `unmanaged` / `absent` test.
- [ ] The `writeJsonDocument` durability test, the two TOML multi-line tests, the sidecar-less advisory test, and the record-free `nothing to retire` idempotence test all pass.
- [ ] `scripts/wishes-lint.ts:12` imports `../scripts/validate-wish.js` (i.e. `./validate-wish.js`) instead of `../plugins/genie/scripts/src/validate-wish.js`; `diff` against the plugin-side original shows the exact two-line import delta of deliverable 10 and nothing else; `bun run wishes:lint` green.

**Validation:**
```bash
# Full gate: this group edits the retirement module every `genie update` runs,
# a shared filesystem primitive, and a repo-wide test exemption.
bun run check
bun test src/lib/legacy-integration-retirement.test.ts src/lib/atomic-fs.test.ts \
  src/lib/agent-sync.test.ts src/lib/runtime-integrations.test.ts \
  src/lib/genie-home-permissions.test.ts scripts/wishes-lint.test.ts
```

**depends-on:** none

---

### Group 3: delete the Codex plugin subsystem; rewrite doctor and uninstall

**Goal:** remove authenticated Codex delivery, activation, generations, fallback lanes, repair/rollback and role profiles; leave `doctor` with only the checks whose dependencies survive; make `genie uninstall` record-driven.

**Deliverables:**
1. Delete `src/lib/codex-activation.ts` (2,158), `codex-activation-executor.ts` (834), `codex-activation-persistence.ts` (214), `codex-delivery-evidence.ts` (957) + `.test-support.ts`, `codex-doctor-observation.ts` (147), `codex-host-observation.ts` (378), `codex-lifecycle-lease.ts` (1,068), `codex-lifecycle-truth.ts` (279), `codex-release-version.ts` (48) and their tests; `src/genie-commands/codex-delivery.ts` (276), `codex-delivery-repair.ts` (405), `codex-rollback.ts` (259) and their tests; `src/fixtures/codex-*.json` (4 files); `tests/integration/codex-lifecycle-pty.test.ts` (it copies `$GENIE_HOME/plugins/genie/.` into a Codex cache at `:87,136`). **`src/genie-commands/local-delivery-repair.ts` (351) + `.test.ts` (457) and `scripts/verify-delivery-evidence-pack.ts` + `.test.ts` are explicitly NOT in this list, and `src/genie-commands/update.ts`'s binary-promotion path keeps `parseReleaseVersion` / `scanPhysicalTree` — see deliverables 10-13.** Note that `codex-delivery-evidence.ts` (957) and `codex-release-version.ts` (48) are deleted only *after* deliverable 10 has moved the surviving symbols out of them.
2. Delete `setup --codex` and its whole activation path from `src/genie-commands/setup.ts` (1,183) plus the `--codex` option (`src/genie.ts:73`) and the delivery/rollback command registrations. **Keep** `switchOrchestrationMode` and the Orca mode-switch path of `genie setup`.
3. Delete the Codex half of `src/lib/ordered-lifecycle-leases.ts` — with `codex-lifecycle-lease.ts` gone the ordered pair collapses to the single agent-sync lease (Group 5 finishes it) — and re-point **every** call site, not only the acquire ones: `install.ts:23,30-37,422,482`, `setup.ts:42,59,746,774`, `update.ts:36,2510`, `uninstall.ts:72,85-93,3580-3582,3729`, and **`src/genie-commands/install-promote.ts`** — `:19` (`acquireLifecycleLease as acquireCodexLifecycleLease` from `codex-lifecycle-lease.js`), `:52` (`releaseOrderedLifecycleLeases`), the `codexLease` lifetime at `:270-297` (the acquire itself is `:290`) and the release at `:365`. `install-promote.ts` survives Wish B and is not named anywhere else in this plan, so it is the one that silently breaks. Also update **`src/lib/genie-home-permissions.test.ts`**, whose `SCAN_EXEMPTIONS` name two files this group deletes — `src/lib/codex-lifecycle-lease.ts` (`:190`) and `src/lib/codex-activation-persistence.ts` (`:192`) — plus the prose reference to `codex-lifecycle-lease.test.ts` at `:14`; a dangling exemption key is a lint failure, not a leftover.
4. Delete the Codex activation convergence from `src/genie-commands/update.ts` (the action-required `2` arm of `applyConvergenceExitSignal`, the post-delivery Codex arms) **without** changing the skills-channel exit-1 behavior Wish A's G1 fix loop established, and delete the Codex arms of `install.ts` / `update-integrations.ts`.
5. Delete the Codex **role-agent transaction engine** from `src/lib/runtime-integrations.ts`: the `CODEX_AGENT_*` prefixes (`:1123-1126`), the inventory writer around `:709,881,1208,1246-1248`, and the `plugins/genie/codex-agents/*.toml` byte-binding and bundle-root discovery at `:554,571,723,2308` — all of which break the moment `codex-agents/` is deleted. **Keep** `inspectCodexAgentOwnership` and `removeCodexPluginRegistration`: Group 2's retirement module imports both (`legacy-integration-retirement.ts:85`).
6. **All `doctor.ts` surgery, one owner** (Decision 10). Delete: `Codex Genie plugin` (`:723,731,749`), `Codex Genie role agents` (`:783`), `Codex Genie plugin payload` (`:934`), `Codex hook review` (`:984`), the hook-manifest reads at `:1141-1143`, the `label = 'plugins/genie'` at `:2099`, the Kimi manifest handling (`minKimiDispatchTimeout`, the `.kimi-plugin` probe), and every `agent sync` check (`:1700,1709,1720,1739,1762,1767,1782,1788,1804,1817,1829,1858,1865,1903,1906,1911,2175` — note `:2175` emits the bare name `'agent sync'` with no trailing colon, so a `git grep "agent sync:"` sweep alone will miss it; grep `agent sync` unanchored). **Keep**: `genie on PATH`, `git present`, `inside a git repository`, `genie.db`, `skills present`, `skills: channel`, `legacy integrations`, `bun present`, `Codex CLI`, `Codex Genie MCP registration`, `Codex project context`, `Codex Genie MCP capability` (all three MCP checks are dual-mode's, design OUT), `obsolete Genie OTel exporter`, `preferred agent runtime`, `CLAUDE_CODE_SUBAGENT_MODEL override`, both `v4 residue` checks, `orchestration authority`, `Orca compatibility` (its dynamic import at `:2498` stays), and the worktree / index-lane checks. Re-point `doctor.ts:20-34`'s `agent-sync.js` import to Group 2's homes and drop what is now unused. Preserve the invariant that `acquireLifecycleLease` never appears in `doctor.ts` (`doctor.test.ts:2559-2562`).
7. **Rewrite `genie uninstall`** (3,731 lines today). New contract: (a) delete the recorded inventory skill dirs from the recorded `agentDirs`, honoring `isSafeSkillName` and refusing anything that is not a real directory it recorded; (b) remove the install record; (c) run `runLegacyIntegrationRetirement` for leftovers; (d) remove the binary and the existing v4/legacy collectors, **including** the classifier-only `.codex/skills/.curated` collector — a legacy directory a very old Genie may have left, which uninstall still collects and sync must never recreate; (e) drop the whole `agent-sync.js` import block (`uninstall.ts:35-60`) and the flat-agent-transaction machinery. Foreign skills in the same dirs stay untouched, and Group 1's `collisions[]` are reported with their backup root, not restored.
8. Delete `plugins/genie/.codex-plugin/plugin.json`, `plugins/genie/codex-agents/*.toml` (7 role profiles), `plugins/genie/references/codex-integration-map.md`, and root `.agents/plugins/marketplace.json` — **and, in the same commit** (Decision 11), delist them from `scripts/build-binary.sh:118-120,131`, `scripts/release-payload-version.ts:19,39` plus `verifyCodexMarketplaceEntry` itself (`:90-101`) and its call sites (`:127`, `:180`), `scripts/version.ts:201`, `scripts/release-guard.sh:164`, `.github/workflows/build-tarballs.yml:71` (the `.agents/plugins/marketplace.json` path filter), and the `.agents` entry of `AUX_LAYOUT_DIRS` (`install.ts:78`, `update.ts:3666-3672`). Fix whichever of `scripts/release-payload-version.test.ts`, `version-format.test.ts`, `version-ci-staging.test.ts`, `release-docs.test.ts` and `runtime-integrations.test.ts:359` the edit breaks; if an assertion binds `version.ts` and `version.yml` together, do both in the same commit.
9. Delete `scripts/codex-plugin-only-smoke.ts`, `scripts/codex-debug-discovery-smoke.ts`, `scripts/codex-smoke-harness.ts`, the `smoke:codex` / `smoke:codex-discovery` entries in `package.json`, **and the `codex-smoke` job in `.github/workflows/ci.yml` (`:178-211`) that invokes them** (Decision 7). `scripts/generate-codex-fallback-allowlist.ts` and `scripts/verify-codex-activation-payload.ts` are **not** deleted here: the former is imported by `src/lib/agent-sync.test.ts:49` (Group 5), the latter is invoked by `scripts/build-binary.sh:223` on every tarball build (Group 6).
10. **Two release-gate consumers survive; give their shared primitives a real home.** Three modules on this group's deletion list are consumed by code that is *not* Codex-plugin code and that a required `publish.needs` edge invokes. Deleting them is green under `check` and red in the release workflow — the exact Decision-7 failure mode.

    **(a) `genie update --publish-local-delivery` survives.** `src/genie-commands/local-delivery-repair.ts` implements it: `update.ts:113` imports `assertLocalDeliveryRepairEnabled` / `materializeLocalDeliveryRepair`, `:1543` declares the `'publish-local-delivery'` mode, `:1586,1588` parse and reject its argv combinations, and `:1895` dispatches it. The real invocation is **`release-publish.yml:1336`** (`output="$(run_genie update --publish-local-delivery "$request" 2>&1)"`) inside `release-update-path-smoke`; `:1351` is only the `printf` that echoes the outcome, not a second run. `scripts/workflow-yaml-parse.test.ts:173` asserts the literal, and `release-update-path-smoke` is a `publish.needs` edge (`release-publish.yml:1623`) C7 requires to remain.

    **(b) `scripts/verify-delivery-evidence-pack.ts` survives.** It imports `type DeliveryEvidenceDescriptor`, `verifiedDeliveryEvidenceFacts` and `verifyDownloadedDeliveryEvidence` from `../src/lib/codex-delivery-evidence.ts` (`:4-8`), and it is invoked by **two** surviving `publish.needs` edges: `delivery-evidence-compatibility` (`release-publish.yml:556`) and `release-update-path-smoke` (`:1198`). It is asserted by `scripts/release-docs.test.ts:253` and `scripts/workflow-yaml-parse.test.ts:180`, and its own test is run by `release-publish.yml:1570`. Neither the script nor its test is deleted.

    **(c) The binary promotion path in `update.ts` survives.** `update.ts:25` imports `{ parseReleaseVersion, scanPhysicalTree }` from `../lib/codex-activation.js` and uses both inside `proveExtractedDeliveryCandidate` (`:2065-2076`), reached from `proveCandidateFromTarball` (`:2054-2062`) and from the promotion path at `:3150`. `scanPhysicalTree` is *defined* in `codex-activation.ts:1277`; `parseReleaseVersion` is defined in the leaf `codex-release-version.ts` and merely **re-exported** by `codex-activation.ts:91`. **The plan's earlier claim that `local-delivery-repair.ts` is `codex-release-version.ts`'s only surviving consumer was false** — `update.ts` consumes it too, transitively.

    **Decision: create two small surviving leaf modules rather than inlining into either consumer.**
    - **`src/lib/release-payload-proof.ts`** — `parseReleaseVersion` (with `RELEASE_VERSION_RE`, `ParsedReleaseVersion`, `compareReleaseVersions` and `stripControl` if they travel with it) and `scanPhysicalTree` (with `PhysicalTreeReport`), moved **verbatim** from `codex-release-version.ts` and `codex-activation.ts:1277`. Consumers: `update.ts:25`, `local-delivery-repair.ts`, and any test re-pointed below. Move the corresponding describe blocks out of `codex-release-version.test.ts` / `codex-activation.test.ts` into `release-payload-proof.test.ts`.
    - **`src/lib/delivery-evidence-verify.ts`** — `DeliveryEvidenceDescriptor`, `verifiedDeliveryEvidenceFacts`, `verifyDownloadedDeliveryEvidence`, plus the `DeliveryEvidenceChannel` / `DeliveryEvidencePlatformId` unions and whatever private helpers they need, moved verbatim out of `codex-delivery-evidence.ts` (957) before the rest of that file is deleted. Consumers: `scripts/verify-delivery-evidence-pack.ts:4-8` and `local-delivery-repair.ts`. Move the matching describe blocks into `delivery-evidence-verify.test.ts`.

    Keep them **two** modules, not one: one is release-version/tree grammar consumed by the update path, the other is evidence verification consumed by a release script; merging them would give the smaller a dependency it does not have. If the move proves the two sets genuinely share private helpers, collapse to one module and **say so in the PR** — do not decide it silently.

    `local-delivery-repair.ts`'s remaining import, `import type { PinnedManifest } from './codex-delivery-repair.js'`, is a **type** only: inline it into `local-delivery-repair.ts`.

    After the rehome, `git grep -n "codex-" -- src/genie-commands/local-delivery-repair.ts scripts/verify-delivery-evidence-pack.ts` returns nothing, and `git grep -n "codex-activation\|codex-release-version" -- src/genie-commands/update.ts` returns nothing. Verify in the same commit that `repairMissingDelivery` — named in `local-delivery-repair.ts`'s header comment as where production verification happens — either survives or has its role reassigned, and record which; do not leave the header describing a deleted function.

11. **Mandatory importer sweep — no module leaves without one.** Round-2 review found H6 and H7 because the plan fixed *instances* rather than the *class*: this group deletes twelve modules and named no sweep. Before writing the deletion commit, run the sweep below for **every** basename this group removes and paste the raw output in the PR:

    ```bash
    for m in codex-activation codex-activation-executor codex-activation-persistence \
             codex-delivery-evidence codex-doctor-observation codex-host-observation \
             codex-lifecycle-lease codex-lifecycle-truth codex-release-version \
             codex-delivery codex-delivery-repair codex-rollback; do
      echo "=== $m ==="
      git grep -n "$m" -- src scripts tests .github package.json
    done
    ```

    Classify **every** hit as exactly one of `deleted-here` / `rehomed-here (→ target module)` / `survives (unchanged)`. A hit that is none of the three is an unplanned break and must be reported, not guessed at. The same sweep is mandatory in Group 4 for `src/hooks/**` (and `trust`, `hook-content-binding`, `sync-plugin-skills`, `council-workflow-lint`, `hook-bundle-parity`, `hook-budgets-lint`, `plugin-executables-check`) and in Group 5 for `agent-sync`, `hermes-skills-config` and `generate-codex-fallback-allowlist`.

12. **Re-point every test that imports a deleted module — including the two this group's own acceptance runs.**
    - `src/genie-commands/doctor.test.ts:2325-2332` imports `CanonicalFact`, `CodexActivationSnapshot`, `FamilyWitness`, `PhysicalCacheFact`, `QueryFact` and `parseReleaseVersion` from `../lib/codex-activation.js`. Deliverable 6's acceptance runs `bun test src/genie-commands/doctor.test.ts`, so this import must die or re-point (`parseReleaseVersion` → `release-payload-proof.js`) in **this** commit.
    - `src/genie-commands/setup.test.ts:5-15` imports `acquireLifecycleLease` / `lifecycleLockPath` from `../lib/agent-sync.js` (`:6`), `ActivationExecutionResult` from `../lib/codex-activation-executor.js` (`:7`), five activation types (`:8-14`) and `parseReleaseVersion` (`:15`) from `../lib/codex-activation.js`. Deliverable 2's acceptance names `setup.test.ts`; the whole Codex half of that file leaves with `setup --codex`, and the surviving Orca mode-switch describe blocks must compile without any of those imports.
    - Also re-point or delete, with the same rule: `src/genie-commands/install-promote.test.ts` (its subject imports `codex-lifecycle-lease` at `install-promote.ts:19`), `src/genie-commands/__tests__/update-command-publication.test.ts` (the publication path deliverable 4 edits), `scripts/build-delivery-evidence.test.ts` and `scripts/materialize-release-subjects.test.ts` — **both moved here from Group 6 deliverable 10**, because the subjects they exercise are edited by *this* group's deletions and a G6-scheduled fix leaves three waves of red. `scripts/verify-delivery-evidence-pack.test.ts` is **kept and re-pointed** at `delivery-evidence-verify.js`, never deleted (`release-publish.yml:1570` runs it).

13. **Classify every file under `tests/integration/` and `tests/support/` — no file left unadjudicated.**

    | File | Disposition |
    |------|-------------|
    | `tests/integration/codex-lifecycle-pty.test.ts` | **deleted here** (already in deliverable 1) |
    | `tests/integration/codex-app-server-cwd.test.ts` | **deleted here** — imports `codex-host-observation.js` (`:36`) and `../support/codex-cwd-evidence.js` (`:38`) |
    | `tests/integration/codex-delivery-bootstrap.test.ts` | **deleted here** — imports `codex-delivery-repair.js` (`:20`), `codex-activation.js` (`:26-27`), `codex-delivery-evidence.js` (`:28`) |
    | `tests/integration/codex-lifecycle-race.test.ts` | **deleted here** — imports `agent-sync.js` (`:20`) and `codex-lifecycle-lease.js` (`:21`) |
    | `tests/integration/install-exit2-propagation.test.ts` | **deleted here** — imports `codex-delivery.js` (`:33`) |
    | `tests/support/codex-lifecycle-test-runner.ts` | **deleted here** — imports `codex-activation-executor.js` (`:26`) and `codex-delivery-evidence.js` (`:30`); its two invokers are `codex-lifecycle-pty.test.ts:43` (deleted here) and `scripts/codex-smoke-harness.ts:77` (deleted by deliverable 9), plus `tests/support/codex-dogfood-fixture.ts:46` (deleted by G6) |
    | `tests/support/codex-cwd-evidence.ts` | **deleted here** — its only consumer is `codex-app-server-cwd.test.ts:38`, deleted above |
    | `tests/support/codex-app-server-transport.ts` | **deleted here** — its only consumer is `codex-cwd-evidence.ts:26`, deleted above; it imports nothing from `src/` |
    | `tests/integration/codex-project-route-migration.test.ts` | **OUT — kept byte-unchanged.** It imports nothing from `src/`; it spawns `genie` and asserts the `genie mcp has been retired` message and the project-route migration. That is MCP surface, which this wish lists under OUT and `genie-dual-mode-orca-plugin` owns. |
    | `tests/support/codex-dogfood-{harness,harness.test,entry-runner,fixture}.ts` | **deleted by Group 6** (deliverable 7), not here |
    | `tests/integration/check-action-pins-matcher.test.ts` | **survives** — no `src/` import, action-pin lint only |
    | `tests/support/update-current-boundary-runner.ts` | **survives** — imports only `src/lib/version.js` |
    | `tests/support/update-publication-failure-runner.ts` | **survives** — imports only `src/genie-commands/update.js`; confirm deliverable 4's `update.ts` surgery keeps `LatestManifest` and `updateCommand` exported |
    | `tests/integration/install-from-gh-releases.sh` | **survives** — shell, no TypeScript import |


**Acceptance Criteria:**
- [ ] `git grep -n "codex-activation\|codex-lifecycle-lease\|codex-delivery\|codex-rollback\|codex-host-observation\|codex-doctor-observation\|codex-lifecycle-truth\|codex-release-version" -- src scripts` returns nothing — including from `src/genie-commands/local-delivery-repair.ts`.
- [ ] `genie update --publish-local-delivery` still parses, still gates on `GENIE_RELEASE_DOGFOOD`, and still exits 2 with `activation-pending` / `deliveryComplete == true` on the smoke's fixture; `bun test src/genie-commands/local-delivery-repair.test.ts scripts/workflow-yaml-parse.test.ts` green with `workflow-yaml-parse.test.ts:173` and `:180` unchanged.
- [ ] `bun scripts/verify-delivery-evidence-pack.ts --help` (or its bare-arg error path) runs without a missing-module error, `bun test scripts/verify-delivery-evidence-pack.test.ts scripts/release-docs.test.ts` is green, and `git grep -n "verify-delivery-evidence-pack" -- .github` still shows `release-publish.yml:556,1198,1570`.
- [ ] `bun test src/genie-commands/update.ts`'s promotion coverage plus `src/genie-commands/__tests__/update-command-publication.test.ts`, `src/genie-commands/install-promote.test.ts`, `scripts/build-delivery-evidence.test.ts` and `scripts/materialize-release-subjects.test.ts` are green **in this commit**, not deferred to G6.
- [ ] The deliverable-11 importer sweep is pasted in the PR with every hit classified `deleted-here` / `rehomed-here (→ target)` / `survives`; no hit is unclassified.
- [ ] `bun test src/genie-commands/doctor.test.ts src/genie-commands/setup.test.ts` green with no import of any deleted module (deliverable 12).
- [ ] Deliverable 13's table is reproduced in the PR against `ls tests/integration tests/support` on the wish head, with every listed file accounted for and `tests/integration/codex-project-route-migration.test.ts` proven byte-unchanged (`git diff --exit-code origin/dev -- tests/integration/codex-project-route-migration.test.ts`).
- [ ] `genie setup --help` shows no `--codex`; `genie --help` lists no delivery/rollback commands; the Orca mode switch still works (`setup.test.ts`).
- [ ] Every surviving doctor check is named in the PR with the module it depends on; `doctor --json` emits `integrationSummary` only for surfaces that still exist; `bun test src/genie-commands/doctor.test.ts` green.
- [ ] `genie uninstall`'s tests describe the record-driven contract; a foreign skill planted in a recorded dir survives; a recorded dir that is a symlink is refused.
- [ ] `bash scripts/build-binary.sh` completes locally (or its required-file loop is proven by inspection to name only existing paths), and `bun scripts/release-payload-version.ts --verify-source .` exits 0.
- [ ] No workflow job references a file this group deleted: for each deleted basename, `git grep -n "<basename>" -- .github` is empty.

**Validation:**
```bash
# Full gate: deletes shared runtime modules, rewrites two commands, edits
# package.json and a CI workflow.
bun run check
bun scripts/release-payload-version.ts --verify-source .
bun test src/genie-commands/ src/lib/
```

**depends-on:** 1, 2

---

### Group 4: delete the hook runtime and the Claude/Kimi plugin; remove six `check` gates

**Goal:** remove every hook handler, the provider-neutral dispatch runtime, the Claude marketplace plugin and the Kimi payload, and the six `check` gates that exist only to lint them — in one commit, so `check` never observes a half-deleted plugin.

**Deliverables:**
1. Delete `src/hooks/**` (27 files, 2,858 non-test lines): the six handlers (`branch-guard`, `freshness`, `identity-inject`, `omni-approval`, `git-freeze-guard`, `audit-context`), `index.ts`'s fail-closed envelope, `dispatch-command.ts`, `codex-adapter.ts`, `trust.ts`, `types.ts`, `env-identity.ts`, `shell-quoting.ts` and `__tests__/`. Remove `registerHookNamespace` from `src/genie.ts` — the import at `:25` and the call at `:187` — and the `hook` command from the CLI surface. Delete `src/term-commands/hook/trust.ts` with them: it is the quarantined `genie hook trust` CLI (its own header at `:3-4` records that it is parked and unregistered, and it imports `../../hooks/trust.js` at `:36` and re-exports `defaultTrustPath` / `readTrustFile` from it at `:207,209`), so it cannot outlive `src/hooks/`. **Delete-not-edit**, and remove its `knip.json:7` `"ignore": ["src/term-commands/hook/trust.ts"]` entry in the same commit — a knip ignore naming a nonexistent file is drift the `dead-code` gate will not catch. Also drop `src/term-commands/omni.test.ts:20-21` (`import { omniApproval } from '../hooks/handlers/omni-approval.js'` and `import type { HandlerResult } from '../hooks/types.js'`) and whatever assertions they feed, and remove `src/hooks/dispatch-command.ts` from `knip.json:3`'s `entry` array (leaving `skills/genie-orca-work/scripts/*.ts` as the sole entry). The `AskUserQuestion` empty-response carve-out leaves with the envelope — no partially deleted hook path may remain that could return a malformed response.
2. Delete the Claude plugin payload: `plugins/genie/.claude-plugin/plugin.json`, `plugins/genie/agents/*.md` (7 role agents), `plugins/genie/hooks/{hooks.json,codex-hooks.json}`, `plugins/genie/workflows/council.js`, `plugins/genie/rules/genie-orchestration.md`, `plugins/genie/scripts/**` (all seven executables plus `validate-wish.cjs`/`.test.ts`, `statusline.sh` and `src/`), `plugins/genie/skills/**` (the mirror), `plugins/genie/{settings.json,genie.ts,index.ts}`, `plugins/genie/references/**` **except** `orca-orchestration.md`, and root `.claude-plugin/marketplace.json`. **Keep `plugins/genie/plugin.json`** (it carries `extensions."dev.orca.compatibility"`), **`plugins/genie/package.json`** (version-stamped, license-asserted at `release-docs.test.ts:67,721`) and **`plugins/genie/README.md`** (read 6× in `release-docs.test.ts` — `:822,943,961,963,974,1006`) — the README is rewritten to Orca-only content, and the three content assertions at `:961,963,1006` plus the two composite reads at `:943,974` are re-pointed to whatever the rewrite says.
3. Delete the Kimi payload: `plugins/genie/.kimi-plugin/plugin.json` and its 11 command files. Its doctor handling left in Group 3; no host-side Kimi asset is ever written by genie, so migration has nothing to retire.
4. Delete `scripts/council-workflow-lint.ts`, `scripts/hook-bundle-parity.ts`, `scripts/hook-budgets-lint.ts`, `scripts/hook-content-binding.ts`, `scripts/plugin-executables-check.ts`, `scripts/sync-plugin-skills.ts` with their tests and `scripts/fixtures/plugin-executables/`, plus `src/lib/council-workflow-stamp.test.ts` (it `require`s `plugins/genie/scripts/council-stamp.cjs` at `:20`) and `src/lib/wish-status.test.ts`'s dependency on `plugins/genie/scripts/session-context.cjs` (`:15`). **There is no `scripts/council-workflow-lint.test.ts`** — only `council-workflow-lint.ts` exists, so "with their tests" covers the five that have one; do not chase a sixth.

    **`scripts/fresh-install-smoke.ts` is the shared consumer of two of these deletions, and both cuts belong to *this* group** (it is invoked by `build-binary.sh:58`, so a dangling import here breaks every tarball build and both this group's and Group 6's acceptance runs of that script):
    - `:31` `import { assertHookContentBinding } from './hook-content-binding.ts'` — delete the import **and** the `assertHookContentBinding` call site inside the smoke (`:502-509`). This moves here from Group 6 deliverable 6, which previously owned it. (`:32` is `import { validateSkillMetadata } from './skills-lint.ts'` — a **survivor**; do not touch it.)
    - `:33` `import { SHIPPED_SKILL_NAMES, assertPluginSkillsInSync } from './sync-plugin-skills.ts'` — `SHIPPED_SKILL_NAMES` (`sync-plugin-skills.ts:36-62`, **25** entries at `dev` head after #2870) must be re-pointed at `skills/*/SKILL.md` rather than deleted into a dangling import, and `assertPluginSkillsInSync` removed with its **two real call sites** — `version.ts:250` (a function call, imported at `version.ts:40`) and `fresh-install-smoke.ts:493`. **`build.js:54` is not a call site**: it is `execFileSync('bun', [.../sync-plugin-skills.ts, '--check'])`, a subprocess spawn, and `build.js:55` spawns `fresh-install-smoke.ts`, which survives — so `build.js` needs the `:54` line deleted and the `:55` line left alone. (G6 deletes `build.js` outright; this group must still not leave it spawning a script that no longer exists.)
5. Strip the plugin-scripts coupling from files that survive: `src/lib/agent-sync.ts:4794` (council-stamp byte-parity) and `:519,5555,5762,6476` (plugin-root discovery) plus `agent-sync.test.ts:88`; `.github/workflows/build-tarballs.yml` path filters `:62` (hook-bundle-parity), `:64` (hook-content-binding), `:65` (plugin-executables-check), `:66` (sync-plugin-skills) and `:72` (`.claude-plugin/marketplace.json`) — `:63` `orca-bundle-parity`, `:67` `fresh-install-smoke` and `:68` `skills-lint` stay; **all five sibling gate steps in `.github/workflows/ci.yml`**, not just one — `Council workflow lint` (`:120-121`), `Generated hook bundle parity` (`:123-124`), `Codex hook launcher content binding` (`:129-130`), `Shipped plugin executable static checks` (`:132-133`) and `Plugin skill mirror + Kimi command orphan check` (`:135-136`), leaving `Native Orca bundle parity` (`:126-127`) and `Fresh-install smoke` (`:138-139`) in place; `scripts/build-binary.sh:57,59,61,62` and its required-file entries `:129-130,135-137` and per-skill mirror assertions `:141-148`; `scripts/build.js:54,123-124,132-146`; `biome.json:56-57`; `.coderabbit.yaml:22`. Delist `plugins/genie/.claude-plugin/plugin.json` and `.kimi-plugin/plugin.json` from `release-payload-version.ts:18,20,38,40`, `version.ts:200,202,207`, `release-guard.sh:163,165` and `version.yml:196-198` (Decision 11), and remove `assertPluginSkillsInSync()` from `version.ts:250` and `build.js:54`.

    **Two prose sites Group 5 previously claimed, moved here** because their content is plugin-scripts / hooks-manifest prose and has nothing to do with agent-sync: `src/genie-commands/legacy-v4.ts:81` (the src-proof comment `grep -rn <name> src/ scripts/ plugins/genie/scripts/`) and `src/types/genie-config.ts:108` (`` `.claude/settings.json` / `plugins/genie/hooks/hooks.json` ``). Both name trees this group deletes, so this group owns them; they are removed from Group 5 deliverable 4's list.

    **`scripts/release-docs.test.ts` literal updates, same commit as the deletions** — the file enumerates these scripts by string and will fail the moment they are gone: the workflow script list at `:508` (`'scripts/hook-bundle-parity.ts'`), `:510` (`'scripts/hook-content-binding.ts'`), `:511` (`'scripts/plugin-executables-check.ts'`) and `:512` (`'scripts/sync-plugin-skills.ts'`) — `:509` `'scripts/orca-bundle-parity.ts'` and `:513` `'scripts/fresh-install-smoke.ts'` stay; the `build-binary.sh` content assertions at `:695` and `:697` (`:696` orca-bundle-parity stays); and the plugin-executables gate block at `:744-748` (`check` / `check:fast` contain `bun run lint:plugin-executables` at `:744-745`, the `'--strict'` read at `:746-747`, and the `error TS7006` read of the deleted test at `:748`) — delete that whole assertion group rather than re-pointing it.
6. **`package.json` surgery in the same commit**: drop `lint:council-workflow`, `lint:hook-bundles`, `lint:hook-budgets`, `lint:hook-content`, `lint:plugin-executables`, `lint:plugin-skills` and `hooks:bind`, and remove all six from **both** `check` and `check:fast`. Everything else stays byte-identical. **The two compositions do not end at the same length**: at `dev` head `check` runs **14** steps (`typecheck`, `lint`, `dead-code`, `skills:lint`, `wishes:lint`, `lint:complexity-budget`, `lint:council-workflow`, `lint:hook-bundles`, `lint:orca-bundle`, `lint:hook-budgets`, `lint:hook-content`, `lint:plugin-executables`, `lint:plugin-skills`, `bun test`) and `check:fast` runs **13** — the same list without `bun test`. Removing six leaves `check` at **eight** (`typecheck`, `lint`, `dead-code`, `skills:lint`, `wishes:lint`, `lint:complexity-budget`, **`lint:orca-bundle`**, `bun test`) and `check:fast` at **seven** (the same seven minus `bun test`).
7. Before deleting `plugins/genie/scripts/src/validate-wish.ts` and `wish-template-text.d.ts`, paste `diff` of each against Group 2's `scripts/` copy in the PR. **The expected result is not byte-identity for `validate-wish.ts`**: the copy moved three directories up, so its two cross-tree specifiers must differ and nothing else may. The accepted delta is exactly two lines — `'../../../../src/lib/wish-status.js'` → `'../src/lib/wish-status.js'` (`:42`) and `'../../../../skills/wish/templates/wish-template.md'` → `'../skills/wish/templates/wish-template.md'` (`:43`). Any third hunk fails this criterion. `wish-template-text.d.ts` has no relative imports and **must** be byte-identical.
8. The generated-SessionStart parity contract (`plugins/genie/scripts/src/session-context.ts` → `session-context.cjs`, enforced by `hook-bundle-parity.ts`) leaves with the files it guards; record in the PR that this release gate is intentionally retired.
9. **Minimum docs edit** (Decision 12): `AGENTS.md:22` names `plugins/genie/references/native-surfaces.md`, pinned by `src/__tests__/claude-md-drift.test.ts:61`. Update both. Nothing else in CLAUDE.md/AGENTS.md/README is touched here.
10. **Mandatory importer sweep** (same contract as Group 3 deliverable 11, applied to this group's basenames). Before the deletion commit, run and paste:

    ```bash
    for m in src/hooks council-workflow-lint hook-bundle-parity hook-budgets-lint \
             hook-content-binding plugin-executables-check sync-plugin-skills \
             council-stamp session-context validate-wish term-commands/hook; do
      echo "=== $m ==="
      git grep -n "$m" -- src scripts tests .github package.json knip.json biome.json .coderabbit.yaml
    done
    ```

    Every hit is classified `deleted-here` / `rehomed-here (→ target)` / `survives`. The round-2 review's root cause was fixing named instances instead of sweeping the class; this group deletes more files than Group 3 and gets the same discipline. Pay particular attention to non-`src/` consumers — `.github/workflows/**`, `package.json`, `knip.json`, `biome.json`, `.coderabbit.yaml` and `scripts/*.sh` — which `bun run check` cannot see.

**Acceptance Criteria:**
- [ ] `git grep -n "src/hooks\|hook dispatch\|CLAUDE_PLUGIN_ROOT\|LENS_ROOT" -- src scripts package.json` returns nothing.
- [ ] `ls plugins/genie` shows only the Orca tree plus `plugin.json`, `package.json`, `README.md` and `references/orca-orchestration.md`.
- [ ] `bun run check` is green with exactly **eight** steps and `bun run check:fast` with exactly **seven** (`check:fast` is `check` minus `bun test`, both before and after this group).
- [ ] `git grep -n "src/term-commands/hook" -- . ':!*.md'` returns nothing, `knip.json` names no deleted path, and `bun run dead-code` is green.
- [ ] `bun scripts/fresh-install-smoke.ts` runs standalone with no import of `hook-content-binding.ts` or `sync-plugin-skills.ts` (only `./skills-lint.ts` remains), and `bun test scripts/release-docs.test.ts` is green.
- [ ] The deliverable-10 importer sweep is pasted in the PR with every hit classified; `scripts/build.js` spawns no deleted script (`:54` gone, `:55` intact).
- [ ] `git grep -n "lint:council-workflow\|lint:hook-\|lint:plugin-" -- . ':!*.md'` returns nothing, including `.github/workflows` and `.husky`.
- [ ] `bash scripts/build-binary.sh` completes and its required-file loop names only existing paths.

**Validation:**
```bash
# Full gate plus both compositions: this group redefines what `check` means and
# edits CI-visible scripts.
bun run check
bun run check:fast
bun test
```

**depends-on:** 3

---

### Group 5: delete Hermes, pi and `agent-sync.ts`; slim `runtime-integrations.ts`

**Goal:** remove the last two per-agent integrations and the 6,733-line sync engine, leaving `runtime-integrations.ts` with only what consent, retirement and the surviving commands consume.

**Deliverables:**
1. Delete `plugins/hermes-genie/**` (19 files, Python plugin + tests) and `plugins/pi-genie/**` (7 files), and `src/lib/hermes-skills-config.ts` (728) + its test — its tier-3 resolution path is `$GENIE_HOME/plugins/genie/skills` (`:15`), the mirror Group 4 deleted. **Keep `src/lib/hermes-mcp-config.ts`** (66 lines): `legacy-integration-retirement.ts:84` imports `retireMcpServersGenie` from it and the retirement module outlives this wish. Delist `plugins/pi-genie/package.json` from `version.ts:205` and `release-guard.sh:167`, and `plugins/hermes-genie/plugin.yaml` from `version.ts:208` and `version.yml:204`.
2. Delete `src/lib/agent-sync.ts` (6,733) and `src/lib/agent-sync.test.ts` (5,305), plus `scripts/generate-codex-fallback-allowlist.ts` (imported at `agent-sync.test.ts:49`; its other consumer left with Group 3). By this point the only remaining non-shim importer is `update.ts:23`'s `runAgentSync` — delete that call chain (`update.ts:1764-1810`, `:2702-2799`, `:2873`) including the `~/.genie/.last-agent-sync` throttle marker and the `agent-sync: no genie plugin source found` probe at `:2783`, and delete `src/lib/ordered-lifecycle-leases.ts` or its remaining agent-sync coupling if nothing else uses it.
3. **Slim `src/lib/runtime-integrations.ts`** (4,348). Keep, with a named consumer for each: `IntegrationSelection` and the consent read/write (`install.ts`, `update.ts`, `skills-installer.ts:44-49`); `CommandRunner` / `CommandResult` / `runBoundedIntegrationCommand` (`skills-installer.ts`); `removeCodexPluginRegistration` + `planCodexPluginRegistrationRemoval` and `inspectCodexAgentOwnership` (`legacy-integration-retirement.ts:85`); `inspectRuntimeIntegrationEvidence` (retirement acceptance + doctor); the `migrateDeadGenieOtel` seam (`codex-config.ts`). Delete: the Codex fallback classification/retirement API, `inspectManagedSkillTree` payload verification, `CANONICAL_GENIE_SKILL_NAMES`, the `agent-sync.js` import block at `:25-39`, and any symbol whose only consumer is a test that dies with it.
4. Remove the now-obsolete `SCAN_EXEMPTIONS` entry in `src/lib/genie-home-permissions.test.ts` — Group 2 made it content-anchored; with `agent-sync.ts` gone it must be deleted, not left dangling — and the stale `agent-sync` prose in `lifecycle-lease.ts:6-7,81,124,145,153,213`, `atomic-fs.ts:2,5,7`, `genie-home.ts:4`, `skills-installer.ts:17,360`, `install.ts:249,372,386,424,428,487-492`, `uninstall.ts:1099,1455,1559,1630,1641,1765,3496,3551,3586,3721-3722`, `setup.ts:39,731,750-751`. **`legacy-v4.ts:81` and `types/genie-config.ts:108` are not in this list**: their content is `plugins/genie/scripts/` and `plugins/genie/hooks/hooks.json` prose, not agent-sync, and Group 4 deliverable 5 owns them.
5. **Mandatory importer sweep** (same contract as Group 3 deliverable 11). Before the deletion commit, run and paste:

    ```bash
    for m in agent-sync hermes-skills-config generate-codex-fallback-allowlist \
             ordered-lifecycle-leases hermes-genie pi-genie; do
      echo "=== $m ==="
      git grep -n "$m" -- src scripts tests plugins .github package.json knip.json
    done
    ```

    Every hit classified `deleted-here` / `rehomed-here (→ target)` / `survives`. `agent-sync.ts` is the largest module in `src/` and its re-export shim from Group 2 will hide consumers from a naive symbol grep — sweep the **module path**, not only the symbol names, and treat every prose mention as a hit that must be classified too (acceptance criterion 1 already requires prose to be clean).
6. **Keep `src/lib/codex-config.ts`** (42 lines): `DEAD_GENIE_OTEL_EXPORTER`, `getCodexConfigPath`, `getCodexHome` and `migrateDeadGenieOtel` are consumed by the surviving doctor OTel check and by `runtime-integrations.ts:3813`. The design's "folds into retirement" note was never executed in Wish A and is not executed here.

**Acceptance Criteria:**
- [ ] `git grep -rn "agent-sync" -- src scripts plugins package.json` returns nothing, prose included.
- [ ] Every remaining export of `runtime-integrations.ts` is named in the PR with its consumer; `bun run dead-code` clean.
- [ ] `genie update` still runs skills-channel convergence then retirement under the lifecycle lease, with no agent-sync step and no throttle marker; `src/genie-commands/__tests__/update.test.ts` re-pointed and green.
- [ ] `bun test src/lib/legacy-integration-retirement.test.ts` green — the retirement module compiles against Group 2's absorbed primitives with no `agent-sync` import.
- [ ] `bash scripts/build-binary.sh` completes; `bash scripts/release-guard.sh` green.
- [ ] The deliverable-5 importer sweep is pasted in the PR with every hit classified.

**Validation:**
```bash
# Full gate: deletes the largest module in src/ and rewrites the update path.
bun run check
bun test
```

**depends-on:** 4

---

### Group 6: build/release toolchain and the release workflow (C11)

**Goal:** make the whole toolchain address `plugins/genie` as the Orca tree plus `skills/`, and replace the Codex dogfood matrix with the two smokes Wish A proved — the one group whose failures never surface in `bun run check`.

**Deliverables:**
1. `scripts/build-binary.sh`: stage only the Orca tree plus `skills/`. `:76-77` copy whole trees and survive; delete the marketplace staging at `:118-120`, whatever remains of the required-file loop `:127-139` beyond the two Orca entries (`:133-134`), the per-skill mirror assertions `:141-148`, and the `--plugin-root` argument at both `fresh-install-smoke` call sites (`:150-152`, `:216-218`). Remove the `verify-codex-activation-payload.ts` call at `:223-224` and delete that script, its test, its `build-tarballs.yml:70` path filter, and the `release-docs.test.ts:816,887,891` assertions.
2. `scripts/release-payload-version.ts`: `TOP_LEVEL_VERSION_FILES` (`:16-22`) and `COMMITTED_VERSION_FILES` (`:35-41`) reduce to `package.json`, `plugins/genie/package.json` and `plugins/genie/orca-plugin.json` (the latter stays excluded from the committed gate per `:24-34`); the `verifyCodexMarketplaceEntry` throw (`:88-99`) and its two call sites (`:127`, `:180`) are gone with `.agents/plugins/marketplace.json`; the `.claude-plugin/marketplace.json` stamping (`:138-144`) and `.agents` stamping (`:146-149`) go with their files; `--verify-source` (`:190-197`) keeps working for `build-binary.sh:63` and `build-tarballs.yml`.
3. Same reduction in `scripts/version.ts:198-208`, `.github/workflows/version.yml:194-204`, and `scripts/release-guard.sh:161-172`. `version.yml`'s "expected exactly nine version files" error at `:272` becomes the new count, and `scripts/release-docs.test.ts:63-77` plus the `CLAUDE.md:186` sentence follow (Decision 12).
4. **`scripts/version.ts --check`**: a read-only mode that reports the bump targets and exits 0 without writing. Today `main()` (`:249-260`) reads no `process.argv` at all and every invocation performs a real bump, so C11 has no runnable verification without it. Never run the bare command as validation.
5. Delete `scripts/build.js` and `scripts/sync.js` with their `build:plugin`, `build-and-sync` and `sync` entries: after Group 4 both compile targets (`build.js:22-23`) and every stamping step are gone, and `sync.js` copies the plugin into `~/.claude/plugins/genie`, which no longer exists. `lint:orca-bundle` (`scripts/orca-bundle-parity.ts`) is the Orca bundle's builder and stays.
6. `scripts/fresh-install-smoke.ts`: delete `checkPluginLayout` (`:487-511`), `checkSourceCopy`/`checkCacheCopy` (`:514-536`), `resolvePluginSkills` (`:410-426`), `checkStarterPrompts` (`:428-440`), `checkPluginMcpLayout` (`:442-456`), `checkClaudePluginMcpLayout` (`:458-469`), `checkH3SessionStartCommand` (`:471-485`), `checkCodexRoleProfiles` (`:182-221`), `checkClaudeRoleAgents` (`:223-256`), the `--plugin-root` parsing (`:119-142`) and the `", 7 Codex + 7 Claude role profiles"` summary (`:606-609`); derive the inventory from `skills/*/SKILL.md` and keep the skills-only checks (`:596-600`) plus the negative source-path assertion at `:279-283`, extended to also forbid `$GENIE_HOME/plugins/genie/skills`. **The `hook-content-binding` import (`:31`) and its `assertHookContentBinding` call site (`:502-509`) are removed by Group 4, not here** — `build-binary.sh:58` runs this script, so the import cannot outlive Group 4's deletion of `scripts/hook-content-binding.ts`; both groups run `bun scripts/fresh-install-smoke.ts` (directly or via `build-binary.sh`) as acceptance, and Group 4's run is the first that would fail. This deliverable therefore starts from a smoke whose only surviving script import is `validateSkillMetadata` from `./skills-lint.ts` (`:32`).
7. `.github/workflows/release-publish.yml`: delete `codex-native-dogfood` (`:562`, name `Codex standalone task/board dogfood / ${{ matrix.platform }}`) and `codex-dogfood-completeness` (`:741`), and remove `codex-dogfood-completeness` from `publish.needs`. **`publish.needs` (`release-publish.yml:1617`) carries seven edges today** — `admit` (`:1618`), `attest-delivery-evidence` (`:1619`), `delivery-evidence-compatibility` (`:1620`), `codex-dogfood-completeness` (`:1621`), `skills-install-smoke` (`:1622`), `release-update-path-smoke` (`:1623`) and `stable-release-security-gate` (`:1624`). **Exactly one — `codex-dogfood-completeness` (`:1621`) — is removed; the other six all remain**, and each also has a matching `needs.<job>.result == 'success'` guard in the `if:` expression below (`:1632` for `skills-install-smoke`), which must be deleted for the removed edge and left untouched for the six survivors. `release-update-path-smoke` in particular stays and keeps depending on `genie update --publish-local-delivery` (G3 deliverable 10), and `stable-release-security-gate` stays and keeps consuming `scripts/candidate-dogfood-matrix.ts` (deliverable 7 below). Delete `tests/support/codex-dogfood-harness.ts` (+ entry-runner, fixture, test) and `scripts/validate-live-dogfood-evidence.ts` and `scripts/validate-dogfood-matrix-evidence.ts` with their tests, in the same commit (Decision 7). **`scripts/candidate-dogfood-matrix.ts` is not a free deletion**: `release-publish.yml:288,354` (`prepare-delivery-evidence`) and `:1480` (`stable-release-security-gate`, which *is* in `publish.needs`) consume it. Either keep it and delete only its dogfood-matrix consumers, or rework those two jobs in this same commit and update `release-docs.test.ts:288` and `workflow-yaml-parse.test.ts:162`. Decide explicitly and record the choice.
8. `scripts/build-delivery-evidence.ts` needs no edit (`:227` digests the whole `plugins/genie` tree; `:119` only requires it to be a physical directory) — verify and record rather than assuming. `release-update-path-smoke:1232-1240` is likewise tree-level and survives. Note for anyone grepping this job: `release-publish.yml:1336` is the real `genie update --publish-local-delivery` invocation and `:1351` is only the `printf` echoing its exit — do not count them as two runs.
9. **Keep `scripts/run-musl-dogfood.sh` and `.github/workflows/musl-adapter-smoke.yml` byte-unchanged** — both are confirmed free of any `plugins/genie` reference, and `release-update-path-smoke` uses the adapter for its musl leg.
10. Re-point every test the above breaks: `scripts/release-payload-version.test.ts`, `release-guard.test.ts`, `release-docs.test.ts`, `version-format.test.ts`, `version-ci-staging.test.ts`, `workflow-yaml-parse.test.ts`, and anything `git grep -l "plugins/genie" -- '*.test.ts'` still names. **`scripts/build-delivery-evidence.test.ts` and `scripts/materialize-release-subjects.test.ts` moved to Group 3 deliverable 12** — their subjects are edited by G3's deletions, so a G6-scheduled fix would leave three waves of red; if they still need a G6-specific edit, make it, but they must already be green on entry to this group.
11. Record in the PR that `version.yml` is a `workflow_run` workflow: its edit is inert on `dev` until promoted, so its evidence is `version-format.test.ts` / `version-ci-staging.test.ts` under `bun test` plus the first post-promotion bump on `main` (design Risk 15).

**Acceptance Criteria:**
- [ ] C11 in full, every command in the criterion run and its output pasted.
- [ ] `git grep -n "plugins/genie" -- src scripts .github package.json` returns only Orca-owned lines.
- [ ] `git diff --exit-code origin/dev -- .github/workflows/musl-adapter-smoke.yml scripts/run-musl-dogfood.sh` empty.
- [ ] `scripts/workflow-yaml-parse.test.ts` passes and no job in `.github/workflows/**` references a deleted script.
- [ ] The `candidate-dogfood-matrix.ts` decision is recorded with the two consuming jobs named.

**Validation:**
```bash
# Full gate PLUS the toolchain commands, because C11's failures are invisible
# to `check` by construction.
bun run check
bun scripts/version.ts --check
bun scripts/release-payload-version.ts --verify-source .
bash scripts/release-guard.sh
bun scripts/fresh-install-smoke.ts
bash scripts/build-binary.sh
bun test scripts/
```

**depends-on:** 5

---

### Group 7: proof

**Goal:** measure every wish-level criterion on the assembled head and produce the evidence file, rather than inferring it from the group PRs.

**Deliverables:**
1. C4: run the exact command against the wish head and against `18b85341b`, and record both totals, the delta, and the top-10 of what left.
2. C-G: `git grep -n "plugins/genie" -- src scripts .github package.json`, pasted in full.
3. C5-lite: the two greps over `skills/**`, with the 5-file Decision-7 worklist handed to Wish C by `file:line`.
4. C8: the Orca no-diff proof and the four Orca test files green.
5. C-R4: a fresh-host pass — install from the candidate tarball, measure the written homes with the dogfood evidence command, then `genie uninstall` and prove zero genie skill dirs remain under `$HOME` and the record is gone, with foreign skills untouched.
6. A full `bun run check` on the head, and the evidence file under `.genie/wishes/skills-everywhere-b/qa/`.

**Acceptance Criteria:**
- [ ] C4, C5-lite, C7, C8, C9, C11, C-G and C-R4 each carry a pasted command and its output in the evidence file.
- [ ] Any criterion that cannot be proven pre-merge (a live candidate release run) is recorded as post-merge acceptance with the named run that will prove it — never ticked on inference.

**Validation:**
```bash
bun run check
git ls-files src | grep '\.ts$' | grep -v '\.test\.ts$' | xargs wc -l | tail -1
git grep -n "plugins/genie" -- src scripts .github package.json
git diff --exit-code origin/dev -- .github/workflows/musl-adapter-smoke.yml scripts/run-musl-dogfood.sh
```

**depends-on:** 6

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] Functional: on a host with several agent CLIs present, `genie update` installs the delivered skills from the local tree, prints the real agent-dir count, and `genie doctor` reports `skills: <agent> <n>/<n> @ v<ver>` for present homes with nothing about plugins, hooks or agent sync.
- [ ] Functional: `genie uninstall` on that host leaves zero genie skill directories anywhere under `$HOME` and removes the record; unrelated skills survive.
- [ ] Integration: a host carrying the full plugin-era surface (Codex plugin, Claude marketplace + council stamp + role agents, Hermes link, pi extension, `.genie-role-agents.json`, `plugins/marketplaces/automagik`) is fully retired by one `genie update`, and the second run prints `nothing to retire`.
- [ ] Integration: the dev-channel release candidate that fires on merge runs `skills-install-smoke` and `release-update-path-smoke` green with no Codex dogfood matrix, and `musl-adapter-smoke` is unaffected.
- [ ] Regression: `genie task`, `genie board`, `genie omni`, `genie mcp`, `genie init` and the Orca mode switch behave exactly as before; `genie.db` and roadmap sync untouched.
- [ ] Regression: `genie setup --codex` and `genie hook dispatch` are gone from the CLI surface with a clear error, not a stack trace.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Wish A has not shipped stable (P2); opening the deletion waves early would delete the retirement code before hosts have run it | High | Wave 0 gate. Waves 2–6 do not open until the stable dispatch completes; wave 1 is additive and safe — and better — before it. |
| The `@ref` pin was fiction, so every host that ran Wish A's channel holds `main`'s skills, not their binary's | High | G1 switches to the local delivered tree; the next `genie update` self-heals every host. Recorded as a Wish A correction, not hidden. |
| The discovery scan is a heuristic over an arbitrary `$HOME`: it can miss a home (depth > 6, unusual name) or over-match | Medium | Union with the known-home floor so it can never record *fewer* dirs than today; byte-equality plus a birth-time window opening at the install start; caps with a warn line on fallback; uninstall only ever deletes a real directory it recorded, under a name `isSafeSkillName` accepts. |
| `--copy --all` overwrites a foreign same-named skill in a home nobody asked us to touch (Decisions 4/5) | Medium | Pre-install snapshot, backup-first copy, recorded `collisions[]`, and an operator line naming path, skill and backup root. Restoration deferred until reported. |
| `branch-guard` is gone: "agents merge to `dev` only" is no longer enforced client-side, and rulesets cannot distinguish an agent from the human whose `gh` credentials it uses | High | Accepted (design Risk 3, Decision 9). Evidence in `ruleset-main.json`; `.husky/pre-push` still blocks direct pushes to `main`; a distinct bot identity is the deferred structural fix. |
| `git-freeze-guard`, `omni-approval`, `freshness`, `identity-inject` and `audit-context` are gone | Medium / Low | Accepted (design Risks 4–6). Release notes list all five as behavior changes; the Omni queue/inbox still serves CLI-originated approvals; Orca worktree isolation replaces the freeze structurally. |
| A deletion group fixes the *named* import seams and misses the class — round 2 found `verify-delivery-evidence-pack.ts` and `update.ts`'s promotion path this way, both behind required release gates | High | Mandatory importer sweep in G3 (deliverable 11), G4 (deliverable 10) and G5 (deliverable 5): a `for`-loop grep over every deleted basename across `src scripts tests .github package.json` and the config files, with **every** hit classified `deleted-here` / `rehomed-here` / `survives` and the raw output pasted in the PR. An unclassified hit blocks the commit. |
| A 25k-line deletion across five sequential waves; one missed import seam breaks `dev` | High | Decisions 7, 8 and 11: `check` green at every boundary, no workflow-invoked file deleted without its job, no manifest deleted without delisting it from the five toolchain lists, disjoint ownership within a wave, and an independent `final-gate` after G7. |
| A toolchain break is invisible to `bun run check` (`build-binary.sh`, `release-guard.sh`, `release-payload-version.ts --verify-source` are in no `check` step) | High | G3, G4 and G5 each run `bash scripts/build-binary.sh` and `--verify-source` as acceptance, not only G6; C11 is re-run in G6 and again in G7. |
| The retirement module's absorbed primitives drag more private helpers than expected (Wish A's G4 moved ~18) | Medium | G2 deliverable 1 re-derives the consumer set first and requires a verbatim-move proof; a symbol with an unexpected surviving consumer is reported, not guessed. |
| Adding a required field to the install record would invalidate every record on disk and silently disarm uninstall | High | Decision 2: `source` and `collisions` are optional, with an explicit old-record parse test. |
| `version.yml` is `workflow_run`: its edit is inert on `dev` until promoted (2026-07-11 downgrade lineage) | Medium | G6 deliverable 11 records it; evidence is the two version tests plus the first post-promotion bump on `main`. |
| `musl-adapter-smoke.yml:123` runs `genie setup --codex` against the **previous stable** binary. It stays green while that binary predates Wish B, and breaks on the first release whose previous stable is post-Wish-B | Medium | Kept byte-unchanged here (C7 requires it). Recorded as a scheduled follow-up with a named trigger: the first stable cut after this wish ships must drop that step. Wish C's release notes carry it. |
| Wish C inherits `skills/**` files naming agents and selectors that no longer exist | Low | C5-lite guards the two hard-dangling tokens now and hands the 5-file worklist to Wish C with `file:line` detail. |

---

## Review Results

_The read-only reviewer returns evidence; the invoking orchestrator appends a timestamped block here after plan, execution, and PR reviews._

### Execution review — Group 2 — 2026-08-31T19:17:40Z — SHIP (round 1)

- Engineer/reviewer: ultracode wave-1 agents (opus/high, reviewer ≠ engineer), session 17ecb3d2. PR #2877, commits `637f9d296` `aa70a7166` `27762ebad` `1bfc2c0e4` `c3b267cef`, merged to `wish/skills-everywhere-b` at `2fc8dc82c`.
- SHIP on round 1. Three LOW residuals recorded, none blocking: rehomed `scripts/validate-wish.ts` sits outside the strict static gates (biome-ignored, outside tsconfig include); `BoundedFileRead`/`AtomicWriteOptions` types dropped from `codex-activation-persistence.ts`'s re-export surface against the literal AC wording (both types travel to `atomic-fs.ts`; G3 deletes the shim); `MANIFEST_NAME`/`PHYSICAL_TREE_IDENTITY_VERSION` landed in `atomic-fs.ts` rather than module-private per Decision 6's letter. Verbatim-move proofs, the two-line `validate-wish.ts` import delta, and the 17-surface `LEGACY_INTEGRATION_SURFACES` evidence are in the PR body.

### Execution review — Group 1 — 2026-08-31T19:17:40Z — SHIP (round 2)

- Engineer/reviewer: ultracode wave-1 agents (opus/high, reviewer ≠ engineer), session 17ecb3d2. PR #2876, commits `899c7c47e` `fe0ae41ac` + fix `8ad47783b`, merged to `wish/skills-everywhere-b` at `8f561fa9f`.
- Round 1 FIX-FIRST (3 findings, all addressed in `8ad47783b` — discovery-scan survival over a real `$HOME`); round 2 SHIP with four LOW residuals recorded, none blocking (scan-fallback path verified manually but untested through `runSkillsInstall`; freshness stamp widened to `max(birthtime, mtime)` with the parent-dir stamp ORed in — a recorded deviation, since `--copy` rewrites SKILL.md in place and the literal birthtime rule would re-orphan every prior-install home; collision candidates include every scanned home by design; one ci.yml doc-drift line).
- Recorded deviations (full list in the PR body): local `bun run check` substituted by `check:fast` + targeted suites per host OOM rule — CI runs the full gate; Wish A Status was already `SHIPPED` by #2875, so G1 added the ownership/upstream/public-path closure block only.

### Plan review — 2026-08-31T16:11:15Z — SHIP (round 3)
- Reviewer: genie:reviewer (session e7edce9e/a2686d03); rounds: 1 FIX-FIRST `3ecb6187…`, 2 FIX-FIRST `114adb57…`, 3 SHIP `e86d3f12…`. Round 3 re-ran the reviewer's own 12-module importer sweep independently: zero unnamed importers; D13 17/17 files verified line-by-line; the two new leaf modules match the real symbol sets (parseReleaseVersion is a codex-release-version leaf re-exported via codex-activation.ts:91). P2 (Wish A stable) remains the wave-0 gate — wave 1 may land before the cut, waves 2–6 may not.
- Status set to APPROVED by the orchestrator on this evidence.

### Plan review — 2026-08-31T16:01:29Z — FIX-FIRST (round 2)

- **Reviewer:** `genie:reviewer session e7edce9e/a2686d03`
- **Reviewed sha:** `114adb571a6f9edd79e204dcf657e1cd95c67dc3823bcbb2372fa3f42ea8a6b1`
- **Verdict:** FIX-FIRST (round 2)

**Root cause.** Round 1 fixed the *instances* the reviewer named and not the *class*: Group 3 deletes twelve modules and the plan carried no importer sweep, so the same defect that produced H1 reappeared twice more in code that `bun run check` cannot see. `scripts/verify-delivery-evidence-pack.ts` (`:4-8`, three symbols from `codex-delivery-evidence`) is invoked by two surviving `publish.needs` edges — `delivery-evidence-compatibility` (`release-publish.yml:556`) and `release-update-path-smoke` (`:1198`) — and asserted at `release-docs.test.ts:253` / `workflow-yaml-parse.test.ts:180` (H6); and `update.ts:25` pulls `parseReleaseVersion` + `scanPhysicalTree` from `codex-activation.js` for the **binary promotion** path at `:2054-2076` and `:3150`, falsifying round 1's "only surviving consumer" claim (H7). Alongside: two of Group 3's own acceptance tests import a module it deletes (M8), no file under `tests/` was adjudicated (M9), five test files were unnamed or scheduled three waves late (M10), and three line/mechanism references were wrong (LOWs).

**Disposition: applied in this revision.** Group 3 deliverable 10 is rewritten as a three-part survivor decision (`--publish-local-delivery`, `verify-delivery-evidence-pack.ts`, the `update.ts` promotion proof) that rehomes the shared primitives into **two new surviving leaf modules** — `src/lib/release-payload-proof.ts` (`parseReleaseVersion`, `scanPhysicalTree`) and `src/lib/delivery-evidence-verify.ts` (the three verify symbols plus the channel/platform unions) — with the two-vs-one module choice justified and its collapse condition stated. New deliverable 11 makes a twelve-module importer sweep mandatory with a three-way classification of every hit, and the same sweep is mirrored into Group 4 (deliverable 10) and Group 5 (deliverable 5) with a new High risk row backing it. Deliverable 12 re-points `doctor.test.ts:2325-2332` and `setup.test.ts:5-15` in the G3 commit and names `install-promote.test.ts`, `__tests__/update-command-publication.test.ts` and `verify-delivery-evidence-pack.test.ts`, pulling `build-delivery-evidence.test.ts` and `materialize-release-subjects.test.ts` forward from G6 D10. Deliverable 13 adjudicates all seventeen files (14 rows; one row brace-expands the four codex-dogfood-* files) under `tests/integration/` and `tests/support/` in a table, with `codex-project-route-migration.test.ts` recorded as **OUT** (it asserts the `genie mcp has been retired` message — dual-mode's surface) and kept byte-unchanged. New pre-condition **P7** states the rebase floor (`dev` ≥ `1b34d7d4b`) with its `knip.json` empty-`entry` rationale. LOWs fixed: the `hook-content-binding` import is `fresh-install-smoke.ts:31`, not `:32` (`:32` is the `skills-lint` survivor) in both G4 D4 and G6 D6; `build.js:54` is an `execFileSync` **subprocess** of `sync-plugin-skills.ts` and `:55` subprocesses the surviving `fresh-install-smoke.ts`, so the real `assertPluginSkillsInSync` call sites are `version.ts:250` and `fresh-install-smoke.ts:493`; and `release-publish.yml:1351` is a `printf` echo, leaving `:1336` as the single real `--publish-local-delivery` run.

---

### Plan review — 2026-08-31T15:44:31Z — FIX-FIRST (round 1)

- **Reviewer:** `genie:reviewer session e7edce9e/a2686d03`
- **Reviewed sha:** `3ecb6187a64a0e937270350ce483fe5eef69808145886ccd62c919baeb3266fb`
- **Verdict:** FIX-FIRST (round 1)

**Findings summary.** Five high and seven medium gaps, all evidence-backed: G3's deletion list swept in `local-delivery-repair.ts`, which implements the `--publish-local-delivery` mode a required `publish.needs` release gate depends on (H1); no owner for the four generic fs primitives `codex-activation-persistence.ts` lends to the two survivors `install-version-marker.ts:42` and `update-capabilities.ts:29` (H2); `install-promote.ts` missing from the ordered-lifecycle-lease re-point list (H3); `fresh-install-smoke.ts:32`'s `hook-content-binding` import scheduled a group later than the deletion that breaks it (H4); `release-docs.test.ts` script literals unscheduled (H5); plus `trust.ts` / `omni.test.ts` / `knip.json` gaps (M1), a wrong `check:fast` step count (M2), an impossible byte-identity AC for the relocated `validate-wish.ts` (M3), inventory counts stale against #2870 (M4), an unnamed `publish.needs` edge set (M5), two prose sites mis-assigned to G5 (M6), the unexplained 25-vs-22 local-path probe and the two-skill-tree `$GENIE_HOME` ambiguity (M7), and a set of drifted line references and miscounts (LOWs).

**Disposition: applied in this revision.** Every item above is now written into the plan, re-verified against `dev` head `67be5c46d` (#2870 merged at `1b34d7d4b`): P3 flipped to ✔; inventory re-derived to 25 (`SHIPPED_SKILL_NAMES` at `sync-plugin-skills.ts:36-62`, `release-docs.test.ts:986`, orphan bound 25 × 53 = 1,325) with the C4 baseline re-confirmed unchanged at 60,189 lines / 97 files; the `$GENIE_HOME` source pinned to `skills/` with the two-tree mirror proven byte-identical (72 blobs, identical hashes); `check` = eight steps and `check:fast` = seven; Decision 6 corrected to eight absorbed symbols; and the drifted references re-pointed (`runtime-integrations.ts:4110` / `:3813`, `release-payload-version.ts:90-101`, `doctor.test.ts:2559-2562`, `genie.ts:187`, `release-publish.yml:894`, `doctor.ts:2175`'s colon-less `agent sync` name, `agent-sync.test.ts` 5,305 lines, `plugins/genie/README.md` 6×, the license assertion at `release-docs.test.ts:720-723`, the nonexistent `council-workflow-lint.test.ts` dropped, `ci.yml:120-136` and `build-tarballs.yml:66` added, `skills/README.md:37` handed to the C5-lite worklist, and `require_extra_approval_for_unattributed_changes: true` recorded in Decision 9).

---

## Wish A closure

`.genie/wishes/skills-everywhere/WISH.md` flips Status `IN_PROGRESS` → `SHIPPED` as part of Group 1's PR. Rationale: merged to `dev` (#2868, `18b85341b`) with C3 proven on a real host (`qa/real-host-20260830.md`) and the stable dispatch pending is the documented closure contract for that wish; the criteria it still carries open (C1, C2, C5, C8) are post-promotion acceptance already recorded in its own ledger. Two of them (C1, C2) assert a release-tag pin that `skills@1.5.23` does not honor, so Group 1 appends a dated correction block naming itself as the owner of that fix — the flip records the wish as shipped, not as flawless.

---

## Files to Create/Modify

```
# G1
src/lib/skills-installer.ts (+ .test.ts)
src/genie-commands/doctor.ts, uninstall.ts (record consumers, if the scan changes their reads)
.github/workflows/release-publish.yml (skills-install-smoke argv), .github/workflows/ci.yml (parity argv)
.genie/wishes/skills-everywhere/WISH.md (Status SHIPPED + correction block)

# G2
src/lib/atomic-fs.ts (+ .test.ts)            <- computeDirDigest, computeFileDigest,
                                                fsyncParentDir, readBoundedRegularFile,
                                                unlinkWithParentFsync, atomicWriteFileSync
src/lib/codex-activation-persistence.ts (re-exports only, deleted in G3)
src/lib/legacy-integration-retirement.ts (+ .test.ts)
src/lib/agent-sync.ts (re-exports only), src/lib/agent-sync.test.ts (describe blocks out)
src/lib/runtime-integrations.ts (+ .test.ts) (planCodexPluginRegistrationRemoval)
src/lib/genie-home-permissions.test.ts (SCAN_EXEMPTIONS)
scripts/validate-wish.ts, scripts/wish-template-text.d.ts (new), scripts/wishes-lint.ts

# G3 (deletions + doctor/uninstall rewrite)
src/lib/codex-{activation,activation-executor,activation-persistence,delivery-evidence,doctor-observation,host-observation,lifecycle-lease,lifecycle-truth,release-version}.ts (+ tests)
src/genie-commands/codex-{delivery,delivery-repair,rollback}.ts (+ tests)
src/fixtures/codex-*.json, tests/integration/codex-lifecycle-pty.test.ts
src/genie-commands/{setup,doctor,uninstall,update,install,update-integrations,install-promote}.ts (+ tests)
src/genie-commands/local-delivery-repair.ts (+ .test.ts)  -- KEPT, imports rehomed
scripts/verify-delivery-evidence-pack.ts (+ .test.ts)     -- KEPT, import rehomed
src/lib/release-payload-proof.ts (+ .test.ts)      <- NEW: parseReleaseVersion, scanPhysicalTree
src/lib/delivery-evidence-verify.ts (+ .test.ts)   <- NEW: the three verify symbols + channel/platform unions
src/genie-commands/doctor.test.ts, setup.test.ts, install-promote.test.ts
src/genie-commands/__tests__/update-command-publication.test.ts
scripts/{build-delivery-evidence,materialize-release-subjects}.test.ts   -- moved here from G6
tests/integration/{codex-app-server-cwd,codex-delivery-bootstrap,codex-lifecycle-race,install-exit2-propagation}.test.ts -- deleted
tests/support/{codex-lifecycle-test-runner,codex-cwd-evidence,codex-app-server-transport}.ts            -- deleted
tests/integration/codex-project-route-migration.test.ts   -- OUT, byte-unchanged
src/lib/{install-version-marker,update-capabilities}.ts   -- re-pointed at atomic-fs.js
src/lib/genie-home-permissions.test.ts (SCAN_EXEMPTIONS for the deleted codex files)
src/lib/{ordered-lifecycle-leases,runtime-integrations}.ts (+ tests), src/genie.ts
.github/workflows/build-tarballs.yml (.agents marketplace path filter)
plugins/genie/.codex-plugin/, plugins/genie/codex-agents/, plugins/genie/references/codex-integration-map.md
.agents/plugins/marketplace.json
scripts/codex-plugin-only-smoke.ts, scripts/codex-debug-discovery-smoke.ts, scripts/codex-smoke-harness.ts
scripts/{build-binary.sh,release-payload-version.ts,version.ts,release-guard.sh} (Codex manifest delisting)
package.json (smoke:codex, smoke:codex-discovery), .github/workflows/ci.yml (codex-smoke job)

# G4 (deletions + check surgery)
src/hooks/**, src/genie.ts (hook namespace :25,:187)
src/term-commands/hook/trust.ts -- deleted; src/term-commands/omni.test.ts (:20-21)
knip.json (entry :3, ignore :7)
src/genie-commands/legacy-v4.ts (:81), src/types/genie-config.ts (:108)  -- prose, moved from G5
scripts/fresh-install-smoke.ts (:32 hook-content-binding, :33 sync-plugin-skills, :502-509)
scripts/release-docs.test.ts (:508,510,511,512,695,697,744-748 + README assertions)
plugins/genie/{.claude-plugin,.kimi-plugin,agents,hooks,workflows,rules,scripts,skills}/**
plugins/genie/{settings.json,genie.ts,index.ts}, plugins/genie/references/** except orca-orchestration.md
plugins/genie/README.md (rewritten to Orca-only)
.claude-plugin/marketplace.json
scripts/{council-workflow-lint,hook-bundle-parity,hook-budgets-lint,hook-content-binding,plugin-executables-check,sync-plugin-skills}.ts (+ tests, fixtures)
src/lib/council-workflow-stamp.test.ts, src/lib/wish-status.test.ts, src/lib/agent-sync.ts (stamp coupling)
scripts/{build-binary.sh,build.js,release-payload-version.ts,version.ts,release-guard.sh}, .github/workflows/{version.yml,build-tarballs.yml,ci.yml}
  ci.yml: five gate steps at :120-121,123-124,129-130,132-133,135-136
  build-tarballs.yml: path filters :62,64,65,66,72
package.json (six gates + hooks:bind, check + check:fast), biome.json, .coderabbit.yaml
AGENTS.md + src/__tests__/claude-md-drift.test.ts (minimum edit)

# G5 (deletions + slimming)
plugins/hermes-genie/**, plugins/pi-genie/**
src/lib/hermes-skills-config.ts (+ .test.ts)
src/lib/agent-sync.ts (+ .test.ts), scripts/generate-codex-fallback-allowlist.ts  -- deleted
src/lib/runtime-integrations.ts (+ .test.ts) -- slimmed
src/genie-commands/update.ts (+ __tests__/update.test.ts), src/lib/ordered-lifecycle-leases.ts
src/lib/genie-home-permissions.test.ts (agent-sync exemption removed)
  -- legacy-v4.ts:81 and types/genie-config.ts:108 are NOT here; they belong to G4
scripts/{version.ts,release-guard.sh}, .github/workflows/version.yml (hermes/pi manifests)

# G6
scripts/{build-binary.sh,release-payload-version.ts,version.ts,release-guard.sh,fresh-install-smoke.ts}
scripts/{build.js,sync.js,verify-codex-activation-payload.ts} (+ tests) -- deleted
scripts/{validate-dogfood-matrix-evidence,validate-live-dogfood-evidence}.ts (+ tests) -- deleted
scripts/candidate-dogfood-matrix.ts -- decision recorded
tests/support/codex-dogfood-{harness,entry-runner,fixture}.ts (+ test) -- deleted
.github/workflows/{release-publish.yml,version.yml,build-tarballs.yml}
scripts/{release-payload-version,release-guard,release-docs,version-format,version-ci-staging,workflow-yaml-parse}.test.ts
  (build-delivery-evidence.test.ts and materialize-release-subjects.test.ts moved to G3)
CLAUDE.md (version-file count sentence only)

# G7
.genie/wishes/skills-everywhere-b/qa/<date>.md
```
