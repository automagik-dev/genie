#!/usr/bin/env node
const path = require('path');

// MCP stdio-only entry point (for Claude Desktop via mcp_settings.json)
// DOES NOT start Forge - requires Forge to be running already
// Launches MCP in stdio mode for Desktop communication
process.argv = process.argv.slice(0, 2).concat(['mcp']);

const entry = path.join(__dirname, '..', 'dist', 'cli', 'genie-cli.js');
require(entry);
