#!/usr/bin/env node
const path = require('path');

// MCP server entry point
const entry = path.join(__dirname, '..', '.genie', 'mcp', 'dist', 'server.js');
require(entry);
