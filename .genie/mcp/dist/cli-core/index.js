"use strict";
/**
 * CLI Core Module - Pure handlers with zero side effects on import
 *
 * Addresses Twin RISK-1: genie.ts main() execution on import
 * Addresses Twin RISK-2: Session store concurrency via SessionService with file locking
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionService = void 0;
exports.createHandlers = createHandlers;
var session_service_1 = require("./session-service");
Object.defineProperty(exports, "SessionService", { enumerable: true, get: function () { return session_service_1.SessionService; } });
/**
 * Factory function for creating CLI command handlers
 *
 * Returns an object with handler functions that can be called by both CLI and MCP server.
 * Handlers are pure functions that don't execute on import.
 */
function createHandlers(_context) {
    // TODO: Complete handler extraction from genie.ts
    // For now, return empty object to satisfy type checking
    // Full extraction deferred to unblock MCP server development
    return {
        run: null,
        resume: null,
        list: null,
        view: null,
        stop: null
    };
}
