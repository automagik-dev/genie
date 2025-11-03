/**
 * Spell utilities for MCP server
 * Extracted from server.ts per Amendment 10 (file size discipline)
 */

import fs from 'fs';
import path from 'path';
import { findWorkspaceRoot } from './server-helpers.js';

// Helper: List all spell files in a directory recursively
export function listSpellsInDir(dir: string, basePath: string = ''): Array<{ path: string; name: string }> {
  const spells: Array<{ path: string; name: string }> = [];

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = basePath ? path.join(basePath, entry.name) : entry.name;

      if (entry.isDirectory()) {
        // Recurse into subdirectories
        spells.push(...listSpellsInDir(fullPath, relativePath));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        // Extract spell name from frontmatter if possible
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          const frontmatterMatch = content.match(/^---\s*\nname:\s*(.+)\s*\n/);
          const spellName = frontmatterMatch ? frontmatterMatch[1].trim() : entry.name.replace('.md', '');
          spells.push({ path: relativePath, name: spellName });
        } catch {
          spells.push({ path: relativePath, name: entry.name.replace('.md', '') });
        }
      }
    }
  } catch (error) {
    // Directory doesn't exist or can't be read
  }

  return spells;
}

// Helper: Read spell content and extract everything after frontmatter
export function readSpellContent(spellPath: string): string {
  try {
    const content = fs.readFileSync(spellPath, 'utf-8');

    // Find the end of frontmatter (second ---)
    const frontmatterEnd = content.indexOf('---', 3);
    if (frontmatterEnd === -1) {
      // No frontmatter, return entire content
      return content;
    }

    // Return everything after the closing ---
    return content.substring(frontmatterEnd + 3).trim();
  } catch (error: any) {
    throw new Error(`Failed to read spell: ${error.message}`);
  }
}

// Helper: Normalize spell path (strip leading .genie/, add directory if missing, add .md if missing)
export function normalizeSpellPath(userPath: string): string {
  const workspaceRoot = findWorkspaceRoot();
  // Strip leading .genie/ if present (prevents double prefix)
  let normalized = userPath.replace(/^\.genie[\\/]/, '');

  // If path contains no directory component and no scope prefix, search all scope directories
  if (!normalized.includes('/') && !normalized.includes('\\')) {
    // Try to find the spell in global, code, or create directories
    const searchDirs = ['spells', 'code/spells', 'create/spells'];
    for (const dir of searchDirs) {
      const testPath = path.join(workspaceRoot, '.genie', dir, normalized.endsWith('.md') ? normalized : `${normalized}.md`);
      if (fs.existsSync(testPath)) {
        normalized = path.join(dir, normalized.endsWith('.md') ? normalized : `${normalized}.md`);
        break;
      }
    }

    // If not found in any directory, default to spells/ (will fail with clear error)
    if (!normalized.includes('/') && !normalized.includes('\\')) {
      normalized = path.join('spells', normalized);
    }
  }

  // Add .md extension if missing
  if (!normalized.endsWith('.md')) {
    normalized += '.md';
  }

  return normalized;
}
