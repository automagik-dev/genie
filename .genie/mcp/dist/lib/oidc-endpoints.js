"use strict";
/**
 * OpenID Connect Discovery and OAuth 2.0 Authorization Server Metadata
 *
 * Implements:
 * - OpenID Connect Discovery (for ChatGPT)
 * - OAuth 2.0 Authorization Server Metadata (for MCP spec)
 * - Dynamic Client Registration (RFC 7591)
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateOpenIDConfiguration = generateOpenIDConfiguration;
exports.generateAuthorizationServerMetadata = generateAuthorizationServerMetadata;
exports.handleOpenIDConfiguration = handleOpenIDConfiguration;
exports.handleAuthorizationServerMetadata = handleAuthorizationServerMetadata;
exports.handleClientRegistration = handleClientRegistration;
exports.getRegisteredClient = getRegisteredClient;
exports.ensureDefaultChatGPTClient = ensureDefaultChatGPTClient;
exports.validateRedirectUri = validateRedirectUri;
exports.handleAuthorizationRequest = handleAuthorizationRequest;
exports.handleAuthorizationConsent = handleAuthorizationConsent;
const crypto_1 = require("crypto");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
const oauth_session_manager_js_1 = require("./oauth-session-manager.js");
/**
 * Generate OpenID Connect Discovery metadata
 */
function generateOpenIDConfiguration(serverUrl) {
    return {
        issuer: serverUrl,
        authorization_endpoint: `${serverUrl}/oauth2/authorize`,
        token_endpoint: `${serverUrl}/oauth/token`,
        registration_endpoint: `${serverUrl}/oauth2/register`,
        scopes_supported: ['mcp:read', 'mcp:write'],
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token', 'client_credentials'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    };
}
/**
 * Generate OAuth 2.0 Authorization Server Metadata
 */
function generateAuthorizationServerMetadata(serverUrl) {
    return {
        issuer: serverUrl,
        authorization_endpoint: `${serverUrl}/oauth2/authorize`,
        token_endpoint: `${serverUrl}/oauth/token`,
        registration_endpoint: `${serverUrl}/oauth2/register`,
        scopes_supported: ['mcp:read', 'mcp:write'],
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token', 'client_credentials'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    };
}
/**
 * Handle OpenID Connect Discovery request
 */
function handleOpenIDConfiguration(req, res, serverUrl) {
    const config = generateOpenIDConfiguration(serverUrl);
    res.json(config);
}
/**
 * Handle OAuth 2.0 Authorization Server Metadata request
 */
function handleAuthorizationServerMetadata(req, res, serverUrl) {
    const metadata = generateAuthorizationServerMetadata(serverUrl);
    res.json(metadata);
}
/**
 * Get path to OAuth clients storage file
 */
function getClientsFilePath() {
    const genieDir = path_1.default.join(os_1.default.homedir(), '.genie');
    if (!fs_1.default.existsSync(genieDir)) {
        fs_1.default.mkdirSync(genieDir, { recursive: true });
    }
    return path_1.default.join(genieDir, 'oauth-clients.json');
}
/**
 * Load registered clients from storage
 */
function loadClients() {
    const filePath = getClientsFilePath();
    if (!fs_1.default.existsSync(filePath)) {
        return [];
    }
    try {
        const content = fs_1.default.readFileSync(filePath, 'utf-8');
        return JSON.parse(content);
    }
    catch (err) {
        console.error('Failed to load OAuth clients:', err);
        return [];
    }
}
/**
 * Save registered clients to storage
 */
function saveClients(clients) {
    const filePath = getClientsFilePath();
    try {
        fs_1.default.writeFileSync(filePath, JSON.stringify(clients, null, 2), 'utf-8');
    }
    catch (err) {
        console.error('Failed to save OAuth clients:', err);
        throw err;
    }
}
/**
 * Handle Dynamic Client Registration (RFC 7591)
 */
function handleClientRegistration(req, res) {
    const registrationReq = req.body;
    // Validate required fields
    if (!registrationReq.client_name || !registrationReq.redirect_uris || registrationReq.redirect_uris.length === 0) {
        res.status(400).json({
            error: 'invalid_client_metadata',
            error_description: 'client_name and redirect_uris are required',
        });
        return;
    }
    // Validate redirect URIs
    for (const uri of registrationReq.redirect_uris) {
        try {
            const url = new URL(uri);
            if (url.protocol !== 'https:' && url.protocol !== 'http:') {
                res.status(400).json({
                    error: 'invalid_redirect_uri',
                    error_description: `Invalid redirect URI protocol: ${uri}`,
                });
                return;
            }
        }
        catch (err) {
            res.status(400).json({
                error: 'invalid_redirect_uri',
                error_description: `Malformed redirect URI: ${uri}`,
            });
            return;
        }
    }
    // Create registered client
    const client = {
        client_id: (0, crypto_1.randomUUID)(),
        client_name: registrationReq.client_name,
        redirect_uris: registrationReq.redirect_uris,
        grant_types: registrationReq.grant_types || ['authorization_code', 'refresh_token'],
        response_types: registrationReq.response_types || ['code'],
        token_endpoint_auth_method: registrationReq.token_endpoint_auth_method || 'none',
        scope: registrationReq.scope || 'mcp:read mcp:write',
        created_at: Date.now(),
    };
    // Save to storage
    const clients = loadClients();
    clients.push(client);
    saveClients(clients);
    console.error(`✅ Registered OAuth client: ${client.client_name} (${client.client_id})`);
    // Return registration response
    res.status(201).json({
        client_id: client.client_id,
        client_name: client.client_name,
        redirect_uris: client.redirect_uris,
        grant_types: client.grant_types,
        response_types: client.response_types,
        token_endpoint_auth_method: client.token_endpoint_auth_method,
        scope: client.scope,
    });
}
/**
 * Get registered client by client_id
 */
function getRegisteredClient(clientId) {
    const clients = loadClients();
    return clients.find((c) => c.client_id === clientId) || null;
}
/**
 * Ensure default ChatGPT client is registered
 * Should be called during MCP server startup
 */
function ensureDefaultChatGPTClient(clientId) {
    // Check if client already registered
    const existing = getRegisteredClient(clientId);
    if (existing) {
        return; // Already registered, nothing to do
    }
    // Register default ChatGPT client
    const defaultClient = {
        client_id: clientId,
        client_name: 'ChatGPT (Default Client)',
        redirect_uris: [
            'https://chatgpt.com/connector_platform_oauth_redirect',
            'http://localhost:3000/callback'
        ],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: 'mcp:read mcp:write',
        created_at: Date.now()
    };
    const clients = loadClients();
    clients.push(defaultClient);
    saveClients(clients);
    // Only log in debug mode
    const debugMode = process.env.MCP_DEBUG === '1' || process.env.DEBUG === '1';
    if (debugMode) {
        console.error(`✅ Auto-registered default ChatGPT client (${clientId})`);
    }
}
/**
 * Validate redirect URI for a registered client
 */
function validateRedirectUri(clientId, redirectUri) {
    const client = getRegisteredClient(clientId);
    if (!client) {
        return false;
    }
    return client.redirect_uris.includes(redirectUri);
}
/**
 * Get Genie OAuth PIN from config
 */
function getOAuthPin() {
    try {
        const configPath = path_1.default.join(os_1.default.homedir(), '.genie', 'config.yaml');
        if (!fs_1.default.existsSync(configPath)) {
            return null;
        }
        const content = fs_1.default.readFileSync(configPath, 'utf-8');
        // Simple YAML parsing for mcp.oauth.pin
        const pinMatch = content.match(/^\s*pin:\s*["']?(.+?)["']?\s*$/m);
        return pinMatch ? pinMatch[1] : null;
    }
    catch (err) {
        console.error('Failed to read OAuth PIN from config:', err);
        return null;
    }
}
/**
 * Handle Authorization Request (GET /oauth2/authorize)
 * Shows consent page to user
 */
function handleAuthorizationRequest(req, res) {
    const { client_id, redirect_uri, response_type, scope, code_challenge, code_challenge_method, state, } = req.query;
    // Validate required parameters
    if (!client_id || !redirect_uri || !response_type || !code_challenge || !state) {
        res.status(400).json({
            error: 'invalid_request',
            error_description: 'Missing required parameters (client_id, redirect_uri, response_type, code_challenge, state)',
        });
        return;
    }
    // Validate response_type
    if (response_type !== 'code') {
        const errorUrl = `${redirect_uri}?error=unsupported_response_type&error_description=${encodeURIComponent('Only response_type=code is supported')}&state=${state}`;
        res.redirect(errorUrl);
        return;
    }
    // Validate code_challenge_method
    if (code_challenge_method && code_challenge_method !== 'S256') {
        const errorUrl = `${redirect_uri}?error=invalid_request&error_description=${encodeURIComponent('Only code_challenge_method=S256 is supported')}&state=${state}`;
        res.redirect(errorUrl);
        return;
    }
    // Validate client exists
    const client = getRegisteredClient(client_id);
    if (!client) {
        const errorUrl = `${redirect_uri}?error=invalid_client&error_description=${encodeURIComponent('Client not registered')}&state=${state}`;
        res.redirect(errorUrl);
        return;
    }
    // Validate redirect_uri
    if (!validateRedirectUri(client_id, redirect_uri)) {
        res.status(400).json({
            error: 'invalid_request',
            error_description: 'Invalid redirect_uri for this client',
        });
        return;
    }
    // Store authorization request
    const requestId = (0, crypto_1.randomUUID)();
    const authRequest = {
        client_id,
        redirect_uri,
        scope: scope || 'mcp:read mcp:write',
        code_challenge,
        code_challenge_method: 'S256',
        state,
        response_type: 'code',
        created_at: Date.now(),
    };
    oauth_session_manager_js_1.oauthSessionManager.storeAuthorizationRequest(requestId, authRequest);
    // Serve consent page
    const htmlPath = path_1.default.join(__dirname, 'views', 'authorize.html');
    let html = fs_1.default.readFileSync(htmlPath, 'utf-8');
    // Build consent page URL with parameters
    const consentUrl = `/oauth2/authorize/consent?request_id=${requestId}&client_name=${encodeURIComponent(client.client_name)}&scope=${encodeURIComponent(authRequest.scope)}&redirect_uri=${encodeURIComponent(redirect_uri)}&state=${state}`;
    // Replace the form action with proper URL
    html = html.replace('action="/oauth2/authorize/consent"', `action="${consentUrl}"`);
    res.send(html);
}
/**
 * Handle Authorization Consent (POST /oauth2/authorize/consent)
 * Validates PIN and generates authorization code
 */
function handleAuthorizationConsent(req, res) {
    const { request_id, pin } = req.body;
    const { redirect_uri, state } = req.query;
    if (!request_id || !pin) {
        res.status(400).json({
            error: 'invalid_request',
            error_description: 'Missing request_id or pin',
        });
        return;
    }
    // Get authorization request
    const authRequest = oauth_session_manager_js_1.oauthSessionManager.getAuthorizationRequest(request_id);
    if (!authRequest) {
        res.status(400).json({
            error: 'invalid_request',
            error_description: 'Invalid or expired authorization request',
        });
        return;
    }
    // Validate PIN
    const configPin = getOAuthPin();
    if (!configPin) {
        res.status(500).json({
            error: 'server_error',
            error_description: 'OAuth PIN not configured. Run `genie` to set up OAuth.',
        });
        return;
    }
    if (pin !== configPin) {
        res.status(401).json({
            error: 'access_denied',
            error_description: 'Invalid PIN',
        });
        return;
    }
    // Generate authorization code
    const code = oauth_session_manager_js_1.oauthSessionManager.generateAuthorizationCode(authRequest);
    // Remove authorization request (no longer needed)
    oauth_session_manager_js_1.oauthSessionManager.removeAuthorizationRequest(request_id);
    // Redirect to client with authorization code
    const redirectUrl = `${authRequest.redirect_uri}?code=${code}&state=${authRequest.state}`;
    res.redirect(redirectUrl);
}
