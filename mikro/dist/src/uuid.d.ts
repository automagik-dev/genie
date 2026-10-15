/**
 * UUIDv7 generator — time-ordered, k-sortable identifiers.
 *
 * Node's `crypto.randomUUID()` only emits v4 (fully random, unsortable).
 * Recursion correlation ids are used as ancestry keys in the live event
 * stream (see `src/sdk/events.ts`), and a sortable id lets consumers order
 * sibling spawns by spawn time without a separate timestamp compare. This
 * is a dependency-free RFC 9562 §5.7 implementation: a 48-bit big-endian
 * Unix-millisecond timestamp, version `7`, the RFC variant bits, and 74
 * bits of randomness.
 */
/** Generate a time-ordered UUIDv7 string. */
export declare function uuidv7(): string;
//# sourceMappingURL=uuid.d.ts.map