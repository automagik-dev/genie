#!/usr/bin/env bun
/**
 * S6 kill-switch bypass — PGSERVE_DISABLE_FINGERPRINT_ENFORCEMENT=1; two genie
 *                         processes from different fingerprints — second
 *                         reaches first's DB; deprecation warning logged.
 *
 * Validates wish/pgserve-v2 Group 4 (kill switch is a real bypass, not a no-op).
 */

const SCENARIO = 'S6';
const WAVE = 'Wave 4 (Group 4 — per-fingerprint DB enforcement)';
const STATUS: 'WIP' | 'READY' = 'WIP';

if (STATUS === 'WIP') {
  process.stderr.write(`${SCENARIO} WIP — awaiting ${WAVE}\n`);
  process.exit(2);
}

// TODO(wave-4): boot daemon, set PGSERVE_DISABLE_FINGERPRINT_ENFORCEMENT=1,
// boot two genie processes with distinct fingerprints (real cwd + fake cwd
// from S2), have the second one connect to the first's DB by name, assert
// the connect succeeds, assert audit log contains
// `enforcement_kill_switch_used` AND a deprecation warning string. Without
// the env var the same operation must fail (regression check).
process.stderr.write(`${SCENARIO} not implemented\n`);
process.exit(3);
