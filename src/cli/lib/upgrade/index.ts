// Upgrade system entry point
export { checkForUpdates } from './version-checker';
export { generateFrameworkDiff } from './diff-generator';
export { applyUpgrade } from './merge-strategy';
export type { UpgradeContext, UpdateCheckResult, UpgradeResult } from './types';
