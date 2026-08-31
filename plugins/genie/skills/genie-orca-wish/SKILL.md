---
name: genie-orca-wish
description: "Turn a brainstorm/design into an APPROVED-able wish whose Dispatch plan is the literal input to Orca tasks and Linear issues. High-reasoning pass: pre-decide everything so fast workers can execute without judgment calls."
---

# genie-orca:wish

**Runtime syntax:** invoke the plugin copy through the active runtime's owner-qualified skill selector; use a bare selector only when intentionally selecting a user-tier copy (a separately installed personal copy; Genie no longer seeds this tier). Cross-skill prose below uses bare names as portable semantic routes; the orchestrator resolves the selector for the active runtime.

The wish is the only durable genie artifact and the instruction source for every worker. Write it with the most capable model you have; everything downstream gets cheaper because of it.

## Before writing

1. **Scout first, opine second.** Dispatch a read-only scout for exact `file:line`, mechanisms, existing tests and the concrete fix per defect/feature. Commit it as `SCOUT.md` next to the wish — workers and reviewers read it, and it pins line numbers to a SHA.
2. Read the repo rules (`.claude/rules/*`, CLAUDE.md) and the council/design that produced this wish.
3. Read the delegation preferences from brain (`brain_profile_get` tier slots) — freeze them into the Dispatch plan; workers never consult brain.

## Required shape

Header table: `Status | Slug | Priority | Base (branch @ sha, gate state) | Target (PR → branch) | Ground truth (SCOUT.md) | Orchestration (Orca/Linear ids once created) | Approval`.

Sections (the v5 validator still enforces these names): Summary · Scope (IN/OUT) · Problem (table: # / defect / symptom) · Decisions · Simplicity Case · Dependencies · Non-goals · Success Criteria · Execution Strategy (waves) · Execution Groups · Files to Create/Modify · QA Criteria · Assumptions / Risks · Review Results · **Dispatch plan** · Status log.

Per group (`### Group n: Gn — title`): **Files** (exact paths, the worker touches nothing else) · **Do** (imperative, decided — no "consider") · **Accept** (a command and an observable, never "works").

Dispatch plan table — the literal argument list:

| id | depends_on | agent | model | effort | worktree | validation_cmd |
|---|---|---|---|---|---|---|

plus `Gates: wish-approval, [dogfood], merge` and the worker contract line (own worktree, conventional commits, one `worker_done` with `--outcome`).

## Rules learned on brain (2026-08-22)

- Groups must have **disjoint files**; if two groups touch one file, say "disjoint hunks" explicitly and let the integrator own the merge.
- Always have an **integrator group** that depends on all others: full gate + build + tripwires + docs, run from the main worktree.
- Validation commands must run inside an Orca child worktree: no `bun run build` there if the repo resolves ROOT via `import.meta.url` (Orca's `~` path bug) — say "coordinator builds from a clean path".
- Name test files that exist (a worker lost time on `ask-pipeline.test.ts` that was really `ask-pipeline-env.test.ts`). The scout should list them.
- Every fix ships with a tripwire that exercises the **shipped artifact**, not just `src/`; say which tier (static string / extracted-artifact run / live backend).
- Leave an escape hatch per risky group ("if X is not possible from the SDK surface, do Y honestly") — G3 needed it.

## Gate

`wish-approval` is a human gate: the human opens the reviewed wish and approves. Under `/goal`-style pre-approval, record that in the header (`Approval: … pre-approved <date>`) and proceed.
