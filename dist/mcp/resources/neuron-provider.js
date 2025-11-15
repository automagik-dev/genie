"use strict";
/**
 * Neuron Resource Provider - MCP Resources for real-time neuron communication
 *
 * Purpose: Provide real-time access to neuron "thoughts" via MCP Resources
 * Architecture: Genie subscribes to neuron resources, receives updates automatically
 *
 * Resources provided:
 * - neuron://wish/stream - WISH neuron thought stream
 * - neuron://forge/stream - FORGE neuron thought stream
 * - neuron://review/stream - REVIEW neuron thought stream
 * - neuron://genie/stream - GENIE neuron thought stream
 *
 * Message format: JsonPatch operations (discovered via WebSocketManager testing)
 * Infrastructure: Uses production WebSocketManager for connection pooling + auto-reconnect
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.NeuronResourceProvider = void 0;
exports.getNeuronProvider = getNeuronProvider;
exports.initNeuronProvider = initNeuronProvider;
const events_1 = require("events");
// Import WebSocketManager singleton from websocket-manager.ts
const websocket_manager_js_1 = require("../websocket-manager.js");
/**
 * Neuron names matching the 4 neurons moved to .genie/agents/neurons/
 */
const NEURON_NAMES = ['wish', 'forge', 'review', 'genie'];
/**
 * Neuron Resource Provider
 *
 * Manages real-time subscriptions to neuron WebSocket streams via Forge API.
 * Emits resource update events when neurons process thoughts.
 */
class NeuronResourceProvider extends events_1.EventEmitter {
    constructor(forgeUrl, projectId) {
        super();
        this.subscriptions = new Map(); // neuron -> subscription ID
        this.activeAttempts = new Map(); // neuron -> attempt ID
        this.forgeUrl = forgeUrl;
        this.projectId = projectId;
    }
    /**
     * Start subscribing to a neuron's stream
     *
     * @param neuron Neuron name (wish, forge, review, genie)
     * @param attemptId Forge task attempt ID for this neuron's execution
     */
    subscribeToNeuron(neuron, attemptId) {
        // Store attempt ID for this neuron
        this.activeAttempts.set(neuron, attemptId);
        // Build WebSocket URL for diff stream (file changes = neuron reasoning)
        const protocol = this.forgeUrl.startsWith('https') ? 'wss' : 'ws';
        const host = new URL(this.forgeUrl).host;
        const diffStreamUrl = `${protocol}://${host}/api/task-attempts/${attemptId}/diff/ws?stats_only=false`;
        // Subscribe via WebSocketManager
        const subscriptionId = websocket_manager_js_1.wsManager.subscribe(diffStreamUrl, (data) => {
            // Handle incoming message
            const thought = {
                timestamp: new Date().toISOString(),
                neuron,
                source: 'diff',
                data
            };
            // Emit resource update event
            this.emit('thought', thought);
            // Also emit neuron-specific event
            this.emit(`thought:${neuron}`, thought);
        }, (error) => {
            console.error(`Neuron ${neuron} stream error:`, error.message);
        });
        // Store subscription ID
        this.subscriptions.set(neuron, subscriptionId);
    }
    /**
     * Stop subscribing to a neuron's stream
     */
    unsubscribeFromNeuron(neuron) {
        const subscriptionId = this.subscriptions.get(neuron);
        if (subscriptionId) {
            websocket_manager_js_1.wsManager.unsubscribe(subscriptionId);
            this.subscriptions.delete(neuron);
            this.activeAttempts.delete(neuron);
        }
    }
    /**
     * Get list of available neuron resources
     */
    getAvailableResources() {
        return NEURON_NAMES.map(neuron => ({
            uri: `neuron://${neuron}/stream`,
            name: `${neuron.toUpperCase()} Neuron Stream`,
            description: `Real-time thought stream from ${neuron.toUpperCase()} neuron orchestrator`
        }));
    }
    /**
     * Get current state of a neuron resource
     */
    getResourceState(neuron) {
        return {
            active: this.subscriptions.has(neuron),
            attemptId: this.activeAttempts.get(neuron) || null
        };
    }
    /**
     * Cleanup all subscriptions
     */
    cleanup() {
        for (const neuron of NEURON_NAMES) {
            this.unsubscribeFromNeuron(neuron);
        }
    }
}
exports.NeuronResourceProvider = NeuronResourceProvider;
/**
 * Singleton instance for use across MCP server
 */
let providerInstance = null;
function getNeuronProvider(forgeUrl, projectId) {
    if (!providerInstance) {
        if (!forgeUrl || !projectId) {
            throw new Error('Neuron provider not initialized. Call initNeuronProvider first.');
        }
        providerInstance = new NeuronResourceProvider(forgeUrl, projectId);
    }
    return providerInstance;
}
function initNeuronProvider(forgeUrl, projectId) {
    providerInstance = new NeuronResourceProvider(forgeUrl, projectId);
    return providerInstance;
}
