# 🧞 Evidence — Group B Meta-Learn Unification

**Date:** 2025-10-07  
**Status:** ✅ Completed

## Summary
- Unified the behavioural learning flow under `@.genie/agents/core/learn.md`, reintroducing violation/pattern workflows, operating framework, and done-report guidance.
- Created `@.genie/custom/learn.md` to host repo-specific overrides and referenced it from the core prompt + documentation.
- Scrubbed legacy `self-learn` references across AGENTS, CLAUDE README, product docs, and guides; updated done-report naming to `done-learn-<slug>-<timestamp>.md`.

## Key File Updates
- `.genie/agents/core/learn.md` — merged legacy self-learn operating guidance, added done report structure, context gathering protocol, and updated report paths.
- `AGENTS.md` — rewrote behavioural corrections section to point at `/learn`, removed legacy alias guidance, refreshed routing aliases.
- `.claude/README.md` — updated infrastructure matrix and command mapping to surface the single learn agent.
- `.genie/custom/learn.md` — new customization stub for repository-level defaults.
- `.genie/product/{environment,tech-stack,roadmap}.md`, `.genie/README.md`, `.genie/guides/getting-started.md`, `.genie/agents/README.md` — documentation sweep to reflect the unified terminology.

## Command Evidence
```bash
rg "self-learn"
```
_Output:_ (no matches) — confirms legacy references removed from the workspace.

## Follow-up / Monitoring
- First `/learn` usage after merge should confirm the new `done-learn-*` report naming and capture diff snippets for review.
- Capture a real violation + pattern input to validate both templates in practice (record outputs in this folder).
