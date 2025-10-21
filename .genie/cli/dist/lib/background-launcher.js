"use strict";
/**
 * DEPRECATED: Background launcher stub for backward compatibility
 *
 * This file is preserved temporarily for old commands/ directory imports.
 * All functionality has been replaced by Forge API in forge-executor.ts.
 *
 * TODO: Remove this file and migrate commands/ to use handlers/ instead.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.maybeHandleBackgroundLaunch = maybeHandleBackgroundLaunch;
/**
 * Stub function - throws error directing users to use Forge
 */
async function maybeHandleBackgroundLaunch(_params) {
    throw new Error('Legacy background launcher is deprecated - use Forge executor via handlers/ instead');
}
