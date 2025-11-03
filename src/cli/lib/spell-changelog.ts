/**
 * Spell Changelog Extractor
 *
 * Detects new spells (skills) learned by Master Genie between versions
 * by analyzing git commits for changes in spell directories:
 * - .genie/spells/ (universal spells)
 * - .genie/code/spells/ (Code collective spells)
 * - .genie/create/spells/ (Create collective spells)
 */

import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

export interface LearnedSpell {
  name: string;
  type: 'universal' | 'code' | 'create';
  action: 'added' | 'modified';
  path: string;
}

export interface SpellChangelog {
  newSpells: LearnedSpell[];
  modifiedSpells: LearnedSpell[];
  totalCount: number;
}

/**
 * Extract spell changes between two git references (tags/commits)
 */
export function getLearnedSpells(fromRef: string, toRef: string = 'HEAD'): SpellChangelog {
  const spellPatterns = [
    '.genie/spells/**/*.md',
    '.genie/code/spells/**/*.md',
    '.genie/create/spells/**/*.md'
  ];

  const newSpells: LearnedSpell[] = [];
  const modifiedSpells: LearnedSpell[] = [];

  try {
    // Get all changed files between refs
    const diffOutput = execSync(
      `git diff --name-status ${fromRef}..${toRef} -- ${spellPatterns.join(' ')}`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }
    ).trim();

    if (!diffOutput) {
      return { newSpells, modifiedSpells, totalCount: 0 };
    }

    const lines = diffOutput.split('\n');

    for (const line of lines) {
      const match = line.match(/^([A-Z])\s+(.+\.md)$/);
      if (!match) continue;

      const [, status, filePath] = match;

      // Skip non-spell files
      if (!filePath.includes('/spells/')) continue;
      if (filePath.includes('README.md')) continue;

      const spell = parseSpellFromPath(filePath);
      if (!spell) continue;

      if (status === 'A') {
        // Added (new spell)
        newSpells.push({ ...spell, action: 'added' });
      } else if (status === 'M') {
        // Modified (enhanced spell)
        modifiedSpells.push({ ...spell, action: 'modified' });
      }
    }

    return {
      newSpells,
      modifiedSpells,
      totalCount: newSpells.length + modifiedSpells.length
    };
  } catch (error) {
    // If git command fails (e.g., no tags yet), return empty
    return { newSpells, modifiedSpells, totalCount: 0 };
  }
}

/**
 * Parse spell metadata from file path
 */
function parseSpellFromPath(filePath: string): Omit<LearnedSpell, 'action'> | null {
  // Extract spell name from filename
  const fileName = path.basename(filePath, '.md');

  // Determine type based on path
  let type: 'universal' | 'code' | 'create';
  if (filePath.includes('.genie/code/spells/')) {
    type = 'code';
  } else if (filePath.includes('.genie/create/spells/')) {
    type = 'create';
  } else if (filePath.includes('.genie/spells/')) {
    type = 'universal';
  } else {
    return null;
  }

  // Convert filename to readable name
  const name = fileName
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

  return {
    name,
    type,
    path: filePath
  };
}

/**
 * Format spell changelog for display in terminal
 */
export function formatSpellChangelog(changelog: SpellChangelog): string[] {
  const lines: string[] = [];

  if (changelog.totalCount === 0) {
    return lines;
  }

  lines.push('🎓 New Magik Learned:');
  lines.push('');

  if (changelog.newSpells.length > 0) {
    lines.push('  ✨ New Spells:');
    for (const spell of changelog.newSpells) {
      const badge = spell.type === 'universal' ? '🌍' : spell.type === 'code' ? '💻' : '✍️';
      lines.push(`     ${badge} ${spell.name}`);
    }
    lines.push('');
  }

  if (changelog.modifiedSpells.length > 0) {
    lines.push('  ⚡ Enhanced Spells:');
    for (const spell of changelog.modifiedSpells) {
      const badge = spell.type === 'universal' ? '🌍' : spell.type === 'code' ? '💻' : '✍️';
      lines.push(`     ${badge} ${spell.name}`);
    }
    lines.push('');
  }

  return lines;
}

/**
 * Get the most recent git tag (for version comparison)
 */
export function getLastTag(): string | null {
  try {
    return execSync('git describe --tags --abbrev=0', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore']
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Get tag for a specific version
 */
export function getTagForVersion(version: string): string | null {
  try {
    const tags = execSync('git tag -l', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore']
    }).trim().split('\n');

    // Try exact match first
    const exactMatch = tags.find(tag => tag === `v${version}` || tag === version);
    if (exactMatch) return exactMatch;

    // Try fuzzy match (e.g., "2.5.0" matches "v2.5.0-rc.1")
    const fuzzyMatch = tags.find(tag => tag.includes(version));
    return fuzzyMatch || null;
  } catch {
    return null;
  }
}
