#!/usr/bin/env node
const path = require('path');

// MCP server entry point - now goes through genie-cli to auto-start Forge
process.argv = process.argv.slice(0, 2).concat(['mcp']);

const entry = path.join(__dirname, '..', '.genie', 'cli', 'dist', 'genie-cli.js');
require(entry);
