/**
 * HTTP Server Setup for Genie MCP with OAuth2 Authentication
 *
 * Uses official MCP SDK with Express for HTTP transport.
 * - OAuth2 Client Credentials flow for authentication
 * - Bearer token middleware from SDK
 * - Streamable HTTP transport from SDK
 */

import express, { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { GenieOAuthProvider, OAuth2Config } from './oauth-provider.js';
import { handleTokenEndpoint, handleProtectedResourceMetadata } from './oauth2-endpoints.js';
import { randomUUID } from 'crypto';

export interface HttpServerOptions {
  server: McpServer;
  oauth2Config: OAuth2Config;
  port: number;
  onReady?: (url: string) => void;
}

/**
 * Start HTTP server with OAuth2 authentication using official MCP SDK
 */
export async function startHttpServer(options: HttpServerOptions): Promise<void> {
  const { server, oauth2Config, port, onReady } = options;
  const app = express();

  // Use public URL if behind tunnel (e.g., ngrok), otherwise localhost
  const serverUrl = process.env.MCP_PUBLIC_URL || `http://localhost:${port}`;

  // Body parser middleware
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  // Create OAuth provider for token verification
  const oauthProvider = new GenieOAuthProvider(oauth2Config, serverUrl);

  // ========================================
  // Public Endpoints (no authentication)
  // ========================================

  // Health check endpoint
  app.get('/health', (req: Request, res: Response) => {
    res.json({
      status: 'ok',
      service: 'genie-mcp-server',
      transport: 'httpStream',
      auth: 'oauth2'
    });
  });

  // OAuth2 token endpoint (client credentials flow)
  app.post('/oauth/token', (req: Request, res: Response) => {
    handleTokenEndpoint(req, res, oauth2Config, serverUrl);
  });

  // OAuth2 protected resource metadata endpoint (RFC 9728)
  app.get('/.well-known/oauth-protected-resource', (req: Request, res: Response) => {
    handleProtectedResourceMetadata(req, res, serverUrl);
  });

  // ========================================
  // Protected Endpoints (OAuth2 required)
  // ========================================

  // Create MCP transport
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: false // Use SSE streams for real-time updates
  });

  // Connect MCP server to transport (McpServer wraps the underlying Server)
  await server.server.connect(transport);

  // MCP endpoint - protected by OAuth2 bearer token
  app.post('/mcp', requireBearerAuth({
    verifier: oauthProvider,
    requiredScopes: ['mcp:read', 'mcp:write'],
    resourceMetadataUrl: `${serverUrl}/.well-known/oauth-protected-resource`
  }), (req: Request, res: Response) => {
    // SDK's middleware adds auth info to req.auth
    transport.handleRequest(req, res);
  });

  // SSE endpoint for streaming responses (also protected)
  app.get('/mcp', requireBearerAuth({
    verifier: oauthProvider,
    requiredScopes: ['mcp:read', 'mcp:write'],
    resourceMetadataUrl: `${serverUrl}/.well-known/oauth-protected-resource`
  }), (req: Request, res: Response) => {
    transport.handleRequest(req, res);
  });

  // ========================================
  // Error handling
  // ========================================

  // 404 handler
  app.use((req: Request, res: Response) => {
    res.status(404).json({
      error: 'Not Found',
      message: `Endpoint ${req.method} ${req.path} not found`
    });
  });

  // Global error handler
  app.use((err: any, req: Request, res: Response, next: any) => {
    console.error('Server error:', err);
    res.status(err.status || 500).json({
      error: err.name || 'Internal Server Error',
      message: err.message || 'An unexpected error occurred'
    });
  });

  // ========================================
  // Start server
  // ========================================

  return new Promise((resolve) => {
    app.listen(port, () => {
      console.error(`\n✅ Genie MCP Server started successfully`);
      console.error(`   HTTP Stream: ${serverUrl}/mcp`);
      console.error(`   SSE Stream:  ${serverUrl}/mcp (GET)`);
      console.error(`   Health:      ${serverUrl}/health`);
      console.error(`   OAuth Token: ${serverUrl}/oauth/token`);
      console.error(`   OAuth Meta:  ${serverUrl}/.well-known/oauth-protected-resource`);
      console.error(`\n🔐 Authentication: OAuth2.1 Client Credentials`);
      console.error(`   ├─ Client ID:     ${oauth2Config.clientId}`);
      console.error(`   ├─ Token Expiry:  ${oauth2Config.tokenExpiry}s`);
      console.error(`   └─ Issuer:        ${oauth2Config.issuer}`);
      console.error(`\n📡 Transport: Streamable HTTP (MCP SDK official)`);

      if (onReady) {
        onReady(serverUrl);
      }

      resolve();
    });
  });
}
