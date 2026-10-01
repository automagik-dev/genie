---
name: brainstorm
description: "Explore an ambiguous idea with the user, settle scope and success criteria, and produce an independently reviewed design for wish."
category: lifecycle
mutates: documents
---

# Brainstorm

Use when the problem, approach, or boundaries need decisions. Explore with the user; do not implement. Resume a related draft rather than starting another: the slug names `.genie/brainstorms/<slug>/`, whose `DRAFT.md` carries the state of every round.

The brainstorm is a saved workflow that runs one round per invocation, because a workflow cannot wait for a person: the owner answers between runs. The single source of truth is `.claude/workflows/brainstorm.js` in the genie repository's workflow catalog (see `.claude/workflows/README.md` there); this skill is its front door and carries no stage roster of its own. On a runtime that runs saved workflows, run the script at `<repository root>/.claude/workflows/brainstorm.js` when that file exists, otherwise `~/.claude/workflows/brainstorm.js` (delivered by `genie install` / `genie update`); give the runtime that explicit script path, never a bare name — both scopes carry these names and the order a name resolves in is undocumented. On a runtime that does not, or where neither file exists, follow "Without a workflow surface" below.

## Invoke

Pass `{slug, request?, answers?, repo, tools: {ledger, evidence, reviewContract}, councilCeiling, repairBudget, model?, timestamp}` through args, every path absolute:

- `slug` is lowercase letters, digits and dashes; `request` is the idea in the owner's words; `repo` is the repository root; `timestamp` is the caller's clock, since the workflow has none; `model` pins every stage.
- `tools` resolve from this skill's own directory, never from the checkout, so a round runs from any repository: `ledger` is `references/round-ledger.mjs`, `evidence` is `references/design-review-evidence.mjs`, and `reviewContract` is `review/SKILL.md` in the skills directory that holds this one, the `review` skill installed beside it; a single-skill install has none, and the run ends `failed` naming the path. The design template stays at `references/design-template.md` beside the ledger, where the workflow finds it.
- `councilCeiling` is the output of `genie config get budgets.maxCouncilsPerBrainstorm` and `repairBudget` the output of `genie config get budgets.maxEscalationsPerGroup`. When `genie` is absent or a read exits non-zero — an installed release older than the council key exits 1 on it — pass that value's schema default (ceiling 1, repair budget 2) and say so when you relay the result.

## Each round

1. Run the script, then relay the WRS bar (`wrs.bar`), the plan as run and the `notes`. Whatever the state, run `genie wish report <runId> --append` with the run id the runtime reported, and relay its output: the run's tokens and time per stage, and one row in the machine-local ledger.
2. Relay `questions` through the runtime's question harness, at most four per batch: each question's text, header and option labels exactly as returned, in the order returned, with no rephrasing and no translation. Ids and kinds stay outside the harness payload.
3. Map the answers back to ids by question order and invoke again with `answers: [{id, question, answer}]`: the id, the question text as the harness returned it, and the picked label (an array of labels for a multi-select) or the owner's own words verbatim. Leave out a question nobody answered; it stays Asked and comes back next round.
4. An empty `round`, with no question to relay, is a valid result: invoke again.

The per-question rule, verbatim: "An answer settles only the question it answers. Nothing rides along: a change the owner was not asked about, including any edit to something they already approved, goes in its own question. An approved decision is reopened only by a question that quotes it and shows old → new. Moves that add scrutiny may be taken and announced; moves that reduce what the owner sees, or change what they approved, wait for their answer."

`state` is one of:

- `round` — questions to relay, including a `council-approval` question (convene past the ceiling or not) or a `review-findings` question (repair again, I settle them, stop).
- `done` — DESIGN.md carries a verified SHIP stamp; the only next route is `wish`.
- `answered` — the owner ended with a recorded verdict and no design.
- `blocked` — a ledger refusal the owner must resolve, a BLOCKED review, the repair budget spent, or the owner's stop. Stop is permanent for the slug: resuming needs a new slug or a deliberate reopen.
- `failed` — a spine agent returned nothing, the ledger could not start, or the review contract is missing; `notConvened` names the agents.

## Simplicity Gate

Choose the simplest complete design satisfying current user stories. Justify added state, caches, synchronization, configuration, or background work with a present requirement or measurement. Bound current data and separate history before introducing distribution machinery. Name concrete triggers for deferred complexity.

## Planning index

`.genie/INDEX.md` is the single intake index. Reconcile a legacy `.genie/brainstorm.md` idempotently into it when encountered; do not maintain two indexes or duplicate entries. After each run, write this slug's entry with a link to `brainstorms/<slug>/`: Simmering while rounds run, Ready at `done`.

- Raw: captured idea.
- Simmering: draft with unresolved decisions.
- Ready: reviewed design awaiting a wish.
- Poured: an existing WISH.md has persisted APPROVED status.

A design or a score alone never makes an entry Poured. Update only the related entry and preserve unrelated material. Ensure the design and the index accompany the wish in version control; in a shared workspace the coordinator stages them. Report the DRAFT and DESIGN paths, the state and the next route. Task-board pointers are optional; unavailable tracking does not block the design.

## Without a workflow surface

Run the same spine inline, one round per turn, as `references/without-a-workflow.md` lays out: the ledger commands through the shell, the lead's work in this session, scouts and the review through the runtime's native delegation surface, and each question as numbered options with its id, recommended first, answered in the same `{id, question, answer}` shape. At WRS 100 with nothing open, write `.genie/brainstorms/<slug>/DESIGN.md` from `references/design-template.md` and run the ledger's `check-design`. Send the exact design to an independent `review` agent with `review/SKILL.md`'s contract, the DRAFT, and the files the design changes as required reading. The reviewer returns verdict, identity, UTC time, findings, and `reviewed-sha256` for the content it actually reviewed; this skill bundles `references/design-review-evidence.mjs`, and the caller passes the reviewer's digest unchanged to the stamp command:

```bash
node "<brainstorm-skill-dir>/references/design-review-evidence.mjs" stamp ".genie/brainstorms/<slug>/DESIGN.md" --verdict SHIP --reviewed-sha256 "<reviewer-returned-sha256>" --reviewer "<reviewer-id>" --reviewed-at "<UTC-time>"
node "<brainstorm-skill-dir>/references/design-review-evidence.mjs" verify ".genie/brainstorms/<slug>/DESIGN.md"
```

Stamp the actual verdict, including FIX-FIRST or BLOCKED; the example shows SHIP. Stamping rejects an edit made after review; changing any reviewed design content invalidates the evidence. Never substitute a locally recomputed digest for the reviewer’s value. Record every verdict with the ledger's `review` command, repair a FIX-FIRST within the repair budget, and obtain fresh review before `wish` consumes the design.
