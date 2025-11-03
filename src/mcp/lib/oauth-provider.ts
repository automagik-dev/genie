/**
 * Genie OAuth Provider for MCP SDK
 *
 * Implements the OAuthTokenVerifier interface required by the official MCP SDK.
 * Uses our existing JWT verification logic from oauth2-utils.ts.
 */

import { OAuthTokenVerifier, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import { OAuthClientInformationFull, OAuthTokens, OAuthTokenRevocationRequest } from '@modelcontextprotocol/sdk/shared/auth.js';
import { Response } from 'express';

// OAuth2 config type (matches cli/src/lib/config-manager.ts)
export interface OAuth2Config {
  clientId: string;
  clientSecret: string;
  signingKey: string;
  publicKey: string;
  tokenExpiry: number;
  issuer: string;
  pin?: string; // Authorization PIN for OAuth consent page
}

// Dynamic import of OAuth2 utilities
let verifyAccessTokenFn: (token: string, publicKey: string, issuer: string, audience: string) => Promise<any>;
let generateAccessTokenFn: (privateKey: string, issuer: string, audience: string, clientId: string, expirySeconds: number) => Promise<string>;
let validateClientCredentialsFn: (providedClientId: string, providedClientSecret: string, storedClientId: string, storedClientSecret: string) => boolean;

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
export class GenieOAuthProvider implements OAuthServerProvider {
  constructor(
    private oauth2Config: OAuth2Config,
    private serverUrl: string
  ) {}

  /**
   * Get the clients store (we use a simple in-memory store with a single client)
   */
  get clientsStore(): OAuthRegisteredClientsStore {
    // Capture oauth2Config in closure to avoid 'this' scope issues
    const config = this.oauth2Config;

    return {
      async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
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
  async authorize(
    client: OAuthClientInformationFull,
    params: any,
    res: Response
  ): Promise<void> {
    // Client credentials flow doesn't use authorization endpoint
    res.status(400).json({
      error: 'unsupported_response_type',
      error_description: 'Only client_credentials grant type is supported'
    });
  }

  /**
   * Get code challenge for authorization code (not used for client credentials flow)
   */
  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    throw new Error('Authorization code flow not supported');
  }

  /**
   * Exchange authorization code for token (not used for client credentials flow)
   */
  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    codeVerifier?: string,
    redirectUri?: string,
    resource?: URL
  ): Promise<OAuthTokens> {
    throw new Error('Authorization code flow not supported');
  }

  /**
   * Exchange refresh token for access token (not supported yet)
   */
  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL
  ): Promise<OAuthTokens> {
    throw new Error('Refresh tokens not supported yet');
  }

  /**
   * Verify access token and return auth info
   *
   * This is the core method used by requireBearerAuth middleware.
   */
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const { verifyAccessTokenFn } = loadOAuth2Utils();

    // Verify JWT token using our existing logic
    const payload = await verifyAccessTokenFn(
      token,
      this.oauth2Config.publicKey,
      this.oauth2Config.issuer,
      `${this.serverUrl}/mcp`
    );

    if (!payload) {
      throw new Error('Invalid or expired token');
    }

    // Map JWT payload to SDK's AuthInfo interface
    return {
      token,
      clientId: payload.client_id as string,
      scopes: ((payload.scope as string) || '').split(' ').filter(Boolean),
      expiresAt: payload.exp as number,
      resource: new URL(payload.aud as string)
    };
  }

  /**
   * Revoke a token (optional - not implemented yet)
   */
  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest
  ): Promise<void> {
    // Token revocation not implemented yet
    // In production, would maintain a revocation list or use token introspection
  }

  /**
   * Generate access token for client credentials flow
   *
   * This method is called by the SDK's mcpAuthRouter when a client
   * requests a token via POST /oauth/token.
   */
  async generateClientCredentialsToken(
    clientId: string,
    clientSecret: string,
    scopes?: string[]
  ): Promise<string> {
    const { generateAccessTokenFn, validateClientCredentialsFn } = loadOAuth2Utils();

    // Validate client credentials
    const isValid = validateClientCredentialsFn(
      clientId,
      clientSecret,
      this.oauth2Config.clientId,
      this.oauth2Config.clientSecret
    );

    if (!isValid) {
      throw new Error('Invalid client credentials');
    }

    // Generate JWT access token
    const token = await generateAccessTokenFn(
      this.oauth2Config.signingKey,
      this.oauth2Config.issuer,
      `${this.serverUrl}/mcp`,
      clientId,
      this.oauth2Config.tokenExpiry || 3600
    );

    return token;
  }
}
