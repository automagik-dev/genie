#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function getPkgVersion() {
  const pkgPath = path.join(process.cwd(), 'package.json');
  if (!fs.existsSync(pkgPath)) throw new Error('package.json not found');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  if (!pkg.version) throw new Error('No version field in package.json');
  return pkg.version;
}

function shortCommit() {
  try { return execSync('git log -1 --format=%h', { encoding: 'utf8' }).trim(); } catch { return 'unknown'; }
}

function updateState(version, dryRun) {
  const statePath = path.join(process.cwd(), '.genie', 'STATE.md');
  if (!fs.existsSync(statePath)) throw new Error('.genie/STATE.md not found');
  const content = fs.readFileSync(statePath, 'utf8');
  const updated = content.replace(/(last_version:\s+)[^\n]+/, `$1${version}`);
  if (updated === content) {
    console.log(`✅ STATE.md already up to date (version: ${version})`);
    return false;
  }
  if (dryRun) {
    console.log('🔍 DRY RUN: Would update STATE.md');
    console.log(`   Version: ${version}`);
    return true;
  }
  fs.writeFileSync(statePath, updated);
  console.log('✅ Updated STATE.md metadata');
  console.log(`   Version: ${version}`);
  return true;
}

function main() {
  const dryRun = process.argv.includes('--dry-run');
  console.log('⚙️  Post-merge: Updating STATE.md metadata...');
  const version = getPkgVersion();
  const commit = shortCommit();
  console.log('📊 Current state:');
  console.log(`   Version: ${version}`);
  console.log(`   Commit:  ${commit}`);
  const changed = updateState(version, dryRun);
  if (!changed) process.exit(0);
  if (dryRun) {
    console.log('🔍 DRY RUN: Would commit changes with [skip ci]');
    process.exit(0);
  }
  execSync('git add .genie/STATE.md');
  console.log('✅ Staged .genie/STATE.md');
  const msg = `chore: auto-update STATE.md to v${version} [skip ci]`;
  execSync(`git commit -m ${JSON.stringify(msg)}`);
  console.log(`✅ Auto-committed: ${msg}`);
  console.log('\n✅ STATE.md update complete!');
}

main();

