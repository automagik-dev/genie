/**
 * Knowledge diff generation for v2.5.14+ efficient update mechanism
 * 
 * Instead of full backups, generates a diff file showing changes in:
 * - AGENTS.md, CLAUDE.md (root files)
 * - .genie/ folder contents
 */

import path from 'path';
import { promises as fsp } from 'fs';
import { pathExists, collectFiles, toIsoId, ensureDir } from './fs-utils';

interface FileDiff {
  path: string;
  status: 'added' | 'removed' | 'modified' | 'unchanged';
  oldSize?: number;
  newSize?: number;
}

interface KnowledgeDiffResult {
  diffPath: string;
  diffId: string;
  summary: {
    added: number;
    removed: number;
    modified: number;
    unchanged: number;
  };
}

/**
 * Generate knowledge diff between old and new Genie installations
 * 
 * @param workspacePath - Root of workspace
 * @param oldGeniePath - Path to old .genie folder (before upgrade)
 * @param newGeniePath - Path to new .genie folder (after upgrade)
 * @param oldVersion - Old version string
 * @param newVersion - New version string
 * @returns Path to generated diff file
 */
export async function generateKnowledgeDiff(
  workspacePath: string,
  oldGeniePath: string,
  newGeniePath: string,
  oldVersion: string,
  newVersion: string
): Promise<KnowledgeDiffResult> {
  const diffId = toIsoId();
  const diffFileName = `update-diff-${oldVersion}-to-${newVersion}-${diffId}.md`;
  const diffPath = path.join(workspacePath, '.genie', 'reports', diffFileName);

  await ensureDir(path.dirname(diffPath));

  const oldFiles = await collectKnowledgeFiles(oldGeniePath, workspacePath);
  const newFiles = await collectKnowledgeFiles(newGeniePath, workspacePath);

  const diffs = await compareFiles(oldFiles, newFiles, oldGeniePath, newGeniePath, workspacePath);

  const report = await buildDiffReport(diffs, oldVersion, newVersion, diffId);

  await fsp.writeFile(diffPath, report, 'utf8');

  const summary = {
    added: diffs.filter(d => d.status === 'added').length,
    removed: diffs.filter(d => d.status === 'removed').length,
    modified: diffs.filter(d => d.status === 'modified').length,
    unchanged: diffs.filter(d => d.status === 'unchanged').length
  };

  return { diffPath, diffId, summary };
}

/**
 * Collect knowledge files (agents, spells, workflows, product, root docs)
 * Excludes user content (wishes, reports, state, backups)
 */
async function collectKnowledgeFiles(geniePath: string, workspacePath: string): Promise<Set<string>> {
  const files = new Set<string>();

  const rootDocs = ['AGENTS.md', 'CLAUDE.md'];
  for (const doc of rootDocs) {
    const docPath = path.join(workspacePath, doc);
    if (await pathExists(docPath)) {
      files.add(doc);
    }
  }

  if (await pathExists(geniePath)) {
    const knowledgeDirs = ['agents', 'spells', 'workflows', 'product', 'code', 'create', 'neurons'];
    
    for (const dir of knowledgeDirs) {
      const dirPath = path.join(geniePath, dir);
      if (await pathExists(dirPath)) {
        const dirFiles = await collectFiles(dirPath, {
          filter: (relPath) => {
            const firstSeg = relPath.split(path.sep)[0];
            const excludeDirs = ['wishes', 'reports', 'state', 'backups', 'scripts'];
            return !excludeDirs.includes(firstSeg);
          }
        });
        
        for (const file of dirFiles) {
          files.add(path.join('.genie', dir, file));
        }
      }
    }
  }

  return files;
}

/**
 * Compare files between old and new installations
 */
async function compareFiles(
  oldFiles: Set<string>,
  newFiles: Set<string>,
  oldGeniePath: string,
  newGeniePath: string,
  workspacePath: string
): Promise<FileDiff[]> {
  const diffs: FileDiff[] = [];
  const allPaths = new Set([...oldFiles, ...newFiles]);

  for (const relPath of allPaths) {
    const inOld = oldFiles.has(relPath);
    const inNew = newFiles.has(relPath);

    if (!inOld && inNew) {
      const newPath = relPath.startsWith('.genie') 
        ? path.join(newGeniePath, relPath.replace('.genie/', '').replace('.genie\\', ''))
        : path.join(workspacePath, relPath);
      const stats = await fsp.stat(newPath);
      diffs.push({
        path: relPath,
        status: 'added',
        newSize: stats.size
      });
    } else if (inOld && !inNew) {
      const oldPath = relPath.startsWith('.genie')
        ? path.join(oldGeniePath, relPath.replace('.genie/', '').replace('.genie\\', ''))
        : path.join(workspacePath, relPath);
      const stats = await fsp.stat(oldPath);
      diffs.push({
        path: relPath,
        status: 'removed',
        oldSize: stats.size
      });
    } else {
      const oldPath = relPath.startsWith('.genie')
        ? path.join(oldGeniePath, relPath.replace('.genie/', '').replace('.genie\\', ''))
        : path.join(workspacePath, relPath);
      const newPath = relPath.startsWith('.genie')
        ? path.join(newGeniePath, relPath.replace('.genie/', '').replace('.genie\\', ''))
        : path.join(workspacePath, relPath);

      const [oldContent, newContent] = await Promise.all([
        fsp.readFile(oldPath, 'utf8'),
        fsp.readFile(newPath, 'utf8')
      ]);

      const [oldStats, newStats] = await Promise.all([
        fsp.stat(oldPath),
        fsp.stat(newPath)
      ]);

      if (oldContent !== newContent) {
        diffs.push({
          path: relPath,
          status: 'modified',
          oldSize: oldStats.size,
          newSize: newStats.size
        });
      } else {
        diffs.push({
          path: relPath,
          status: 'unchanged',
          oldSize: oldStats.size,
          newSize: newStats.size
        });
      }
    }
  }

  return diffs.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Build markdown diff report
 */
async function buildDiffReport(
  diffs: FileDiff[],
  oldVersion: string,
  newVersion: string,
  diffId: string
): Promise<string> {
  const added = diffs.filter(d => d.status === 'added');
  const removed = diffs.filter(d => d.status === 'removed');
  const modified = diffs.filter(d => d.status === 'modified');

  const lines: string[] = [];
  
  lines.push(`# Genie Knowledge Update Diff`);
  lines.push(``);
  lines.push(`**Version Transition:** ${oldVersion} → ${newVersion}`);
  lines.push(`**Diff ID:** ${diffId}`);
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push(``);
  lines.push(`## Summary`);
  lines.push(``);
  lines.push(`- **Added:** ${added.length} files`);
  lines.push(`- **Removed:** ${removed.length} files`);
  lines.push(`- **Modified:** ${modified.length} files`);
  lines.push(`- **Total Changes:** ${added.length + removed.length + modified.length} files`);
  lines.push(``);

  if (added.length > 0) {
    lines.push(`## Added Files (${added.length})`);
    lines.push(``);
    for (const diff of added) {
      const size = diff.newSize ? ` (${formatBytes(diff.newSize)})` : '';
      lines.push(`- ✅ \`${diff.path}\`${size}`);
    }
    lines.push(``);
  }

  if (removed.length > 0) {
    lines.push(`## Removed Files (${removed.length})`);
    lines.push(``);
    for (const diff of removed) {
      const size = diff.oldSize ? ` (${formatBytes(diff.oldSize)})` : '';
      lines.push(`- ❌ \`${diff.path}\`${size}`);
    }
    lines.push(``);
  }

  if (modified.length > 0) {
    lines.push(`## Modified Files (${modified.length})`);
    lines.push(``);
    for (const diff of modified) {
      const oldSize = diff.oldSize ? formatBytes(diff.oldSize) : '?';
      const newSize = diff.newSize ? formatBytes(diff.newSize) : '?';
      const delta = diff.oldSize && diff.newSize 
        ? ` (${diff.newSize > diff.oldSize ? '+' : ''}${formatBytes(diff.newSize - diff.oldSize)})`
        : '';
      lines.push(`- 📝 \`${diff.path}\` (${oldSize} → ${newSize}${delta})`);
    }
    lines.push(``);
  }

  lines.push(`## Notes`);
  lines.push(``);
  lines.push(`This diff shows changes in Genie's "knowledge" (framework files) between versions.`);
  lines.push(`User content (wishes, reports, state) is excluded from this diff.`);
  lines.push(``);
  lines.push(`**Included in diff:**`);
  lines.push(`- Root documentation: AGENTS.md, CLAUDE.md`);
  lines.push(`- Framework directories: .genie/agents/, .genie/spells/, .genie/workflows/, .genie/product/`);
  lines.push(`- Collective directories: .genie/code/, .genie/create/, .genie/neurons/`);
  lines.push(``);
  lines.push(`**Excluded from diff:**`);
  lines.push(`- User content: .genie/wishes/, .genie/reports/`);
  lines.push(`- Runtime state: .genie/state/, .genie/backups/`);
  lines.push(`- Helper scripts: .genie/scripts/helpers/`);
  lines.push(``);

  return lines.join('\n');
}

/**
 * Format bytes to human-readable string
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}
