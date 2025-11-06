#!/usr/bin/env node

/**
 * Fix Agent Frontmatter Models
 *
 * Corrects model configurations in agent frontmatter:
 * - Executor order: CLAUDE_CODE, CODEX, OPENCODE
 * - CLAUDE_CODE: sonnet (keep existing haiku, opus, etc.)
 * - CODEX: gpt-5-codex
 * - OPENCODE: opencode/glm-4.6 (replace all grok models)
 */

const fs = require('fs');
const path = require('path');
const yaml = require('yaml');

const DRY_RUN = process.argv.includes('--dry-run');

// ANSI colors
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function findAgentFiles(dir, files = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      // Skip non-agent directories
      const skipDirs = ['spells', 'workflows', 'reports', 'state', 'product', 'qa',
                        'wishes', 'scripts', 'utilities', 'specs', '.cache',
                        'node_modules', '.git', 'backups'];
      if (!skipDirs.includes(entry.name)) {
        findAgentFiles(fullPath, files);
      }
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      // Skip README and AGENTS files
      const name = path.basename(entry.name, '.md');
      if (!['README', 'AGENTS'].includes(name.toUpperCase())) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

function extractFrontmatter(content) {
  const regex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;
  const match = content.match(regex);

  if (!match) {
    return null;
  }

  try {
    const frontmatter = yaml.parse(match[1]);
    const body = match[2];
    return { frontmatter, body, rawYaml: match[1] };
  } catch (e) {
    return null;
  }
}

function getClaudeModel(existingModel) {
  // Keep existing Claude models (haiku, opus, sonnet-4-5, etc.)
  // Default to sonnet if none specified
  if (!existingModel) return 'sonnet';

  const claudeModels = ['haiku', 'opus', 'sonnet', 'sonnet-4-5', 'sonnet-4.5'];
  const normalized = existingModel.toLowerCase();

  // If it's already a valid Claude model, keep it
  if (claudeModels.some(m => normalized.includes(m))) {
    return existingModel;
  }

  // Otherwise default to sonnet
  return 'sonnet';
}

function fixFrontmatter(frontmatter) {
  if (!frontmatter.genie || !frontmatter.genie.executor) {
    return { changed: false, frontmatter };
  }

  let changed = false;
  const newFrontmatter = JSON.parse(JSON.stringify(frontmatter));

  // Ensure executor is an array
  const executors = Array.isArray(newFrontmatter.genie.executor)
    ? newFrontmatter.genie.executor
    : [newFrontmatter.genie.executor];

  // Fix executor order and ensure all three are present
  const targetExecutors = ['CLAUDE_CODE', 'CODEX', 'OPENCODE'];
  const hasExecutors = targetExecutors.filter(e => executors.includes(e));

  if (hasExecutors.length > 0) {
    newFrontmatter.genie.executor = targetExecutors;
    if (JSON.stringify(frontmatter.genie.executor) !== JSON.stringify(targetExecutors)) {
      changed = true;
    }
  }

  // Initialize forge if not present
  if (!newFrontmatter.forge) {
    newFrontmatter.forge = {};
  }

  // Fix CLAUDE_CODE model
  if (executors.includes('CLAUDE_CODE')) {
    const existingClaudeModel = newFrontmatter.forge.CLAUDE_CODE?.model;
    const newClaudeModel = getClaudeModel(existingClaudeModel);

    if (!newFrontmatter.forge.CLAUDE_CODE) {
      newFrontmatter.forge.CLAUDE_CODE = {};
    }

    if (newFrontmatter.forge.CLAUDE_CODE.model !== newClaudeModel) {
      newFrontmatter.forge.CLAUDE_CODE.model = newClaudeModel;
      changed = true;
    }
  }

  // Fix CODEX model
  if (executors.includes('CODEX')) {
    if (!newFrontmatter.forge.CODEX) {
      newFrontmatter.forge.CODEX = {};
    }

    if (newFrontmatter.forge.CODEX.model !== 'gpt-5-codex') {
      newFrontmatter.forge.CODEX.model = 'gpt-5-codex';
      changed = true;
    }
  }

  // Fix OPENCODE model (replace grok with glm-4-plus)
  if (executors.includes('OPENCODE')) {
    if (!newFrontmatter.forge.OPENCODE) {
      newFrontmatter.forge.OPENCODE = {};
    }

    const existingModel = newFrontmatter.forge.OPENCODE.model || '';
    const isGrok = existingModel.includes('grok') || existingModel.includes('xai');

    if (!newFrontmatter.forge.OPENCODE.model || isGrok) {
      newFrontmatter.forge.OPENCODE.model = 'opencode/glm-4.6';
      changed = true;
    }
  }

  return { changed, frontmatter: newFrontmatter };
}

function formatYaml(obj) {
  // Custom YAML formatting to match existing style
  return yaml.stringify(obj, {
    indent: 2,
    lineWidth: 0,
    defaultStringType: 'PLAIN',
    defaultKeyType: 'PLAIN',
  });
}

function processFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const parsed = extractFrontmatter(content);

  if (!parsed) {
    log(`  ⊘ No valid frontmatter`, 'dim');
    return { skipped: true };
  }

  const { changed, frontmatter: newFrontmatter } = fixFrontmatter(parsed.frontmatter);

  if (!changed) {
    log(`  ✓ Already correct`, 'dim');
    return { skipped: true };
  }

  // Show changes
  const oldExecutors = parsed.frontmatter.genie?.executor || [];
  const newExecutors = newFrontmatter.genie?.executor || [];
  const oldForge = parsed.frontmatter.forge || {};
  const newForge = newFrontmatter.forge || {};

  log(`  Changes:`, 'yellow');

  if (JSON.stringify(oldExecutors) !== JSON.stringify(newExecutors)) {
    log(`    executors: ${JSON.stringify(oldExecutors)} → ${JSON.stringify(newExecutors)}`, 'cyan');
  }

  for (const executor of ['CLAUDE_CODE', 'CODEX', 'OPENCODE']) {
    const oldModel = oldForge[executor]?.model;
    const newModel = newForge[executor]?.model;

    if (oldModel !== newModel) {
      log(`    ${executor}.model: ${oldModel || '(none)'} → ${newModel}`, 'cyan');
    }
  }

  if (DRY_RUN) {
    log(`  [DRY RUN] Would update file`, 'yellow');
    return { changed: true, dryRun: true };
  }

  // Write updated file
  const newYaml = formatYaml(newFrontmatter);
  const newContent = `---\n${newYaml}---\n${parsed.body}`;
  fs.writeFileSync(filePath, newContent, 'utf-8');

  log(`  ✓ Updated`, 'green');
  return { changed: true };
}

function main() {
  const genieRoot = path.join(__dirname, '..');

  log('\n=== Agent Frontmatter Model Fixer ===\n', 'bright');

  if (DRY_RUN) {
    log('🔍 DRY RUN MODE - No files will be modified\n', 'yellow');
  }

  // Find all agent files
  const agentDirs = [
    path.join(genieRoot, 'agents'),
    path.join(genieRoot, 'code', 'agents'),
    path.join(genieRoot, 'create', 'agents'),
    path.join(genieRoot, 'neurons'),
  ];

  let allFiles = [];
  for (const dir of agentDirs) {
    if (fs.existsSync(dir)) {
      const files = findAgentFiles(dir);
      allFiles = allFiles.concat(files);
    }
  }

  log(`Found ${allFiles.length} agent files\n`, 'bright');

  let stats = {
    total: 0,
    changed: 0,
    skipped: 0,
  };

  for (const file of allFiles) {
    const relativePath = path.relative(genieRoot, file);
    log(`\n${relativePath}`, 'blue');

    stats.total++;
    const result = processFile(file);

    if (result.changed) {
      stats.changed++;
    } else if (result.skipped) {
      stats.skipped++;
    }
  }

  // Summary
  log('\n' + '='.repeat(50), 'dim');
  log('\nSummary:', 'bright');
  log(`  Total files: ${stats.total}`, 'dim');
  log(`  Changed: ${stats.changed}`, stats.changed > 0 ? 'green' : 'dim');
  log(`  Skipped: ${stats.skipped}`, 'dim');

  if (DRY_RUN && stats.changed > 0) {
    log('\n💡 Run without --dry-run to apply changes', 'yellow');
  }

  log('');
}

main();
