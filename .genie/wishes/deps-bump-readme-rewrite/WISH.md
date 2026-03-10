# Wish: Dependency Bump + README Rewrite

| Field | Value |
|-------|-------|
| **Status** | APPROVED |
| **Slug** | deps-bump-readme-rewrite |
| **Date** | 2026-03-10 |
| **Design** | [DESIGN.md](../../brainstorms/deps-bump-readme-rewrite/DESIGN.md) |

## Summary

Bump all safe dependencies to latest compatible versions and rewrite the README with cognitive-load-reduction positioning ("Wishes in, PRs out"), pain-first voice, and a streamlined ~120-line structure. The current README undersells the product with abstract jargon and insider terminology; the new one leads with developer pain and shows how Genie eliminates it.

## Scope

### IN
- Bump safe dependency versions (patches, minors, and cautious majors per design D6)
- Full README.md rewrite with new positioning, structure, and content blocks from design
- CLI reference and configuration moved to collapsed `<details>` sections

### OUT
- Plugin marketplace listing
- Comparison pages vs competitors
- Video/GIF/demo recording
- Architecture diagram
- Blog posts or content strategy
- Zod v4, Biome v2, UUID v13, Inquirer v8, Commander v14 (breaking majors — separate wish)

## Decisions

1. **Positioning:** Cognitive load reduction — "Wishes in, PRs out"
2. **Voice:** Third-person, pain-first. No first-person Genie voice.
3. **Tagline:** Hero: "Wishes in, PRs out." Subtitle: "Describe the problem. Genie interviews you, plans the work, dispatches agents, and reviews the code. You approve and ship."
4. **Dep strategy:** Safe bumps only. Stay on current majors for risky packages.
5. **README structure:** Hero → What is Genie (3 sentences) → Right for you if → 3-step quickstart → Feature grid → Without/With pain table → Wish Pipeline → CLI (collapsed) → Config (collapsed) → Dev → Community

## Success Criteria

- [ ] All safe dependency bumps applied per design D6
- [ ] `bun run check` passes (typecheck + lint + dead-code + test)
- [ ] README body under 150 lines (excluding collapsed `<details>` sections)
- [ ] No first-person voice anywhere in README
- [ ] 3-step quickstart present (install → launch → wish)
- [ ] Feature grid present (3x3 or similar scannable format)
- [ ] "Without/With" pain table present (6 rows)
- [ ] No `--dangerously-skip-permissions` in any README example
- [ ] CLI reference in collapsed `<details>` section
- [ ] Prerequisites listed explicitly

## Execution Groups

### Group 1: Dependency Bump

**Goal:** Update all safe dependencies to latest compatible versions.

**Deliverables:**
- Updated `package.json` with bumped version ranges
- Updated `bun.lock` via `bun install`
- Any code changes needed for API differences (commander v13 if breaking)

**Acceptance Criteria:**
- [ ] @types/bun bumped to ^1.3.10
- [ ] @types/node bumped to ^22.0.0
- [ ] esbuild bumped to ^0.27.3
- [ ] knip bumped to ^5.86.0
- [ ] typescript bumped to ^5.8.0
- [ ] zod bumped to ^3.25.0
- [ ] No type errors after bump
- [ ] All 527+ tests pass

**Validation:**
```bash
bun install && bun run check
```

---

### Group 2: README Rewrite

**Goal:** Rewrite README.md with cognitive-load positioning and pain-first structure.

**Deliverables:**
- New `README.md` following design D4 structure
- Pre-written content blocks from design integrated
- CLI reference and config in collapsed sections

**Acceptance Criteria:**
- [ ] Hero + badges + "Wishes in, PRs out" tagline
- [ ] "What is Genie?" — 3 sentences
- [ ] "Right for you if" — 6-item pain checklist
- [ ] 3-step quickstart (install, launch, wish)
- [ ] Feature grid (scannable, not a wall of text)
- [ ] "Without/With" pain table (6 rows from design)
- [ ] Wish Pipeline section (flow + descriptions)
- [ ] CLI reference in `<details>` (updated for current commands)
- [ ] Config in `<details>`
- [ ] Community + License footer
- [ ] Under 150 lines excluding collapsed sections
- [ ] No first-person voice
- [ ] No `--dangerously-skip-permissions`
- [ ] Prerequisites listed (macOS/Linux, Bun 1.3.10+, Claude Code)

**Validation:**
```bash
# Line count check (excluding collapsed sections)
awk '/^<details/,/^<\/details>/{next}1' README.md | wc -l
# Must be under 150
```

## Assumptions & Risks

- **R1:** Commander v13 may have breaking API changes — mitigated by test suite; if breaks, stay on v12
- **R2:** "Wishes" is jargon to newcomers — mitigated by plain language in hero, term introduced in body
- **R3:** Feature grid may undersell depth — mitigated by linking to docs/Discord for details

## Dependencies

- None (standalone wish)
