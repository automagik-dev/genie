# DRAFT: control-plane-contract (Domain C — umbrella G2+G3)

**Parent:** [genie-token-efficiency-program](../genie-token-efficiency-program/DESIGN.md) · **Status:** Raw

## KNOWN (evidence)
- Same dispatch contract duplicated ~6× (work, pm, dream, council, fix, rules/genie-orchestration.md).
- plugins/genie/references/dispatch-contract.md is v4 (TeamCreate, model:"sonnet", codex_subagent); review-criteria.md says max-3 loops vs skills' max-2; plugin README advertises nonexistent skills/agents.
- Global ~/.claude/skills {brainstorm,wish,work,review} = NEWER dual-backend rewrites (CLI-optional, native Task fallback, each with SKILL.v4-backup.md); repo copies = stronger contracts (reviewer≠engineer, orchestrator-owns-done, wishes:lint). Jar filename drift: repo brainstorm/dream → nonexistent .genie/brainstorm.md; real file .genie/INDEX.md.
- Global brainstorm design-template group headers are in Portuguese (localization drift).

## DECIDED (umbrella D5, D6, D8; Hermes)
- dispatch-contract.md → THE single versioned executable reference: schema, route matrix (hosts the routing matrix), context-diet + verification-budget policy text, lint, deprecation map, CI duplication check (fails if canonical text re-duplicated into skills).
- Convergence by LAYER, not by base: global = runtime/adapter base; repo = contract/invariant base; golden tests assert both obey the contract. Rule: execution-without-CLI diffs → global wins; done/review/lint/role-separation diffs → repo wins. Repo = distribution source again.
- work/review policy refactor rides here: per-role context diets (scouts: question+paths; engineers: group+acceptance+relevant files; reviewers: diff+acceptance+proof; final gate: WISH+aggregate evidence; fixers: finding+diff+failing proof); orchestrator verification budget (evidence checklist before accepting a group); reviewer coverage-first prompt + BLOCKER/FIX-FIRST/FOLLOW-UP/NIT.

## GAPS
- [ ] **Collision: skills-fable5-revamp wish** (G1–G8 committed on dev, awaiting execution review) touches the same skill files. Sequence: finish its execution review first, or fold its residue into this wish?
- [ ] Distribution model: who else installs the plugin / global skills? (affects how aggressive the global↔repo cutover can be, and whether SKILL.v4-backup.md files can be deleted)
- [ ] Contract versioning scheme: semver in frontmatter? tie to plugin version (5.x auto-bumps)?
- [ ] Portuguese vs English for template headers — pick one deliberately.
