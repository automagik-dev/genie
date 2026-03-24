Hey @namastex888 👋

I ran your skills through `tessl skill review` at work and found some targeted improvements. Here's the full before/after:

| Skill | Before | After | Change |
|-------|--------|-------|--------|
| refine | 44% | 96% | +52% |
| brain | 55% | 100% | +45% |
| wish | 55% | 93% | +38% |
| dream | 55% | 93% | +38% |
| docs | 53% | 89% | +36% |
| fix | 59% | 93% | +34% |
| genie | 55% | 89% | +34% |
| review | 68% | 100% | +32% |
| work | 51% | 80% | +29% |
| council | 72% | 100% | +28% |
| learn | 68% | 96% | +28% |
| trace | 71% | 96% | +25% |
| report | 73% | 93% | +20% |
| brainstorm | 79% | 91% | +12% |

![Score Card](score_card.png)

<details>
<summary>What changed</summary>

### Description improvements (all 14 skills)
- Added explicit "Use when..." clauses with natural trigger terms so agents can reliably match user requests to the right skill
- Replaced internal jargon (e.g. "FIX-FIRST gaps", "SHIP-ready wishes", "agent behavioral surfaces") with plain language in descriptions while preserving terminology in the body
- Ensured all descriptions use quoted string format

### Content improvements (10 skills)
- **refine**: Extracted the ~710-line Prompt Optimizer Reference into `references/OPTIMIZER_REFERENCE.md` — dropped the SKILL.md from 791 to 86 lines while keeping the subagent's full knowledge base accessible via `@references/OPTIMIZER_REFERENCE.md`
- **brain**: Moved CLAUDE.md and AGENTS.md template blocks to separate files (`claude-md-template.md`, `agents-md-template.md`), removing duplicated protocol steps
- **dream**: Extracted DREAM.md and DREAM-REPORT.md templates to standalone reference files
- **wish**: Extracted the wish template to `WISH-TEMPLATE.md`, removed the redundant "Wish Document Sections" table
- **report**: Consolidated duplicated degradation rules into the single summary table, extracted GitHub issue template to `github-issue-template.md`
- **council**: Moved Council Members and Smart Routing tables to `COUNCIL_MEMBERS.md`, trimmed explanatory phrases
- **docs**: Added concrete validation example, error handling guidance, and expected output format
- **learn**: Added a worked example showing a complete correction-to-memory-file flow
- **trace**: Added spawn example with context passing and investigation command examples
- **work**: Added a full dispatch cycle example showing end-to-end task execution

</details>

Honest disclosure — I work at @tesslio where we build tooling around skills like these. Not a pitch - just saw room for improvement and wanted to contribute.

Want to self-improve your skills? Just point your agent (Claude Code, Codex, etc.) at [this Tessl guide](https://docs.tessl.io/evaluate/optimize-a-skill-using-best-practices) and ask it to optimize your skill. Ping me - [@rohan-tessl](https://github.com/rohan-tessl) - if you hit any snags.

Thanks in advance 🙏
