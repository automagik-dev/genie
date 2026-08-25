# Brainstorm: public-roadmap-polish — publish the roadmap outward

**Started:** 2026-08-25 · **WRS:** 35/100 (Problem ✅ Scope ◐ Decisions ░ Risks ◐ Criteria ░)

Seeded from [genie-official-roadmap](../genie-official-roadmap/DESIGN.md) Decision 6: Felipe's #1 axis (public-facing polish) had no wish. The roadmap now exists as data (`roadmap.json`, board `roadmap`, INDEX Shipped section) — this brainstorm owns surfacing it outward.

## Problem

- The roadmap is only readable by someone who clones the repo and runs `genie board --board roadmap`. Nothing on automagik.dev shows what shipped, what is in flight, or what is next.
- The board's Done lane is empty by design (official-roadmap D6): shipped work lives in `.genie/wishes/archive/` + the INDEX Shipped section, invisible to the board reader.
- Docs/onboarding drifted while v5 shipped: `docs/` still describes surfaces that the archived wishes changed (routing, hooks, Codex activation, boards).

## Scope (candidate)

- Render `roadmap.json` into a public page (Mintlify `docs/roadmap.mdx` or a generated section) — lanes + Shipped list, regenerated in CI from the committed snapshot, no live DB.
- Decide how Done is represented outward: archived wishes as a "Shipped" timeline (date + PR) rather than cards.
- Docs/onboarding sweep against the archived wishes' "Files to Create/Modify" sections — every shipped surface has a docs page that matches.
- OUT: changing board/sync machinery; per-wish public write-ups; anything requiring the desktop fork.

## Open questions

1. Public page = generated from `roadmap.json` at docs build time, or committed markdown refreshed by a `genie` verb?
2. Granularity outward: initiative cards only, or group tasks too?
3. Does the Shipped list cite PRs (public repo, fine) or just dates?

## Risks

- Publishing lane names that read as promises (Work/Review) — needs a "no dates, no commitments" banner.
- Docs sweep is unbounded without the archived-wish file lists as the checklist.

## Next step

Felipe picks Q1–Q3 → design.
