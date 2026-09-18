---
name: council
description: "Assess a proposal through independent technical, product, risk, and dissenting lenses, then synthesize a decision without mutating unless explicitly requested."
category: routing
mutates: none
---

# Council

Use a council when a consequential decision benefits from independent scrutiny. The council assesses; it does not edit files, change configuration, or execute the plan unless the user explicitly asks for that.

The council is a saved workflow, not a procedure this skill performs inline. The single source of truth is `.claude/workflows/council.js` in the genie repository's canonical workflow catalog (see `.claude/workflows/README.md` there); this skill is its front door. On Claude Code, run the script at `<repository root>/.claude/workflows/council.js` when that file exists, otherwise `~/.claude/workflows/council.js` (delivered by `genie install` / `genie update`); hand the native Workflow tool that explicit script path, never a bare name — both scopes now carry these names and the order a name resolves in is undocumented. Pass the decision as a string or `{decision, constraints?, evidence?, unknowns?}`, and relay the returned `report` unchanged; lenses that returned nothing are listed under `notConvened` and were never averaged in. On a runtime without a workflow surface, dispatch the lenses below by hand with the same brief; the roster and both response shapes are the workflow's and must not diverge from it.

## Dispatch

Choose the lenses the decision needs from the set below, sized to its stakes: Dissent is always included, and at least one other lens supplies independent evidence. Send each chosen lens to its own subagent through the runtime's native delegation surface, in parallel where supported. Every lens receives the same decision statement, constraints, evidence, and explicit unknowns — and nothing else. The session transcript, the emerging consensus, and another lens's answer stay outside the brief, because a lens that reads the room returns an echo instead of evidence. Lenses that run on one model family through one runtime are role-separated, not independent; say so when reporting, alongside the lenses that did not answer.

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

A dissenting finding is preserved verbatim in the dissenting lens's own words and attributed to it. It is never paraphrased into agreement, folded into the consensus line, or deleted because the majority disagrees.

## Synthesis

```text
Decision: proceed | proceed-with-conditions | revise | stop | gather-evidence
Consensus: <where the lenses agree>
Dissent: <minority positions, attributed by lens>
Conditions: <concrete prerequisites>
Evidence gaps: <unknowns that could change the decision>
Next action: <one bounded next step>
```

The synthesizer integrates; it does not assess. It writes its own reading of the decision before the consensus line, so the summary is not an echo of the loudest lens, and it introduces no finding traceable to no lens report. Agreement between lenses is signal: repeated findings are counted, not compressed away as overlap. Explain how conflicts were resolved. If evidence is insufficient, say so rather than manufacturing consensus. End after the assessment unless mutation was explicitly authorized.
