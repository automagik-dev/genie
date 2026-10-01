# DRAFT: brainstorm-workflow (check-design fixture)

`DESIGN.md` beside this file is the frozen design of the `brainstorm-workflow` brainstorm, copied byte for byte (SHIP, review digest `a2dd766c…`). This is not that brainstorm's DRAFT: its ledger block transcribes only what the design cites, so `round-ledger.mjs check-design` runs against it in CI (wish `brainstorm-workflow`, Decision 8).

- The Settled ids keep the original DRAFT's numbering: R2-4 is its Settled #4, answered in round 2, not the fourth question of round 2. That DRAFT predates the ledger's `R<round>-<n>` scheme and recorded neither question texts nor option values, so every `value` is null and each `question` names where the entry came from.
- The one council is the round-3 Socratic run that decided P1-P16.
- The reviews are the four design reviews with their full digests; `findings` lists each review's finding ids and the criteria C1-C12 it scored.
- The original DRAFT kept no per-item record of Scope IN, so `scopeIn` is empty.

## Settled

- **R1-1** (round 1, decision): DRAFT Settled #1, round 1 (question text not recorded) — owner answered through the question harness; the DRAFT recorded: "WRS returns as it was (5 dimensions, bar every round); wish size (P/M/G, split or not) is a triage output outside the score."
- **R1-2** (round 1, decision): DRAFT Settled #2, round 1 (question text not recorded) — owner answered through the question harness; the DRAFT recorded: "One round per run; DRAFT.md carries state; `/brainstorm` collects the answers and re-invokes."
- **R1-3** (round 1, decision): DRAFT Settled #3, round 1 (question text not recorded) — owner answered through the question harness; the DRAFT recorded: "One council per round answers every open decision at once (recommended answer + dissent)." · reopened by R3-council
- **R2-4** (round 2, decision): DRAFT Settled #4, round 2 (question text not recorded) — owner answered through the question harness; the DRAFT recorded: "Spine fixed, inside free: the script fixes only the auditable parts (WRS in DRAFT.md, the human round, the design-review stamp); a lead agent decides scouts (0..n), tier, effort and whether to convene the council; the script runs the lead's plan and returns it."
- **R2-5** (round 2, decision): DRAFT Settled #5, round 2 (question text not recorded) — owner answered through the question harness; the DRAFT recorded: "The council is Felipe's Socratic pattern (Lenses → Elenchus by Socrates on Fable 5.1 high → Answers → Proposal that writes AskUserQuestion-ready rounds), as run in his sessions since 2026-09-28; it is not in the catalog's `council.js`."
- **R3-agents** (round 3, decision): DRAFT round 3, R3-agents (question text not recorded) — owner picked "PR pequeno separado (Recommended)"; the DRAFT recorded: the per-question rule also goes to AGENTS.md in its own small PR.
- **R3-council** (round 3, decision): DRAFT round 3, R3-council (question text not recorded; per the DRAFT it quoted Settled #3 against #4: old "one council per round answers every open decision at once" → new "lead's judgment, none by default") — owner picked "Julgamento do líder, nenhum por padrão (Recommended)"; the DRAFT recorded: no council unless asked or a decision is contested and hard to reverse; reason and spend in the plan; tighten-only ceiling in budgets.*. · reopens R1-3
- **R4-delivery** (round 4, decision): DRAFT round 4, R4-delivery (question text not recorded) — owner picked "Wish com grupos (Recommended)"; the DRAFT recorded: one WISH.md in groups (G1 ledger, G2 routing, G3 brainstorm.js, G4 front door/template/anchors), plan reviewed, one PR to dev.
- **R4-ceiling** (round 4, decision): DRAFT round 4, R4-ceiling (question text not recorded) — owner picked "1 por brainstorm (Recommended)"; the DRAFT recorded: at most one council per brainstorm; a second only on an explicit owner request; code ceiling 3.
- **R5-roster** (round 5, decision): DRAFT round 5, R5-roster (question text not recorded) — owner picked "Escritas por decisão (Recommended)"; the DRAFT recorded: the lead writes 3 to 5 lens briefs per decision, dissent always present; the test only requires dissent. Reopens the design's earlier "council.js's five canonical lenses", which was the author's, never asked.

## Asked

_No open questions._

## Size

- **M** · raised by owner · round 4

## Scope ratchet

_No IN items yet._

## Councils

- run wf_24aa02c5-abd · round 3 · decided P1, P2, P3, P4, P5, P6, P7, P8, P9, P10, P11, P12, P13, P14, P15, P16

## Ledger

```ledger
{
  "settled": [
    {
      "id": "R1-1",
      "kind": "decision",
      "question": "DRAFT Settled #1, round 1 (question text not recorded)",
      "answer": "WRS returns as it was (5 dimensions, bar every round); wish size (P/M/G, split or not) is a triage output outside the score.",
      "value": null,
      "provenance": "owner answered through the question harness; the DRAFT recorded: \"WRS returns as it was (5 dimensions, bar every round); wish size (P/M/G, split or not) is a triage output outside the score.\"",
      "round": 1
    },
    {
      "id": "R1-2",
      "kind": "decision",
      "question": "DRAFT Settled #2, round 1 (question text not recorded)",
      "answer": "One round per run; DRAFT.md carries state; `/brainstorm` collects the answers and re-invokes.",
      "value": null,
      "provenance": "owner answered through the question harness; the DRAFT recorded: \"One round per run; DRAFT.md carries state; `/brainstorm` collects the answers and re-invokes.\"",
      "round": 1
    },
    {
      "id": "R1-3",
      "kind": "decision",
      "question": "DRAFT Settled #3, round 1 (question text not recorded)",
      "answer": "One council per round answers every open decision at once (recommended answer + dissent).",
      "value": null,
      "provenance": "owner answered through the question harness; the DRAFT recorded: \"One council per round answers every open decision at once (recommended answer + dissent).\"",
      "round": 1,
      "reopenedBy": "R3-council"
    },
    {
      "id": "R2-4",
      "kind": "decision",
      "question": "DRAFT Settled #4, round 2 (question text not recorded)",
      "answer": "Spine fixed, inside free: the script fixes only the auditable parts (WRS in DRAFT.md, the human round, the design-review stamp); a lead agent decides scouts (0..n), tier, effort and whether to convene the council; the script runs the lead's plan and returns it.",
      "value": null,
      "provenance": "owner answered through the question harness; the DRAFT recorded: \"Spine fixed, inside free: the script fixes only the auditable parts (WRS in DRAFT.md, the human round, the design-review stamp); a lead agent decides scouts (0..n), tier, effort and whether to convene the council; the script runs the lead's plan and returns it.\"",
      "round": 2
    },
    {
      "id": "R2-5",
      "kind": "decision",
      "question": "DRAFT Settled #5, round 2 (question text not recorded)",
      "answer": "The council is Felipe's Socratic pattern (Lenses → Elenchus by Socrates on Fable 5.1 high → Answers → Proposal that writes AskUserQuestion-ready rounds), as run in his sessions since 2026-09-28; it is not in the catalog's `council.js`.",
      "value": null,
      "provenance": "owner answered through the question harness; the DRAFT recorded: \"The council is Felipe's Socratic pattern (Lenses → Elenchus by Socrates on Fable 5.1 high → Answers → Proposal that writes AskUserQuestion-ready rounds), as run in his sessions since 2026-09-28; it is not in the catalog's `council.js`.\"",
      "round": 2
    },
    {
      "id": "R3-agents",
      "kind": "decision",
      "question": "DRAFT round 3, R3-agents (question text not recorded)",
      "answer": "PR pequeno separado (Recommended)",
      "value": null,
      "provenance": "owner picked \"PR pequeno separado (Recommended)\"; the DRAFT recorded: the per-question rule also goes to AGENTS.md in its own small PR.",
      "round": 3
    },
    {
      "id": "R3-council",
      "kind": "decision",
      "question": "DRAFT round 3, R3-council (question text not recorded; per the DRAFT it quoted Settled #3 against #4: old \"one council per round answers every open decision at once\" → new \"lead's judgment, none by default\")",
      "answer": "Julgamento do líder, nenhum por padrão (Recommended)",
      "value": null,
      "provenance": "owner picked \"Julgamento do líder, nenhum por padrão (Recommended)\"; the DRAFT recorded: no council unless asked or a decision is contested and hard to reverse; reason and spend in the plan; tighten-only ceiling in budgets.*.",
      "round": 3,
      "reopens": "R1-3"
    },
    {
      "id": "R4-delivery",
      "kind": "decision",
      "question": "DRAFT round 4, R4-delivery (question text not recorded)",
      "answer": "Wish com grupos (Recommended)",
      "value": null,
      "provenance": "owner picked \"Wish com grupos (Recommended)\"; the DRAFT recorded: one WISH.md in groups (G1 ledger, G2 routing, G3 brainstorm.js, G4 front door/template/anchors), plan reviewed, one PR to dev.",
      "round": 4
    },
    {
      "id": "R4-ceiling",
      "kind": "decision",
      "question": "DRAFT round 4, R4-ceiling (question text not recorded)",
      "answer": "1 por brainstorm (Recommended)",
      "value": null,
      "provenance": "owner picked \"1 por brainstorm (Recommended)\"; the DRAFT recorded: at most one council per brainstorm; a second only on an explicit owner request; code ceiling 3.",
      "round": 4
    },
    {
      "id": "R5-roster",
      "kind": "decision",
      "question": "DRAFT round 5, R5-roster (question text not recorded)",
      "answer": "Escritas por decisão (Recommended)",
      "value": null,
      "provenance": "owner picked \"Escritas por decisão (Recommended)\"; the DRAFT recorded: the lead writes 3 to 5 lens briefs per decision, dissent always present; the test only requires dissent. Reopens the design's earlier \"council.js's five canonical lenses\", which was the author's, never asked.",
      "round": 5
    }
  ],
  "asked": [],
  "size": [
    {
      "value": "M",
      "by": "owner",
      "round": 4
    }
  ],
  "scopeIn": [],
  "councils": [
    {
      "run": "wf_24aa02c5-abd",
      "round": 3,
      "decided": [
        "P1",
        "P2",
        "P3",
        "P4",
        "P5",
        "P6",
        "P7",
        "P8",
        "P9",
        "P10",
        "P11",
        "P12",
        "P13",
        "P14",
        "P15",
        "P16"
      ]
    }
  ],
  "reviews": [
    {
      "verdict": "FIX-FIRST",
      "digest": "d9e22cf4f9216127559f63355ec32331f5e617eab9fa7e45ebb6a3f7f60905ae",
      "round": 3,
      "repaired": false,
      "findings": [
        "HIGH-1",
        "HIGH-2",
        "HIGH-3",
        "HIGH-4",
        "HIGH-5",
        "HIGH-6",
        "HIGH-7",
        "M1",
        "M2",
        "M3",
        "M4",
        "M5",
        "M6",
        "M7",
        "M8",
        "M9",
        "M10",
        "L1",
        "L2",
        "L3",
        "L4",
        "L5",
        "C1",
        "C2",
        "C3",
        "C4",
        "C5",
        "C6",
        "C7",
        "C8",
        "C9",
        "C10",
        "C11",
        "C12"
      ]
    },
    {
      "verdict": "FIX-FIRST",
      "digest": "41279cec2ab9a1bd656dc8b4f6d2edb0516c297c639a3300387fe0346dd89689",
      "round": 4,
      "repaired": true,
      "findings": [
        "N1",
        "N2",
        "N3",
        "N4",
        "N5",
        "L-new1",
        "L-new2",
        "L-new3",
        "C1",
        "C2",
        "C3",
        "C4",
        "C5",
        "C6",
        "C7",
        "C8",
        "C9",
        "C10",
        "C11",
        "C12"
      ]
    },
    {
      "verdict": "FIX-FIRST",
      "digest": "7d29b423dba13ac658ce3a858f806593e69aacbb421849521878aa6100d88abc",
      "round": 5,
      "repaired": true,
      "findings": [
        "N6",
        "N7",
        "N8",
        "N9",
        "L6",
        "L7",
        "C1",
        "C2",
        "C3",
        "C4",
        "C5",
        "C6",
        "C7",
        "C8",
        "C9",
        "C10",
        "C11",
        "C12"
      ]
    },
    {
      "verdict": "SHIP",
      "digest": "a2dd766c158cc36431d81261d3165e83eda8ab21a31a8ea65e7baff869cf9775",
      "round": 5,
      "repaired": true,
      "findings": [
        "M-a",
        "M-b",
        "M-c",
        "M-d",
        "L8",
        "L9",
        "L10",
        "L11",
        "C1",
        "C2",
        "C3",
        "C4",
        "C5",
        "C6",
        "C7",
        "C8",
        "C9",
        "C10",
        "C11",
        "C12"
      ]
    }
  ]
}
```
