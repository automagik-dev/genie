#!/usr/bin/env node
/**
 * Sync script for automagik-genie
 *
 * Deploys the built plugin to the install target:
 *   ~/.claude/plugins/automagik-genie/
 *
 * Uses pure Node.js - no rsync dependency.
 * Also triggers worker restart after sync.
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, copyFileSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');
const pluginDir = path.join(rootDir, 'plugin');
const INSTALLED_PATH = path.join(os.homedir(), '.claude', 'plugins', 'automagik-genie');
const WORKER_PORT = 48888;

/**
 * Recursively copy directory contents
 */
function copyDir(src, dest) {
  mkdirSync(dest, { recursive: true });

  const entries = readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Clean directory but preserve .git if it exists
 */
function cleanDir(dir) {
  if (!existsSync(dir)) return;

  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    // Preserve .git directory for git-based updates
    if (entry.name === '.git') continue;

    const fullPath = path.join(dir, entry.name);
    rmSync(fullPath, { recursive: true, force: true });
  }
}

function getPluginVersion() {
  try {
    const pluginJsonPath = path.join(pluginDir, '.claude-plugin', 'plugin.json');
    const pluginJson = JSON.parse(readFileSync(pluginJsonPath, 'utf-8'));
    return pluginJson.version;
  } catch (error) {
    console.error('Failed to read plugin version:', error.message);
    return null;
  }
}

function triggerWorkerRestart() {
  return new Promise((resolve) => {
    console.log('\nTriggering worker restart...');
    const req = http.request({
      hostname: '127.0.0.1',
      port: WORKER_PORT,
      path: '/api/admin/restart',
      method: 'POST',
      timeout: 2000
    }, (res) => {
      if (res.statusCode === 200) {
        console.log('Worker restart triggered');
      } else {
        console.log(`Worker restart returned status ${res.statusCode}`);
      }
      resolve();
    });
    req.on('error', () => {
      console.log('Worker not running, will start on next hook');
      resolve();
    });
    req.on('timeout', () => {
      req.destroy();
      console.log('Worker restart timed out');
      resolve();
    });
    req.end();
  });
}

async function main() {
  const version = getPluginVersion();
  console.log(`Syncing automagik-genie ${version || 'unknown'} to ${INSTALLED_PATH}...`);

  try {
    // Ensure target directory exists
    mkdirSync(INSTALLED_PATH, { recursive: true });

    // Clean existing files (preserving .git)
    console.log('Cleaning target directory...');
    cleanDir(INSTALLED_PATH);

    // Copy plugin files
    console.log('Copying plugin files...');
    copyDir(pluginDir, INSTALLED_PATH);

    // Run bun install in target
    console.log('\nRunning bun install in target...');
    execSync('bun install', { cwd: INSTALLED_PATH, stdio: 'inherit' });

    console.log('\nSync complete!');

    // Trigger worker restart
    await triggerWorkerRestart();

  } catch (error) {
    console.error('Sync failed:', error.message);
    process.exit(1);
  }
}

main();
