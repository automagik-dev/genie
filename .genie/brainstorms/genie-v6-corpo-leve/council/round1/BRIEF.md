# Council brief — genie v6 "corpo leve", rev. 3 simplification (Felipe, 2026-08-25)

Repo: /home/namastex/workspace/repos/genie (branch v6/corpo-leve). READ-ONLY: assess, do not mutate.

## Decision statement
Simplify genie by:
1. **Deleting `plugins/` entirely** — Claude Code plugin (`plugins/genie`: .claude-plugin, .codex-plugin, .kimi-plugin, hooks, scripts, agents, workflows, rules, references, skills mirror), `plugins/hermes-genie` (Python), `plugins/pi-genie`. With that: plugin-delivered hooks, the marketplace/activation/delivery machinery (`genie update` authenticated delivery, `genie setup --codex`, `src/lib/codex-*.ts`, install-promotion/transaction/version-marker, `agent-sync.ts` fan-out of role agents), and the Codex/Hermes/pi bridges.
2. **Skills published instead as a skillset on https://www.skills.sh/** (universal detection + install across Claude Code / Codex / Hermes / pi etc.). `skills/` stays as the source of truth.
3. **A simpler CLI harness with only what is really needed.**
4. **`genie board` STAYS** for the *standalone* installation (SQLite `.genie/genie.db` + `roadmap.json` + sync hooks + `genie task *` + `genie mcp` read/write tools).
5. **New installation mode `orca`** (was going to be "lite"): board DISABLED, ships a DIFFERENT Orca-focused skillset — the overlays prototyped in `skills/genie-orca/{wish,work,review}` (`genie-orca-wish`/`-review` overlay the base skill; `genie-orca-work` fully replaces `work`). Design: `.genie/brainstorms/genie-v6-corpo-leve/DESIGN.md` (rev. 2, FIX-FIRST twice; it still frames itself as "a mode, not a rewrite" and keeps standalone semantics OUT — rev. 3 must absorb points 1–3 and 5).
6. **genie has NO UI and NO khal/desktop surface** — `packages/genie-ui`, `genie ui-bridge` command (`src/term-commands/ui-bridge.ts`, `src/lib/v5/bridge-watcher.ts`, `hire_roster` table + `UI-BRIDGE.md`), desktop-related docs (`docs/_internal/genie-ui-two-faces.mdx`, `design-system.mdx`, `tui-host`) are candidates to leave.

## Constraints
- Felipe is a solo maintainer; no second-approver gates.
- Standalone mode must keep working for existing repos (board, roadmap.json sync, wish lifecycle statuses DRAFT/FIX-FIRST/APPROVED/IN_PROGRESS/BLOCKED/SHIPPED).
- The first real orca-mode wish (`caio-cria-ds-tokens-hapvida`, in another repo) is v5-shaped and enters orca mode only by explicit amendment (Dispatch plan).
- Model rule: no haiku/sonnet in dispatch plans; coordinator on Fable; heavy load `codex gpt-5.6-terra --effort xhigh`.
- Orca owns dispatch/worktrees/receipts; Linear/GitHub own status; brain owns preferences.

## Surface inventory (measured 2026-08-25)
- CLI (`src/genie.ts` registers): doctor, install, setup, shortcuts, show, uninstall, update + term-commands: context, hook (dispatch), idea, init, mcp, omni, shortcuts, ui-bridge, board (v5-board), task (v5-task). CLAUDE.md lists 16 commands.
- `src/genie-commands/` (31.6k LOC): auxiliary-trees, codex-delivery-repair, codex-delivery, codex-rollback, doctor-modes, doctor-worktrees, doctor, install-promote, install, legacy-v4, local-delivery-repair, setup, shortcuts, uninstall, update-integrations, update.
- `src/lib/` (65.7k LOC): agent-sync 7462, runtime-integrations 4271, omni-runner 2669, codex-activation 2158, install-promotion 2049, codex-lifecycle-lease 1068, codex-project-mcp 1028, codex-delivery-evidence 957, codex-activation-executor 834, hermes-skills-config 728, install-transaction 622, hermes-mcp-config 585, update-capabilities 558, install-link 393, codex-host-observation 378, workspace 335, codex-lifecycle-truth 279, codex-mcp-health-session 246, codex-activation-persistence 214, wish-status 186, interactivity 173, defaults 171, trusted-executable 166, omni-config 164, plus claude-settings, codex-config, codex-release-version, genie-config, genie-home, install-version-marker, omni-matching, omni-registration, omni-signature, ordered-lifecycle-leases, system-detect, term-format, version.
- `src/lib/v5/`: base-state, bridge-watcher, card-render, genie-db, global-db, identity, launch-worktrees, mcp-server, mcp-tools, omni-queue, resolve-wish-branch, roadmap-sync, sqlite-open, task-state, TAXONOMY.md, UI-BRIDGE.md.
- `src/hooks/` (6.9k): index (handler chain, fail-closed), dispatch-command, codex-adapter, trust, env-identity, shell-quoting, handlers: freshness, git-freeze-guard, omni-approval, audit-context, branch-guard, identity-inject.
- `plugins/genie/scripts` (4.5k, incl. generated `session-context.cjs` — parity is a release gate), `plugins/genie/agents/*.md` (engineer-trivial/standard/complex, fixer, scout, reviewer, final-gate), `plugins/genie/workflows/council.js`, `plugins/genie/rules/genie-orchestration.md`, `plugins/genie/references/{dispatch-contract,review-criteria,native-surfaces,codex-integration-map,lenses/}`, `plugins/genie/codex-agents`, `plugins/genie/skills/*` (mirror of skills/, byte-identity enforced by `scripts/codex-plugin-only-smoke.ts` and `scripts/sync-plugin-skills.ts`).
- `skills/`: architecture, brainstorm, code-quality, council, docs, dream, dx-docs, fix, genie (router), genie-hacks, omni, perf, pm, qa, refine, repo-hygiene, report, review, supply-chain, trace, wish, work, + `skills/genie-orca/{wish,work,review,scripts/retro-collect.ts}` prototype.
- `packages/genie-ui` (21.7k LOC, dist only).
- `scripts/` (16.7k): release/signing/attestation (release-guard, release-immutability, sign/attest, verify-release, materialize-release-subjects, reconcile-*), codex smokes (codex-plugin-only-smoke, codex-smoke-harness, codex-debug-discovery-smoke, verify-codex-activation-payload, generate-codex-fallback-allowlist, build-delivery-evidence, verify-delivery-evidence-pack, candidate-dogfood-matrix, validate-*-dogfood-*), lints (skills-lint, skills-audit, wishes-lint, complexity-budget, council-workflow-lint, hook-budgets-lint, hook-bundle-parity, hook-content-binding, plugin-executables-check), build (build.js, build-binary.sh, run-musl-dogfood.sh), sync-plugin-skills, backfill-roadmap-wish, version.
- CI workflows: audit-next-tag, build-tarballs, ci, commitlint, docs-lint, musl-adapter-smoke, release-orphan-alert, release-publish, release, rolling-pr, sign-attest, signing-identity-pin, version.
- docs/: installation, quickstart, onboarding, features, hacks, contributing, release-process, architecture/, cli/, concepts/, config/, incident-response/, observability/, security/, skills/, _internal/ (agent-frontmatter, agent-profiles, architecture, cli-reference, co-orchestration-guide, design-system, detectors, event-emitters-inventory, genie-ui-two-faces, observability-*, release-architecture, retention, runbooks, sdk-executor-guide, spawn-auto-resume, spawn-team-resolution, state-machine, templates, tui-host).
- Live wishes after today's triage: v4-home-residue-doctor (DRAFT), release-ops-hardening (DRAFT); 37 archived under `.genie/wishes/archive/`.

## Explicit unknowns
- What skills.sh actually provides for install/detect across runtimes (hooks? agents? only SKILL.md dirs?). If it only ships SKILL.md directories, everything that today rides in the plugin besides skills (hooks, agents/role profiles, workflows, rules, references) needs a new home or dies.
- Whether the SessionStart context injection (`session-context.ts`: wish/task/session context + the planned `mode=` token) survives without a plugin-installed hook — the base skills may have to read state themselves.
- Whether Codex/Hermes users exist beyond Felipe's own machines (affects how loudly the plugin removal must be deprecated).
- Omni runner (`genie omni serve`, NATS bridge, approval queue in global genie.db): not mentioned by Felipe either way.
- What the `orca` install mode concretely disables: only board/task/mcp verbs, or also the sync git hooks, `genie init` scaffolding of `.genie/`, `context`?

## What each lens must return
1. The standard lens response block (Verdict / Confidence / Key evidence / Risks or objections / Required conditions / Unknowns).
2. Your lens's own LEAVES / STAYS / STAYS-RESCOPED call for each inventory area above (one line each; cite paths; say where you disagree with the proposal).
3. Your view of the base-skill vs orca-skill deltas (read `skills/wish|work|review|brainstorm|genie/SKILL.md` and `skills/genie-orca/*/SKILL.md`): which base skills exist in orca mode, which are overlaid/replaced, what the board-disabled mode removes from each.
Ground every claim by reading the code/skills. Cite file paths. Be terse: bullets, tables.
