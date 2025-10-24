"use strict";
/**
 * Dashboard Server - HTTP + WebSocket server for real-time stats
 *
 * Provides REST API and WebSocket streaming for engagement statistics.
 * Runs alongside the MCP server on a separate port (default: 8886).
 *
 * Features:
 * - HTTP REST API for stats queries (/api/stats/*)
 * - WebSocket streaming for real-time updates (/api/stats/stream)
 * - CORS enabled for frontend development
 * - Event-driven architecture for stats updates
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.statsEventEmitter = exports.DashboardServer = void 0;
const http_1 = __importDefault(require("http"));
const ws_1 = require("ws");
// ============================================================================
// Dashboard Server
// ============================================================================
class DashboardServer {
    constructor(config) {
        // Connected WebSocket clients
        this.clients = new Set();
        this.statsService = config.statsService;
        this.port = config.port;
        this.enableCors = config.enableCors !== false; // Default true
        // Create HTTP server
        this.httpServer = http_1.default.createServer((req, res) => {
            this.handleHttpRequest(req, res);
        });
        // Create WebSocket server (attached to HTTP server)
        this.wss = new ws_1.WebSocketServer({
            server: this.httpServer,
            path: '/api/stats/stream'
        });
        this.setupWebSocketHandlers();
    }
    /**
     * Start the dashboard server
     */
    start() {
        this.httpServer.listen(this.port, () => {
            console.error(`📊 Dashboard server started on port ${this.port}`);
            console.error(`   HTTP API: http://localhost:${this.port}/api/stats`);
            console.error(`   WebSocket: ws://localhost:${this.port}/api/stats/stream`);
        });
    }
    /**
     * Stop the dashboard server
     */
    stop() {
        // Close all WebSocket connections
        this.clients.forEach(client => {
            client.close();
        });
        // Close WebSocket server
        this.wss.close();
        // Close HTTP server
        this.httpServer.close(() => {
            console.error('📊 Dashboard server stopped');
        });
    }
    /**
     * Emit stats event to all connected WebSocket clients
     */
    emitStatsEvent(event) {
        const message = JSON.stringify(event);
        this.clients.forEach(client => {
            if (client.readyState === ws_1.WebSocket.OPEN) {
                client.send(message);
            }
        });
    }
    // ============================================================================
    // HTTP Request Handling
    // ============================================================================
    handleHttpRequest(req, res) {
        // CORS headers
        if (this.enableCors) {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
            if (req.method === 'OPTIONS') {
                res.writeHead(200);
                res.end();
                return;
            }
        }
        const url = req.url || '/';
        // Route handling
        if (url.startsWith('/api/stats/session/current')) {
            this.handleGetCurrentSession(req, res);
        }
        else if (url.startsWith('/api/stats/session/')) {
            const sessionId = url.split('/').pop() || '';
            this.handleGetSession(sessionId, req, res);
        }
        else if (url.startsWith('/api/stats/monthly/')) {
            const month = url.split('/').pop() || '';
            this.handleGetMonthlyStats(month, req, res);
        }
        else if (url === '/api/stats/all-time') {
            this.handleGetAllTimeStats(req, res);
        }
        else if (url === '/api/stats/streak') {
            this.handleGetStreak(req, res);
        }
        else if (url === '/api/stats/today') {
            this.handleGetTodayStats(req, res);
        }
        else if (url === '/health') {
            this.handleHealth(req, res);
        }
        else {
            this.send404(res);
        }
    }
    handleGetCurrentSession(req, res) {
        try {
            const session = this.statsService.getCurrentSession();
            this.sendJson(res, session || { error: 'No active session' });
        }
        catch (error) {
            this.sendError(res, 500, error.message);
        }
    }
    handleGetSession(sessionId, req, res) {
        try {
            const session = this.statsService.getCurrentSession(sessionId);
            this.sendJson(res, session || { error: 'Session not found' });
        }
        catch (error) {
            this.sendError(res, 500, error.message);
        }
    }
    handleGetMonthlyStats(month, req, res) {
        try {
            const stats = this.statsService.getMonthlyStats(month);
            this.sendJson(res, stats);
        }
        catch (error) {
            this.sendError(res, 500, error.message);
        }
    }
    handleGetAllTimeStats(req, res) {
        try {
            const stats = this.statsService.getAllTimeStats();
            this.sendJson(res, stats);
        }
        catch (error) {
            this.sendError(res, 500, error.message);
        }
    }
    handleGetStreak(req, res) {
        try {
            const streak = this.statsService.calculateStreak();
            this.sendJson(res, streak);
        }
        catch (error) {
            this.sendError(res, 500, error.message);
        }
    }
    handleGetTodayStats(req, res) {
        try {
            const stats = this.statsService.getTodayStats();
            this.sendJson(res, stats);
        }
        catch (error) {
            this.sendError(res, 500, error.message);
        }
    }
    handleHealth(req, res) {
        this.sendJson(res, {
            status: 'ok',
            service: 'genie-dashboard',
            timestamp: new Date().toISOString(),
            websocket: {
                connected_clients: this.clients.size
            }
        });
    }
    // ============================================================================
    // WebSocket Handling
    // ============================================================================
    setupWebSocketHandlers() {
        this.wss.on('connection', (ws) => {
            console.error('📊 WebSocket client connected');
            this.clients.add(ws);
            // Send initial session state
            const currentSession = this.statsService.getCurrentSession();
            if (currentSession) {
                ws.send(JSON.stringify({
                    type: 'session_started',
                    sessionId: currentSession.id,
                    data: currentSession
                }));
            }
            // Handle client disconnection
            ws.on('close', () => {
                console.error('📊 WebSocket client disconnected');
                this.clients.delete(ws);
            });
            ws.on('error', (error) => {
                console.error('📊 WebSocket error:', error);
                this.clients.delete(ws);
            });
        });
    }
    // ============================================================================
    // Response Helpers
    // ============================================================================
    sendJson(res, data) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
    }
    sendError(res, status, message) {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: message }));
    }
    send404(res) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
    }
}
exports.DashboardServer = DashboardServer;
// ============================================================================
// Event Emitter Helpers (for integration with StatsService)
// ============================================================================
/**
 * Stats event emitter singleton
 * Used by StatsService to broadcast events to dashboard server
 */
class StatsEventEmitter {
    constructor() {
        this.dashboardServer = null;
    }
    setDashboardServer(server) {
        this.dashboardServer = server;
    }
    emitTokenUpdate(sessionId, tokens) {
        if (this.dashboardServer) {
            this.dashboardServer.emitStatsEvent({
                type: 'token_update',
                sessionId,
                data: { tokens }
            });
        }
    }
    emitTaskCompleted(sessionId, taskId) {
        if (this.dashboardServer) {
            this.dashboardServer.emitStatsEvent({
                type: 'task_completed',
                sessionId,
                data: { taskId }
            });
        }
    }
    emitMilestoneReached(sessionId, milestone) {
        if (this.dashboardServer) {
            this.dashboardServer.emitStatsEvent({
                type: 'milestone_reached',
                sessionId,
                data: milestone
            });
        }
    }
    emitSessionStarted(sessionId, projectId) {
        if (this.dashboardServer) {
            this.dashboardServer.emitStatsEvent({
                type: 'session_started',
                sessionId,
                data: { projectId }
            });
        }
    }
    emitSessionEnded(sessionId) {
        if (this.dashboardServer) {
            this.dashboardServer.emitStatsEvent({
                type: 'session_ended',
                sessionId,
                data: {}
            });
        }
    }
}
exports.statsEventEmitter = new StatsEventEmitter();
