# Genie Agent Framework

## Core Purpose
- Provide universal agent templates and CLI orchestration
- Replace product-specific branding with placeholders
- Domain-agnostic template repo

## Primary References
See `.genie/` directory for comprehensive documentation:
- `@.genie/product/mission.md`
- `@.genie/product/tech-stack.md`
- `@.genie/product/roadmap.md`
- `@.genie/product/environment.md`

## Core Skills Architecture

### Priority Tiers (Auto-loaded)
**Tier 1 (Identity):**
- `@.genie/agents/code/skills/know-yourself.md`

**Tier 2 (Decision Framework):**
- `@.genie/agents/code/skills/evidence-based-thinking.md`
- `@.genie/agents/code/skills/routing-decision-matrix.md`

**Tier 3 (System Coordination):**
- `@.genie/agents/code/skills/execution-integrity-protocol.md`
- `@.genie/agents/code/skills/persistent-tracking-protocol.md`
- `@.genie/agents/code/skills/meta-learn-protocol.md`
- `@.genie/agents/code/skills/wish-initiation-rule.md`

**Tier 4 (Discovery & Tools):**
- `@.genie/agents/code/skills/delegation-discipline.md`
- `@.genie/agents/code/skills/blocker-protocol.md`
- `@.genie/agents/code/skills/chat-mode-helpers.md`
- `@.genie/agents/code/skills/experimentation-protocol.md`
- `@.genie/agents/code/skills/orchestration-protocols.md`
- `@.genie/agents/code/skills/parallel-execution.md`

**Tier 5 (Guardrails):**
- `@.genie/agents/code/skills/sequential-questioning.md`
- `@.genie/agents/code/skills/no-backwards-compatibility.md`

### Reference-Only Skills
**Protocols & Tools:**
- `@.genie/agents/code/skills/publishing-protocol.md`
- `@.genie/agents/code/skills/role-clarity-protocol.md`
- `@.genie/agents/code/skills/triad-maintenance-protocol.md`
- `@.genie/agents/code/skills/genie-integration.md`
- `@.genie/agents/code/skills/agent-configuration.md`
- `@.genie/agents/code/skills/tool-requirements.md`

**Conventions:**
- `@.genie/agents/code/skills/branch-tracker-guidance.md`
- `@.genie/agents/code/skills/evidence-storage.md`
- `@.genie/agents/code/skills/prompting-standards.md`
- `@.genie/agents/code/skills/workspace-system.md`
- `@.genie/agents/code/skills/file-naming-rules.md`
- `@.genie/agents/code/skills/execution-patterns.md`
- `@.genie/agents/code/skills/wish-document-management.md`
- `@.genie/agents/code/skills/forge-integration.md`
- `@.genie/agents/code/skills/forge-mcp-pattern.md`
- `@.genie/agents/code/skills/missing-context-protocol.md`

## Universal Workflow Architecture
**Workflow Pattern:** `Wish → Forge → Review`

**Wish workflow structure:**
- Main: `.genie/agents/neurons/wish.md` (discovery & planning orchestrator)
- Delegates to: `.genie/agents/code/neurons/wish/blueprint.md` (wish document creation)

### Core Workflow Variants
- **Code:** Implementation, tests, documentation
- **Create:** Research, content, strategic planning
- **NL:** Process improvements, decision frameworks

### Workflow Components
- `@.genie/agents/neurons/wish.md` (main orchestrator, delegates to blueprint)
- `@.genie/agents/code/neurons/wish/blueprint.md` (wish document creation)
- `@.genie/agents/neurons/forge.md`
- `@.genie/agents/neurons/review.md`

## @ Tool Semantics
**Critical:** @ is a lightweight path reference, NOT a content loader.

**Use Cases:**
- Point to supplementary documentation
- Create knowledge graph connections
- Save tokens by referencing, not duplicating

## Neuron Delegation Hierarchy
**Tiers:**
1. **Base Genie:** Human interface, persistent coordinator
2. **Neurons:** Specialized execution with persistent memory
3. **Workflows:** Neuron-scoped, atomic execution

**Enforcement:** Folder structure = Delegation hierarchy

## MCP Quick Reference
See `@.genie/docs/mcp-interface.md` for complete documentation.

## Neural Graph Architecture (Auto-Generated)
<!-- AUTO-GENERATED-START: Do not edit manually -->
**Last Updated:** 2025-10-18 18:23:24 UTC
**Total Tokens:** 35,977 (baseline for efficiency validation)

**Distribution:**
- Skills: 19,381 tokens (53.9%)
- Universal Neurons: 10,633 tokens (29.6%)
- Other: 3,276 tokens (9.1%)
- Core Framework: 2,042 tokens (5.7%)
- Code Neurons: 645 tokens (1.8%)

**Hierarchy:**

- **AGENTS.md** (2,042 tokens, +33,935 from 40 refs)
  - **.genie/product/mission.md** (684 tokens)
  - **.genie/product/tech-stack.md** (546 tokens)
  - **.genie/product/roadmap.md** (594 tokens)
  - **.genie/product/environment.md** (694 tokens)
  - **.genie/agents/code/skills/know-yourself.md** (1,359 tokens)
  - **.genie/agents/code/skills/evidence-based-thinking.md** (750 tokens)
  - **.genie/agents/code/skills/routing-decision-matrix.md** (1,146 tokens)
  - **.genie/agents/code/skills/execution-integrity-protocol.md** (643 tokens)
  - **.genie/agents/code/skills/persistent-tracking-protocol.md** (1,078 tokens)
  - **.genie/agents/code/skills/meta-learn-protocol.md** (648 tokens)
  - **.genie/agents/code/skills/wish-initiation-rule.md** (1,210 tokens)
  - **.genie/agents/code/skills/delegation-discipline.md** (1,246 tokens)
  - **.genie/agents/code/skills/blocker-protocol.md** (97 tokens)
  - **.genie/agents/code/skills/chat-mode-helpers.md** (248 tokens)
  - **.genie/agents/code/skills/experimentation-protocol.md** (499 tokens)
  - **.genie/agents/code/skills/orchestration-protocols.md** (219 tokens)
  - **.genie/agents/code/skills/parallel-execution.md** (93 tokens)
  - **.genie/agents/code/skills/sequential-questioning.md** (1,275 tokens)
  - **.genie/agents/code/skills/no-backwards-compatibility.md** (295 tokens)
  - **.genie/agents/code/skills/publishing-protocol.md** (565 tokens)
  - **.genie/agents/code/skills/role-clarity-protocol.md** (732 tokens)
  - **.genie/agents/code/skills/triad-maintenance-protocol.md** (1,315 tokens)
  - **.genie/agents/code/skills/genie-integration.md** (1,215 tokens)
  - **.genie/agents/code/skills/agent-configuration.md** (537 tokens)
  - **.genie/agents/code/skills/tool-requirements.md** (116 tokens)
  - **.genie/agents/code/skills/branch-tracker-guidance.md** (164 tokens)
  - **.genie/agents/code/skills/evidence-storage.md** (286 tokens)
  - **.genie/agents/code/skills/prompting-standards.md** (172 tokens)
  - **.genie/agents/code/skills/workspace-system.md** (104 tokens)
  - **.genie/agents/code/skills/file-naming-rules.md** (293 tokens)
  - **.genie/agents/code/skills/execution-patterns.md** (110 tokens)
  - **.genie/agents/code/skills/wish-document-management.md** (791 tokens)
  - **.genie/agents/code/skills/forge-integration.md** (1,630 tokens)
  - **.genie/agents/code/skills/forge-mcp-pattern.md** (417 tokens)
  - **.genie/agents/code/skills/missing-context-protocol.md** (128 tokens)
  - **.genie/agents/neurons/wish.md** (1,373 tokens)
  - **.genie/agents/code/neurons/wish/blueprint.md** (645 tokens)
  - **.genie/agents/neurons/forge.md** (5,973 tokens)
  - **.genie/agents/neurons/review.md** (3,287 tokens)
  - **.genie/docs/mcp-interface.md** (758 tokens)

<!-- AUTO-GENERATED-END -->
