"use strict";
/**
 * Authentication Token Generation for Genie MCP Server
 *
 * Generates and validates Bearer tokens in the format: genie_<48 hex chars>
 * This provides 192 bits of entropy, suitable for ChatGPT homologation
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateToken = generateToken;
exports.isValidTokenFormat = isValidTokenFormat;
exports.validateToken = validateToken;
exports.extractBearerToken = extractBearerToken;
const crypto_1 = __importDefault(require("crypto"));
const TOKEN_PREFIX = 'genie_';
const TOKEN_BYTES = 24; // 24 bytes = 48 hex chars = 192 bits
/**
 * Generate a new authentication token
 * Format: genie_<48 random hex characters>
 */
function generateToken() {
    const randomBytes = crypto_1.default.randomBytes(TOKEN_BYTES);
    const hexString = randomBytes.toString('hex');
    return `${TOKEN_PREFIX}${hexString}`;
}
/**
 * Validate token format
 * Returns true if token matches genie_<48 hex chars> pattern
 */
function isValidTokenFormat(token) {
    const pattern = /^genie_[0-9a-f]{48}$/i;
    return pattern.test(token);
}
/**
 * Validate token value
 * Checks both format and compares against stored token
 */
function validateToken(token, storedToken) {
    // First check format
    if (!isValidTokenFormat(token)) {
        return false;
    }
    // Then compare values (constant-time comparison to prevent timing attacks)
    return crypto_1.default.timingSafeEqual(Buffer.from(token), Buffer.from(storedToken));
}
/**
 * Extract token from Authorization header
 * Returns token if valid Bearer header, null otherwise
 */
function extractBearerToken(authHeader) {
    if (!authHeader) {
        return null;
    }
    if (!authHeader.startsWith('Bearer ')) {
        return null;
    }
    return authHeader.slice(7); // Remove 'Bearer ' prefix
}
