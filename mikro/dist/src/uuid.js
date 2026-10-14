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
import { randomBytes } from "node:crypto";
/** Generate a time-ordered UUIDv7 string. */
export function uuidv7() {
    const ts = Date.now();
    const bytes = randomBytes(16);
    // 48-bit big-endian millisecond timestamp in bytes 0..5.
    bytes[0] = Math.floor(ts / 2 ** 40) & 0xff;
    bytes[1] = Math.floor(ts / 2 ** 32) & 0xff;
    bytes[2] = Math.floor(ts / 2 ** 24) & 0xff;
    bytes[3] = Math.floor(ts / 2 ** 16) & 0xff;
    bytes[4] = Math.floor(ts / 2 ** 8) & 0xff;
    bytes[5] = ts & 0xff;
    // Version 7 in the high nibble of byte 6.
    bytes[6] = (bytes[6] & 0x0f) | 0x70;
    // RFC 4122/9562 variant (10xx) in the high bits of byte 8.
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
//# sourceMappingURL=uuid.js.map