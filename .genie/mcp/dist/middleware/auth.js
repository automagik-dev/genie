"use strict";
/**
 * Authentication Middleware for Genie MCP Server
 *
 * Validates Bearer token authentication on all HTTP requests
 * Allows /health endpoint without authentication (for monitoring)
 * Returns 401 Unauthorized for missing or invalid tokens
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAuthMiddleware = createAuthMiddleware;
exports.attachAuthMiddleware = attachAuthMiddleware;
exports.validateHttpAuth = validateHttpAuth;
/**
 * Create authentication middleware
 * Validates Bearer token on all requests except public paths
 */
function createAuthMiddleware(options) {
    const { storedToken, publicPaths = ['/health'] } = options;
    return function authMiddleware(req, res, next) {
        // Check if path is public (no auth required)
        const pathname = req.url?.split('?')[0] || '';
        if (publicPaths.includes(pathname)) {
            if (next)
                next();
            return;
        }
        // Extract Authorization header
        const authHeader = req.headers.authorization;
        // Check if Authorization header exists
        if (!authHeader) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unauthorized: Missing Authorization header' }));
            return;
        }
        // Check if it's a Bearer token
        if (!authHeader.startsWith('Bearer ')) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unauthorized: Invalid Authorization scheme' }));
            return;
        }
        // Extract token
        const token = authHeader.slice(7);
        // Validate token using constant-time comparison
        let isValid = false;
        try {
            if (token.length === storedToken.length) {
                // Use crypto module for constant-time comparison
                const crypto = require('crypto');
                isValid = crypto.timingSafeEqual(Buffer.from(token), Buffer.from(storedToken));
            }
        }
        catch {
            // timingSafeEqual throws if lengths don't match
            isValid = false;
        }
        if (!isValid) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unauthorized: Invalid token' }));
            return;
        }
        // Token is valid, proceed
        if (next)
            next();
    };
}
/**
 * Attach auth middleware to Express-like router/app
 */
function attachAuthMiddleware(app, options) {
    const middleware = createAuthMiddleware(options);
    // For Express-like apps
    if (app.use && typeof app.use === 'function') {
        app.use((req, res, next) => {
            middleware(req, res, next);
        });
    }
}
/**
 * Create a simple HTTP request handler that validates auth
 * Returns true if auth is valid, false otherwise
 * Automatically sends 401 response if auth fails
 */
function validateHttpAuth(req, res, storedToken, publicPaths = ['/health']) {
    const pathname = req.url?.split('?')[0] || '';
    // Public paths bypass auth
    if (publicPaths.includes(pathname)) {
        return true;
    }
    // Extract and validate token
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized: Missing or invalid Authorization header' }));
        return false;
    }
    const token = authHeader.slice(7);
    // Constant-time comparison
    let isValid = false;
    try {
        if (token.length === storedToken.length) {
            const crypto = require('crypto');
            isValid = crypto.timingSafeEqual(Buffer.from(token), Buffer.from(storedToken));
        }
    }
    catch {
        isValid = false;
    }
    if (!isValid) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized: Invalid token' }));
        return false;
    }
    return true;
}
