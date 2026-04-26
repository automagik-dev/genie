/**
 * Derived signals — second-order observability events emitted by the rule
 * engine when the raw audit stream matches a known fingerprint.
 *
 * Wish: invincible-genie / Group 2.
 *
 * The reconciler emits raw events (`session.reconciled`,
 * `resume.missing_session`, `state_changed reason=dead_pane_zombie`,
 * `partition_health=fail`); nothing aggregates them into "the operator
 * needs to act" buckets. This module is the missing subscriber.
 *
 * Each rule lives in its own file. Detected signals are written back to
 * `audit_events` with `entity_type='derived_signal'`, `event_type=<signal>`,
 * so `genie status` reads them with the same machinery it reads everything
 * else — no new table, no new API surface.
 *
 * Per Decision #11 (Measurer's methodology rule), every signal documents:
 *   - **Consumer**: who renders it (always `genie status`).
 *   - **Green state**: when the signal is absent.
 *   - **Action threshold**: when the signal warrants a red badge / ack.
 */

/** All derived signal types this engine can emit. Closed enum. */
export type DerivedSignalType =
  /**
   * `session.reconciled` overwrote a session UUID on a terminal-state
   * executor — destroying recovery information. Fingerprint of the
   * `9623de43` corruption that prompted this wish.
   *
   * - Consumer: `genie status` red-flag section.
   * - Green: no `session.reconciled` event in the last hour where
   *   `old_session_id != new_session_id` AND old was non-null AND the
   *   executor was in a terminal state. Also covers the post-fix
   *   `session.divergence_preserved` event (same fingerprint, safer code
   *   path) so legacy + current code paths both light up.
   * - Action threshold: any single occurrence — this is the corruption
   *   signal, never benign.
   */
  | 'observability.recovery_anchor_at_risk'
  /**
   * Three or more consecutive `resume.missing_session` events for a single
   * agent within a 5 minute window. Indicates the resume chokepoint
   * cannot find a session UUID for that agent — operator should run
   * `genie agent resume <name>` manually or archive the row.
   *
   * - Consumer: `genie status` (per-agent line + red-flag section).
   * - Green: every agent has < 3 missing-session emissions in the last
   *   5 min.
   * - Action threshold: ≥ 3 within 5 min = signal fires once per agent
   *   (until the window slides clean).
   */
  | 'resume.lost_anchor'
  /**
   * Dead-pane zombies are reconciler-flipped agents whose tmux pane
   * vanished mid-run. A storm (rate > 5/hour) typically means a tmux
   * server crashed, the host reaper ran amok, or a watchdog mis-fired.
   *
   * - Consumer: `genie status` red-flag section.
   * - Green: < 5 `state_changed reason=dead_pane_zombie` events per hour.
   * - Action threshold: rate > 5/hour fires the signal; auto-clears once
   *   the rate drops below threshold for 1 hour.
   */
  | 'agents.zombie_storm'
  /**
   * Today's runtime-events partition is missing or rotation is overdue.
   * Polled from `collectObservabilityHealth().partition_health === 'fail'`
   * because the underlying state isn't in the audit stream.
   *
   * - Consumer: `genie status --health` and red-flag section.
   * - Green: `partition_health` is `'ok'` or `'warn'`.
   * - Action threshold: `'fail'` fires the signal — operator must run
   *   the partition rotation primitive immediately.
   */
  | 'observability.partition.missing';

/** Severity of a derived signal — used by `genie status` for color coding. */
export type DerivedSignalSeverity = 'info' | 'warn' | 'critical';

/** Default severity for each known signal type. */
export const SIGNAL_SEVERITY: Record<DerivedSignalType, DerivedSignalSeverity> = {
  'observability.recovery_anchor_at_risk': 'critical',
  'resume.lost_anchor': 'warn',
  'agents.zombie_storm': 'warn',
  'observability.partition.missing': 'critical',
};

/**
 * Stable subject string for a signal. `genie status` groups its red-flag
 * section by (type, subject) so a second `recovery_anchor_at_risk` for the
 * same executor doesn't render twice; for global signals, subject is the
 * literal string `'global'`.
 */
export interface DerivedSignal {
  type: DerivedSignalType;
  subject: string;
  severity: DerivedSignalSeverity;
  details: Record<string, unknown>;
  /**
   * ISO timestamp of the underlying audit event that triggered this
   * signal. Stable across re-detections so the audit log doesn't churn.
   */
  triggeredAt: string;
}

/**
 * Suggested drill-down command for each signal. `genie status` renders
 * this verbatim so the operator can copy/paste into the next prompt.
 */
export const SIGNAL_DRILLDOWN: Record<DerivedSignalType, string> = {
  'observability.recovery_anchor_at_risk': 'genie events timeline <executor-id>',
  'resume.lost_anchor': 'genie agent resume <name>',
  'agents.zombie_storm': 'genie prune --zombies',
  'observability.partition.missing': 'genie doctor --observability',
};
