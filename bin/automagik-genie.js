#!/usr/bin/env node
const path = require('path');

const entry = path.join(__dirname, '..', '.genie', 'cli', 'dist', 'genie-cli.js');
require(entry);
