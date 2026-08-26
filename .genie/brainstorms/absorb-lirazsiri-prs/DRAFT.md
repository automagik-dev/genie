# Brainstorm — absorb-lirazsiri-prs

**Status:** Ready (crystallized → DESIGN.md) · **WRS:** 100/100
**Dispositions (Felipe, 2026-08-07):** A1 absorb · B1/B2/B3 absorb · B4 decline · B5 dropped · B6 defer · B7 reject
**Date:** 2026-08-07
**Context:** lirazsiri has two open PRs. #2737 `feat(db-sync)` (+13,679/−40) was reviewed 2026-08-07 → **BLOCKED** (2 CRITICAL, 9 HIGH; premise conflicts with canonical roadmap.json/`task sync` channel; built 104 commits behind main). #2738 `feat(skills): configurable fix-loop budgets` (+39/−26, base `dev`) is small and coherent. Decision made by Felipe: **close both PRs** with a respectful note; absorb approved portions through our own lifecycle with credit.

## Problem

Two community PRs will be closed, but they contain genuinely valuable fragments (verified bug fix, test-determinism/infra fixes, one small well-formed feature) that we want to absorb deliberately — with credit — instead of losing them or merging unreviewable bulk.

## Goodies inventory (candidate absorptions)

### From #2738 — fix-loop budget (whole-PR candidate)
- **A1. Resolved fix-loop budget `B`** (default 2; explicit higher-priority user/workspace instruction may override; override never expands scope, permits unchanged retries, or skips diagnosis/re-review). Touches skills/{fix,review,work,pm,dream}, lifecycle.md, plugin mirrors, release-docs test. Needs re-authoring on current dev (skills drifted since 2026-07-30) + mirror parity regen.
- Recommendation: **absorb** (cheap, no durable machinery, useful for dream/overnight runs). Alternative honest option: this PR alone could merge after rebase — Felipe chose close+absorb.

### From #2737 — fragments only (core is rejected per BLOCKED review)
- **B1. `hireAgent` race fix** — `getHire(...) as HireRosterRow` after write, non-null cast; concurrent `unhireAgent` ⇒ null typed as row. **Confirmed on current main** `src/lib/v5/task-state.ts:1312`. Fix: read inside the transaction or construct the return row. Recommendation: **absorb**.
- **B2. update.test.ts determinism fix** (`selection: 'all'`, cites issue #2732) — genuine unrelated flake fix. Recommendation: **absorb**.
- **B3. Umask-hardening of test fixtures** — explicit `mode: 0o755/0o644` on mkdir/write in 5 test files + `copyFrozenHistoricalSkill` chmod helper. Helps contributors with non-022 umask (cf. darwin mode quirks). Recommendation: **absorb** as one test-infra commit.
- **B4. codex-dogfood-harness `ownsRoot` mkdir change** — behavior change in shared test infra, motivated only by his scenario; CodeRabbit flagged. Recommendation: **decline**.
- **B5. Docs: "sandbox guest hand-back" workflow** — document the supported round-trip (guest gets state via `task export`/`import`, reports back via roadmap.json channel). Absorbs the *intent* of #2737 with zero code. Recommendation: **absorb if the scenario matters**.
- **B6. Conflict-visibility idea** — his bounded conflict reports could inspire `genie task sync` diverged-state reporting. Recommendation: **defer** behind a trigger (recurring diverged-state pain).
- **B7. Everything else** (snapshot store, libc FFI flock, tombstones, schema fingerprint, WAL bootstrap, `db sync` command) — **reject** per review: wrong premise, conflicts with canonical channel, disproportionate machinery.

## Scope

- IN: close #2737 and #2738 with respectful credit-bearing notes; land approved absorptions (A1, B1–B3 recommended; B5 optional) as small focused commits/PRs through the normal lifecycle.
- OUT: merging either PR as-is; any DB-to-DB sync mechanism; rebasing his branches ourselves.

## Decisions

- Close-both decided by Felipe (2026-08-07). ✔
- Pending approval: which absorptions (A1, B1–B7 dispositions above).
- Close notes drafted for Felipe's review before posting (outward-facing).

## Risks

- Contributor relations: notes must credit specifically (he has 3 merged PRs; a valued contributor), explain the architecture reasoning for #2737, and welcome future work through brainstorm/wish first.
- A1 re-authoring must keep skills/ ↔ plugins/genie/skills mirror parity (release gate).
- B2/B3 may partially overlap fixes already landed on main since 2026-07-30 — verify before landing.

## Criteria (draft)

- Both PRs closed with posted notes naming the absorbed portions and crediting @lirazsiri.
- Each approved absorption lands as its own conventional commit referencing this slug; `bun run check` green.
- B1 covered by a regression test (concurrent unhire during hire).

## Open questions

1. A1: absorb, or decline as speculative configurability?
2. Which of B1–B5 approved?
3. Anything Felipe saw in #2737 he specifically wants preserved that the review rejected?
