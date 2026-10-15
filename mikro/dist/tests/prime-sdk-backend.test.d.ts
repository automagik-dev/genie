/**
 * Prime SDK backend — the in-process leg's own machinery.
 *
 * `tests/backend-contract.test.ts` proves the HOST-VISIBLE surface is
 * identical across every backend, driving this one through its engine seam.
 * This file proves the layer underneath that seam: the mikro → prime mapping,
 * the event-driven budget enforcement, the answer channel, and the scratch
 * lifecycle — all against an injected fake SDK, so the suite never needs a
 * real prime-agent install or a network call.
 *
 * The fake implements exactly `PrimeSdkModule`, the structural contract the
 * backend declares. That is the point of declaring it structurally: if the
 * backend starts using a part of prime's API the fake does not implement,
 * this suite stops compiling rather than passing against a fiction.
 *
 * Every event shape and every behavior asserted here was probed live against
 * the installed prime-agent 0.8.1 before being written down — notably the two
 * that are easy to get wrong and impossible to notice:
 *
 *   1. `tools` is an allowlist that gates CUSTOM tools too, so `emit_done`
 *      must always be named in it or the answer channel silently vanishes;
 *   2. `message_end` and the `turn_end` that follows carry the SAME assistant
 *      message and the SAME usage, so usage must be counted once.
 */
export {};
//# sourceMappingURL=prime-sdk-backend.test.d.ts.map