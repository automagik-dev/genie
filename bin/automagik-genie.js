#!/usr/bin/env node
const path = require('path');

// Default to server startup if no command provided
const args = process.argv.slice(2);
if (args.length === 0) {
  // Default: start Genie server (Forge + MCP with SSE)
  process.argv.push('start');
}

const entry = path.join(__dirname, '..', '.genie', 'cli', 'dist', 'genie-cli.js');
require(entry);
