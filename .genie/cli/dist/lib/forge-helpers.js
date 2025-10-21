"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.describeForgeError = exports.FORGE_RECOVERY_HINT = void 0;
exports.FORGE_RECOVERY_HINT = "Run 'genie forge restart' to recover the Automagik Forge backend.";
function describeForgeError(error) {
    if (error instanceof Error)
        return error.message;
    if (typeof error === 'string')
        return error;
    try {
        return JSON.stringify(error);
    }
    catch {
        return String(error);
    }
}
exports.describeForgeError = describeForgeError;
