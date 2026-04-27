#!/usr/bin/env bun
/**
 * S4 TTL reaped — package.json has no persist flag; kill genie, fast-forward 25h,
 *                 restart genie with same fingerprint → DB was reaped, fresh
 *                 empty one provisioned.
 *
 * Validates wish/pgserve-v2 Group 5 (lifecycle / GC reaps stale DBs).
 */

const SCENARIO = 'S4';
const WAVE = 'Wave 5 (Group 5 — lifecycle / GC)';
const STATUS: 'WIP' | 'READY' = 'WIP';

if (STATUS === 'WIP') {
  process.stderr.write(`${SCENARIO} WIP — awaiting ${WAVE}\n`);
  process.exit(2);
}

// TODO(wave-5): write a temporary package.json with NO pgserve.persist flag,
// boot genie, write a sentinel row, kill the genie process, advance the
// reaper's clock 25h, restart genie, assert the sentinel row is gone (table
// either missing or empty) and the DB name is unchanged (same fingerprint
// produces the same name on re-create). Audit log must contain
// `db_reaped_ttl`.
process.stderr.write(`${SCENARIO} not implemented\n`);
process.exit(3);
