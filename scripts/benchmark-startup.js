#!/usr/bin/env node
/**
 * Benchmark Genie startup performance
 * Measures time from launch to ready state
 */

const { spawn, execSync } = require('child_process');
const path = require('path');

const RUNS = parseInt(process.env.BENCHMARK_RUNS || '3', 10);
const WARMUP = process.env.BENCHMARK_WARMUP === 'false' ? false : true;

function formatTime(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function calculateStats(times) {
  const sorted = [...times].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const median = sorted[Math.floor(sorted.length / 2)];

  return { min, max, avg, median };
}

async function measureStartup() {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const cliPath = path.join(__dirname, '..', '.genie', 'cli', 'dist', 'genie-cli.js');

    const child = spawn('node', [cliPath], {
      env: { ...process.env, GENIE_SHOW_PERF: 'true' },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let output = '';
    child.stdout.on('data', (data) => {
      output += data.toString();
    });

    child.stderr.on('data', (data) => {
      output += data.toString();
    });

    // Wait for "Starting health monitoring" message
    const checkInterval = setInterval(() => {
      if (output.includes('Starting health monitoring')) {
        const elapsed = Date.now() - start;
        clearInterval(checkInterval);

        // Kill the server
        try {
          child.kill('SIGTERM');
        } catch {}

        resolve(elapsed);
      }
    }, 100);

    // Timeout after 90 seconds
    setTimeout(() => {
      clearInterval(checkInterval);
      try {
        child.kill('SIGKILL');
      } catch {}
      reject(new Error('Startup timeout (90s)'));
    }, 90000);

    child.on('error', reject);
  });
}

async function killExistingServers() {
  try {
    execSync('pkill -f "automagik-forge" || true', { stdio: 'ignore' });
    execSync('pkill -f "genie-cli" || true', { stdio: 'ignore' });
    await new Promise(r => setTimeout(r, 2000)); // Wait for cleanup
  } catch {
    // Ignore errors
  }
}

async function runBenchmark() {
  console.log('🚀 Genie Startup Performance Benchmark');
  console.log('━'.repeat(50));
  console.log('');

  const times = [];

  if (WARMUP) {
    console.log('🔥 Warm-up run (not counted)...');
    await killExistingServers();
    try {
      await measureStartup();
      console.log('   ✓ Warm-up complete\n');
    } catch (err) {
      console.error('   ✗ Warm-up failed:', err.message, '\n');
    }
  }

  for (let i = 0; i < RUNS; i++) {
    process.stdout.write(`📊 Run ${i + 1}/${RUNS}: `);

    // Kill any existing servers
    await killExistingServers();

    try {
      const time = await measureStartup();
      times.push(time);
      console.log(`${formatTime(time)} ✓`);
    } catch (err) {
      console.log(`FAILED (${err.message})`);
    }

    // Brief pause between runs
    if (i < RUNS - 1) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  console.log('');
  console.log('━'.repeat(50));
  console.log('📈 Results');
  console.log('━'.repeat(50));

  if (times.length === 0) {
    console.log('❌ All runs failed');
    process.exit(1);
  }

  const stats = calculateStats(times);

  console.log(`Runs:    ${times.length}/${RUNS} successful`);
  console.log(`Fastest: ${formatTime(stats.min)}`);
  console.log(`Slowest: ${formatTime(stats.max)}`);
  console.log(`Average: ${formatTime(stats.avg)}`);
  console.log(`Median:  ${formatTime(stats.median)}`);
  console.log('');

  // Individual times
  console.log('Individual times:');
  times.forEach((time, i) => {
    console.log(`  ${i + 1}. ${formatTime(time)}`);
  });

  console.log('');
  console.log('━'.repeat(50));

  // Cleanup
  await killExistingServers();
}

// Run benchmark
runBenchmark().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
