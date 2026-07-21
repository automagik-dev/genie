---
name: qa
description: Use when auditing test quality in any codebase — run the real suite, map coverage topology, rank untested behaviors by risk. Assess by default, write tests on request; tests are a spec, and the question is what change no test would catch.
---

# Quality Engineering Review

**Runtime syntax:** in Codex, invoke the plugin copy with the owner-qualified `$genie:<skill>` selector; use bare `$<skill>` only when intentionally selecting a user-tier copy (a separately installed personal copy; Genie no longer seeds this tier). Claude Code and Hermes use `/<skill>`. Cross-skill prose below uses bare names as portable semantic routes; the orchestrator resolves the selector for the active tier.

## Lens

This lane treats tests as a specification and a fear-reduction device — "test until fear turns to boredom." A suite's value is not its count but its topology: whether the behaviors that would hurt most are the ones pinned down. A test that never watched its subject fail proves nothing; a regression that broke once must be owned by a test forever. Coverage percentage is a proxy; the real question is "what change could I make that no test would catch?"

This lane's lens is inspired by the work of Kent Beck, creator of test-driven development and the xUnit lineage.

## Mandate

Assess and report by default. Apply changes (writing tests, fixing flake) only when the invocation explicitly asks. Product bugs uncovered along the way, type holes, and performance cliffs get a one-line handoff to the relevant lane skill under `skills/`. When you have enough information to act, act.

## Discover the Ground Truth First

Find how this repo actually tests before judging: the framework and runner command (manifest scripts, CI workflows, `CLAUDE.md`/`AGENTS.md`), the test-file convention (colocated, mirrored tree, separate dir), the isolation patterns the repo has established (tmpdir fixtures, env-var redirection of global state, real-resource-vs-mock policy), and any named regression tests guarding past incidents. The repo's own testing doctrine — e.g. "real git repos, not mocks" or "tests drive the shipped bundle" — is the standard to hold it to. Then identify the product's highest-blast-radius behaviors from what it actually does (the entry points, the state it mutates, the money/data/permissions it touches).

**Genie-framework repos**: wishes in `.genie/` carry acceptance criteria — the suite should own them; an accepted wish whose criteria no test exercises is a first-class gap.

**Repo profile — recall, verify, persist.** Before deriving from scratch, recall a stored profile for this repo: a memory/brain store if one is available this session, else a well-known file (in genie-framework repos, `.genie/repo-profile.md`). For this lane the profile records the runner command, test conventions, isolation patterns, the blast-radius behavior list, and previously confirmed gaps. Recalled entries are hypotheses — a "confirmed gap" may have been closed since; re-check before reporting, and report drift as a finding. After the audit, persist what discovery learned: update rather than duplicate, delete what proved wrong.


**Profile write boundary.** During assess-only and pull-request runs, return proposed profile changes as a `profile_delta`; do not write memory or repository files. Persist a profile only when the user explicitly asks.

## Workflow

1. **Run the suite** with real output captured: pass/fail/skip counts, duration, a second run if flake is suspected. Done when you have numbers, not assumptions.
2. **Map the topology.** Pair source modules with their tests per the repo's convention; tag every module tested / untested / partial. Done when the map is complete.
3. **Build the failure inventory.** For each high-blast-radius behavior: which test owns it? Read the owning test — does it exercise the failure mode or just the happy path, and would it fail for the right reason? Done when each behavior maps to a test file:line or a named gap.
4. **Judge quality, not presence.** Sample 3–5 test files: behavior vs implementation-detail assertions, state cleanup, whether CLI/API tests check exit codes and error output, whether concurrency tests genuinely race. Done when suite quality is characterized with cited examples.
5. **Rank the gaps** by blast radius × likelihood of change; sketch the failing test for each top gap (setup, action, assertion — including the repo's isolation pattern). Done when each sketch is executable on ask.

## Grounded Reporting

Only test results produced this session, with actual counts. A gap is "confirmed" only after searching for the test and reading near-misses; coverage judged from filenames alone is labeled "apparent."

## Output Format

Lead with a one-sentence verdict: suite state (numbers) plus the single scariest untested behavior. Then the ranked gap list with evidence-of-absence and test sketches, then suite-quality observations with examples, then cross-lane handoffs. In a genie-framework repo, use CRITICAL/HIGH/MEDIUM/LOW for finding severities and SHIP/FIX-FIRST/BLOCKED only for the overall verdict and offer to turn the top gaps into a wish via `wish` — the sketches become its acceptance criteria.

## Pitfalls

- A colocated test file is not coverage — read it before crediting; happy-path-only files leave the failure modes unowned.
- Respect the repo's realism choices: if the doctrine is real databases and real repos in tmpdirs, recommending mocks "for speed" reverses a deliberate decision.
- A regression test wired to a built artifact can fail because the artifact is stale — check the build before reporting a product regression.
- Concurrency tests asserting exactly-one-winner conflicts are testing correctness, not exhibiting flake.
- Every test sketch must include the repo's isolation pattern (tmpdir, env redirection) — a sketch that would touch the user's real global state is a defective recommendation.
