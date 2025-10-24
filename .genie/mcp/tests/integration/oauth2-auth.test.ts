/**
 * E2E OAuth2 Authentication Tests for Genie MCP Server
 *
 * Tests the complete OAuth2 authentication flow:
 * - Token generation
 * - Token validation
 * - Public endpoint access
 * - Protected endpoint access
 */

import { spawn, ChildProcess } from 'child_process';
import http from 'http';
import path from 'path';
import { generateAccessToken, generateClientCredentials, generateKeyPair } from '../../../cli/src/lib/oauth2-utils';

// Test configuration
const MCP_PORT = 8886; // Use different port to avoid conflicts
const SERVER_URL = `http://localhost:${MCP_PORT}`;
const MCP_ENDPOINT = `${SERVER_URL}/mcp`;

// Test fixtures
let serverProcess: ChildProcess | null = null;
let testCredentials: {
  clientId: string;
  clientSecret: string;
  signingKey: string;
  publicKey: string;
};

/**
 * Start MCP server with OAuth2 enabled
 */
async function startMCPServer(): Promise<void> {
  // Generate test credentials
  const { clientId, clientSecret } = generateClientCredentials();
  const { privateKey, publicKey } = await generateKeyPair();

  testCredentials = {
    clientId,
    clientSecret,
    signingKey: privateKey,
    publicKey
  };

  // Create test config
  const testConfig = {
    enabled: true,
    clientId,
    clientSecret,
    signingKey: privateKey,
    publicKey,
    tokenExpiry: 3600,
    issuer: 'genie-mcp-test-server'
  };

  // Write config to temp file
  const configPath = path.join(process.cwd(), '.genie', 'state', 'test-oauth2-config.json');
  const fs = require('fs');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(testConfig));

  // Start server
  serverProcess = spawn('node', [
    path.join(__dirname, '../../dist/server.js')
  ], {
    env: {
      ...process.env,
      MCP_PORT: String(MCP_PORT),
      MCP_TRANSPORT: 'httpStream',
      GENIE_CONFIG_PATH: configPath
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  // Wait for server to start
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Server startup timeout'));
    }, 10000);

    let output = '';
    serverProcess!.stderr?.on('data', (data) => {
      output += data.toString();
      if (output.includes('Server started successfully')) {
        clearTimeout(timeout);
        resolve(undefined);
      }
    });

    serverProcess!.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });

  // Additional wait for server to fully initialize
  await new Promise(resolve => setTimeout(resolve, 1000));
}

/**
 * Stop MCP server
 */
async function stopMCPServer(): Promise<void> {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 1000));
    serverProcess = null;
  }
}

/**
 * Make HTTP request
 */
function makeRequest(options: http.RequestOptions, body?: string): Promise<{
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let responseBody = '';

      res.on('data', (chunk) => {
        responseBody += chunk.toString();
      });

      res.on('end', () => {
        resolve({
          statusCode: res.statusCode || 0,
          headers: res.headers,
          body: responseBody
        });
      });
    });

    req.on('error', reject);

    if (body) {
      req.write(body);
    }

    req.end();
  });
}

/**
 * Generate test access token
 */
async function generateTestToken(): Promise<string> {
  return await generateAccessToken(
    testCredentials.signingKey,
    'genie-mcp-test-server',
    `${SERVER_URL}/mcp`,
    testCredentials.clientId,
    3600
  );
}

/**
 * Test suite
 */
describe('MCP OAuth2 Integration', () => {
  // Setup/teardown
  beforeAll(async () => {
    await startMCPServer();
  });

  afterAll(async () => {
    await stopMCPServer();
  });

  // Test 1: Health endpoint works without token
  test('health endpoint works without token', async () => {
    const response = await makeRequest({
      hostname: 'localhost',
      port: MCP_PORT,
      path: '/health',
      method: 'GET'
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('ok');
  });

  // Test 2: OAuth metadata endpoint works without token
  test('oauth metadata endpoint works without token', async () => {
    const response = await makeRequest({
      hostname: 'localhost',
      port: MCP_PORT,
      path: '/.well-known/oauth-protected-resource',
      method: 'GET'
    });

    expect(response.statusCode).toBe(200);

    const metadata = JSON.parse(response.body);
    expect(metadata.resource).toBe(`${SERVER_URL}/mcp`);
    expect(metadata.authorizationServers).toContain(SERVER_URL);
    expect(metadata.bearerMethodsSupported).toContain('header');
  });

  // Test 3: MCP request without token returns 401
  test('MCP request without token returns 401', async () => {
    const response = await makeRequest({
      hostname: 'localhost',
      port: MCP_PORT,
      path: '/mcp',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    }, JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/list',
      id: 1
    }));

    expect(response.statusCode).toBe(401);
    expect(response.headers['www-authenticate']).toBeDefined();
  });

  // Test 4: MCP request with invalid token returns 401
  test('MCP request with invalid token returns 401', async () => {
    const response = await makeRequest({
      hostname: 'localhost',
      port: MCP_PORT,
      path: '/mcp',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer invalid-token-here'
      }
    }, JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/list',
      id: 1
    }));

    expect(response.statusCode).toBe(401);
  });

  // Test 5: MCP request with valid token succeeds
  test('MCP request with valid token returns 200', async () => {
    const token = await generateTestToken();

    const response = await makeRequest({
      hostname: 'localhost',
      port: MCP_PORT,
      path: '/mcp',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      }
    }, JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/list',
      id: 1
    }));

    expect(response.statusCode).toBe(200);

    const result = JSON.parse(response.body);
    expect(result.jsonrpc).toBe('2.0');
    expect(result.id).toBe(1);
  });

  // Test 6: MCP request with expired token returns 401
  test('MCP request with expired token returns 401', async () => {
    // Generate token with -1 second expiry (already expired)
    const expiredToken = await generateAccessToken(
      testCredentials.signingKey,
      'genie-mcp-test-server',
      `${SERVER_URL}/mcp`,
      testCredentials.clientId,
      -1 // Already expired
    );

    // Wait a moment to ensure token is definitely expired
    await new Promise(resolve => setTimeout(resolve, 100));

    const response = await makeRequest({
      hostname: 'localhost',
      port: MCP_PORT,
      path: '/mcp',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${expiredToken}`
      }
    }, JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/list',
      id: 1
    }));

    expect(response.statusCode).toBe(401);
  });
});
