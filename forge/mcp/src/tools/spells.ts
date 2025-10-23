/**
 * Spells Tools
 * Lists and retrieves Genie framework spells (reusable knowledge patterns)
 */

import { z } from 'zod';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Find the .genie directory by walking up from cwd
 */
function findGenieRoot(): string | null {
  let currentDir = process.cwd();
  const root = '/';

  while (currentDir !== root) {
    const geniePath = join(currentDir, '.genie');
    try {
      const stat = statSync(geniePath);
      if (stat.isDirectory()) {
        return currentDir;
      }
    } catch {
      // Directory doesn't exist, continue searching
    }
    currentDir = join(currentDir, '..');
  }

  return null;
}

/**
 * List all spell files in a directory recursively
 */
function listSpellsInDir(dir: string, basePath: string = ''): Array<{ path: string; name: string }> {
  const spells: Array<{ path: string; name: string }> = [];

  try {
    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const relativePath = basePath ? join(basePath, entry.name) : entry.name;

      if (entry.isDirectory()) {
        // Recurse into subdirectories
        spells.push(...listSpellsInDir(fullPath, relativePath));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        // Extract spell name from frontmatter if possible
        try {
          const content = readFileSync(fullPath, 'utf-8');
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

/**
 * Read spell content and extract everything after frontmatter
 */
function readSpellContent(spellPath: string): string {
  try {
    const content = readFileSync(spellPath, 'utf-8');

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

export function registerSpellTools(server: any) {
  // Tool: list_spells
  server.addTool({
    name: 'list_spells',
    description: 'List all available Genie spells (reusable knowledge patterns). Returns spells from .genie/spells/ (global), .genie/code/spells/ (code-specific), and .genie/create/spells/ (create-specific).',
    parameters: z.object({
      scope: z.enum(['all', 'global', 'code', 'create']).optional().describe('Filter spells by scope. Default: all')
    }),
    annotations: {
      readOnlyHint: true
    },
    execute: async (args: { scope?: 'all' | 'global' | 'code' | 'create' }, { log }: any) => {
      const scope = args.scope || 'all';
      log.info(`Listing spells (scope: ${scope})...`);

      const genieRoot = findGenieRoot();
      if (!genieRoot) {
        return 'Error: Could not find .genie directory. Are you in a Genie workspace?';
      }

      const geniePath = join(genieRoot, '.genie');
      const result: any = {};

      // Global spells
      if (scope === 'all' || scope === 'global') {
        const globalSpellsDir = join(geniePath, 'spells');
        result.global = listSpellsInDir(globalSpellsDir);
      }

      // Code spells
      if (scope === 'all' || scope === 'code') {
        const codeSpellsDir = join(geniePath, 'code', 'spells');
        result.code = listSpellsInDir(codeSpellsDir);
      }

      // Create spells
      if (scope === 'all' || scope === 'create') {
        const createSpellsDir = join(geniePath, 'create', 'spells');
        result.create = listSpellsInDir(createSpellsDir);
      }

      // Format output
      let output = '# Genie Spells\n\n';

      if (result.global) {
        output += `## Global Spells (.genie/spells/) - ${result.global.length} spells\n`;
        output += 'Universal patterns applicable to all collectives:\n\n';
        for (const spell of result.global) {
          output += `- **${spell.name}** - \`${spell.path}\`\n`;
        }
        output += '\n';
      }

      if (result.code) {
        output += `## Code Spells (.genie/code/spells/) - ${result.code.length} spells\n`;
        output += 'Code-specific patterns for technical execution:\n\n';
        for (const spell of result.code) {
          output += `- **${spell.name}** - \`${spell.path}\`\n`;
        }
        output += '\n';
      }

      if (result.create) {
        output += `## Create Spells (.genie/create/spells/) - ${result.create.length} spells\n`;
        output += 'Create-specific patterns for creative work:\n\n';
        for (const spell of result.create) {
          output += `- **${spell.name}** - \`${spell.path}\`\n`;
        }
        output += '\n';
      }

      const totalCount = (result.global?.length || 0) + (result.code?.length || 0) + (result.create?.length || 0);
      output += `\n**Total:** ${totalCount} spells\n`;

      return output;
    }
  });

  // Tool: read_spell
  server.addTool({
    name: 'read_spell',
    description: 'Read the full content of a specific spell. Returns the spell content after the frontmatter (---). Use list_spells first to see available spells.',
    parameters: z.object({
      spell_path: z.string().describe('Relative path to the spell file from .genie/ directory (e.g., "spells/learn.md" or "code/spells/forge-code-blueprints.md")')
    }),
    annotations: {
      readOnlyHint: true
    },
    execute: async (args: { spell_path: string }, { log }: any) => {
      log.info(`Reading spell: ${args.spell_path}`);

      const genieRoot = findGenieRoot();
      if (!genieRoot) {
        return 'Error: Could not find .genie directory. Are you in a Genie workspace?';
      }

      const fullPath = join(genieRoot, '.genie', args.spell_path);

      try {
        const content = readSpellContent(fullPath);
        return `# Spell: ${args.spell_path}\n\n${content}`;
      } catch (error: any) {
        return `Error reading spell: ${error.message}`;
      }
    }
  });
}
