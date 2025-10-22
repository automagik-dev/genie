#!/usr/bin/env node
/**
 * Standalone intelligent entry point - spawned by genie-cli.ts
 * Handles animated startup with auto-detection logic
 */

import { runIntelligentEntry } from './intelligent-entry.js';
import { getDirname } from './lib/esm-dirname.js';

const __dirname = getDirname(import.meta.url);
import fs from 'fs';
import path from 'path';
import { execSync, spawn } from 'child_process';

async function main(): Promise<void> {
  // Get current version from package.json
  const packageJsonPath = path.join(__dirname, '../../../package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
  const currentVersion = packageJson.version;

  // Check for latest version
  let latestVersion = currentVersion;
  try {
    const npmVersion = execSync('npm view automagik-genie@next version', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
    latestVersion = npmVersion;
  } catch (err) {
    // If npm check fails, assume current version is latest
  }

  // Check if workspace is initialized (.genie directory exists)
  const genieDir = path.join(process.cwd(), '.genie');
  const isWorkspaceInitialized = fs.existsSync(genieDir);

  // Check for old version markers
  const hasOldVersion = isWorkspaceInitialized && fs.existsSync(path.join(genieDir, '.legacy'));

  await runIntelligentEntry({
    currentVersion,
    latestVersion,
    isWorkspaceInitialized,
    hasOldVersion,
    onUpdate: () => {
      console.log('Starting update...');
      try {
        execSync('pnpm install -g automagik-genie@next', { stdio: 'inherit' });
        console.log('Update complete! Please run genie again.');
        process.exit(0);
      } catch (err) {
        console.error('Update failed:', err);
        process.exit(1);
      }
    },
    onInit: () => {
      console.log('Starting workspace initialization...');
      try {
        // Spawn genie init
        const child = spawn('genie', ['init'], { stdio: 'inherit' });
        child.on('exit', (code) => {
          process.exit(code || 0);
        });
      } catch (err) {
        console.error('Init failed:', err);
        process.exit(1);
      }
    },
    onUpgrade: () => {
      console.log('Starting workspace upgrade...');
      try {
        // Backup old workspace
        const backupDir = path.join(process.cwd(), '.genie.backup');
        if (fs.existsSync(backupDir)) {
          fs.rmSync(backupDir, { recursive: true, force: true });
        }
        fs.renameSync(genieDir, backupDir);

        // Initialize new workspace
        const child = spawn('genie', ['init'], { stdio: 'inherit' });
        child.on('exit', (code) => {
          console.log('Upgrade complete! Your old workspace is backed up at .genie.backup');
          process.exit(code || 0);
        });
      } catch (err) {
        console.error('Upgrade failed:', err);
        process.exit(1);
      }
    },
    onStart: () => {
      // User pressed ENTER to start - now launch the actual server
      // Spawn genie CLI with no args (which will call startGenieServer)
      process.env.GENIE_SKIP_ENTRY = 'true'; // Prevent recursion
      const genieScript = path.join(__dirname, 'genie-cli.js');
      const child = spawn('node', [genieScript], {
        stdio: 'inherit',
        env: process.env
      });

      child.on('exit', (code) => {
        process.exit(code || 0);
      });
    }
  });
}

main().catch((error) => {
  console.error('Failed to start intelligent entry:', error);
  process.exit(1);
});
