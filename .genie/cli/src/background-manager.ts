/**
 * DEPRECATED: BackgroundManager stub for backward compatibility
 *
 * This file is preserved temporarily to prevent compilation errors during
 * the Forge executor transition. All functionality has been replaced by
 * Forge API in forge-executor.ts.
 *
 * TODO: Remove this file and all references to it in future cleanup.
 */

export { INTERNAL_BACKGROUND_ENV, INTERNAL_START_TIME_ENV, INTERNAL_LOG_PATH_ENV, INTERNAL_SESSION_ID_ENV, INTERNAL_BACKGROUND_MARKER_ENV } from './lib/constants';

/**
 * Stub BackgroundManager class (no-op)
 */
export default class BackgroundManager {
  constructor(_options?: any) {}

  launch(_options?: any): number {
    throw new Error('BackgroundManager is deprecated - use Forge executor instead');
  }

  isAlive(_pid: number | null | undefined): boolean {
    return false;
  }

  stop(_pid: number): boolean {
    return false;
  }
}

export { BackgroundManager };
