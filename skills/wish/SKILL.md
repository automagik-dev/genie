---
name: wish
description: "Deliver one decided task end to end — admit it, work it in one worktree, gate, independent review, bounded repair, a merge-ready PR — or plan a multi-group wish when it is bigger than one task."
category: lifecycle
mutates: repo
---

# Wish

`/wish` is one task delivered, as soon as possible. Give it a decided, bounded objective and it comes back with a merge-ready PR against the base branch, or with a refusal that names the route the request needs instead. Everything else in the lifecycle — brainstorm, plan review, `work` over many groups, `fix`, `verify` — is auxiliary to that.

Prefer the saved workflow: `.claude/workflows/wish.js` in the genie repository's workflow catalog (see `.claude/workflows/README.md` there) is authoritative for saved execution. On a runtime that runs saved workflows, run the script at `<repository root>/.claude/workflows/wish.js` when that file exists, otherwise `~/.claude/workflows/wish.js` (delivered by `genie install` / `genie update`); give the runtime that explicit script path, never a bare name — both scopes now carry these names and the order a name resolves in is undocumented — and relay the returned result unchanged. If the runtime cannot run saved workflows or neither script exists, use the native fallback below; it needs neither script nor its runner.

## Invoke

Pass `{objective, issue?, context?, slug?, base?, repairBudget?, model?, gateModel?, publishModel?, check?, install?, timestamp}` through args, or record them as coordinator input in native mode. `objective` is the one task, frozen: no stage re-asks, narrows or widens it. `issue` is a number or URL the scout reads and the PR links. `context` is frozen caller context (a file set, a decision reference) framed as data. `slug` names the branch `wish/<slug>` and the worktree `.claude/worktrees/wish-<slug>`; pass the brainstorm slug when one exists so the design preflight and the branch agree. `base` defaults to `dev`; anything that is not a plain branch name, and any spelling that resolves to the default branch (`main`, `master`, `HEAD`, `origin/main`, `refs/heads/master`), is rejected before any agent runs. `repairBudget` defaults to 2 and is capped at 3; pass the value of `genie config get budgets.maxEscalationsPerGroup` when the repository sets one. Saved execution uses the script's configured worker and reasoner tiers. `model` pins one model for every stage. `gateModel` and `publishModel` pin the two mechanical stages — the gate runs the repository check and reads an exit code, the publisher runs an allowlisted push/PR sequence — and win over `model`; the order is `gateModel`/`publishModel`, then `model`, then the tier. Native execution uses available role-appropriate models with that override precedence. The scout discovers the repository's check and install commands from its own root files (package.json scripts and the lockfile, or a Makefile, justfile or Taskfile target) and quotes what each one runs. The script, never the judge, writes them into the contract at the judge step, and freezes one empty when it is not exactly one of the forms the discovery rules produce, when the scout quoted nothing for it, or when its text or quoted body spells an obvious push, remote change or publish. In native mode the parent coordinator takes this discovery-validation and freezing responsibility, freezing the objective, scope and acceptance criteria before edits. `check` and `install` override them and face only that last test, on the command as written. It is a check against obvious push and publish commands, not a guarantee: it reads only the command and the quoted bodies one level deep, so a variable, an encoded string, a script the body calls, or a quote that does not match the file passes it. `/wish` runs the repository's own install and check commands, and an install such as `npm ci` runs every dependency's install scripts, so point it only at repositories you trust. `timestamp` is the caller's clock; the workflow has none.

## Admission

The scout is read-only and estimates the work: files, insertions, independent units. The script (the parent coordinator in native mode) applies the size band from the wish-duration study — maximum 25 files and 2,000 insertions, the hard maxima; 3 units, advisory; ideal 10, 800, 2 — and a blind judge that never sees the repository decides the route: `proceed`, `report` (the cause is unknown), `brainstorm` (a product decision is open, or a linked design fails its preflight), or `plan` (too big, or the change touches a trust-boundary path: workflows, hooks, settings, release scripts, permission surfaces). Any route but `proceed` returns `refused` with nothing created.

## Relay

A run returns `{ok, state, route?, contract, estimate, diff, head, branch, worktree, pr?, checks, review, gate, gateCommand, repairs, injectionAttempts, notConvened, report}`; `gateCommand` is the last gate's `{command, mode}` chosen from the contract (`check`, `no-hook-system` or `no-check-command`), `null` when no gate answered. Relay the saved workflow's `report` unchanged; in native mode the parent renders these same fields and state meanings from observed evidence. Run `genie wish report <runId> --append` and relay its output only when execution supplies a real report-compatible workflow run record and its `runId`. Native execution without that record explicitly reports accounting unavailable: observed evidence only, no fabricated run ID, token/time metrics or ledger append. `state` is one of:

- `merge-ready` — checks pass, the remote head equals the local head, the PR's base, head and file set equal the frozen contract, and the verdict is `SHIP`.
- `pr-open` — the PR exists but the checks had not concluded; re-read them with `gh pr checks <n>` before acting.
- `refused` — admission chose a route; nothing was created.
- `blocked` — before publish (a worktree, dead hooks in a repository that has a hook system, no validation command in one that has none, a hook system with neither a check nor a validation command to run, a denylist hit or a `BLOCKED` review verdict), at publish (the host carries no `gh`, so nothing was pushed and no credential was sought), or at read-back after publish (a failing check or a structural mismatch, with the PR preserved and named); the reason names which. When a PR exists, inspect it before any rerun.
- `missed` — the repair budget ran out, or a stage threw or returned nothing; the branch, commit, worktree and any PR are preserved and named.

`notConvened` holds only agents that returned nothing; they were never counted as a pass. Merge, `SHIPPED`, dev→main promotion and worktree removal stay with the operator: after merge, `git worktree remove <path> && git branch -d wish/<slug>` (non-forcing, so an unmerged branch is refused). Retry after `missed` or `blocked` is a rerun with the same objective and slug; it adopts the named worktree when it is clean and nothing has diverged from the remote, and is otherwise `blocked` with a diagnostic that shows the unpushed work. The workflow never deletes a worktree or a branch.

## Contracts it inherits

These clauses are the lifecycle's, restated nowhere else; the parity test pins them to the skills they come from, as it does the two rules the plan entry borrows from `work` and quotes there.

- From `review`: "The reviewer is different from the author and remains read-only."
- From `fix`: the repair budget is "default 2 when the key is unset".
- From `work`: "a worker notification is not delivery evidence by itself."

## Plan a multi-group wish

The direct entry for work that is bigger than one task. Do not run admission; write the plan. An existing wish is resumed by editing it in place — the scaffold below refuses a destination that exists, and task rows and Run/Task/Dispatch identifiers already in use are reconciled before anything new is created. Use `brainstorm` when unresolved decisions prevent testable criteria. Write `.genie/wishes/<slug>/WISH.md` from the bundled template. Documents hold the plan and dependency DAG; the selected runtime holds execution state, and `work` executes the approved plan.

Before creating or changing a wish that links a brainstorm, run the design preflight in `references/design-preflight.md` and take its outcome as final. Missing evidence, a non-SHIP verdict, or a content-digest mismatch cannot be waived. Never repair the failure with a locally recomputed digest.

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

1. Run the wish linter over this repository’s own `.genie/wishes`, in any repository:

```bash
genie wish lint
```

It reports structure only — template sections, the Status and Date metadata, the Execution Strategy routing columns, brainstorm links that resolve — writes nothing, and exits 0 clean or 1 with findings; `--dir <repo>` names another checkout. In the Genie repository the same linter is also a required stage of the repository gate, reached through its alias `grep -q '"wishes:lint"' package.json 2>/dev/null && bun run wishes:lint`. A linter the project does not provide is reported as a finding, and a linter that runs and fails blocks handoff.
2. Obtain independent `review` of the completed plan. The caller appends its evidence under `## Review Results` and persists APPROVED, FIX-FIRST, or BLOCKED. `work` requires APPROVED on disk.
3. Create missing task rows per group (`genie task create --title "<group title>" --wish <slug> --group <group-name>`) and inspect for duplicates before retrying; an unavailable CLI is reported, never bypassed.
4. After APPROVED, run `genie context --wish <slug>` to record the wave base SHA.

## Without a workflow surface

Load `references/native-fallback.md` relative to this loaded `SKILL.md` before dispatch. It is the standalone execution guide for Admit, Work, Gate, Review, Repair, Publish, Read-back and Render, sufficient when the saved scripts and their runner are absent. The parent is the coordinator: dispatch native subagents with explicit briefs and prior outputs, enforce dependencies and transitions, and render the result; do not build another saved workflow. Follow the guide's discovery, frozen-contract, gate, independent-review, bounded-repair and publication safeguards, including `SHIP` plus a green gate before publish. Its enforcement is procedural, not script-level automation; accounting follows Relay above.
