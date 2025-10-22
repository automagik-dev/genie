#!/usr/bin/env node

const { execSync } = require('child_process');

function getStagedFiles() {
  try {
    const out = execSync('git diff --cached --name-only', { encoding: 'utf8' }).trim();
    return out ? out.split('\n') : [];
  } catch (e) {
    console.error(`❌ Error getting staged files: ${e.message}`);
    return [];
  }
}

function main() {
  const staged = getStagedFiles();
  if (!staged.length) process.exit(0);
  const violations = ['.genie/TODO.md', '.genie/USERCONTEXT.md'].filter((f) => staged.includes(f));
  if (violations.length) {
    console.error('❌ User files detected in commit (should be gitignored):\n');
    violations.forEach((v) => console.error(`   ${v}`));
    console.error('\nThese files are personal and should never be committed.\n');
    console.error('Fix:');
    console.error('  1. Unstage files:');
    violations.forEach((v) => console.error(`       git reset HEAD ${v}`));
    console.error('  2. Verify .gitignore contains:');
    console.error('       .genie/TODO.md');
    console.error('       .genie/USERCONTEXT.md');
    console.error('  3. Retry commit\n');
    process.exit(1);
  }
  console.log('✅ User files validation passed (no personal files in commit)');
}

main();

