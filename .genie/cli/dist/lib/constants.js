"use strict";
/**
 * Environment variable constants used for internal CLI communication
 *
 * These were previously in background-manager.ts but are preserved here
 * for backward compatibility during the Forge executor transition.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.INTERNAL_BACKGROUND_MARKER_ENV = exports.INTERNAL_SESSION_ID_ENV = exports.INTERNAL_LOG_PATH_ENV = exports.INTERNAL_START_TIME_ENV = exports.INTERNAL_BACKGROUND_ENV = void 0;
exports.INTERNAL_BACKGROUND_ENV = 'GENIE_AGENT_BACKGROUND_RUNNER';
exports.INTERNAL_START_TIME_ENV = 'GENIE_AGENT_START_TIME';
exports.INTERNAL_LOG_PATH_ENV = 'GENIE_AGENT_LOG_FILE';
// Propagate the pre-assigned session ID to the background runner so it updates
// the same store entry instead of creating a duplicate.
exports.INTERNAL_SESSION_ID_ENV = 'GENIE_AGENT_SESSION_ID';
exports.INTERNAL_BACKGROUND_MARKER_ENV = 'GENIE_INTERNAL_BACKGROUND';
