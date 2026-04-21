/**
 * Built-in detector aggregator — loading this module registers every
 * production detector with the registry in `src/detectors/index.ts`.
 *
 * Wish: genie-self-healing-observability-b1-detectors (Group 3c).
 *
 * Groups 3a, 3b, and 3c land detectors in parallel; this file is the single
 * import point `serve.ts` uses so that one `await import('./built-in.js')`
 * runs every side-effect `registerDetector(...)` call before the scheduler
 * issues `listDetectors()`. Future groups append their detectors here.
 *
 * Never import this from test code — tests inject detectors directly via
 * `detectorSource` on the scheduler, or call `makeXDetector()` factories
 * with stubbed `loadState`. Auto-registering every production detector into
 * Bun's test registry would leak cross-test state.
 */

// Group 3a — low-risk rot detectors (#1237). Each module registers its
// detector via the `registerDetector(module)` side-effect at import time.
import './pattern-1-backfill-no-worktree.js';
import './pattern-4-duplicate-agents.js';
import './pattern-5-zombie-team-lead.js';

// Group 3b — pattern-2 team-ls vs team-disband drift detector (#1235).
import './pattern-2-team-ls-drift.js';

// Group 3c — four read-only detectors for high-blast-radius rot patterns.
// Each module's import triggers its own `registerDetector(default)` call.
import './pattern-3-anchor-orphan.js';
import './pattern-6-subagent-cascade.js';
import './pattern-7-dispatch-silent-drop.js';
import './pattern-8-session-reuse-ghost.js';

// Group 3d — pattern-9 team-unpushed-orphaned-worktree (#1288 — registers
// detector from #1283, which shipped the source without wiring the import).
import './pattern-9-team-unpushed-orphaned-worktree.js';

// Future detector groups append their imports above. Keep imports
// alphabetical within each group for predictable registration order.
