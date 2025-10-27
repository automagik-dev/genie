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
const oidc_endpoints_js_1 = require("./oidc-endpoints.js");
const crypto_1 = require("crypto");
/**
 * Start HTTP server with OAuth2 authentication using official MCP SDK
 */
async function startHttpServer(options) {
    const { server, oauth2Config, port, onReady } = options;
    const app = (0, express_1.default)();
    // Use public URL if behind tunnel (e.g., ngrok), otherwise localhost
    const serverUrl = process.env.MCP_PUBLIC_URL || `http://localhost:${port}`;
    // Debug mode (enabled via MCP_DEBUG=1 environment variable)
    const debugMode = process.env.MCP_DEBUG === '1' || process.env.DEBUG === '1';
    // Body parser middleware
    app.use(express_1.default.json());
    app.use(express_1.default.urlencoded({ extended: false }));
    // Debug logging middleware (logs all incoming requests)
    if (debugMode) {
        app.use((req, res, next) => {
            const timestamp = new Date().toISOString();
            console.error(`\n${'='.repeat(80)}`);
            console.error(`🔍 [${timestamp}] ${req.method} ${req.path}`);
            console.error(`${'='.repeat(80)}`);
            // Log query parameters
            if (Object.keys(req.query).length > 0) {
                console.error('📋 Query Parameters:');
                Object.entries(req.query).forEach(([key, value]) => {
                    console.error(`   ${key}: ${value}`);
                });
            }
            // Log headers (filter sensitive ones)
            console.error('📨 Headers:');
            Object.entries(req.headers).forEach(([key, value]) => {
                if (key.toLowerCase() === 'authorization') {
                    console.error(`   ${key}: ${String(value).substring(0, 20)}...`);
                }
                else {
                    console.error(`   ${key}: ${value}`);
                }
            });
            // Log body (for POST/PUT requests)
            if (req.body && Object.keys(req.body).length > 0) {
                console.error('📦 Body:');
                console.error(JSON.stringify(req.body, null, 2));
            }
            console.error(`${'='.repeat(80)}\n`);
            next();
        });
    }
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
    // OpenID Connect Discovery (for ChatGPT)
    app.get('/.well-known/openid-configuration', (req, res) => {
        (0, oidc_endpoints_js_1.handleOpenIDConfiguration)(req, res, serverUrl);
    });
    // OAuth 2.0 Authorization Server Metadata (for MCP spec)
    app.get('/.well-known/oauth-authorization-server', (req, res) => {
        (0, oidc_endpoints_js_1.handleAuthorizationServerMetadata)(req, res, serverUrl);
    });
    // OAuth2 protected resource metadata endpoint (RFC 9728) - kept for backward compatibility
    app.get('/.well-known/oauth-protected-resource', (req, res) => {
        (0, oauth2_endpoints_js_1.handleProtectedResourceMetadata)(req, res, serverUrl);
    });
    // OAuth2 token endpoint (client_credentials + authorization_code flows)
    app.post('/oauth/token', (req, res) => {
        (0, oauth2_endpoints_js_1.handleTokenEndpoint)(req, res, oauth2Config, serverUrl);
    });
    // OAuth2 dynamic client registration (RFC 7591)
    app.post('/oauth2/register', (req, res) => {
        (0, oidc_endpoints_js_1.handleClientRegistration)(req, res);
    });
    // OAuth2 authorization endpoint (GET - shows consent page)
    app.get('/oauth2/authorize', (req, res) => {
        (0, oidc_endpoints_js_1.handleAuthorizationRequest)(req, res);
    });
    // OAuth2 authorization consent endpoint (POST - processes user consent)
    app.post('/oauth2/authorize/consent', (req, res) => {
        (0, oidc_endpoints_js_1.handleAuthorizationConsent)(req, res);
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
            console.error(`\n🔐 OAuth 2.0 Endpoints:`);
            console.error(`   ├─ OIDC Discovery:      ${serverUrl}/.well-known/openid-configuration`);
            console.error(`   ├─ Authorization:       ${serverUrl}/oauth2/authorize`);
            console.error(`   ├─ Token Exchange:      ${serverUrl}/oauth/token`);
            console.error(`   ├─ Client Registration: ${serverUrl}/oauth2/register`);
            console.error(`   └─ Resource Metadata:   ${serverUrl}/.well-known/oauth-protected-resource`);
            console.error(`\n🔑 Supported Flows:`);
            console.error(`   ├─ Authorization Code + PKCE (for ChatGPT)`);
            console.error(`   └─ Client Credentials (for machine-to-machine)`);
            console.error(`\n⚙️  OAuth Config:`);
            console.error(`   ├─ Issuer:       ${oauth2Config.issuer}`);
            console.error(`   ├─ Client ID:    ${oauth2Config.clientId}`);
            console.error(`   └─ Token Expiry: ${oauth2Config.tokenExpiry}s`);
            console.error(`\n📡 Transport: Streamable HTTP (MCP SDK official)`);
            if (debugMode) {
                console.error(`\n🔍 DEBUG MODE ENABLED`);
                console.error(`   All incoming requests will be logged`);
            }
            if (onReady) {
                onReady(serverUrl);
            }
            resolve();
        });
    });
}
