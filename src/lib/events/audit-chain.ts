/**
 * Audit-tier HMAC chain verifier.
 *
 * The `audit_events_chain_hash()` trigger (migration 039) computes
 *   chain_hash = hmac( prior_chain_hash || sha256(row_digest_text), key )
 * on every INSERT into `genie_runtime_events_audit`. `key` is read from the
 * session GUC `app.audit_hmac_key`; when absent the chain degrades to an
 * un-keyed SHA256 digest so the chain is still continuous across dev/test.
 *
 * This module replays the same computation row-by-row and asserts continuity.
 * Any break (tampered chain_hash, reordered rows, missing prior row) is
 * reported with the offending row id so IR can reproduce.
 *
 * Wish: genie-serve-structured-observability, Group 5.
 */

import { createHash, createHmac } from 'node:crypto';
import { getConnection } from '../db.js';

export interface AuditChainRow {
  id: number;
  kind: string;
  agent: string;
  text: string;
  data: Record<string, unknown> | string | null;
  trace_id: string | null;
  span_id: string | null;
  severity: string | null;
  created_at: string; // ISO timestamp string
  chain_hash: Buffer | null;
  chain_key_version: number;
}

export interface ChainBreak {
  row_id: number;
  reason:
    | 'chain_hash_null'
    | 'digest_mismatch'
    | 'hmac_mismatch'
    | 'prior_row_missing'
    | 'key_version_unknown'
    | 'first_row_nonzero_predecessor';
  expected?: string;
  actual?: string;
}

export interface ChainVerifyResult {
  verified: number;
  breaks: ChainBreak[];
  first_id: number | null;
  last_id: number | null;
  key_versions_used: number[];
}

/**
 * Replay the chain from `since_id` forward. Reads rows directly from the WORM
 * table; the caller must connect as a role that can SELECT from it
 * (events_admin, events_audit, or the pgserve-owner bootstrap role).
 */
export async function verifyAuditChain(opts: { since_id?: number; limit?: number } = {}): Promise<ChainVerifyResult> {
  const sql = await getConnection();
  const sinceId = opts.since_id ?? 0;
  const limit = opts.limit ?? 100_000;

  const rows = (await sql`
    SELECT id, kind, agent, text, data, trace_id::text AS trace_id, span_id::text AS span_id,
           severity, created_at::text AS created_at, chain_hash, chain_key_version
    FROM genie_runtime_events_audit
    WHERE id > ${sinceId}
    ORDER BY id ASC
    LIMIT ${limit}
  `) as unknown as AuditChainRow[];

  const keyMap = await loadKeyMap();
  const breaks: ChainBreak[] = [];
  const keyVersionsUsed = new Set<number>();

  // Seed prior_hash — if since_id is 0 (new chain) start with the all-zero
  // predecessor the trigger uses; otherwise fetch the previous row's chain
  // hash to resume verification from mid-chain.
  let priorHash: Buffer;
  if (sinceId > 0) {
    const [prev] = (await sql`
      SELECT chain_hash FROM genie_runtime_events_audit WHERE id = ${sinceId} LIMIT 1
    `) as Array<{ chain_hash: Buffer | null }>;
    priorHash = prev?.chain_hash ?? Buffer.alloc(32, 0);
  } else {
    priorHash = Buffer.alloc(32, 0);
  }

  let firstId: number | null = null;
  let lastId: number | null = null;

  const verifyRow = (row: AuditChainRow, prior: Buffer): Buffer => {
    if (!row.chain_hash) {
      breaks.push({ row_id: Number(row.id), reason: 'chain_hash_null' });
      return prior;
    }
    const key = keyMap.get(row.chain_key_version);
    if (key === undefined) {
      breaks.push({
        row_id: Number(row.id),
        reason: 'key_version_unknown',
        expected: `version ${row.chain_key_version} in genie_audit_chain_keys`,
      });
      return row.chain_hash;
    }
    const rowDigest = computeRowDigest(row);
    const input = Buffer.concat([prior, rowDigest]);
    const expected =
      key.length === 0 ? createHash('sha256').update(input).digest() : createHmac('sha256', key).update(input).digest();
    if (!expected.equals(row.chain_hash)) {
      breaks.push({
        row_id: Number(row.id),
        reason: key.length === 0 ? 'digest_mismatch' : 'hmac_mismatch',
        expected: expected.toString('hex'),
        actual: row.chain_hash.toString('hex'),
      });
    }
    return row.chain_hash;
  };

  for (const row of rows) {
    if (firstId === null) firstId = Number(row.id);
    lastId = Number(row.id);
    keyVersionsUsed.add(row.chain_key_version);
    priorHash = verifyRow(row, priorHash);
  }

  return {
    verified: rows.length,
    breaks,
    first_id: firstId,
    last_id: lastId,
    key_versions_used: [...keyVersionsUsed].sort((a, b) => a - b),
  };
}

/**
 * Recompute the row digest the trigger uses. Must stay bit-for-bit identical
 * to the SQL expression in migration 039_runtime_events_siblings.sql.
 */
export function computeRowDigest(row: AuditChainRow): Buffer {
  const dataText = typeof row.data === 'string' ? row.data : JSON.stringify(row.data ?? {});
  const parts = [
    row.kind ?? '',
    '|',
    row.agent ?? '',
    '|',
    row.text ?? '',
    '|',
    dataText,
    '|',
    row.trace_id ?? '',
    '|',
    row.span_id ?? '',
    '|',
    row.severity ?? '',
    '|',
    row.created_at ?? '',
  ].join('');
  return createHash('sha256').update(parts).digest();
}

async function loadKeyMap(): Promise<Map<number, Buffer>> {
  const sql = await getConnection();
  const rows = (await sql`
    SELECT version, key_material FROM genie_audit_chain_keys WHERE tenant_id = 'default'
    ORDER BY version ASC
  `) as Array<{ version: number; key_material: string }>;
  const map = new Map<number, Buffer>();
  for (const row of rows) {
    map.set(row.version, Buffer.from(row.key_material, 'utf8'));
  }
  return map;
}

// ---------------------------------------------------------------------------
// Signed audit export — produces a bundle with (chain_verify, rows, digest).
// ---------------------------------------------------------------------------

export interface AuditExportBundle {
  generated_at: string;
  tenant_id: string;
  since_id: number;
  verify: ChainVerifyResult;
  rows: AuditChainRow[];
  bundle_signature: string;
  signer: string;
}

/**
 * Produce a signed audit export. Caller must have events_admin or events_audit
 * role. The bundle signature is HMAC-SHA256 over the canonical JSON of
 * (verify, rows) keyed by the current redaction key — detached so the recipient
 * can re-verify independently by running `verifyAuditChain` + recomputing the
 * HMAC.
 */
export async function exportSignedAuditBundle(opts: {
  tenant_id?: string;
  since_id?: number;
  limit?: number;
  signer: string;
  secret?: string;
}): Promise<AuditExportBundle> {
  const tenantId = opts.tenant_id ?? 'default';
  const sinceId = opts.since_id ?? 0;
  const verify = await verifyAuditChain({ since_id: sinceId, limit: opts.limit });

  const sql = await getConnection();
  const rows = (await sql`
    SELECT id, kind, agent, text, data, trace_id::text AS trace_id, span_id::text AS span_id,
           severity, created_at::text AS created_at, chain_hash, chain_key_version
    FROM genie_runtime_events_audit
    WHERE id > ${sinceId}
      AND tenant_id = ${tenantId}
    ORDER BY id ASC
    LIMIT ${opts.limit ?? 100_000}
  `) as unknown as AuditChainRow[];

  const canon = JSON.stringify({ verify, rows: rows.map(serializeRowForDigest) });
  const key =
    opts.secret ??
    process.env.GENIE_AUDIT_EXPORT_SECRET ??
    process.env.GENIE_EVENTS_TOKEN_SECRET ??
    'genie-export-fallback';
  const signature = createHmac('sha256', key).update(canon).digest('hex');

  return {
    generated_at: new Date().toISOString(),
    tenant_id: tenantId,
    since_id: sinceId,
    verify,
    rows,
    bundle_signature: signature,
    signer: opts.signer,
  };
}

function serializeRowForDigest(row: AuditChainRow): Record<string, unknown> {
  return {
    id: row.id,
    kind: row.kind,
    agent: row.agent,
    text: row.text,
    data: row.data,
    trace_id: row.trace_id,
    span_id: row.span_id,
    severity: row.severity,
    created_at: row.created_at,
    chain_hash: row.chain_hash ? row.chain_hash.toString('hex') : null,
    chain_key_version: row.chain_key_version,
  };
}
