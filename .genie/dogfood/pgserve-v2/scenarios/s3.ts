#!/usr/bin/env bun
/**
 * S3 persist honored — package.json has `pgserve.persist: true`; kill genie,
 *                      fast-forward 25h via test hook, restart genie → original
 *                      DB still present.
 *
 * Validates wish/pgserve-v2 Group 5 (lifecycle / GC honors persist flag).
 */

const SCENARIO = 'S3';
const WAVE = 'Wave 5 (Group 5 — lifecycle / GC)';
const STATUS: 'WIP' | 'READY' = 'WIP';

if (STATUS === 'WIP') {
  process.stderr.write(`${SCENARIO} WIP — awaiting ${WAVE}\n`);
  process.exit(2);
}

// TODO(wave-5): write a temporary package.json with pgserve.persist: true,
// boot genie, write a sentinel row, kill the genie process, advance the
// reaper's clock 25h via the documented test hook (PGSERVE_NOW_OVERRIDE or
// equivalent — see Group 5 deliverables), restart genie, assert the sentinel
// row is still readable. Audit log must contain `db_persist_honored`.
process.stderr.write(`${SCENARIO} not implemented\n`);
process.exit(3);
