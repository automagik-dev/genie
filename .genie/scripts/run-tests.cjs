#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');

async function main() {
  const repoRoot = path.join(__dirname, '..', '..');
  console.log('⚙️  Running tests...');
  await new Promise((resolve) => {
    const ps = spawn('pnpm', ['run', 'test:all'], { stdio: 'inherit', cwd: repoRoot, shell: false });
    ps.on('exit', (code) => {
      if (code === 0) {
        console.log('✅ Tests passed');
      } else {
        console.error(`❌ Tests failed (exit code: ${code})`);
        console.error('   Fix failing tests before pushing');
      }
      process.exit(code || 0);
    });
  });
}

main().catch((e) => {
  console.error(`❌ Error running tests: ${e.message}`);
  process.exit(1);
});

