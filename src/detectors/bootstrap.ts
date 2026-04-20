/**
 * Detector bootstrap — imports every production DetectorModule for its
 * registration side-effect.
 *
 * Wish: genie-self-healing-observability-b1-detectors (Group 3a).
 *
 * Each detector module calls `registerDetector(module)` at the bottom of
 * its file. Bun/Node only runs that side-effect when the module is
 * actually imported — so the scheduler boot path has to import each
 * module at least once. Centralising those imports here keeps
 * `src/term-commands/serve.ts` minimal and gives future detectors a
 * single place to land.
 *
 * Production import order is the order detectors show up in
 * `listDetectors()`, which the scheduler iterates in on every tick. Keep
 * the list sorted by pattern-<N> so the order is stable and greppable.
 */

// Pattern 1 — teams with no worktree on disk.
import './pattern-1-backfill-no-worktree.js';
// Pattern 4 — agents violating (custom_name, team) uniqueness.
import './pattern-4-duplicate-agents.js';
// Pattern 5 — team-leads alive while their team has no activity.
import './pattern-5-zombie-team-lead.js';

// No named exports: this module exists only for its import side-effects.
// `serve.ts` references it via `await import('../detectors/bootstrap.js')`
// and knip is satisfied because the file is listed in `knip.json -> entry`.
