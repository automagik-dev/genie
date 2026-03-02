#!/usr/bin/env node

/**
 * Genie Helper CLI Router
 *
 * Provides easy access to all Genie helper utilities.
 *
 * Usage:
 *   genie helper <command> [args]
 *   node .genie/scripts/helpers/index.js <command> [args]
 *
 * Available commands:
 *   count-tokens <file>                - Count tokens in file
 *   count-tokens --before=f1 --after=f2 - Compare token counts
 *   validate-frontmatter <dir>         - Validate YAML frontmatter
 *   create-frontmatter <file.md>       - Generate frontmatter from content
 *   detect-markers <dir>               - Find TODO/FIXME markers
 *   list                              - List all available helpers
 *   help [command]                    - Show help for a command
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const HELPERS_DIR = __dirname;

// Available helpers and their descriptions
const HELPERS = {
  'count-tokens': {
    script: 'count-tokens.js',
    description: 'Count tokens in files using tiktoken (cl100k_base)',
    usage: [
      'genie helper count-tokens <file>',
      'genie helper count-tokens --before=old.md --after=new.md',
      'echo "text" | genie helper count-tokens'
    ],
    examples: [
      '$ genie helper count-tokens AGENTS.md',
      '$ genie helper count-tokens --before=v1.md --after=v2.md'
    ]
  },
  'validate-frontmatter': {
    script: 'validate-frontmatter.js',
    description: 'Validate YAML frontmatter in markdown files',
    usage: [
      'genie helper validate-frontmatter <directory>'
    ],
    examples: [
      '$ genie helper validate-frontmatter .genie',
      '$ genie helper validate-frontmatter .genie/spells'
    ]
  },
  'detect-markers': {
    script: 'detect-markers.js',
    description: 'Detect TODO/FIXME markers and merge conflicts',
    usage: [
      'genie helper detect-markers <directory>'
    ],
    examples: [
      '$ genie helper detect-markers .genie',
      '$ genie helper detect-markers .'
    ]
  },
  'analyze-commit': {
    script: 'analyze-commit.js',
    description: 'Analyze commit messages (conventional commits, traceability)',
    usage: [
      'genie helper analyze-commit [commit-hash]',
      'genie helper analyze-commit --staged'
    ],
    examples: [
      '$ genie helper analyze-commit HEAD',
      '$ genie helper analyze-commit abc123',
      '$ genie helper analyze-commit --staged'
    ]
  },
  'check-secrets': {
    script: 'check-secrets.js',
    description: 'Detect secrets and credentials in files',
    usage: [
      'genie helper check-secrets [files...]',
      'genie helper check-secrets --staged'
    ],
    examples: [
      '$ genie helper check-secrets',
      '$ genie helper check-secrets --staged',
      '$ genie helper check-secrets file1.ts file2.ts'
    ]
  },
  'detect-todos': {
    script: 'detect-todos.js',
    description: 'Detect TODO/FIXME/WIP markers in markdown files',
    usage: [
      'genie helper detect-todos [directory]'
    ],
    examples: [
      '$ genie helper detect-todos .genie',
      '$ genie helper detect-todos'
    ]
  },
  'detect-unlabeled-blocks': {
    script: 'detect-unlabeled-blocks.js',
    description: 'Detect unlabeled code blocks in markdown files',
    usage: [
      'genie helper detect-unlabeled-blocks [directory]'
    ],
    examples: [
      '$ genie helper detect-unlabeled-blocks .genie'
    ]
  },
  'find-empty-sections': {
    script: 'find-empty-sections.js',
    description: 'Find empty sections in markdown files',
    usage: [
      'genie helper find-empty-sections [directory]'
    ],
    examples: [
      '$ genie helper find-empty-sections .genie'
    ]
  },
  'validate-links': {
    script: 'validate-links.js',
    description: 'Validate @ references and links in markdown files',
    usage: [
      'genie helper validate-links [directory]'
    ],
    examples: [
      '$ genie helper validate-links .genie'
    ]
  },
  'embeddings': {
    script: 'embeddings.js',
    description: 'Check if new learning already exists in target section (deduplication)',
    usage: [
      'genie helper embeddings "new learning text" file.md "Section Name"',
      'genie helper embeddings clear-cache'
    ],
    examples: [
      '$ genie helper embeddings "Never rewrite sections" .genie/spells/learn.md "Grow-and-Refine"',
      '$ genie helper embeddings clear-cache'
    ]
  },
  'bullet-id': {
    script: 'bullet-id.js',
    description: 'Generate unique IDs for structured learning bullets',
    usage: [
      'genie helper bullet-id file.md',
      'genie helper bullet-id file.md --count=10',
      'genie helper bullet-id file.md --peek'
    ],
    examples: [
      '$ genie helper bullet-id .genie/spells/learn.md',
      '$ genie helper bullet-id .genie/spells/learn.md --count=5'
    ]
  },
  'bullet-counter': {
    script: 'bullet-counter.js',
    description: 'Update helpful/harmful counters for learning bullets',
    usage: [
      'genie helper bullet-counter ID',
      'genie helper bullet-counter ID --helpful',
      'genie helper bullet-counter ID --harmful'
    ],
    examples: [
      '$ genie helper bullet-counter learn-042',
      '$ genie helper bullet-counter learn-042 --helpful'
    ]
  },
  'bullet-find': {
    script: 'bullet-find.js',
    description: 'Find and query structured learning bullets',
    usage: [
      'genie helper bullet-find ID',
      'genie helper bullet-find --top-helpful --limit=10',
      'genie helper bullet-find --top-harmful --limit=10',
      'genie helper bullet-find --file=file.md',
      'genie helper bullet-find --search="keyword"'
    ],
    examples: [
      '$ genie helper bullet-find learn-042',
      '$ genie helper bullet-find --top-helpful --limit=5',
      '$ genie helper bullet-find --search="delegate"'
    ]
  },
  'validate-paths': {
    script: 'validate-paths.js',
    description: 'Validate all literal file path references in codebase',
    usage: [
      'genie helper validate-paths',
      'genie helper validate-paths --staged',
      'genie helper validate-paths --verbose'
    ],
    examples: [
      '$ genie helper validate-paths',
      '$ genie helper validate-paths --staged',
      '$ genie helper validate-paths --verbose'
    ]
  },
  'create-frontmatter': {
    script: 'create-frontmatter.js',
    description: 'Content-aware frontmatter generator (reads .md, analyzes, generates)',
    usage: [
      'genie helper create-frontmatter <file.md>',
      'genie helper create-frontmatter <file.md> --type=TYPE'
    ],
    examples: [
      '$ genie helper create-frontmatter .genie/agents/my-agent.md',
      '$ genie helper create-frontmatter .genie/spells/learn.md --type=spell'
    ]
  }
};

function showList() {
  console.log('');
  console.log('Available Genie Helpers:');
  console.log('━'.repeat(60));
  console.log('');

  Object.entries(HELPERS).forEach(([name, info]) => {
    console.log(`  ${name.padEnd(25)} ${info.description}`);
  });

  console.log('');
  console.log('Usage:');
  console.log('  genie helper <command> [args]');
  console.log('  genie helper help [command]   Show help for specific command');
  console.log('');
}

function showHelp(command) {
  if (!command) {
    showList();
    return;
  }

  const helper = HELPERS[command];
  if (!helper) {
    console.error(`Unknown helper: ${command}`);
    console.error('');
    showList();
    process.exit(1);
  }

  console.log('');
  console.log(`${command} - ${helper.description}`);
  console.log('━'.repeat(60));
  console.log('');
  console.log('Usage:');
  helper.usage.forEach(usage => {
    console.log(`  ${usage}`);
  });

  if (helper.examples && helper.examples.length > 0) {
    console.log('');
    console.log('Examples:');
    helper.examples.forEach(example => {
      console.log(`  ${example}`);
    });
  }

  console.log('');
}

function runHelper(command, args) {
  const helper = HELPERS[command];

  if (!helper) {
    console.error(`Unknown helper: ${command}`);
    console.error('');
    console.error('Run "genie helper list" to see available helpers');
    process.exit(1);
  }

  const scriptPath = path.join(HELPERS_DIR, helper.script);

  if (!fs.existsSync(scriptPath)) {
    console.error(`Helper script not found: ${scriptPath}`);
    process.exit(1);
  }

  // Spawn the helper script
  const child = spawn('node', [scriptPath, ...args], {
    stdio: 'inherit',
    env: process.env
  });

  child.on('exit', (code) => {
    process.exit(code || 0);
  });

  child.on('error', (err) => {
    console.error(`Failed to run helper: ${err.message}`);
    process.exit(1);
  });
}

// Main CLI router
function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === 'list') {
    showList();
    return;
  }

  const command = args[0];

  if (command === 'help' || command === '--help' || command === '-h') {
    showHelp(args[1]);
    return;
  }

  // Run the helper with remaining args
  const helperArgs = args.slice(1);
  runHelper(command, helperArgs);
}

main();
