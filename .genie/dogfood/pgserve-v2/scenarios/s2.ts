#!/usr/bin/env bun
/**
 * S2 fingerprint mismatch denied — genie booting from /tmp/fake-project (different
 *                                  package.json) must NOT reach the real genie DB;
 *                                  gets a fresh fingerprint instead.
 *
 * Validates wish/pgserve-v2 Group 4 (per-fingerprint DB enforcement) on top of
 * Group 3 (fingerprint derivation + SO_PEERCRED).
 */

const SCENARIO = 'S2';
const WAVE = 'Wave 4 (Group 4 — per-fingerprint DB enforcement)';
const STATUS: 'WIP' | 'READY' = 'WIP';

if (STATUS === 'WIP') {
  process.stderr.write(`${SCENARIO} WIP — awaiting ${WAVE}\n`);
  process.exit(2);
}

// TODO(wave-4): scaffold /tmp/fake-project with its own package.json, boot a
// second genie there, attempt to attach to the real genie DB by name; expect
// the daemon to refuse and create a fresh app_fake_<hex> instead. Audit log
// must contain `connection_denied_fingerprint_mismatch`.
process.stderr.write(`${SCENARIO} not implemented\n`);
process.exit(3);
