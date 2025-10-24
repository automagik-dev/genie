/**
 * OAuth2 Type Definitions for MCP Server
 * Shared types without importing from CLI module
 */

export interface OAuth2Config {
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  signingKey: string; // Private key for signing JWTs (PEM format)
  publicKey: string;  // Public key for verification (PEM format)
  tokenExpiry: number; // Token expiry in seconds (default: 3600)
  issuer: string;      // Token issuer (e.g., 'genie-mcp-server')
}
