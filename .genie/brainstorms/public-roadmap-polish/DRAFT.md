# DRAFT: public-roadmap-polish

**Status:** Raw · **Seeded:** 2026-07-28 from [genie-official-roadmap](../genie-official-roadmap/DESIGN.md) decision **D6** · **Lane:** Idea

## WHY THIS EXISTS

The 2026-07-28 triage produced an honest internal roadmap: 29 wishes archived, 19 cards on the `roadmap` board, an INDEX that a lint can now check against the board. All of it is invisible from outside the repo.

Felipe named public-facing polish as **axis #1**, and D6 carved it out as its own brainstorm rather than smuggling it into the triage wish. That decision has one visible consequence today: the board's Done lane is deliberately empty, because "what shipped" is currently presented as INDEX prose and surfacing it outward is *this* brainstorm's job, not the triage's.

## THE GAP

- **No outward roadmap surface.** `genie board` is a terminal view over a per-repo SQLite DB. `roadmap.json` is git-tracked and therefore technically public, but it is a machine snapshot — nobody reads it as a roadmap.
- **Done-ness has no public home.** 29 shipped wishes live under `.genie/wishes/archive/`, findable only by someone already inside the repo who knows the taxonomy.
- **Docs and reality drift at the edges.** The public Mintlify site (`automagik.dev/genie`) documents installation and operations; it says nothing about direction, and nothing routes a newcomer from "what is this" to "what is being built next".
- **Onboarding is a separate wound.** The 30-minute-contributor test has never been run against the current tree. A public roadmap that lands next to stale onboarding docs makes the drift *more* visible, not less — the sweep has to ship with the surface.

## SHAPE (first sketch, nothing locked)

Three plausible layers, roughly in dependency order:

1. **Export.** A deterministic projection of the roadmap board into something publishable — lanes, cards, slugs, and the shipped set. Likely a `genie` subcommand or a CI step reading `roadmap.json`, so the published artifact is derived, never hand-maintained.
2. **Surface.** A page (or small set of pages) under `docs/` on the Mintlify site rendering that projection: what is in flight, what is next, what shipped. Public-safe by construction — the projection decides what crosses the boundary.
3. **Sweep.** Docs + onboarding pass landing alongside: kill the drift the roadmap page will expose, make the first-30-minutes path real, route newcomers to the roadmap and back.

## OPEN QUESTIONS

- **How public is public?** The board carries internal reasoning (review verdicts, fix-loop counts, Felipe-verbatim directives, fork-relocation notes). Is the public projection a *filtered* view, a *separate curated* view, or a hard allowlist of fields? This is the decision everything else hangs off.
- **Where does it render?** Mintlify page under `docs/` (consistent with the existing public site) vs. a GitHub Projects board vs. a generated markdown file in the repo root. The docs site is the obvious default; it costs a build step and a submodule PR per update.
- **How does it stay fresh?** Manual regeneration will rot within two weeks — the INDEX prose already proves it. CI on merge to dev? A `genie` command run by the release pipeline? Does staleness become a doctor check?
- **Does the Done lane get populated?** If shipped work lands on the public board, does the internal board's Done lane fill too, or does INDEX's Shipped section stay the internal record and the projection read the archive directory instead?
- **What does "onboarding sweep" actually cover?** Diátaxis audit of `docs/`, a real 30-minute run-through, error-message quality, or all three? Scope discipline matters — this could swallow a month.
- **Does public visibility change how wishes are written?** If WISH.md prose becomes quotable, the honest internal register (fix loops, BLOCKED, unmet criteria recorded rather than waived) is exactly what must *not* be sanitized. Worth an explicit non-goal.

## NON-GOALS (tentative)

- Not a rewrite of the wish/brainstorm taxonomy — the triage just settled it.
- Not a marketing page. Roadmap honesty is the product; polish means legible, not promotional.
- Not a second tracker. The `roadmap` board stays the single source; anything published is derived from it.

## NEXT STEP

Take the "how public is public" question to Felipe before anything else — the answer determines whether this is a small export + docs page (small appetite) or a curation workflow with its own review gate (medium+). Crystallize into DESIGN.md only after that.
