#!/usr/bin/env node
const path = require('path');

const entry = path.join(__dirname, '..', 'dist', 'cli', 'genie-cli.js');
process.argv.splice(2, 0, 'status');
require(entry);
