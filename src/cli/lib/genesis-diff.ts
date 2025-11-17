/**
 * Genesis Diff Generator - Non-destructive framework update comparison
 *
 * Compares LOCAL workspace files vs UPSTREAM package template
 * WITHOUT copying or modifying any files. Pure information generation.
 *
 * This is the foundation for agent-driven framework updates.
 */

import path from 'path';
import { promises as fsp } from 'fs';
import { pathExists, collectFiles, toIsoId, ensureDir } from './fs-utils';
import { execSync } from 'child_process';

interface FileDiff {
  path: string;
  status: 'added' | 'removed' | 'modified' | 'unchanged';
  oldSize?: number;
  newSize?: number;
  oldContent?: string;
  newContent?: string;
}

interface GenesisDiffResult {
  diffPath: string;
  diffId: string;
  summary: {
    added: number;
    removed: number;
    modified: number;
    unchanged: number;
  };
  hasChanges: boolean;
}

/**
 * Generate genesis diff between workspace and upstream package template
 *
 * NO DESTRUCTIVE OPERATIONS - only reads files and generates report
 *
 * @param workspacePath - User's project root
 * @param packageRoot - Genie package installation directory
 * @param oldVersion - Current installed version
 * @param newVersion - New package version
 * @returns Diff result with path to generated diff file
 */
export async function generateGenesisDiff(
  workspacePath: string,
  packageRoot: string,
  oldVersion: string,
  newVersion: string
): Promise<GenesisDiffResult> {
  const diffId = toIsoId();
  const diffFileName = `v${oldVersion.replace(/\./g, '-')}-to-v${newVersion.replace(/\./g, '-')}.diff.md`;

  // Store in .genie/upgrades/ (new location for upgrade diffs)
  const upgradesDir = path.join(workspacePath, '.genie', 'upgrades');
  await ensureDir(upgradesDir);
  const diffPath = path.join(upgradesDir, diffFileName);

  console.log('   Comparing framework files...');

  // Collect files from both locations
  const localFiles = await collectLocalKnowledgeFiles(workspacePath);
  const upstreamFiles = await collectUpstreamKnowledgeFiles(packageRoot);

  console.log(`   Local: ${localFiles.size} files | Upstream: ${upstreamFiles.size} files`);

  // Compare files
  const diffs = await compareFilesDirectly(
    localFiles,
    upstreamFiles,
    workspacePath,
    packageRoot
  );

  // Generate detailed diff report with actual content diffs
  const report = await buildGenesisDiffReport(diffs, oldVersion, newVersion, diffId);

  await fsp.writeFile(diffPath, report, 'utf8');

  const summary = {
    added: diffs.filter(d => d.status === 'added').length,
    removed: diffs.filter(d => d.status === 'removed').length,
    modified: diffs.filter(d => d.status === 'modified').length,
    unchanged: diffs.filter(d => d.status === 'unchanged').length
  };

  const hasChanges = summary.added > 0 || summary.removed > 0 || summary.modified > 0;

  return { diffPath, diffId, summary, hasChanges };
}

/**
 * Collect knowledge files from LOCAL workspace
 * These are the user's current files
 */
async function collectLocalKnowledgeFiles(workspacePath: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();

  // Root documentation files
  const rootDocs = ['AGENTS.md', 'CLAUDE.md'];
  for (const doc of rootDocs) {
    const docPath = path.join(workspacePath, doc);
    if (await pathExists(docPath)) {
      files.set(doc, docPath);
    }
  }

  // .genie folder (excluding user content)
  const geniePath = path.join(workspacePath, '.genie');
  if (await pathExists(geniePath)) {
    const knowledgeDirs = [
      'agents',
      'spells',
      'workflows',
      'product',
      'code',
      'create',
      'neurons',
      'qa',
      'utilities',
      'scripts'
    ];

    for (const dir of knowledgeDirs) {
      const dirPath = path.join(geniePath, dir);
      if (await pathExists(dirPath)) {
        const dirFiles = await collectFiles(dirPath, {
          filter: (relPath) => {
            // Exclude user-specific content
            const excludeDirs = ['wishes', 'reports', 'state', 'backups', 'upgrades'];
            const firstSeg = relPath.split(path.sep)[0];
            return !excludeDirs.includes(firstSeg);
          }
        });

        for (const file of dirFiles) {
          const relPath = path.join('.genie', dir, file);
          const absPath = path.join(dirPath, file);
          files.set(relPath, absPath);
        }
      }
    }

    // Also check for AGENTS.md and other root files in .genie/
    const genieRootFiles = ['AGENTS.md', 'README.md'];
    for (const file of genieRootFiles) {
      const filePath = path.join(geniePath, file);
      if (await pathExists(filePath)) {
        files.set(path.join('.genie', file), filePath);
      }
    }
  }

  return files;
}

/**
 * Collect knowledge files from UPSTREAM package template
 * These are the new framework files from the package
 */
async function collectUpstreamKnowledgeFiles(packageRoot: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();

  // Root documentation files in package
  const rootDocs = ['AGENTS.md', 'CLAUDE.md'];
  for (const doc of rootDocs) {
    const docPath = path.join(packageRoot, doc);
    if (await pathExists(docPath)) {
      files.set(doc, docPath);
    }
  }

  // .genie folder from package
  const geniePath = path.join(packageRoot, '.genie');
  if (await pathExists(geniePath)) {
    const knowledgeDirs = [
      'agents',
      'spells',
      'workflows',
      'product',
      'code',
      'create',
      'neurons',
      'qa',
      'utilities',
      'scripts'
    ];

    for (const dir of knowledgeDirs) {
      const dirPath = path.join(geniePath, dir);
      if (await pathExists(dirPath)) {
        const dirFiles = await collectFiles(dirPath, {
          filter: (relPath) => {
            // Exclude user-specific directories (these shouldn't exist in package anyway)
            const excludeDirs = ['wishes', 'reports', 'state', 'backups', 'upgrades'];
            const firstSeg = relPath.split(path.sep)[0];
            return !excludeDirs.includes(firstSeg);
          }
        });

        for (const file of dirFiles) {
          const relPath = path.join('.genie', dir, file);
          const absPath = path.join(dirPath, file);
          files.set(relPath, absPath);
        }
      }
    }

    // Root files in .genie/
    const genieRootFiles = ['AGENTS.md', 'README.md'];
    for (const file of genieRootFiles) {
      const filePath = path.join(geniePath, file);
      if (await pathExists(filePath)) {
        files.set(path.join('.genie', file), filePath);
      }
    }
  }

  return files;
}

/**
 * Compare files directly between local workspace and upstream package
 * No copying - just read and compare
 */
async function compareFilesDirectly(
  localFiles: Map<string, string>,
  upstreamFiles: Map<string, string>,
  workspacePath: string,
  packageRoot: string
): Promise<FileDiff[]> {
  const diffs: FileDiff[] = [];
  const allPaths = new Set([...localFiles.keys(), ...upstreamFiles.keys()]);

  for (const relPath of allPaths) {
    const localPath = localFiles.get(relPath);
    const upstreamPath = upstreamFiles.get(relPath);

    if (!localPath && upstreamPath) {
      // File exists in upstream but not in local (new file)
      const stats = await fsp.stat(upstreamPath);
      const content = await fsp.readFile(upstreamPath, 'utf8');
      diffs.push({
        path: relPath,
        status: 'added',
        newSize: stats.size,
        newContent: content
      });
    } else if (localPath && !upstreamPath) {
      // File exists in local but not in upstream (removed from framework)
      const stats = await fsp.stat(localPath);
      const content = await fsp.readFile(localPath, 'utf8');
      diffs.push({
        path: relPath,
        status: 'removed',
        oldSize: stats.size,
        oldContent: content
      });
    } else if (localPath && upstreamPath) {
      // File exists in both - check if modified
      const [localContent, upstreamContent] = await Promise.all([
        fsp.readFile(localPath, 'utf8'),
        fsp.readFile(upstreamPath, 'utf8')
      ]);

      const [localStats, upstreamStats] = await Promise.all([
        fsp.stat(localPath),
        fsp.stat(upstreamPath)
      ]);

      if (localContent !== upstreamContent) {
        diffs.push({
          path: relPath,
          status: 'modified',
          oldSize: localStats.size,
          newSize: upstreamStats.size,
          oldContent: localContent,
          newContent: upstreamContent
        });
      } else {
        diffs.push({
          path: relPath,
          status: 'unchanged',
          oldSize: localStats.size,
          newSize: upstreamStats.size
        });
      }
    }
  }

  return diffs.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Build detailed genesis diff report with actual content changes
 */
async function buildGenesisDiffReport(
  diffs: FileDiff[],
  oldVersion: string,
  newVersion: string,
  diffId: string
): Promise<string> {
  const added = diffs.filter(d => d.status === 'added');
  const removed = diffs.filter(d => d.status === 'removed');
  const modified = diffs.filter(d => d.status === 'modified');

  const lines: string[] = [];

  lines.push(`# Genie Framework Upgrade Diff`);
  lines.push(``);
  lines.push(`**Upgrade:** v${oldVersion} → v${newVersion}`);
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push(`**Diff ID:** ${diffId}`);
  lines.push(``);
  lines.push(`---`);
  lines.push(``);
  lines.push(`## Summary`);
  lines.push(``);
  lines.push(`| Type | Count |`);
  lines.push(`|------|-------|`);
  lines.push(`| Added | ${added.length} |`);
  lines.push(`| Removed | ${removed.length} |`);
  lines.push(`| Modified | ${modified.length} |`);
  lines.push(`| **Total Changes** | **${added.length + removed.length + modified.length}** |`);
  lines.push(``);

  // Added files (new in upstream)
  if (added.length > 0) {
    lines.push(`## New Files (${added.length})`);
    lines.push(``);
    lines.push(`These files exist in the new version but not in your workspace:`);
    lines.push(``);
    for (const diff of added) {
      const size = diff.newSize ? ` (${formatBytes(diff.newSize)})` : '';
      lines.push(`### ✅ \`${diff.path}\`${size}`);
      lines.push(``);
      if (diff.newContent && diff.newContent.length < 10000) {
        lines.push(`<details>`);
        lines.push(`<summary>View new file content</summary>`);
        lines.push(``);
        lines.push('```markdown');
        lines.push(diff.newContent.trim());
        lines.push('```');
        lines.push(``);
        lines.push(`</details>`);
        lines.push(``);
      } else {
        lines.push(`*File too large to include inline. Review directly.*`);
        lines.push(``);
      }
    }
  }

  // Removed files (exist locally but removed from framework)
  if (removed.length > 0) {
    lines.push(`## Removed from Framework (${removed.length})`);
    lines.push(``);
    lines.push(`These files exist in your workspace but are no longer part of the framework:`);
    lines.push(``);
    for (const diff of removed) {
      const size = diff.oldSize ? ` (${formatBytes(diff.oldSize)})` : '';
      lines.push(`- ❌ \`${diff.path}\`${size}`);
    }
    lines.push(``);
    lines.push(`**Action:** Review if these are user customizations to keep or obsolete files to remove.`);
    lines.push(``);
  }

  // Modified files (most important - these need careful review)
  if (modified.length > 0) {
    lines.push(`## Modified Files (${modified.length})`);
    lines.push(``);
    lines.push(`These files have changed in the upstream framework:`);
    lines.push(``);
    for (const diff of modified) {
      const oldSize = diff.oldSize ? formatBytes(diff.oldSize) : '?';
      const newSize = diff.newSize ? formatBytes(diff.newSize) : '?';
      const delta = diff.oldSize && diff.newSize
        ? ` (${diff.newSize > diff.oldSize ? '+' : ''}${formatBytes(diff.newSize - diff.oldSize)})`
        : '';

      lines.push(`### 📝 \`${diff.path}\``);
      lines.push(``);
      lines.push(`**Size:** ${oldSize} → ${newSize}${delta}`);
      lines.push(``);

      // Generate unified diff for content
      if (diff.oldContent && diff.newContent) {
        const unifiedDiff = generateUnifiedDiff(diff.path, diff.oldContent, diff.newContent);
        if (unifiedDiff.length < 15000) {
          lines.push(`<details>`);
          lines.push(`<summary>View changes</summary>`);
          lines.push(``);
          lines.push('```diff');
          lines.push(unifiedDiff);
          lines.push('```');
          lines.push(``);
          lines.push(`</details>`);
          lines.push(``);
        } else {
          lines.push(`*Diff too large to include inline. Key changes summarized below.*`);
          lines.push(``);
          // Provide a summary instead
          const addedLines = diff.newContent.split('\n').length - diff.oldContent.split('\n').length;
          lines.push(`**Line changes:** ${addedLines >= 0 ? '+' : ''}${addedLines} lines`);
          lines.push(``);
        }
      }
    }
  }

  lines.push(`---`);
  lines.push(``);
  lines.push(`## Agent Instructions`);
  lines.push(``);
  lines.push(`This diff file documents all framework changes from v${oldVersion} to v${newVersion}.`);
  lines.push(``);
  lines.push(`**Your task:**`);
  lines.push(`1. **Learn** the new patterns and teachings from added/modified files`);
  lines.push(`2. **Apply** necessary changes to workspace (preserve user customizations)`);
  lines.push(`3. **Report** what was learned and what actions were taken`);
  lines.push(``);
  lines.push(`**Important:**`);
  lines.push(`- Do NOT blindly copy files - understand the intent of each change`);
  lines.push(`- Preserve user customizations in workspace files`);
  lines.push(`- For conflicts, present options to user`);
  lines.push(`- Create a report of learnings applied`);
  lines.push(``);

  return lines.join('\n');
}

/**
 * Generate unified diff format for content comparison
 */
function generateUnifiedDiff(filename: string, oldContent: string, newContent: string): string {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');

  // Simple diff - show changed lines with context
  const result: string[] = [];
  result.push(`--- a/${filename}`);
  result.push(`+++ b/${filename}`);

  // Use a simple LCS-based diff algorithm
  const diff = simpleDiff(oldLines, newLines);
  result.push(...diff);

  return result.join('\n');
}

/**
 * Simple line-by-line diff (not as sophisticated as real git diff, but readable)
 */
function simpleDiff(oldLines: string[], newLines: string[]): string[] {
  const result: string[] = [];
  const maxLines = Math.max(oldLines.length, newLines.length);

  let i = 0, j = 0;
  let hunkStart = -1;
  let hunkLines: string[] = [];

  const flushHunk = () => {
    if (hunkLines.length > 0) {
      result.push(`@@ -${hunkStart + 1} +${hunkStart + 1} @@`);
      result.push(...hunkLines);
      hunkLines = [];
    }
  };

  while (i < oldLines.length || j < newLines.length) {
    if (i >= oldLines.length) {
      // Remaining new lines
      if (hunkStart === -1) hunkStart = i;
      hunkLines.push(`+${newLines[j]}`);
      j++;
    } else if (j >= newLines.length) {
      // Remaining old lines (removed)
      if (hunkStart === -1) hunkStart = i;
      hunkLines.push(`-${oldLines[i]}`);
      i++;
    } else if (oldLines[i] === newLines[j]) {
      // Lines match - context or end of hunk
      if (hunkLines.length > 0) {
        // Add some context then close hunk
        hunkLines.push(` ${oldLines[i]}`);
        if (hunkLines.length > 20) {
          flushHunk();
          hunkStart = -1;
        }
      }
      i++;
      j++;
    } else {
      // Lines differ
      if (hunkStart === -1) hunkStart = i;

      // Look ahead to find if old line appears later in new
      let foundInNew = false;
      for (let k = j + 1; k < Math.min(j + 5, newLines.length); k++) {
        if (oldLines[i] === newLines[k]) {
          // Old line found later - these are additions
          while (j < k) {
            hunkLines.push(`+${newLines[j]}`);
            j++;
          }
          foundInNew = true;
          break;
        }
      }

      if (!foundInNew) {
        // Check if new line appears later in old
        let foundInOld = false;
        for (let k = i + 1; k < Math.min(i + 5, oldLines.length); k++) {
          if (newLines[j] === oldLines[k]) {
            // New line found later - these are deletions
            while (i < k) {
              hunkLines.push(`-${oldLines[i]}`);
              i++;
            }
            foundInOld = true;
            break;
          }
        }

        if (!foundInOld) {
          // Simple replacement
          hunkLines.push(`-${oldLines[i]}`);
          hunkLines.push(`+${newLines[j]}`);
          i++;
          j++;
        }
      }
    }

    // Limit hunk size
    if (hunkLines.length > 100) {
      flushHunk();
      hunkStart = -1;
    }
  }

  flushHunk();

  return result;
}

/**
 * Format bytes to human-readable string
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes < 0) return `-${formatBytes(Math.abs(bytes))}`;
  const k = 1024;
  const sizes = ['B', 'KB', 'MB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}
