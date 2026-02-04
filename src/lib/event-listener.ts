/**
 * Event Listener - Permission Request Subscription
 *
 * Subscribes to permission_request events from Claude Code logs (wish-21 event system)
 * and extracts tool name, parameters, pane-id for evaluation by the rule matcher.
 *
 * Usage:
 * 1. Subscribe to permission requests:
 *    const subscription = subscribeToPermissionRequests((request) => {
 *      // Handle the permission request
 *      queue.add(request);
 *    });
 *
 * 2. Process events from the event stream:
 *    subscription.processEvent(normalizedEvent);
 *
 * 3. Unsubscribe when done:
 *    subscription.unsubscribe();
 */

import type { NormalizedEvent } from '../term-commands/events.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Permission request extracted from a tool_call or permission_request event
 */
export interface PermissionRequest {
  /** Unique request ID (generated) */
  id: string;
  /** Tool name (Read, Write, Bash, etc.) */
  toolName: string;
  /** Tool input parameters (if available) */
  toolInput?: Record<string, unknown>;
  /** tmux pane ID (e.g., "%42") */
  paneId?: string;
  /** Associated wish slug (e.g., "wish-23") */
  wishId?: string;
  /** Claude session ID */
  sessionId: string;
  /** Working directory */
  cwd: string;
  /** ISO timestamp */
  timestamp: string;
  /** Tool call ID for correlation (if available) */
  toolCallId?: string;
}

/**
 * Event subscription handle
 */
export interface EventSubscription {
  /** Process a normalized event - extracts permission request if applicable */
  processEvent: (event: NormalizedEvent) => void;
  /** Unsubscribe and stop processing events */
  unsubscribe: () => void;
}

/**
 * Permission request queue interface
 */
export interface PermissionRequestQueue {
  /** Add a request to the queue */
  add: (request: PermissionRequest) => void;
  /** Get and remove the next request (FIFO) */
  next: () => PermissionRequest | null;
  /** Get a request by ID without removing it */
  get: (id: string) => PermissionRequest | null;
  /** Remove a request by ID */
  remove: (id: string) => void;
  /** Get all pending requests */
  getAll: () => PermissionRequest[];
  /** Get requests for a specific pane */
  getByPane: (paneId: string) => PermissionRequest[];
  /** Get the number of pending requests */
  size: () => number;
  /** Clear all requests */
  clear: () => void;
}

// ============================================================================
// Request ID Generation
// ============================================================================

let requestCounter = 0;

/**
 * Generate a unique request ID
 */
function generateRequestId(): string {
  requestCounter++;
  const timestamp = Date.now().toString(36);
  const counter = requestCounter.toString(36).padStart(4, '0');
  return `req-${timestamp}-${counter}`;
}

// ============================================================================
// Permission Request Extraction
// ============================================================================

/**
 * Extract a permission request from a normalized event.
 * Returns null if the event is not a permission-related event.
 *
 * @param event - Normalized event from the wish-21 event system
 * @returns PermissionRequest or null
 */
export function extractPermissionRequest(event: NormalizedEvent): PermissionRequest | null {
  // Only process tool_call and permission_request events
  if (event.type !== 'tool_call' && event.type !== 'permission_request') {
    return null;
  }

  // Must have a tool name
  if (!event.toolName) {
    return null;
  }

  return {
    id: generateRequestId(),
    toolName: event.toolName,
    toolInput: event.toolInput,
    paneId: event.paneId,
    wishId: event.wishId,
    sessionId: event.sessionId,
    cwd: event.cwd,
    timestamp: event.timestamp,
    toolCallId: event.toolCallId,
  };
}

// ============================================================================
// Permission Request Queue
// ============================================================================

/**
 * Create a new permission request queue.
 * Requests are stored in FIFO order for processing.
 *
 * @returns PermissionRequestQueue instance
 */
export function createPermissionRequestQueue(): PermissionRequestQueue {
  const requests: PermissionRequest[] = [];

  return {
    add(request: PermissionRequest): void {
      requests.push(request);
    },

    next(): PermissionRequest | null {
      if (requests.length === 0) {
        return null;
      }
      return requests.shift() || null;
    },

    get(id: string): PermissionRequest | null {
      return requests.find((r) => r.id === id) || null;
    },

    remove(id: string): void {
      const index = requests.findIndex((r) => r.id === id);
      if (index !== -1) {
        requests.splice(index, 1);
      }
    },

    getAll(): PermissionRequest[] {
      return [...requests];
    },

    getByPane(paneId: string): PermissionRequest[] {
      return requests.filter((r) => r.paneId === paneId);
    },

    size(): number {
      return requests.length;
    },

    clear(): void {
      requests.length = 0;
    },
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Extract the bash command from a Bash tool permission request.
 * Returns null if the request is not for the Bash tool or command is not found.
 *
 * @param request - Permission request to extract command from
 * @returns The bash command string or null
 */
export function getBashCommand(request: PermissionRequest): string | null {
  if (request.toolName !== 'Bash') {
    return null;
  }

  if (!request.toolInput) {
    return null;
  }

  const command = request.toolInput.command;
  if (typeof command === 'string') {
    return command;
  }

  return null;
}

/**
 * Check if a permission request is for a Bash tool
 */
export function isBashRequest(request: PermissionRequest): boolean {
  return request.toolName === 'Bash';
}

// ============================================================================
// Event Subscription
// ============================================================================

/**
 * Subscribe to permission request events.
 * The callback is invoked whenever a tool_call or permission_request event
 * is processed.
 *
 * @param callback - Function to call when a permission request is detected
 * @returns EventSubscription handle for processing events and unsubscribing
 */
export function subscribeToPermissionRequests(
  callback: (request: PermissionRequest) => void
): EventSubscription {
  let active = true;

  return {
    processEvent(event: NormalizedEvent): void {
      if (!active) {
        return;
      }

      const request = extractPermissionRequest(event);
      if (request) {
        callback(request);
      }
    },

    unsubscribe(): void {
      active = false;
    },
  };
}
