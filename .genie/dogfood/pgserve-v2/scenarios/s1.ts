#!/usr/bin/env bun
/**
 * S1 connect — genie boots, requests a DB, gets one named app_<sanitized>_<12hex>,
 *              CRUD a row, disconnect.
 *
 * Validates wish/pgserve-v2 Group 4 (per-fingerprint DB enforcement).
 */

const SCENARIO = 'S1';
const WAVE = 'Wave 4 (Group 4 — per-fingerprint DB enforcement)';
const STATUS: 'WIP' | 'READY' = 'WIP';

if (STATUS === 'WIP') {
  process.stderr.write(`${SCENARIO} WIP — awaiting ${WAVE}\n`);
  process.exit(2);
}

// TODO(wave-4): consume pgserve from `npm pack` of wish/pgserve-v2, boot daemon
// in ephemeral mode, request a DB, assert name matches /^app_[a-z0-9_]+_[0-9a-f]{12}$/,
// CRUD a row, disconnect, assert DB still listed in pgserve_meta.
process.stderr.write(`${SCENARIO} not implemented\n`);
process.exit(3);
