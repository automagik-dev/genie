import path from 'path';
import { promises as fsp } from 'fs';
import { execSync } from 'child_process';
import { toIsoId } from '../fs-utils';
import type { FrameworkDiff, UpgradeContext, UpgradeResult, ConflictInfo, FrameworkVersion } from './types';

/**
 * Apply upgrade diff to workspace
 */
export async function applyUpgrade(
  diff: FrameworkDiff,
  context: UpgradeContext
): Promise<UpgradeResult> {
  const { workspacePath, oldVersion, newVersion } = context;

  // Backup .genie directory
  const backupId = await backupGenieDirectory(workspacePath);

  try {
    // Test if patch applies cleanly
    execSync(`git apply --check ${diff.patchFile}`, {
      cwd: workspacePath,
      stdio: 'pipe'
    });

    // Clean apply - no conflicts
    execSync(`git apply ${diff.patchFile}`, {
      cwd: workspacePath,
      stdio: 'pipe'
    });

    // Update .framework-version
    await updateFrameworkVersion(workspacePath, oldVersion, newVersion, context);

    // Clean up temp patch file
    await fsp.unlink(diff.patchFile).catch(() => {});

    return {
      success: true,
      filesUpdated: diff.affectedFiles.length,
      filesPreserved: 0, // TODO: Count user files
      conflicts: [],
      backupId
    };
  } catch (error) {
    // Conflicts detected
    const conflicts = parseConflicts(error, diff.affectedFiles);

    return {
      success: false,
      filesUpdated: 0,
      filesPreserved: 0,
      conflicts,
      backupId
    };
  }
}

/**
 * Backup .genie directory before upgrade
 * Returns backup ID for tracking
 */
async function backupGenieDirectory(workspacePath: string): Promise<string> {
  const genieDir = path.join(workspacePath, '.genie');
  const backupId = toIsoId();
  const backupDir = path.join(workspacePath, `.genie.backup-${backupId}`);

  try {
    // Use cp -r for recursive copy
    execSync(`cp -r "${genieDir}" "${backupDir}"`, { stdio: 'pipe' });
    return backupId;
  } catch (error) {
    throw new Error(
      `Failed to backup .genie directory: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Update .framework-version file
 */
async function updateFrameworkVersion(
  workspacePath: string,
  oldVersion: string,
  newVersion: string,
  context: UpgradeContext
): Promise<void> {
  const versionPath = path.join(workspacePath, '.genie', '.framework-version');

  const now = new Date().toISOString();

  // Read existing version data (if exists)
  let existingData: Partial<FrameworkVersion> = {};
  try {
    const existingContent = await fsp.readFile(versionPath, 'utf8');
    existingData = JSON.parse(existingContent);
  } catch {
    // File doesn't exist or is invalid, start fresh
  }

  const versionData: FrameworkVersion = {
    installed_version: newVersion,
    installed_commit: context.newCommit,
    installed_date: existingData.installed_date || now,
    package_name: 'automagik-genie',
    customized_files: existingData.customized_files || [],
    deleted_files: existingData.deleted_files || [],
    last_upgrade_date: now,
    previous_version: oldVersion,
    upgrade_history: [
      ...(existingData.upgrade_history || []),
      {
        from: oldVersion,
        to: newVersion,
        date: now,
        success: true
      }
    ]
  };

  await fsp.writeFile(versionPath, JSON.stringify(versionData, null, 2), 'utf8');
}

/**
 * Parse conflicts from git apply error output
 */
function parseConflicts(error: any, affectedFiles: string[]): ConflictInfo[] {
  const errorMessage = error instanceof Error ? error.message : String(error);

  // Git apply error format: "error: patch failed: .genie/spells/learn.md:15"
  const conflictPattern = /error: patch failed: (.+?):(\d+)/g;
  const matches = [...errorMessage.matchAll(conflictPattern)];

  if (matches.length === 0) {
    // Generic error, assume all files conflicted
    return affectedFiles.map(file => ({
      file,
      hunks: [],
      reason: 'Failed to apply patch'
    }));
  }

  return matches.map(match => ({
    file: match[1],
    hunks: [`Line ${match[2]}`],
    reason: 'User modification conflicts with upstream changes'
  }));
}
