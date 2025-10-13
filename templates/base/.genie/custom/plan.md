# Planning • Project Defaults

## Core References
- Product mission: `.genie/product/mission.md`
- Roadmap: `.genie/product/roadmap.md`
- Tech stack overview: `.genie/product/tech-stack.md`
- Standards: `.genie/standards/best-practices.md`
- Recent instructions & decisions: `.genie/instructions/`, `.genie/product/mission-lite.md`
- Current wishes for cross-linking: `.genie/wishes/`

Provide a quick summary of each when `/plan` loads so humans know why they matter; only load additional files when the user supplies extra `@` references.

## Discovery Prompts
- Confirm whether the idea extends existing wishes or requires a new branch.
- Ask for blockers, compliance constraints, or deployment concerns.
- Capture assumptions (ASM-*), decisions (DEC-*), and risks in the planning brief.

## Evidence & Reporting
- Record the planning brief at `.genie/wishes/<slug>/<slug>-wish.md` once the idea is wish-ready.
- Save supplemental research logs in the wish `qa/` folder if they are reused later.
- Log branch strategy and tracker notes directly into the wish status log when created.
