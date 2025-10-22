#!/usr/bin/env node

// Pass through to genie-cli.js (handles default server startup)
const path = require('path');
const entry = path.join(__dirname, '..', '.genie', 'cli', 'dist', 'genie-cli.js');
require(entry);
