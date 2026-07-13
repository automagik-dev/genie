---
name: dx-docs
description: Use when auditing DX, docs, and delivery in any codebase — the 30-minute-contributor test, docs-vs-reality drift, onboarding friction, error-message quality. Assess by default, fix docs on request; docs are judged by use, and every failure is a misfiled or missing Diátaxis quadrant.
---

# DX, Docs & Delivery Review

**Runtime syntax:** in Codex, invoke the plugin copy with the owner-qualified `$genie:<skill>` selector; use bare `$<skill>` only when intentionally selecting a user-tier copy (a separately installed personal copy; Genie no longer seeds this tier). Claude Code and Hermes use `/<skill>`. Cross-skill prose below uses bare names as portable semantic routes; the orchestrator resolves the selector for the active tier.

## Lens

This lane treats documentation as four different things — tutorials (learning-oriented), how-to guides (task-oriented), reference (information-oriented), explanation (understanding-oriented) — and nearly every documentation failure is one quadrant's content misfiled in another, or a quadrant missing entirely. Documentation is judged by use, not by existence: a doc that cannot be followed is worse than no doc, because it costs trust. Developer experience is documentation's runtime — error messages, help text, and onboarding friction are docs delivered at the moment of need.

This lane's lens is inspired by the work of Daniele Procida, creator of the Diátaxis framework.

## Mandate

Assess and report by default. Apply doc fixes only when the invocation explicitly asks — and only through the repo's documented docs workflow if it has one (submodules, docs repos, review gates). Findings outside this lane get a one-line handoff to the relevant lane skill under `skills/`. Judgments come from *using* the docs and the product, never from reading them approvingly.

## Discover the Ground Truth First

Map the docs estate before judging it: where docs live (in-repo, submodule, separate site), which are public vs internal, what the contribution/onboarding path claims to be (README, CONTRIBUTING, `CLAUDE.md`/`AGENTS.md`), and what the product's real interface is — for a CLI, the live `--help` output of every command; for an API, the actual routes/signatures; for a library, the exported surface. The live interface is the truth; every doc, README table, and agent-context file is a claim to diff against it. Note the repo's stated DX bar (e.g. a 30-minute-contributor promise) — hold it to its own standard.

**Genie-framework repos**: the lifecycle skills (brainstorm → wish → work → review, plus their kin) are part of the user-facing surface. Their SKILL.md descriptions, inputs, and outputs must chain coherently — does `wish` consume what `brainstorm` produces, does `review` validate what `work` emits — and match what the docs claim about them.

**Repo profile — recall, verify, persist.** Before deriving from scratch, recall a stored profile for this repo: a memory/brain store if one is available this session, else a well-known file (in genie-framework repos, `.genie/repo-profile.md`). For this lane the profile records the docs topology, the live-interface inventory, past stumble logs, and open drift findings. Recalled drift may have been fixed since — re-check each entry against the live interface before reporting, and report new drift as a finding. After the audit, persist what discovery learned: update rather than duplicate, delete what proved wrong.


**Profile write boundary.** During assess-only and pull-request runs, return proposed profile changes as a `profile_delta`; do not write memory or repository files. Persist a profile only when the user explicitly asks.

## Workflow

1. **Run the contributor test.** Follow the written onboarding path verbatim — clone/install through the first passing check — with no insider shortcuts, logging every divergence between docs and reality with a timestamp. Done when you have a stumble log and a pass/fail against the repo's stated (or a 30-minute default) bar.
2. **Diff docs against the live interface.** Enumerate the real commands/routes/exports; diff names, flags, and described behavior against every doc that mentions them. Done when each drift instance quotes both sides.
3. **Diátaxis-classify the docs tree.** Assign each page a quadrant; flag misfiled content (reference dumps inside how-tos, explanation blocking a tutorial path) and name missing quadrants (is there any true tutorial?). Check audience leakage across public/internal boundaries. Done when the tree has a quadrant map with gaps named.
4. **Trace the workflow chain** (in genie-framework repos: the lifecycle skills; elsewhere: the documented contributor workflow). Verify each handoff's stated inputs/outputs against actual behavior. Done when each link is confirmed coherent or flagged with mismatched quotes.
5. **Sample error messages.** Run 4–6 realistic failure invocations; record exit code, stderr, and text; grade each on what failed / why / what to do next. Done when each sample has a grade and quote.
6. **Rank**: onboarding blockers first (they cost every new contributor), then drift (it costs trust), then misfiling, then message polish.

## Grounded Reporting

Every drift claim quotes both sides; every stumble names the exact step and what actually happened; skipped steps (e.g. no fresh clone was feasible) are stated, with affected conclusions marked partial.

## Output Format

Lead with a one-sentence verdict: did the repo pass its contributor test, and what is the worst drift. Then findings ranked as above with evidence and concrete fixes — routed through the repo's docs workflow where one exists. Include what works well; a review that only lists friction misleads. In a genie-framework repo, use CRITICAL/HIGH/MEDIUM/LOW for finding severities and SHIP/FIX-FIRST/BLOCKED only for the overall verdict and offer to crystallize a docs-overhaul into a wish via `wish`.

## Pitfalls

- Never evaluate docs by reading them — a page can read beautifully and be unfollowable; every "docs are good" claim must trace to a followed procedure.
- Internal-only docs deliberately excluded from a public site are design, not gaps — check the exclusion mechanism before reporting "missing" pages.
- If docs live in a submodule or separate repo, a fix recommendation that says "edit and commit here" strands changes — name the real workflow in the fix.
- Agent-context files (CLAUDE.md and kin) drifting from the product is real drift, but its fix lands in this repo, not the docs pipeline — route the two drift classes separately.
- Terse is not bad: an error message answering what/why/next in one line beats a paragraph. Grade on the three questions, not on length.
