/**
 * OAuth2.1 Utilities for MCP Server
 * JWT token validation and utility functions
 */

import crypto from 'crypto';
import * as jose from 'jose';

/**
 * Verify and decode JWT access token
 *
 * @param token - JWT access token to verify
 * @param publicKeyPem - Public key in PEM format for verification
 * @param issuer - Expected token issuer
 * @param audience - Expected token audience
 * @returns Decoded token payload if valid, null otherwise
 */
export async function verifyAccessToken(
  token: string,
  publicKeyPem: string,
  issuer: string,
  audience: string
): Promise<jose.JWTPayload | null> {
  try {
    const publicKey = await jose.importSPKI(publicKeyPem, 'RS256');

    const { payload } = await jose.jwtVerify(token, publicKey, {
      issuer,
      audience,
    });

    return payload;
  } catch (error) {
    // Token verification failed (expired, invalid signature, etc.)
    return null;
  }
}

/**
 * Validate client credentials (constant-time comparison)
 *
 * @param providedClientId - Client ID from request
 * @param providedClientSecret - Client secret from request
 * @param storedClientId - Stored client ID
 * @param storedClientSecret - Stored client secret
 * @returns True if credentials match
 */
export function validateClientCredentials(
  providedClientId: string,
  providedClientSecret: string,
  storedClientId: string,
  storedClientSecret: string
): boolean {
  try {
    // Use constant-time comparison to prevent timing attacks
    const clientIdMatch =
      providedClientId.length === storedClientId.length &&
      crypto.timingSafeEqual(Buffer.from(providedClientId), Buffer.from(storedClientId));

    const clientSecretMatch =
      providedClientSecret.length === storedClientSecret.length &&
      crypto.timingSafeEqual(Buffer.from(providedClientSecret), Buffer.from(storedClientSecret));

    return clientIdMatch && clientSecretMatch;
  } catch {
    return false;
  }
}

/**
 * Check if a string is a JWT token (simple format check)
 */
export function isJWT(token: string): boolean {
  // JWT format: header.payload.signature (3 base64url-encoded parts)
  const parts = token.split('.');
  return parts.length === 3 && parts.every((part) => part.length > 0);
}

/**
 * Generate JWT access token for OAuth2.1 client credentials flow
 *
 * @param privateKeyPem - Private key in PEM format for signing
 * @param issuer - Token issuer (e.g., 'genie-mcp-server')
 * @param audience - Token audience (resource identifier)
 * @param clientId - OAuth2 client identifier
 * @param expirySeconds - Token expiry in seconds (default: 3600)
 * @returns Signed JWT access token
 */
export async function generateAccessToken(
  privateKeyPem: string,
  issuer: string,
  audience: string,
  clientId: string,
  expirySeconds: number = 3600
): Promise<string> {
  const privateKey = await jose.importPKCS8(privateKeyPem, 'RS256');

  const jwt = await new jose.SignJWT({
    client_id: clientId,
    scope: 'mcp:read mcp:write', // Default scopes for MCP access
  })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(clientId)
    .setIssuedAt()
    .setExpirationTime(`${expirySeconds}s`)
    .setJti(crypto.randomUUID()) // Unique token ID
    .sign(privateKey);

  return jwt;
}
