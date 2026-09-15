---
name: wish
description: "Turn a settled idea into a reviewed executable wish with scope, criteria, dependency-ordered groups, and validation."
category: lifecycle
mutates: documents
---

# Wish

Plan only. Resume an existing wish; use `brainstorm` when unresolved decisions prevent testable criteria. Write `.genie/wishes/<slug>/WISH.md` from the bundled template. Documents hold the plan and dependency DAG; the selected runtime holds execution state.

## Design preflight

Before creating or changing a linked wish, check `.genie/brainstorms/<slug>/DESIGN.md`:

```bash
node "<wish-skill-dir>/references/design-review-evidence.mjs" verify ".genie/brainstorms/<slug>/DESIGN.md"
```

- Existing design and verification passes: link `[DESIGN.md](../../brainstorms/<slug>/DESIGN.md)` in the Design row.
- Existing design and verification fails: return to independent design review. Missing evidence, a non-SHIP verdict, or a content-digest mismatch cannot be waived. Never repair the failure with a locally recomputed digest.
- No design: use the literal `_No brainstorm — direct wish_` in the Design row, without a broken link. A direct wish is valid when a brainstorm adds no value.

## Scaffold and fill

For a new wish, resolve this loaded skill’s absolute directory, replace the two assignments, and run from the repository root. Existing wishes are edited in place, never overwritten by scaffolding.

<!-- wish-scaffold-command:start -->
```sh
set -eu
WISH_SKILL_DIR='<absolute directory containing this SKILL.md>'
WISH_SLUG='<slug>'
case "$WISH_SLUG" in
  ''|*[!a-z0-9-]*|-*|*-) printf 'invalid wish slug: %s\n' "$WISH_SLUG" >&2; exit 2 ;;
esac
WISH_DEST=".genie/wishes/$WISH_SLUG/WISH.md"
test -f "$WISH_SKILL_DIR/templates/wish-template.md"
test ! -e "$WISH_DEST"
mkdir -p "$(dirname "$WISH_DEST")"
cp "$WISH_SKILL_DIR/templates/wish-template.md" "$WISH_DEST"
```
<!-- wish-scaffold-command:end -->

Fill `{{slug}}`, `{{date}}`, and every TODO. Preserve the template’s machine-consumed structure exactly: the `# Wish:` title, the metadata table rows, and the sections `## Summary`, `## Scope` with `### IN` and `### OUT`, `## Decisions`, `## Simplicity Case`, `## Dependencies`, `## Success Criteria`, `## Execution Strategy`, `## Execution Groups` holding at least one `### Group <n>:` heading, `## QA Criteria`, `## Assumptions / Risks`, `## Review Results`, and `## Files to Create/Modify`. Inside every group keep the `**Goal:**`, `**Deliverables:**`, `**Interfaces:**`, `**Acceptance Criteria:**`, `**Validation:**`, and `**depends-on:**` blocks, and keep the Execution Strategy columns including Complexity and Model. Use portable roles/reasoning effort in the plan; runtime configuration selects actual models.

Pass the simplicity gate: state the smallest complete design, justify added machinery with present requirements or measurements, and keep deferred mechanisms out of execution. Give each group a goal, owned files, deliverables, testable criteria, dependencies, and a non-zero validation command. Explain why validation fits the risk; the repository’s required gate is sufficient rationale. Preserve aggregate integration/release checks. Use `review`’s validation policy for affected runtime, schema, dependency, build, or broad changes.

Declare wish-level `**depends-on:**` and `**blocks:**` under `## Dependencies` (comma-separated slugs or `none`), plus per-group `**depends-on:**`. Keep the hyphenated keys; the DAG is in git, not inferred from task status.

Fill each group's `**Interfaces:**` block with exact signatures: Consumes is what the group takes from earlier groups, Produces is what later groups rely on. A worker sees only its own group, so an unstated signature is re-invented rather than reused. Copy the plan-wide requirements into `**Global constraints:**` verbatim; every group inherits them and review reads them as the attention lens.

A wide refactor is the exception to a self-contained group. When one mechanical change — a renamed field, a retyped shared symbol — breaks call sites across the repository so no single group can land green, sequence expand, migrate, contract: an expand group adds the new form beside the old so nothing breaks; one migrate group per batch sized by blast radius (per package, per directory) each declares `**depends-on:**` the expand group and stays green because the old form still exists; a contract group deletes the old form and declares `**depends-on:**` every migrate batch. When even a batch cannot stay green alone, keep that order but give the batches a shared integration branch and add a final integrate-and-verify group depending on all of them; green is promised only there, and that group carries the aggregate validation.

## Review and handoff

1. Run the project’s wish linter when provided. In the Genie repository:

```bash
grep -q '"wishes:lint"' package.json 2>/dev/null && bun run wishes:lint
```

An unavailable project-specific linter is reported; an available linter failing blocks handoff.
2. Obtain independent `review` of the completed plan. The caller appends its evidence under `## Review Results` and persists APPROVED, FIX-FIRST, or BLOCKED. `work` requires APPROVED on disk.
3. In standalone mode, create missing task rows per group and inspect for duplicates before retrying:

```bash
genie task create --title "<group title>" --wish <slug> --group <group-name>
genie task list --wish <slug>
```

If the CLI/DB is unavailable, report it and keep the document usable without task rows. This fallback cannot bypass an authority refusal.
4. After APPROVED in standalone mode, run `genie context --wish <slug>` to record the wave base SHA. `--plan` is read-only and cannot record it. Report a failure without discarding the approved plan; a later non-plan resolution records the base.

## Orca mode

When explicitly selected, use the same template, design evidence, and plan review. Record the base branch and exact SHA in WISH.md; its existing execution groups supply the worker briefs. Specify portable roles, file ownership, deliverables, criteria, validation, and dependencies without duplicating them in another dispatch table. Shared-file writers require isolation or sequencing.

Genie owns planning documents and evidence; Orca owns operational Run/Task/Dispatch state. Reconcile existing identifiers before creating anything. The coordinator follows `work`'s Orca protocol instead of standalone task/base commands. Existing user authorization satisfies the applicable human checkpoint; do not request it again.
