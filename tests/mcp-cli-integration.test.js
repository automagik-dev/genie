#!/usr/bin/env node
/**
 * MCP CLI Integration Test
 * Tests the MCP server via the main genie CLI entry point
 */

const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');

console.log('=== MCP CLI Integration Test ===');
console.log('Objective: Verify genie mcp command works end-to-end\n');

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

async function sendRequest(server, request, timeout = 5000) {
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
  console.log('[Setup] Starting MCP server via genie mcp -t stdio...');

  const server = spawn('genie', ['mcp', '-t', 'stdio'], {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  test('Server started with PID', server.pid > 0, `PID: ${server.pid}`);

  // Wait for server to initialize
  await new Promise(resolve => setTimeout(resolve, 1000));

  try {
    // Test 1: Initialize
    console.log('\n[Test 1-3] MCP Initialize Protocol');
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
    test('Initialize response received', initResponse.result !== undefined);
    test('Protocol version present', initResponse.result.protocolVersion !== undefined);
    test('Server capabilities present', initResponse.result.capabilities !== undefined);

    // Test 2: Tools list
    console.log('\n[Test 4-7] Tools Discovery via CLI Entry Point');
    const toolsRequest = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {}
    };

    const toolsResponse = await sendRequest(server, toolsRequest);
    test('tools/list response received', toolsResponse.result !== undefined);
    test('Tools array returned', Array.isArray(toolsResponse.result.tools));
    test('6 tools present', toolsResponse.result.tools.length === 6);

    const toolNames = toolsResponse.result.tools.map(t => t.name);
    test('All tools discoverable',
      toolNames.includes('list_agents') &&
      toolNames.includes('list_sessions') &&
      toolNames.includes('run') &&
      toolNames.includes('resume') &&
      toolNames.includes('view') &&
      toolNames.includes('stop'),
      `Found: ${toolNames.join(', ')}`
    );

    // Test 3: Execute list_agents
    console.log('\n[Test 8-10] Tool Execution via CLI Entry Point');
    const listAgentsRequest = {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'list_agents',
        arguments: {}
      }
    };

    const listAgentsResponse = await sendRequest(server, listAgentsRequest, 10000);
    test('list_agents executed', listAgentsResponse.result !== undefined);
    test('list_agents returned content',
      listAgentsResponse.result.content &&
      listAgentsResponse.result.content.length > 0
    );

    const agentsText = listAgentsResponse.result.content[0]?.text || '';
    test('list_agents response mentions agents',
      agentsText.includes('agent') || agentsText.includes('Agent'),
      `Response length: ${agentsText.length} chars`
    );

    // Test 4: Server stability
    console.log('\n[Test 11] Server Stability');
    test('Server still running after tests', !server.killed && server.exitCode === null);

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
    console.log('✅ MCP CLI Integration: PASS\n');
    console.log('📋 Validation Complete:');
    console.log('  ✅ genie mcp command accessible');
    console.log('  ✅ MCP server starts via CLI');
    console.log('  ✅ All 6 tools discoverable');
    console.log('  ✅ Tool execution functional');
    console.log('  ✅ Server stability confirmed');
    process.exit(0);
  } else {
    console.log('❌ MCP CLI Integration: FAIL\n');
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
