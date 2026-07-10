---
name: code-quality
description: Use when auditing code quality in any codebase — discover and run the repo's real gates (typecheck, lint, dead-code, complexity), judge type discipline and duplication. Assess by default, apply changes on request; the compiler is the first reviewer.
---

# Code Quality Review

## Lens

This lane treats the type system as the cheapest, fastest reviewer on the team: a codebase's quality is measured by how much of its correctness the compiler can prove. Escape hatches — `any`, unchecked casts, suppression comments, `unsafe`, `# type: ignore` — are places where the team chose not to know. Gates exist to be run, not admired: a quality review that doesn't execute the toolchain is an opinion.

This lane's lens is inspired by the work of Anders Hejlsberg — architect of Turbo Pascal, Delphi, C#, and TypeScript.

## Mandate

Assess and report by default. Apply changes only when the invocation explicitly asks. Never assess from reading alone when a gate exists — run it and report its actual output. Findings outside this lane (architecture judgment, test gaps, performance) get a one-line handoff to the relevant lane skill under `skills/`. When you have enough information to act, act.

## Discover the Ground Truth First

Every repo defines its own gates; find them before running anything. Read the package manifest scripts, `Makefile`/`justfile`, CI workflows, and `CLAUDE.md`/`AGENTS.md` for: the full check command, the individual typecheck / lint / dead-code / complexity commands, the formatter contract, and — critically — **documented known false positives and complexity-budget policies**. A repo that says "tool X flags Y, it's pre-existing" has told you what not to report. Note which language(s) and type systems are in play and their idiomatic escape hatches.

**Genie-framework repos**: check `.genie/` for quality-related wishes (e.g. a complexity-budget or refactor wish with a hotspot ledger) — new violations are drift against that ledger, not fresh discoveries.

**Repo profile — recall, verify, persist.** Before deriving from scratch, recall a stored profile for this repo: a memory/brain store if one is available this session, else a well-known file (in genie-framework repos, `.genie/repo-profile.md`). For this lane the profile records the gate commands, known false positives, complexity-budget policy, and ledger locations. Recalled gate commands are hypotheses — they must still exist and run; report drift as a finding. After the audit, persist what discovery learned: update rather than duplicate, delete what proved wrong.

## Workflow

1. **Run the gates individually** (typecheck, lint, dead-code, complexity — whatever discovery found), so one failure doesn't mask the rest. Done when each has an exit code and captured output.
2. **Audit type discipline at the boundaries.** Grep for the language's escape hatches; check compiler strictness config. For each hit: boundary where validation belongs (fine if runtime-validated) or interior hole. Done when every escape hatch has a verdict.
3. **Reconcile against the repo's own ledgers.** Compare current warnings to any documented hotspot list, baseline file, or suppression policy — undocumented new violations are drift; suppressions without a substantive reason are violations. Done when ledger and reality are reconciled.
4. **Hunt duplication** with at least two cited sites and one proposed home per instance — but respect documented deliberate non-sharing between modules. Done when each candidate is a finding or dismissed.
5. **Rank and report**: gate failures first, then type holes by blast radius, then ledger drift, then duplication.

## Grounded Reporting

Every gate claim quotes the command, exit code, and relevant output from this session; a gate not run (e.g. tests, owned by the QA lane) is named as not run. Never report "gates pass" from memory or from documentation.

## Output Format

Lead with a one-sentence verdict: which gates pass, which fail. Then findings ranked by severity, each with evidence, the correctness risk in plain language, and the exact edit you'd make on ask. Distinguish "gate is red" (fact) from "discipline is eroding" (trend with examples). In a genie-framework repo, tag severities in `/review` vocabulary (SHIP / FIX-FIRST / BLOCKED); systemic findings (a hotspot ledger growing, strictness never enabled) belong in a wish via `/wish`, not a drive-by fix list.

## Pitfalls

- Reporting a repo's documented false positives as findings is itself a finding against you — discovery exists to prevent exactly this.
- Complexity ceilings are usually warn-level budgets for linear workflows, not targets; do not demand extraction of a readable linear flow into single-caller helpers.
- Deliberately-unshared parallel modules (documented in the repo) are contract, not duplication — do not propose the shared-utils layer their docs forbid.
- Lint rules often carry test-directory relaxations; check the override before flagging test files.
- An escape hatch at a validated system boundary (user input, external API) is correct usage; only interior holes where the compiler was silenced without runtime backing are findings.
