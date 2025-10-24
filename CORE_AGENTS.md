# Core Agents

Core Genie agents available globally (not tied to a specific collective).

## Orchestration Agents

- **Forge** — Orchestrates execution using domain Forge workflows (thin agent)
- **Wish** — Global wish orchestrator (delegates to domain-specific wish flows)
- **Review** — Global review orchestrator (delegates to domain-specific review flows)

## Quality Maintenance Agents

- **Garbage Collector** — Autonomous documentation quality assurance (daily sweep)
  - Detects: Token bloat, metadata duplication, content duplication, contradictions, dead references
  - Outputs: GitHub issues per finding + daily report
  - Schedule: Local cron 0:00 daily
  - See: `.genie/agents/garbage-collector.md`

- **Garbage Cleaner** — Batch executor for garbage-collection fixes
  - Processes: GitHub issues tagged `garbage-collection`
  - Implements: Automated quality improvements
  - Outputs: PR with all fixes + issue auto-close
  - Trigger: Manual after reviewing issues
  - See: `.genie/agents/garbage-cleaner.md`

## Guiding Principle

Keep core agents thin and delegate into collective workflows for domain specifics.

