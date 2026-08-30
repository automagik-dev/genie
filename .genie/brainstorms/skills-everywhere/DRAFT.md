# Brainstorm: skills-everywhere (renamed 2026-08-30 from codex-skill-installer)

**Slug:** `skills-everywhere` · **Started:** 2026-08-30 · **WRS:** 100/100 — crystallized to DESIGN.md

## Request (verbatim)
"replace codex plugin, make it a light weight skill installer, also, i want to adopt skills.sh in the skill distribution method"

## Problem (✅)
The Codex integration ships as a full Codex plugin with authenticated delivery, activation via `genie setup --codex` (interactive-TTY only), fallback retirement, role-profile convergence, delivery-repair/rollback commands and a required release dogfood matrix — ~55 source files, `runtime-integrations.ts` alone 4.2k lines — while Genie's actual value to a Codex session is the skill set. Dogfood on 2026-08-30 (stable v5.260830.16): the plugin still needed a manual interactive activation after `genie update`; doctor reported plugin identity/version mismatch.

## Scope (✅)
IN:
- Retire the Codex *plugin* delivery/activation subsystem: `setup --codex` activation, plugin cache generations, fallback retirement, delivery repair/rollback commands, plugin-identity doctor checks, release dogfood-matrix gate.
- Skills reach Codex through skills.sh: canonical command `npx skills add automagik-dev/genie -a codex -g` (repo `skills/` is already compatible — verified `--list` shows all 22).
- `genie install`/`update` become a thin wrapper that runs that same command (plus Claude later) and records the pinned ref; no bespoke copy/digest machinery for skills.
- Hooks H3/H4/H6 re-homed to global `~/.codex/hooks.json` entries pointing at `~/.genie/...` scripts, managed marker-first like `.codex/config.toml` routes today.
- Role agents keep `~/.codex/agents/*.toml` (already plugin-independent).
- One-time migration: backup-first removal of `[plugins."genie@automagik"]`, its hook trust state and cache dir; doctor reports the new surface.
- Release gate replacement: a skills-install smoke (fresh container: `npx skills add automagik-dev/genie@<sha> -a codex -g -y` → 22 skills present → one `codex exec` invoking `$wish`).
OUT:
- Claude Code plugin/marketplace (separate follow-up; skills.sh can serve it later).
- Board/task runtime, Orca plugin, Omni (untouched).
- Signing skills content (skills.sh has no verification; accepted risk, see Risks).

## Decisions (✅ — user picks 2026-08-30: D1 skills.sh THE channel; D2 superseded by user 2026-08-30: 'skills + cli, nothing else, everywhere except orca' → hooks, role agents, council stamp, Hermes/pi links all deleted; D3 all detected agents; single smoke gate)
- D1 skills channel: skills.sh is THE channel (genie wraps it) vs. genie copies its signed tarball skills and skills.sh is an alternative. → recommend A (one channel; simplest).
- D2 hooks: keep H3/H4/H6 via `~/.codex/hooks.json` vs. drop Codex hooks entirely. → pending user.
- D3 gate: replace dogfood matrix with skills-install smoke (1 job, not 4-platform matrix). → recommend.
- D4 pinning: `automagik-dev/genie@<tag>` per release vs. floating main. → recommend pin to release tag written by `genie update`.

## Risks (✅)
- R1 Trust downgrade: skills.sh does no integrity/signature verification — content is whatever the git ref serves. Mitigation: pin to the release tag (`@v<version>`, verified working), tags are immutable-release protected; genie records the installed ref; hooks/agents/binary keep the signed tarball path.
- R2 Node/npx dependency at install time (skills.sh is an npm CLI). Mitigation: genie preflight `node`/`npx` presence with a clear message; `--copy` so the result is plain files (no symlinks into an npx cache; Codex sandbox and umask-077 hosts behave better with copies).
- R3 Gate regression: dropping the 4-platform Codex dogfood matrix loses the "task/board works from a Codex session" proof. Mitigation: one skills-install smoke job (fresh container → `npx skills add …@<sha> -a codex -g -y --copy` → 22 skills present → `codex exec` runs `$wish --help`-class invocation) — smaller but still black-box.
- R4 Migration on hosts with an enabled plugin generation: `[plugins."genie@automagik"]`, hook trust rows, `~/.codex/plugins/cache/automagik/genie/*` must be retired backup-first (existing marker-owned config.toml pattern) or Codex loads both plugin skills and `~/.codex/skills` copies (duplicate `$genie:*` vs bare names).
- R5 Doctor/CLAUDE.md/docs carry many plugin-era gotchas (separate delivery/activation owners, H3/H4/H6 trust, fallback retirement) — must be rewritten or they mislead.
- R6 skills.sh CLI is external and moving (`experimental_*` subcommands); wrap only the stable `add`/`list`/`remove` surface and pin a tested CLI version in genie's wrapper (`npx -y skills@<ver>`).
- Constraint: no interactive-TTY step may remain in the Codex path (the plugin's activation requirement is the pain being removed).

## Criteria (✅)
- C1 Fresh host: `genie install` (non-interactive) → `~/.codex/skills/<22 names>/SKILL.md` present, byte-equal to the release tag's `skills/`; no `[plugins."genie@automagik"]` in config.toml; `codex exec` can invoke `$wish`.
- C2 `genie update` to a new version re-runs the install pinned to the new tag; `genie doctor` reports `codex skills: 22/22 @ v<version>`; zero interactive prompts.
- C3 Host with the old plugin enabled: `genie update` retires it backup-first; doctor shows no plugin generation, no duplicate skill names visible to Codex.
- C4 Hooks (if kept): `~/.codex/hooks.json` carries the marker-owned genie entries; removing genie (`genie uninstall`) leaves the file with only foreign entries (Orca's) intact.
- C5 Repo: `src/genie-commands/codex-delivery*.ts`, `codex-rollback.ts`, plugin activation paths in `runtime-integrations.ts`, and the release dogfood matrix are deleted (not disabled); `bun run check` green; release-publish has the skills-install smoke as a required job.
- C6 Users outside genie can `npx skills add automagik-dev/genie` and get the same 22 skills (already true — regression-guarded by a CI `--list` assertion = 22).

## Criteria (░)

## Simplicity gate
Simplest complete design: `genie install/update` = run `npx -y skills@<pinned> add automagik-dev/genie@v<version> -a codex -g -y --copy`, write the marker-owned hook entries, retire the legacy plugin once. Everything the plugin subsystem added on top (activation ceremony, generations, fallback lanes, delivery repair/rollback, 4-platform dogfood evidence) exists to prove *plugin bytes* — with skills as plain files pinned to a tag, that proof collapses to "files match tag", which the smoke job checks. No new durable states beyond the recorded ref.

## Context gathered
- `npx skills add automagik-dev/genie@v5.260830.16 --list` → "Found 22 skills" (also `#ref` and `/tree/<ref>` URL forms). CLI has `update`, `remove`, `--copy`, `-g`, `-a codex`, `skills-lock.json` (experimental restore).
- Codex global skill dir `~/.codex/skills` (exists on host, empty); project `.agents/skills`.
- Global `~/.codex/hooks.json` is live (Orca entries) → plugin not required for hooks.
- Role agents already in `~/.codex/agents/*.toml` (7 managed), plugin-independent.
- `genie-dual-mode-orca-plugin` DESIGN mentions Codex nowhere → orthogonal; no dependency.
- Plugin payload `plugins/genie`: skills/ (22 canonical), hooks/codex-hooks.json (session_start, pre_tool_use, permission_request), codex-agents/ (7 managed role profiles), workflows/, rules/, scripts/, orca-entrypoint.
- Host: `~/.codex/plugins/cache/automagik/genie/1.0.0`, `[plugins."genie@automagik"]` in config.toml + per-hook trust state.
- Related: `genie-dual-mode-orca-plugin` DESIGN (WRS 100) already retires MCP and "rehomes standalone skills, role templates and supported hooks required after legacy plugin-delivery cleanup".

## Review round 1 (2026-08-30T16:04Z, genie:reviewer) — FIX-FIRST → rev. 2
H1 nested genie-orca skills invisible to skills.sh (verified: 22 on every ref; --full-depth 23 due to name collision) → inventory = top-level dirs, orca skills move to unique top-level names. H2 Orca plugin exists on dev/main not on v6 → base=dev, Risk 12. H3 dual-mode rehome clause superseded explicitly. H4 lease/atomic-fs rehomed. H5 all six handlers listed with accepts + C9 ruleset pre-check. H6 sizes corrected, umbrella split A→B→C. H7 update-path smoke retained. M1–M11, L1–L5 applied.

## Review round 2 (2026-08-30T16:13Z) — FIX-FIRST narrow (N1–N9) → rev. 3
N1 six check gates + orca-bundle/wishes:lint kept; N2 C9 restated to what rulesets prove + actor gap accepted; N3 WISH.md amendment + Risk 15 sequencing; N4 correct wc command; N5 Orca OUT list + call sites; N6 v6→dev before Wish B; N7 clean-archive sizes; N8 path; N9 land on dev.

## Review round 3 (2026-08-30T16:16Z) — FIX-FIRST literal (F1–F5) → rev. 4: push-vs-merge control named correctly; C4 baseline 57,771 (clean dev) re-measured at Wish-A merge; stale counts; risk order; plugin executables enumerated.

## Review round 4 (2026-08-30T16:19Z) — FIX-FIRST (F6–F9) → rev. 5: Kimi integration added to deletions; build/release toolchain enumerated from full `git grep plugins/genie` consumer trace as its own Wish-B group + C11; validate-wish.ts rehomed for wishes:lint; mcp-launcher.cjs (nonexistent) replaced by validate-wish.cjs.

## Review round 5 (2026-08-30T16:22Z) — FIX-FIRST (G1–G4) → rev. 6: C11 rewritten (version.ts --check read-only mode as a deliverable; version.yml evidence via existing tests + first post-promotion bump; --verify-source takes repo root); seven toolchain test files listed; C11 after C10.

## Review rounds 2–5 (2026-08-30, genie:reviewer) — FIX-FIRST ×4 → SHIP at rev. 6
- Round 2 (16:13Z): six `check` gates incl. `lint:plugin-skills`; `lint:orca-bundle`/`wishes:lint` kept; C9 restated to what rulesets prove + actor gap; dual-mode WISH.md amendment + Risk 15; correct `wc` command; Orca OUT list + three surviving call sites; v6→dev before Wish B; clean-archive sizes; dispatch-runtime path; land on dev.
- Round 3 (16:16Z): push-vs-merge control named correctly; C4 baseline 57,771 re-measured at the Wish-A merge; stale counts; risk order; plugin executables enumerated.
- Round 4 (16:19Z): Kimi integration added to deletions; build/release toolchain enumerated from the full `git grep plugins/genie` consumer trace (24 files) as its own Wish-B group + C11; validate-wish.ts rehomed for wishes:lint; validate-wish.cjs replaces the nonexistent mcp-launcher.cjs.
- Round 5 (16:22Z): C11 rewritten — `version.ts --check` read-only mode as a deliverable; version.yml evidence via existing tests + first post-promotion bump; `--verify-source .`; seven toolchain test files; C11 after C10.
- SHIP (16:23Z) digest `500ebbc9…`; re-stamped `fafaef24…` (16:51Z) after the rename to `skills-everywhere`.

## Wish A
`.genie/wishes/skills-everywhere/WISH.md` — plan review SHIP at rev. 5 (`10495bc5…`, 16:54Z) after four FIX-FIRST rounds; status APPROVED; wave base `b52dfff2b`.
