# Wish: Upgrade Brainstorm Skill with Handoff Output

**Status:** DRAFT
**Slug:** `upgrade-brainstorm-handoff`
**Created:** 2026-02-02

---

## Summary

Merge the best parts from local and plugin brainstorm skill versions, and add a structured handoff output to `.genie/brainstorms/<slug>/design.md` that provides the perfect input for `/wish` to begin execution planning.

---

## Scope

### IN
- Merge local `.claude/skills/brainstorm/` improvements into plugin
- Add design.md output template as a reference file
- Update SKILL.md to include handoff phase
- Delete local duplicate after merge
- Test the upgraded skill works

### OUT
- Changes to other skills (wish, forge, review)
- New features beyond the handoff document
- Changes to the wish template (wish reads brainstorm output, not the other way)

---

## Decisions

- **DEC-1:** Output location is `.genie/brainstorms/<slug>/design.md` — keeps brainstorm artifacts separate from wishes
- **DEC-2:** Handoff document uses markdown table format for decisions/risks — scannable and structured
- **DEC-3:** Status field in design.md is `VALIDATED` — signals ready for /wish consumption

---

## Success Criteria

- [ ] Plugin brainstorm skill includes all best practices from both versions
- [ ] Running `/brainstorm` produces `.genie/brainstorms/<slug>/design.md` on completion
- [ ] Design.md format includes: Problem, Solution, Scope IN/OUT, Decisions, Risks, Success definition
- [ ] Local `.claude/skills/brainstorm/` is deleted
- [ ] No duplicate brainstorm skills exist

---

## Assumptions

- **ASM-1:** The plugin can be updated and reinstalled locally for testing
- **ASM-2:** The design.md template is sufficient for /wish to begin planning

## Risks

- **RISK-1:** Breaking existing brainstorm behavior — Mitigation: Test with a real brainstorm session before deleting local

---

## Execution Groups

### Group A: Create Design Template Reference

**Goal:** Add the design.md template as a reference file in the plugin.

**Deliverables:**
- `plugin/references/design-template.md` with the agreed format

**Acceptance Criteria:**
- [ ] Template file exists at `plugin/references/design-template.md`
- [ ] Template includes all agreed sections (Problem, Solution, Scope, Design, Constraints, Success)

**Validation:** `cat plugin/references/design-template.md | head -30`

---

### Group B: Upgrade Brainstorm SKILL.md

**Goal:** Merge best practices and add handoff phase to the brainstorm skill.

**Deliverables:**
- Updated `plugin/skills/brainstorm/SKILL.md` with:
  - Merged content from both versions
  - New Phase 6: Write Handoff Document
  - Reference to design-template.md

**Acceptance Criteria:**
- [ ] SKILL.md includes all 6 phases
- [ ] Phase 6 writes to `.genie/brainstorms/<slug>/design.md`
- [ ] References the design-template.md for format
- [ ] Includes "Never Do" guardrails

**Validation:** `grep -c "Phase\|design-template\|\.genie/brainstorms" plugin/skills/brainstorm/SKILL.md`

---

### Group C: Delete Local Duplicate

**Goal:** Remove the local `.claude/skills/brainstorm/` now that plugin is upgraded.

**Deliverables:**
- Delete `.claude/skills/brainstorm/` directory

**Acceptance Criteria:**
- [ ] `.claude/skills/brainstorm/` no longer exists
- [ ] No errors when running `/brainstorm` (uses plugin version)

**Validation:** `ls .claude/skills/brainstorm 2>&1 | grep -c "No such file"`

---

## Review Results

_Populated by `/review` after forge execution completes._

---

## Files to Create/Modify

```
plugin/references/design-template.md (CREATE)
plugin/skills/brainstorm/SKILL.md (MODIFY)
.claude/skills/brainstorm/ (DELETE)
```
