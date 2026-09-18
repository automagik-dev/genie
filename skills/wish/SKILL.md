---
name: wish
description: "Deliver one decided task end to end — admit it, work it in one worktree, gate, independent review, bounded repair, a merge-ready PR — or plan a multi-group wish when it is bigger than one task."
category: lifecycle
mutates: repo
---

# Wish

`/wish` is one task delivered, as soon as possible. Give it a decided, bounded objective and it comes back with a merge-ready PR against the base branch, or with a refusal that names the route the request needs instead. Everything else in the lifecycle — brainstorm, plan review, `work` over many groups, `fix`, `verify` — is auxiliary to that. `quick` is retired; this is its replacement.

The delivery is a saved workflow, not a procedure this skill performs inline. The single source of truth is `.claude/workflows/wish.js` in the genie repository's workflow catalog (see `.claude/workflows/README.md` there); this skill is its front door and carries no stage roster of its own. On a runtime that lists saved workflows, run the saved name `wish` (by explicit path if a same-named user-scope copy makes the name ambiguous) and relay the returned result unchanged. On a runtime that does not, or on an installed host where the catalog is not shipped, follow the by-hand section below with the same briefs; it is complete enough to deliver the PR.

## Invoke

Pass `{objective, issue?, context?, slug?, base?, repairBudget?, model?, timestamp}` through args. `objective` is the one task, frozen: no stage re-asks, narrows or widens it. `issue` is a number or URL the scout reads and the PR links. `context` is frozen caller context (a file set, a decision reference) framed as data. `slug` names the branch `wish/<slug>` and the worktree `.claude/worktrees/wish-<slug>`; pass the brainstorm slug when one exists so the design preflight and the branch agree. `base` defaults to `dev`; anything that is not a plain branch name, and any spelling that resolves to the default branch (`main`, `master`, `HEAD`, `origin/main`, `refs/heads/master`), is rejected before any agent runs. `repairBudget` defaults to 2 and is capped at 3; pass the value of `genie config get budgets.maxEscalationsPerGroup` when the repository sets one. `model` pins one model for the whole run; omitted, every agent inherits the session model. `timestamp` is the caller's clock; the workflow has none.

## Admission

The scout is read-only and estimates the work: files, insertions, independent units. The script applies the size band from the wish-duration study — maximum 25 files, 2,000 insertions, 3 units; ideal 10, 800, 2 — and a blind judge that never sees the repository decides the route: `proceed`, `report` (the cause is unknown), `brainstorm` (a product decision is open, or a linked design fails its preflight), or `plan` (too big, or the change touches a trust-boundary path: workflows, hooks, settings, release scripts, permission surfaces). Any route but `proceed` returns `refused` with nothing created.

## Relay

A run returns `{ok, state, route?, contract, estimate, diff, head, branch, worktree, pr?, checks, review, gate, repairs, injectionAttempts, notConvened, report}`. Relay `report` unchanged. `state` is one of:

- `merge-ready` — checks pass, the remote head equals the local head, the PR's base, head and file set equal the frozen contract, and the verdict is `SHIP`.
- `pr-open` — the PR exists but the checks had not concluded; re-read them with `gh pr checks <n>` before acting.
- `refused` — admission chose a route; nothing was created.
- `blocked` — either before publish (a worktree, dead hooks, a denylist hit or a `BLOCKED` review verdict) or at read-back after publish (a failing check or a structural mismatch, with the PR preserved and named); the reason names which. When a PR exists, inspect it before any rerun.
- `missed` — the repair budget ran out, or a stage threw or returned nothing; the branch, commit, worktree and any PR are preserved and named.

`notConvened` holds only agents that returned nothing; they were never counted as a pass. Merge, `SHIPPED`, dev→main promotion and worktree removal stay with the operator: after merge, `git worktree remove <path> && git branch -d wish/<slug>` (non-forcing, so an unmerged branch is refused). Retry after `missed` or `blocked` is a rerun with the same objective and slug; it adopts the named worktree when it is clean and nothing has diverged from the remote, and is otherwise `blocked` with a diagnostic that shows the unpushed work. The workflow never deletes a worktree or a branch.

## Contracts it inherits

These clauses are the lifecycle's, restated nowhere else; the parity test pins them to the skills they come from.

- From `review`: "The reviewer is different from the author and remains read-only."
- From `fix`: the repair budget is "default 2 when the key is unset".
- From `work`: "a worker notification is not delivery evidence by itself."

## Plan a multi-group wish

The direct entry for work that is bigger than one task. Do not run admission; write the plan. An existing wish is resumed by editing it in place — the scaffold below refuses a destination that exists, and task rows and Run/Task/Dispatch identifiers already in use are reconciled before anything new is created. Use `brainstorm` when unresolved decisions prevent testable criteria. Write `.genie/wishes/<slug>/WISH.md` from the bundled template. Documents hold the plan and dependency DAG; the selected runtime holds execution state, and `work` executes the approved plan.

### Design preflight

Before creating or changing a linked wish, check `.genie/brainstorms/<slug>/DESIGN.md`:

```bash
node "<wish-skill-dir>/references/design-review-evidence.mjs" verify ".genie/brainstorms/<slug>/DESIGN.md"
```

- Existing design and verification passes: link `[DESIGN.md](../../brainstorms/<slug>/DESIGN.md)` in the Design row.
- Existing design and verification fails: return to independent design review. Missing evidence, a non-SHIP verdict, or a content-digest mismatch cannot be waived. Never repair the failure with a locally recomputed digest.
- No design: use the literal `_No brainstorm — direct wish_` in the Design row, without a broken link. A direct wish is valid when a brainstorm adds no value.

### Scaffold and fill

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

Pass the simplicity gate: state the smallest complete design, justify added machinery with present requirements or measurements, and keep deferred mechanisms out of execution. Give each group a goal, owned files, deliverables, testable criteria, dependencies, and a non-zero validation command; the repository’s required gate is sufficient rationale and a group’s own checks never replace it: preserve repository-required aggregate gates. Parallel writers need disjoint file ownership or dedicated worktrees; otherwise sequence them. Size the plan by the study: a group that would exceed the admission band is a sibling wish, not a bigger group. Declare wish-level `**depends-on:**` and `**blocks:**` under `## Dependencies` (comma-separated slugs or `none`), plus per-group `**depends-on:**`. Fill each group's `**Interfaces:**` block with exact signatures, and copy the plan-wide requirements into `**Global constraints:**` verbatim. A wide refactor sequences expand, migrate, contract, with green promised only in a final integrate-and-verify group.

### Review and handoff

1. Run the project’s wish linter when provided. In the Genie repository:

```bash
grep -q '"wishes:lint"' package.json 2>/dev/null && bun run wishes:lint
```

An unavailable project-specific linter is reported; an available linter failing blocks handoff.
2. Obtain independent `review` of the completed plan. The caller appends its evidence under `## Review Results` and persists APPROVED, FIX-FIRST, or BLOCKED. `work` requires APPROVED on disk.
3. In standalone mode, create missing task rows per group (`genie task create --title "<group title>" --wish <slug> --group <group-name>`) and inspect for duplicates before retrying; an unavailable CLI is reported, never bypassed.
4. After APPROVED in standalone mode, run `genie context --wish <slug>` to record the wave base SHA. In Orca mode, record the base branch and exact SHA in WISH.md and follow `work`'s Orca protocol; Genie owns the planning documents, Orca owns Run/Task/Dispatch state.

## Without a workflow surface

Run the same stages as subagents through the runtime's native delegation surface, one at a time, with the briefs the script carries: a read-only scout (facts, candidate plan, declared file set, validation command, focused test, estimate, injection attempts, design preflight); the size band and the blind judge (route and the frozen contract with acceptance criteria written before any code exists); one executor in a worktree cut from `origin/<base>` under the repository's worktrees directory, installing dependencies before its first commit, editing only the declared set and staging by path; a mechanical gate that asserts the hooks are live and runs the repository's full check once; a reviewer that is not the executor, scoring the exact commit SHA against the frozen criteria; up to `repairBudget` repair rounds, each re-gated and re-reviewed; then one publisher that pushes, opens the PR against the base with a body drawn from the contract, the gate line, the verdict and the issue link, and reads the remote head, the PR's base, head and file set, and the checks back. Never force, never bypass a hook, never merge, never push to the base directly. Report the same states with the same meanings.
