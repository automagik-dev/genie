---
name: workfly
description: "Discover a procedure and build its saved workflow — dynamic discovery, drafted script, adversarial verification, landed in the catalog."
category: authoring
mutates: repo
---

# Workfly

Use workfly when a procedure worth repeating — a skill, a runbook, a review ritual, a migration sweep — should become a saved workflow that any body runs unmodified. A procedure that needs the user in the middle of the run stays a skill; workfly encodes the part that can run on its own.

Workfly is a saved workflow, not a procedure this skill performs inline. The single source of truth is `.claude/workflows/workfly.js` in the genie repository's canonical workflow catalog (see `.claude/workflows/README.md` there); this skill is its front door. On Claude Code, run the native Workflow tool with the saved name `workfly`, by explicit path when a same-named user-scope copy makes the name ambiguous. The orchestrator — the session model — specifies the objective and relays the result; the script is written by the workflow's own author agent, never drafted inline in the session.

## Invoke

Pass `{objective, sources?, name?, catalogDir?, model?, maxRepairs?, timestamp?}` through args. Sources are repository-relative paths to whatever already describes the procedure — a runbook, a workflow README, or the review skill's own SKILL.md as it sits in this repository. `name` is kebab and the workflow checks it against every name already taken; `catalogDir` defaults to `.claude/workflows` and is the only directory the contract suite covers, so any other value comes back as a recorded coverage gap rather than a pass; `maxRepairs` is the repair budget — 2 when unset and clamped to 3, so a larger value buys nothing; `timestamp` is the provenance stamp for the drafted script's header comment, and the workflow has no clock, so the caller is its only source. Everything else keeps its default.

```text
args: {
  objective: "turn the nightly release-ledger sweep into a saved workflow",
  sources:   ["docs/_internal/release-ledger.md"],
  name:      "ledger-sweep",
  model:     "opus",
  timestamp: "2026-09-15T10:00:00Z"
}
```

## Relay

A run that reached verification returns `{ok, name, path, spec, readmeRow, frontDoor, parityGuard, verification, repairs, notConvened}`. Relay `verification` unchanged: the static result, both refuters with their blocking and advisory findings intact, and `ran`, which names the lenses that answered — `ok` is never true while one of the three is silent. List `notConvened` — it holds exactly one kind of entry, an agent that returned nothing, counted as unverified and never as a pass; every other stop is reported through `error`.

A finding naming any file other than the drafted script — the catalog README row, the fronting skill, the parity test — always arrives as advisory, because those are the landing steps below and the repairer may edit only the script, so `ok: false` always names a defect in the script itself.

Read `ok: false` twice, because two shapes carry it. A run that stopped early returns `{ok: false, error}` and no `verification`: the objective was missing, a required reading did not answer or came back empty (no existing name reported is read as a failed reading, never as "every name is free"), the designer returned nothing or a SPEC with no name or a name that is not a single kebab slug, the author returned nothing, or the name was already taken. When the author returned nothing the error names the target path — check it for a partial write before re-running; every other early stop drafted nothing. Restate the objective, free the name, or re-run. A verified `ok: false` carries every surviving blocking finding in `verification.blocking` — including one the workflow synthesizes when a refuter answered `refuted: true` without naming a defect, so a bare refutation is never silent — and the static gate's own `problems`, which is where a non-default `catalogDir` reports that the contract suite never opened the drafted file. Read them, then decide whether to raise `maxRepairs`, change the objective, or land the fixes by hand.

## Land it

Once `ok` is true and the returned path holds a script:

1. Append `readmeRow` verbatim to the Entries table of `.claude/workflows/README.md`, and check the result: that table names the new script on its own row.
2. Run `bun test scripts/workflows-meta.test.ts` yourself and read its output: the command exits zero and its summary reports `0 fail` before the work is called done. `bun test` names failing cases only, so there is no per-case pass line to look for.
3. When the objective converts an existing skill, rewrite that skill into a thin front door the way the council skill fronts its workflow: it names the script path and the saved name, says what it relays unchanged and what stays with the user, keeps a by-hand fallback for a runtime with no workflow surface, and carries no roster of its own. Add a static parity test that pins that single-source roster, the way the council parity test pins council's.
4. Report what the SPEC left open and every advisory finding nobody fixed. Silence there reads as "nothing was found", which is a different claim.

## Without a workflow surface

Run the same five stages — Discover, Design, Draft, Verify, Repair — as subagents through the runtime's native delegation surface, with the briefs the script carries: three independent readers in parallel (source stages, catalog contract, token economy), one designer that merges the three readings into the SPEC, one author that writes the script file from the SPEC, then the static test and two refuters — semantics against the contract, fidelity against the source stages — both defaulting to refuted when uncertain and naming a blocking finding whenever they refute. Keep Repair bounded, re-verify after each round, and report what did not answer.

## Rules

- A saved name has to be free in both namespaces a runtime resolves from one list. The workflow checks the project catalog (`.claude/workflows`) and the skill namespace (`skills/*`) and returns any collision rather than overwriting anything — but a user-scope `~/.claude/workflows` copy of the same name is outside what it can see, so confirm that scope by hand before landing (a stale user copy shadowed the project `council.js` on 2026-09-15).
- The workflow decides fan-out and per-agent effort; the front door states the objective and the sources, and may pin one model for the whole run. `model` stays a caller key on purpose — one model for the whole run is a front-door decision, per-agent tiers are not — and a front door that starts naming tiers has become a second source of truth.
- Every conversion is one roadmap card, so the rewrite of the source skill and its parity test land together and stay reviewable.
- Token economy is a criterion, not a slogan: a stage whose raw output would flood the orchestrator returns a summary rather than the raw result. That pricing is the economy reader's, and it shapes the SPEC; it is not carried back in the returned object.
- A stage that needs the user mid-run stays in the front door. The refuters look for exactly that stage trapped inside a script, where the user can no longer reach it.
