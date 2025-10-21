"use strict";
/**
 * CLI Core Module - Pure handlers with zero side effects on import
 *
 * Addresses Genie RISK-1: genie.ts main() execution on import
 * Addresses Genie RISK-2: Session store concurrency via SessionService with file locking
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createHandlers = exports.SessionService = void 0;
var session_service_1 = require("./session-service");
Object.defineProperty(exports, "SessionService", { enumerable: true, get: function () { return session_service_1.SessionService; } });
const run_1 = require("./handlers/run");
const resume_1 = require("./handlers/resume");
const view_1 = require("./handlers/view");
const stop_1 = require("./handlers/stop");
const list_1 = require("./handlers/list");
/**
 * Factory function for creating CLI command handlers
 *
 * Returns an object with handler functions that can be called by both CLI and MCP server.
 * Handlers are pure functions that don't execute on import.
 */
function createHandlers(context) {
    return {
        run: (0, run_1.createRunHandler)(context),
        resume: (0, resume_1.createResumeHandler)(context),
        list: (0, list_1.createListHandler)(context),
        view: (0, view_1.createViewHandler)(context),
        stop: (0, stop_1.createStopHandler)(context)
    };
}
exports.createHandlers = createHandlers;
