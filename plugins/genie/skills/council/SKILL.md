---
name: council
description: "Assess a proposal through independent technical, product, risk, and dissenting lenses, then synthesize a decision without mutating unless explicitly requested."
---

# Council

**Runtime syntax:** in Codex, invoke the plugin copy with the owner-qualified `$genie:<skill>` selector; use bare `$<skill>` only when intentionally selecting a user-tier copy (a separately installed personal copy; Genie no longer seeds this tier). Claude Code and Hermes use `/<skill>`. Cross-skill prose below uses bare names as portable semantic routes; the orchestrator resolves the selector for the active tier.

Use a council when a consequential decision benefits from independent scrutiny. The council assesses by default; it does not edit files, change configuration, or execute a proposed plan unless the user explicitly asks it to mutate.

## Dispatch

Read `references/native-surfaces.md` relative to the directory containing this loaded `SKILL.md` and use the active runtime's native delegation surface. Dispatch these lenses independently and in parallel when supported:

1. **Architecture** — contracts, coupling, failure modes, operability, and long-term cost.
2. **Delivery** — sequencing, testability, migration, rollback, and evidence required to ship.
3. **Product** — user value, usability, scope discipline, and compatibility.
4. **Security** — trust boundaries, permissions, data exposure, and abuse cases.
5. **Dissent** — the strongest evidence-backed case against the emerging consensus.

Give every lens the same decision statement, constraints, evidence, and explicit unknowns. Do not show one lens another lens's conclusion before it answers.

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

Preserve minority opinions. A dissenting finding is not deleted merely because most lenses agree.

## Synthesis

```text
Decision: proceed | proceed-with-conditions | revise | stop | gather-evidence
Consensus: <where the lenses agree>
Dissent: <minority positions, attributed by lens>
Conditions: <concrete prerequisites>
Evidence gaps: <unknowns that could change the decision>
Next action: <one bounded next step>
```

Explain how conflicts were resolved. If evidence is insufficient, say so rather than manufacturing consensus. End after assessment unless mutation was explicitly authorized.
