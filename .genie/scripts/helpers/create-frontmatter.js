#!/usr/bin/env node

/**
 * Frontmatter Generator for Genie Framework
 *
 * Content-aware frontmatter generation that reads existing .md files,
 * analyzes content, and generates appropriate YAML frontmatter.
 *
 * Follows Amendment #6: Zero Metadata (no version, timestamps, author).
 *
 * Usage:
 *   genie helper create-frontmatter <file.md>
 *   genie helper create-frontmatter <file.md> --type=agent
 *
 * Example:
 *   # Agent with content already written
 *   genie helper create-frontmatter .genie/agents/my-agent.md
 *
 *   # Spell with manual type hint
 *   genie helper create-frontmatter .genie/spells/my-spell.md --type=spell
 */

const readline = require('readline');
const fs = require('fs');
const path = require('path');
const yaml = require('yaml');

// File type detection patterns
const TYPE_PATTERNS = {
  agent: {
    pathHints: ['/agents/', '/agent-', 'agent.md'],
    contentHints: ['executor', 'background', 'Identity & Mission', 'Operating Prompt']
  },
  spell: {
    pathHints: ['/spells/', '/spell-', 'spell.md'],
    contentHints: ['Core Principle', '## When to', 'Spell:', 'Skill:']
  },
  wish: {
    pathHints: ['/wishes/', '/wish-', 'wish.md'],
    contentHints: ['🧞', 'WISH', 'GitHub Issue', '## Context Ledger', '## Execution Groups']
  },
  report: {
    pathHints: ['/reports/', '/report-', 'report.md'],
    contentHints: ['## Executive Summary', '## QA', '## Test', '**Date:**', '**Status:**']
  }
};

// Frontmatter schemas by type
const SCHEMAS = {
  agent: {
    required: ['name', 'description', 'genie'],
    fields: {
      name: { type: 'string', prompt: 'Agent name (e.g., "code", "writer")' },
      description: { type: 'string', prompt: 'Brief agent purpose' },
      genie: {
        type: 'object',
        fields: {
          executor: { type: 'enum', values: ['CLAUDE_CODE', 'OPENCODE', 'CODEX', 'AMP'], default: 'CLAUDE_CODE' },
          background: { type: 'boolean', default: true }
        }
      },
      forge: {
        type: 'object',
        optional: true,
        fields: {
          model: { type: 'enum', values: ['haiku', 'sonnet', 'opus-4'], default: 'sonnet' }
        }
      }
    }
  },
  spell: {
    required: ['name', 'description'],
    fields: {
      name: { type: 'string', prompt: 'Spell name' },
      description: { type: 'string', prompt: 'Brief spell purpose' }
    }
  },
  wish: {
    required: ['github_issue', 'status'],
    fields: {
      github_issue: { type: 'number', prompt: 'GitHub issue number' },
      status: { type: 'enum', values: ['DRAFT', 'ACTIVE', 'COMPLETE', 'BLOCKED'], default: 'DRAFT' },
      roadmap_item: { type: 'string', optional: true },
      mission_link: { type: 'string', optional: true }
    }
  },
  report: {
    required: ['date', 'context'],
    fields: {
      date: { type: 'date', prompt: 'Report date (YYYY-MM-DD or "today")' },
      context: { type: 'string', prompt: 'What is this report about?' },
      goal: { type: 'string', optional: true },
      status: { type: 'enum', values: ['DRAFT', 'FINAL', 'ARCHIVED'], optional: true }
    }
  }
};

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Parse CLI arguments
function parseArgs() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    showHelp();
    process.exit(0);
  }

  const file = args.find(arg => !arg.startsWith('--'));
  const typeFlag = args.find(arg => arg.startsWith('--type='));
  const type = typeFlag ? typeFlag.split('=')[1] : null;

  if (!file) {
    console.error('❌ Error: Missing file argument');
    console.error('Usage: genie helper create-frontmatter <file.md>');
    process.exit(1);
  }

  return { file, type };
}

function showHelp() {
  console.log('');
  console.log('Frontmatter Generator - Content-Aware');
  console.log('━'.repeat(60));
  console.log('');
  console.log('Usage:');
  console.log('  genie helper create-frontmatter <file.md>');
  console.log('  genie helper create-frontmatter <file.md> --type=TYPE');
  console.log('');
  console.log('Options:');
  console.log('  --type=TYPE        Force file type (agent, spell, wish, report)');
  console.log('  --help, -h         Show this help');
  console.log('');
  console.log('Examples:');
  console.log('  $ genie helper create-frontmatter .genie/agents/my-agent.md');
  console.log('  $ genie helper create-frontmatter .genie/spells/learn.md --type=spell');
  console.log('');
}

// Detect file type from path and content
function detectFileType(filePath, content) {
  const scores = {};

  for (const [type, patterns] of Object.entries(TYPE_PATTERNS)) {
    let score = 0;

    // Check path hints
    for (const hint of patterns.pathHints) {
      if (filePath.includes(hint)) {
        score += 10;
        break;
      }
    }

    // Check content hints
    for (const hint of patterns.contentHints) {
      if (content.includes(hint)) {
        score += 5;
      }
    }

    scores[type] = score;
  }

  // Return type with highest score
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  return sorted[0][1] > 0 ? sorted[0][0] : 'spell'; // Default to spell
}

// Extract information from content
function extractFromContent(content, type) {
  const extracted = {};

  // Extract first H1 heading as name
  const h1Match = content.match(/^#\s+(.+)$/m);
  if (h1Match) {
    extracted.name = h1Match[1].replace(/🧞|✨|🔮|📝/g, '').trim();
  }

  // Extract first paragraph as description (first non-empty line after heading)
  const lines = content.split('\n');
  let foundHeading = false;
  for (const line of lines) {
    if (line.startsWith('#')) {
      foundHeading = true;
      continue;
    }
    if (foundHeading && line.trim() && !line.startsWith('**') && !line.startsWith('---')) {
      extracted.description = line.trim();
      break;
    }
  }

  // Type-specific extraction
  if (type === 'wish') {
    // Extract GitHub issue number
    const issueMatch = content.match(/(?:GitHub Issue|Issue):\s*#?(\d+)/i);
    if (issueMatch) {
      extracted.github_issue = parseInt(issueMatch[1]);
    }

    // Extract status
    const statusMatch = content.match(/\*\*Status:\*\*\s*([A-Z]+)/);
    if (statusMatch) {
      extracted.status = statusMatch[1];
    }
  }

  if (type === 'report') {
    // Extract date
    const dateMatch = content.match(/\*\*Date:\*\*\s*([\d-]+)/);
    if (dateMatch) {
      extracted.date = dateMatch[1];
    }

    // Extract context
    const contextMatch = content.match(/\*\*Context:\*\*\s*(.+)/);
    if (contextMatch) {
      extracted.context = contextMatch[1].trim();
    }
  }

  return extracted;
}

// Prompt user for input
function prompt(question) {
  return new Promise(resolve => {
    rl.question(question + ' ', resolve);
  });
}

// Collect missing required fields
async function collectMissingFields(schema, extracted) {
  const values = { ...extracted };

  for (const [fieldName, fieldConfig] of Object.entries(schema.fields)) {
    // Skip if already extracted
    if (values[fieldName] !== undefined) {
      continue;
    }

    // Skip optional fields
    if (fieldConfig.optional && !schema.required.includes(fieldName)) {
      continue;
    }

    // Handle nested objects (genie, forge)
    if (fieldConfig.type === 'object') {
      const nestedValues = {};

      // Ask if user wants to include optional nested objects
      if (fieldConfig.optional) {
        const answer = await prompt(`Include ${fieldName} config? (y/n) [n]:`);
        if (answer.toLowerCase() !== 'y') {
          continue;
        }
      }

      for (const [nestedName, nestedConfig] of Object.entries(fieldConfig.fields)) {
        const value = await promptField(nestedName, nestedConfig);
        if (value !== null) {
          nestedValues[nestedName] = value;
        }
      }

      if (Object.keys(nestedValues).length > 0) {
        values[fieldName] = nestedValues;
      }
    } else {
      const value = await promptField(fieldName, fieldConfig);
      if (value !== null) {
        values[fieldName] = value;
      }
    }
  }

  return values;
}

// Prompt for single field
async function promptField(fieldName, fieldConfig) {
  let promptText = `${fieldName}`;

  if (fieldConfig.prompt) {
    promptText += ` (${fieldConfig.prompt})`;
  }

  if (fieldConfig.type === 'enum') {
    promptText += ` [${fieldConfig.values.join(', ')}]`;
  }

  if (fieldConfig.default) {
    promptText += ` [${fieldConfig.default}]`;
  }

  if (fieldConfig.optional) {
    promptText += ' (optional)';
  }

  promptText += ':';

  const answer = await prompt(promptText);

  // Use default if empty
  if (answer.trim() === '' && fieldConfig.default) {
    return fieldConfig.default;
  }

  // Skip if empty and optional
  if (answer.trim() === '' && fieldConfig.optional) {
    return null;
  }

  // Type conversion
  const value = answer.trim();
  if (fieldConfig.type === 'number') {
    return parseInt(value);
  } else if (fieldConfig.type === 'boolean') {
    return value === 'true';
  } else if (fieldConfig.type === 'date') {
    return value === 'today' ? new Date().toISOString().split('T')[0] : value;
  }

  return value;
}

// Generate frontmatter YAML
function generateFrontmatter(values) {
  const yamlString = yaml.stringify(values, {
    defaultStringType: 'PLAIN',
    lineWidth: 0
  });
  return `---\n${yamlString}---\n\n`;
}

// Prepend frontmatter to file
function prependFrontmatter(filePath, frontmatter, content) {
  // Backup original
  const backupPath = `${filePath}.backup`;
  fs.copyFileSync(filePath, backupPath);
  console.log(`   Backed up original: ${path.basename(backupPath)}`);

  // Write new content
  const newContent = frontmatter + content;
  fs.writeFileSync(filePath, newContent, 'utf8');
  console.log(`   ✅ Frontmatter prepended to: ${filePath}`);
}

// Main
async function main() {
  const { file, type: forcedType } = parseArgs();

  // Check file exists
  if (!fs.existsSync(file)) {
    console.error(`❌ Error: File not found: ${file}`);
    process.exit(1);
  }

  console.log('');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║       Genie Frontmatter Generator                         ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');

  // Read file
  const content = fs.readFileSync(file, 'utf8');

  // Check if frontmatter already exists
  if (content.startsWith('---')) {
    const confirm = await prompt('⚠️  Frontmatter already exists. Overwrite? (y/n) [n]:');
    if (confirm.toLowerCase() !== 'y') {
      console.log('Aborted.');
      rl.close();
      return;
    }
    // Strip existing frontmatter
    const endIndex = content.indexOf('\n---', 3);
    if (endIndex !== -1) {
      const cleanContent = content.slice(endIndex + 4).trimStart();
      fs.writeFileSync(file, cleanContent, 'utf8');
      console.log('   Removed existing frontmatter');
    }
  }

  // Re-read cleaned content
  const cleanContent = fs.readFileSync(file, 'utf8');

  // Detect type
  const detectedType = forcedType || detectFileType(file, cleanContent);
  console.log(`📋 Detected type: ${detectedType}`);

  const schema = SCHEMAS[detectedType];
  if (!schema) {
    console.error(`❌ Unknown type: ${detectedType}`);
    process.exit(1);
  }

  // Extract information from content
  console.log('🔍 Analyzing content...\n');
  const extracted = extractFromContent(cleanContent, detectedType);

  if (Object.keys(extracted).length > 0) {
    console.log('📝 Extracted from content:');
    for (const [key, value] of Object.entries(extracted)) {
      console.log(`   ${key}: ${value}`);
    }
    console.log('');
  }

  // Collect missing fields
  console.log('⚙️  Configuring frontmatter...\n');
  const values = await collectMissingFields(schema, extracted);

  // Generate frontmatter
  const frontmatter = generateFrontmatter(values);

  // Preview
  console.log('');
  console.log('━'.repeat(60));
  console.log('Generated Frontmatter:');
  console.log('━'.repeat(60));
  console.log(frontmatter.trim());
  console.log('━'.repeat(60));

  // Amendment #6 check
  console.log('');
  console.log('✅ Amendment #6 Compliance:');
  console.log('   - No version field ✓');
  console.log('   - No last_updated field ✓');
  console.log('   - No author field ✓');
  console.log('   - Only semantic frontmatter ✓');
  console.log('');

  // Confirm
  const confirm = await prompt('Apply frontmatter to file? (y/n) [y]:');
  if (confirm.toLowerCase() !== 'n') {
    prependFrontmatter(file, frontmatter, cleanContent);
    console.log('');
    console.log('✅ Done!');
  } else {
    console.log('Aborted.');
  }

  rl.close();
}

main().catch(err => {
  console.error('\n❌ Error:', err.message);
  rl.close();
  process.exit(1);
});
