import { z } from 'zod';

const text = z.string();
const nullable = text.nullable();
const time = z.number().finite().nonnegative();
const id = text.regex(/^t_[a-z0-9]+$/);
const status = z.enum(['blocked', 'ready', 'in_progress', 'done']);
const event = z
  .object({ id: time.int(), kind: text, note: nullable, authorKind: nullable, author: nullable, createdAt: time })
  .strict();
export const cardSchema = z
  .object({
    id,
    boardId: nullable,
    title: text,
    status,
    claimedBy: nullable,
    claimedAt: time.nullable(),
    wish: nullable,
    group: nullable,
    assignedAgent: nullable,
    assignedReason: nullable,
    createdAt: time,
    updatedAt: time,
    lane: nullable,
    enforcedBlock: z
      .object({ reason: text, kind: z.enum(['work', 'hold']) })
      .strict()
      .nullable(),
    agentKind: nullable,
    heartbeatAt: time.nullable(),
    blockedBy: nullable,
    blockedReason: nullable,
    liveness: z.enum(['running', 'idle', 'stale']).nullable(),
    dependencies: z.array(z.object({ id, title: text, status }).strict()),
    timeline: z.array(event),
    comments: z.array(
      event
        .omit({ kind: true })
        .extend({ note: text.min(1) })
        .strict(),
    ),
  })
  .strict();
export const aggregateSchema = z
  .object({
    schemaVersion: z.literal(1),
    scope: text,
    lanes: z
      .array(z.object({ name: text.min(1), label: nullable, action: nullable, cards: z.array(cardSchema) }).strict())
      .min(1),
  })
  .strict()
  .superRefine((board, ctx) => {
    const names = board.lanes.map((lane) => lane.name);
    const ids = board.lanes.flatMap((lane) => lane.cards.map((card) => card.id));
    if (new Set(names).size !== names.length || new Set(ids).size !== ids.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate lane or card' });
  });
export const boardsSchema = z.array(
  z.object({ id: text.regex(/^b_[a-z0-9]+$/), name: text, laneCount: time.int(), cardCount: time.int() }).strict(),
);
const bounded = (max: number) =>
  text
    .refine(
      (value) =>
        !Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127),
      'Control characters are not allowed',
    )
    .transform((value) => value.trim())
    .refine(
      (value) =>
        value.length > 0 &&
        Buffer.byteLength(value) <= max &&
        !Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127),
      'Invalid text',
    );
const base = { workspaceId: text.min(1).max(200), boardRef: text.regex(/^b_[a-z0-9]+$/) };
export const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list'), workspaceId: base.workspaceId }).strict(),
  z.object({ action: z.literal('load'), ...base }).strict(),
  z.object({ action: z.literal('create'), ...base, title: bounded(200) }).strict(),
  z.object({ action: z.literal('move'), ...base, id, lane: text.min(1).max(200) }).strict(),
  z.object({ action: z.literal('comment'), ...base, id, text: bounded(4000) }).strict(),
  z.object({ action: z.literal('block'), ...base, id, text: bounded(1000), hold: z.boolean().optional() }).strict(),
  ...(['unblock', 'checkout', 'release', 'done'] as const).map((action) =>
    z.object({ action: z.literal(action), ...base, id }).strict(),
  ),
]);
export type Request = z.infer<typeof requestSchema>;
export type Aggregate = z.infer<typeof aggregateSchema>;
