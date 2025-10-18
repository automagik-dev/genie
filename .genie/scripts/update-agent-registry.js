#!/usr/bin/env node
/**
 * Agent Registry Auto-Generator
 *
 * Scans folder structure and generates agent/skill registry section in AGENTS.md
 * Part of self-updating ecosystem (Group D)
 *
 * Usage:
 *   node .genie/scripts/update-agent-registry.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');

// Configuration
const AGENTS_MD_PATH = path.join(process.cwd(), 'AGENTS.md');
const MARKER_START = '<!-- AUTO-GENERATED-START: Do not edit manually -->';
const MARKER_END = '<!-- AUTO-GENERATED-END -->';
const SECTION_HEADER = '## Agent Registry (Auto-Generated)';

// Folders to scan
const SCAN_PATHS = {
  'Universal Neurons': '.genie/agents/neurons',
  'Code Neurons': '.genie/agents/code/neurons',
  'Create Neurons': '.genie/agents/create/neurons',
  'Code Skills': '.genie/agents/code/skills',
};

/**
 * Scan a directory for .md files (non-recursive for top-level agents)
 * For neurons with workflows (like git), only count the parent neuron file
 */
function scanDirectory(dirPath) {
  const fullPath = path.join(process.cwd(), dirPath);

  if (!fs.existsSync(fullPath)) {
    return [];
  }

  const entries = fs.readdirSync(fullPath, { withFileTypes: true });
  const agents = [];

  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.md')) {
      // Extract agent name (filename without .md extension)
      const agentName = entry.name.replace(/\.md$/, '');
      agents.push(agentName);
    } else if (entry.isDirectory()) {
      // For directories like git/, look for the main neuron file (git.md)
      const neuronFile = path.join(fullPath, entry.name, `${entry.name}.md`);
      if (fs.existsSync(neuronFile)) {
        agents.push(entry.name);
      }
    }
  }

  return agents.sort();
}

/**
 * Generate registry markdown content
 */
function generateRegistryContent() {
  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19) + ' UTC';

  let content = `${SECTION_HEADER}\n${MARKER_START}\n`;
  content += `**Last Updated:** ${timestamp}\n\n`;

  // Scan each category
  for (const [category, dirPath] of Object.entries(SCAN_PATHS)) {
    const agents = scanDirectory(dirPath);
    const count = agents.length;

    content += `**${category}:** ${count} total\n`;

    if (count > 0) {
      // Format as comma-separated list
      const agentList = agents.join(', ');
      content += `- ${agentList}\n`;
    } else {
      content += `- (none)\n`;
    }

    content += '\n';
  }

  content += MARKER_END;

  return content;
}

/**
 * Find and replace registry section in AGENTS.md
 */
function updateAgentsFile(dryRun = false) {
  if (!fs.existsSync(AGENTS_MD_PATH)) {
    console.error(`❌ AGENTS.md not found at ${AGENTS_MD_PATH}`);
    process.exit(1);
  }

  const originalContent = fs.readFileSync(AGENTS_MD_PATH, 'utf8');

  // Check if section header exists
  if (!originalContent.includes(SECTION_HEADER)) {
    console.error(`❌ Section header "${SECTION_HEADER}" not found in AGENTS.md`);
    console.error('   Add this section manually first:');
    console.error('');
    console.error(SECTION_HEADER);
    console.error(MARKER_START);
    console.error('(content will be auto-generated)');
    console.error(MARKER_END);
    process.exit(1);
  }

  // Generate new registry content
  const newRegistryContent = generateRegistryContent();

  // Replace content between markers
  // Pattern: section header + any whitespace + start marker + any content + end marker
  const sectionPattern = new RegExp(
    `${escapeRegex(SECTION_HEADER)}[\\s\\S]*?${escapeRegex(MARKER_START)}[\\s\\S]*?${escapeRegex(MARKER_END)}`,
    'g'
  );

  const updatedContent = originalContent.replace(sectionPattern, newRegistryContent);

  if (originalContent === updatedContent) {
    console.log('✅ Agent registry already up to date');
    return false;
  }

  if (dryRun) {
    console.log('🔍 DRY RUN - Changes that would be made:');
    console.log('');
    console.log(newRegistryContent);
    return true;
  }

  // Write updated content
  fs.writeFileSync(AGENTS_MD_PATH, updatedContent, 'utf8');
  console.log('✅ Agent registry updated in AGENTS.md');

  // Show summary
  console.log('');
  console.log('📊 Registry Summary:');
  for (const [category, dirPath] of Object.entries(SCAN_PATHS)) {
    const agents = scanDirectory(dirPath);
    console.log(`   ${category}: ${agents.length} total`);
  }

  return true;
}

/**
 * Escape special regex characters
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Main execution
 */
function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  console.log('🤖 Agent Registry Auto-Generator');
  console.log('');

  if (dryRun) {
    console.log('Mode: DRY RUN (no changes will be made)');
    console.log('');
  }

  try {
    const changed = updateAgentsFile(dryRun);

    if (!dryRun && changed) {
      console.log('');
      console.log('Next steps:');
      console.log('  git add AGENTS.md');
      console.log('  git commit -m "chore: update agent registry"');
    }

    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

// Show help
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('Agent Registry Auto-Generator');
  console.log('');
  console.log('Usage:');
  console.log('  node .genie/scripts/update-agent-registry.js [--dry-run]');
  console.log('');
  console.log('Options:');
  console.log('  --dry-run    Preview changes without modifying files');
  console.log('  --help, -h   Show this help message');
  console.log('');
  console.log('Description:');
  console.log('  Scans agent/neuron/skill folders and auto-generates registry section');
  console.log('  in AGENTS.md between AUTO-GENERATED markers.');
  console.log('');
  console.log('Scanned folders:');
  console.log('  - .genie/agents/neurons/ (Universal Neurons)');
  console.log('  - .genie/agents/code/neurons/ (Code Neurons)');
  console.log('  - .genie/agents/create/neurons/ (Create Neurons)');
  console.log('  - .genie/agents/code/skills/ (Code Skills)');
  process.exit(0);
}

main();
