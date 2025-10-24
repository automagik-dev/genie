"use strict";
/**
 * OAuth2.1 Utilities for MCP Server
 * JWT token validation and utility functions
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyAccessToken = verifyAccessToken;
exports.validateClientCredentials = validateClientCredentials;
exports.isJWT = isJWT;
exports.generateAccessToken = generateAccessToken;
const crypto_1 = __importDefault(require("crypto"));
const jose = __importStar(require("jose"));
/**
 * Verify and decode JWT access token
 *
 * @param token - JWT access token to verify
 * @param publicKeyPem - Public key in PEM format for verification
 * @param issuer - Expected token issuer
 * @param audience - Expected token audience
 * @returns Decoded token payload if valid, null otherwise
 */
async function verifyAccessToken(token, publicKeyPem, issuer, audience) {
    try {
        const publicKey = await jose.importSPKI(publicKeyPem, 'RS256');
        const { payload } = await jose.jwtVerify(token, publicKey, {
            issuer,
            audience,
        });
        return payload;
    }
    catch (error) {
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
function validateClientCredentials(providedClientId, providedClientSecret, storedClientId, storedClientSecret) {
    try {
        // Use constant-time comparison to prevent timing attacks
        const clientIdMatch = providedClientId.length === storedClientId.length &&
            crypto_1.default.timingSafeEqual(Buffer.from(providedClientId), Buffer.from(storedClientId));
        const clientSecretMatch = providedClientSecret.length === storedClientSecret.length &&
            crypto_1.default.timingSafeEqual(Buffer.from(providedClientSecret), Buffer.from(storedClientSecret));
        return clientIdMatch && clientSecretMatch;
    }
    catch {
        return false;
    }
}
/**
 * Check if a string is a JWT token (simple format check)
 */
function isJWT(token) {
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
async function generateAccessToken(privateKeyPem, issuer, audience, clientId, expirySeconds = 3600) {
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
        .setJti(crypto_1.default.randomUUID()) // Unique token ID
        .sign(privateKey);
    return jwt;
}
