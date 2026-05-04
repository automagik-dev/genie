/**
 * Standalone splash runner — bypasses src/genie.ts so the animation can
 * be previewed even when other commands in the CLI graph are broken.
 *
 * Run via: `bun run src/tui/splash-cli.ts [--duration <ms>] [--hold <ms>] [--freeze <p>]`
 */

import { renderSplash } from './splash-render.js';

interface CliArgs {
  duration?: number;
  holdMs?: number;
  freezeAt?: number;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--duration' || flag === '-d') {
      args.duration = Number.parseInt(value ?? '', 10);
      i++;
    } else if (flag === '--hold' || flag === '-h') {
      args.holdMs = Number.parseInt(value ?? '', 10);
      i++;
    } else if (flag === '--freeze' || flag === '-f') {
      args.freezeAt = Number.parseFloat(value ?? '');
      i++;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
await renderSplash({
  duration: Number.isFinite(args.duration) ? args.duration : undefined,
  holdMs: Number.isFinite(args.holdMs) ? args.holdMs : undefined,
  freezeAt: Number.isFinite(args.freezeAt) ? args.freezeAt : undefined,
});
process.exit(0);
