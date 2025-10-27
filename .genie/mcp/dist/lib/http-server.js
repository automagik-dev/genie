"use strict";
/**
 * HTTP Server Setup for Genie MCP with OAuth2 Authentication
 *
 * Uses official MCP SDK with Express for HTTP transport.
 * - OAuth2 Client Credentials flow for authentication
 * - Bearer token middleware from SDK
 * - Streamable HTTP transport from SDK
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startHttpServer = startHttpServer;
const express_1 = __importDefault(require("express"));
const streamableHttp_js_1 = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const bearerAuth_js_1 = require("@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js");
const oauth_provider_js_1 = require("./oauth-provider.js");
const oauth2_endpoints_js_1 = require("./oauth2-endpoints.js");
const crypto_1 = require("crypto");
/**
 * Start HTTP server with OAuth2 authentication using official MCP SDK
 */
async function startHttpServer(options) {
    const { server, oauth2Config, port, onReady } = options;
    const app = (0, express_1.default)();
    // Use public URL if behind tunnel (e.g., ngrok), otherwise localhost
    const serverUrl = process.env.MCP_PUBLIC_URL || `http://localhost:${port}`;
    // Body parser middleware
    app.use(express_1.default.json());
    app.use(express_1.default.urlencoded({ extended: false }));
    // Create OAuth provider for token verification
    const oauthProvider = new oauth_provider_js_1.GenieOAuthProvider(oauth2Config, serverUrl);
    // ========================================
    // Public Endpoints (no authentication)
    // ========================================
    // Health check endpoint
    app.get('/health', (req, res) => {
        res.json({
            status: 'ok',
            service: 'genie-mcp-server',
            transport: 'httpStream',
            auth: 'oauth2'
        });
    });
    // OAuth2 token endpoint (client credentials flow)
    app.post('/oauth/token', (req, res) => {
        (0, oauth2_endpoints_js_1.handleTokenEndpoint)(req, res, oauth2Config, serverUrl);
    });
    // OAuth2 protected resource metadata endpoint (RFC 9728)
    app.get('/.well-known/oauth-protected-resource', (req, res) => {
        (0, oauth2_endpoints_js_1.handleProtectedResourceMetadata)(req, res, serverUrl);
    });
    // ========================================
    // Protected Endpoints (OAuth2 required)
    // ========================================
    // Create MCP transport
    const transport = new streamableHttp_js_1.StreamableHTTPServerTransport({
        sessionIdGenerator: () => (0, crypto_1.randomUUID)(),
        enableJsonResponse: false // Use SSE streams for real-time updates
    });
    // Connect MCP server to transport (McpServer wraps the underlying Server)
    await server.server.connect(transport);
    // MCP endpoint - protected by OAuth2 bearer token
    app.post('/mcp', (0, bearerAuth_js_1.requireBearerAuth)({
        verifier: oauthProvider,
        requiredScopes: ['mcp:read', 'mcp:write'],
        resourceMetadataUrl: `${serverUrl}/.well-known/oauth-protected-resource`
    }), (req, res) => {
        // SDK's middleware adds auth info to req.auth
        transport.handleRequest(req, res);
    });
    // SSE endpoint for streaming responses (also protected)
    app.get('/mcp', (0, bearerAuth_js_1.requireBearerAuth)({
        verifier: oauthProvider,
        requiredScopes: ['mcp:read', 'mcp:write'],
        resourceMetadataUrl: `${serverUrl}/.well-known/oauth-protected-resource`
    }), (req, res) => {
        transport.handleRequest(req, res);
    });
    // ========================================
    // Error handling
    // ========================================
    // 404 handler
    app.use((req, res) => {
        res.status(404).json({
            error: 'Not Found',
            message: `Endpoint ${req.method} ${req.path} not found`
        });
    });
    // Global error handler
    app.use((err, req, res, next) => {
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
