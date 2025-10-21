#!/usr/bin/env node
const path = require('path');

// Pass through to genie-cli.js (handles default server startup)
const entry = path.join(__dirname, '..', '.genie', 'cli', 'dist', 'genie-cli.js');
require(entry);
