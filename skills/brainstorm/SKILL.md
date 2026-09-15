---
name: brainstorm
description: "Explore an ambiguous idea with the user, settle scope and success criteria, and produce an independently reviewed design for wish."
---

# Brainstorm

Use when the problem, approach, or boundaries need decisions. Explore with the user; do not implement. Resume a related draft rather than starting another.

## Explore

Establish the problem and who it affects, scope and exclusions, constraints, risks, and observable success. Inspect relevant project evidence before presenting options. Ask only questions whose answers change the design; make routine assumptions explicit. Use a council when a consequential disagreement needs independent perspectives.

A design is ready when those questions are settled enough to write a testable plan. Record unresolved decisions in `.genie/brainstorms/<slug>/DRAFT.md` so the next session can continue.

## Simplicity Gate

Choose the simplest complete design satisfying current user stories. Justify added state, caches, synchronization, configuration, or background work with a present requirement or measurement. Bound current data and separate history before introducing distribution machinery. Name concrete triggers for deferred complexity.

## Design and independent review

1. Resolve this skill’s directory and copy `references/design-template.md` to `.genie/brainstorms/<slug>/DESIGN.md` when creating a design. Preserve existing work on resume.
2. Fill the problem, scope, approach, decisions, Simplicity Case, risks, and testable criteria. Remove placeholders.
3. Send the exact design to an independent `review` agent. The reviewer returns verdict, identity, UTC time, findings, and `reviewed-sha256` for the content it actually reviewed. This skill bundles `references/design-review-evidence.mjs` for digesting and stamping.
4. The caller passes the reviewer’s digest unchanged to the stamp command:

```bash
node "<brainstorm-skill-dir>/references/design-review-evidence.mjs" stamp ".genie/brainstorms/<slug>/DESIGN.md" --verdict SHIP --reviewed-sha256 "<reviewer-returned-sha256>" --reviewer "<reviewer-id>" --reviewed-at "<UTC-time>"
node "<brainstorm-skill-dir>/references/design-review-evidence.mjs" verify ".genie/brainstorms/<slug>/DESIGN.md"
```

Stamp the actual verdict, including FIX-FIRST or BLOCKED; the example shows SHIP. Stamping rejects an edit made after review; changing any reviewed design content invalidates the evidence. Never substitute a locally recomputed digest for the reviewer’s value. Correct blocking findings and obtain fresh review before `wish` consumes the design.

## Planning index

`.genie/INDEX.md` is the single intake index. Reconcile a legacy `.genie/brainstorm.md` idempotently into it when encountered; do not maintain two indexes or duplicate entries.

- Raw: captured idea.
- Simmering: draft with unresolved decisions.
- Ready: reviewed design awaiting a wish.
- Poured: an existing WISH.md has persisted APPROVED status.

A design or a score alone never makes an entry Poured. Update only the related entry and preserve unrelated material. Ensure the design, draft, and index accompany the wish in version control; in a shared workspace the coordinator stages them. Return artifact paths, settled decisions, unresolved questions, and next route. Task-board pointers are optional; unavailable tracking does not block the design.
