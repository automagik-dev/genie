"use strict";
/**
 * WebSocket Manager - Centralized WebSocket connection manager for Forge streams
 *
 * Provides connection pooling, auto-reconnection, and error handling for WebSocket streams.
 * Enables real-time monitoring of Forge tasks, diffs, logs, and execution processes.
 *
 * Features:
 * - Connection pooling (reuse connections per stream URL)
 * - Auto-reconnect with exponential backoff
 * - Graceful error handling and cleanup
 * - TypeScript-first with full type safety
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.wsManager = exports.WebSocketManager = void 0;
const ws_1 = require("ws");
/**
 * WebSocket Manager for Forge stream connections
 */
class WebSocketManager {
    constructor() {
        this.subscriptions = new Map();
        this.connectionPool = new Map();
        this.nextSubscriptionId = 0;
    }
    /**
     * Subscribe to a WebSocket stream
     *
     * @param streamUrl WebSocket URL (e.g., ws://localhost:8887/api/tasks/stream/ws?project_id=xxx)
     * @param onMessage Callback for incoming messages
     * @param onError Optional error callback
     * @param maxReconnectAttempts Maximum reconnection attempts (default: 5)
     * @returns Subscription ID (use with unsubscribe)
     */
    subscribe(streamUrl, onMessage, onError, maxReconnectAttempts = 5) {
        const subscriptionId = `sub_${this.nextSubscriptionId++}`;
        // Check if we already have a connection for this URL
        let ws = this.connectionPool.get(streamUrl);
        if (!ws || ws.readyState === ws_1.WebSocket.CLOSED || ws.readyState === ws_1.WebSocket.CLOSING) {
            // Create new WebSocket connection
            ws = this.createConnection(streamUrl);
            this.connectionPool.set(streamUrl, ws);
        }
        // Create subscription
        const subscription = {
            id: subscriptionId,
            url: streamUrl,
            ws,
            onMessage,
            onError,
            reconnectAttempts: 0,
            maxReconnectAttempts,
            reconnectDelay: 1000, // Start with 1 second
            closed: false
        };
        this.subscriptions.set(subscriptionId, subscription);
        // Set up event handlers
        this.setupEventHandlers(subscription);
        return subscriptionId;
    }
    /**
     * Unsubscribe from a stream
     */
    unsubscribe(subscriptionId) {
        const subscription = this.subscriptions.get(subscriptionId);
        if (!subscription)
            return;
        subscription.closed = true;
        this.subscriptions.delete(subscriptionId);
        // Check if any other subscriptions are using this WebSocket
        const stillInUse = Array.from(this.subscriptions.values()).some(sub => sub.url === subscription.url && !sub.closed);
        if (!stillInUse) {
            // Close the WebSocket if no more subscriptions
            const ws = this.connectionPool.get(subscription.url);
            if (ws && ws.readyState === ws_1.WebSocket.OPEN) {
                ws.close();
            }
            this.connectionPool.delete(subscription.url);
        }
    }
    /**
     * Close all connections
     */
    close() {
        // Mark all subscriptions as closed
        this.subscriptions.forEach(sub => {
            sub.closed = true;
        });
        // Close all WebSocket connections
        this.connectionPool.forEach(ws => {
            if (ws.readyState === ws_1.WebSocket.OPEN) {
                ws.close();
            }
        });
        this.subscriptions.clear();
        this.connectionPool.clear();
    }
    /**
     * Create a new WebSocket connection
     */
    createConnection(url) {
        const ws = new ws_1.WebSocket(url, {
            headers: {
                'User-Agent': 'Genie-MCP/1.0'
            }
        });
        return ws;
    }
    /**
     * Set up event handlers for a subscription
     */
    setupEventHandlers(subscription) {
        const { ws, onMessage, onError } = subscription;
        ws.on('open', () => {
            // Reset reconnect attempts on successful connection
            subscription.reconnectAttempts = 0;
            subscription.reconnectDelay = 1000;
        });
        ws.on('message', (data) => {
            if (subscription.closed)
                return;
            try {
                const parsed = JSON.parse(data.toString());
                onMessage(parsed);
            }
            catch (error) {
                // If parsing fails, pass raw string
                onMessage(data.toString());
            }
        });
        ws.on('error', (error) => {
            if (subscription.closed)
                return;
            if (onError) {
                onError(error);
            }
        });
        ws.on('close', (code, reason) => {
            if (subscription.closed)
                return;
            // Attempt reconnection if not closed intentionally
            this.attemptReconnect(subscription);
        });
    }
    /**
     * Attempt to reconnect a subscription
     */
    attemptReconnect(subscription) {
        if (subscription.closed)
            return;
        if (subscription.reconnectAttempts >= subscription.maxReconnectAttempts) {
            // Max attempts reached
            if (subscription.onError) {
                subscription.onError(new Error(`Failed to reconnect after ${subscription.maxReconnectAttempts} attempts`));
            }
            subscription.closed = true;
            return;
        }
        subscription.reconnectAttempts++;
        // Exponential backoff
        const delay = subscription.reconnectDelay * Math.pow(2, subscription.reconnectAttempts - 1);
        setTimeout(() => {
            if (subscription.closed)
                return;
            // Create new connection
            const ws = this.createConnection(subscription.url);
            subscription.ws = ws;
            this.connectionPool.set(subscription.url, ws);
            // Set up handlers
            this.setupEventHandlers(subscription);
        }, delay);
    }
}
exports.WebSocketManager = WebSocketManager;
// Singleton instance
exports.wsManager = new WebSocketManager();
