"use strict";
/**
 * Secret Token Authentication Middleware
 *
 * Alternative to OAuth2 for services that don't support OAuth (like ElevenLabs).
 *
 * The secret token can be provided via:
 * - Authorization: Bearer <token>
 * - X-Secret-Token: <token>
 * - secret_token query parameter
 *
 * Configure via MCP_SECRET_TOKEN environment variable.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateSecretToken = validateSecretToken;
exports.requireSecretToken = requireSecretToken;
exports.requireOAuth2OrSecretToken = requireOAuth2OrSecretToken;
/**
 * Validate secret token from request
 * Checks Authorization header, custom header, and query params
 */
function validateSecretToken(req, config) {
    const { secretToken, headerName = 'x-secret-token' } = config;
    // No secret token configured - reject
    if (!secretToken) {
        return false;
    }
    // Parse configured tokens (supports comma-separated list)
    const validTokens = secretToken.split(',').map(t => t.trim());
    // Check 1: Authorization header (Bearer format)
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7).trim();
        if (validTokens.includes(token)) {
            return true;
        }
    }
    // Check 2: Custom header (e.g., X-Secret-Token)
    const customHeader = req.headers[headerName.toLowerCase()];
    if (customHeader && validTokens.includes(customHeader.trim())) {
        return true;
    }
    // Check 3: Query parameter
    const queryToken = req.query.secret_token;
    if (queryToken && validTokens.includes(queryToken.trim())) {
        return true;
    }
    return false;
}
/**
 * Express middleware for secret token authentication
 */
function requireSecretToken(config) {
    return (req, res, next) => {
        if (validateSecretToken(req, config)) {
            // Token valid - continue
            next();
        }
        else {
            // Token invalid or missing
            res.status(401).json({
                jsonrpc: '2.0',
                error: {
                    code: -32001,
                    message: 'Unauthorized: Invalid or missing secret token'
                },
                id: null
            });
        }
    };
}
/**
 * Dual authentication middleware - tries OAuth2 first, then secret token
 * Useful for supporting multiple auth methods on the same endpoint
 */
function requireOAuth2OrSecretToken(oauthMiddleware, secretConfig) {
    return (req, res, next) => {
        // Check if secret token is valid
        if (validateSecretToken(req, secretConfig)) {
            // Secret token auth succeeded - skip OAuth
            return next();
        }
        // Fall back to OAuth2 middleware
        oauthMiddleware(req, res, next);
    };
}
