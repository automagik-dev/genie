"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FORGE_RECOVERY_HINT = void 0;
exports.describeForgeError = describeForgeError;
exports.FORGE_RECOVERY_HINT = "Forge backend connection failed. Try running 'genie' again to restart Forge, or check if another Genie instance is running.";
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
