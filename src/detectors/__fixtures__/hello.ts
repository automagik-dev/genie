/**
 * Test-only stub detector. Fires a fixed payload on every tick so the
 * scheduler tests have a predictable subject for timing and budget checks.
 *
 * Never import this from production code paths — it is only for the scheduler
 * and fire-budget unit tests. The production registry is populated by the
 * real detector modules that land in later waves of this wish.
 */

import type { DetectorModule } from '../index.js';

export interface HelloState {
  readonly now: number;
  readonly fire: boolean;
}

/**
 * Factory returning a stub detector. The `alwaysFire` flag lets budget tests
 * create a detector that fires every tick; the default is to fire on every
 * tick too (the scheduler timing tests care about tick cadence, not payload
 * shape).
 */
export function makeHelloDetector(
  opts: { id?: string; version?: string; alwaysFire?: boolean } = {},
): DetectorModule<HelloState> {
  const id = opts.id ?? 'test.hello';
  const version = opts.version ?? '0.0.1';
  const alwaysFire = opts.alwaysFire ?? true;

  return {
    id,
    version,
    riskClass: 'low',
    query(): HelloState {
      return { now: Date.now(), fire: alwaysFire };
    },
    shouldFire(state: HelloState): boolean {
      return state.fire;
    },
    render(state: HelloState) {
      // We route through the existing runbook.triggered schema because it
      // accepts a free-form evidence_summary and exists in the registry. The
      // scheduler tests only care that emission happens with the correct
      // detector_version — payload shape is incidental.
      return {
        type: 'runbook.triggered',
        subject: id,
        payload: {
          rule: 'R1',
          evidence_count: 1,
          evidence_summary: `stub detector ${id} tick ${state.now}`,
        },
      };
    },
  };
}
