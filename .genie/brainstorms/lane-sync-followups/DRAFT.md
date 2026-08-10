# Brainstorm: lane-sync-followups

**Origin:** PR #2756 xhigh review (2026-08-10) — four design-level findings deliberately not fixed
during the review-fix push (`da7e41f..7eb5215` on dev) because they need decisions, not patches.

**WRS: ██████████ 100/100** — Problem ✅ | Scope ✅ | Decisions ✅ | Risks ✅ | Criteria ✅

**Felipe's picks (2026-08-10):** D1 = unify write paths (link delegates to setTaskWish, no-op
skips event). D2 = document the existing rule only (reframed: lanes follow the primary checkout's
current branch — no branch policy imposed; drag-back is cockpit-flow-only). D3 = shared
read/extract module, per-consumer interpretation. D4 = reconcile only lane-rendering reads +
thread repo root. Crystallized to DESIGN.md.

## Problem

The board/wish lane-sync layer shipped by roadmap-truth and remotty-board-asks left four seams:
two write paths for one card mutation with different audit policy, undecided worktree semantics
for the WISH.md lane source, a triplicated WISH.md status parser, and reconcile work spent on
reads whose output cannot show it.

## Scope

- **IN:** the four items below; `src/term-commands/v5-task.ts`, `src/term-commands/v5-board.ts`,
  `src/lib/v5/task-state.ts`, a possible shared `src/lib/wish-status` module,
  `plugins/genie/scripts/src/session-context.ts` (+ regenerated `.cjs`), `scripts/wishes-lint.ts`,
  `src/lib/v5/TAXONOMY.md`.
- **OUT:** MCP surface changes (stays read-only per roadmap-truth Decision 7), the frozen laneless
  `--json` shape, remotty-side scanner changes, any new daemon/config surface.

## The four decisions

### D1 — `task link` writes no timeline event; `task set-wish` guarantees one
Evidence softens the review's "contradiction": roadmap-truth Group 2 explicitly says
*"If the timeline should record the link, make that a deliverable first"* — deferred, not forbidden.
remotty-board-asks Decision 3 + AC establish the every-identity-change-has-an-event invariant, and
its review already logged LOW-1 (no-op `--clear` writes a `(none)→(none)` event) and LOW-4 (wish-ref
format duplicate) as follow-ups.
- **A (recommended): unify** — `linkTaskToWish` delegates to `setTaskWish` (one write path, one
  validation chain, event on every real change); `setTaskWish` skips the event when from == to
  (also fixes LOW-1); both verb names stay (remotty scripts call `link`).
- **B:** `link` appends its own event; two write paths remain and keep drifting.
- **C:** keep `link` eventless; document the divergence as designed.

### D2 — lane-source rule (REFRAMED 2026-08-10 after Felipe's worktree question)
`resolveRepoRoot()` (genie-db.ts:61) = parent of git-common-dir, which in a **plain checkout is the
checkout itself, current branch** — lanes already follow whatever branch the user has checked out.
The review's "reconciles against main" framing over-specified: genie imposes no branch policy.
The lag/drag-back symptom exists ONLY in the linked-worktree cockpit flow (`genie launch`,
work/dream hires), where the primary checkout sits on dev/main while wish branches live in
worktrees — there, lanes show merged truth until the branch lands. Felipe's remotty workflow
(plain `../remotty` checkout) is unaffected: status edits move cards immediately.
Genie creates worktrees only in `launch` (one per ready group) and orchestration hires
(`hire_roster`, machine-local); everything else is read-side worktree-safety.
- **A (recommended): document the existing rule** — "lanes follow the primary checkout's current
  branch; linked worktrees inherit the primary checkout's view" in TAXONOMY.md + wish skill.
  Zero machinery, no policy imposed on other codebases.
- **B: A + monotonic guard for the cockpit case** — reconcile additionally never moves a card
  backwards along Idea→…→Done; kills cockpit drag-back, breaks automatic true reverts.
- **C: prefer the wish branch's worktree copy when present** — freshest truth for cockpit users,
  but lanes become machine/worktree-dependent; discovery machinery. Fails the simplicity gate.

### D3 — WISH.md status parser exists three times
`v5-board.ts` (wide prefix ladder), `session-context.ts` (strict durable vocabulary, 256KB cap,
slug/physical-dir guards), `wishes-lint.ts` (third slug regex). The interpretation difference is
intentional; the read/extract mechanics are not.
- **A (recommended): shared parser, per-consumer interpretation** — extract slug validation +
  bounded read + status extraction into `src/lib/wish-status.ts`; all three import it; each keeps
  its own status→meaning mapping; regenerate `session-context.cjs` via the existing parity
  workflow (a supported release-gate step, not a violation).
- **B: parity fixture test only** — three copies stay, a test corpus asserts agreement.
- **C: full semantic unification** — one canonical vocabulary; riskiest (board tolerance is
  deliberately wider); not recommended.

### D4 — reconcile runs on the laneless `--json` path + redundant `git rev-parse`
`handleBoard` calls `reconcileWishLanes` for every `--json` read at v5-board.ts:277, before the
branch that decides whether lanes render; unscoped reads sweep ALL lane boards and write moves for
frozen status-only output. `resolveRepoRoot()` re-spawns git although `openDb` just resolved it.
- **A (recommended): reconcile only lane-rendering reads** — move the call inside the
  `board?.lanes` branch; unscoped/laneless `--json` becomes a pure read (pi/hermes session-start
  probes under 5s timeouts stop paying write transactions); remotty's scoped
  `--board roadmap --json` probe keeps its designed freshening. Also thread the repo root through
  instead of the second `git rev-parse`. Revisit the pi-genie tool descriptions after (unscoped
  default becomes genuinely read-only again).
- **B: keep global freshening** — every `--json` read reconciles every board; dedupe the spawn only.

## Risks

- D1-A: `setTaskWish` no-op event skip changes remotty-observed behavior (LOW-1 was
  "pattern-faithful with moveTask") — confirm no consumer counts events.
- D2-A: accepted product cost — the board shows a wish as un-started while it is actively being
  worked in a worktree, until merge. If that reads wrong to operators, D2-B is the fallback.
- D3-A: bundling a shared module into `session-context.cjs` grows the committed bundle; parity
  gate must be regenerated in the same commit or `bun run check` fails.
- D4-A: any consumer relying on *unscoped* reads to freshen lanes loses that side effect
  (roadmap-truth's designed freshener is the scoped probe; review of remotty scanners recommended).

## Criteria (to be finalized at crystallize)

- One write path for wish/group identity; `task link` and `task set-wish` produce identical
  timeline evidence for identical mutations; no-op mutations write no event.
- TAXONOMY.md states the WISH.md lane-source rule (main checkout canonical).
- One shared read/extract implementation; `hook-bundle-parity --check` green.
- Unscoped `genie board --json` issues zero writes (provable by WAL/query count or seeded-divergence
  test in the roadmap-truth style); scoped lane reads still reconcile.
