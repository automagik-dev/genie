/**
 * Per-step runner — enforces the check → apply → validate contract,
 * records outcome to the store, returns structured result.
 */

import type { MigrationContext, MigrationModule } from './discover.js';
import { getApplied, recordApplied, recordFailed } from './store.js';

export type StepStatus = 'APPLIED' | 'SKIP' | 'NO-OP' | 'FAIL' | 'DRY-RUN';

export interface StepResult {
  id: string;
  status: StepStatus;
  detail: string;
}

export async function runMigration(mod: MigrationModule, ctx: MigrationContext, version: string): Promise<StepResult> {
  const applied = getApplied();
  const prior = applied.get(mod.id);
  if (prior?.status === 'APPLIED') {
    ctx.log(`[${mod.id}] SKIP: already applied at ${prior.appliedAt}`);
    return { id: mod.id, status: 'SKIP', detail: `already applied at ${prior.appliedAt}` };
  }

  let needsApply: boolean;
  try {
    needsApply = await mod.check(ctx);
  } catch (err) {
    const msg = (err as Error).message;
    ctx.warn(`[${mod.id}] FAIL during check: ${msg}`);
    recordFailed(mod.id, version, `check threw: ${msg}`);
    return { id: mod.id, status: 'FAIL', detail: `check threw: ${msg}` };
  }

  if (!needsApply) {
    ctx.log(`[${mod.id}] NO-OP: check returned false (host already in target state)`);
    recordApplied(mod.id, version, 'no-op (check returned false)');
    return { id: mod.id, status: 'NO-OP', detail: 'check returned false' };
  }

  if (ctx.dryRun) {
    ctx.log(`[${mod.id}] DRY-RUN: would apply — ${mod.description}`);
    return { id: mod.id, status: 'DRY-RUN', detail: mod.description };
  }

  try {
    await mod.apply(ctx);
  } catch (err) {
    const msg = (err as Error).message;
    ctx.warn(`[${mod.id}] FAIL during apply: ${msg}`);
    recordFailed(mod.id, version, `apply threw: ${msg}`);
    return { id: mod.id, status: 'FAIL', detail: `apply threw: ${msg}` };
  }

  try {
    await mod.validate(ctx);
  } catch (err) {
    const msg = (err as Error).message;
    ctx.warn(`[${mod.id}] FAIL during validate: ${msg}`);
    recordFailed(mod.id, version, `validate threw: ${msg}`);
    return { id: mod.id, status: 'FAIL', detail: `validate threw: ${msg}` };
  }

  recordApplied(mod.id, version, mod.description);
  ctx.log(`[${mod.id}] APPLIED: ${mod.description}`);
  return { id: mod.id, status: 'APPLIED', detail: mod.description };
}
