#!/usr/bin/env node
/**
 * Post-install setup instructions for automagik-genie
 */

const fs = require('fs');
const path = require('path');

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
