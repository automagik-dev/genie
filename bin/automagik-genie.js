#!/usr/bin/env node

/**
 * Automagik Genie Entry Point
 *
 * When called without arguments, launches unified startup (Forge + MCP + Auth)
 * Otherwise delegates to genie-cli for other commands
 */

const path = require('path');
const fs = require('fs');

// Check if this is a unified startup (no args) or CLI command
const args = process.argv.slice(2);
const isUnifiedStartup = args.length === 0;

if (isUnifiedStartup) {
  // Launch unified startup (Forge + MCP together)
  const unifiedStartup = path.join(__dirname, '..', '.genie', 'cli', 'dist', 'unified-startup.js');

  // Hard dependency check: Ensure unified-startup.js exists
  if (!fs.existsSync(unifiedStartup)) {
    console.error('❌ Error: unified-startup.js not found');
    console.error('📁 Expected at: ' + unifiedStartup);
    console.error('\n💡 This usually means the project wasn\'t built correctly.');
    console.error('   Run: pnpm run build');
    console.error('   Or: npm run build\n');
    process.exit(1);
  }

  require(unifiedStartup);
} else {
  // Delegate to genie-cli for commands like 'genie run', 'genie forge start', etc.
  const entry = path.join(__dirname, '..', '.genie', 'cli', 'dist', 'genie-cli.js');

  // Hard dependency check: Ensure genie-cli.js exists
  if (!fs.existsSync(entry)) {
    console.error('❌ Error: genie-cli.js not found');
    console.error('📁 Expected at: ' + entry);
    console.error('\n💡 This usually means the project wasn\'t built correctly.');
    console.error('   Run: pnpm run build');
    console.error('   Or: npm run build\n');
    process.exit(1);
  }

  require(entry);
}
