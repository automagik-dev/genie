---
name: architecture
description: Use when reviewing architecture in any codebase — module boundaries, stated design contracts, abstraction depth, error-handling design. Assess by default, apply changes on request; complexity is dependencies plus obscurity, and deep modules win.
---

# Architecture Review

**Runtime syntax:** in Codex, invoke the plugin copy with the owner-qualified `$genie:<skill>` selector; use bare `$<skill>` only when intentionally selecting a user-tier copy (a separately installed personal copy; Genie no longer seeds this tier). Claude Code and Hermes use `/<skill>`. Cross-skill prose below uses bare names as portable semantic routes; the orchestrator resolves the selector for the active tier.

## Lens

This lane treats complexity as anything that makes a system hard to understand or modify — it accumulates as dependencies and obscurity. The unit of judgment is the module: deep modules (simple interface, substantial implementation) are good; shallow modules (interface as complicated as what they hide) are architecture debt. Information leakage, pass-through methods, and temporal decomposition are the smells to hunt. Prize "define errors out of existence" and design-it-twice thinking.

This lane's lens is inspired by the work of John Ousterhout, author of *A Philosophy of Software Design*.

## Mandate

Assess and report by default. Apply changes only when the invocation explicitly asks. Every finding must cite the concrete interface, import, or branch that embodies it — no vibes. Findings outside this lane (failing gates, security holes, missing tests) get a one-line handoff to the relevant lane skill under `skills/`. When you have enough information to judge, judge; recommend one design, not a survey.

## Discover the Ground Truth First

Architecture is judged against the repo's own stated intent, then against first principles. Before scoring anything, collect: `CLAUDE.md` / `AGENTS.md` architecture sections, ADRs or design docs, any documented invariants ("X must never import Y", "state lives in Z"), and the real module graph traced from the entry points via imports. A repo's deliberate constraints (zero-daemon designs, intentionally-duplicated modules, forbidden cross-imports) are the design under review — the defect is a *violated* contract or a contract the code has outgrown, not the contract's existence.

**Genie-framework repos**: `.genie/` documents (wishes, brainstorms) often record the intended design and its acceptance criteria — read the relevant wish before judging the code it produced.

**Repo profile — recall, verify, persist.** Before deriving from scratch, recall a stored profile for this repo: a memory/brain store if one is available this session, else a well-known file (in genie-framework repos, `.genie/repo-profile.md`). For this lane the profile records the module map, documented invariants, key interfaces and their depth verdicts. Recalled anchors are hypotheses — re-verify each invariant you rely on against current code and report drift as a finding. After the audit, persist what discovery learned: update rather than duplicate, delete what proved wrong.


**Profile write boundary.** During assess-only and pull-request runs, return proposed profile changes as a `profile_delta`; do not write memory or repository files. Persist a profile only when the user explicitly asks.

## Workflow

1. **Map the module graph.** Trace imports from the entry points; identify layers, cycles, and upward imports. Done when you have the real dependency picture, not the README's.
2. **Verify the stated contracts.** For each documented invariant found in discovery, read the code that must uphold it. Done when each is confirmed intact or broken with file:line evidence.
3. **Depth-score the key interfaces.** For the repo's central abstractions: interface surface vs implementation hidden, leakage of internals to callers, pass-throughs. Done when each has a deep/shallow verdict with the specific signature that decides it.
4. **Hunt the classic smells**: information leakage (two modules that must change together), temporal decomposition (modules named after steps, not capabilities), exceptions where errors could be defined away, configuration knobs exporting decisions the module should make. Done when each smell has a concrete instance or the category is declared clean.
5. **Rank by change amplification** — how many places must be touched when the underlying decision changes — and report.

## Grounded Reporting

Every structural claim traces to code read this session, cited file:line. A design opinion is only a defect if you can name the modification scenario it makes expensive; interfaces judged without reading their implementation are labeled as such.

## Output Format

Lead with a one-sentence verdict on architectural health. Then findings ranked by change-amplification risk, each with evidence, the modification scenario it hurts, and one recommended structural move. Explicitly list contracts verified intact — a review that only lists problems hides where the design is strong. Cross-lane handoffs last. In a genie-framework repo, use CRITICAL/HIGH/MEDIUM/LOW for finding severities and SHIP/FIX-FIRST/BLOCKED only for the overall verdict and note which findings warrant a refactor wish via `wish` rather than opportunistic edits.

## Pitfalls

- Deliberate separation is not duplication to consolidate — when the docs say two modules must not share code, the finding would be a cross-import, not the existence of two modules.
- A documented, empirically-forced exception to a clean rule is design; judge how it is encapsulated, not that it exists.
- Do not recommend extracting helpers from a readable linear workflow just to lower a complexity score — indirection with one caller is the opposite of a deep module. Respect the repo's own complexity-budget policy if it has one.
- Architectural constraints like "no resident daemon" or "state never in files" are usually load-bearing product decisions; proposing their reversal is a scope change to surface, not a finding to assert.
- Read the design doc or wish behind a subsystem before judging it — code that looks odd often implements a stated requirement.
