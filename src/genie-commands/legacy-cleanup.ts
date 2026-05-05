/**
 * Legacy artifact cleanup registry.
 *
 * Day-one registry is intentionally empty for genie — the primitive lives
 * here so future migrations (orphaned tmux configs, stale plugin caches, …)
 * can plug in via the `LegacyArtifact` interface, and the sibling omni
 * wish (see `.genie/wishes/update-unify-stages/SHARED-DESIGN.md` decision #5)
 * absorbs the type signature verbatim.
 */

export interface LegacyArtifact {
  readonly name: string;
  detect(): Promise<boolean>;
  cleanup(): Promise<{ removed: string[]; warnings: string[] }>;
  summary(): string;
}

export type CleanupOutcome = 'cleaned' | 'skipped' | 'absent';

export interface CleanupEntry {
  name: string;
  outcome: CleanupOutcome;
  removed: string[];
  warnings: string[];
}

export interface CleanupReport {
  entries: CleanupEntry[];
}

export const REGISTRY: LegacyArtifact[] = [];

export async function cleanupLegacyArtifacts(
  skipList: Set<string>,
  registry: LegacyArtifact[] = REGISTRY,
): Promise<CleanupReport> {
  const entries: CleanupEntry[] = [];
  for (const artifact of registry) {
    if (skipList.has(artifact.name)) {
      entries.push({ name: artifact.name, outcome: 'skipped', removed: [], warnings: [] });
      continue;
    }
    const present = await artifact.detect();
    if (!present) {
      entries.push({ name: artifact.name, outcome: 'absent', removed: [], warnings: [] });
      continue;
    }
    const result = await artifact.cleanup();
    entries.push({
      name: artifact.name,
      outcome: 'cleaned',
      removed: result.removed,
      warnings: result.warnings,
    });
  }
  return { entries };
}

export function parseSkipCleanupFlag(value: string | undefined): Set<string> {
  const skip = new Set<string>();
  if (!value) return skip;
  for (const part of value.split(',')) {
    const name = part.trim();
    if (name) skip.add(name);
  }
  return skip;
}
