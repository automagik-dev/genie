---
name: genie
description: "Route Genie questions, operations, bugs, and planned work. Resume related wishes; handle ordinary requests directly unless Genie planning or coordination adds value."
---

# Genie

Route the request using the active runtime’s discovered skills. Preserve the user’s scope and existing authorization.

## Choose a route

Inspect related `.genie/wishes/` and `.genie/brainstorms/` only as needed. Resume matching work before creating a new plan. An explicit skill request selects that skill; a mention of Genie is not necessarily an invocation.

Ordinary unrelated requests bypass the lifecycle unless the user asks for Genie or the work needs durable planning, unresolved product/architecture decisions, coordinated workstreams, or tracking across sessions. Announce the bypass in one line and proceed without creating `.genie` artifacts or adding Genie gates. Repository validation and safety rules still apply. Use cheap read-only inspection when uncertain. Security-sensitive changes retain review gates unless the user explicitly chooses otherwise.

| Request | Route |
|---|---|
| Ambiguous idea needing decisions | `brainstorm` |
| Defined work needing a durable plan | `wish` |
| Bug investigation | `report` |
| Design, plan, implementation, or PR assessment | `review` |
| Consequential decision with competing views | `council` |
| Explicit fast delivery ("quick") or batch execution | `quick` or `dream` |
| Prompt, documentation, channel wiring, community patterns | `refine`, `docs`, `omni`, or `genie-hacks` |
| Genie question or operation | Current CLI help and the requested operation |

Bug reports, operational commands, and Genie questions route normally without creating a wish merely to answer them. With no request text, summarize relevant open work and ask what the user wants to do.

## Resume persisted state

| WISH Status | Route |
|---|---|
| DRAFT | Continue `wish`, then plan review |
| FIX-FIRST | Correct the recorded gaps through `fix` |
| APPROVED | `work` |
| IN_PROGRESS | Resume `work` or its recorded corrective route |
| BLOCKED | Resolve the recorded blocker |
| SHIPPED | Report history; new scope needs its own plan |

A ready design without an approved wish resumes at its recorded brainstorm/wish handoff. Review verdicts alone do not change state: the caller persists evidence and transitions. Read `reference/lifecycle.md` for that contract.

## Operations

Read `genie --help` and the relevant namespace help before running CLI commands. Standalone mode uses `genie task` and `genie board`; Orca mode uses Orca’s native state and version-matched `orca-cli` / `orchestration` guides. Installing or opening Orca does not change the selected lifecycle authority. Never bypass an Orca-mode refusal by opening Genie’s local task DB.

Use structured status and native completion notifications. A worker’s completion claim still requires the workflow’s review and validation before its group is done.
