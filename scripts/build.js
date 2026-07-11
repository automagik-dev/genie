#!/usr/bin/env node

/**
 * Build script for genie plugin
 * Bundles TypeScript CLIs into standalone CJS executables using esbuild
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { replaceTopLevelStringProperty } from './json-top-level-string.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');

const TARGETS = [
  // Hook scripts (pure Node.js - no bun dependency)
  { name: 'validate-wish', source: 'plugins/genie/scripts/src/validate-wish.ts', runtime: 'node' },
  { name: 'validate-completion', source: 'plugins/genie/scripts/src/validate-completion.ts', runtime: 'node' },
  { name: 'session-context', source: 'plugins/genie/scripts/src/session-context.ts', runtime: 'node' },
];

export function updateManifestVersion(filePath, version) {
  const source = fs.readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(source);
  if (typeof parsed.version !== 'string') throw new Error(`manifest has no string version: ${filePath}`);
  const updated = replaceTopLevelStringProperty(source, 'version', version);
  fs.writeFileSync(filePath, updated);
}

export function pluginPackageManifest(version) {
  return {
    name: 'genie-plugin',
    version,
    private: true,
    description: 'Runtime dependencies for genie bundled CLIs',
    license: 'MIT',
    type: 'module',
    dependencies: {},
    engines: {
      node: '>=18.0.0',
      bun: '>=1.0.0',
    },
  };
}

export async function buildPlugin() {
  console.log('Building genie plugin...\n');

  try {
    execFileSync('bun', [path.join(rootDir, 'scripts/sync-plugin-skills.ts'), '--check'], { stdio: 'inherit' });
    execFileSync('bun', [path.join(rootDir, 'scripts/fresh-install-smoke.ts')], { stdio: 'inherit' });

    // Read version from package.json
    const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf-8'));
    const version = packageJson.version;
    console.log(`Version: ${version}`);

    // Create output directory
    const scriptsDir = path.join(rootDir, 'plugins/genie/scripts');
    if (!fs.existsSync(scriptsDir)) {
      fs.mkdirSync(scriptsDir, { recursive: true });
    }

    // Generate plugin/package.json for dependency installation
    console.log('\nGenerating plugin package.json...');
    const pluginPackageJson = pluginPackageManifest(version);
    fs.writeFileSync(
      path.join(rootDir, 'plugins/genie/package.json'),
      `${JSON.stringify(pluginPackageJson, null, 2)}\n`,
    );
    console.log('plugins/genie/package.json generated');

    // Build each target
    for (const target of TARGETS) {
      const sourcePath = path.join(rootDir, target.source);

      // Check if source exists
      if (!fs.existsSync(sourcePath)) {
        console.log(`\nSkipping ${target.name} (source not found: ${target.source})`);
        continue;
      }

      console.log(`\nBuilding ${target.name}...`);

      const outfile = `${scriptsDir}/${target.name}.cjs`;

      await build({
        entryPoints: [sourcePath],
        bundle: true,
        platform: 'node',
        target: 'node18',
        format: 'cjs',
        outfile,
        minify: true,
        logLevel: 'error',
        external: ['bun', 'bun:*'],
        define: {
          __GENIE_VERSION__: `"${version}"`,
        },
      });

      // Add shebang based on target runtime (esbuild banner can cause duplicates if source has shebang)
      const content = fs.readFileSync(outfile, 'utf-8');
      const runtime = target.runtime || 'bun';
      const shebang = `#!/usr/bin/env ${runtime}\n`;
      // Remove any existing shebangs and add fresh one
      const cleanContent = content.replace(/^#!.*\n/gm, '');
      fs.writeFileSync(outfile, shebang + cleanContent);

      // Make executable
      fs.chmodSync(outfile, 0o755);

      const stats = fs.statSync(`${scriptsDir}/${target.name}.cjs`);
      console.log(`  ${target.name}.cjs (${(stats.size / 1024).toFixed(2)} KB)`);
    }

    // Generated hook bundles are committed release inputs. Prove the exact
    // SessionStart source/output contract before version metadata is updated.
    execFileSync('bun', [path.join(rootDir, 'scripts/hook-bundle-parity.ts'), '--check'], { stdio: 'inherit' });

    // NOTE: the shipped SessionStart hook under plugins/genie/scripts/ is now the
    // single committed source of truth (agent-sync wish, Decision 8). The old
    // copy-from-scripts step was removed — it was one `bun run build:plugin` away
    // from clobbering the shipped hook's council stamp.

    // Keep both runtime manifests version-matched to the binary.
    for (const manifest of ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json']) {
      const pluginJsonPath = path.join(rootDir, 'plugins/genie', manifest);
      if (!fs.existsSync(pluginJsonPath)) continue;
      updateManifestVersion(pluginJsonPath, version);
      console.log(`Updated ${manifest} version`);
    }

    const claudeMarketplacePath = path.join(rootDir, '.claude-plugin', 'marketplace.json');
    if (fs.existsSync(claudeMarketplacePath)) {
      const marketplace = JSON.parse(fs.readFileSync(claudeMarketplacePath, 'utf-8'));
      const genie = marketplace.plugins?.find((plugin) => plugin.name === 'genie');
      if (genie) genie.version = version;
      fs.writeFileSync(claudeMarketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`);
      console.log('Updated Claude marketplace version');
    }

    console.log('\nBuild complete!');
    console.log('Output: plugins/genie/scripts/');
  } catch (error) {
    console.error('\nBuild failed:', error.message);
    if (error.errors) {
      console.error('\nBuild errors:');
      error.errors.forEach((err) => console.error(`  - ${err.text}`));
    }
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) buildPlugin();
