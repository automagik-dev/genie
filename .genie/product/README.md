# Product Docs Index


Use these as the single source of truth for product context. Reference with `@.genie/product/...` so agents auto-load content.

- `@.genie/product/mission.md` – Pitch, users, problem, key features
- `@.genie/product/mission-lite.md` – Short elevator pitch for prompts
- `@.genie/product/tech-stack.md` – Technologies, architecture, dependencies
- `@.genie/product/environment.md` – Required/optional env vars and setup
- `@.genie/product/roadmap.md` – Phases, initiatives, and milestones
- `@.genie/product/planning-notes/` – Internal notes for product decisions

Framework behavior
- The framework consumes these files via `@` references and injects their content into agent prompts.
- Keep sections stable so downstream tools can parse consistently (e.g., headings like "Pitch", "Users", "The Problem").
- Prefer updating these docs over scattering product data elsewhere.

Validation
- The install and wish workflows verify these paths exist and surface missing sections as blockers.
- If you rename/move files, update all `@.genie/product/...` references to avoid broken context.

