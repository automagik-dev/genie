/**
 * Authentication Token Generation for Genie MCP Server
 *
 * Generates and validates Bearer tokens in the format: genie_<48 hex chars>
 * This provides 192 bits of entropy, suitable for ChatGPT homologation
 */

import crypto from 'crypto';

const TOKEN_PREFIX = 'genie_';
const TOKEN_BYTES = 24; // 24 bytes = 48 hex chars = 192 bits

/**
 * Generate a new authentication token
 * Format: genie_<48 random hex characters>
 */
export function generateToken(): string {
  const randomBytes = crypto.randomBytes(TOKEN_BYTES);
  const hexString = randomBytes.toString('hex');
  return `${TOKEN_PREFIX}${hexString}`;
}

/**
 * Validate token format
 * Returns true if token matches genie_<48 hex chars> pattern
 */
export function isValidTokenFormat(token: string): boolean {
  const pattern = /^genie_[0-9a-f]{48}$/i;
  return pattern.test(token);
}

/**
 * Validate token value
 * Checks both format and compares against stored token
 */
export function validateToken(token: string, storedToken: string): boolean {
  // First check format
  if (!isValidTokenFormat(token)) {
    return false;
  }

  // Then compare values (constant-time comparison to prevent timing attacks)
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(storedToken));
}

/**
 * Extract token from Authorization header
 * Returns token if valid Bearer header, null otherwise
 */
export function extractBearerToken(authHeader?: string): string | null {
  if (!authHeader) {
    return null;
  }

  if (!authHeader.startsWith('Bearer ')) {
    return null;
  }

  return authHeader.slice(7); // Remove 'Bearer ' prefix
}
