#!/usr/bin/env node

/**
 * Build script for genie plugin
 * Bundles TypeScript CLIs into standalone CJS executables using esbuild
 */

import { build } from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');

const TARGETS = [
  // CLI binaries (use bun runtime)
  { name: 'genie', source: 'src/genie.ts', runtime: 'bun' },
  { name: 'term', source: 'src/term.ts', runtime: 'bun' },
  { name: 'worker-service', source: 'src/services/worker-service.ts', runtime: 'bun' },
  // Hook scripts (pure Node.js - no bun dependency)
  { name: 'validate-wish', source: 'plugins/genie/scripts/src/validate-wish.ts', runtime: 'node' },
  { name: 'validate-completion', source: 'plugins/genie/scripts/src/validate-completion.ts', runtime: 'node' },
  { name: 'session-context', source: 'plugins/genie/scripts/src/session-context.ts', runtime: 'node' },
];

async function buildPlugin() {
  console.log('Building genie plugin...\n');

  try {
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
    const pluginPackageJson = {
      name: 'genie-plugin',
      version: version,
      private: true,
      description: 'Runtime dependencies for genie bundled CLIs',
      type: 'module',
      dependencies: {},
      engines: {
        node: '>=18.0.0',
        bun: '>=1.0.0'
      }
    };
    fs.writeFileSync(
      path.join(rootDir, 'plugins/genie/package.json'),
      JSON.stringify(pluginPackageJson, null, 2) + '\n'
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
          '__GENIE_VERSION__': `"${version}"`
        }
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

    // Copy smart-install.js (stays as Node.js, not bundled)
    const smartInstallSrc = path.join(rootDir, 'scripts/smart-install.js');
    const smartInstallDest = path.join(scriptsDir, 'smart-install.js');
    if (fs.existsSync(smartInstallSrc)) {
      fs.copyFileSync(smartInstallSrc, smartInstallDest);
      console.log('\nCopied smart-install.js');
    }

    // Update plugin.json version
    const pluginJsonPath = path.join(rootDir, 'plugins/genie/.claude-plugin/plugin.json');
    if (fs.existsSync(pluginJsonPath)) {
      const pluginJson = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf-8'));
      pluginJson.version = version;
      fs.writeFileSync(pluginJsonPath, JSON.stringify(pluginJson, null, 2) + '\n');
      console.log('Updated plugin.json version');
    }

    console.log('\nBuild complete!');
    console.log(`Output: plugins/genie/scripts/`);

  } catch (error) {
    console.error('\nBuild failed:', error.message);
    if (error.errors) {
      console.error('\nBuild errors:');
      error.errors.forEach(err => console.error(`  - ${err.text}`));
    }
    process.exit(1);
  }
}

buildPlugin();
