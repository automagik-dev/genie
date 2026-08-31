#!/usr/bin/env node

/**
 * Build script for the genie plugin payload.
 *
 * The generated hook executables this script used to bundle left with the hook
 * runtime; what remains is the plugin package manifest generator plus the
 * fresh-install smoke that gates it.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { replaceTopLevelStringProperty } from './json-top-level-string.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');

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
    execFileSync('bun', [path.join(rootDir, 'scripts/fresh-install-smoke.ts')], { stdio: 'inherit' });

    // Read version from package.json
    const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf-8'));
    const version = packageJson.version;
    console.log(`Version: ${version}`);

    // Generate plugin/package.json for dependency installation
    console.log('\nGenerating plugin package.json...');
    const pluginPackageJson = pluginPackageManifest(version);
    fs.writeFileSync(
      path.join(rootDir, 'plugins/genie/package.json'),
      `${JSON.stringify(pluginPackageJson, null, 2)}\n`,
    );
    console.log('plugins/genie/package.json generated');

    console.log('\nBuild complete!');
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
