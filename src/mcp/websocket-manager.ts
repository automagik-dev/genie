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

import { WebSocket } from 'ws';

/**
 * Subscription configuration
 */
interface Subscription {
  id: string;
  url: string;
  ws: WebSocket;
  onMessage: (data: any) => void;
  onError?: (error: Error) => void;
  reconnectAttempts: number;
  maxReconnectAttempts: number;
  reconnectDelay: number;
  closed: boolean;
}

/**
 * WebSocket Manager for Forge stream connections
 */
export class WebSocketManager {
  private subscriptions: Map<string, Subscription> = new Map();
  private connectionPool: Map<string, WebSocket> = new Map();
  private nextSubscriptionId = 0;

  /**
   * Subscribe to a WebSocket stream
   *
   * @param streamUrl WebSocket URL (e.g., ws://localhost:{FORGE_PORT}/api/tasks/stream/ws?project_id=xxx)
   * @param onMessage Callback for incoming messages
   * @param onError Optional error callback
   * @param maxReconnectAttempts Maximum reconnection attempts (default: 5)
   * @returns Subscription ID (use with unsubscribe)
   */
  subscribe(
    streamUrl: string,
    onMessage: (data: any) => void,
    onError?: (error: Error) => void,
    maxReconnectAttempts = 5
  ): string {
    const subscriptionId = `sub_${this.nextSubscriptionId++}`;

    // Check if we already have a connection for this URL
    let ws = this.connectionPool.get(streamUrl);

    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      // Create new WebSocket connection
      ws = this.createConnection(streamUrl);
      this.connectionPool.set(streamUrl, ws);
    }

    // Create subscription
    const subscription: Subscription = {
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
  unsubscribe(subscriptionId: string): void {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) return;

    subscription.closed = true;
    this.subscriptions.delete(subscriptionId);

    // Check if any other subscriptions are using this WebSocket
    const stillInUse = Array.from(this.subscriptions.values()).some(
      sub => sub.url === subscription.url && !sub.closed
    );

    if (!stillInUse) {
      // Close the WebSocket if no more subscriptions
      const ws = this.connectionPool.get(subscription.url);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
      this.connectionPool.delete(subscription.url);
    }
  }

  /**
   * Close all connections
   */
  close(): void {
    // Mark all subscriptions as closed
    this.subscriptions.forEach(sub => {
      sub.closed = true;
    });

    // Close all WebSocket connections
    this.connectionPool.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    });

    this.subscriptions.clear();
    this.connectionPool.clear();
  }

  /**
   * Create a new WebSocket connection
   */
  private createConnection(url: string): WebSocket {
    const ws = new WebSocket(url, {
      headers: {
        'User-Agent': 'Genie-MCP/1.0'
      }
    });

    return ws;
  }

  /**
   * Set up event handlers for a subscription
   */
  private setupEventHandlers(subscription: Subscription): void {
    const { ws, onMessage, onError } = subscription;

    ws.on('open', () => {
      // Reset reconnect attempts on successful connection
      subscription.reconnectAttempts = 0;
      subscription.reconnectDelay = 1000;
    });

    ws.on('message', (data: Buffer) => {
      if (subscription.closed) return;

      try {
        const parsed = JSON.parse(data.toString());
        onMessage(parsed);
      } catch (error) {
        // If parsing fails, pass raw string
        onMessage(data.toString());
      }
    });

    ws.on('error', (error: Error) => {
      if (subscription.closed) return;

      if (onError) {
        onError(error);
      }
    });

    ws.on('close', (code: number, reason: Buffer) => {
      if (subscription.closed) return;

      // Attempt reconnection if not closed intentionally
      this.attemptReconnect(subscription);
    });
  }

  /**
   * Attempt to reconnect a subscription
   */
  private attemptReconnect(subscription: Subscription): void {
    if (subscription.closed) return;

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
      if (subscription.closed) return;

      // Create new connection
      const ws = this.createConnection(subscription.url);
      subscription.ws = ws;
      this.connectionPool.set(subscription.url, ws);

      // Set up handlers
      this.setupEventHandlers(subscription);
    }, delay);
  }
}

// Singleton instance
export const wsManager = new WebSocketManager();
