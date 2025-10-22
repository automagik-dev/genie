---
name: Orchestration Protocols
description: Enforce TDD: RED → GREEN → REFACTOR with explicit approval gates
---

# Orchestration Protocols

**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Execution patterns governing sequencing and validation:**

**Success criteria:**
✅ TDD: RED → GREEN → REFACTOR enforced for features.
✅ Approval gates explicit in wishes/forge plans.

**Strategic orchestration rules:**
- Orchestrate; don't implement. Delegate to the appropriate agents and collect evidence.
- Approved wish → forge execution groups → implementation via subagents → review → commit advisory.
- Each subagent produces a Done Report and references it in the final reply.

**Done Report:**
- Location: `.genie/wishes/<slug>/reports/done-<agent>-<slug>-<YYYYMMDDHHmm>.md` (UTC).
- Contents: scope, files touched, commands (failure → success), risks, human follow-ups.
