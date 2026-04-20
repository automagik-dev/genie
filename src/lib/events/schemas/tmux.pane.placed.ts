/**
 * Event: tmux.pane.placed — an agent was placed into a tmux pane (spawn or
 * re-attach). Correlates DB-registered agents with live terminal topology.
 */

import { z } from 'zod';
import { hashEntity } from '../redactors.js';
import { tagTier } from '../tier.js';

export const SCHEMA_VERSION = 1;
export const TYPE = 'tmux.pane.placed' as const;
export const KIND = 'event' as const;

const AgentIdSchema = tagTier(
  z
    .string()
    .min(1)
    .max(256)
    .transform((v) => hashEntity('agent', v)),
  'A',
);
const SessionSchema = tagTier(z.string().min(1).max(128), 'C', 'tmux session name — public');
const WindowIndexSchema = tagTier(z.number().int().min(0).max(256), 'C');
const PaneIndexSchema = tagTier(z.number().int().min(0).max(256), 'C');
const PaneIdSchema = tagTier(z.string().max(64).optional(), 'C', 'tmux pane id — public');
const ActionSchema = tagTier(z.enum(['spawn', 'attach', 'replace', 'split']), 'C');

export const schema = z
  .object({
    agent_id: AgentIdSchema,
    session: SessionSchema,
    window_index: WindowIndexSchema,
    pane_index: PaneIndexSchema,
    pane_id: PaneIdSchema,
    action: ActionSchema,
  })
  .strict();

export type TmuxPanePlacedPayload = z.infer<typeof schema>;
