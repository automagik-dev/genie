#!/usr/bin/env node
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Get __dirname equivalent in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Pass through to genie-cli.js (handles default server startup)
const entry = join(__dirname, '..', '.genie', 'cli', 'dist', 'genie-cli.js');
await import(entry);
