#!/usr/bin/env tsx
/**
 * Forge WebSocket Validation Test
 *
 * Purpose: Validate websocket streaming capabilities before redesigning MCP server
 * Tests: Diff stream, log stream, task stream
 * Expected: Real-time updates from Forge API
 */

import { WebSocket } from 'ws';
import * as path from 'path';

// Resolve from workspace root
const workspaceRoot = path.resolve(__dirname, '../..');

// Load ForgeClient
const { ForgeClient } = require(path.join(workspaceRoot, 'src/lib/forge-client.js'));

// Load ForgeExecutor for session creation
const { createForgeExecutor } = require(path.join(workspaceRoot, '.genie/cli/dist/lib/forge-executor'));

const FORGE_URL = process.env.FORGE_BASE_URL || 'http://localhost:8887';
const PROJECT_ID = 'ee8f0a72-44da-411d-a23e-f2c6529b62ce'; // Genie project

interface StreamTestResult {
  stream: string;
  connected: boolean;
  messagesReceived: number;
  error?: string;
  sampleMessages?: any[];
}

async function testDiffStream(attemptId: string): Promise<StreamTestResult> {
  const result: StreamTestResult = {
    stream: 'diff',
    connected: false,
    messagesReceived: 0,
    sampleMessages: []
  };

  return new Promise((resolve) => {
    const forgeClient = new ForgeClient(FORGE_URL);
    const wsUrl = forgeClient.getTaskDiffStreamUrl(attemptId, false);

    console.log(`\n📡 Connecting to diff stream: ${wsUrl}`);
    const ws = new WebSocket(wsUrl, {
      headers: {
        'Origin': FORGE_URL,
        'User-Agent': 'Genie-MCP-Test/1.0'
      }
    });

    const timeout = setTimeout(() => {
      console.log('⏱️  Timeout reached, closing connection...');
      ws.close();
      resolve(result);
    }, 10000); // 10 second test window

    ws.on('open', () => {
      console.log('✅ Diff stream connected successfully!');
      result.connected = true;
    });

    ws.on('message', (data: Buffer) => {
      result.messagesReceived++;
      try {
        const message = JSON.parse(data.toString());
        console.log(`📨 Diff message #${result.messagesReceived}:`, JSON.stringify(message, null, 2));
        if (result.sampleMessages!.length < 3) {
          result.sampleMessages!.push(message);
        }
      } catch (e) {
        console.log(`📨 Raw diff #${result.messagesReceived}:`, data.toString().substring(0, 200));
      }
    });

    ws.on('error', (error: any) => {
      console.error('❌ Diff stream error:', error.message);
      result.error = error.message;
      clearTimeout(timeout);
      resolve(result);
    });

    ws.on('close', (code, reason) => {
      console.log(`🔌 Diff stream closed (code: ${code}, reason: ${reason.toString()})`);
      clearTimeout(timeout);
      resolve(result);
    });

    ws.on('unexpected-response', (req, res) => {
      console.error(`❌ Unexpected HTTP response: ${res.statusCode} ${res.statusMessage}`);
      result.error = `Unexpected server response: ${res.statusCode}`;

      // Read the response body
      let body = '';
      res.on('data', chunk => { body += chunk.toString(); });
      res.on('end', () => {
        console.error('Response body:', body.substring(0, 500));
        clearTimeout(timeout);
        resolve(result);
      });
    });
  });
}

async function testRawLogsStream(processId: string): Promise<StreamTestResult> {
  const result: StreamTestResult = {
    stream: 'raw_logs',
    connected: false,
    messagesReceived: 0,
    sampleMessages: []
  };

  return new Promise((resolve) => {
    const forgeClient = new ForgeClient(FORGE_URL);
    const wsUrl = forgeClient.getRawLogsStreamUrl(processId);

    console.log(`\n📡 Connecting to raw logs stream: ${wsUrl}`);
    const ws = new WebSocket(wsUrl, {
      headers: {
        'Origin': FORGE_URL,
        'User-Agent': 'Genie-MCP-Test/1.0'
      }
    });

    const timeout = setTimeout(() => {
      console.log('⏱️  Timeout reached, closing connection...');
      ws.close();
      resolve(result);
    }, 10000);

    ws.on('open', () => {
      console.log('✅ Raw logs stream connected successfully!');
      result.connected = true;
    });

    ws.on('message', (data: Buffer) => {
      result.messagesReceived++;
      const message = data.toString();
      console.log(`📨 Log message #${result.messagesReceived}:`, message.substring(0, 200));

      if (result.sampleMessages!.length < 3) {
        result.sampleMessages!.push(message);
      }
    });

    ws.on('error', (error: any) => {
      console.error('❌ Raw logs stream error:', error.message);
      result.error = error.message;
      clearTimeout(timeout);
      resolve(result);
    });

    ws.on('close', (code, reason) => {
      console.log(`🔌 Raw logs stream closed (code: ${code}, reason: ${reason.toString()})`);
      clearTimeout(timeout);
      resolve(result);
    });

    ws.on('unexpected-response', (req, res) => {
      console.error(`❌ Unexpected HTTP response: ${res.statusCode} ${res.statusMessage}`);
      result.error = `Unexpected server response: ${res.statusCode}`;

      // Read the response body
      let body = '';
      res.on('data', chunk => { body += chunk.toString(); });
      res.on('end', () => {
        console.error('Response body:', body.substring(0, 500));
        clearTimeout(timeout);
        resolve(result);
      });
    });
  });
}

async function testTasksStream(projectId: string): Promise<StreamTestResult> {
  const result: StreamTestResult = {
    stream: 'tasks',
    connected: false,
    messagesReceived: 0,
    sampleMessages: []
  };

  return new Promise((resolve) => {
    // Correct URL format: /api/tasks/stream/ws?project_id={id}
    const protocol = FORGE_URL.startsWith('https') ? 'wss' : 'ws';
    const host = new URL(FORGE_URL).host;
    const wsUrl = `${protocol}://${host}/api/tasks/stream/ws?project_id=${projectId}`;

    console.log(`\n📡 Connecting to tasks stream: ${wsUrl}`);
    const ws = new WebSocket(wsUrl, {
      headers: {
        'Origin': FORGE_URL,
        'User-Agent': 'Genie-MCP-Test/1.0'
      }
    });

    const timeout = setTimeout(() => {
      console.log('⏱️  Timeout reached, closing connection...');
      ws.close();
      resolve(result);
    }, 5000);

    ws.on('open', () => {
      console.log('✅ Tasks stream connected successfully!');
      result.connected = true;
    });

    ws.on('message', (data: Buffer) => {
      result.messagesReceived++;
      try {
        const message = JSON.parse(data.toString());
        console.log(`📨 Task message #${result.messagesReceived}:`, JSON.stringify(message, null, 2));
        if (result.sampleMessages!.length < 3) {
          result.sampleMessages!.push(message);
        }
      } catch (e) {
        console.log(`📨 Raw message #${result.messagesReceived}:`, data.toString());
      }
    });

    ws.on('error', (error: any) => {
      console.error('❌ Tasks stream error:', error.message);
      result.error = error.message;
      clearTimeout(timeout);
      resolve(result);
    });

    ws.on('close', (code, reason) => {
      console.log(`🔌 Tasks stream closed (code: ${code}, reason: ${reason.toString()})`);
      clearTimeout(timeout);
      resolve(result);
    });

    ws.on('unexpected-response', (req, res) => {
      console.error(`❌ Unexpected HTTP response: ${res.statusCode} ${res.statusMessage}`);
      result.error = `Unexpected server response: ${res.statusCode}`;

      // Read the response body
      let body = '';
      res.on('data', chunk => { body += chunk.toString(); });
      res.on('end', () => {
        console.error('Response body:', body.substring(0, 500));
        clearTimeout(timeout);
        resolve(result);
      });
    });
  });
}

async function main() {
  console.log('🧞 Forge WebSocket Validation Test');
  console.log('=====================================\n');
  console.log(`Forge URL: ${FORGE_URL}`);
  console.log(`Project ID: ${PROJECT_ID}\n`);

  const results: StreamTestResult[] = [];

  // Test 1: Tasks stream (project-level, should work immediately)
  console.log('\n--- Test 1: Tasks Stream ---');
  const tasksResult = await testTasksStream(PROJECT_ID);
  results.push(tasksResult);

  // Test 2: Create a test task to get attempt/process IDs
  console.log('\n--- Test 2: Creating Test Task ---');
  let attemptId: string | null = null;
  let processId: string | null = null;

  try {
    const forgeExecutor = createForgeExecutor();
    console.log('Creating test wish session...');

    const session = await forgeExecutor.createSession({
      agentName: 'wish',
      prompt: 'Test websocket streaming validation',
      executorKey: 'claude-code',
      executorVariant: 'default',
      executionMode: 'test'
    });

    attemptId = session.attemptId;
    console.log(`✅ Test task created: ${session.taskId}`);
    console.log(`   Attempt ID: ${attemptId}`);
    console.log(`   Forge URL: ${session.forgeUrl}`);

    // Wait a moment for task to initialize
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Get process ID from Forge API
    const forgeClient = new ForgeClient(FORGE_URL);
    const attempt = await forgeClient.getTaskAttempt(attemptId);
    if (attempt.execution_processes && attempt.execution_processes.length > 0) {
      processId = attempt.execution_processes[0].id;
      console.log(`   Process ID: ${processId}`);
    }
  } catch (error: any) {
    console.error('❌ Failed to create test task:', error.message);
  }

  // Test 3: Diff stream (requires attempt ID)
  if (attemptId) {
    console.log('\n--- Test 3: Diff Stream ---');
    const diffResult = await testDiffStream(attemptId);
    results.push(diffResult);
  } else {
    console.log('\n--- Test 3: Diff Stream (SKIPPED - no attempt ID) ---');
  }

  // Test 4: Raw logs stream (requires process ID)
  if (processId) {
    console.log('\n--- Test 4: Raw Logs Stream ---');
    const logsResult = await testRawLogsStream(processId);
    results.push(logsResult);
  } else {
    console.log('\n--- Test 4: Raw Logs Stream (SKIPPED - no process ID) ---');
  }

  // Summary
  console.log('\n=====================================');
  console.log('📊 Test Results Summary');
  console.log('=====================================\n');

  results.forEach(result => {
    console.log(`${result.stream.toUpperCase()} Stream:`);
    console.log(`  Connected: ${result.connected ? '✅' : '❌'}`);
    console.log(`  Messages: ${result.messagesReceived}`);
    if (result.error) {
      console.log(`  Error: ${result.error}`);
    }
    console.log();
  });

  // Conclusions
  console.log('=====================================');
  console.log('🎯 Conclusions for MCP Integration');
  console.log('=====================================\n');

  const allConnected = results.every(r => r.connected);
  const anyMessages = results.some(r => r.messagesReceived > 0);

  if (allConnected) {
    console.log('✅ All websocket streams connected successfully');
  } else {
    console.log('⚠️  Some websocket streams failed to connect');
  }

  if (anyMessages) {
    console.log('✅ Real-time messages received via websocket');
  } else {
    console.log('⚠️  No messages received (tasks may be too fast or not generating events)');
  }

  console.log('\n🚀 MCP Integration Recommendations:');
  console.log('   1. Use ForgeClient.getTaskDiffStreamUrl() for file change streaming');
  console.log('   2. Use ForgeClient.getRawLogsStreamUrl() for agent output streaming');
  console.log('   3. Use ForgeClient.getTasksStreamUrl() for project-wide task updates');
  console.log('   4. Replace CLI shell-out with direct ForgeExecutor.createSession()');
  console.log('   5. Websocket connections provide true real-time updates\n');

  process.exit(0);
}

main().catch(error => {
  console.error('💥 Test failed:', error);
  process.exit(1);
});
