# Wish: Proportional validation policy

| Field | Value |
|-------|-------|
| **Status** | SHIPPED — Group 1 (sole group) execution SHIP 2026-07-28, skills landed on dev (`78a22a325`), 3/3 success criteria ticked; post-merge QA rows remain a ritual item; header reconciled + archived 2026-08-24 |
| **Slug** | `proportional-validation-policy` |
| **Date** | 2026-07-28 |
| **Author** | Codex with user direction |
| **Appetite** | small |
| **Branch** | `policy/proportional-validation` |
| **Repos touched** | `automagik-dev/genie` |
| **Issue** | [#2724](https://github.com/automagik-dev/genie/issues/2724) |
| **Design** | _No brainstorm — direct wish_ |

## Summary

When Genie plans, executes, or reviews work in any target repository, it will require validation effort to match the
risk and reach of the actual diff. A documentation-only change such as a README edit will use focused documentation
checks, while cross-cutting runtime, dependency, generated
executable/runtime artifact, CI, integration, and release changes will still escalate to the aggregate gate.
Deterministic generated documentation and plugin mirrors may instead use focused generator, parity, and content checks.

## Scope

### IN

- Make the shipped, runtime-neutral `wish`, `work`, and `review` workflows select, execute, and assess the smallest
  sufficient validation command in whichever target repository invokes Genie, with explicit triggers for widening.
- Regenerate the committed Codex plugin skill mirror so the shipped workflow matches the canonical skills.

### OUT

- Automatic changed-file classification, a validation-command generator, caches, and new CI jobs.
- Modifying target repositories' `AGENTS.md`, CI configuration, package scripts, or test commands.
- Weakening a target repository's aggregate CI, integration, release, or pre-merge gates.
- Retrofitting historical wishes whose validation commands were correct under their original policy.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Proportional means risk-and-reach based, not file-extension based | A README can contain generated or tested contracts, while a small source diff can affect every command. |
| 2 | Every change gets targeted validation; widening is trigger-based | This removes waste without turning “proportional” into permission to skip evidence. |
| 3 | Keep the aggregate gate at integration/release boundaries | A focused local loop and a final system gate serve different purposes. |
| 4 | Change shipped workflow policy surfaces only | The workflow already carries each target repo's per-group validation commands; no selector engine or target-repo edit is required. |

## Simplicity Case

- **Simplest complete design:** Rewrite the portable workflow guidance so Genie chooses the narrowest target-repository
  checks that directly exercise the changed contract, then widens only for named risk triggers.
- **Added machinery:** None. Existing validation-command fields and review evidence carry the policy.
- **Deferred until measured:** Automate selection only after repeated review evidence shows humans or agents choose
  insufficient checks; add a classifier only when at least three concrete misses share a deterministic rule.
- **Complexity removed:** No path matrix, config surface, cache, changed-file parser, or second CI workflow.

## Dependencies

**depends-on:** none
**blocks:** none

## Success Criteria

- [x] Shipped `wish`, `work`, and `review` consistently require the smallest sufficient target-repository validation
  and the same widening triggers.
- [x] The policy never permits zero validation and preserves aggregate validation for integration/release risk.
- [x] Canonical and plugin-mirrored skills remain byte-identical.

## Execution Strategy

### Wave 1 (sequential)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 1 | engineer | 1 — prompt-skill change | engineer-trivial / low | Update and validate the proportional policy surfaces. |

Complexity scoring rubric: score each group independently and record the total plus a short rationale in **Complexity**. Add:

- **+2** each for orchestration / agent-lifecycle / routing; cost / model / escalation; stateful work; subjective acceptance.
- **+1** each for multi-package work; OTel-label dependency; no deterministic test; prior rework; prompt-skill change; CI / release work.

Route the total in **Model** by portable role and reasoning effort: **0–1** →
`engineer-trivial` / low; **2–3** → `engineer-standard` / medium or high;
**4–6** → `engineer-complex` / high; **7+** → `engineer-complex` plus an
independent `final-gate` at the highest justified effort. Codex maps these to
the `genie_*` profiles; other runtimes use their matching native roles. Keep
model and effort in runtime session/agent configuration, never skill frontmatter.

## Execution Groups

### Group 1: Make validation proportional

**Goal:** Make Genie's cross-repository per-group validation requirements scale with the target diff's risk and reach.

**Deliverables:**
1. Update `skills/wish/SKILL.md`, `skills/work/SKILL.md`, and `skills/review/SKILL.md` so plans, execution, and reviews
   apply the same rule.
2. Regenerate `plugins/genie/skills/` from the canonical skill tree.

**Acceptance Criteria:**
- [x] Documentation-only changes use relevant formatting, link, or content-contract checks rather than `bun run check`
  by default.
- [x] Runtime changes name focused tests for changed behavior and add type/lint/build checks only when the diff reaches
  those contracts.
- [x] Shared runtime/core behavior, dependency/lockfile, generated executable/runtime artifact, config/schema,
  CI/release, broad refactor, or uncertain impact explicitly widen to `bun run check` and any affected build/e2e gate;
  deterministic documentation/plugin mirrors may use focused generator, parity, and content checks.
- [x] Review rejects under-validation and zero validation; a passing full suite missing only its scope rationale is at
  most a MEDIUM gap, never by itself a blocker.
- [x] Canonical and mirrored skills pass their focused structural/parity checks.

**Validation:**
```bash
bun run wishes:lint
bun run skills:lint
bun scripts/sync-plugin-skills.ts --check
bun test scripts/sync-plugin-skills.test.ts
```

**depends-on:** none

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] A README-only example clearly selects focused documentation checks without the full suite.
- [ ] A shared runtime or release example clearly selects the aggregate gate.
- [ ] The installed plugin payload carries the same policy as the source skills.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| “Proportional” becomes subjective under-testing | Medium | Name a minimum evidence rule and explicit widening triggers. |
| Aggregate checks are removed from true integration boundaries | Medium | State that CI, release, and cross-cutting gates remain mandatory. |
| Canonical/plugin policy drift | Low | Regenerate the mirror and run the parity check. |

---

## Review Results

### Plan review — 2026-07-28T09:58:10Z

- **Context:** Plan review before execution
- **Target SHA-256:** `f72a6b3dd11763a870ca75a49b39622e84e3657a014fcd82f89f4ee9888a8f57`
- **Base HEAD:** `614e472c43977c3c122f1ea0410b3338f2a8f063`
- **Verdict:** **SHIP**
- **Validation:** `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun run wishes:lint` passed (67 files, zero broken
  brainstorm links).
- **Gaps:** No CRITICAL, HIGH, MEDIUM, or LOW gaps.
- **Finding:** The actual problem is blanket validation, not testing itself. The plan preserves targeted evidence,
  forbids zero validation, retains aggregate integration/release gates, and defers automation until repeated
  deterministic misses justify it.

### Plan re-review — 2026-07-28T10:10:33Z

- **Target SHA-256:** `ddc3793965ce3581a22a9f0e2e8410a3f9246df69cc8a1aee92e372ce402def2`
- **Verdict:** **SHIP**
- **Validation:** `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun run wishes:lint` passed (67 files, zero broken
  brainstorm links).
- **Gaps:** No CRITICAL, HIGH, MEDIUM, or LOW gaps.
- **Finding:** The amended criterion consistently distinguishes generated executable/runtime artifacts from
  deterministic documentation/plugin mirrors and preserves the aggregate-gate boundary without adding machinery.

### Group 1 execution review — 2026-07-28

- **Verdict:** **SHIP** after fix loop 1.
- **Validation:** `bun run wishes:lint`, `bun run skills:lint`, `bun scripts/sync-plugin-skills.ts --check`,
  `bun test scripts/sync-plugin-skills.test.ts` (8 pass, 0 fail), and `git diff --check` all passed.
- **Gaps:** None. Manual semantic enforcement is the explicitly accepted simplicity decision; automation remains
  deferred until three concrete misses share a deterministic rule.

### Group 1 quality review — 2026-07-28

- **Initial verdict:** **FIX-FIRST** because “generated artifact” and “shared core” were too broad.
- **Fix loop 1:** Distinguished deterministic documentation/plugin mirrors from generated executable/runtime artifacts
  and narrowed the shared trigger to shared runtime/core behavior.
- **Final verdict:** **SHIP**. No CRITICAL, HIGH, MEDIUM, or LOW gaps remain.

### Scope clarification review — 2026-07-28

- **Verdict:** **SHIP**.
- **Finding:** The control plane is the shipped runtime-neutral `wish`, `work`, and `review` skills plus their plugin
  mirrors. Target repositories retain ownership of their `AGENTS.md`, CI, scripts, and test commands.
- **Gaps:** No CRITICAL, HIGH, MEDIUM, or LOW gaps.

---

## Files to Create/Modify

```
.genie/wishes/proportional-validation-policy/WISH.md
skills/wish/SKILL.md
skills/work/SKILL.md
skills/review/SKILL.md
plugins/genie/skills/wish/SKILL.md
plugins/genie/skills/work/SKILL.md
plugins/genie/skills/review/SKILL.md
```
