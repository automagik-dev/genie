export interface UpgradeContext {
  oldVersion: string;
  newVersion: string;
  oldCommit: string;
  newCommit: string;
  workspacePath: string;
}

export interface UpdateCheckResult {
  available: boolean;
  latestVersion: string;
  latestCommit: string;
  changes: string[];
}

export interface FrameworkDiff {
  hasChanges: boolean;
  patchFile: string;
  affectedFiles: string[];
}

export interface ConflictInfo {
  file: string;
  hunks: string[];
  reason: string;
}

export interface UpgradeResult {
  success: boolean;
  filesUpdated: number;
  filesPreserved: number;
  conflicts: ConflictInfo[];
}

export interface FrameworkVersion {
  installed_version: string;
  installed_commit: string;
  installed_date: string;
  package_name: string;
  customized_files: string[];
  deleted_files: string[];
  last_upgrade_date: string | null;
  previous_version: string | null;
  upgrade_history: Array<{
    from: string;
    to: string;
    date: string;
    success: boolean;
  }>;
}
