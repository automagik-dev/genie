#!/usr/bin/env node
'use strict';

/**
 * Retired Stop-hook completion checker — compatibility stub (hooks-v2#retire).
 *
 * A stale cached Claude/Kimi manifest may still name this path after an
 * update. Keep that invocation harmless: the advisory completion scan is
 * retired and Stop telemetry replaces it in Wave 2. The stub exits 0 on
 * every invocation so a stale manifest can never fail a session end.
 */

// Deliberately no behavior: always exit 0.
