---
name: genie-orca-review
description: "Independent, read-only review of a group, a wish, or a PR on Orca — SHIP / FIX-FIRST / BLOCKED with severity-tagged findings. Council and retro are this skill with a different input."
---

# genie-orca:review

**Runtime syntax:** invoke the plugin copy through the active runtime's owner-qualified skill selector; use a bare selector only when intentionally selecting a user-tier copy (a separately installed personal copy; Genie no longer seeds this tier). Cross-skill prose below uses bare names as portable semantic routes; the orchestrator resolves the selector for the active runtime.

A reviewer is a **read-only worker dispatched by the coordinator**, never the engineer of the same group, preferably a different model family (brain default: Codex reviews Claude-Sonnet work; Fable/Opus for the two gate reviews).

## Contract

- Input: the group spec (`WISH.md` section), ground truth (`SCOUT.md`), `git diff <wish-branch>..HEAD`, the validation command.
- The reviewer **re-runs validation** and quotes the summary line. A review that did not run the gate is not a review.
- Body starts with `VERDICT: SHIP | FIX-FIRST | BLOCKED`, then numbered findings `[critical|major|minor]` with `file:line` and a concrete fix. FIX-FIRST only on critical/major.
- One `worker_done`, `--outcome succeeded` = review delivered (the verdict is in the body). The reviewer's `worker_done` never authorizes coordinator edits; fixes are re-dispatched.
- Name the *environments* in the adversarial question: the dev box with the product installed, the compiled binary from cwd `/` with no env, a DSN/detached service, the vault literally named like the product. On brain, the same precedence bug survived four gates because each ran in one environment.
- Ask the adversarial question explicitly in the brief ("how does this still fail in the compiled binary / under DSN / on a box with brain installed?"). On brain, 3 of 5 groups went FIX-FIRST from exactly that prompt.

## Tiers

| When | Reviewers | Merge rule |
|---|---|---|
| per group | 1 capable model (≠ engineer) | verdict as-is |
| wish-approval, PR | 3 in parallel (claude / codex / third), same read-only worktree | severity-max; any BLOCKED → BLOCKED; SHIP only if all SHIP; one merged Linear comment |
| council | lenses (questioner / architecture / simplifier / perf …) on a decision | synthesis + unresolved tensions, persisted next to the wish |
| retro | the run's `RETRO.md` from `skills/genie-orca-work/scripts/retro-collect.ts` | findings → skill edits, not prose |

## Fix loop

Coordinator re-dispatches a **fast** worker into the same worktree with the findings quoted verbatim and "apply exactly this, nothing else". Cap 2 loops per group; the coordinator may verify a trivial delta itself instead of a second review. After the cap → human gate.

## What the integrated gate catches that group review does not

Run the **full** suite on the integrated branch before declaring SHIP — on brain, G4's artifact fallback passed its group gate and its review, and only the integrated gate (a box with `~/.brain` installed) exposed the cwd hijack. Per-group validation is necessary, not sufficient.
