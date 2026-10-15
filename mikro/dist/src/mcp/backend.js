/**
 * Runtime backend seam — Wish mikro-v2-prime-backend Group 1.
 *
 * The MCP server used to call `rlmLoop` directly; it now calls a backend.
 * That inversion is the whole point of this module: the server owns the
 * MCP contract (tools, sessions, result shape, progress presentation) and a
 * backend owns "what actually executes the turn", so a second engine can
 * slot in behind the same host-visible surface.
 *
 */
/** Failed backend operation carrying only actual observed receipts, never a fabricated zero. */
export class BackendRunError extends Error {
    receipt;
    constructor(message, receipt, options) {
        super(message, options);
        this.receipt = receipt;
        this.name = "BackendRunError";
    }
}
//# sourceMappingURL=backend.js.map