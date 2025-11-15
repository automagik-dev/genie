"use strict";
/**
 * Genie OAuth Provider for MCP SDK
 *
 * Implements the OAuthTokenVerifier interface required by the official MCP SDK.
 * Uses our existing JWT verification logic from oauth2-utils.ts.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.GenieOAuthProvider = void 0;
// Dynamic import of OAuth2 utilities
let verifyAccessTokenFn;
let generateAccessTokenFn;
let validateClientCredentialsFn;
function loadOAuth2Utils() {
    if (!verifyAccessTokenFn) {
        const oauth2Utils = require('../../cli/lib/oauth2-utils.js');
        verifyAccessTokenFn = oauth2Utils.verifyAccessToken;
        generateAccessTokenFn = oauth2Utils.generateAccessToken;
        validateClientCredentialsFn = oauth2Utils.validateClientCredentials;
    }
    return { verifyAccessTokenFn, generateAccessTokenFn, validateClientCredentialsFn };
}
/**
 * Genie OAuth Provider - Implements token verification and issuance
 *
 * This provider implements the full OAuthServerProvider interface for the MCP SDK.
 * It uses client credentials flow (RFC 6749 Section 4.4) with JWT access tokens.
 */
class GenieOAuthProvider {
    constructor(oauth2Config, serverUrl) {
        this.oauth2Config = oauth2Config;
        this.serverUrl = serverUrl;
    }
    /**
     * Get the clients store (we use a simple in-memory store with a single client)
     */
    get clientsStore() {
        // Capture oauth2Config in closure to avoid 'this' scope issues
        const config = this.oauth2Config;
        return {
            async getClient(clientId) {
                if (clientId === config.clientId) {
                    return {
                        client_id: config.clientId,
                        client_secret: config.clientSecret,
                        grant_types: ['client_credentials'],
                        token_endpoint_auth_method: 'client_secret_post',
                        // Optional fields
                        client_name: 'Genie MCP Client',
                        redirect_uris: []
                    };
                }
                return undefined;
            }
        };
    }
    /**
     * Begin authorization flow (not used for client credentials flow)
     */
    async authorize(client, params, res) {
        // Client credentials flow doesn't use authorization endpoint
        res.status(400).json({
            error: 'unsupported_response_type',
            error_description: 'Only client_credentials grant type is supported'
        });
    }
    /**
     * Get code challenge for authorization code (not used for client credentials flow)
     */
    async challengeForAuthorizationCode(client, authorizationCode) {
        throw new Error('Authorization code flow not supported');
    }
    /**
     * Exchange authorization code for token (not used for client credentials flow)
     */
    async exchangeAuthorizationCode(client, authorizationCode, codeVerifier, redirectUri, resource) {
        throw new Error('Authorization code flow not supported');
    }
    /**
     * Exchange refresh token for access token (not supported yet)
     */
    async exchangeRefreshToken(client, refreshToken, scopes, resource) {
        throw new Error('Refresh tokens not supported yet');
    }
    /**
     * Verify access token and return auth info
     *
     * This is the core method used by requireBearerAuth middleware.
     */
    async verifyAccessToken(token) {
        const { verifyAccessTokenFn } = loadOAuth2Utils();
        // Verify JWT token using our existing logic
        const payload = await verifyAccessTokenFn(token, this.oauth2Config.publicKey, this.oauth2Config.issuer, `${this.serverUrl}/mcp`);
        if (!payload) {
            throw new Error('Invalid or expired token');
        }
        // Map JWT payload to SDK's AuthInfo interface
        return {
            token,
            clientId: payload.client_id,
            scopes: (payload.scope || '').split(' ').filter(Boolean),
            expiresAt: payload.exp,
            resource: new URL(payload.aud)
        };
    }
    /**
     * Revoke a token (optional - not implemented yet)
     */
    async revokeToken(client, request) {
        // Token revocation not implemented yet
        // In production, would maintain a revocation list or use token introspection
    }
    /**
     * Generate access token for client credentials flow
     *
     * This method is called by the SDK's mcpAuthRouter when a client
     * requests a token via POST /oauth/token.
     */
    async generateClientCredentialsToken(clientId, clientSecret, scopes) {
        const { generateAccessTokenFn, validateClientCredentialsFn } = loadOAuth2Utils();
        // Validate client credentials
        const isValid = validateClientCredentialsFn(clientId, clientSecret, this.oauth2Config.clientId, this.oauth2Config.clientSecret);
        if (!isValid) {
            throw new Error('Invalid client credentials');
        }
        // Generate JWT access token
        const token = await generateAccessTokenFn(this.oauth2Config.signingKey, this.oauth2Config.issuer, `${this.serverUrl}/mcp`, clientId, this.oauth2Config.tokenExpiry || 3600);
        return token;
    }
}
exports.GenieOAuthProvider = GenieOAuthProvider;
