---
name: council
description: "Pressure-test a decision through five independent lenses (architecture, delivery, product, security, dissent) and synthesize a decision without mutating anything — runs the saved `council` workflow."
---

# Council

**Runtime syntax:** invoke the plugin copy through the active runtime's owner-qualified skill selector; use a bare selector only when intentionally selecting a user-tier copy (a separately installed personal copy; Genie no longer seeds this tier). Cross-skill prose below uses bare names as portable semantic routes; the orchestrator resolves the selector for the active runtime.

The council is a saved workflow, not a procedure this skill performs inline. The
single source of truth is `.claude/workflows/council.js` in the genie repository's
canonical workflow catalog (see `.claude/workflows/README.md` there). This skill is
its front door: it turns the user's request into the workflow's `args` and runs the
workflow on the active runtime's workflow surface. It never dispatches lenses by
hand, so the lens roster, the response schemas and the synthesis shape live in one
file.

## When to use

A consequential decision benefits from independent scrutiny. The council assesses
by default; it does not edit files, change configuration, or execute a proposed
plan unless the user explicitly asks it to mutate, and the workflow itself never
mutates.

## Run it

Build `args` from the request. A plain string is the decision; an object adds
context:

```json
{
  "decision": "<one clear statement of what is being decided>",
  "constraints": ["<hard constraint>"],
  "evidence": ["<fact the lenses may rely on, with its source>"],
  "unknowns": ["<explicit unknown>"]
}
```

| Runtime | How to run the saved workflow |
|---------|-------------------------------|
| Claude Code | The native Workflow tool with the saved name `council`. If the name is ambiguous on the host (a stale user-scope copy, or a same-named entry from another scope), run it by explicit path: the `council.js` file in the repository's `.claude/workflows/` directory. |
| DSH | The genie DSH workflow surface, once the `dsh-workflow-fork` wish ships an executor that reads the same `.claude/workflows/` catalog: `/workflow council <args as JSON>`. Until then the council is not available on DSH; say so rather than deliberating inline. |
| Any other runtime | Not supported. Report that the council needs a workflow surface. |

Give the workflow the whole request at once. Do not pre-answer for any lens, and
do not feed one lens another lens's conclusion; the workflow enforces that
separation itself.

## What comes back

The workflow returns `{ok, decision, report, lenses, synthesis, notConvened}`. Relay
the `report` to the user unchanged. Its synthesis block always has this shape:

```text
Decision: proceed | proceed-with-conditions | revise | stop | gather-evidence
Consensus: <where the lenses agree>
Dissent: <minority positions, attributed by lens>
Conditions: <concrete prerequisites>
Evidence gaps: <unknowns that could change the decision>
Next action: <one bounded next step>
```

Lenses that returned nothing are listed under `notConvened` and were never
averaged in; surface that list. If `ok` is false, the workflow says why (no
decision given, or fewer than three lenses responded); relay that and stop.

Preserve minority opinions. A dissenting finding is not deleted merely because
most lenses agree. End after assessment unless mutation was explicitly authorized.
