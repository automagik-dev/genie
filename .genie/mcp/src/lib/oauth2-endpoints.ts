/**
 * OAuth2.1 Endpoints for Genie MCP Server
 *
 * Implements:
 * - /.well-known/oauth-protected-resource (RFC 9728)
 * - /oauth/token (client_credentials flow)
 *
 * Note: We implement our own token endpoint because the MCP SDK doesn't support
 * client_credentials grant type yet (it only supports authorization_code and refresh_token).
 */

import { Request, Response } from 'express';
import { OAuth2Config } from './oauth-provider.js';

// Dynamic import of OAuth2 utilities
let generateAccessTokenFn: (privateKey: string, issuer: string, audience: string, clientId: string, expirySeconds: number) => Promise<string>;
let validateClientCredentialsFn: (providedClientId: string, providedClientSecret: string, storedClientId: string, storedClientSecret: string) => boolean;

function loadOAuth2Utils() {
  if (!generateAccessTokenFn) {
    const oauth2Utils = require('../../../cli/dist/lib/oauth2-utils.js');
    generateAccessTokenFn = oauth2Utils.generateAccessToken;
    validateClientCredentialsFn = oauth2Utils.validateClientCredentials;
  }
  return { generateAccessTokenFn, validateClientCredentialsFn };
}

/**
 * OAuth2.1 Protected Resource Metadata (RFC 9728)
 * Advertises authorization server and token requirements
 */
export interface ProtectedResourceMetadata {
  resource: string; // Resource identifier URL
  authorization_servers: string[]; // Authorization servers that can issue tokens
  bearer_methods_supported: string[]; // Supported token presentation methods
  resource_documentation?: string; // Optional documentation URL
  scopes_supported?: string[]; // Supported scopes
  resource_signing_alg_values_supported?: string[]; // Supported signing algorithms
}

/**
 * Generate protected resource metadata
 *
 * @param serverUrl - Base URL of the MCP server (e.g., 'http://localhost:8885')
 * @returns RFC 9728 compliant metadata
 */
export function generateResourceMetadata(serverUrl: string): ProtectedResourceMetadata {
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
export function handleProtectedResourceMetadata(
  req: Request,
  res: Response,
  serverUrl: string
): void {
  const metadata = generateResourceMetadata(serverUrl);

  res.status(200)
    .set('Cache-Control', 'public, max-age=3600') // Cache for 1 hour
    .json(metadata);
}

/**
 * OAuth2.1 Token Response (RFC 6749 Section 5.1)
 */
interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  scope?: string;
}

/**
 * OAuth2.1 Error Response (RFC 6749 Section 5.2)
 */
interface TokenErrorResponse {
  error: string;
  error_description?: string;
  error_uri?: string;
}

/**
 * Parse Basic authentication header
 * Returns { username, password } or null if invalid
 */
function parseBasicAuth(authHeader: string | undefined): { username: string; password: string } | null {
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
  } catch {
    return null;
  }
}

// parseFormBody removed - Express handles body parsing via express.json() and express.urlencoded()

/**
 * Handle /oauth/token endpoint (client_credentials flow)
 * Implements RFC 6749 Section 4.4
 *
 * Express middleware - body is already parsed by express.json() / express.urlencoded()
 */
export async function handleTokenEndpoint(
  req: Request,
  res: Response,
  oauth2Config: OAuth2Config,
  serverUrl: string
): Promise<void> {
  const { generateAccessTokenFn, validateClientCredentialsFn } = loadOAuth2Utils();

  // Parse client credentials from Authorization header OR request body
  let clientId: string | null = null;
  let clientSecret: string | null = null;

  // Try Authorization header first (RFC 6749 Section 2.3.1)
  const basicAuth = parseBasicAuth(req.headers.authorization);
  if (basicAuth) {
    clientId = basicAuth.username;
    clientSecret = basicAuth.password;
  } else {
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
      } as TokenErrorResponse);
    return;
  }

  // Verify client credentials against config
  const validCredentials = validateClientCredentialsFn(
    clientId,
    clientSecret,
    oauth2Config.clientId,
    oauth2Config.clientSecret
  );

  if (!validCredentials) {
    res.status(401)
      .set('WWW-Authenticate', 'Basic realm="Genie MCP Server"')
      .json({
        error: 'invalid_client',
        error_description: 'Client authentication failed: invalid credentials',
      } as TokenErrorResponse);
    return;
  }

  // Validate grant_type
  if (req.body.grant_type !== 'client_credentials') {
    res.status(400).json({
      error: 'unsupported_grant_type',
      error_description: 'Only client_credentials grant type is supported',
    } as TokenErrorResponse);
    return;
  }

  try {
    // Generate JWT access token
    const accessToken = await generateAccessTokenFn(
      oauth2Config.signingKey,
      oauth2Config.issuer,
      `${serverUrl}/mcp`, // Audience = resource identifier
      clientId,
      oauth2Config.tokenExpiry
    );

    const tokenResponse: TokenResponse = {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: oauth2Config.tokenExpiry,
      scope: 'mcp:read mcp:write',
    };

    res.status(200)
      .set('Cache-Control', 'no-store')
      .set('Pragma', 'no-cache')
      .json(tokenResponse);
  } catch (error) {
    console.error('Token generation error:', error);
    res.status(500).json({
      error: 'server_error',
      error_description: 'Failed to generate access token',
    } as TokenErrorResponse);
  }
}
