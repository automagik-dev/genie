---
name: council
description: "Assess a proposal through independent technical, product, risk, and dissenting lenses, then synthesize a decision without mutating unless explicitly requested."
---

# Council

Use a council when a consequential decision benefits from independent scrutiny. The council assesses; it does not edit files, change configuration, or execute the plan unless the user explicitly asks for that.

The council is a saved workflow, not a procedure this skill performs inline. The single source of truth is `.claude/workflows/council.js` in the genie repository's canonical workflow catalog (see `.claude/workflows/README.md` there); this skill is its front door. On Claude Code, run the native Workflow tool with the saved name `council` (by explicit path if a same-named user-scope copy makes the name ambiguous), passing the decision as a string or `{decision, constraints?, evidence?, unknowns?}`, and relay the returned `report` unchanged; lenses that returned nothing are listed under `notConvened` and were never averaged in. On a runtime without a workflow surface, dispatch the lenses below by hand with the same brief; the roster and both response shapes are the workflow's and must not diverge from it.

## Dispatch

Choose the lenses the decision needs from the set below, sized to its stakes: Dissent is always included, and at least one other lens supplies independent evidence. Send each chosen lens to its own subagent through the runtime's native delegation surface, in parallel where supported. Every lens receives the same decision statement, constraints, evidence, and explicit unknowns, and none sees another lens's conclusion before answering.

- **Architecture** — contracts, coupling, failure modes, operability, long-term cost.
- **Delivery** — sequencing, testability, migration, rollback, evidence required to ship.
- **Product** — user value, usability, scope discipline, compatibility.
- **Security** — trust boundaries, permissions, data exposure, abuse cases.
- **Dissent** — the strongest evidence-backed case against the emerging consensus.

## Lens response

```text
Verdict: support | support-with-conditions | oppose | insufficient-evidence
Confidence: low | medium | high
Key evidence:
- ...
Risks or objections:
- ...
Required conditions:
- ...
Unknowns:
- ...
```

A dissenting finding is preserved, not deleted because the majority disagrees.

## Synthesis

```text
Decision: proceed | proceed-with-conditions | revise | stop | gather-evidence
Consensus: <where the lenses agree>
Dissent: <minority positions, attributed by lens>
Conditions: <concrete prerequisites>
Evidence gaps: <unknowns that could change the decision>
Next action: <one bounded next step>
```

Explain how conflicts were resolved. If evidence is insufficient, say so rather than manufacturing consensus. End after the assessment unless mutation was explicitly authorized.
