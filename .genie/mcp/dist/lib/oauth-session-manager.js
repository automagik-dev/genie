"use strict";
/**
 * OAuth Session Manager
 *
 * Manages authorization requests and codes for OAuth 2.0 Authorization Code flow with PKCE.
 * Uses in-memory storage (sessions don't persist across restarts).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.oauthSessionManager = exports.OAuthSessionManager = void 0;
const crypto_1 = require("crypto");
const crypto_2 = require("crypto");
/**
 * OAuth Session Manager
 */
class OAuthSessionManager {
    constructor() {
        this.authRequests = new Map();
        this.authCodes = new Map();
        // Authorization code expiry (5 minutes)
        this.CODE_EXPIRY_MS = 5 * 60 * 1000;
    }
    /**
     * Store authorization request (pending user consent)
     */
    storeAuthorizationRequest(requestId, request) {
        this.authRequests.set(requestId, request);
    }
    /**
     * Get authorization request by ID
     */
    getAuthorizationRequest(requestId) {
        return this.authRequests.get(requestId) || null;
    }
    /**
     * Remove authorization request after processing
     */
    removeAuthorizationRequest(requestId) {
        this.authRequests.delete(requestId);
    }
    /**
     * Generate authorization code after user consent
     */
    generateAuthorizationCode(request) {
        const code = (0, crypto_1.randomUUID)();
        const now = Date.now();
        const authCode = {
            code,
            client_id: request.client_id,
            redirect_uri: request.redirect_uri,
            scope: request.scope,
            code_challenge: request.code_challenge,
            code_challenge_method: request.code_challenge_method,
            used: false,
            expires_at: now + this.CODE_EXPIRY_MS,
            created_at: now,
        };
        this.authCodes.set(code, authCode);
        return code;
    }
    /**
     * Get authorization code
     */
    getAuthorizationCode(code) {
        return this.authCodes.get(code) || null;
    }
    /**
     * Validate and consume authorization code
     * Returns the code data if valid, null if invalid/expired/used
     */
    validateAndConsumeCode(code, clientId, redirectUri, codeVerifier) {
        const authCode = this.authCodes.get(code);
        if (!authCode) {
            return null; // Code doesn't exist
        }
        // Check if already used
        if (authCode.used) {
            return null; // Code already consumed
        }
        // Check expiry
        if (Date.now() > authCode.expires_at) {
            this.authCodes.delete(code);
            return null; // Code expired
        }
        // Verify client_id
        if (authCode.client_id !== clientId) {
            return null; // Client mismatch
        }
        // Verify redirect_uri
        if (authCode.redirect_uri !== redirectUri) {
            return null; // Redirect URI mismatch
        }
        // Validate PKCE
        if (!this.validatePKCE(codeVerifier, authCode.code_challenge)) {
            return null; // PKCE validation failed
        }
        // Mark as used
        authCode.used = true;
        this.authCodes.set(code, authCode);
        return authCode;
    }
    /**
     * Validate PKCE code_verifier against code_challenge
     * code_challenge = BASE64URL(SHA256(code_verifier))
     */
    validatePKCE(codeVerifier, codeChallenge) {
        try {
            // Compute SHA256 hash of code_verifier
            const hash = (0, crypto_2.createHash)('sha256').update(codeVerifier).digest();
            // Base64url encode (RFC 7636 Section 4.2)
            const computedChallenge = hash
                .toString('base64')
                .replace(/\+/g, '-')
                .replace(/\//g, '_')
                .replace(/=/g, '');
            return computedChallenge === codeChallenge;
        }
        catch (err) {
            console.error('PKCE validation error:', err);
            return false;
        }
    }
    /**
     * Clean up expired codes (garbage collection)
     */
    cleanupExpiredCodes() {
        const now = Date.now();
        const expiredCodes = [];
        for (const [code, authCode] of this.authCodes.entries()) {
            if (now > authCode.expires_at) {
                expiredCodes.push(code);
            }
        }
        for (const code of expiredCodes) {
            this.authCodes.delete(code);
        }
        if (expiredCodes.length > 0) {
            console.error(`🧹 Cleaned up ${expiredCodes.length} expired authorization codes`);
        }
    }
    /**
     * Get statistics (for monitoring)
     */
    getStats() {
        let usedCount = 0;
        for (const authCode of this.authCodes.values()) {
            if (authCode.used) {
                usedCount++;
            }
        }
        return {
            pendingRequests: this.authRequests.size,
            activeCodes: this.authCodes.size - usedCount,
            usedCodes: usedCount,
        };
    }
}
exports.OAuthSessionManager = OAuthSessionManager;
// Global OAuth session manager instance
exports.oauthSessionManager = new OAuthSessionManager();
// Run cleanup every 5 minutes
setInterval(() => {
    exports.oauthSessionManager.cleanupExpiredCodes();
}, 5 * 60 * 1000);
