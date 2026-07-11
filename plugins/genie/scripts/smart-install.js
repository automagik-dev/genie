#!/usr/bin/env node
'use strict';

/**
 * Retired SessionStart installer retained as a compatibility diagnostic.
 *
 * Lifecycle hooks must never install, update, synchronize, stamp, or otherwise
 * mutate global/user state. Installation and convergence require an explicit
 * operator command. The Claude hook manifest no longer invokes this file; it
 * remains in the payload only so a stale cached manifest exits harmlessly.
 */

if (process.argv.length > 2 && !process.argv.includes('--explain')) {
  process.stderr.write('usage: smart-install.js [--explain]\n');
  process.exitCode = 2;
} else if (process.argv.includes('--explain')) {
  process.stderr.write(
    'Automatic lifecycle installation is disabled. Run `genie install`, `genie setup`, or `genie update` explicitly.\n',
  );
}
