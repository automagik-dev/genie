import { type ZodError, z } from 'zod';

/** The aggregate contract this plugin speaks. A different version means stop. */
export const SCHEMA_VERSION = 1;
/**
 * The one message a laneless board produces. `genie board --board <id> --json`
 * answers a board without usable lane metadata with the frozen `{scope, columns}`
 * payload instead of the lane aggregate, and exits 0 — so the plugin recognises
 * that payload and says so, rather than reporting a schema failure.
 */
export const LANELESS_MESSAGE =
  'This board has no usable lane metadata, so it cannot be shown as lanes. Repair its lanes in Genie (or create a board with lanes) and try again.';

const text = z.string();
const nullable = text.nullable();
const time = z.number().finite().nonnegative();
/**
 * An identifier exactly as Genie may emit it. `task import` stores ids as
 * unvalidated TEXT, so a shape rule stricter than Genie's own would make a
 * whole board unopenable (F5). The plugin therefore bounds the length and
 * refuses only what its own argv handling cares about: control characters and
 * a leading `-`, which commander would read as an option.
 */
const identifier = text
  .min(1)
  .max(200)
  .refine((value) => !/\p{Cc}/u.test(value), 'identifiers must not contain control characters')
  .refine((value) => !value.startsWith('-'), 'identifiers must not start with a dash');
const status = z.enum(['blocked', 'ready', 'in_progress', 'done']);
const event = z
  .object({ id: time.int(), kind: text, note: nullable, authorKind: nullable, author: nullable, createdAt: time })
  .passthrough();
export const cardSchema = z
  .object({
    id: identifier,
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
      .passthrough()
      .nullable(),
    agentKind: nullable,
    heartbeatAt: time.nullable(),
    blockedBy: nullable,
    blockedReason: nullable,
    liveness: z.enum(['running', 'idle', 'stale']).nullable(),
    dependencies: z.array(z.object({ id: identifier, title: text, status }).passthrough()),
    // The newest window of a possibly longer history; the two counts describe
    // the whole card, so the view can say "showing last N of M".
    timeline: z.array(event),
    eventCount: time.int(),
    eventsTruncated: z.boolean(),
    // A comment note may be the empty string. The CLI refuses one
    // (`task comment -- <id> ''` exits 1 with "a non-empty comment is
    // required."), so an empty note only ever reaches the aggregate through
    // imported data (`task import` of a snapshot that carries one), which the
    // aggregate then emits verbatim — so the schema must still accept it.
    comments: z.array(event.omit({ kind: true }).extend({ note: text }).passthrough()),
    commentCount: time.int(),
  })
  .passthrough();
/**
 * The board aggregate. Every object passes unknown keys through: the emitter's
 * contract is additive under `schemaVersion` 1, so a genie release that adds a
 * key must not break an installed plugin (F11). Lane names may repeat —
 * `genie board create X --lanes A,A` produces exactly that — so the view
 * dedupes on render instead of refusing the board.
 */
export const aggregateSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    scope: text,
    lanes: z
      .array(
        z.object({ name: text.min(1), label: nullable, action: nullable, cards: z.array(cardSchema) }).passthrough(),
      )
      .min(1),
  })
  .passthrough();
export const boardsSchema = z.array(
  z.object({ id: identifier, name: text, laneCount: time.int(), cardCount: time.int() }).passthrough(),
);
/**
 * Text typed into the browser. The CLI persists newlines, tabs and format
 * characters (ZWJ, soft hyphen) verbatim, so the plugin accepts them too and
 * refuses only the C0 controls plus DEL that no argv should carry (F12).
 */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    // Tab, line feed and carriage return are text; every other C0 code
    // point, and DEL, is not. Written as arithmetic, not as a regex with
    // literal control characters in the source.
    if (code === 0x7f || (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d)) return true;
  }
  return false;
}
const bounded = (max: number) =>
  text
    .refine((value) => !hasControlCharacter(value), 'must not contain control characters')
    .transform((value) => value.trim())
    .refine((value) => value.length > 0, 'must not be empty')
    .refine((value) => Buffer.byteLength(value) <= max, `must be at most ${max} bytes`);
const base = { workspaceId: text.min(1).max(200), boardRef: identifier };
export const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list'), workspaceId: base.workspaceId }).strict(),
  z.object({ action: z.literal('load'), ...base }).strict(),
  z.object({ action: z.literal('create'), ...base, title: bounded(200) }).strict(),
  z.object({ action: z.literal('move'), ...base, id: identifier, lane: text.min(1).max(200) }).strict(),
  z.object({ action: z.literal('comment'), ...base, id: identifier, text: bounded(4000) }).strict(),
  z
    .object({ action: z.literal('block'), ...base, id: identifier, text: bounded(1000), hold: z.boolean().optional() })
    .strict(),
  ...(['unblock', 'checkout', 'release', 'done'] as const).map((action) =>
    z.object({ action: z.literal(action), ...base, id: identifier }).strict(),
  ),
]);
export type Request = z.infer<typeof requestSchema>;
export type Aggregate = z.infer<typeof aggregateSchema>;
export type Boards = z.infer<typeof boardsSchema>;

/**
 * One human sentence for a Zod failure. The browser shows whatever the Host
 * puts in the 400 body, and a raw issues array there is unreadable and loses
 * the user's typed text (F12), so exactly one issue becomes the message.
 */
export function describeIssues(error: ZodError, subject: string): string {
  const issue = error.issues[0];
  if (!issue) return `${subject}.`;
  const path = issue.path.filter((part) => typeof part !== 'number').join('.');
  const extra = error.issues.length > 1 ? ` (and ${error.issues.length - 1} more)` : '';
  return `${subject}: ${path ? `${path} ` : ''}${issue.message}${extra}.`;
}
function parseWith<Output>(
  schema: { safeParse(value: unknown): z.SafeParseReturnType<unknown, Output> },
  value: unknown,
  subject: string,
): Output {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new Error(describeIssues(result.error, subject));
}
/** Validate one browser request, reporting the first problem as a sentence. */
export function parseRequest(input: unknown): Request {
  return parseWith(requestSchema, input, 'Invalid request');
}
/** Validate `board list --json`. */
export function parseBoards(output: string): Boards {
  return parseWith(boardsSchema, parseJson(output), 'Genie board list is unreadable');
}
/**
 * Validate `board --board <id> --json`. Two producer answers are recognised
 * before the schema runs, so neither reaches the browser as a schema failure:
 * a newer aggregate contract, and the frozen laneless payload.
 */
export function parseAggregate(output: string): Aggregate {
  const value = parseJson(output);
  const version = isRecord(value) ? value.schemaVersion : undefined;
  if (typeof version === 'number' && version !== SCHEMA_VERSION)
    throw new Error(
      `Incompatible genie output (schemaVersion ${version}, expected ${SCHEMA_VERSION}). Update the Genie board plugin.`,
    );
  if (version === undefined && isRecord(value) && 'columns' in value) throw new Error(LANELESS_MESSAGE);
  return parseWith(aggregateSchema, value, 'Genie board output is unreadable');
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
function parseJson(output: string): unknown {
  try {
    return JSON.parse(output);
  } catch {
    throw new Error('Genie returned output that is not JSON.');
  }
}
