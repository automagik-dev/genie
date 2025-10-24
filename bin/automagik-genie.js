#!/usr/bin/env node

/**
 * Automagik Genie Entry Point
 *
 * When called without arguments, launches unified startup (Forge + MCP + Auth)
 * Otherwise delegates to genie-cli for other commands
 */

const path = require('path');

// Check if this is a unified startup (no args) or CLI command
const args = process.argv.slice(2);
const isUnifiedStartup = args.length === 0;

if (isUnifiedStartup) {
  // Launch unified startup (Forge + MCP together)
  const unifiedStartup = path.join(__dirname, '..', '.genie', 'cli', 'dist', 'unified-startup.js');
  require(unifiedStartup);
} else {
  // Delegate to genie-cli for commands like 'genie run', 'genie forge start', etc.
  const entry = path.join(__dirname, '..', '.genie', 'cli', 'dist', 'genie-cli.js');
  require(entry);
}
