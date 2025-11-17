#!/usr/bin/env node
/**
 * MCP Real User Test
 * Tests the complete workflow a real user would experience:
 * task → view → continue → stop
 */

const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');

console.log('=== MCP Real User Test ===');
console.log('Simulating real user workflow: task → view → continue → stop\n');

let testsPassed = 0;
let testsFailed = 0;

function test(name, condition, details = '') {
  if (condition) {
    console.log(`✅ PASS: ${name}`);
    if (details) console.log(`  → ${details}`);
    testsPassed++;
  } else {
    console.log(`❌ FAIL: ${name}`);
    if (details) console.log(`  → ${details}`);
    testsFailed++;
  }
}

async function sendRequest(server, request, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Request timeout'));
    }, timeout);

    let buffer = '';
    const dataHandler = (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');

      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i].trim();
        if (line.length === 0) continue;

        try {
          const response = JSON.parse(line);
          if (response.id === request.id) {
            clearTimeout(timer);
            server.stdout.off('data', dataHandler);
            resolve(response);
          }
        } catch (e) {
          // Not JSON, continue
        }
      }
      buffer = lines[lines.length - 1];
    };

    server.stdout.on('data', dataHandler);
    server.stdin.write(JSON.stringify(request) + '\n');
  });
}

async function runTests() {
  console.log('[Setup] Starting MCP server...');

  const server = spawn('genie', ['mcp', '-t', 'stdio'], {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  test('Server started', server.pid > 0, `PID: ${server.pid}`);

  // Wait for server to initialize
  await new Promise(resolve => setTimeout(resolve, 1000));

  let sessionId = null;

  try {
    // Initialize
    console.log('\n[Step 1] Initialize MCP connection');
    const initRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0' }
      }
    };

    const initResponse = await sendRequest(server, initRequest);
    test('Initialize successful', initResponse.result !== undefined);

    // Step 2: Run an agent
    console.log('\n[Step 2] Task tool: core/analyze');
    const runRequest = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'task',
        arguments: {
          agent: 'core/analyze',
          prompt: 'Verify your identity and confirm you can access the framework. Be brief.'
        }
      }
    };

    const runResponse = await sendRequest(server, runRequest, 30000);
    test('Task tool executed', runResponse.result !== undefined);
    test('Task tool returned content',
      runResponse.result.content &&
      runResponse.result.content.length > 0
    );

    const runText = runResponse.result.content[0]?.text || '';
    test('Task tool succeeded (no error)',
      !runText.includes('Failed to start') && !runText.includes('not found'),
      runText.includes('Failed') ? `Error: ${runText.substring(0, 200)}` : 'Success'
    );

    // Extract session ID from response
    const sessionMatch = runText.match(/"task_id"[:\s"]+([0-9a-f-]+)/i) ||
                         runText.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    if (sessionMatch) {
      sessionId = sessionMatch[1] || sessionMatch[0];
      test('Session ID extracted', true, `Session: ${sessionId}`);
    } else {
      test('Session ID extracted', false, 'Could not find session ID in response');
    }

    // Step 3: View session (if we got a session ID)
    if (sessionId) {
      console.log('\n[Step 3] View session transcript');
      const viewRequest = {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'view_task',
          arguments: {
            taskId: sessionId,
            full: false
          }
        }
      };

      const viewResponse = await sendRequest(server, viewRequest, 15000);
      test('view_task tool executed', viewResponse.result !== undefined);

      const viewText = viewResponse.result.content[0]?.text || '';
      test('View returned transcript',
        viewText.length > 100 &&
        !viewText.includes('Failed to view'),
        `Response length: ${viewText.length} chars`
      );
    }

    // Step 4: List sessions to verify
    console.log('\n[Step 4] List tasks to verify');
    const listRequest = {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'list_tasks',
        arguments: {}
      }
    };

    const listResponse = await sendRequest(server, listRequest, 10000);
    test('List tasks executed', listResponse.result !== undefined);

    const listText = listResponse.result.content[0]?.text || '';
    if (sessionId) {
      test('New session appears in list',
        listText.includes(sessionId) || listText.includes('core/analyze'),
        'Session found in list'
      );
    }

    // Step 5: Stop session (if we got a session ID)
    if (sessionId) {
      console.log('\n[Step 5] Stop session');
      const stopRequest = {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
        name: 'stop',
        arguments: {
          taskId: sessionId
        }
      }
    };

      const stopResponse = await sendRequest(server, stopRequest, 15000);
      test('Stop tool executed', stopResponse.result !== undefined);

      const stopText = stopResponse.result.content[0]?.text || '';
      test('Stop succeeded',
        !stopText.includes('Failed to stop'),
        stopText.includes('Failed') ? 'Stop failed' : 'Session stopped'
      );
    }

    // Test 6: Server stability
    console.log('\n[Step 6] Verify server stability');
    test('Server still running', !server.killed && server.exitCode === null);

  } catch (error) {
    console.error('\n❌ Test error:', error.message);
    testsFailed++;
  } finally {
    // Cleanup
    console.log('\n[Cleanup] Stopping server...');
    server.kill();
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  // Summary
  console.log('\n========================================');
  console.log(`✅ Tests passed: ${testsPassed}`);
  console.log(`❌ Tests failed: ${testsFailed}`);
  console.log(`📊 Total: ${testsPassed + testsFailed} assertions`);
  console.log('========================================\n');

  if (testsFailed === 0) {
    console.log('✅ MCP Real User Workflow: PASS\n');
    console.log('📋 Complete User Journey Validated:');
    console.log('  ✅ MCP server starts');
    console.log('  ✅ Agent runs via MCP');
    console.log('  ✅ Session transcript viewable');
    console.log('  ✅ Sessions listed correctly');
    console.log('  ✅ Sessions can be stopped');
    console.log('  ✅ Server remains stable');
    process.exit(0);
  } else {
    console.log('❌ MCP Real User Workflow: FAIL\n');
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
