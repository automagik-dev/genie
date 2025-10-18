#!/usr/bin/env node
/**
 * Advanced Forge MCP Server
 *
 * Type-safe MCP interface to Automagik Forge Backend API using FastMCP.
 * Provides 30+ tools for managing projects, tasks, and AI agent execution.
 *
 * Features:
 * - HTTP Streaming transport (default)
 * - Stateless mode (serverless-ready)
 * - Health check endpoints (/health, /ready)
 * - Authentication (API key or environment)
 * - Progress notifications
 * - Dynamic resources (logs, status)
 * - Comprehensive error handling
 */

import { FastMCP } from 'fastmcp';
import { ForgeClient } from './lib/forge-client.js';
import { ForgeLogger } from './lib/logger.js';

// Tool registration
import { registerHealthTools } from './tools/health.js';
import { registerProjectTools } from './tools/projects.js';
import { registerTaskTools } from './tools/tasks.js';
import { registerTaskAttemptTools } from './tools/attempts.js';

// Resource registration
import { registerLogResources } from './resources/logs.js';
import { registerStatusResources } from './resources/status.js';

// Configuration
const PORT = process.env.MCP_PORT ? parseInt(process.env.MCP_PORT) : 8081;
const TRANSPORT = process.env.MCP_TRANSPORT || 'httpStream';
const FORGE_BASE_URL = process.env.FORGE_BASE_URL || 'http://localhost:3000';
const FORGE_API_KEY = process.env.FORGE_API_KEY;

// Initialize logger
const logger = new ForgeLogger('[Forge MCP]');

/**
 * Extract API key from request headers
 */
function extractApiKey(request: any): string | undefined {
  // Check X-Forge-API-Key header
  const forgeKey = request.headers['x-forge-api-key'];
  if (forgeKey) return forgeKey;

  // Check Authorization: Bearer <token>
  const authHeader = request.headers['authorization'];
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.replace('Bearer ', '');
  }

  return undefined;
}

/**
 * Initialize FastMCP server with authentication
 */
const server = new FastMCP({
  name: 'Forge MCP Server',
  version: '1.0.0' as `${number}.${number}.${number}`,

  // Authentication middleware
  authenticate: async (request: any) => {
    logger.debug('Authenticating request...');

    // Extract API key from request or environment
    const apiKey = extractApiKey(request) || FORGE_API_KEY;

    if (!apiKey) {
      logger.warn('Authentication failed: No API key provided');
      throw new Response(null, {
        status: 401,
        statusText: 'Missing API key. Provide X-Forge-API-Key header or FORGE_API_KEY environment variable.'
      });
    }

    logger.debug('Authentication successful');
    return {
      apiKey,
      userId: 'authenticated-user' // In production, validate against Forge backend
    };
  }
});

/**
 * Initialize Forge client
 * Client is created per-request with auth context
 */
let globalClient: ForgeClient | null = null;

// Use global client for non-authenticated scenarios (stdio mode)
if (TRANSPORT === 'stdio') {
  globalClient = new ForgeClient(FORGE_BASE_URL, FORGE_API_KEY);
}

/**
 * Register all tools and resources
 */
logger.info('Registering tools and resources...');

// Create client for registration (stdio mode only)
const registrationClient = globalClient || new ForgeClient(FORGE_BASE_URL, FORGE_API_KEY);

// Register tools (30+ tools across 4 categories)
registerHealthTools(server, registrationClient);
registerProjectTools(server, registrationClient);
registerTaskTools(server, registrationClient);
registerTaskAttemptTools(server, registrationClient);

// Register resources (dynamic resources for logs and status)
registerLogResources(server, registrationClient);
registerStatusResources(server, registrationClient);

logger.info('Tools and resources registered successfully');

/**
 * Start server with configured transport
 */
logger.info('Starting Forge MCP Server...');
logger.info(`Version: 1.0.0`);
logger.info(`Transport: ${TRANSPORT}`);
logger.info(`Forge Backend: ${FORGE_BASE_URL}`);
logger.info(`Authentication: ${FORGE_API_KEY ? 'Enabled (env)' : 'Required (header)'}`);

if (TRANSPORT === 'stdio') {
  // STDIO transport (for Claude Desktop)
  server.start({
    transportType: 'stdio'
  });
  logger.info('✅ Server started successfully (stdio)');
  logger.info('Ready for Claude Desktop or MCP Inspector connections');

} else if (TRANSPORT === 'httpStream' || TRANSPORT === 'http') {
  // HTTP Streaming transport (default, for Claude Code)
  server.start({
    transportType: 'httpStream',
    httpStream: {
      port: PORT
    }
  });
  logger.info(`✅ Server started successfully (HTTP Stream)`);
  logger.info(`MCP Endpoint: http://localhost:${PORT}/mcp`);
  logger.info(`SSE Endpoint: http://localhost:${PORT}/sse`);
  logger.info(`Health Check: http://localhost:${PORT}/health`);
  logger.info(`Ready Check: http://localhost:${PORT}/ready`);

} else {
  logger.error(`❌ Unknown transport type: ${TRANSPORT}`);
  logger.error('Valid options: stdio, httpStream (default)');
  process.exit(1);
}

/**
 * Graceful shutdown
 */
process.on('SIGINT', () => {
  logger.info('Received SIGINT, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('Received SIGTERM, shutting down gracefully...');
  process.exit(0);
});
