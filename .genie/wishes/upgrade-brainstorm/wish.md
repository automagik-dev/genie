# Wish: Upgrade Brainstorm Skill with Handoff Output

**Status:** REVIEW
**Slug:** `upgrade-brainstorm`
**Created:** 2026-02-09

---

## Summary

Add a structured handoff phase to the brainstorm skill that writes a `design.md` document to `.genie/brainstorms/<slug>/design.md`. This gives `/wish` a concrete artifact to consume instead of relying on conversational context. Also add a design template reference file for consistent output format.

---

## Scope

### IN
- Create design template reference file at `skills/brainstorm/references/design-template.md`
- Add Phase 6 (Write Handoff Document) to brainstorm `SKILL.md`
- Ensure all existing phases remain intact
- Reference the design template from the handoff phase

### OUT
- Changes to other skills (wish, make, review, council)
- New features beyond the handoff document
- Changes to the wish template
- TypeScript/CLI code changes
- Local `.claude/skills/brainstorm/` cleanup (does not exist — already clean)

---

## Decisions

- **DEC-1:** Output location is `.genie/brainstorms/<slug>/design.md` — keeps brainstorm artifacts separate from wishes
- **DEC-2:** Template uses markdown sections (not YAML/tables) for readability and flexibility
- **DEC-3:** Design status field is `VALIDATED` — signals the design is ready for `/wish` consumption
- **DEC-4:** Template lives at `skills/brainstorm/references/design-template.md` — follows existing convention (see `skills/juice-server/references/`)
- **DEC-5:** Local `.claude/skills/brainstorm/` does not exist, so Group C (cleanup) is a no-op — verified during exploration

---

## Success Criteria

- [ ] Design template exists at `skills/brainstorm/references/design-template.md`
- [ ] Template includes sections: Problem, Solution, Scope IN/OUT, Key Decisions, Risks, Success Definition
- [ ] Brainstorm SKILL.md has 6 phases (5 existing + 1 new handoff phase)
- [ ] Phase 6 instructs writing to `.genie/brainstorms/<slug>/design.md`
- [ ] Phase 6 references the design template
- [ ] All existing phases (1-5) and "Never Do" section remain intact
- [ ] No duplicate brainstorm skill directories exist

---

## Assumptions

- **ASM-1:** The plugin skill at `skills/brainstorm/SKILL.md` is the canonical version
- **ASM-2:** The design.md format is sufficient for `/wish` to begin planning without additional context

## Risks

- **RISK-1:** Adding a mandatory handoff phase could make brainstorm feel too rigid for quick explorations — Mitigation: Phase 6 guidance says "skip for trivial ideas that don't need /wish"

---

## Execution Groups

### Group A: Create Design Template Reference

**Goal:** Provide a reusable template for the handoff document.

**Deliverables:**
- `skills/brainstorm/references/design-template.md` with all required sections

**Acceptance Criteria:**
- [ ] File exists at `skills/brainstorm/references/design-template.md`
- [ ] Template includes: Problem, Solution, Scope (IN/OUT), Key Decisions, Risks, Success Definition
- [ ] Template uses placeholder text that's easy to replace
- [ ] Template is concise (under 60 lines)

**Validation:** `test -f skills/brainstorm/references/design-template.md && wc -l skills/brainstorm/references/design-template.md`

---

### Group B: Upgrade Brainstorm SKILL.md

**Goal:** Add handoff phase to brainstorm skill while preserving all existing content.

**Deliverables:**
- Updated `skills/brainstorm/SKILL.md` with Phase 6: Write Handoff Document

**Acceptance Criteria:**
- [ ] SKILL.md contains phases numbered 1 through 6
- [ ] Phase 6 writes to `.genie/brainstorms/<slug>/design.md`
- [ ] Phase 6 references `references/design-template.md`
- [ ] Existing phases 1-5 are unchanged
- [ ] "Never Do" section is preserved
- [ ] "After Design Validation" section is updated to mention design.md output

**Validation:** `grep -c "Phase\|design-template\|\.genie/brainstorms" skills/brainstorm/SKILL.md`

---

## Review Results

**Verdict: SHIP**
**Reviewed:** 2026-02-09

### Group A: Design Template — PASS
- [x] File exists at `skills/brainstorm/references/design-template.md`
- [x] All 6 sections present (Problem, Solution, Scope, Key Decisions, Risks, Success Definition)
- [x] Placeholder text is clear and replaceable
- [x] Concise at 60 lines

### Group B: SKILL.md Upgrade — PASS
- [x] Phases 1-6 all present and correctly numbered
- [x] Phase 6 writes to `.genie/brainstorms/<slug>/design.md`
- [x] Phase 6 references `references/design-template.md`
- [x] Phases 1-5 unchanged from original
- [x] "Never Do" section preserved at line 118
- [x] "After Design Validation" replaced by Phase 6 with Options A/B/C

### Group C: Cleanup — N/A
- No local `.claude/skills/brainstorm/` directory existed. No action needed.

### Overall Success Criteria
- [x] Design template exists
- [x] Template has all required sections
- [x] SKILL.md has 6 phases
- [x] Phase 6 references design output path and template
- [x] All existing content preserved
- [x] No duplicate skill directories

---

## Files to Create/Modify

```
skills/brainstorm/references/design-template.md (CREATE)
skills/brainstorm/SKILL.md (MODIFY)
.genie/wishes/upgrade-brainstorm/wish.md (CREATE)
```
