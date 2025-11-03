/**
 * Authentication Middleware for Genie MCP Server
 *
 * OAuth2.1 JWT token validation (RFC 6749, RFC 9728)
 * - Validates JWT access tokens with RS256 signatures
 * - Checks issuer, audience, and expiration
 * - Returns 401 Unauthorized with WWW-Authenticate header per RFC 6750
 *
 * Public endpoints (no auth required):
 * - /health - Health check
 * - /.well-known/oauth-protected-resource - Resource metadata
 * - /oauth/token - Token endpoint
 */

import { IncomingMessage, ServerResponse } from 'http';

// OAuth2 configuration (matches cli/src/lib/config-manager.ts)
export interface OAuth2Config {
  clientId: string;
  clientSecret: string;
  signingKey: string;
  publicKey: string;
  tokenExpiry: number;
  issuer: string;
}

// Import verification function at runtime (dynamic to avoid TypeScript cross-project issues)
let verifyAccessToken: (token: string, publicKey: string, issuer: string, audience: string) => Promise<any>;

// Initialize the verification function lazily
function getVerifyAccessToken() {
  if (!verifyAccessToken) {
    const oauth2Utils = require('../../cli/lib/oauth2-utils.js');
    verifyAccessToken = oauth2Utils.verifyAccessToken;
  }
  return verifyAccessToken;
}

interface AuthMiddlewareOptions {
  oauth2Config: OAuth2Config;
  serverUrl: string; // Server URL for JWT audience validation (e.g., 'http://localhost:8885')
  publicPaths?: string[];
}

/**
 * Create OAuth2 authentication middleware
 * Validates JWT Bearer tokens on all requests except public paths
 */
export function createAuthMiddleware(options: AuthMiddlewareOptions) {
  const {
    oauth2Config,
    serverUrl,
    publicPaths = ['/health', '/.well-known/oauth-protected-resource', '/oauth/token']
  } = options;

  return async function authMiddleware(
    req: IncomingMessage,
    res: ServerResponse,
    next?: () => void
  ): Promise<void> {
    // Check if path is public (no auth required)
    const pathname = req.url?.split('?')[0] || '';
    if (publicPaths.includes(pathname)) {
      if (next) next();
      return;
    }

    // Extract Authorization header
    const authHeader = req.headers.authorization;

    // Check if Authorization header exists
    if (!authHeader) {
      res.writeHead(401, {
        'Content-Type': 'application/json',
        'WWW-Authenticate': `Bearer realm="Genie MCP Server", error="invalid_token", error_description="Missing Authorization header"`
      });
      res.end(JSON.stringify({ error: 'Unauthorized: Missing Authorization header' }));
      return;
    }

    // Check if it's a Bearer token
    if (!authHeader.startsWith('Bearer ')) {
      res.writeHead(401, {
        'Content-Type': 'application/json',
        'WWW-Authenticate': `Bearer realm="Genie MCP Server", error="invalid_token", error_description="Invalid Authorization scheme (must be Bearer)"`
      });
      res.end(JSON.stringify({ error: 'Unauthorized: Invalid Authorization scheme' }));
      return;
    }

    // Extract JWT token
    const token = authHeader.slice(7); // Remove 'Bearer ' prefix

    // Verify JWT token
    try {
      const verify = getVerifyAccessToken();
      const payload = await verify(
        token,
        oauth2Config.publicKey,
        oauth2Config.issuer,
        `${serverUrl}/mcp` // Expected audience
      );

      if (!payload) {
        // Token verification failed
        res.writeHead(401, {
          'Content-Type': 'application/json',
          'WWW-Authenticate': `Bearer realm="Genie MCP Server", error="invalid_token", error_description="Token validation failed"`
        });
        res.end(JSON.stringify({ error: 'Unauthorized: Invalid token' }));
        return;
      }

      // Token is valid, proceed
      if (next) next();
    } catch (error) {
      // Token verification threw an error
      res.writeHead(401, {
        'Content-Type': 'application/json',
        'WWW-Authenticate': `Bearer realm="Genie MCP Server", error="invalid_token", error_description="Token verification error"`
      });
      res.end(JSON.stringify({ error: 'Unauthorized: Token verification error' }));
    }
  };
}

/**
 * Validate HTTP request authentication
 * Returns true if auth is valid, false otherwise
 * Automatically sends 401 response if auth fails
 */
export async function validateHttpAuth(
  req: IncomingMessage,
  res: ServerResponse,
  oauth2Config: OAuth2Config,
  serverUrl: string,
  publicPaths: string[] = ['/health', '/.well-known/oauth-protected-resource', '/oauth/token']
): Promise<boolean> {
  const pathname = req.url?.split('?')[0] || '';

  // Public paths bypass auth
  if (publicPaths.includes(pathname)) {
    return true;
  }

  // Extract Authorization header
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.writeHead(401, {
      'Content-Type': 'application/json',
      'WWW-Authenticate': `Bearer realm="Genie MCP Server", error="invalid_token", error_description="Missing or invalid Authorization header"`
    });
    res.end(JSON.stringify({ error: 'Unauthorized: Missing or invalid Authorization header' }));
    return false;
  }

  const token = authHeader.slice(7);

  // Verify JWT token
  try {
    const verify = getVerifyAccessToken();
    const payload = await verify(
      token,
      oauth2Config.publicKey,
      oauth2Config.issuer,
      `${serverUrl}/mcp`
    );

    if (!payload) {
      res.writeHead(401, {
        'Content-Type': 'application/json',
        'WWW-Authenticate': `Bearer realm="Genie MCP Server", error="invalid_token", error_description="Token validation failed"`
      });
      res.end(JSON.stringify({ error: 'Unauthorized: Invalid token' }));
      return false;
    }

    return true;
  } catch (error) {
    res.writeHead(401, {
      'Content-Type': 'application/json',
      'WWW-Authenticate': `Bearer realm="Genie MCP Server", error="invalid_token", error_description="Token verification error"`
    });
    res.end(JSON.stringify({ error: 'Unauthorized: Token verification error' }));
    return false;
  }
}
