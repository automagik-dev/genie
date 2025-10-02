# Genie Dev Roadmap

The genie-dev branch is the laboratory for Genie’s self-improvement program. Phases are sequenced to keep downstream adopters safe while we iterate quickly.

## Phase 0 — Baseline Capture (✅ complete)
- Neutralize template placeholders and document the current mission, tech stack, and guardrails
- Inventory existing behavioural learnings and confirm they are enforced across agents
- Establish `pnpm run build:genie` + smoke tests as the minimum verification gate

## Phase 1 — Instrumentation & Telemetry (in progress)
- Treat the wish **Evidence Checklist** as the gating deliverable before other instrumentation tasks proceed (see @.genie/agents/wish.md).
- Add branch-specific checklists to every wish to log evidence paths and validation commands
- Expand done-report coverage so each experiment stores scope, risks, and follow-ups
- Wire CLI diagnostics to surface missing sessions or misconfigured presets

## Phase 2 — Guided Self-Improvement
- Author wishes that target prompt quality, guardrail clarity, and CLI usability
- Pair each wish with twin audits and validation scripts before merging back to `main`
- Promote validated learnings into `.genie/instructions/` and specialist briefs

## Phase 3 — Adoption Kits for Downstream Repos
- Package upgrade notes, migration diffs, and rollback guidance for every major change
- Publish branch-to-main release checklist (Plan → Wish → Forge coverage, tests, done report link)
- Partner with pilot teams to trial upgrades and capture their feedback in structured templates

## Phase 4 — Automation & CI Integration
- Land GitHub Actions pipeline that runs build + smoke tests and attaches artefacts to PRs
- Add regression checks for behavioural rules (self-learn, guardrail compliance)
- Introduce metrics capture (latency, wish completion velocity) with reporting hooks

## Success Metrics
- 100% of genie-dev wishes include validation commands and evidence links
- Smoke suite (`pnpm run test:genie`) passing before merge on every PR
- Documented learnings promoted within 48 hours of validation
- Downstream adopters report <5% rollback rate on genie-dev releases

## Dependencies & Enablers
- Maintainers available for twin reviews and manual approvals
- Access to GPT-5 class models (configurable via `GENIE_MODEL`)
- Stable sandboxed environment mirroring production guardrails

## Risk Log (actively monitored)
- **Automation drift:** self-improvement scripts may bypass approval gates → mitigate with review checklist baked into wishes
- **Telemetry gaps:** missing evidence makes regression root-cause harder → mitigate by enforcing done report template updates
- **Adopter fatigue:** too many upgrades without guides → mitigate by bundling changes into release kits with opt-in toggles
