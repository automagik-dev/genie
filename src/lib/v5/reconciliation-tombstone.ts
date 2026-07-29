import { Buffer } from 'node:buffer';

export const RECONCILIATION_TOMBSTONE_PREFIX = 'genie:reconciliation-tombstone:v1:';
export const RECONCILIATION_TOMBSTONE_VALUE = 'deleted';

const MAX_ENCODED_KEY_BYTES = 4_096;

export interface ReconciliationTombstone {
  readonly table: 'hire_roster';
  readonly wish: string;
  readonly agentAdapterId: string;
}

export interface ReconciliationTombstoneMeta {
  readonly key: string;
  readonly value: typeof RECONCILIATION_TOMBSTONE_VALUE;
}

function tombstoneParts(tombstone: ReconciliationTombstone): readonly string[] {
  return [tombstone.wish, tombstone.agentAdapterId];
}

function encodedParts(parts: readonly string[]): string {
  const encoded = Buffer.from(JSON.stringify(parts), 'utf8').toString('base64url');
  if (Buffer.byteLength(encoded, 'utf8') > MAX_ENCODED_KEY_BYTES) invalidTombstone();
  return encoded;
}

export function reconciliationTombstoneMeta(tombstone: ReconciliationTombstone): ReconciliationTombstoneMeta {
  return {
    key: `${RECONCILIATION_TOMBSTONE_PREFIX}${tombstone.table}:${encodedParts(tombstoneParts(tombstone))}`,
    value: RECONCILIATION_TOMBSTONE_VALUE,
  };
}

function invalidTombstone(): never {
  throw new Error('Invalid reconciliation tombstone metadata.');
}

function decodedParts(encoded: string): readonly [string, string] {
  if (encoded.length === 0 || Buffer.byteLength(encoded, 'utf8') > MAX_ENCODED_KEY_BYTES) invalidTombstone();
  let parsed: unknown;
  try {
    const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
    parsed = JSON.parse(decoded);
    if (Buffer.from(decoded, 'utf8').toString('base64url') !== encoded) invalidTombstone();
  } catch {
    invalidTombstone();
  }
  if (!Array.isArray(parsed) || parsed.length !== 2 || parsed.some((part) => typeof part !== 'string')) {
    invalidTombstone();
  }
  return parsed as [string, string];
}

export function parseReconciliationTombstoneMeta(key: string, value: string): ReconciliationTombstone | null {
  if (!key.startsWith(RECONCILIATION_TOMBSTONE_PREFIX)) return null;
  if (value !== RECONCILIATION_TOMBSTONE_VALUE) invalidTombstone();
  const suffix = key.slice(RECONCILIATION_TOMBSTONE_PREFIX.length);
  const separator = suffix.indexOf(':');
  if (separator < 1) invalidTombstone();
  const table = suffix.slice(0, separator);
  const [first, second] = decodedParts(suffix.slice(separator + 1));
  if (table === 'hire_roster') return { table, wish: first, agentAdapterId: second };
  return invalidTombstone();
}
