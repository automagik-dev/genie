#!/usr/bin/env node

// Product distributions always ship the complete 23-skill set. Keep the wish
// gate's CLI path local to this skill while sharing the canonical digest logic
// with brainstorm, where the evidence block is created.
export * from '../../brainstorm/references/design-review-evidence.mjs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDesignReviewEvidenceCli } from '../../brainstorm/references/design-review-evidence.mjs';

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runDesignReviewEvidenceCli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
