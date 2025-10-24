# OAuth2.1 Support for Genie MCP Server

## Overview

Genie MCP Server implements OAuth2.1 Resource Server capabilities to support Claude Desktop and other OAuth2-compatible clients. This enables secure, standards-based authentication using Client Credentials flow.

## Architecture

### Components

1. **Legacy Bearer Token Auth** - Simple token-based authentication (backward compatible)
2. **OAuth2 Client Credentials Flow** - RFC 6749 Section 4.4 compliant
3. **JWT Token Generation** - RS256 signed tokens (jose library)
4. **Protected Resource Metadata** - RFC 9728 compliant discovery endpoint
5. **Dual Token Validation** - Supports both legacy tokens and OAuth2 JWTs

### Endpoints

**`/.well-known/oauth-protected-resource`**
- RFC 9728 Protected Resource Metadata
- Advertises authorization server location
- Declares supported token formats and scopes
- Public endpoint (no authentication required)

**`/oauth/token`**
- OAuth2 token endpoint for client_credentials grant
- Accepts client credentials via HTTP Basic Auth or request body
- Returns signed JWT access tokens
- Public endpoint (validates client credentials)

### Token Flow

```
Client                          Genie MCP Server
  |                                    |
  |  POST /oauth/token                 |
  |  grant_type=client_credentials     |
  |  (+ client credentials)            |
  |-------------------------------->   |
  |                                    |
  |  200 OK                            |
  |  {                                 |
  |    access_token: "<JWT>",          |
  |    token_type: "Bearer",           |
  |    expires_in: 3600                |
  |  }                                 |
  |<--------------------------------   |
  |                                    |
  |  Authorization: Bearer <JWT>       |
  |  (subsequent MCP requests)         |
  |-------------------------------->   |
  |                                    |
  |  200 OK + MCP response             |
  |<--------------------------------   |
```

## Configuration

### Enable OAuth2

Edit `~/.genie/config.yaml`:

```yaml
mcp:
  auth:
    token: genie_<legacy_token>
    created: "2025-10-24T00:00:00.000Z"
    oauth2:
      enabled: true
      clientId: genie_client_<32_hex_chars>
      clientSecret: genie_secret_<48_hex_chars>
      signingKey: |
        -----BEGIN PRIVATE KEY-----
        <RSA private key in PEM format>
        -----END PRIVATE KEY-----
      publicKey: |
        -----BEGIN PUBLIC KEY-----
        <RSA public key in PEM format>
        -----END PUBLIC KEY-----
      tokenExpiry: 3600  # seconds (1 hour)
      issuer: genie-mcp-server
  server:
    port: 8885
    transport: httpStream
```

### Generate OAuth2 Credentials

Using the CLI (recommended):

```bash
# This will be added to the setup wizard
genie init --enable-oauth2
```

Programmatically:

```typescript
import { createDefaultConfigAsync, saveConfig } from './lib/config-manager.js';

// Generate config with OAuth2 support
const config = await createDefaultConfigAsync(undefined, true);

// Save to ~/.genie/config.yaml
saveConfig(config);

// Display client credentials for Claude Desktop configuration
console.log('Client ID:', config.mcp.auth.oauth2.clientId);
console.log('Client Secret:', config.mcp.auth.oauth2.clientSecret);
```

## Claude Desktop Integration

### Step 1: Get Server Metadata

```bash
curl http://localhost:8885/.well-known/oauth-protected-resource
```

Response:
```json
{
  "resource": "http://localhost:8885/mcp",
  "authorization_servers": ["http://localhost:8885"],
  "bearer_methods_supported": ["header"],
  "scopes_supported": ["mcp:read", "mcp:write"],
  "resource_signing_alg_values_supported": ["RS256"]
}
```

### Step 2: Configure Claude Desktop

Add to Claude Desktop settings (Settings > Connectors > Add Custom Connector):

- **Server URL**: `http://localhost:8885/mcp`
- **OAuth Client ID**: `genie_client_<your_id>` (from config.yaml)
- **OAuth Client Secret**: `genie_secret_<your_secret>` (from config.yaml)
- **Token Endpoint**: `http://localhost:8885/oauth/token`

### Step 3: Test Authentication

```bash
# Request token
curl -X POST http://localhost:8885/oauth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -u "genie_client_<id>:genie_secret_<secret>" \
  -d "grant_type=client_credentials"

# Use token
curl -H "Authorization: Bearer <jwt_token>" \
  http://localhost:8885/mcp
```

## Token Format

### JWT Claims

```json
{
  "iss": "genie-mcp-server",       // Issuer
  "aud": "http://localhost:8885/mcp", // Audience (resource identifier)
  "sub": "genie_client_<id>",      // Subject (client_id)
  "iat": 1729728000,               // Issued at (Unix timestamp)
  "exp": 1729731600,               // Expiration (Unix timestamp)
  "jti": "<uuid>",                 // Unique token ID
  "client_id": "genie_client_<id>", // OAuth2 client identifier
  "scope": "mcp:read mcp:write"    // Granted scopes
}
```

### Signature

- **Algorithm**: RS256 (RSA with SHA-256)
- **Key Size**: 2048 bits
- **Format**: JWT (header.payload.signature)

## Security Considerations

### Token Storage

- **Private Key**: Stored in `~/.genie/config.yaml` with 0600 permissions
- **Client Secret**: Stored in `~/.genie/config.yaml` with 0600 permissions
- **Access Tokens**: Short-lived (1 hour), not stored server-side

### Validation

- **Signature Verification**: All JWT tokens verified using RS256 public key
- **Expiration Check**: Expired tokens rejected with 401 Unauthorized
- **Audience Validation**: Token audience must match resource identifier
- **Issuer Validation**: Token issuer must match configured issuer

### Backward Compatibility

- **Legacy Tokens**: Continue to work alongside OAuth2 JWTs
- **Detection**: Server automatically detects JWT vs legacy token format
- **Migration**: No breaking changes for existing integrations

## Error Handling

### OAuth2 Errors (RFC 6749 Section 5.2)

**invalid_client** (401):
```json
{
  "error": "invalid_client",
  "error_description": "Client authentication failed: invalid credentials"
}
```

**unsupported_grant_type** (400):
```json
{
  "error": "unsupported_grant_type",
  "error_description": "Only client_credentials grant type is supported"
}
```

**invalid_token** (401):
```json
{
  "error": "Unauthorized: Invalid token"
}
```

### WWW-Authenticate Header

OAuth2-enabled servers include RFC 6750 compliant error headers:

```
WWW-Authenticate: Bearer realm="Genie MCP Server",
                  error="invalid_token",
                  error_description="Token validation failed"
```

## Compliance

- **OAuth 2.1**: Draft specification (client_credentials flow)
- **RFC 6749**: OAuth 2.0 Authorization Framework
- **RFC 6750**: OAuth 2.0 Bearer Token Usage
- **RFC 7519**: JSON Web Token (JWT)
- **RFC 9068**: JWT Profile for OAuth 2.0 Access Tokens
- **RFC 9728**: OAuth 2.0 Protected Resource Metadata
- **MCP Specification**: Model Context Protocol authorization requirements

## Limitations

### Current Implementation

- **Grant Types**: Only `client_credentials` supported (machine-to-machine auth)
- **Scopes**: Fixed scopes (`mcp:read mcp:write`), no granular permissions
- **Token Refresh**: No refresh tokens (access tokens are short-lived)
- **Revocation**: No token revocation endpoint (wait for expiry)
- **Dynamic Client Registration**: Not implemented (manual configuration)

### Future Enhancements

- [ ] Token introspection endpoint (RFC 7662)
- [ ] Token revocation endpoint (RFC 7009)
- [ ] Dynamic Client Registration (RFC 7591)
- [ ] Granular scope-based permissions
- [ ] Authorization Code flow (for user delegation)
- [ ] PKCE support (RFC 7636)

## Troubleshooting

### "OAuth2 not enabled" error

Check `~/.genie/config.yaml` has `mcp.auth.oauth2.enabled: true`

### "Invalid token" with valid JWT

1. Check token expiration: `jwt.io` decoder
2. Verify audience matches resource URL
3. Confirm issuer matches config (`genie-mcp-server`)
4. Check server logs for signature verification errors

### Claude Desktop connection fails

1. Verify server is running: `curl http://localhost:8885/health`
2. Test token endpoint: `curl -X POST http://localhost:8885/oauth/token ...`
3. Check client credentials match config.yaml
4. Review Claude Desktop error logs

### Token validation performance

- RS256 verification is ~0.5ms per request
- Consider connection pooling and token reuse
- Tokens valid for 1 hour (reduce auth overhead)

## Example: Complete Setup

```bash
# 1. Install Genie with OAuth2 support
npm install -g automagik-genie@next

# 2. Initialize with OAuth2
genie init --enable-oauth2

# 3. Start MCP server
MCP_TRANSPORT=httpStream genie mcp

# 4. Get credentials
cat ~/.genie/config.yaml | grep -A 2 "oauth2:"

# 5. Configure Claude Desktop with client_id and client_secret

# 6. Test connection from Claude
# (Claude Desktop will automatically request token and use it)
```

## Related

- [MCP Server Setup](./mcp-interface.md)
- [Authentication Middleware](../../mcp/src/middleware/auth.ts)
- [OAuth2 Endpoints](../../mcp/src/lib/oauth2-endpoints.ts)
- [OAuth2 Utilities](../../cli/src/lib/oauth2-utils.ts)
