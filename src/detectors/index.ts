/**
 * Detector Plugin API — read-only measurement modules.
 *
 * Wish: Observability B1 — rot-pattern detectors (Group 2 / Phase 0).
 *
 * A detector is a small module that:
 *   1. Queries some piece of genie state (DB row counts, worktree fs, etc).
 *   2. Decides whether the state indicates a known rot pattern.
 *   3. Renders a structured event payload describing what it saw.
 *
 * The scheduler in `src/serve/detector-scheduler.ts` invokes every registered
 * detector on a 60s cadence, routes emitted payloads through the existing
 * `src/lib/emit.ts` event substrate, and enforces a per-detector hourly
 * fire_budget. Detectors never mutate genie state — V1 is pure observation.
 *
 * Future waves (see roadmap) may consume these events to drive automated
 * remediation; this module stays strictly read-only measurement forever.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Risk classification for a detector. Currently informational only — future
 * phases may use this to gate automatic runbook execution.
 */
export type DetectorRiskClass = 'low' | 'medium' | 'high';

/**
 * Payload emitted when a detector fires. `type` is the registered event type
 * (must live in `src/lib/events/schemas/` and be present in the registry);
 * `payload` is the schema-validated body. `subject` is an optional human-
 * readable identifier copied into the event metadata.
 */
export interface DetectorEvent {
  readonly type: string;
  readonly subject?: string;
  readonly payload: Record<string, unknown>;
}

/**
 * A detector module.
 *
 * Fields:
 *   - `id`: stable kebab-case identifier ('rot.backfill-no-worktree').
 *   - `version`: semver release identifier; populates `detector_version` on
 *     every emission. Bump when the detector's semantics change.
 *   - `riskClass`: informational risk bucket.
 *   - `query`: reads a slice of genie state and returns a state object. Run
 *     once per tick. Must be side-effect free.
 *   - `shouldFire`: pure predicate over the query result.
 *   - `render`: turns a query result into the event payload to emit. Only
 *     invoked when `shouldFire` returns true.
 *
 * The type parameter `T` is the shape returned by `query` and threaded into
 * `shouldFire` and `render`. Defaults to `unknown` so callers can omit it.
 */
export interface DetectorModule<T = unknown> {
  readonly id: string;
  readonly version: string;
  readonly riskClass: DetectorRiskClass;
  query(): T | Promise<T>;
  shouldFire(result: T): boolean;
  render(result: T): DetectorEvent;
}

// ---------------------------------------------------------------------------
// In-memory registry
// ---------------------------------------------------------------------------

/**
 * Registry. Map keyed by detector.id so duplicate registrations replace cleanly
 * (important for tests that re-register the same stub across describe blocks).
 */
const registry = new Map<string, DetectorModule<unknown>>();

/**
 * Register a detector. Replaces any existing registration with the same id.
 */
export function registerDetector<T>(module: DetectorModule<T>): void {
  validateModule(module);
  registry.set(module.id, module as DetectorModule<unknown>);
}

/**
 * List all registered detectors in insertion order.
 */
export function listDetectors(): ReadonlyArray<DetectorModule<unknown>> {
  return Array.from(registry.values());
}

/**
 * Remove a detector from the registry. Returns true if a module was removed.
 * Useful for tests that need to isolate detector state between runs.
 */
export function unregisterDetector(id: string): boolean {
  return registry.delete(id);
}

/**
 * Clear the registry. Tests only — never call from production code paths.
 */
export function __clearDetectorsForTests(): void {
  registry.clear();
}

// ---------------------------------------------------------------------------
// Validation — surface misuse at registration time so the scheduler never
// has to defensively handle malformed modules.
// ---------------------------------------------------------------------------

const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;

function validateModule<T>(module: DetectorModule<T>): void {
  if (!module || typeof module !== 'object') {
    throw new Error('registerDetector: module must be an object');
  }
  if (typeof module.id !== 'string' || !ID_RE.test(module.id)) {
    throw new Error(`registerDetector: invalid id '${String(module.id)}' — must match ${ID_RE.source}`);
  }
  if (typeof module.version !== 'string' || !SEMVER_RE.test(module.version)) {
    throw new Error(
      `registerDetector: invalid version '${String(module.version)}' for '${module.id}' — must be semver`,
    );
  }
  if (module.riskClass !== 'low' && module.riskClass !== 'medium' && module.riskClass !== 'high') {
    throw new Error(`registerDetector: invalid riskClass for '${module.id}'`);
  }
  if (typeof module.query !== 'function') {
    throw new Error(`registerDetector: query must be a function on '${module.id}'`);
  }
  if (typeof module.shouldFire !== 'function') {
    throw new Error(`registerDetector: shouldFire must be a function on '${module.id}'`);
  }
  if (typeof module.render !== 'function') {
    throw new Error(`registerDetector: render must be a function on '${module.id}'`);
  }
}
