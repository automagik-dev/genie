#!/usr/bin/env node
"use strict";
/**
 * Minimal MCP Server - No external dependencies
 * Implements Model Context Protocol using only Node.js built-ins
 *
 * Addresses Twin RISK-3: Minimal implementation without FastMCP dependency
 * Can be enhanced with FastMCP later when available
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const http_1 = __importDefault(require("http"));
const PORT = process.env.MCP_PORT ? parseInt(process.env.MCP_PORT) : 8080;
// MCP Tools using cli-core handlers
const TOOLS = {
    'genie_run': {
        description: 'Start a new Genie agent session',
        parameters: {
            agent: 'string',
            prompt: 'string'
        }
    },
    'genie_resume': {
        description: 'Continue an existing Genie session',
        parameters: {
            taskId: 'string',
            prompt: 'string'
        }
    },
    'genie_list_agents': {
        description: 'List all available Genie agents',
        parameters: {}
    },
    'genie_list_sessions': {
        description: 'List active and recent sessions',
        parameters: {}
    },
    'genie_view': {
        description: 'View session transcript',
        parameters: {
            taskId: 'string',
            full: 'boolean?'
        }
    },
    'genie_stop': {
        description: 'Stop a running session',
        parameters: {
            taskId: 'string'
        }
    }
};
function handleRequest(req) {
    // MCP initialization
    if (req.method === 'initialize') {
        return {
            jsonrpc: '2.0',
            id: req.id,
            result: {
                protocolVersion: '2024-11-05',
                capabilities: {
                    tools: {}
                },
                serverInfo: {
                    name: 'genie-mcp-server',
                    version: '0.1.0'
                }
            }
        };
    }
    // List available tools
    if (req.method === 'tools/list') {
        return {
            jsonrpc: '2.0',
            id: req.id,
            result: {
                tools: Object.entries(TOOLS).map(([name, spec]) => ({
                    name,
                    description: spec.description,
                    inputSchema: {
                        type: 'object',
                        properties: Object.entries(spec.parameters).reduce((acc, [key, type]) => {
                            acc[key] = { type: type.replace('?', '') };
                            return acc;
                        }, {}),
                        required: Object.keys(spec.parameters).filter(k => !spec.parameters[k].includes('?'))
                    }
                }))
            }
        };
    }
    // Tool execution
    if (req.method === 'tools/call') {
        const { name, arguments: args } = req.params || {};
        // Stub implementations - will be completed when cli-core handlers are fully extracted
        const result = {
            content: [{
                    type: 'text',
                    text: `Tool ${name} called with args: ${JSON.stringify(args)}\\n\\nNote: Full implementation pending cli-core handler completion.`
                }]
        };
        return {
            jsonrpc: '2.0',
            id: req.id,
            result
        };
    }
    // Unknown method
    return {
        jsonrpc: '2.0',
        id: req.id,
        error: {
            code: -32601,
            message: 'Method not found',
            data: { method: req.method }
        }
    };
}
// HTTP server
const server = http_1.default.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
        return;
    }
    if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
    }
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
        try {
            const request = JSON.parse(body);
            const response = handleRequest(request);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(response));
        }
        catch (error) {
            const errorResponse = {
                jsonrpc: '2.0',
                error: {
                    code: -32700,
                    message: 'Parse error',
                    data: error instanceof Error ? error.message : String(error)
                }
            };
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(errorResponse));
        }
    });
});
server.listen(PORT, () => {
    console.log(`Genie MCP Server listening on port ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
    console.log('Protocol: MCP (Model Context Protocol)');
    console.log('Implementation: Minimal (Node.js built-ins only)');
});
