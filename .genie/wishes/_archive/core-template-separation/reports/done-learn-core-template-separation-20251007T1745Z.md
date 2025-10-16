# 🧞📚 Done Report: learn-core-template-separation-20251007T1745Z

**Date:** 2025-10-07T17:45Z  
**Type:** workflow consolidation  
**Severity:** High  
**Teacher:** Felipe → via wish feedback

---

## Scope
- Unified the behavioural learning flow under the single `learn` agent.
- Retired the legacy `self-learn` prompt and associated command wrappers.
- Updated documentation and customization stubs to reflect the new done-report convention.

## Tasks
- [x] Analyze wish requirements and prior self-learn guidance
- [x] Update `@.genie/agents/core/learn.md` with violation/pattern workflows + reporting rules
- [x] Refresh documentation (`AGENTS.md`, `.claude/README.md`, product/guides) to remove `self-learn`
- [x] Add repository override stub `@.genie/custom/learn.md`
- [x] Record QA evidence in `qa/group-b/meta-learn-merge.md`
- [ ] Monitor first `/learn` execution post-merge

## Changes
- `@.genie/agents/core/learn.md` — merged operating framework, context gathering, done-report template, and project customization guidance.
- `@AGENTS.md` — behavioural corrections section reworded for `/learn`; routing aliases cleaned up.
- `.claude/README.md` — infrastructure/agent matrix updated; legacy command mappings removed.
- `.genie/custom/learn.md` — new stub for repo-specific defaults.
- `.genie/product/{environment,tech-stack,roadmap}.md`, `.genie/guides/getting-started.md`, `.genie/README.md`, `.genie/agents/README.md` — terminology sweep.
- `.genie/wishes/core-template-separation/qa/group-b/meta-learn-merge.md` — evidence capture.

## Validation Evidence
```bash
rg "self-learn"
```
_Output:_ (no matches) — confirms the old prompt/aliases no longer referenced.

## Follow-up
- [ ] Capture practical `/learn` session output (violation + pattern) and attach logs.
- [ ] Verify downstream template exports mirror the new naming when Phase 2 kicks off.

## Notes
- Done-report naming now standardized on `done-learn-<slug>-<timestamp>.md`.
- Next `/learn` execution should reference this report and append monitoring results.
