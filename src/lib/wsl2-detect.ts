/**
 * WSL2 environment detection.
 *
 * Genie on WSL2 experiences slower pgserve startup due to I/O characteristics.
 * This utility detects WSL2 and allows callers to adjust timeouts accordingly.
 */

import { readFileSync } from 'node:fs';

let memoized: boolean | null = null;

/**
 * Detect if running on WSL2 by checking /proc/version for "microsoft" or "wsl".
 * Result is memoized for performance.
 *
 * @returns true if running on WSL2, false otherwise
 */
export function isWSL2(): boolean {
  // Return memoized result if already computed
  if (memoized !== null) return memoized;

  try {
    const procVersion = readFileSync('/proc/version', 'utf-8');
    memoized = procVersion.toLowerCase().includes('microsoft') || procVersion.toLowerCase().includes('wsl');
    return memoized;
  } catch {
    // /proc/version not readable (non-Linux or permission issue) — assume not WSL2
    memoized = false;
    return false;
  }
}
