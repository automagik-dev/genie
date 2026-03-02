# Wish: Workflow Rebrand — The Universal Method

**Status:** COMPLETE
**Slug:** workflow-rebrand
**Created:** 2026-02-12
**Agent:** Eva 👰

---

## Summary

Consolidate the genie-cli plugin's 15 overlapping skills into **4 core commands** that every agent uses identically:

```
/brainstorm → /wish → /work → /review
```

Kill the confusion between `make` vs `forge` vs `work`. Make skills small enough to inject fresh. One execution command, one review command.

---

## Scope

### IN
- **Kill skills:** `make/`, `work-activation/`, `work-orchestration/`, `plan-review/`
- **Create skill:** `work/` — new, ≤50 lines, combines execution + context loading
- **Rewrite skill:** `review/` — universal (plan + execution + PR + anything), ≤50 lines
- **Update skill:** `wish/` — add brainstorm gate ("want to brainstorm first?")
- **Update skill:** `brainstorm/` — trim to ≤50 lines, stays standalone
- **Update skill:** `sleepyhead/` — reference new command names
- **Update both plugin manifests:** `openclaw.plugin.json` + `.claude-plugin/plugin.json`
- **Update README.md** with new 4-command pipeline

### OUT
- Skill folder audit/cleanup (dead skills like `genie-blank-init`) — separate backlog item
- Changes to OpenClaw core or genie-cli CLI code
- Changes to non-workflow skills (council, term-pilot, genie-base, genie-pdf, juice-server, genie-cli-dev)
- Eva's own skill files (separate from the shared plugin)
- Machine-machine comms optimization (separate effort)

---

## Decisions

| Decision | Rationale |
|----------|-----------|
| `/work` replaces make/forge/work-activation/work-orchestration | Three overlapping concepts confused everyone. One command, one behavior. |
| `/review` becomes universal | Plan review, execution review, PR review — all "look carefully and give verdict." |
| `/brainstorm` stays standalone | Valuable as independent exploration. Keeps brainstorm pressure-free. |
| Skills must be ≤50 lines | Agents prioritize fresh context. 30-line prompt > 200-line manifest. |
| Both plugin formats in sync | `openclaw plugin add` must work identically to Claude Code discovery. |

---

## Success Criteria

- [ ] `grep -r "forge\|/make\b\|plan-review\|work-activation\|work-orchestration" skills/` returns ZERO hits
- [ ] Only 4 workflow skills exist: `brainstorm/`, `wish/`, `work/`, `review/`
- [ ] Dead skill directories removed: `make/`, `work-activation/`, `work-orchestration/`, `plan-review/`
- [ ] `sleepyhead/SKILL.md` references new pipeline (`/work` instead of `/make`)
- [ ] Both plugin manifests valid and point to skills directory
- [ ] README.md documents the 4-command pipeline
- [ ] Each workflow skill ≤50 lines

---

## Execution Groups

### Group A: Write New Skills

**Task A1: Create `work/SKILL.md`**
- Write new skill file, ≤50 lines
- Combine: execution dispatch, context loading, subagent spawning, validation-as-you-go
- Kill references to make/forge/work-activation/work-orchestration
- **Validation:** `wc -l skills/work/SKILL.md` ≤ 50
- **Files:** `skills/work/SKILL.md` (new)

**Task A2: Rewrite `review/SKILL.md`**
- Make universal: plan review, execution review, PR review, comment review
- Trim to ≤50 lines
- **Validation:** `wc -l skills/review/SKILL.md` ≤ 50
- **Files:** `skills/review/SKILL.md` (edit)

**Task A3: Update `wish/SKILL.md`**
- Add brainstorm gate: "Want to brainstorm first, or you have everything?"
- Trim to ≤50 lines if over
- **Validation:** `grep -q "brainstorm" skills/wish/SKILL.md`
- **Files:** `skills/wish/SKILL.md` (edit)

**Task A4: Trim `brainstorm/SKILL.md`**
- Reduce from 119 lines to ≤50
- Keep core: one question at a time, explore approaches, align on scope
- **Validation:** `wc -l skills/brainstorm/SKILL.md` ≤ 50
- **Files:** `skills/brainstorm/SKILL.md` (edit)

---

### Group B: Kill Dead Skills

**Task B1: Delete obsolete skill directories**
- Remove: `skills/make/`, `skills/work-activation/`, `skills/work-orchestration/`, `skills/plan-review/`
- **Validation:** `ls skills/make skills/work-activation skills/work-orchestration skills/plan-review 2>&1 | grep -c "No such file"` = 4
- **Files:** 4 directories deleted

---

### Group C: Update References

**Task C1: Update `sleepyhead/SKILL.md`**
- Replace `/make` references with `/work`
- Replace any `plan-review` references with `/review`
- **Validation:** `grep -E "/make|plan-review" skills/sleepyhead/SKILL.md` returns nothing
- **Files:** `skills/sleepyhead/SKILL.md` (edit)

**Task C2: Update plugin manifests**
- Ensure both manifests list only the 4 workflow skills
- Validate JSON syntax
- **Validation:** `jq . openclaw.plugin.json && jq . .claude-plugin/plugin.json`
- **Files:** `openclaw.plugin.json`, `.claude-plugin/plugin.json` (edit)

**Task C3: Update README.md**
- Document the new 4-command pipeline
- Remove references to `/make`, `/forge`, `/plan-review`
- **Validation:** `grep -E "/make|/forge|/plan-review" README.md` returns nothing
- **Files:** `README.md` (edit)

---

### Group D: Final Validation

**Task D1: Run full validation suite**
- All success criteria from above
- No broken references in any skill file
- Plugin can be loaded by OpenClaw
- **Validation:** All success criteria checkboxes pass
- **Files:** None (validation only)

---

## Risks

| Risk | Mitigation |
|------|------------|
| Agents don't read new skills | Keep under 50 lines, fresh and injectable |
| Existing wishes reference `/make` | Search `.genie/wishes/` and update references |
| Sleepyhead pipeline breaks | Task C1 explicitly handles this |
| Plugin manifests drift | Single skills/ symlink serves both manifests |

---

## Notes

- This is a prompt-only change. No CLI code changes.
- Eva can execute this herself (her domain).
- Machine-machine comms optimization is a separate effort.
