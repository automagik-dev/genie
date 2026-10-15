/**
 * Exhaustive sentinel — useful for switch statements so TS flags any
 * consumer that forgets to handle a new variant as the union grows.
 */
export const ALL_AGENT_EVENT_TYPES = [
    "AgentStart",
    "IterationStart",
    "IterationOutput",
    "ToolCallBefore",
    "ToolCallAfter",
    "Recurse",
    "Validation",
    "Message",
    "EmitDone",
    "Error",
    "SessionOpen",
    "SessionClose",
    "ToolCallObservation",
];
/** The 10 wish-spec event types. Session lifecycle types (SessionOpen /
 *  SessionClose) arrive in Group 2 as additions — `ALL_AGENT_EVENT_TYPES`
 *  above is the full current union, this constant stays frozen at the
 *  WISH.md L21 contract so regression tests can pin it. */
export const WISH_SPEC_EVENT_TYPES = [
    "AgentStart",
    "IterationStart",
    "IterationOutput",
    "ToolCallBefore",
    "ToolCallAfter",
    "Recurse",
    "Validation",
    "Message",
    "EmitDone",
    "Error",
];
/** ISO-8601 in UTC — identical across machines + easy for downstream parsing. */
export function iso(now = new Date()) {
    return now.toISOString();
}
/**
 * Build an event from a partial — the SDK internals call this instead
 * of writing object literals, so the timestamp + discriminant land
 * consistently and future additions (e.g. `spanId`) can be filled in
 * here without touching every call site.
 */
export function makeEvent(type, fields) {
    const { timestamp, ...rest } = fields;
    return { ...rest, type, timestamp: timestamp ?? iso() };
}
/**
 * Round-trip hardness check — used in tests. Every event must
 * serialize to JSON without losing its discriminant or timestamp.
 */
export function isAgentEvent(value) {
    if (!value || typeof value !== "object")
        return false;
    const v = value;
    return (typeof v.type === "string" &&
        typeof v.timestamp === "string" &&
        ALL_AGENT_EVENT_TYPES.includes(v.type));
}
//# sourceMappingURL=events.js.map