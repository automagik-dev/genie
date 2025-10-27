"use strict";
/**
 * OAuth2.1 Endpoints for Genie MCP Server
 *
 * Implements:
 * - /.well-known/oauth-protected-resource (RFC 9728)
 * - /oauth/token (client_credentials + authorization_code flows)
 *
 * Note: We implement our own token endpoint because the MCP SDK doesn't support
 * client_credentials grant type yet (it only supports authorization_code and refresh_token).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateResourceMetadata = generateResourceMetadata;
exports.handleProtectedResourceMetadata = handleProtectedResourceMetadata;
exports.handleTokenEndpoint = handleTokenEndpoint;
const oauth_session_manager_js_1 = require("./oauth-session-manager.js");
// Dynamic import of OAuth2 utilities
let generateAccessTokenFn;
let validateClientCredentialsFn;
function loadOAuth2Utils() {
    if (!generateAccessTokenFn) {
        const oauth2Utils = require('../../../cli/dist/lib/oauth2-utils.js');
        generateAccessTokenFn = oauth2Utils.generateAccessToken;
        validateClientCredentialsFn = oauth2Utils.validateClientCredentials;
    }
    return { generateAccessTokenFn, validateClientCredentialsFn };
}
/**
 * Generate protected resource metadata
 *
 * @param serverUrl - Base URL of the MCP server (e.g., 'http://localhost:8885')
 * @returns RFC 9728 compliant metadata
 */
function generateResourceMetadata(serverUrl) {
    return {
        resource: `${serverUrl}/mcp`,
        authorization_servers: [`${serverUrl}`], // Self-issued tokens
        bearer_methods_supported: ['header'], // Authorization: Bearer <token>
        scopes_supported: ['mcp:read', 'mcp:write'],
        resource_signing_alg_values_supported: ['RS256'],
    };
}
/**
 * Handle /.well-known/oauth-protected-resource endpoint
 * Returns metadata as JSON per RFC 9728
 */
function handleProtectedResourceMetadata(req, res, serverUrl) {
    const metadata = generateResourceMetadata(serverUrl);
    res.status(200)
        .set('Cache-Control', 'public, max-age=3600') // Cache for 1 hour
        .json(metadata);
}
/**
 * Parse Basic authentication header
 * Returns { username, password } or null if invalid
 */
function parseBasicAuth(authHeader) {
    if (!authHeader || !authHeader.startsWith('Basic ')) {
        return null;
    }
    try {
        const base64Credentials = authHeader.slice(6); // Remove 'Basic '
        const credentials = Buffer.from(base64Credentials, 'base64').toString('utf-8');
        const [username, password] = credentials.split(':', 2);
        if (!username || !password) {
            return null;
        }
        return { username, password };
    }
    catch {
        return null;
    }
}
// parseFormBody removed - Express handles body parsing via express.json() and express.urlencoded()
/**
 * Handle /oauth/token endpoint (client_credentials + authorization_code flows)
 * Implements RFC 6749 Section 4.1 (authorization_code) and 4.4 (client_credentials)
 *
 * Express middleware - body is already parsed by express.json() / express.urlencoded()
 */
async function handleTokenEndpoint(req, res, oauth2Config, serverUrl) {
    const { generateAccessTokenFn, validateClientCredentialsFn } = loadOAuth2Utils();
    const grantType = req.body.grant_type;
    // Route to appropriate grant handler
    if (grantType === 'authorization_code') {
        return handleAuthorizationCodeGrant(req, res, oauth2Config, serverUrl, generateAccessTokenFn);
    }
    else if (grantType === 'client_credentials') {
        return handleClientCredentialsGrant(req, res, oauth2Config, serverUrl, generateAccessTokenFn, validateClientCredentialsFn);
    }
    else {
        res.status(400).json({
            error: 'unsupported_grant_type',
            error_description: 'Supported grant types: authorization_code, client_credentials',
        });
        return;
    }
}
/**
 * Handle authorization_code grant (RFC 6749 Section 4.1.3)
 * Validates authorization code with PKCE and issues access token
 */
async function handleAuthorizationCodeGrant(req, res, oauth2Config, serverUrl, generateAccessTokenFn) {
    const { code, redirect_uri, client_id, code_verifier } = req.body;
    // Validate required parameters
    if (!code || !redirect_uri || !client_id || !code_verifier) {
        res.status(400).json({
            error: 'invalid_request',
            error_description: 'Missing required parameters: code, redirect_uri, client_id, code_verifier',
        });
        return;
    }
    // Validate and consume authorization code (includes PKCE validation)
    const authCode = oauth_session_manager_js_1.oauthSessionManager.validateAndConsumeCode(code, client_id, redirect_uri, code_verifier);
    if (!authCode) {
        res.status(400).json({
            error: 'invalid_grant',
            error_description: 'Invalid or expired authorization code, or PKCE validation failed',
        });
        return;
    }
    try {
        // Generate JWT access token
        const accessToken = await generateAccessTokenFn(oauth2Config.signingKey, oauth2Config.issuer, `${serverUrl}/mcp`, // Audience = resource identifier
        client_id, oauth2Config.tokenExpiry);
        const tokenResponse = {
            access_token: accessToken,
            token_type: 'Bearer',
            expires_in: oauth2Config.tokenExpiry,
            scope: authCode.scope,
        };
        res.status(200)
            .set('Cache-Control', 'no-store')
            .set('Pragma', 'no-cache')
            .json(tokenResponse);
    }
    catch (error) {
        console.error('Token generation error:', error);
        res.status(500).json({
            error: 'server_error',
            error_description: 'Failed to generate access token',
        });
    }
}
/**
 * Handle client_credentials grant (RFC 6749 Section 4.4)
 * Validates client credentials and issues access token
 */
async function handleClientCredentialsGrant(req, res, oauth2Config, serverUrl, generateAccessTokenFn, validateClientCredentialsFn) {
    // Parse client credentials from Authorization header OR request body
    let clientId = null;
    let clientSecret = null;
    // Try Authorization header first (RFC 6749 Section 2.3.1)
    const basicAuth = parseBasicAuth(req.headers.authorization);
    if (basicAuth) {
        clientId = basicAuth.username;
        clientSecret = basicAuth.password;
    }
    else {
        // Fall back to request body (RFC 6749 Section 2.3.1 - not recommended but allowed)
        clientId = req.body.client_id || null;
        clientSecret = req.body.client_secret || null;
    }
    // Validate client credentials presence
    if (!clientId || !clientSecret) {
        res.status(401)
            .set('WWW-Authenticate', 'Basic realm="Genie MCP Server"')
            .json({
            error: 'invalid_client',
            error_description: 'Client authentication failed: missing credentials',
        });
        return;
    }
    // Verify client credentials against config
    const validCredentials = validateClientCredentialsFn(clientId, clientSecret, oauth2Config.clientId, oauth2Config.clientSecret);
    if (!validCredentials) {
        res.status(401)
            .set('WWW-Authenticate', 'Basic realm="Genie MCP Server"')
            .json({
            error: 'invalid_client',
            error_description: 'Client authentication failed: invalid credentials',
        });
        return;
    }
    try {
        // Generate JWT access token
        const accessToken = await generateAccessTokenFn(oauth2Config.signingKey, oauth2Config.issuer, `${serverUrl}/mcp`, // Audience = resource identifier
        clientId, oauth2Config.tokenExpiry);
        const tokenResponse = {
            access_token: accessToken,
            token_type: 'Bearer',
            expires_in: oauth2Config.tokenExpiry,
            scope: 'mcp:read mcp:write',
        };
        res.status(200)
            .set('Cache-Control', 'no-store')
            .set('Pragma', 'no-cache')
            .json(tokenResponse);
    }
    catch (error) {
        console.error('Token generation error:', error);
        res.status(500).json({
            error: 'server_error',
            error_description: 'Failed to generate access token',
        });
    }
}
