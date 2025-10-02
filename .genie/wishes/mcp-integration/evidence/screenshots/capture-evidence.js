#!/usr/bin/env node
/**
 * Capture MCP Evidence
 *
 * Creates detailed evidence files showing:
 * 1. Tools list with schemas
 * 2. Tool execution results
 * 3. Prompts list
 * 4. JSON-RPC message samples
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function sendRequest(process, request, timeout = 30000) {
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
              clearTimeout(timer);
              process.stdout.removeListener('data', onData);
              resolve(response);
              return;
            }
          } catch (e) {
            // Ignore
          }
        }
      }
    };

    process.stdout.on('data', onData);
    process.stdin.write(JSON.stringify(request) + '\n');
  });
}

function startServer() {
  return new Promise((resolve, reject) => {
    // Use process.cwd() to get the actual working directory (repo root)
    const rootDir = process.cwd();
    const serverPath = path.join(rootDir, '.genie/mcp/dist/server.js');

    if (!fs.existsSync(serverPath)) {
      reject(new Error(`Server not found at ${serverPath}`));
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
    setTimeout(() => reject(new Error('Server startup timeout')), 5000);
  });
}

async function captureEvidence() {
  console.log('\n=== Capturing MCP Evidence ===\n');

  let server;
  let requestId = 1;
  const evidenceDir = __dirname;

  try {
    server = await startServer();
    console.log('✅ Server started\n');

    // Initialize
    const initResponse = await sendRequest(server, {
      jsonrpc: '2.0',
      id: requestId++,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'evidence-capture', version: '1.0.0' }
      }
    });

    // Capture 1: Tools List
    console.log('[1/6] Capturing tools list...');
    const toolsResponse = await sendRequest(server, {
      jsonrpc: '2.0',
      id: requestId++,
      method: 'tools/list',
      params: {}
    });

    const toolsOutput = `# MCP Tools List

**Total Tools:** ${toolsResponse.result.tools.length}

${toolsResponse.result.tools.map((tool, i) => `
## ${i + 1}. ${tool.name}

**Description:** ${tool.description}

**Input Schema:**
\`\`\`json
${JSON.stringify(tool.inputSchema, null, 2)}
\`\`\`
`).join('\n')}
`;

    fs.writeFileSync(path.join(evidenceDir, 'tools-list.txt'), toolsOutput);
    console.log('   ✅ Saved: tools-list.txt\n');

    // Capture 2: Run Tool Schema Detail
    console.log('[2/6] Capturing run tool schema...');
    const runTool = toolsResponse.result.tools.find(t => t.name === 'run');
    fs.writeFileSync(
      path.join(evidenceDir, 'tool-schema-run.json'),
      JSON.stringify(runTool, null, 2)
    );
    console.log('   ✅ Saved: tool-schema-run.json\n');

    // Capture 3: list_agents Execution
    console.log('[3/6] Capturing list_agents execution...');
    const listAgentsResponse = await sendRequest(server, {
      jsonrpc: '2.0',
      id: requestId++,
      method: 'tools/call',
      params: {
        name: 'list_agents',
        arguments: {}
      }
    }, 15000);

    const listAgentsOutput = `# list_agents Tool Execution

**Request:**
\`\`\`json
{
  "jsonrpc": "2.0",
  "id": ${requestId - 1},
  "method": "tools/call",
  "params": {
    "name": "list_agents",
    "arguments": {}
  }
}
\`\`\`

**Response:**
\`\`\`json
${JSON.stringify(listAgentsResponse, null, 2)}
\`\`\`

**Output:**
${listAgentsResponse.result.content[0]?.text || 'No output'}
`;

    fs.writeFileSync(path.join(evidenceDir, 'list-agents-execution.txt'), listAgentsOutput);
    console.log('   ✅ Saved: list-agents-execution.txt\n');

    // Capture 4: list_sessions Execution
    console.log('[4/6] Capturing list_sessions execution...');
    const listSessionsResponse = await sendRequest(server, {
      jsonrpc: '2.0',
      id: requestId++,
      method: 'tools/call',
      params: {
        name: 'list_sessions',
        arguments: {}
      }
    }, 15000);

    const listSessionsOutput = `# list_sessions Tool Execution

**Request:**
\`\`\`json
{
  "jsonrpc": "2.0",
  "id": ${requestId - 1},
  "method": "tools/call",
  "params": {
    "name": "list_sessions",
    "arguments": {}
  }
}
\`\`\`

**Response:**
\`\`\`json
${JSON.stringify(listSessionsResponse, null, 2)}
\`\`\`

**Output:**
${listSessionsResponse.result.content[0]?.text || 'No output'}
`;

    fs.writeFileSync(path.join(evidenceDir, 'list-sessions-execution.txt'), listSessionsOutput);
    console.log('   ✅ Saved: list-sessions-execution.txt\n');

    // Capture 5: run Tool Execution
    console.log('[5/6] Capturing run execution...');
    const runResponse = await sendRequest(server, {
      jsonrpc: '2.0',
      id: requestId++,
      method: 'tools/call',
      params: {
        name: 'run',
        arguments: {
          agent: 'analyze',
          prompt: 'Evidence capture test'
        }
      }
    }, 30000);

    const runOutput = `# run Tool Execution

**Request:**
\`\`\`json
{
  "jsonrpc": "2.0",
  "id": ${requestId - 1},
  "method": "tools/call",
  "params": {
    "name": "run",
    "arguments": {
      "agent": "analyze",
      "prompt": "Evidence capture test"
    }
  }
}
\`\`\`

**Response:**
\`\`\`json
${JSON.stringify(runResponse, null, 2)}
\`\`\`

**Output:**
${runResponse.result.content[0]?.text || 'No output'}
`;

    fs.writeFileSync(path.join(evidenceDir, 'run-execution.txt'), runOutput);
    console.log('   ✅ Saved: run-execution.txt\n');

    // Capture 6: Prompts List
    console.log('[6/6] Capturing prompts list...');
    const promptsResponse = await sendRequest(server, {
      jsonrpc: '2.0',
      id: requestId++,
      method: 'prompts/list',
      params: {}
    });

    const promptsOutput = `# MCP Prompts List

**Total Prompts:** ${promptsResponse.result.prompts.length}

${promptsResponse.result.prompts.map((prompt, i) => `
## ${i + 1}. ${prompt.name}

**Description:** ${prompt.description || 'N/A'}

**Arguments:**
${prompt.arguments?.map(arg => `- **${arg.name}** (${arg.required ? 'required' : 'optional'}): ${arg.description || 'N/A'}`).join('\n') || 'None'}
`).join('\n')}
`;

    fs.writeFileSync(path.join(evidenceDir, 'prompts-list.txt'), promptsOutput);
    console.log('   ✅ Saved: prompts-list.txt\n');

    console.log('========================================');
    console.log('✅ All evidence captured successfully');
    console.log('========================================\n');
    console.log('Evidence location:');
    console.log(`  ${evidenceDir}\n`);
    console.log('Files created:');
    console.log('  1. tools-list.txt');
    console.log('  2. tool-schema-run.json');
    console.log('  3. list-agents-execution.txt');
    console.log('  4. list-sessions-execution.txt');
    console.log('  5. run-execution.txt');
    console.log('  6. prompts-list.txt');
    console.log('  7. full-test-output.txt (from automated tests)');
    console.log('  8. README.md (evidence index)\n');

    process.exit(0);

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    process.exit(1);
  } finally {
    if (server) {
      server.kill();
    }
  }
}

captureEvidence();
