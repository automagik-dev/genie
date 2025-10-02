#!/usr/bin/env node
/**
 * MCP Performance Benchmark
 *
 * Measures latency for all 6 MCP tools
 * Target: <500ms for list operations (list_agents, list_sessions)
 *
 * Outputs:
 * - Average latency per tool
 * - P95/P99 percentiles
 * - Pass/fail against targets
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Send JSON-RPC request and measure latency
 */
function sendRequest(process, request, timeout = 30000) {
  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Request timeout: ${request.method}`));
    }, timeout);

    let buffer = '';

    const onData = (chunk) => {
      buffer += chunk.toString();

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.trim().startsWith('{')) {
          try {
            const response = JSON.parse(line.trim());
            if (response.id === request.id) {
              const latency = Date.now() - startTime;
              clearTimeout(timer);
              process.stdout.removeListener('data', onData);
              resolve({ response, latency });
              return;
            }
          } catch (e) {
            // Ignore parse errors
          }
        }
      }
    };

    process.stdout.on('data', onData);

    const message = JSON.stringify(request) + '\n';
    process.stdin.write(message);
  });
}

/**
 * Start MCP server
 */
function startServer() {
  return new Promise((resolve, reject) => {
    // __dirname is .genie/wishes/mcp-integration/evidence, so go up 3 levels to root
    const rootDir = path.resolve(__dirname, '../../..');
    const serverPath = path.join(rootDir, 'mcp/dist/server.js');

    if (!fs.existsSync(serverPath)) {
      reject(new Error(`MCP server not built at ${serverPath}`));
      return;
    }

    const env = { ...process.env, MCP_TRANSPORT: 'stdio' };
    const proc = spawn('node', [serverPath], {
      env,
      cwd: rootDir,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let startupLog = '';

    const onStderr = (data) => {
      startupLog += data.toString();
      if (startupLog.includes('Server started successfully')) {
        proc.stderr.removeListener('data', onStderr);
        setTimeout(() => resolve(proc), 500);
      }
    };

    proc.stderr.on('data', onStderr);
    proc.on('error', reject);

    setTimeout(() => {
      reject(new Error('Server startup timeout'));
    }, 5000);
  });
}

/**
 * Calculate statistics
 */
function calculateStats(measurements) {
  if (measurements.length === 0) return null;

  const sorted = [...measurements].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);

  return {
    count: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: Math.round(sum / sorted.length),
    median: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.floor(sorted.length * 0.95)],
    p99: sorted[Math.floor(sorted.length * 0.99)]
  };
}

/**
 * Run benchmark
 */
async function runBenchmark() {
  console.log('\n=== MCP Performance Benchmark ===');
  console.log('Target: <500ms for list operations');
  console.log('Iterations: 10 per tool\n');

  let server;
  let requestId = 1;
  const results = {
    list_agents: [],
    list_sessions: [],
    run: [],
    view: [],
    resume: [],
    stop: []
  };

  let testSessionId = null;

  try {
    console.log('[Setup] Starting MCP server...');
    server = await startServer();

    // Initialize
    const initRequest = {
      jsonrpc: '2.0',
      id: requestId++,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'benchmark', version: '1.0.0' }
      }
    };

    await sendRequest(server, initRequest);
    console.log('✅ Server initialized\n');

    // Benchmark: list_agents (10 iterations)
    console.log('[1/6] Benchmarking list_agents...');
    for (let i = 0; i < 10; i++) {
      const { latency } = await sendRequest(server, {
        jsonrpc: '2.0',
        id: requestId++,
        method: 'tools/call',
        params: {
          name: 'list_agents',
          arguments: {}
        }
      });
      results.list_agents.push(latency);
      process.stdout.write('.');
    }
    console.log(' done');

    // Benchmark: list_sessions (10 iterations)
    console.log('[2/6] Benchmarking list_sessions...');
    for (let i = 0; i < 10; i++) {
      const { latency } = await sendRequest(server, {
        jsonrpc: '2.0',
        id: requestId++,
        method: 'tools/call',
        params: {
          name: 'list_sessions',
          arguments: {}
        }
      });
      results.list_sessions.push(latency);
      process.stdout.write('.');
    }
    console.log(' done');

    // Create a test session for run/view/resume/stop benchmarks
    console.log('[Setup] Creating test session...');
    const { response: runResult, latency: runLatency1 } = await sendRequest(server, {
      jsonrpc: '2.0',
      id: requestId++,
      method: 'tools/call',
      params: {
        name: 'run',
        arguments: {
          agent: 'analyze',
          prompt: 'Benchmark test session'
        }
      }
    }, 30000);

    results.run.push(runLatency1);

    // Extract session ID
    const runText = runResult.result?.content?.[0]?.text || '';
    const sessionIdMatch = runText.match(/Session ID: ([a-f0-9-]+)/i) ||
                          runText.match(/session[:\s]+([a-f0-9-]+)/i);

    if (sessionIdMatch) {
      testSessionId = sessionIdMatch[1];
      console.log(`✅ Test session created: ${testSessionId}\n`);
    } else {
      // Try to get from list
      const { response: listResult } = await sendRequest(server, {
        jsonrpc: '2.0',
        id: requestId++,
        method: 'tools/call',
        params: {
          name: 'list_sessions',
          arguments: {}
        }
      });

      const listText = listResult.result?.content?.[0]?.text || '';
      const idMatch = listText.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/);
      if (idMatch) {
        testSessionId = idMatch[1];
        console.log(`✅ Using existing session: ${testSessionId}\n`);
      } else {
        console.log('⚠️  Could not extract session ID, skipping session-dependent benchmarks\n');
      }
    }

    // Benchmark: run (9 more iterations)
    console.log('[3/6] Benchmarking run...');
    for (let i = 0; i < 9; i++) {
      const { latency } = await sendRequest(server, {
        jsonrpc: '2.0',
        id: requestId++,
        method: 'tools/call',
        params: {
          name: 'run',
          arguments: {
            agent: 'analyze',
            prompt: `Benchmark iteration ${i + 2}`
          }
        }
      }, 30000);
      results.run.push(latency);
      process.stdout.write('.');
    }
    console.log(' done');

    if (testSessionId) {
      // Benchmark: view (10 iterations)
      console.log('[4/6] Benchmarking view...');
      for (let i = 0; i < 10; i++) {
        const { latency } = await sendRequest(server, {
          jsonrpc: '2.0',
          id: requestId++,
          method: 'tools/call',
          params: {
            name: 'view',
            arguments: {
              sessionId: testSessionId,
              full: false
            }
          }
        });
        results.view.push(latency);
        process.stdout.write('.');
      }
      console.log(' done');

      // Benchmark: resume (10 iterations)
      console.log('[5/6] Benchmarking resume...');
      for (let i = 0; i < 10; i++) {
        const { latency } = await sendRequest(server, {
          jsonrpc: '2.0',
          id: requestId++,
          method: 'tools/call',
          params: {
            name: 'resume',
            arguments: {
              sessionId: testSessionId,
              prompt: `Benchmark iteration ${i + 1}`
            }
          }
        }, 30000);
        results.resume.push(latency);
        process.stdout.write('.');
      }
      console.log(' done');

      // Benchmark: stop (1 iteration - cleanup)
      console.log('[6/6] Benchmarking stop...');
      const { latency: stopLatency } = await sendRequest(server, {
        jsonrpc: '2.0',
        id: requestId++,
        method: 'tools/call',
        params: {
          name: 'stop',
          arguments: {
            sessionId: testSessionId
          }
        }
      });
      results.stop.push(stopLatency);
      console.log(' done');
    } else {
      console.log('[4-6/6] Skipping view/resume/stop (no session available)');
    }

    // Calculate and display results
    console.log('\n========================================');
    console.log('BENCHMARK RESULTS');
    console.log('========================================\n');

    const reportLines = [];

    for (const [tool, measurements] of Object.entries(results)) {
      if (measurements.length === 0) continue;

      const stats = calculateStats(measurements);
      const target = (tool === 'list_agents' || tool === 'list_sessions') ? 500 : null;
      const passed = target ? stats.avg < target : 'N/A';

      console.log(`${tool}:`);
      console.log(`  Iterations: ${stats.count}`);
      console.log(`  Average:    ${stats.avg}ms`);
      console.log(`  Median:     ${stats.median}ms`);
      console.log(`  P95:        ${stats.p95}ms`);
      console.log(`  P99:        ${stats.p99}ms`);
      console.log(`  Min/Max:    ${stats.min}ms / ${stats.max}ms`);

      if (target) {
        const status = passed ? '✅ PASS' : '❌ FAIL';
        console.log(`  Target:     <${target}ms ${status}`);
      }

      console.log();

      reportLines.push({
        tool,
        stats,
        target,
        passed
      });
    }

    // Generate markdown report
    const reportPath = path.join(__dirname, 'performance-benchmarks.md');
    const timestamp = new Date().toISOString();

    let markdown = `# MCP Performance Benchmarks

**Date:** ${timestamp}
**Iterations:** 10 per tool
**Target:** <500ms for list operations

## Summary

| Tool | Avg (ms) | P95 (ms) | P99 (ms) | Target | Status |
|------|----------|----------|----------|--------|--------|
`;

    for (const { tool, stats, target, passed } of reportLines) {
      const targetStr = target ? `<${target}ms` : 'baseline';
      const statusStr = target ? (passed ? '✅ PASS' : '❌ FAIL') : 'N/A';
      markdown += `| ${tool} | ${stats.avg} | ${stats.p95} | ${stats.p99} | ${targetStr} | ${statusStr} |\n`;
    }

    markdown += `\n## Detailed Results\n\n`;

    for (const { tool, stats } of reportLines) {
      markdown += `### ${tool}\n\n`;
      markdown += `- **Iterations:** ${stats.count}\n`;
      markdown += `- **Average:** ${stats.avg}ms\n`;
      markdown += `- **Median:** ${stats.median}ms\n`;
      markdown += `- **P95:** ${stats.p95}ms\n`;
      markdown += `- **P99:** ${stats.p99}ms\n`;
      markdown += `- **Min/Max:** ${stats.min}ms / ${stats.max}ms\n\n`;
    }

    markdown += `## Validation\n\n`;
    markdown += `✅ list_agents: ${reportLines.find(r => r.tool === 'list_agents')?.passed ? 'PASS' : 'FAIL'} (<500ms target)\n`;
    markdown += `✅ list_sessions: ${reportLines.find(r => r.tool === 'list_sessions')?.passed ? 'PASS' : 'FAIL'} (<500ms target)\n`;
    markdown += `📊 Other tools: Baseline measurements captured for future optimization\n\n`;

    markdown += `## Environment\n\n`;
    markdown += `- Platform: ${process.platform}\n`;
    markdown += `- Node.js: ${process.version}\n`;
    markdown += `- Transport: stdio\n`;

    fs.writeFileSync(reportPath, markdown);

    console.log('========================================');
    console.log(`📄 Report saved: ${reportPath}`);
    console.log('========================================\n');

    const listAgentsPassed = reportLines.find(r => r.tool === 'list_agents')?.passed;
    const listSessionsPassed = reportLines.find(r => r.tool === 'list_sessions')?.passed;

    if (listAgentsPassed && listSessionsPassed) {
      console.log('✅ All performance targets met\n');
      process.exit(0);
    } else {
      console.log('⚠️  Some performance targets not met\n');
      process.exit(1);
    }

  } catch (error) {
    console.error('\n❌ Benchmark error:', error.message);
    console.error('Stack:', error.stack);
    process.exit(1);
  } finally {
    if (server) {
      server.kill();
    }
  }
}

// Run benchmark
runBenchmark().catch(err => {
  console.error('\n❌ Fatal:', err);
  process.exit(1);
});
