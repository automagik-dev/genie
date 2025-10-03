#!/usr/bin/env node
const path = require('path');

const entry = path.join(__dirname, '..', '.genie', 'cli', 'dist', 'genie-cli.js');
process.argv.splice(2, 0, 'rollback');
require(entry);
