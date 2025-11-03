#!/usr/bin/env node

/**
 * Migrate agent frontmatter from old schema to new schema
 *
 * Old schema:
 *   genie:
 *     executor: CLAUDE_CODE
 *     executorVariant: DEFAULT
 *     model: sonnet
 *     dangerously_skip_permissions: false
 *
 * New schema:
 *   genie:
 *     executor: CLAUDE_CODE
 *     variant: DEFAULT
 *     background: true
 *   forge:
 *     model: claude-sonnet-4-5-20250929
 *     dangerously_skip_permissions: false
 */

import fs from 'fs';
import path from 'path';
import { parse as parseYAML, stringify as stringifyYAML } from 'yaml';

interface MigrationStats {
  totalFiles: number;
  migratedFiles: number;
  skippedFiles: number;
  errors: string[];
  changes: Array<{
    file: string;
    movedFields: string[];
  }>;
}

// Fields that should move from genie.* to forge.*
const FORGE_FIELDS = [
  'model',
  'dangerously_skip_permissions',
  'sandbox',
  'dangerously_allow_all',
  'model_reasoning_effort',
  'model_reasoning_summary',
  'model_reasoning_summary_format',
  'profile',
  'base_instructions',
  'include_plan_tool',
  'include_apply_patch_tool',
  'claude_code_router',
  'plan',
  'approvals',
  'base_command_override',
  'additional_params',
  'ask_for_approval',
  'oss',
  'force',
  'yolo',
  'allow_all_tools',
  'allow_tool',
  'deny_tool',
  'add_dir',
  'disable_mcp_server',
  'agent'
];

// Fields that stay in genie.*
const GENIE_FIELDS = [
  'executor',
  'variant',  // Will be renamed from executorVariant
  'background'
];

function extractFrontMatter(content: string): { frontmatter: string; body: string } | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    return null;
  }
  return {
    frontmatter: match[1],
    body: match[2]
  };
}

function migrateFrontmatter(frontmatter: any): { migrated: any; movedFields: string[] } {
  const migrated: any = { ...frontmatter };
  const movedFields: string[] = [];

  // Initialize forge object if genie has executor fields
  if (migrated.genie) {
    migrated.forge = migrated.forge || {};

    // Rename executorVariant to variant
    if (migrated.genie.executorVariant !== undefined) {
      migrated.genie.variant = migrated.genie.executorVariant;
      delete migrated.genie.executorVariant;
      movedFields.push('executorVariant → variant');
    }

    // Move executor-specific fields to forge namespace
    for (const field of FORGE_FIELDS) {
      if (migrated.genie[field] !== undefined) {
        migrated.forge[field] = migrated.genie[field];
        delete migrated.genie[field];
        movedFields.push(`genie.${field} → forge.${field}`);
      }
    }

    // Clean up empty genie object
    if (Object.keys(migrated.genie).length === 0) {
      delete migrated.genie;
    }

    // Clean up empty forge object
    if (Object.keys(migrated.forge).length === 0) {
      delete migrated.forge;
    }
  }

  return { migrated, movedFields };
}

async function migrateFile(filePath: string): Promise<string[]> {
  const content = fs.readFileSync(filePath, 'utf-8');

  const parsed = extractFrontMatter(content);
  if (!parsed) {
    throw new Error('No frontmatter found');
  }

  const frontmatter = parseYAML(parsed.frontmatter);
  const { migrated, movedFields } = migrateFrontmatter(frontmatter);

  // Only write if changes were made
  if (movedFields.length === 0) {
    return [];
  }

  // Reconstruct file with migrated frontmatter
  const newFrontmatter = stringifyYAML(migrated, {
    lineWidth: 0,  // Don't wrap lines
    defaultStringType: 'PLAIN'
  });

  const newContent = `---\n${newFrontmatter}---\n${parsed.body}`;
  fs.writeFileSync(filePath, newContent, 'utf-8');

  return movedFields;
}

function findMarkdownFiles(dir: string, skipDirs: string[] = []): string[] {
  const files: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      // Skip certain directories
      if (skipDirs.includes(entry.name)) {
        continue;
      }
      // Recursively search subdirectories
      files.push(...findMarkdownFiles(fullPath, skipDirs));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(fullPath);
    }
  }

  return files;
}

async function migrateDirectory(dir: string): Promise<MigrationStats> {
  const stats: MigrationStats = {
    totalFiles: 0,
    migratedFiles: 0,
    skippedFiles: 0,
    errors: [],
    changes: []
  };

  // Find all .md files recursively, skipping certain directories
  const skipDirs = ['node_modules', 'dist', '.git', 'spells', 'workflows', 'reports', 'wishes'];
  const files = findMarkdownFiles(dir, skipDirs);

  stats.totalFiles = files.length;

  for (const file of files) {
    try {
      const movedFields = await migrateFile(file);

      if (movedFields.length > 0) {
        stats.migratedFiles++;
        stats.changes.push({
          file: path.relative(dir, file),
          movedFields
        });
        console.log(`✓ Migrated: ${path.relative(dir, file)} (${movedFields.length} changes)`);
      } else {
        stats.skippedFiles++;
      }
    } catch (error: any) {
      stats.errors.push(`${path.relative(dir, file)}: ${error.message}`);
      console.warn(`⚠ Skipped: ${path.relative(dir, file)} - ${error.message}`);
    }
  }

  return stats;
}

async function main() {
  const args = process.argv.slice(2);
  const targetDir = args[0] || '.genie';

  if (!fs.existsSync(targetDir)) {
    console.error(`❌ Directory not found: ${targetDir}`);
    process.exit(1);
  }

  console.log(`🔄 Migrating frontmatter in: ${targetDir}\n`);

  const stats = await migrateDirectory(targetDir);

  console.log('\n📊 Migration Summary:');
  console.log(`   Total files scanned: ${stats.totalFiles}`);
  console.log(`   Files migrated: ${stats.migratedFiles}`);
  console.log(`   Files skipped (no changes): ${stats.skippedFiles}`);
  console.log(`   Errors: ${stats.errors.length}`);

  if (stats.errors.length > 0) {
    console.log('\n⚠️  Errors:');
    stats.errors.forEach(err => console.log(`   - ${err}`));
  }

  if (stats.changes.length > 0) {
    console.log('\n📝 Changes made:');
    stats.changes.forEach(change => {
      console.log(`   ${change.file}:`);
      change.movedFields.forEach(field => console.log(`      - ${field}`));
    });
  }

  console.log('\n✅ Migration complete!');
}

// Run if executed directly
if (require.main === module) {
  main().catch(error => {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  });
}

export { migrateDirectory, migrateFile, extractFrontMatter, migrateFrontmatter };
