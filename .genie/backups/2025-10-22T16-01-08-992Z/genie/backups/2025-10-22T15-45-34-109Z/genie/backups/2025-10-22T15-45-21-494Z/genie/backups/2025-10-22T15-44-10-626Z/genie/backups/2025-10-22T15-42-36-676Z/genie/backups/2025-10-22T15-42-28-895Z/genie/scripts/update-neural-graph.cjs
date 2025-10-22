#!/usr/bin/env node
/**
 * Knowledge Graph Generator
 *
 * Builds hierarchical token count graph from @ references in AGENTS.md
 * Part of self-updating ecosystem (Group C)
 *
 * Usage:
 *   node .genie/scripts/update-agent-graph.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const { Tiktoken } = require('js-tiktoken/lite');
const cl100k_base = require('js-tiktoken/ranks/cl100k_base');

// Configuration
const AGENTS_MD_PATH = path.join(process.cwd(), 'AGENTS.md');
const MARKER_START = '<!-- AUTO-GENERATED-START: Do not edit manually -->';
const MARKER_END = '<!-- AUTO-GENERATED-END -->';
const SECTION_HEADER = '## Knowledge Graph (Auto-Generated)';

// Initialize tiktoken encoder (cl100k_base for GPT-4/3.5-turbo)
const encoder = new Tiktoken(cl100k_base);

/**
 * Count tokens using tiktoken (accurate GPT-4 token counting)
 */
function countTokens(text) {
  return encoder.encode(text).length;
}

/**
 * Extract @ references from markdown content
 */
function extractAtReferences(content) {
  // Match @path/to/file.md patterns
  const matches = content.match(/@[\w/./-]+\.md/g) || [];
  // Remove @ prefix and return unique paths
  return [...new Set(matches.map(ref => ref.substring(1)))];
}

/**
 * Resolve file path (handle both absolute and relative paths)
 */
function resolveFilePath(refPath, basePath) {
  // If starts with ., it's relative to basePath
  if (refPath.startsWith('.')) {
    return path.resolve(basePath, refPath);
  }
  // Otherwise, relative to project root
  return path.resolve(process.cwd(), refPath);
}

/**
 * Build knowledge graph recursively
 */
function buildKnowledgeGraph(filePath, visited = new Set(), depth = 0) {
  // Prevent circular references and infinite recursion
  const normalizedPath = path.normalize(filePath);
  if (visited.has(normalizedPath)) {
    return null;
  }
  visited.add(normalizedPath);

  // Max depth safeguard
  if (depth > 10) {
    console.warn(`⚠️  Max depth reached for ${filePath}`);
    return null;
  }

  // Check file exists
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const tokens = countTokens(content);
  const basePath = path.dirname(filePath);

  const node = {
    path: filePath,
    relativePath: path.relative(process.cwd(), filePath),
    tokens: tokens,
    children: []
  };

  // Find @ references
  const atRefs = extractAtReferences(content);

  // Build children
  for (const ref of atRefs) {
    const childPath = resolveFilePath(ref, basePath);
    const childNode = buildKnowledgeGraph(childPath, visited, depth + 1);
    if (childNode) {
      node.children.push(childNode);
    }
  }

  return node;
}

/**
 * Calculate total tokens including all children
 */
function calculateTotalTokens(node) {
  if (!node) return 0;

  let total = node.tokens;
  for (const child of node.children) {
    total += calculateTotalTokens(child);
  }

  return total;
}

/**
 * Render agent graph as markdown tree
 */
function renderGraph(node, indent = 0) {
  if (!node) return '';

  const prefix = '  '.repeat(indent);
  const totalTokens = calculateTotalTokens(node);
  const childrenTokens = totalTokens - node.tokens;

  let output = `${prefix}- **${node.relativePath}** `;
  output += `(${node.tokens.toLocaleString()} tokens`;

  if (node.children.length > 0) {
    output += `, +${childrenTokens.toLocaleString()} from ${node.children.length} refs`;
  }

  output += `)\n`;

  // Render children
  for (const child of node.children) {
    output += renderGraph(child, indent + 1);
  }

  return output;
}

/**
 * Calculate distribution statistics
 */
function calculateDistribution(node, stats = { total: 0, byCategory: {} }) {
  if (!node) return stats;

  stats.total += node.tokens;

  // Categorize by path
  const relPath = node.relativePath;
  let category = 'Other';

  if (relPath.includes('/code/agents/')) {
    category = 'Code Agents';
  } else if (relPath.includes('/create/agents/')) {
    category = 'Create Agents';
  } else if (relPath.includes('/code/skills/')) {
    category = 'Code Skills';
  } else if (relPath.includes('.genie/skills/')) {
    category = 'Universal Skills';
  } else if (relPath.includes('/code/workflows/')) {
    category = 'Code Workflows';
  } else if (relPath.includes('/teams/')) {
    category = 'Advisory Teams';
  } else if (relPath === 'AGENTS.md' || relPath === 'CLAUDE.md') {
    category = 'Core Framework';
  } else if (relPath.includes('/product/')) {
    category = 'Product Docs';
  } else if (relPath.includes('/docs/')) {
    category = 'Documentation';
  }

  if (!stats.byCategory[category]) {
    stats.byCategory[category] = 0;
  }
  stats.byCategory[category] += node.tokens;

  // Recurse to children
  for (const child of node.children) {
    calculateDistribution(child, stats);
  }

  return stats;
}

/**
 * Generate knowledge graph content
 */
function generateKnowledgeGraphContent() {
  // Build graph starting from AGENTS.md
  console.log('📊 Building knowledge graph from AGENTS.md...');
  const graph = buildKnowledgeGraph(AGENTS_MD_PATH);

  if (!graph) {
    console.error('❌ Failed to build knowledge graph');
    process.exit(1);
  }

  const totalTokens = calculateTotalTokens(graph);
  const stats = calculateDistribution(graph);

  let content = `${SECTION_HEADER}\n${MARKER_START}\n`;
  content += `**Last Updated:** !\`date -u +"%Y-%m-%d %H:%M:%S UTC"\`\n`;
  content += `**Note:** Paths updated for new architecture (Genie → Collectives → Entities)\n`;
  content += `**Total Tokens:** ${totalTokens.toLocaleString()} (baseline for efficiency validation)\n\n`;

  // Distribution breakdown
  content += `**Distribution:**\n`;
  const sortedCategories = Object.entries(stats.byCategory)
    .sort((a, b) => b[1] - a[1]); // Sort by token count desc

  for (const [category, tokens] of sortedCategories) {
    const percentage = ((tokens / stats.total) * 100).toFixed(1);
    content += `- ${category}: ${tokens.toLocaleString()} tokens (${percentage}%)\n`;
  }
  content += `\n`;

  // Hierarchy tree
  content += `**Hierarchy:**\n\n`;
  content += renderGraph(graph);

  content += `\n${MARKER_END}`;

  return content;
}

/**
 * Find and replace knowledge graph section in AGENTS.md
 */
function updateAgentsFile(dryRun = false) {
  if (!fs.existsSync(AGENTS_MD_PATH)) {
    console.error(`❌ AGENTS.md not found at ${AGENTS_MD_PATH}`);
    process.exit(1);
  }

  const originalContent = fs.readFileSync(AGENTS_MD_PATH, 'utf8');

  // Check if section header exists
  if (!originalContent.includes(SECTION_HEADER)) {
    console.log(`ℹ️  Section header "${SECTION_HEADER}" not found - will add it`);

    // Add section at end of file
    const newSection = `\n\n${generateKnowledgeGraphContent()}\n`;

    if (dryRun) {
      console.log('🔍 DRY RUN - Would add new section:');
      console.log(newSection);
      return true;
    }

    fs.writeFileSync(AGENTS_MD_PATH, originalContent + newSection, 'utf8');
    console.log('✅ Knowledge graph section added to AGENTS.md');
    return true;
  }

  // Generate new graph content
  const newGraphContent = generateKnowledgeGraphContent();

  // Replace content between section header and end marker
  const sectionPattern = new RegExp(
    `${escapeRegex(SECTION_HEADER)}[\\s\\S]*?${escapeRegex(MARKER_END)}`,
    'g'
  );

  const updatedContent = originalContent.replace(sectionPattern, newGraphContent);

  if (originalContent === updatedContent) {
    console.log('✅ Knowledge graph already up to date');
    return false;
  }

  if (dryRun) {
    console.log('🔍 DRY RUN - Changes that would be made:');
    console.log('');
    console.log(newGraphContent);
    return true;
  }

  // Write updated content
  fs.writeFileSync(AGENTS_MD_PATH, updatedContent, 'utf8');
  console.log('✅ Knowledge graph updated in AGENTS.md');

  return true;
}

/**
 * Escape special regex characters
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Export baseline token count for validation script
 */
function getBaselineTokens() {
  const graph = buildKnowledgeGraph(AGENTS_MD_PATH);
  return calculateTotalTokens(graph);
}

/**
 * Main execution
 */
function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  console.log('📚 Knowledge Graph Generator');
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
      console.log('  git commit -m "chore: update knowledge graph"');
    }

    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Show help
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('Knowledge Graph Generator');
  console.log('');
  console.log('Usage:');
  console.log('  node .genie/scripts/update-agent-graph.js [--dry-run]');
  console.log('');
  console.log('Options:');
  console.log('  --dry-run    Preview changes without modifying files');
  console.log('  --help, -h   Show this help message');
  console.log('');
  console.log('Description:');
  console.log('  Builds hierarchical knowledge graph by parsing @ references from AGENTS.md');
  console.log('  Calculates token counts using tiktoken (GPT-4 accurate) for entire hierarchy');
  console.log('  Generates distribution statistics and dependency tree');
  console.log('  Updates AGENTS.md with auto-generated section');
  console.log('');
  console.log('Output:');
  console.log('  - Total token baseline for efficiency validation');
  console.log('  - Distribution breakdown by category (agents, skills, workflows, teams)');
  console.log('  - Hierarchical dependency tree with token counts');
  process.exit(0);
}

// Export for use by validation script
module.exports = { buildKnowledgeGraph, calculateTotalTokens, getBaselineTokens };

// Run if called directly
if (require.main === module) {
  main();
}
