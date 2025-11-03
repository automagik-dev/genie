import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

/**
 * Migration utility for upgrading from old Genie versions to npm-backed architecture
 *
 * Strategy:
 * 1. Detect existing Genie installation
 * 2. Backup entire .genie/ directory
 * 3. Analyze user customizations vs framework defaults
 * 4. Migrate to new structure (core agents in npm; project notes inline in agents/skills)
 * 5. Preserve user work (product/, standards/, wishes/, state/)
 */

export interface MigrationResult {
  status: 'clean_install' | 'upgraded' | 'already_migrated' | 'failed';
  backupPath?: string;
  customAgentsPreserved: string[];
  coreAgentsRemoved: string[];
  customizationsExtracted: string[];
  errors: string[];
  warnings: string[];
}

// Core agents that ship with npm package (should NOT be in user .genie/agents/)
// Reflects current structure: workflows/, agents/, agents/modes/
const CORE_AGENT_IDS = [
  // Workflow orchestrators (.genie/agents/workflows/)
  'workflows/plan',
  'workflows/wish',
  'workflows/forge',
  'workflows/review',
  'workflows/vibe',
  'workflows/qa',
  'workflows/prompt',

  // Core agents (.genie/agents/agents/)
  'agents/orchestrator',
  'agents/commit',
  'agents/git',
  'agents/implementor',
  'agents/install',
  'agents/learn',
  'agents/polish',
  'agents/release',
  'agents/roadmap',
  'agents/tests',

  // Strategic thinking modes (.genie/agents/agents/modes/)
  'agents/modes/analyze',
  'agents/modes/audit',
  'agents/modes/challenge',
  'agents/modes/consensus',
  'agents/modes/debug',
  'agents/modes/docgen',
  'agents/modes/explore',
  'agents/modes/refactor',
  'agents/modes/tracer',
];

/**
 * Detects if this is a clean install or needs migration
 *
 * CRITICAL FIX for issue #237 (infinite update loop):
 * Check version files FIRST - if modern version exists, never report as "old_genie"
 * The presence of .genie/agents/workflows/ and .genie/agents/agents/ with .md files
 * is NOT a reliable indicator of old installations, as the new structure (v2.1.0+)
 * also copies these directories from templates.
 */
export function detectInstallType(): 'clean' | 'old_genie' | 'already_new' {
  const genieDir = '.genie';

  if (!fs.existsSync(genieDir)) {
    return 'clean';
  }

  // FIX: Check for modern version file FIRST
  // If version.json exists and has a modern version (v2.1.0+), this is NOT old_genie
  const versionPath = path.join(genieDir, 'state', 'version.json');

  if (fs.existsSync(versionPath)) {
    try {
      const versionData = JSON.parse(fs.readFileSync(versionPath, 'utf8'));
      const version = versionData.version;
      // If version.json exists with a version string, this is modern structure
      if (version && typeof version === 'string') {
        return 'already_new';
      }
    } catch (e) {
      // Corrupted version file - treat as needs upgrade
    }
  }

  const agentsDir = path.join(genieDir, 'agents');
  if (!fs.existsSync(agentsDir)) {
    return 'clean';
  }

  // Check for old nested structure (workflows/ and agents/ subdirectories)
  const workflowsDir = path.join(agentsDir, 'workflows');
  const legacyAgentsDir = path.join(agentsDir, 'agents');

  if (fs.existsSync(workflowsDir) && fs.existsSync(legacyAgentsDir)) {
    // Has old nested structure - check if agents come from npm or are in repo
    const workflowAgents = fs.existsSync(workflowsDir)
      ? fs.readdirSync(workflowsDir).filter(f => f.endsWith('.md')).length
      : 0;
    const agentCount = fs.existsSync(legacyAgentsDir)
      ? fs.readdirSync(legacyAgentsDir).filter(f => f.endsWith('.md')).length
      : 0;

    // If agents exist in repo, old structure (should come from npm)
    // BUT: Only flag as old_genie if NO version file exists (modern installs always have version)
    if (workflowAgents > 0 || agentCount > 0) {
      return 'old_genie';
    }

    return 'already_new';
  }

  // Check for legacy core/ structure
  const coreDir = path.join(agentsDir, 'core');
  if (fs.existsSync(coreDir)) {
    const coreAgents = fs.readdirSync(coreDir).filter(f => f.endsWith('.md'));

    // If core/ has agents, this is old structure
    if (coreAgents.length > 0) {
      return 'old_genie';
    }
  }

  // Check for very old structure (top-level agents)
  const topLevelAgents = fs.readdirSync(agentsDir).filter(f => f.endsWith('.md'));
  const hasOldCoreAgents = topLevelAgents.some(f =>
    ['plan', 'wish', 'forge', 'review', 'orchestrator', 'vibe'].includes(f.replace('.md', ''))
  );

  return hasOldCoreAgents ? 'old_genie' : 'already_new';
}

/**
 * Creates timestamped backup of .genie/ directory
 */
export function backupGenie(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T').join('-').slice(0, -5);
  const backupPath = `.genie-backup-${timestamp}`;

  execSync(`cp -r .genie "${backupPath}"`);

  return backupPath;
}

/**
 * Analyzes which agents are custom (user-created) vs core (framework)
 */
export function analyzeAgents(): {
  core: string[];
  custom: string[];
  modified: string[];
} {
  const agentsDir = '.genie/agents';
  const result = {
    core: [] as string[],
    custom: [] as string[],
    modified: [] as string[]
  };

  if (!fs.existsSync(agentsDir)) {
    return result;
  }

  const walkDir = (dir: string, prefix: string = ''): void => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name === 'README.md') continue;

      const fullPath = path.join(dir, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        walkDir(fullPath, relativePath);
      } else if (entry.name.endsWith('.md')) {
        const agentId = relativePath.replace(/\.md$/, '');

        if (CORE_AGENT_IDS.includes(agentId)) {
          // TODO: Check if modified from framework default
          // For now, assume all core agents should be removed
          result.core.push(agentId);
        } else {
          result.custom.push(agentId);
        }
      }
    }
  };

  walkDir(agentsDir);

  return result;
}

/**
 * Extracts customizations from modified core agents (custom folder retired)
 */
export function extractCustomizations(coreAgents: string[]): string[] {
  const extracted: string[] = [];

  // TODO: Implement diff-based extraction/merge into local agent/skill docs
  // For now: no-op (document that custom folder is retired)

  return extracted;
}

/**
 * Copies templates from npm package to user project
 */
export function copyTemplates(options: { force?: boolean } = {}): void {
  // Resolve npm package location (from dist/cli/lib/)
  const packageRoot = path.resolve(__dirname, '../../..');
  // Migration is for code projects (old Genie was for development)
  const templatesSource = path.join(packageRoot, 'templates', 'code');

  if (!fs.existsSync(templatesSource)) {
    throw new Error(`Templates not found at ${templatesSource}`);
  }

  // Copy .claude/ directory (npm-referencing aliases)
  const claudeSource = path.join(templatesSource, '.claude');
  const claudeDest = '.claude';

  if (fs.existsSync(claudeDest) && !options.force) {
    console.warn(`⚠️  .claude/ exists, skipping (use --force to overwrite)`);
  } else {
    if (fs.existsSync(claudeDest)) {
      execSync(`rm -rf ${claudeDest}`);
    }
    execSync(`cp -r "${claudeSource}" "${claudeDest}"`);
  }

  // Note: `.genie/custom/` retired — no custom stubs copied

  // Copy product/ and standards/ templates if they don't exist
  const copyIfMissing = (subdir: string) => {
    const source = path.join(templatesSource, '.genie', subdir);
    const dest = path.join('.genie', subdir);

    if (!fs.existsSync(dest)) {
      execSync(`cp -r "${source}" "${dest}"`);
    }
  };

  copyIfMissing('product');
  copyIfMissing('standards');

  // Ensure state/ and wishes/ directories exist
  ['state', 'wishes'].forEach(dir => {
    const dirPath = path.join('.genie', dir);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  });

  // Copy root documentation files if missing
  const rootDocs = ['AGENTS.md', 'CLAUDE.md', 'README.md', '.gitignore'];
  for (const doc of rootDocs) {
    const source = path.join(templatesSource, doc);
    const dest = doc;

    if (fs.existsSync(source) && !fs.existsSync(dest)) {
      fs.copyFileSync(source, dest);
    }
  }
}

/**
 * Main migration orchestrator
 */
export async function runMigration(options: {
  force?: boolean;
  dryRun?: boolean;
} = {}): Promise<MigrationResult> {
  const result: MigrationResult = {
    status: 'failed',
    customAgentsPreserved: [],
    coreAgentsRemoved: [],
    customizationsExtracted: [],
    errors: [],
    warnings: []
  };

  try {
    // Step 1: Detect installation type
    const installType = detectInstallType();
    console.log(`📊 Installation type: ${installType}`);

    if (installType === 'clean') {
      console.log('✨ Clean installation detected');

      if (!options.dryRun) {
        copyTemplates(options);
      }

      result.status = 'clean_install';
      return result;
    }

    if (installType === 'already_new') {
      console.log('✅ Already using new structure');
      result.status = 'already_migrated';
      return result;
    }

    // Step 2: Backup existing installation
    console.log('💾 Creating backup...');
    if (!options.dryRun) {
      result.backupPath = backupGenie();
      console.log(`   Backup created: ${result.backupPath}`);
    }

    // Step 3: Analyze agents
    console.log('🔍 Analyzing agents...');
    const analysis = analyzeAgents();
    console.log(`   Core agents: ${analysis.core.length}`);
    console.log(`   Custom agents: ${analysis.custom.length}`);
    console.log(`   Modified: ${analysis.modified.length}`);

    result.customAgentsPreserved = analysis.custom;

    // Step 4: Extract customizations from modified core agents
    if (analysis.modified.length > 0) {
      console.log('📝 Extracting customizations...');
      if (!options.dryRun) {
        result.customizationsExtracted = extractCustomizations(analysis.modified);
      }
    }

    // Step 5: Remove core agents (they'll come from npm)
    console.log('🗑️  Removing core agents (now in npm package)...');
    if (!options.dryRun) {
      for (const agentId of analysis.core) {
        const agentPath = path.join('.genie', 'agents', `${agentId}.md`);
        if (fs.existsSync(agentPath)) {
          fs.unlinkSync(agentPath);
          result.coreAgentsRemoved.push(agentId);
        }
      }

      // Clean up empty directories
      const cleanEmptyDirs = (dir: string): void => {
        if (!fs.existsSync(dir)) return;

        const entries = fs.readdirSync(dir, { withFileTypes: true });

        // Recursively clean subdirectories first
        for (const entry of entries) {
          if (entry.isDirectory()) {
            cleanEmptyDirs(path.join(dir, entry.name));
          }
        }

        // If directory is empty, remove it
        const remaining = fs.readdirSync(dir);
        if (remaining.length === 0 || (remaining.length === 1 && remaining[0] === 'README.md')) {
          execSync(`rm -rf "${dir}"`);
        }
      };

      // Clean up legacy structure directories (if they exist)
      cleanEmptyDirs(path.join('.genie', 'agents', 'core'));
      cleanEmptyDirs(path.join('.genie', 'agents', 'qa'));

      // Clean up current structure directories (should be empty after core removal)
      cleanEmptyDirs(path.join('.genie', 'agents', 'workflows'));
      cleanEmptyDirs(path.join('.genie', 'agents', 'agents'));
    }

    // Step 6: Copy new templates
    console.log('📦 Installing new template structure...');
    if (!options.dryRun) {
      copyTemplates(options);
    }

    // Step 7: Success!
    console.log('✅ Migration complete!');
    result.status = 'upgraded';

    // Summary
    console.log('\n📋 Migration Summary:');
    console.log(`   Backup: ${result.backupPath}`);
    console.log(`   Custom agents preserved: ${result.customAgentsPreserved.length}`);
    console.log(`   Core agents removed: ${result.coreAgentsRemoved.length}`);
    if (result.customizationsExtracted.length > 0) {
      console.log(`   Customizations extracted: ${result.customizationsExtracted.length}`);
    }

  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
    console.error('❌ Migration failed:', error);
  }

  return result;
}
