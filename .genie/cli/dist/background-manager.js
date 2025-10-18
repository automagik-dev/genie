"use strict";
/**
 * DEPRECATED: BackgroundManager stub for backward compatibility
 *
 * This file is preserved temporarily to prevent compilation errors during
 * the Forge executor transition. All functionality has been replaced by
 * Forge API in forge-executor.ts.
 *
 * TODO: Remove this file and all references to it in future cleanup.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.BackgroundManager = exports.INTERNAL_BACKGROUND_MARKER_ENV = exports.INTERNAL_SESSION_ID_ENV = exports.INTERNAL_LOG_PATH_ENV = exports.INTERNAL_START_TIME_ENV = exports.INTERNAL_BACKGROUND_ENV = void 0;
var constants_1 = require("./lib/constants");
Object.defineProperty(exports, "INTERNAL_BACKGROUND_ENV", { enumerable: true, get: function () { return constants_1.INTERNAL_BACKGROUND_ENV; } });
Object.defineProperty(exports, "INTERNAL_START_TIME_ENV", { enumerable: true, get: function () { return constants_1.INTERNAL_START_TIME_ENV; } });
Object.defineProperty(exports, "INTERNAL_LOG_PATH_ENV", { enumerable: true, get: function () { return constants_1.INTERNAL_LOG_PATH_ENV; } });
Object.defineProperty(exports, "INTERNAL_SESSION_ID_ENV", { enumerable: true, get: function () { return constants_1.INTERNAL_SESSION_ID_ENV; } });
Object.defineProperty(exports, "INTERNAL_BACKGROUND_MARKER_ENV", { enumerable: true, get: function () { return constants_1.INTERNAL_BACKGROUND_MARKER_ENV; } });
/**
 * Stub BackgroundManager class (no-op)
 */
class BackgroundManager {
    constructor(_options) { }
    launch(_options) {
        throw new Error('BackgroundManager is deprecated - use Forge executor instead');
    }
    isAlive(_pid) {
        return false;
    }
    stop(_pid) {
        return false;
    }
}
exports.default = BackgroundManager;
exports.BackgroundManager = BackgroundManager;
