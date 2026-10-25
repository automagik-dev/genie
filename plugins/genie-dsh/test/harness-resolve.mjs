// Tests import the plugin outside a dsh profile, so its @deepseek-ai peers resolve from a
// DeepSeek Harness install: DSH_HARNESS, else the Bot team checkout's dev/harness
// (automagik-dev/automagik apps/bots-dsh, `bun run harness` there), found beside the genie
// repository or at BOTS_DSH.
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const plugin = resolve(import.meta.dirname, '..');
const team = resolve(process.env.BOTS_DSH ?? join(plugin, '..', '..', '..', 'automagik', 'apps', 'bots-dsh'));
const harness = resolve(process.env.DSH_HARNESS ?? join(team, 'dev', 'harness'));
if (!existsSync(join(harness, 'node_modules', '@deepseek-ai'))) {
  throw new Error(`No DeepSeek Harness packages at ${harness}: set DSH_HARNESS or BOTS_DSH`);
}
const anchor = pathToFileURL(join(harness, 'package.json')).href;
const ours = `${pathToFileURL(plugin).href}/`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/') && context.parentURL?.startsWith(ours)) {
      return nextResolve(specifier, { ...context, parentURL: anchor });
    }
    return nextResolve(specifier, context);
  },
});
