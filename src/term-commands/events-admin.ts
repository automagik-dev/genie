/**
 * `genie events admin ...` — incident-response commands for the observability
 * event substrate. Every command that reveals or rotates sensitive state emits
 * an `audit:true` event into the WORM tier (sentinel H6 — "audit the auditors").
 *
 * Subcommands:
 *   revoke-subscriber <token_id>          mark a subscription token revoked
 *   rotate-redaction-keys                  bump redaction + audit HMAC key versions
 *   un-hash <namespace> <hashed>           admin reverse lookup; emits audit.un_hash
 *   export-audit --signed                  produce HMAC-signed audit bundle
 *
 * Wish: genie-serve-structured-observability, Group 5.
 */

import { createHmac, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { emitEvent } from '../lib/emit.js';
import { type AuditExportBundle, exportSignedAuditBundle, verifyAuditChain } from '../lib/events/audit-chain.js';
import { listRevokedTokenIds, revokeToken } from '../lib/events/tokens.js';
import { color } from '../lib/term-format.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function currentActor(): string {
  const who = process.env.GENIE_OPERATOR_ACTOR ?? process.env.USER ?? userInfo().username ?? 'unknown';
  return `${who}@${hostname()}`;
}

function requireEnv(name: string, hint: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    console.error(color('red', `${name} is not set — required for ${hint}`));
    process.exit(2);
  }
  return v;
}

// ---------------------------------------------------------------------------
// revoke-subscriber
// ---------------------------------------------------------------------------

export interface RevokeOptions {
  tokenId?: string;
  subscriberId?: string;
  tenant?: string;
  reason?: string;
  json?: boolean;
}

export async function revokeSubscriberCommand(options: RevokeOptions): Promise<void> {
  if (!options.tokenId) {
    console.error(color('red', '--token-id is required'));
    process.exit(2);
  }
  const reason = options.reason ?? 'IR revocation (no reason supplied)';
  await revokeToken({
    token_id: options.tokenId,
    subscriber_id: options.subscriberId,
    tenant_id: options.tenant ?? 'default',
    revoked_by: currentActor(),
    reason,
  });

  if (options.json) {
    console.log(JSON.stringify({ ok: true, token_id: options.tokenId }));
    return;
  }
  console.log(color('green', `revoked token_id=${options.tokenId} by ${currentActor()}`));
}

// ---------------------------------------------------------------------------
// rotate-redaction-keys
// ---------------------------------------------------------------------------

export interface RotateOptions {
  tenant?: string;
  newKey?: string;
  target?: 'redaction' | 'audit' | 'both';
  json?: boolean;
}

/**
 * Bumps the version in `genie_events_redaction_keys` and/or
 * `genie_audit_chain_keys`. Old key rows are preserved with `rotated_out_at` /
 * `retired_at` stamps so pre-rotation hashes still reverse-look-up.
 */
export async function rotateRedactionKeysCommand(options: RotateOptions): Promise<void> {
  const { getConnection } = await import('../lib/db.js');
  const sql = await getConnection();

  const tenant = options.tenant ?? 'default';
  const target = options.target ?? 'both';
  const keyMaterial = options.newKey ?? randomBytes(32).toString('hex');

  const rotated: Record<string, { from: number; to: number }> = {};

  if (target === 'redaction' || target === 'both') {
    const [{ max_version }] = (await sql`
      SELECT COALESCE(MAX(version), 0)::int AS max_version
      FROM genie_events_redaction_keys
      WHERE tenant_id = ${tenant}
    `) as Array<{ max_version: number }>;
    const nextVersion = max_version + 1;
    await sql`
      UPDATE genie_events_redaction_keys
      SET rotated_out_at = now()
      WHERE tenant_id = ${tenant} AND version = ${max_version} AND rotated_out_at IS NULL
    `;
    await sql`
      INSERT INTO genie_events_redaction_keys (tenant_id, version, key_material)
      VALUES (${tenant}, ${nextVersion}, ${keyMaterial})
    `;
    rotated.redaction = { from: max_version, to: nextVersion };
  }

  if (target === 'audit' || target === 'both') {
    const [{ max_version }] = (await sql`
      SELECT COALESCE(MAX(version), 0)::int AS max_version
      FROM genie_audit_chain_keys
      WHERE tenant_id = ${tenant}
    `) as Array<{ max_version: number }>;
    const nextVersion = max_version + 1;
    await sql`
      UPDATE genie_audit_chain_keys
      SET retired_at = now()
      WHERE tenant_id = ${tenant} AND version = ${max_version} AND retired_at IS NULL
    `;
    await sql`
      INSERT INTO genie_audit_chain_keys (tenant_id, version, key_material)
      VALUES (${tenant}, ${nextVersion}, ${keyMaterial})
    `;
    rotated.audit = { from: max_version, to: nextVersion };
  }

  if (options.json) {
    console.log(JSON.stringify({ ok: true, tenant, rotated }, null, 2));
  } else {
    for (const [target, { from, to }] of Object.entries(rotated)) {
      console.log(color('green', `rotated ${target} key v${from} → v${to} (tenant=${tenant})`));
    }
    console.log(color('dim', 'Previous key rows retained for pre-rotation hash lookups.'));
  }
}

// ---------------------------------------------------------------------------
// un-hash  (admin reverse lookup)
// ---------------------------------------------------------------------------

export interface UnHashOptions {
  namespace?: string;
  hashedValue?: string;
  candidates?: string; // CSV of candidate plaintexts to try
  tenant?: string;
  reason?: string;
  ticket?: string;
  json?: boolean;
}

/**
 * Admin reverse-lookup. Operationally this is a brute-force over a candidate
 * set the operator supplies (e.g. the agent directory, team roster, a user
 * list). Without a candidate set the command reports that un-hash is only
 * possible by replaying the HMAC against known inputs.
 *
 * Whether resolution succeeds or fails, an `audit.un_hash` event is emitted
 * into the WORM tier so the admin action itself lands on the immutable chain.
 */
export async function unHashCommand(options: UnHashOptions): Promise<void> {
  const namespace = options.namespace;
  const hashed = options.hashedValue;
  if (!namespace || !hashed) {
    console.error(color('red', '--namespace and --hashed-value are required'));
    process.exit(2);
  }

  const candidates = (options.candidates ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const key = process.env.GENIE_REDACTION_KEY ?? 'genie-redaction-fallback';
  let resolved: string | null = null;
  for (const cand of candidates) {
    const digest = createHmac('sha256', key).update(cand).digest('hex').slice(0, 16);
    const tag = `tier-a:${namespace}:${digest}`;
    if (tag === hashed) {
      resolved = cand;
      break;
    }
  }

  // Sentinel H6 — emit audit.un_hash into the WORM tier REGARDLESS of outcome.
  try {
    emitEvent(
      'audit.un_hash',
      {
        admin_actor: currentActor(),
        namespace,
        hashed_value: hashed,
        resolved: resolved !== null,
        reason: options.reason ?? 'admin IR un-hash (no reason supplied)',
        ticket_ref: options.ticket,
      },
      { severity: 'warn', source_subsystem: 'events-admin' },
    );
  } catch (err) {
    console.error(color('yellow', `warning: failed to emit audit.un_hash: ${String(err)}`));
  }

  if (options.json) {
    console.log(JSON.stringify({ ok: true, resolved: resolved !== null, plaintext: resolved }));
    return;
  }

  if (resolved !== null) {
    console.log(color('green', `resolved ${hashed} → ${resolved}`));
  } else if (candidates.length === 0) {
    console.log(
      color(
        'yellow',
        'un-hash requires --candidates <csv> of plaintext candidates to brute-force (HMAC is one-way). ' +
          'Audit event emitted regardless.',
      ),
    );
  } else {
    console.log(color('yellow', `no candidate produced ${hashed}`));
  }
}

// ---------------------------------------------------------------------------
// export-audit --signed
// ---------------------------------------------------------------------------

export interface ExportAuditOptions {
  signed?: boolean;
  since?: string;
  sinceId?: string;
  limit?: string;
  tenant?: string;
  output?: string;
  json?: boolean;
  reason?: string;
}

function parseSinceToId(since: string | undefined, sinceId: string | undefined): number {
  if (sinceId) {
    const n = Number.parseInt(sinceId, 10);
    return Number.isFinite(n) ? n : 0;
  }
  // `since` as duration is advisory — the authoritative cursor is id. Callers
  // wanting a time-based window should first run `genie events list --v2
  // --since <dur>` to find the anchor id.
  if (since) {
    console.log(color('yellow', '--since is advisory; exporting from id=0. Use --since-id <n> for a precise cursor.'));
  }
  return 0;
}

function resolveExportSecret(signed: boolean | undefined): string {
  const fromEnv = process.env.GENIE_AUDIT_EXPORT_SECRET ?? process.env.GENIE_EVENTS_TOKEN_SECRET;
  if (fromEnv) return fromEnv;
  if (signed) return requireEnv('GENIE_AUDIT_EXPORT_SECRET', '--signed bundle signatures');
  return 'genie-export-fallback';
}

function emitExportAuditEvent(
  bundle: AuditExportBundle,
  sinceId: number,
  tenant: string,
  signer: string,
  reason: string | undefined,
): void {
  try {
    emitEvent(
      'audit.export',
      {
        exporter_actor: signer,
        since_id: sinceId,
        row_count: bundle.rows.length,
        break_count: bundle.verify.breaks.length,
        bundle_signature_prefix: bundle.bundle_signature.slice(0, 16),
        tenant_id: tenant,
        reason: reason ?? 'admin IR export (no reason supplied)',
      },
      { severity: 'warn', source_subsystem: 'events-admin' },
    );
  } catch (err) {
    console.error(color('yellow', `warning: failed to emit audit.export: ${String(err)}`));
  }
}

function printExportPretty(bundle: AuditExportBundle, tenant: string, sinceId: number): void {
  console.log(color('brightCyan', `Audit export — tenant=${tenant}, since_id=${sinceId}`));
  console.log(color('dim', `rows:              ${bundle.rows.length}`));
  console.log(color('dim', `chain breaks:      ${bundle.verify.breaks.length}`));
  console.log(color('dim', `key versions used: ${bundle.verify.key_versions_used.join(',') || '(none)'}`));
  console.log(color('dim', `first/last id:     ${bundle.verify.first_id ?? '-'} → ${bundle.verify.last_id ?? '-'}`));
  console.log(color('dim', `signer:            ${bundle.signer}`));
  console.log(color('dim', `bundle signature:  ${bundle.bundle_signature.slice(0, 32)}…`));
  if (bundle.verify.breaks.length === 0) return;
  console.log(color('red', 'CHAIN BREAK(S) DETECTED:'));
  for (const b of bundle.verify.breaks.slice(0, 10)) {
    const expected = b.expected ? ` expected=${b.expected.slice(0, 16)}…` : '';
    console.log(color('red', `  row=${b.row_id} reason=${b.reason}${expected}`));
  }
}

function writeBundleOutput(
  bundle: AuditExportBundle,
  options: ExportAuditOptions,
  tenant: string,
  sinceId: number,
): void {
  if (options.output) {
    writeFileSync(options.output, JSON.stringify(bundle, null, 2), 'utf8');
    console.log(color('green', `wrote signed bundle → ${options.output}`));
    return;
  }
  if (options.json) {
    console.log(JSON.stringify(bundle, null, 2));
    return;
  }
  printExportPretty(bundle, tenant, sinceId);
}

export async function exportAuditCommand(options: ExportAuditOptions): Promise<void> {
  const tenant = options.tenant ?? 'default';
  const sinceId = parseSinceToId(options.since, options.sinceId);
  const limit = options.limit ? Number.parseInt(options.limit, 10) : 100_000;
  const signer = currentActor();
  const secret = resolveExportSecret(options.signed);

  const bundle: AuditExportBundle = await exportSignedAuditBundle({
    tenant_id: tenant,
    since_id: sinceId,
    limit,
    signer,
    secret,
  });

  // Sentinel H6 — the export itself is audit-worthy. Emit before writing the
  // bundle so even a failed write is recorded.
  emitExportAuditEvent(bundle, sinceId, tenant, signer, options.reason);
  writeBundleOutput(bundle, options, tenant, sinceId);

  if (bundle.verify.breaks.length > 0) {
    process.exit(3);
  }
}

// ---------------------------------------------------------------------------
// verify-chain (admin quick-check without exporting)
// ---------------------------------------------------------------------------

export interface VerifyChainOptions {
  sinceId?: string;
  limit?: string;
  json?: boolean;
}

export async function verifyChainCommand(options: VerifyChainOptions): Promise<void> {
  const sinceId = options.sinceId ? Number.parseInt(options.sinceId, 10) : 0;
  const limit = options.limit ? Number.parseInt(options.limit, 10) : 100_000;
  const result = await verifyAuditChain({ since_id: sinceId, limit });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(color('brightCyan', `audit chain verify (since_id=${sinceId})`));
    console.log(color('dim', `rows verified:       ${result.verified}`));
    console.log(color('dim', `first/last id:       ${result.first_id ?? '-'} → ${result.last_id ?? '-'}`));
    console.log(color('dim', `key versions used:   ${result.key_versions_used.join(',') || '(none)'}`));
    if (result.breaks.length === 0) {
      console.log(color('green', 'chain intact — 0 breaks'));
    } else {
      console.log(color('red', `${result.breaks.length} break(s) detected:`));
      for (const b of result.breaks.slice(0, 20)) {
        console.log(color('red', `  row=${b.row_id} reason=${b.reason}`));
      }
    }
  }

  if (result.breaks.length > 0) {
    process.exit(3);
  }
}

// ---------------------------------------------------------------------------
// list-revocations
// ---------------------------------------------------------------------------

export interface ListRevocationsOptions {
  tenant?: string;
  json?: boolean;
}

export async function listRevocationsCommand(options: ListRevocationsOptions): Promise<void> {
  const tenant = options.tenant ?? 'default';
  const ids = await listRevokedTokenIds(tenant);
  if (options.json) {
    console.log(JSON.stringify({ tenant, revoked: [...ids] }, null, 2));
  } else {
    if (ids.size === 0) {
      console.log(color('dim', `no revoked tokens for tenant=${tenant}`));
    } else {
      console.log(color('brightCyan', `Revoked tokens — tenant=${tenant}`));
      for (const id of ids) console.log(`  ${id}`);
      console.log(color('dim', `(${ids.size} revoked)`));
    }
  }
}
