# DRAFT: plugin-resource-shipping (squeeze-in — fresh-install gap, found live 2026-07-09)

**Parent:** genie-token-efficiency-program (umbrella deleted in the 2026-09-19 triage) (extends G2/G3 distribution scope) · **Status:** Simmering — small, urgent, wishable fast

## KNOWN (evidence, audited on this machine)
- `plugins/genie/skills` is a relative symlink → `../../skills`. It RESOLVES in shipped artifacts: marketplace install = full repo clone; CC's runtime cache (`~/.claude/plugins/cache/automagik/genie/<ver>/skills/`) materializes real dirs; dist platform builds materialize too. **Skills ship fine.**
- **The wish skill's runtime resources do NOT ship**: shipped SKILL.md instructs `cp templates/wish-template.md` (repo-ROOT templates/, not in the plugin) and `bun run wishes:lint` (`scripts/wishes-lint.ts` + package.json script, genie-repo-only). Both run in the USER'S cwd on a fresh install → fail. Observed live: fresh-install Claude hunting for template/design with searches + shell probes.
- Same class of issue latent elsewhere: brainstorm repo copy referenced nonexistent `.genie/brainstorm.md`; fix references dead `genie task comment/block`. Pattern = skills assume genie-repo working tree.
- Global ~/.claude/skills rewrites (template INLINED, lint checklist INLINED, native Task fallback) exist ONLY on Felipe's machine — fresh installs never get them. Confirms convergence direction: the dual-backend/inline pattern must land in the REPO skills that actually ship.
- Installed cache pinned at `5.260703.5` (2026-07-03, pre-fable5-revamp) — plugin updates ride releases, not dev; stale-skill window is real.
- Bonus: `scripts/uninstall.js` references `~/.agents/skills/genie` — an existing Codex skills symlink surface (feeds cross-agent-delegate).

## PROPOSED (to refine)
1. **Resource-shipping contract**: every runtime resource a skill needs lives UNDER the skill dir (or plugin dir) and is addressed via `${CLAUDE_SKILL_DIR}` / `${CLAUDE_PLUGIN_ROOT}` — never repo-root paths, never target-repo package.json scripts. Enforced by a lint (extends the G2 duplication-lint: "no repo-root resource references in skills/").
2. Immediate fixes: wish template → `skills/wish/templates/wish-template.md` (or inlined, matching the global rewrite); lint → self-contained checklist in-skill (global pattern) with `bun run wishes:lint` as genie-repo bonus when present (dual-backend probe, same as work skill's `genie task --help` probe).
3. Fresh-install smoke test in CI: install the built plugin into a bare tmp repo, run a scripted /brainstorm→/wish pass, assert no missing-resource errors (ties into hook-fixture CI from always-on-genie).
4. Release-lag mitigation: document/verify plugin update path (`/plugin update` cadence or genie update touching the marketplace clone).

## SWEEP RESULTS (2026-07-09 — gaps 2+3 closed with evidence)
- Offenders: **skills/wish** (`cp templates/wish-template.md` ×2, `bun run wishes:lint` ×2, `scripts/wishes-lint.ts` mention) and **skills/brainstorm:85** (`bun run wishes:lint`). That's the whole list.
- Clean precedent: **skills/council** already ships its template in-skill and addresses it as `${CLAUDE_SKILL_DIR}/templates/report.md` — the contract to standardize on. skills/genie also uses `${CLAUDE_SKILL_DIR}`.
- Non-issues: skills/work `bun run check` is an example string; genie-hacks catalog `bun run build` is recipe content.
- `~/.agents/skills/genie`: referenced ONLY by scripts/uninstall.js cleanup — v4 residue; nothing creates it today. (Feeds cross-agent-delegate: mint fresh if wanted.)

## FIX SHAPE (refined)
1. Canonical template moves INTO the skill: `skills/wish/templates/wish-template.md`; wish skill copies via `${CLAUDE_SKILL_DIR}`; repo-root `templates/wish-template.md` deleted, repo tooling (wishes-lint scaffolding refs) repointed. **Cross-wish dep: after routing-matrix G3 lands its template edits** (don't reopen a SHIP-reviewed wish).
2. Lint invocation goes dual-backend: in-skill checklist always applies; `bun run wishes:lint` only behind an existence probe (same pattern as work skill's `genie task --help` probe). brainstorm:85 reworded the same way.
3. Resource-shipping lint: extend `scripts/skills-lint.ts` — skills may not reference repo-root resources (`cp templates/`, unguarded `bun run`); `${CLAUDE_SKILL_DIR}`/`${CLAUDE_PLUGIN_ROOT}` required for skill-shipped files.
4. CI fresh-install smoke (minimal): every `${CLAUDE_SKILL_DIR}` path referenced by any SKILL.md resolves inside the built plugin tree; scaffold flow exercised in a bare tmp repo.
5. Release-lag: docs note on `/plugin update` cadence only (auto-update machinery OUT).

## GAPS
- [x] **Sequencing — DECIDED (Felipe 2026-07-09): own fast wish**, cross-wish dep on routing-matrix G3 for the template move; convergence builds on the shipped baseline.

## STATUS: WISH-READY (all gaps closed 2026-07-09)
