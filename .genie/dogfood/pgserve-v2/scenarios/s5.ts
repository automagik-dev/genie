#!/usr/bin/env bun
/**
 * S5 --listen TCP fallback — pgserve started with `--listen :5432`; genie
 *                            configured with host=localhost port=5432 instead
 *                            of socket — connects.
 *
 * Validates wish/pgserve-v2 Group 6 (--listen TCP fallback).
 */

const SCENARIO = 'S5';
const WAVE = 'Wave 5 (Group 6 — --listen TCP fallback)';
const STATUS: 'WIP' | 'READY' = 'WIP';

if (STATUS === 'WIP') {
  process.stderr.write(`${SCENARIO} WIP — awaiting ${WAVE}\n`);
  process.exit(2);
}

// TODO(wave-5): boot pgserve daemon with `--listen :5432` (use an ephemeral
// port if 5432 is bound; keep the test deterministic), point genie at
// host=localhost port=<port>, assert it connects, runs the same CRUD as S1,
// and that audit log contains `connection_routed` with `transport: tcp`.
process.stderr.write(`${SCENARIO} not implemented\n`);
process.exit(3);
