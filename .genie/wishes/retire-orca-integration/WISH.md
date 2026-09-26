# Wish: Retire genie's Orca integration — the plugin and Orca mode

| Field | Value |
|-------|-------|
| **Status** | IN_PROGRESS |
| **Slug** | `retire-orca-integration` |
| **Date** | 2026-09-25 |
| **Author** | Felipe Rosa |
| **Appetite** | medium |
| **Branch** | `wish/retire-orca-integration` |
| **Repos touched** | automagik-dev/genie (docs follow-up in automagik-dev/docs) |
| **Design** | _No brainstorm — direct wish_ |

## Summary

Owner decision after the live dogfood of 2026-09-25 (issue #3064).

Genie ships an Orca plugin (eight palette commands, a settle notification) and an Orca lifecycle mode (Orca Runs, tasks, gates and a workspace card instead of genie's board). A live dogfood on 2026-09-25 (issue #3064, the run behind #3063) found:
- the plugin gave the operator no visible value from a remote macOS client: no settle notification in two tests;
- the card shows only in an experimental dashboard;
- gates have no UI and only resolve from a terminal bound to the Run;
- Orca mode made the coordinator slower and costlier than the standalone `/wish` workflow.

The owner decided to retire both. This wish removes them while keeping standalone genie, every release path and old-binary updates intact.

## Scope

### IN

- **Release tooling** tolerates absent `plugins/genie/package.json` and `plugins/genie/orca-plugin.json` (version bump, release guard, payload stamping), promoted to `main` before those files are deleted.
- **Orca mode removed:**
  - the `orchestration.mode` config field, `src/lib/orchestration-mode.ts` and `src/lib/orca-plugin-lifecycle.ts`;
  - the preAction refusal in `src/genie.ts`;
  - the `task sync`, `context --plan`, `genie-db` and `roadmap-sync` carve-outs;
  - the doctor, update and setup Orca branches;
  - the Orca-mode sections of the skills (`work` with `references/orca-coordinator.md`, `review`, `wish`, `fix`, `report`, `genie`), and the related README, CLAUDE.md and AGENTS.md text, with their pinning tests.
- **Plugin and integration removed:**
  - `plugins/genie/*`;
  - `src/lib/orca-orchestration-adapter.ts`, `src/lib/orca-lifecycle-mirror.ts`, `src/term-commands/orca.ts`;
  - `orca-marketplace.json` and `.github/workflows/orca-plugin-ref.yml`;
  - `scripts/orca-bundle-parity.*`, `scripts/orca-manifest-parity.test.ts`;
  - `lint:orca-bundle`, and the CI and build-tarballs hooks.
- **One-release retirement stubs:** `genie setup --orchestration-mode <x>` (hidden: `standalone` prints a no-op notice and exits 0; `orca` prints a retirement notice and exits 2), and `genie orca` (prints a retirement notice and exits 2). The command count stays at 16.

### OUT

- The empty `plugins/genie/` compat directory in the release payload stays **permanently**. Old binaries' `genie update` (`update.ts:2237,2264`) and `main`'s delivery evidence (`build-delivery-evidence.ts:93,166`) require it to exist. `build-binary.sh` creates it, the same way as the `.agents` and `.claude-plugin` compat members.
- `INSTALL_PAYLOAD_MEMBERS` is unchanged. `plugins/dsh-genie-board` and `plugins/dsh-workflow-loader` are unchanged.
- The public docs site (`docs/` → automagik-dev/docs) is a separate PR in that repository, followed by a submodule bump here.
- Deleting the remote `orca-plugin` and `orca-plugin-dev` refs is an owner action, after G3 is on `main`.
- Removing the two stubs happens one release later, in a follow-up.
- Retired-skill cleanup names in `src/lib/legacy-skills-catalog.ts` stay.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Retire the plugin **and** Orca mode, not only the plugin | Owner decision 2026-09-25, after the dogfood (#3064): neither gave the operator or the agent a benefit; the coordinator measured slower and costlier than the standalone workflow |
| 2 | This reverses v6-stable-cut decision D-B ("`plugins/genie`, `orca-marketplace.json` and `orca-plugin-ref.yml` are not deleted") | Explicit owner reversal, recorded here and in `v6-stable-cut` |
| 3 | Keep an empty `plugins/genie/` in the payload forever | Old binaries and `main`'s delivery evidence require the physical directory; an empty one passes `scanPhysicalTree` |
| 4 | G1 lands on `main` before G3 deletes the version files | `version.yml` and `release-guard.sh` always run from `main`; deleting first breaks every dev version bump |
| 5 | Delete the config field instead of keeping a tolerant enum | `GenieConfigSchema` is a non-strict `z.object`, so an old `orchestration.mode` is stripped on read; a regression test pins that `task create` still works |
| 6 | One-release stubs for `--orchestration-mode` and `genie orca` | "Deprecate loudly, remove decisively": a host script calling them gets a named retirement notice, not `unknown option` |

## Simplicity Case

- **Simplest complete design:** delete the modules, keep one empty compat directory, and add two stubs that print a retirement notice and exit.
- **Added machinery:** the compat directory creation (one `mkdir`), and the two stubs, removed one release later.
- **Deferred until measured:** revisiting Orca if it ships a gate UI and a card surface an operator actually uses.
- **Complexity removed:**
  - a second lifecycle authority, and the refusal gate with its three carve-outs;
  - a 1,714-line adapter and the plugin's bundle-parity lint;
  - two force-pushed release refs, and a plugin consent surface.

## Dependencies

**depends-on:** none
**blocks:** none

## Success Criteria

- [ ] `bun run check`, `bun run build` and `bun run dead-code` are green on the integrated branch, and CI is green on linux and darwin.
- [ ] A config holding `{"orchestration":{"mode":"orca"}}` (or a garbage value) parses, and `genie task create`, `genie task sync` and `genie board` work.
- [ ] `genie setup --orchestration-mode orca` exits 2 with the retirement notice; `--orchestration-mode standalone` exits 0; `genie orca mirror …` exits 2 with the retirement notice.
- [ ] A locally built tarball's top-level members equal the 8 `INSTALL_PAYLOAD_MEMBERS`, and `plugins/` contains `genie/` (empty), `dsh-genie-board/` and `dsh-workflow-loader/`.
- [ ] After G1 is promoted and G3 lands, the first dev auto-version run and its release (including the update-path smoke) are green.
- [ ] No tracked file mentions Orca mode or the Orca plugin (checked with `git grep -i orca`), except:
  - the retained stubs and `interactivity.ts`'s `'orca'` exemption;
  - the compat creation;
  - historical records (`.genie/`, `commitlint.config.ts`, release notes);
  - `legacy-skills-catalog.ts`;
  - `src/genie-commands/install.test.ts:753,762` (fixture only).

## Execution Strategy

### Wave 1 (parallel; one shared file, sequenced)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 1 | engineer | Medium: release scripts and workflows that run from `main`; a mistake breaks versioning or release | inherit | Make the release tooling tolerate absent `plugins/genie` version files |
| 2 | engineer | Medium-high: CLI behaviour, config compatibility and many pinned texts | inherit | Remove Orca mode and its skill and docs text; add the setup stub |

### Wave 2 (after G1 is promoted to `main`)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 3 | engineer | High: payload shape and the update path for old binaries | inherit | Remove the plugin, adapter, mirror and publishing; keep the compat directory; add the `genie orca` stub |

**Shared file:** G1 owns `scripts/release-docs.test.ts:78-84`; G2 owns its `848-916` and `1110-1118` hunks. G1 merges into the wish branch first, and G2 rebases onto it before its gate.

**Global constraints:**
- Base is `origin/dev`; conventional commits; commit messages end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- `INSTALL_PAYLOAD_MEMBERS` must not change, and `plugins/genie/` must exist as a physical directory in every built payload.
- G3 must not start before G1 is on `main`: `git show origin/main:.github/workflows/version.yml` and `git show origin/main:scripts/release-guard.sh` must both carry G1's tolerant version lists.
- Never bypass a hook, never force-push, never merge; the orchestrator integrates.
- `bun run check` never runs concurrently with another full test run on this host (OOM); run `umask 022` in fresh worktrees.
- Public text names no private repository or person.

## Execution Groups

### Group 1: Release tooling tolerates absent plugin version files

**Goal:** Versioning and release keep working when `plugins/genie/package.json` and `plugins/genie/orca-plugin.json` do not exist, while still bumping them when they do.

**Deliverables:**
1. `.github/workflows/version.yml`:
   - `JSON_FILES` bumps `package.json`, plus each `plugins/genie/*` file only when present;
   - the `invalid_path` guard and the "expected exactly three version files" assertion are relaxed to the files that exist;
   - the header comment is updated.
2. `scripts/release-guard.sh` `version_child_matches_parent`: `plugins/genie/package.json` becomes optional, like `orca-plugin.json`, and is required to match only when it changed.
3. `scripts/version.ts`: `VERSION_FILES` skips absent `plugins/genie/*` files in both preflight and `--check`.
4. `scripts/release-payload-version.ts`: stamping and verifying skip absent `plugins/genie/*` files, and `COMMITTED_VERSION_FILES` drops `plugins/genie/package.json`.
5. The tests that pin these lists are updated with both cases (files present, files absent):
   - `scripts/version-format.test.ts`, `version-ci-staging.test.ts`, `release-guard.test.ts`;
   - `release-payload-version.test.ts`, `verify-dsh-genie-board-release.test.ts`, `release-docs.test.ts:78-84`.

**Interfaces:**
- Consumes: none
- Produces: tolerant version tooling that G3 relies on once it is on `main`.

**Acceptance Criteria:**
- [ ] Each changed script has a test for the "plugin files absent" case, and that test fails before the change.
- [ ] With the files present, `version.yml`, `release-guard.sh`, `version.ts` and payload stamping behave exactly as today. The one intended change: `--verify-source` stops requiring `plugins/genie/package.json`.
- [ ] `bun scripts/version.ts --check` passes.

**Validation:**
```bash
bun test scripts/release-guard.test.ts scripts/version-format.test.ts scripts/version-ci-staging.test.ts scripts/release-payload-version.test.ts scripts/release-docs.test.ts scripts/verify-dsh-genie-board-release.test.ts
bun scripts/version.ts --check
```

**depends-on:** none

---

### Group 2: Remove Orca mode

**Goal:** Genie has one lifecycle authority, its own board. Old configs and scripts get a clean retirement instead of a crash.

**Deliverables:**
1. Delete `src/lib/orchestration-mode.ts`, `src/lib/orca-plugin-lifecycle.ts` and their tests.
2. `src/genie.ts`: remove the Orca preAction gate and its imports. `--orchestration-mode` becomes a hidden, one-release stub:
   - `standalone`: prints "Orca mode is retired; genie always uses its own board" and exits 0;
   - `orca`: prints the retirement notice and exits 2.
   - Either way, an old `orchestration` key stays in `config.json` until the next config write. It is harmless (stripped on read), and the notice says so.
3. `src/genie-commands/setup.ts`: the switch branch is replaced by the stub.
4. Remove the Orca carve-outs and guards in `src/term-commands/v5-task.ts`, `context.ts`, `src/lib/v5/genie-db.ts` and `roadmap-sync.ts`. Remove the Orca branches in `doctor.ts` (including `checkOrcaLifecycle` and its import of `plugins/genie/orca-runtime`) and `update.ts` (`refreshOrcaOwnershipAfterDelivery`).
5. `src/types/genie-config.ts`: remove `OrchestrationConfigSchema` and its field. Add a regression test: a config with `orchestration.mode` set to `orca`, `standalone` or garbage parses, and `task create`, `task sync` and `board` work.
6. Tests: delete `src/lib/v5/authority-barriers.test.ts` and the Orca blocks in `context`, `v5-board`, `v5-task`, `doctor`, `setup` and `update` tests.
7. Skills:
   - delete `skills/work/references/orca-coordinator.md`;
   - remove the Orca-mode sections in `skills/{work,review,wish,fix,report,genie}/SKILL.md`, `skills/genie/reference/lifecycle.md`, `skills/work/agents/openai.yaml` and `skills/README.md`;
   - update `scripts/task-conversation-contract.test.ts` and `release-docs.test.ts:1110-1118`.
8. Docs:
   - README `## Standalone and Orca authority` (the Orca-mode half);
   - CLAUDE.md: the setup row and the lifecycle-authority gotcha;
   - AGENTS.md: any Orca-mode text (G3 owns its plugin lines `:20,67`);
   - `src/term-commands/v5-board.ts:276`: drop the stale `LocalLifecycleDisabledError` comment;
   - move any non-Orca strings pinned by `release-docs.test.ts:848-916` to their own section.

**Interfaces:**
- Consumes: none
- Produces: no `orchestration-mode` module and no `orcaOwnsLifecycle` for G3 to worry about. `doctor.ts` no longer imports `plugins/genie`.

**Acceptance Criteria:**
- [ ] The config regression test passes and fails before the change (the field removal is what makes an `orca` config harmless).
- [ ] The two stub behaviours are tested (exit codes and stderr).
- [ ] `git grep -n "orcaOwnsLifecycle\|orchestration-mode\|ORCA_FORBIDDEN" -- src skills` returns only the stub.
- [ ] CLAUDE.md drift tests and `release-docs` pass.

**Validation:**
```bash
bun run check
bun run build
bun run skills:lint
```

**depends-on:** none

---

### Group 3: Remove the plugin, adapter, mirror and publishing

**Goal:** No Orca plugin or adapter remains, while the release payload keeps an empty `plugins/genie/` so old binaries still update.

**Deliverables:**
1. Delete `plugins/genie/*` (10 tracked files).
2. `scripts/build-binary.sh`:
   - `mkdir -p "${STAGE}/plugins/genie"` next to the other compat members;
   - drop the `orca-bundle-parity` check and the plugin required-file entries;
   - `release-payload-version` stamping skips the absent files (from G1).
3. Delete:
   - `src/lib/orca-orchestration-adapter.*` and `src/lib/orca-lifecycle-mirror.*`;
   - `src/term-commands/orca.ts` and its test. `genie orca` becomes a one-release stub that prints the retirement notice and exits 2, registered so the command count stays 16;
   - `scripts/orca-bundle-parity.*` and `scripts/orca-manifest-parity.test.ts`;
   - `orca-marketplace.json` and `.github/workflows/orca-plugin-ref.yml`, in the same commit as the tree.
4. `package.json`: drop `plugins/genie/` from `files`, drop `lint:orca-bundle` and its chaining. Also update `ci.yml:135-136`, `build-tarballs.yml:11-12,71`, `codex-project-mcp.test.ts:170-183`, `.coderabbit.yaml:25-26`, and `release-docs.test.ts` (the plugin pins).
5. Docs: README (plugin install, update and rollback, the command row), CLAUDE.md (tree rows, the `genie orca` row, `### Orca subcommands`, the two plugin gotchas), AGENTS.md `:20,67`.
6. References to deleted paths:
   - `.claude/workflows/wish.js:113` DARWIN_TOLERATED: drop the adapter-test entry, and update `scripts/wish-workflow-logic.test.ts:76` to the new length;
   - the mikro fixtures `scripts/mikro/fixtures/review-prep.json:44,126,163`, `issue-triage.json:47` and `scripts/mikro/triage.test.ts:180`: repoint or drop entries that name deleted files;
   - `src/lib/interactivity.ts:88-93`: KEEP `'orca'` in WORKSPACE_EXEMPT while the stub exists (pinned by `interactivity.test.ts:28-30`).
7. The `genie orca` stub stays VISIBLE in `--help`: `release-docs.test.ts:928-939` counts commands from the help output.

**Interfaces:**
- Consumes: G1 tooling on `main`, and G2's removal of `doctor.ts`'s plugin import.
- Produces: none.

**Acceptance Criteria:**
- [ ] A locally built tarball's top-level set equals the 8 members, and `plugins/genie/` is present and empty.
- [ ] The install and update tests pass: `install-promotion`, `install-swap`, `build-delivery-evidence` and `update-command-publication`.
- [ ] `git grep -il 'orca' -- src scripts .github plugins package.json` lists only the retirement stub, `legacy-skills-catalog.ts`, and history-only files.

**Validation:**
```bash
bun run check
bun run build
bun run dead-code
bash scripts/build-binary.sh --platform linux-x64-glibc
tar -tzf dist/genie-*.tar.gz | sed 's|^\./||' | awk -F/ 'NF>0{print $1}' | sort -u
bun test src/lib/install-promotion.test.ts scripts/install-swap.test.ts scripts/build-delivery-evidence.test.ts src/genie-commands/__tests__/update-command-publication.test.ts
```

**depends-on:** Group 1 (on `main`), Group 2

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] On the dogfood host, `genie update` to the first release without the plugin succeeds, and `~/.genie/plugins/genie` ends up empty (or holds only legacy leftovers).
- [ ] On a host whose config still says `orchestration.mode: orca`, genie works in standalone mode after the update.
- [ ] The release's update-path smoke (the previous stable version updating to the candidate) is green.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| G3 lands before G1 reaches `main`, and dev versioning breaks | High | Global constraint and an explicit check of `origin/main` `version.yml` and `release-guard.sh` before G3 starts |
| An old binary refuses the update because `plugins/genie` is missing | High | The permanent empty compat directory, with a local tarball check |
| A host left in Orca mode silently switches back to the local board | Low | The one-release `--orchestration-mode` stub, plus the release note |
| Existing Orca installs of the plugin keep running a pinned commit | Low | The owner uninstalls it in Orca; the refs are deleted after G3 |

---

## Review Results

_The read-only reviewer returns evidence; the invoking orchestrator appends a timestamped block here after plan, execution, and PR reviews._

### Plan review — 2026-09-25 — SHIP

- An independent read-only reviewer scored the plan at `14ba42433` against the code. Verified:
  - old binaries need only a physical `plugins/genie` directory, and an empty one passes `scanPhysicalTree` (`update.ts:2237,2264`, `release-payload-proof.ts:79-97`, `build-delivery-evidence.ts:91-100`);
  - `INSTALL_PAYLOAD_MEMBERS` includes `plugins`;
  - `main`'s `version.yml` and `release-guard.sh` hardcode both plugin version files;
  - the config schema is non-strict;
  - the plugin/src import cycle is split correctly between G2 and G3;
  - an old binary in Orca mode still updates.
- Five MEDIUM and three LOW, all folded in:
  - `release-docs.test.ts` hunk ownership and sequencing between G1 and G2;
  - owners for the files that would otherwise be orphaned (`wish.js` DARWIN_TOLERATED, mikro fixtures, `interactivity.ts`, a `v5-board.ts` comment, `install.test.ts`);
  - the pre-G3 check reads `origin/main` `version.yml` as well as `release-guard.sh`;
  - AGENTS.md ownership split;
  - the stub notes the stale config key;
  - the `--verify-source` wording;
  - the `genie orca` stub stays visible in `--help`.

### Approval — 2026-09-25 — APPROVED

- The owner approved the plan in chat ("plan approved, execute the whole thing autonomously end to end"). Status set to APPROVED at head `5ba0f772e`; base `origin/dev` `c20720a4f`.

### Execution review — G1 and G2 — 2026-09-26 — SHIP

- **G1** at `37178c871`: an independent read-only reviewer returned SHIP.
  - 150/150 focused tests pass, and 12 fail with the four scripts reverted.
  - Its LOW findings 1–2 were folded in by `6c08184fd`: a dangling plugin symlink now counts as present, like `version.yml`'s `-e || -L`, and the no-op `--verify-source` loop is gone.
- **G2** at `f0e850acc`: an independent read-only reviewer returned SHIP.
  - 688/688 focused tests pass.
  - A bundle run with a stale `orchestration.mode: orca` config: idea, task, sync, board and context all exit 0, and the wish base is written.
  - The stub exits 2 for orca and 0 for standalone, and writes nothing.
  - Its LOW findings 1, 3 and 4 were folded in by `a58ff8b0e`. Finding 2 (the mikro fixtures) and the plugin README stay with G3, as planned.
- **Integration** at `fe4b238e8`: `bun run check` gave 3153 pass and 5 fail. All five were 5 s timeouts at load average 140. Those files re-run at `e5308f8a5` with `--timeout 60000` gave 127/127.

### Execution review — G3 — 2026-09-26 — BLOCKED on sequencing only (becomes SHIP once G1 is on main)

- The engineer's commits `47fe5592d` and `798a8fcd6` were scored by an independent read-only reviewer, who found no code defect.
- **Update path:** a built `linux-x64-glibc` tarball has exactly the 8 `INSTALL_PAYLOAD_MEMBERS`, with `plugins/genie/` present and empty. `scanPhysicalTree` on the extracted tarball returns ok, and its digest matches `build-delivery-evidence`. An old binary's extract, promote, copyTree and canonical-root steps all accept an empty directory. The release-publish smoke uses `cp -R`, and no artifact upload ships a bare directory.
- **Stub:** `genie orca` exits 2, writes nothing, stays visible in `--help`, and the command count stays at 16.
- **Tests:** 348/348 focused tests pass. typecheck, dead-code and `version.ts --check` are clean.
- **Blocker:** D4. The live `main` `version.yml` and `release-guard.sh` still hardcode both plugin version files, so G3 waits for promotion #3061.
- **LOW 2 folded in by `1ce75cf39`:** `build-binary.sh` fails unless `plugins/genie` is an empty directory. The D-B reversal is recorded in `v6-stable-cut` (`82f227da0`).

### Delivery QA — dev pre-release v6.260926.3 — 2026-09-26

- **Sequencing held.** #3065 (G1+G2) was merged to dev and promoted to main in #3061 (`0358bfa48`). Main's `version.yml` and `release-guard.sh` then carried the present-only loops. #3066 (G3) was merged to dev (`d9bc44107`), and main's copy of `version.yml` bumped the plugin-less tree to `6.260926.3` and published the dev pre-release.
- **Update hop, on a replica HOME:**
  - `install.sh` from main installed stable `v6.260925.1`.
  - With that old binary, `genie update --dev -y` reached `✔ Genie v6.260926.3 verified`.
  - `plugins/genie/` converged to an empty directory.
  - 18 skills and 10 workflows converged.
- **The new binary with a stale `{"orchestration":{"mode":"orca"}}` config:**
  - `init`, `task create`, `task list`, `board`, `idea`, `task sync` and `context` all exit 0;
  - `setup --orchestration-mode orca` exits 2 and `standalone` exits 0, both with the retirement notice;
  - `orca mirror …` exits 2 with the retirement notice;
  - `--help` lists 16 commands, with `orca` shown as "Retired";
  - `doctor` prints no Orca lines;
  - `config.json` stays byte-identical.

---

## Files to Create/Modify

```
.github/workflows/version.yml
scripts/release-guard.sh
scripts/version.ts
scripts/release-payload-version.ts
scripts/version-format.test.ts
scripts/version-ci-staging.test.ts
scripts/release-guard.test.ts
scripts/release-payload-version.test.ts
scripts/verify-dsh-genie-board-release.test.ts
scripts/release-docs.test.ts
scripts/task-conversation-contract.test.ts
src/genie.ts
src/genie-commands/setup.ts
src/genie-commands/setup.test.ts
src/genie-commands/doctor.ts
src/genie-commands/doctor.test.ts
src/genie-commands/update.ts
src/genie-commands/__tests__/update.test.ts
src/term-commands/v5-task.ts
src/term-commands/v5-task.test.ts
src/term-commands/context.ts
src/term-commands/context.test.ts
src/term-commands/v5-board.test.ts
src/lib/v5/genie-db.ts
src/lib/v5/roadmap-sync.ts
src/lib/v5/authority-barriers.test.ts
src/lib/orchestration-mode.ts
src/lib/orchestration-mode.test.ts
src/lib/orca-plugin-lifecycle.ts
src/lib/orca-plugin-lifecycle.test.ts
src/lib/orca-orchestration-adapter.ts
src/lib/orca-orchestration-adapter.test.ts
src/lib/orca-lifecycle-mirror.ts
src/lib/orca-lifecycle-mirror.test.ts
src/lib/interactivity.ts
src/term-commands/orca.ts
src/term-commands/orca.test.ts
src/types/genie-config.ts
src/lib/codex-project-mcp.test.ts
skills/work/SKILL.md
skills/work/references/orca-coordinator.md
skills/work/agents/openai.yaml
skills/review/SKILL.md
skills/wish/SKILL.md
skills/fix/SKILL.md
skills/report/SKILL.md
skills/genie/SKILL.md
skills/genie/reference/lifecycle.md
skills/README.md
plugins/genie/*
orca-marketplace.json
.github/workflows/orca-plugin-ref.yml
.github/workflows/ci.yml
.github/workflows/build-tarballs.yml
scripts/build-binary.sh
scripts/orca-bundle-parity.ts
scripts/orca-bundle-parity.test.ts
scripts/orca-manifest-parity.test.ts
package.json
.coderabbit.yaml
README.md
CLAUDE.md
AGENTS.md
.genie/wishes/retire-orca-integration/WISH.md
.genie/wishes/v6-stable-cut/WISH.md
```
