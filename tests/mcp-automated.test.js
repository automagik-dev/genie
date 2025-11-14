#!/usr/bin/env node
/**
 * MCP Automated Test Suite
 *
 * Automated validation of MCP server without requiring MCP Inspector.
 * Tests basic functionality, tool execution, and server stability.
 *
 * Complements manual validation checklist with automated assertions.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

let testsPassed = 0;
let testsFailed = 0;

function assert(condition, message) {
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    testsFailed++;
    return false;
  }
  console.log(`✅ PASS: ${message}`);
  testsPassed++;
  return true;
}

/**
 * Send JSON-RPC request and wait for response
 */
function sendRequest(process, request, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Request timeout: ${request.method}`));
    }, timeout);

    let buffer = '';

    const onData = (chunk) => {
      buffer += chunk.toString();

      // Process complete JSON-RPC messages
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        if (line.trim().startsWith('{')) {
          try {
            const response = JSON.parse(line.trim());
            if (response.id === request.id) {
              clearTimeout(timer);
              process.stdout.removeListener('data', onData);
              resolve(response);
              return;
            }
          } catch (e) {
            // Ignore parse errors, might be partial JSON
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
    const serverPath = path.join(__dirname, '../dist/mcp/server.js');

    if (!fs.existsSync(serverPath)) {
      reject(new Error('MCP server not built'));
      return;
    }

    const env = { ...process.env, MCP_TRANSPORT: 'stdio' };
    const proc = spawn('node', [serverPath], {
      env,
      cwd: path.join(__dirname, '..'),
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let startupLog = '';
    let stdoutBuffer = '';

    // Capture startup logs from stderr
    const onStderr = (data) => {
      startupLog += data.toString();
      if (startupLog.includes('Server started successfully')) {
        proc.stderr.removeListener('data', onStderr);
        // Switch to stdout mode for JSON-RPC messages
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
 * Test Suite
 */
async function runTests() {
  console.log('\n=== MCP Automated Test Suite ===');
  console.log('Target: 20+ automated assertions');
  console.log('Complement: Manual validation checklist\n');

  let server;
  let requestId = 1;

  try {
    // Test 1-2: Server Startup
    console.log('\n[Test 1-2] Server Startup');
    server = await startServer();
    assert(server && server.pid, 'Server started with PID');
    assert(fs.existsSync('dist/mcp/server.js'), 'Server artifact exists');

    // Test 3-6: Initialize Handshake
    console.log('\n[Test 3-6] MCP Initialize Protocol');
    const initRequest = {
      jsonrpc: '2.0',
      id: requestId++,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'automated-test', version: '1.0.0' }
      }
    };

    const initResponse = await sendRequest(server, initRequest);
    assert(initResponse.result, 'Initialize response received');
    assert(initResponse.result.protocolVersion, 'Protocol version present');
    assert(initResponse.result.serverInfo, 'Server info present');
    assert(initResponse.result.serverInfo.name === 'genie', 'Server name correct');

    // Test 7-13: Tools Discovery
    console.log('\n[Test 7-13] Tools Discovery');
    const toolsRequest = {
      jsonrpc: '2.0',
      id: requestId++,
      method: 'tools/list',
      params: {}
    };

    const toolsResponse = await sendRequest(server, toolsRequest);
    assert(toolsResponse.result, 'tools/list response received');
    assert(Array.isArray(toolsResponse.result.tools), 'Tools array returned');
    assert(toolsResponse.result.tools.length === 6, `6 tools present (got ${toolsResponse.result.tools.length})`);

    const tools = toolsResponse.result.tools;
    const toolNames = tools.map(t => t.name);
    assert(toolNames.includes('list_agents'), 'list_agents tool exists');
    assert(toolNames.includes('list_tasks'), 'list_tasks tool exists');
    assert(toolNames.includes('run'), 'run tool exists');
    assert(toolNames.includes('resume'), 'resume tool exists');
    assert(toolNames.includes('view'), 'view tool exists');
    assert(toolNames.includes('stop'), 'stop tool exists');

    // Test 14-16: Tool Schema Validation
    console.log('\n[Test 14-16] Tool Schema Validation');
    const runTool = tools.find(t => t.name === 'run');
    assert(runTool.description, 'run tool has description');
    assert(runTool.inputSchema, 'run tool has schema');
    assert(runTool.inputSchema.properties.agent && runTool.inputSchema.properties.prompt,
      'run tool has required parameters');

    // Test 17-19: list_agents Tool Execution
    console.log('\n[Test 17-19] list_agents Tool Execution');
    const listAgentsCall = {
      jsonrpc: '2.0',
      id: requestId++,
      method: 'tools/call',
      params: {
        name: 'list_agents',
        arguments: {}
      }
    };

    const listAgentsResponse = await sendRequest(server, listAgentsCall, 15000);
    assert(listAgentsResponse.result, 'list_agents executed');
    assert(Array.isArray(listAgentsResponse.result.content), 'list_agents returned content');
    const agentsText = listAgentsResponse.result.content[0]?.text || '';
    assert(agentsText.includes('agents'), 'list_agents response mentions agents');

    // Test 20-22: list_tasks Tool Execution
    console.log('\n[Test 20-22] list_tasks Tool Execution');
    const listSessionsCall = {
      jsonrpc: '2.0',
      id: requestId++,
      method: 'tools/call',
      params: {
        name: 'list_tasks',
        arguments: {}
      }
    };

    const listSessionsResponse = await sendRequest(server, listSessionsCall, 15000);
    assert(listSessionsResponse.result, 'list_tasks executed');
    assert(Array.isArray(listSessionsResponse.result.content), 'list_tasks returned content');
    const sessionsText = listSessionsResponse.result.content[0]?.text || '';
    assert(
      sessionsText.includes('session') || sessionsText.includes('No sessions'),
      'list_tasks response valid'
    );

    // Test 23-25: Prompts Discovery
    console.log('\n[Test 23-25] Prompts Feature');
    const promptsRequest = {
      jsonrpc: '2.0',
      id: requestId++,
      method: 'prompts/list',
      params: {}
    };

    const promptsResponse = await sendRequest(server, promptsRequest);
    assert(promptsResponse.result, 'prompts/list response received');
    assert(Array.isArray(promptsResponse.result.prompts), 'Prompts array returned');
    // Be resilient to additions: ensure a baseline and core prompts
    const prompts = promptsResponse.result.prompts;
    assert(prompts.length >= 4, `At least 4 prompts present (got ${prompts.length})`);
    const promptNames = prompts.map(p => p.name);
    ['plan', 'wish', 'forge', 'review'].forEach((name) => {
      assert(promptNames.includes(name), `Prompt "${name}" exists`);
    });

    // Test 26-27: Error Handling
    console.log('\n[Test 26-27] Error Handling');
    const invalidToolCall = {
      jsonrpc: '2.0',
      id: requestId++,
      method: 'tools/call',
      params: {
        name: 'nonexistent_tool',
        arguments: {}
      }
    };

    const errorResponse = await sendRequest(server, invalidToolCall);
    assert(errorResponse.error, 'Invalid tool returns error');
    assert(errorResponse.error.code, 'Error has code');

    // Test 28: Server Stability
    console.log('\n[Test 28] Server Stability');
    assert(server.exitCode === null, 'Server still running after all tests');

    console.log('\n========================================');
    console.log(`✅ Tests passed: ${testsPassed}`);
    console.log(`❌ Tests failed: ${testsFailed}`);
    console.log(`📊 Total: ${testsPassed + testsFailed} assertions`);
    console.log('========================================\n');

    if (testsFailed > 0) {
      console.error('❌ Test suite FAILED\n');
      process.exit(1);
    } else {
      console.log('✅ Test suite PASSED');
      console.log('\n📋 Automated Validation Complete:');
      console.log('  • MCP protocol handshake works');
      console.log('  • All 6 tools discoverable');
      console.log('  • Tool schemas valid');
      console.log('  • list_agents and list_tasks functional');
      console.log('  • Prompts feature operational');
      console.log('  • Error handling robust');
      console.log('  • Server stability confirmed');
      console.log('\n📝 Next Step: Complete manual validation checklist');
      console.log('   Command: See tests/mcp-manual-validation.md\n');
      process.exit(0);
    }

  } catch (error) {
    console.error('\n❌ Test error:', error.message);
    console.error('Stack:', error.stack);
    process.exit(1);
  } finally {
    if (server) {
      server.kill();
    }
  }
}

// Run tests
runTests().catch(err => {
  console.error('\n❌ Fatal:', err);
  process.exit(1);
});
