#!/usr/bin/env node
'use strict';

/**
 * Retired SessionStart scaffolder retained as a compatibility diagnostic.
 *
 * A stale cached Claude manifest may still name this path after an update.
 * Keep that invocation harmless: project initialization and instruction-file
 * writes require the operator to run `genie init` explicitly.
 */

if (process.argv.length > 2 && !process.argv.includes('--explain')) {
  process.stderr.write('usage: first-run-check.cjs [--explain]\n');
  process.exitCode = 2;
} else if (process.argv.includes('--explain')) {
  process.stderr.write('Automatic lifecycle scaffolding is disabled. Run `genie init` explicitly.\n');
}
