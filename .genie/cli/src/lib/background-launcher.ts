/**
 * DEPRECATED: Background launcher stub for backward compatibility
 *
 * This file is preserved temporarily for old commands/ directory imports.
 * All functionality has been replaced by Forge API in forge-executor.ts.
 *
 * TODO: Remove this file and migrate commands/ to use handlers/ instead.
 */

export interface BackgroundLaunchArgs {
  parsed: { options: any };
  config: any;
  paths: any;
  store: any;
  entry: any;
  agentName: string;
  executorKey: string;
  executionMode: string;
  startTime: number;
  logFile: string;
  allowResume: boolean;
  prompt?: string;
}

/**
 * Stub function - throws error directing users to use Forge
 */
export async function maybeHandleBackgroundLaunch(_params: BackgroundLaunchArgs): Promise<boolean> {
  throw new Error('Legacy background launcher is deprecated - use Forge executor via handlers/ instead');
}
