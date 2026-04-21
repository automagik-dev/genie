/**
 * Closed registry of all emittable event / span types.
 *
 * Group 2 ships 20 types: 7 span + 13 event. Five are fully elaborated
 * (`cli.command`, `agent.lifecycle`, `error.raised`, `state_transition`,
 * `schema.violation`); the other 15 are typed scaffolds that Group 3
 * replaces with fully elaborated schemas.
 *
 * Adding a new type = new file in `./schemas/` + import here. There is no
 * `.passthrough()`, no `z.any()`, and the lint rule enforces those absences.
 */

import type { z } from 'zod';

import * as agentLifecycle from './schemas/agent.lifecycle.js';
import * as auditExport from './schemas/audit.export.js';
import * as auditUnHash from './schemas/audit.un_hash.js';
import * as cacheHit from './schemas/cache.hit.js';
import * as cacheInvalidate from './schemas/cache.invalidate.js';
import * as cliCommand from './schemas/cli.command.js';
import * as consumerHeartbeat from './schemas/consumer.heartbeat.js';
import * as consumerLagged from './schemas/consumer.lagged.js';
import * as correlationOrphanRate from './schemas/correlation.orphan.rate.js';
import * as detectorDisabled from './schemas/detector.disabled.js';
import * as emitBackpressureCritical from './schemas/emit.backpressure.critical.js';
import * as emitterLatencyP99 from './schemas/emitter.latency_p99.js';
import * as emitterQueueDepth from './schemas/emitter.queue.depth.js';
import * as emitterRejected from './schemas/emitter.rejected.js';
import * as emitterSheddingLoad from './schemas/emitter.shedding_load.js';
import * as errorRaised from './schemas/error.raised.js';
import * as executorRowWritten from './schemas/executor.row.written.js';
import * as executorWrite from './schemas/executor.write.js';
import * as hookDelivery from './schemas/hook.delivery.js';
import * as mailboxDelivery from './schemas/mailbox.delivery.js';
import * as notifyDeliveryLag from './schemas/notify.delivery.lag.js';
import * as permissionsDeny from './schemas/permissions.deny.js';
import * as permissionsGrant from './schemas/permissions.grant.js';
import * as resumeAttempt from './schemas/resume.attempt.js';
import * as rotDetected from './schemas/rot.detected.js';
import * as rotExecutorGhostDetected from './schemas/rot.executor-ghost.detected.js';
import * as rotTeamLsDriftDetected from './schemas/rot.team-ls-drift.detected.js';
import * as runbookTriggered from './schemas/runbook.triggered.js';
import * as schemaViolation from './schemas/schema.violation.js';
import * as sessionIdWritten from './schemas/session.id.written.js';
import * as sessionReconciled from './schemas/session.reconciled.js';
import * as stateTransition from './schemas/state_transition.js';
import * as streamGapDetected from './schemas/stream.gap.detected.js';
import * as teamCreate from './schemas/team.create.js';
import * as teamDisband from './schemas/team.disband.js';
import * as tmuxPanePlaced from './schemas/tmux.pane.placed.js';
import * as wishDispatch from './schemas/wish.dispatch.js';

export type EventKind = 'span' | 'event';
export type EventTier = 'default' | 'debug' | 'audit';

export interface RegistryEntry<S extends z.ZodTypeAny = z.ZodTypeAny> {
  readonly type: string;
  readonly kind: EventKind;
  readonly schema: S;
  readonly schema_version: number;
  /** Storage routing: `audit` sinks into the WORM table when Group 5 lands. */
  readonly tier_defaults: EventTier;
}

function entry<S extends z.ZodTypeAny>(mod: {
  TYPE: string;
  KIND: EventKind;
  SCHEMA_VERSION: number;
  schema: S;
  DEFAULT_TIER?: EventTier;
}): RegistryEntry<S> {
  return {
    type: mod.TYPE,
    kind: mod.KIND,
    schema: mod.schema,
    schema_version: mod.SCHEMA_VERSION,
    tier_defaults: mod.DEFAULT_TIER ?? 'default',
  };
}

export const EventRegistry = {
  [cliCommand.TYPE]: entry(cliCommand),
  [agentLifecycle.TYPE]: entry(agentLifecycle),
  [wishDispatch.TYPE]: entry(wishDispatch),
  [hookDelivery.TYPE]: entry(hookDelivery),
  [resumeAttempt.TYPE]: entry(resumeAttempt),
  [executorWrite.TYPE]: entry(executorWrite),
  [mailboxDelivery.TYPE]: entry(mailboxDelivery),

  [errorRaised.TYPE]: entry(errorRaised),
  [stateTransition.TYPE]: entry(stateTransition),
  [schemaViolation.TYPE]: entry(schemaViolation),
  [sessionIdWritten.TYPE]: entry(sessionIdWritten),
  [sessionReconciled.TYPE]: entry(sessionReconciled),
  [tmuxPanePlaced.TYPE]: entry(tmuxPanePlaced),
  [executorRowWritten.TYPE]: entry(executorRowWritten),
  [cacheInvalidate.TYPE]: entry(cacheInvalidate),
  [cacheHit.TYPE]: entry(cacheHit),
  [runbookTriggered.TYPE]: entry(runbookTriggered),
  [consumerHeartbeat.TYPE]: entry(consumerHeartbeat),
  [permissionsGrant.TYPE]: entry(permissionsGrant),
  [permissionsDeny.TYPE]: entry(permissionsDeny),
  [teamCreate.TYPE]: entry(teamCreate),
  [teamDisband.TYPE]: entry(teamDisband),

  // Group 5 sentinel H6 — "audit the auditors" events.
  [auditUnHash.TYPE]: entry(auditUnHash),
  [auditExport.TYPE]: entry(auditExport),

  // Group 6 watcher-of-watcher meta events.
  [emitterRejected.TYPE]: entry(emitterRejected),
  [emitterQueueDepth.TYPE]: entry(emitterQueueDepth),
  [emitterLatencyP99.TYPE]: entry(emitterLatencyP99),
  [notifyDeliveryLag.TYPE]: entry(notifyDeliveryLag),
  [streamGapDetected.TYPE]: entry(streamGapDetected),
  [correlationOrphanRate.TYPE]: entry(correlationOrphanRate),

  // Group 6 back-pressure companion events.
  [emitterSheddingLoad.TYPE]: entry(emitterSheddingLoad),
  [consumerLagged.TYPE]: entry(consumerLagged),
  [emitBackpressureCritical.TYPE]: entry(emitBackpressureCritical),

  // Self-healing B1 Group 2 — detector lifecycle meta-events.
  [detectorDisabled.TYPE]: entry(detectorDisabled),

  // Self-healing B1 Group 3a/3c — shared rot-detection event.
  [rotDetected.TYPE]: entry(rotDetected),

  // Self-healing B1 Group 3b — team-ls vs team-disband drift detector.
  [rotTeamLsDriftDetected.TYPE]: entry(rotTeamLsDriftDetected),

  // fix-executor-ghost-on-reinstall — resolver fallback + boot reconciler
  // emit this when GENIE_EXECUTOR_ID fails to resolve but agent_id lookup
  // succeeds. See `turn-close.ts#turnClose` and the boot reconciler (F).
  [rotExecutorGhostDetected.TYPE]: entry(rotExecutorGhostDetected),
} as const satisfies Record<string, RegistryEntry>;

export type EventType = keyof typeof EventRegistry;
export type SpanType = {
  [K in EventType]: (typeof EventRegistry)[K]['kind'] extends 'span' ? K : never;
}[EventType];
export type PointEventType = {
  [K in EventType]: (typeof EventRegistry)[K]['kind'] extends 'event' ? K : never;
}[EventType];

export function getEntry(type: string): RegistryEntry | null {
  return (EventRegistry as Record<string, RegistryEntry>)[type] ?? null;
}

export function isRegistered(type: string): type is EventType {
  return Object.hasOwn(EventRegistry, type);
}

export function listTypes(): EventType[] {
  return Object.keys(EventRegistry) as EventType[];
}
