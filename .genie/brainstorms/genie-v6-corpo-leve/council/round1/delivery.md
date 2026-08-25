# Council rodada 1 — lente delivery

_Rodada 1 (2026-08-25): proposta rev. 3 crua (deletar plugins, skills.sh, harness mínimo, board só standalone, sem UI). Relatório integral do subagente, recuperado do transcript._

I have what I need. Here is the DELIVERY lens assessment.

---

# DELIVERY lens — genie v6 "corpo leve" rev. 3

## 1. Lens response block

**Verdict:** GO with conditions — the deletion is deliverable and mostly *subtractive*, but only if it lands as an ordered multi-PR sequence with a standalone-parity tripwire established **before** the first deletion, and a deprecation release that still knows how to uninstall the plugin it will no longer ship.

**Confidence:** 0.75 (high on the mechanical map; low on skills.sh capabilities and on the existence of external Codex/Hermes users — neither verifiable from the repo).

**Key evidence**
- Standalone surface is already isolated from the plugin: `src/lib/v5/*` and `src/term-commands/{v5-board,v5-task,init,context,mcp,idea}.ts` have **zero** imports from `codex-*`, `install-*`, `agent-sync`, `runtime-integrations` (grep `plugins/genie|CLAUDE_PLUGIN_ROOT` in `src/` hits only install/update/setup/uninstall/doctor/legacy-v4/agent-sync/runtime-integrations/hermes-skills-config/codex-project-mcp + `types/genie-config.ts`). `init.ts` imports `codex-project-mcp.js` only for `.codex/config.toml` facade writing (`src/term-commands/init.ts:27,206`) — the one coupling to cut.
- `tests/e2e/v5-lifecycle.sh` drives the **built** `dist/genie.js` through `init → task → board → context → mcp` without any plugin present (`ci.yml` job `e2e`). This is the standalone-untouched proof already in CI.
- Roughly **38.2k test LOC** are plugin/codex/hermes/pi/install-delivery-bound (codex-*, install-*, agent-sync 249k bytes, runtime-integrations 154k, hermes-*, `tests/integration/codex-*`, `plugins/genie/scripts/*.test.ts`, `scripts/*codex|dogfood|delivery*.test.ts`) vs **~15.5k** test LOC on v5 + term-commands + hooks that must stay green. Of 136 test files, ~70 die.
- Claude Code hooks are delivered **only** through the marketplace plugin (`plugins/genie/hooks/hooks.json` → `dispatch-runtime.cjs` → `genie hook dispatch`; `agent-sync.ts:98-110` checks `enabledPlugins['genie@automagik']`). No path in `src/lib` writes hooks into `~/.claude/settings.json` (`claude-settings.ts` is cleanup-only). Deleting `plugins/` therefore removes branch-guard/freshness/git-freeze-guard/omni-approval/identity-inject/SessionStart from every Claude session unless a replacement installer is written.
- `plugin.json` `mcpServers.genie` (`plugins/genie/.claude-plugin/plugin.json`) is the *global* MCP registration; `genie init` still writes per-repo `.mcp.json` (`init.ts:137-206`), so `genie mcp` survives per-repo.
- CI/release coupling: `ci.yml` `unit` job runs `lint:hook-bundles`, `lint:hook-content`, `lint:plugin-executables`, `fresh-install-smoke`; job `codex-smoke` (whole job); `release-publish.yml` jobs `prepare-delivery-evidence → attest-delivery-evidence → delivery-evidence-compatibility → codex-native-dogfood → codex-dogfood-completeness → stable-release-security-gate → publish` — `publish` is gated on `codex-dogfood-completeness` (`release-publish.yml:1032-1040`). `version.yml:196-203` and `scripts/release-guard.sh:156-192` hard-require the 7 plugin manifests to exist and match version. `scripts/build-binary.sh:57,75,117-150,215` copies `plugins/` into the tarball and fails if `plugins/genie/skills/<s>/SKILL.md` or `agents/openai.yaml` is missing.
- `install.sh:790-851` hands off to `genie install`; `:65,:907` emit the Codex "activation-pending" trailer. `package.json` `files` lists `plugins/genie/`.
- `.github/workflows/musl-adapter-smoke.yml:123` runs `genie setup --codex` — dies.
- DESIGN.md rev. 2 explicitly puts orca skills "no plugin, nos dois espelhos" and hangs `mode=` on `plugins/genie/scripts/src/session-context.ts` (IN §Modo) — both contradict rev. 3; the design must be rewritten, not amended.

**Risks / objections**
- **R1 (high) — hooks vanish silently.** After plugin removal Claude Code users lose PreToolUse guards and SessionStart context with no error. `src/hooks/` (6.9k) becomes dead code with no installer; knip will flag it (entry is `dispatch-command.ts` in `knip.json`).
- **R2 (high) — release pipeline is hard-wired to Codex evidence.** `publish` cannot run until `codex-native-dogfood`/`completeness`/`stable-release-security-gate` are rewritten; deleting `plugins/` on a branch without touching `release-publish.yml`/`version.yml`/`release-guard.sh` makes the next tag unpublishable.
- **R3 (medium) — existing installs keep an enabled plugin pointing at a marketplace path that no longer exists.** `~/.claude/settings.json.enabledPlugins['genie@automagik']` + marketplace cache of the last version keep running the old `dispatch-runtime.cjs`, which execs the *new* `$GENIE_HOME/bin/genie hook dispatch`. If `hook dispatch` is removed, every tool call in those sessions hits the fail-closed deny envelope (`src/hooks/index.ts` buildFailClosedResponse). That is the worst failure mode: stale plugin + new CLI = blocked editor.
- **R4 (medium) — `uninstall.ts` (145k) is the only code that knows how to remove plugin/Codex/Hermes residue.** Deleting it in the same PR as `plugins/` leaves no migration tool.
- **R5 (medium) — skills.sh publishing unverified.** Nothing in the repo references skills.sh; `skills/*/agents/openai.yaml` and `skills/work/references/native-surfaces.md` are Codex/Claude-specific sidecars whose survival under skills.sh is unknown. `skills-lint.ts` lints `skills/` only (good — it survives).
- **R6 (low) — orca prototype internally contradicts the model rule** (`skills/genie-orca/work/SKILL.md` "fast-tps workers (`claude --model sonnet`)"; `review/SKILL.md` "Codex reviews Claude-Sonnet work") — DESIGN Decision 8 already targets this; keep it in rev. 3.
- **R7 (low) — `hire_roster`** rides in `genie-db.ts`, `task-state.ts`, `v5-task.ts`, `roadmap-sync.ts` (excluded from sync). Dropping it needs a `user_version` bump + migration, not just deleting `ui-bridge.ts`.

**Required conditions**
1. PR-0 first: freeze a **standalone parity fixture** — snapshot `genie --help`, `genie task --help`, `genie board --json`, `genie mcp` tool list (`mcp-tools.ts:582-1118`), `task export` schema, and `tests/e2e/v5-lifecycle.sh` output on `main`; add them as golden tests. Every later PR must keep them byte-identical.
2. One **deprecation release** (`5.2608xx`) that still ships the plugin but: prints "plugin channel retires on <date>; run `genie uninstall --plugin-only`" from `genie update`/`doctor`; `install.sh` stops emitting the Codex activation trailer.
3. Decide hooks before deleting `plugins/`: either (a) `genie init --hooks` writes the SessionStart/PreToolUse entries into `~/.claude/settings.json` (keeping `src/hooks/`), or (b) delete `src/hooks/` too and accept no guards. Not deciding = R1/R3.
4. `release-publish.yml`, `version.yml`, `release-guard.sh`, `build-binary.sh`, `musl-adapter-smoke.yml` updated **in the same PR** as `plugins/` removal, with a dry-run tag on a fork/branch proving `publish` reaches `finalize`.
5. skills.sh install proven on a clean box for at least Claude Code + Codex before `plugins/genie/skills` is dropped (see §4).
6. DESIGN.md rewritten to rev. 3 and re-reviewed (currently FIX-FIRST, and its IN section places orca skills inside the plugin).

**Unknowns**
- skills.sh: whether it can carry `agents/openai.yaml`, `references/`, `templates/`, `scripts/` alongside SKILL.md, and whether it can inject SessionStart context (almost certainly not).
- External Codex/Hermes users (decides loudness of deprecation; no telemetry in repo).
- Whether `orca` mode wants `genie init` at all (only `.genie/INDEX.md` + wishes dirs, no `.mcp.json`, no db).

---

## 2. LEAVES / STAYS / STAYS-RESCOPED per inventory area

| Area | Call | Evidence / note |
|---|---|---|
| CLI: `install`, `update`, `setup --codex`, `__install-promote` | **STAYS-RESCOPED** | `install.sh:790-851` needs a finisher. Keep `install`/`update` as *binary-only* (download+verify+promote via `install-link.ts`, `install-transaction.ts`, `install-promotion.ts` trimmed); delete `--post-delivery-converge`, `update-integrations.ts`, `codex-delivery*.ts`, `codex-rollback.ts`, `local-delivery-repair.ts`. `setup` drops `--codex`. |
| CLI: `uninstall` | **STAYS-RESCOPED** | Keep one more release as the migration tool (removes `enabledPlugins`, marketplace dirs, `.codex/config.toml` marker block, hermes/pi residue), then shrink. Do **not** delete in the plugin-removal PR. |
| CLI: `doctor` (+`doctor-modes`, `doctor-worktrees`) | **STAYS-RESCOPED** | Drop codex/hermes observation checks (`doctor.ts:44-92` imports); keep db/worktree/index-lane checks. |
| CLI: `legacy-v4` | **LEAVES** (after one release) | v4 cleanup can ride the deprecation release then go. |
| CLI: `board`, `task`, `idea`, `init`, `context`, `mcp` | **STAYS** | Zero plugin coupling except `init.ts:27,206` (`codex-project-mcp`) — replace with plain `.mcp.json` write. `context` gains `mode=` (DESIGN IN). |
| CLI: `hook dispatch` + `src/hooks/` | **STAYS-RESCOPED or LEAVES — must decide** | Disagree with the brief's implicit "hooks die with the plugin": `branch-guard`/`git-freeze-guard`/`omni-approval` are standalone-valuable. Recommend keep + `genie init --claude-hooks` writer; otherwise delete cleanly, never leave dangling (knip). |
| CLI: `omni` + `omni-runner.ts`, `omni-queue.ts`, `global-db.ts` | **STAYS (unchanged)** | Not in scope; e2e asserts `genie omni status` works without config (`v5-lifecycle.sh:398-419`). Only its hook handler depends on the hooks decision. |
| CLI: `ui-bridge` + `bridge-watcher.ts` + `hire_roster` + `UI-BRIDGE.md` | **LEAVES** | Needs `genie-db.ts` schema `user_version` bump + drop-table migration; `roadmap-sync.ts` exclusion removed; `v5-task.ts` roster refs removed. |
| CLI: `shortcuts` | **STAYS** | tmux-only, no coupling. |
| `src/lib/agent-sync.ts` (7.4k) + `runtime-integrations.ts` (4.3k) + `hermes-*`, `codex-*` (all), `install-version-marker`, `update-capabilities`, `ordered-lifecycle-leases`, `codex-lifecycle-lease` | **LEAVES** | Pure plugin/delivery machinery; ~50k src LOC + ~30k test LOC. Delete in one PR after CI rewrite. `wish-status.ts`, `workspace.ts`, `genie-config.ts`, `genie-home.ts`, `trusted-executable.ts`, `version.ts`, `system-detect.ts`, `interactivity.ts`, `defaults.ts` STAY. |
| `src/lib/v5/*` | **STAYS** | The standalone body. `TAXONOMY.md` gets a mode paragraph. |
| `plugins/genie/scripts` (`session-context`, `validate-wish`, `dispatch-runtime`, `council-stamp`, `mcp-launcher`) | **LEAVES, with two rescues** | `validate-wish.ts` (and its fixture-driven section check) is the only wish validator — move to `scripts/` or `genie wish validate`. `session-context.ts` logic: either becomes a `genie context --session` verb the base skills call, or dies (DESIGN's `mode=` token must move to `genie context`). |
| `plugins/genie/agents/*.md` (7 role profiles) | **STAYS-RESCOPED** | Claude Code subagent profiles referenced by `work` ("named engineer role"). Disagree with silent deletion: relocate to `skills/work/agents/` or ship via skills.sh if it supports agents; else `work` must fall back to inline briefs. |
| `plugins/genie/workflows/council.js`, `rules/`, `references/{dispatch-contract,review-criteria,codex-integration-map,lenses}` | **LEAVES** | `council-workflow-lint.ts` and `council-workflow-stamp.test.ts` die with it. `skills/council` already resolves `references/native-surfaces.md` relative to itself. |
| `plugins/genie/skills` mirror + `scripts/sync-plugin-skills.ts` + `codex-plugin-only-smoke.ts` | **LEAVES** | Mirror exists only for the plugin; DESIGN Risk 10 evaporates. |
| `plugins/hermes-genie`, `plugins/pi-genie` | **LEAVES** | Python tests (`plugins/hermes-genie/tests/*.py`) are not in `bun test`; nothing else depends on them. |
| `skills/` | **STAYS** (source of truth) | `skills-lint.ts` already lints `skills/` only. Rescope `omni`, `genie-hacks`, `dream`, `pm`, `report` descriptions per mode. |
| `skills/genie-orca/*` | **STAYS-RESCOPED** | Promote to `skills/genie-orca-{wish,work,review}`; delete `scripts/retro-collect.ts` and `migrate-to-linear.ts` (DESIGN Decisions 9, OUT). |
| `packages/genie-ui` | **LEAVES** | Dist-only, no src imports. |
| `scripts/` release/signing (`release-guard`, `verify-release`, `sign-attest`, `materialize-release-subjects`, `reconcile-*`) | **STAYS-RESCOPED** | Keep signing/attestation; strip plugin manifest lists (`release-guard.sh:156-192`). |
| `scripts/` codex smokes + dogfood validators + delivery evidence (`codex-plugin-only-smoke`, `codex-smoke-harness`, `codex-debug-discovery-smoke`, `verify-codex-activation-payload`, `generate-codex-fallback-allowlist`, `build-delivery-evidence`, `verify-delivery-evidence-pack`, `candidate-dogfood-matrix`, `validate-*-dogfood-*`, `install-swap.test.ts`) | **LEAVES** | All plugin/Codex evidence. |
| `scripts/` lints: `hook-bundle-parity`, `hook-budgets-lint`, `hook-content-binding`, `plugin-executables-check`, `council-workflow-lint`, `sync-plugin-skills` | **LEAVES** | Remove from `package.json` `check`/`check:fast`, `.husky/pre-push` (runs `check:fast`), `ci.yml unit`. |
| `scripts/` lints: `skills-lint`, `wishes-lint`, `complexity-budget`, `version.ts` | **STAYS-RESCOPED** | `version.ts:199-202` and `scripts/build.js` manifest list shrink to `package.json` only. `fresh-install-smoke.ts:279` forbids plugin paths — keep, it becomes the positive proof. |
| CI: `ci.yml` | **STAYS-RESCOPED** | Drop `codex-smoke` job, 5 plugin lint steps, Node 22 pin justification (session-context tests). Keep `e2e` as the standalone gate. |
| CI: `release-publish.yml` | **STAYS-RESCOPED** | Delete `prepare-delivery-evidence`, `attest-delivery-evidence`, `delivery-evidence-compatibility`, `codex-native-dogfood`, `codex-dogfood-completeness`; re-point `stable-release-security-gate` and `publish.needs`. |
| CI: `musl-adapter-smoke.yml` | **STAYS-RESCOPED** | Replace `setup --codex` smoke with `init`+`board`. |
| CI: `version.yml`, `build-tarballs.yml`, `sign-attest.yml`, `release.yml`, `audit-next-tag`, `release-orphan-alert`, `signing-identity-pin`, `commitlint`, `docs-lint`, `rolling-pr` | **STAYS-RESCOPED / STAYS** | Only `version.yml:196-257` manifest list changes. |
| `install.sh` | **STAYS-RESCOPED** | Remove Codex trailer (`:65,:907`); keep verify+promote+`genie install` handoff. |
| docs/ | **STAYS-RESCOPED** | 29 mdx files mention plugin/codex/hermes; `installation`, `quickstart`, `config/setup`, `config/files`, `release-process`, `concepts/skills`, `concepts/byoa` need rewrite; `_internal/{genie-ui-two-faces,design-system,tui-host,spawn-*,sdk-executor-guide,detectors}` LEAVE. Lives in the `.docs-vendor` submodule → separate PR + pointer bump. |
| Live wishes | **STAYS-RESCOPED** | `release-ops-hardening` (DRAFT) must absorb the CI rewrite or be superseded. |

---

## 3. Base-skill vs orca-skill deltas

| Base skill | In orca mode | Delta / what board-disabled removes |
|---|---|---|
| `genie` (router) | STAYS, mode-aware | Bare-invocation counts via `ls .genie/wishes` (already file-based). Ops table rows 74-87 (`genie board`, `genie task list/done/checkout/status`, `genie context --plan`) all become "not in orca mode" — replace with `orca orchestration task-list --ready`, `run-show`, worktree state. State-detection `APPROVED → genie-orca-work`. |
| `brainstorm` | STAYS (unchanged prose) | Only step 115-117 (`genie task create` board pointer, already warn-and-continue) is dropped; `INDEX.md` is the pointer (DESIGN). |
| `wish` | STAYS + **overlay** `genie-orca-wish` | Base steps 77-80 (`genie task create --wish --group`) and 83/107 (`genie context --wish` wave-base pinning) are removed — orca's base is the `Base (branch @ sha)` header cell. Overlay adds SCOUT.md, `Orchestration`/`Tracker` header, Dispatch plan table, disjoint-files + integrator rules, model rule. Section names must stay validator-compatible (`validate-wish` fixture `--mode orca`). |
| `work` | **replaced** by `genie-orca-work` | Every base primitive is board-bound: `task checkout` (L25,103), `task list/board` (L21,28,106), `task done` (L43,139), `context --plan` (L82), "no task row → drive from WISH.md" fallback (L108). Orca version: Run/Task/worker-start/check --wait/worker-release, coordinator-owned merges, tracker writes, 2 human gates, dogfood, brief templates. Must add the DESIGN's refusal-without-Dispatch-plan and Run/Task reconstruction steps; must delete the `claude --model sonnet` line (L~60). |
| `review` | STAYS + **overlay** `genie-orca-review` | Base checklists (design/plan/execution/PR pipelines, severity tags) reused wholesale; only L192/196 (`genie task done` after SHIP) is removed. Overlay adds reviewer-as-read-only-worker contract, `VERDICT:` first line, re-run validation, tiers (group / gate 3-parallel / council / retro), fix-loop cap 2, adversarial-environment question. |
| `council`, `fix`, `trace`, `report`, `pm`, `dream` | `council`→ folded into orca-review tier (DESIGN); `fix` survives as the fix-brief content; `report/pm/dream` read the board → standalone-only (DESIGN OUT). |
| `docs`, `qa`, `perf`, `architecture`, `code-quality`, `repo-hygiene`, `supply-chain`, `dx-docs`, `refine`, `genie-hacks`, `omni` | STAY, mode-agnostic (no board refs). |

Overlay mechanism as designed ("load base, apply deltas, this file wins") has **no include primitive**; the testable proof is a lint that the orca SKILL.md's first instruction names the base skill and that base skills open with a `mode=orca` guard — achievable in `skills-lint.ts`. Without a hook injecting `mode=`, the guard must come from `genie context` output or a `.genie/config.json` read the skill performs itself.

---

## Safe deletion order (PR sequence, each independently revertible)

| # | PR | Gates that change | Rollback |
|---|---|---|---|
| 0 | **Parity fixture**: golden tests for standalone CLI/MCP/e2e (no deletions) | adds tests | trivial |
| 1 | **Deprecation release** (still ships plugin): deprecation notices in `update`/`doctor`, `install.sh` drops Codex trailer, `uninstall` gains plugin-only removal path, docs "plugin channel retires" page | none removed | revert tag |
| 2 | **UI leaves**: `packages/genie-ui`, `ui-bridge.ts`, `bridge-watcher.ts`, `hire_roster` (db migration), `UI-BRIDGE.md`, ui docs | knip, `genie-db.test`, `roadmap-sync` | db migration is additive-drop; keep `user_version` bump reversible by re-adding table |
| 3 | **CI/release rewrite** (before code deletion): `ci.yml`, `release-publish.yml`, `version.yml`, `musl-adapter-smoke.yml`, `release-guard.sh`, `build-binary.sh`, `build.js`, `version.ts`, `package.json` scripts — plugin steps made *optional/skipped* not deleted; dry-run tag proves `publish→finalize` | 5 unit-job steps, codex-smoke job, 5 release jobs | single-file reverts |
| 4 | **Hooks decision PR**: either `genie init --claude-hooks` writer (keep `src/hooks/`) or delete `src/hooks/` + `hook dispatch` | knip entry (`knip.json`), `tests/hooks/genie-hook-perf.test.ts` | isolated |
| 5 | **Delete `plugins/`** + `.claude-plugin/`, `.agents/plugins/`, `src/lib/{agent-sync,runtime-integrations,codex-*,hermes-*,install-promotion,install-transaction,install-version-marker,update-capabilities,ordered-lifecycle-leases}`, `src/genie-commands/{codex-*,local-delivery-repair,update-integrations,install-promote?}`, `scripts/{codex-*,*dogfood*,*delivery*,hook-*,plugin-executables-check,sync-plugin-skills,council-workflow-lint}`, `tests/integration/codex-*`, `tests/support/codex-*`, `install-swap.test.ts`; rescue `validate-wish.ts` + `session-context` logic first | ~70 test files, CLAUDE.md gotchas (`claude-md-drift.test.ts` will fail — update CLAUDE.md in same PR) | one big revert; that's why 3 and 4 precede it |
| 6 | **Rescope `install/update/setup/uninstall/doctor`** to binary-only | `install.test`, `update.test`, `setup.test`, `uninstall.test`, `doctor.test` (~350k bytes) rewritten | isolated |
| 7 | **Orca mode**: `GenieConfigSchema.execution.mode`, `.genie/config.json`, `GENIE_MODE`, `genie init --mode`, `genie context` prints `mode=`, promote `skills/genie-orca-*`, base-skill guards, `validate-wish --mode orca` fixture, skills-lint overlay rule | `skills-lint`, `wishes-lint`, `init.test`, `context.test` | isolated |
| 8 | **skills.sh publishing** + docs submodule PR + pointer bump | docs-lint | isolated |

## What dies with the plugin (gates)

- `package.json`: `lint:hook-bundles`, `lint:hook-budgets`, `lint:hook-content`, `lint:plugin-executables`, `lint:council-workflow`, `smoke:codex`, `smoke:codex-discovery`, `build:plugin`, `sync`, `build-and-sync`, `hooks:bind`; `check`/`check:fast` shrink to typecheck+lint+knip+skills+wishes+complexity+test.
- `.husky/pre-push` (`check:fast`) shrinks automatically.
- CI `unit`: 5 steps + the Node 22 pin rationale; `codex-smoke` job entirely; `release-publish`: 5 jobs; `musl-adapter-smoke`: the `setup --codex` step; `version.yml`: manifest fan-out.
- Tests: ~70 of 136 files (~38k LOC) + 4 Python files.
- `CLAUDE.md` Gotchas 1,2,5-9,11 describe removed machinery → `src/__tests__/claude-md-drift.test.ts` must be updated in PR 5.

## Migration / deprecation story for plugin users

1. Release N (PR 1): plugin still ships; `genie update`/`doctor` print retirement notice with date; docs page.
2. Release N+1 (PR 5/6): no plugin in tarball. `genie install` (via `install.sh`) runs the **plugin-residue cleanup** (retained `uninstall` logic: unset `enabledPlugins['genie@automagik']`, remove marketplace cache dirs, strip the marker-owned block in `.codex/config.toml`, remove `~/.genie/plugins`). This is what prevents R3 (stale `dispatch-runtime.cjs` + missing `hook dispatch` = fail-closed denial on every tool call).
3. `genie doctor` gains a "stale plugin enabled" check that stays for ≥2 releases.
4. Cross-version rule in CLAUDE.md ("second `genie update` then `setup --codex`") is replaced by: "update once; run `genie doctor`".

## Verifying skills.sh publishing

- No repo evidence of skills.sh contracts; verification must be empirical: on a clean `$HOME` (pattern from `scripts/fresh-install-smoke.ts`), install the skillset via skills.sh for Claude Code and Codex, then assert (a) every `skills/<name>/SKILL.md` frontmatter `name` appears in the runtime's skill list, (b) `skills/wish/templates`, `skills/*/references`, `skills/work/agents/openai.yaml`, `skills/review/references/design-review-evidence.mjs` are present at the installed path (skills reference them relatively), (c) byte-parity between `skills/` and the installed copy — reuse `sync-plugin-skills.ts --check` logic pointed at the install dir before deleting that script. Add this as a `skills-publish-smoke` CI job; it is the replacement for `codex-plugin-only-smoke`.
- Publishing hook: a `release-publish.yml` step after `finalize` that pushes `skills/` at the tag; `skills-lint.ts` remains the pre-publish gate.

## Evidence that standalone is untouched

- `tests/e2e/v5-lifecycle.sh` green on the built binary (already CI `e2e`; make `quality-gate` require it unchanged).
- PR-0 golden files: `genie --help` command list, `genie task --help`, `genie board --json` on a fixture, `genie mcp` tool names (`mcp-tools.ts` 17 tools), `task export` JSON shape, `roadmap.json` three-way sync behaviour (`.husky/pre-commit` path) — all diffed per PR.
- `src/lib/v5/*.test.ts` + `src/term-commands/{v5-board,v5-task,init,context,mcp,idea}.test.ts` (~15.5k LOC) unchanged in PRs 3-6 (assert via `git diff --stat` in PR description).
- `fresh-install-smoke.ts:279` (forbids `plugins/genie/references/`, `$GENIE_HOME/plugins/genie`) flips from "forbidden reference" to positive proof that no plugin path is ever written.
- Host baseline caveat: ~14 env-conditioned failures pre-exist on Felipe's host (memory note) — compare against a pristine-HEAD worktree, not zero.