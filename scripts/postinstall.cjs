#!/usr/bin/env node
/**
 * Post-install setup instructions for automagik-genie
 */

const fs = require('fs');
const path = require('path');

/**
 * Install git hooks if we're in a git repository
 */
function installGitHooks() {
  const gitDir = path.join(__dirname, '..', '.git');
  const hooksSourceDir = path.join(__dirname, '..', '.genie', 'scripts', 'hooks');

  // Check if we're in a git repository
  if (!fs.existsSync(gitDir)) {
    return; // Not a git repo, skip hook installation
  }

  // Check if .git is a file (worktree) or directory (main repo)
  const gitDirStats = fs.statSync(gitDir);
  let gitHooksDir;

  if (gitDirStats.isFile()) {
    // Worktree: read the gitdir path from .git file
    const gitDirContent = fs.readFileSync(gitDir, 'utf8');
    const match = gitDirContent.match(/gitdir:\s*(.+)/);
    if (match) {
      const worktreeGitDir = path.resolve(path.dirname(gitDir), match[1].trim());
      // For worktrees, hooks are in the main .git/hooks directory
      const mainGitDir = worktreeGitDir.replace(/\/worktrees\/[^/]+$/, '');
      gitHooksDir = path.join(mainGitDir, 'hooks');
    }
  } else {
    // Main repository
    gitHooksDir = path.join(gitDir, 'hooks');
  }

  if (!gitHooksDir || !fs.existsSync(gitHooksDir)) {
    return; // Can't find hooks directory
  }

  // Check if hook templates exist
  if (!fs.existsSync(hooksSourceDir)) {
    return; // No hook templates to install
  }

  // Install each hook
  const hooks = ['pre-commit', 'pre-push'];
  for (const hook of hooks) {
    const source = path.join(hooksSourceDir, hook + '.cjs');
    // Keep .cjs extension to avoid ESM/CommonJS issues (package.json has "type": "module")
    const dest = path.join(gitHooksDir, hook);

    if (!fs.existsSync(source)) {
      continue; // Hook template doesn't exist
    }

    try {
      // Copy hook file and keep CommonJS by using a shebang wrapper
      // Git hooks must be executable scripts without extension, so we create
      // a wrapper that explicitly runs node with the .cjs file
      const wrapper = `#!/usr/bin/env node\nrequire('${source}');\n`;
      fs.writeFileSync(dest, wrapper, { mode: 0o755 });
    } catch (err) {
      // Silently fail - don't break installation if hooks can't be installed
    }
  }
}

const GREEN = '\x1b[32m';
const BLUE = '\x1b[34m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

function printHeader(text) {
  console.log('');
  console.log(`${BLUE}${text}${RESET}`);
  console.log('='.repeat(text.length));
}

function printSuccess(text) {
  console.log(`${GREEN}✓${RESET} ${text}`);
}

function printCommand(description, command) {
  console.log(`  ${description}`);
  console.log(`  ${YELLOW}${command}${RESET}`);
  console.log('');
}

/**
 * Apply performance patches to dependencies
 */
function applyPerformancePatches() {
  const forgeCliPath = path.join(__dirname, '..', 'node_modules', 'automagik-forge', 'bin', 'cli.js');
  const patchedCliPath = path.join(__dirname, '..', 'patches', 'automagik-forge-cli.js');

  // Check if patch exists and forge is installed
  if (fs.existsSync(patchedCliPath) && fs.existsSync(forgeCliPath)) {
    try {
      // Apply blazing-fast startup patch (removes extraction delay)
      fs.copyFileSync(patchedCliPath, forgeCliPath);
      fs.chmodSync(forgeCliPath, 0o755);
    } catch (err) {
      // Silently fail - don't break installation
    }
  }
}

// Apply performance patches first
applyPerformancePatches();

// Install git hooks (silent)
installGitHooks();

console.log('');
console.log(`${GREEN}╔═══════════════════════════════════════════════════════════╗${RESET}`);
console.log(`${GREEN}║                                                           ║${RESET}`);
console.log(`${GREEN}║         🧞  Automagik Genie installed successfully!      ║${RESET}`);
console.log(`${GREEN}║                                                           ║${RESET}`);
console.log(`${GREEN}╚═══════════════════════════════════════════════════════════╝${RESET}`);

printHeader('Quick Start');
printSuccess('The global "genie" command is now available!');
console.log('');

printHeader('Basic Commands');

printCommand(
  'Run an agent:',
  'genie run <agent> "<prompt>"'
);

printCommand(
  'List available agents:',
  'genie list agents'
);

printCommand(
  'List active sessions:',
  'genie list sessions'
);

printCommand(
  'View session transcript:',
  'genie view <sessionId> --full'
);

printCommand(
  'Resume a session:',
  'genie resume <sessionId> "<follow-up prompt>"'
);

printCommand(
  'Stop a session:',
  'genie stop <sessionId>'
);

printHeader('MCP Server (Model Context Protocol)');

printCommand(
  'Start MCP server (stdio for Claude Desktop):',
  'genie mcp -t stdio'
);

printCommand(
  'Start MCP server (SSE for remote access):',
  'genie mcp -t sse -p 8080'
);

printCommand(
  'Start MCP server (HTTP streaming):',
  'genie mcp -t http -p 8080'
);

printHeader('Claude Desktop Integration');

console.log('  Add this to your Claude Desktop config:');
console.log(`  ${YELLOW}~/.config/Claude/claude_desktop_config.json${RESET} (Linux/Mac)`);
console.log(`  ${YELLOW}%APPDATA%\\Claude\\claude_desktop_config.json${RESET} (Windows)`);
console.log('');
console.log('  {');
console.log('    "mcpServers": {');
console.log('      "genie": {');
console.log('        "command": "npx",');
console.log('        "args": ["automagik-genie", "mcp", "-t", "stdio"]');
console.log('      }');
console.log('    }');
console.log('  }');
console.log('');

printHeader('Documentation');

printCommand(
  'View help:',
  'genie --help'
);

printCommand(
  'Command-specific help:',
  'genie <command> --help'
);

printHeader('Next Steps');

printSuccess('Initialize Genie in your project:');
console.log('  1. Navigate to your project directory');
console.log('  2. Create ".genie/agents/" directory');
console.log('  3. Add agent definitions (markdown files)');
console.log('  4. Run: genie run <agent> "your prompt"');
console.log('');

printSuccess('For more information:');
console.log('  - GitHub: https://github.com/automagik-genie/genie');
console.log('  - Docs: https://github.com/automagik-genie/genie#readme');
console.log('');

printSuccess('Happy automating! 🧞✨');
console.log('');
