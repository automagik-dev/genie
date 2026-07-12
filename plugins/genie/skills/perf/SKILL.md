---
name: perf
description: Use when auditing performance in any codebase — cold starts, hot paths, dependency weight, storage query patterns. Assess by default, optimize on request; measure, don't guess, and every number carries the command that produced it.
---

# Performance Review

**Runtime syntax:** in Codex, invoke the plugin copy with the owner-qualified `$genie:<skill>` selector; use bare `$<skill>` only when intentionally selecting a user-tier copy (CLI-managed fallback or separately installed personal skill). Claude Code and Hermes use `/<skill>`. Cross-skill prose below uses bare names as portable semantic routes; the orchestrator resolves the selector for the active tier.

## Lens

This lane begins performance work with measurement of the running system, never with intuition about the code. Every claim carries the command that produced it and the number it produced. The USE method frames each resource — utilization, saturation, errors. The most expensive performance bug is the one "fixed" without measuring before and after.

This lane's lens is inspired by the work of Brendan Gregg — author of *Systems Performance*, inventor of flame graphs and the USE method.

## Mandate

Assess and report by default. Apply optimizations only when the invocation explicitly asks — and then only with a before/after measurement pair. Never report an estimate where a measurement is obtainable this session. Findings outside this lane get a one-line handoff to the relevant lane skill under `skills/`. When you have enough numbers to conclude, conclude.

## Discover the Ground Truth First

Before measuring anything, establish what the product *is* and which latency its users actually feel: a CLI pays cold start per invocation (and per hook event, if it's invoked by hooks — the hook timeout is then the hard ceiling); a server pays per-request latency and saturation; a batch tool pays throughput. Read the entry points, the build config (bundling, minification, what's inlined), the manifest for dependency weight, and `CLAUDE.md`/`AGENTS.md` for stated performance constraints and deliberate tradeoffs (fork-per-event models, zero-daemon rules, chosen storage engines). Identify the shipped artifact users run — measure that, not the dev-mode path. Never carry numbers forward from documentation; a documented size or timing is a claim to re-measure.

**Repo profile — recall, verify, persist.** Before deriving from scratch, recall a stored profile for this repo: a memory/brain store if one is available this session, else a well-known file (in genie-framework repos, `.genie/repo-profile.md`). For this lane the profile records the headline paths, hard ceilings, and baseline numbers with the commands that produced them. Baselines are the one profile entry you never trust — re-measure the headline path every run and report the delta against the stored baseline; that delta is often the most valuable finding. After the audit, persist the new numbers: update rather than duplicate, delete what proved wrong.


**Profile write boundary.** During assess-only and pull-request runs, return proposed profile changes as a `profile_delta`; do not write memory or repository files. Persist a profile only when the user explicitly asks.

## Workflow

1. **Measure the headline path.** Time the user-felt path on the shipped artifact — `hyperfine` or a 10+-run loop; report median and spread, with first-run (cold cache) noted separately. Compare against any hard ceiling discovery found (hook timeouts, SLOs). Done when you have medians with exact commands.
2. **Profile startup/dispatch weight.** Identify what executes before useful work begins (eager imports, top-level side effects, artifact parse cost); check whether heavy dependencies load eagerly on paths that don't need them. Done when pre-work cost is characterized with evidence.
3. **Weigh the artifact and dependencies.** Measure the shipped size; attribute weight where feasible. Done when you know — from step 1's numbers, not assumption — whether size materially drives the headline path.
4. **Read the storage patterns.** Review hot-path queries and schema: per-row queries in loops, missing indexes vs actual WHERE/ORDER BY clauses, missing transactions around multi-statement writes, recomputation that grows with data size. Where a suspicion is testable, seed a throwaway store in an isolated tmpdir and time it. Done when each smell is confirmed with a citation (and a number where obtainable) or dismissed.
5. **Rank by user-felt impact** — frequency × cost: a path paid on every invocation outranks a slow rarely-used command. Done when the report is ordered by that product.

## Grounded Reporting

Every number was produced by a command this session and is quoted with that command; anything else is either inferred (calculation shown) or explicitly unmeasured (with the command that would measure it).

## Output Format

Lead with a one-sentence verdict anchored on the headline number vs its ceiling. Then findings ranked by user-felt impact, each with the measurement, the mechanism in plain language, and a recommended change whose expected effect is stated testably. Close with what was not measured and how to measure it. In a genie-framework repo, use CRITICAL/HIGH/MEDIUM/LOW for finding severities and SHIP/FIX-FIRST/BLOCKED only for the overall verdict; optimization campaigns bigger than one change belong in a wish via `wish` with the baseline numbers as its acceptance criteria.

## Pitfalls

- Measure what users execute (the installed binary, the built bundle, the deployed server), never the dev-mode or source-interpreted path.
- First-run timings include OS cache warming — report the median of many runs and the first-run outlier separately; the outlier is often the realistic cold-start story.
- Retry/conflict patterns that implement correctness (claim conflicts, optimistic-lock retries) are design, not contention to optimize away — distinguish them from genuine saturation before flagging.
- Reversing an architectural constraint (adding a daemon to a zero-daemon design, adding a cache layer the docs forbid) is a cross-lane architecture proposal — hand it off with your numbers attached; the numbers are your contribution, the decision is not yours.
- Check the build config before recommending "enable minification/optimization" — partial minification or debug symbols are often deliberate.
