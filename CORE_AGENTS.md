# Core Agents

Core Genie agents available globally (not tied to a specific collective).

## Neurons (Master Orchestrators)

**Neurons** are persistent master orchestrators that live in Forge and coordinate work. Unlike regular agents:
- Persist indefinitely (survive MCP restarts)
- Live in Forge worktrees with read-only filesystems
- Reuse across sessions (ONE neuron per type per project)
- Use Claude Haiku for fast, efficient orchestration
- Invoked via MCP tools (not `genie run`)

### Available Neurons

- **neuron-wish** — Persistent wish master (invoked via `create_wish` MCP tool)
  - Coordinates wish authoring across all domains
  - Delegates to `create/wish` or `code/wish` executors
  - Location: `.genie/neurons/neuron-wish.md`

- **neuron-forge** — Persistent forge master (invoked via `run_forge` MCP tool)
  - Coordinates execution using domain-specific forge workflows
  - Delegates to `code/forge` using spells
  - Location: `.genie/neurons/neuron-forge.md`

- **neuron-review** — Persistent review master (invoked via `run_review` MCP tool)
  - Coordinates validation against evaluation matrices
  - Delegates to `code/review` for actual reviews
  - Location: `.genie/neurons/neuron-review.md`

**See:** `.genie/neurons/README.md` for complete neuron architecture documentation

## Orchestration Agents (Deprecated - Replaced by Neurons)

The following orchestrators are **deprecated** in favor of neurons:
- ~~**Forge** (`.genie/agents/forge.md`)~~ → Use `neuron-forge` instead
- ~~**Wish** (`.genie/agents/wish.md`)~~ → Use `neuron-wish` instead
- ~~**Review** (`.genie/agents/review.md`)~~ → Use `neuron-review` instead

**Migration:** MCP tools now invoke neurons via `neuron-*` executor variants. Legacy orchestrator files remain for backward compatibility but should not be used directly.

## Quality Maintenance Agents

- **Garbage Collector** — Autonomous documentation quality assurance (daily sweep)
  - Detects: Token bloat, metadata duplication, content duplication, contradictions, dead references, invalid frontmatter, TODO markers, merge conflicts
  - Outputs: GitHub issues per finding + daily report
  - Schedule: Local cron 0:00 daily
  - Helpers: `genie helper validate-frontmatter`, `genie helper detect-markers`, `genie helper count-tokens`
  - See: `.genie/agents/garbage-collector.md`

- **Garbage Cleaner** — Individual PR executor for garbage-collection fixes
  - Processes: GitHub issues tagged `garbage-collection` (one issue = one PR)
  - Implements: Automated quality improvements
  - Outputs: Individual PR per issue + auto-close on merge
  - Review: Auto-assigned to victor
  - Trigger: Manual after reviewing issues
  - See: `.genie/agents/garbage-cleaner.md`

## Guiding Principle

Keep core agents thin and delegate into collective workflows for domain specifics.

