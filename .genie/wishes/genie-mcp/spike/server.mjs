#!/usr/bin/env node
// THROWAWAY G1 spike: hand-rolled JSON-RPC 2.0 MCP server over stdio.
// Newline-delimited framing (one JSON object per line) — MCP stdio transport.
// Implements just: initialize, tools/list, tools/call (echo). No deps.
// Runs under both `bun` and `node`.

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'genie-spike', version: '0.0.1' };

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo back the provided text (spike smoke tool).',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to echo' } },
      required: ['text'],
    },
  },
];

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function handle(msg) {
  const { id, method, params } = msg;
  // Notifications (no id) — e.g. notifications/initialized — need no response.
  if (method === 'notifications/initialized' || method === 'initialized') return;

  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });
      return;
    case 'ping':
      reply(id, {});
      return;
    case 'tools/list':
      reply(id, { tools: TOOLS });
      return;
    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments ?? {};
      if (name === 'echo') {
        reply(id, {
          content: [{ type: 'text', text: `echo: ${args.text ?? ''}` }],
          isError: false,
        });
        return;
      }
      replyError(id, -32602, `Unknown tool: ${name}`);
      return;
    }
    default:
      if (id !== undefined) replyError(id, -32601, `Method not found: ${method}`);
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch (e) {
      replyError(null, -32700, `Parse error: ${e.message}`);
    }
  }
});
// Do NOT exit on stdin end until stdout drains, or clients truncate responses.
process.stdin.on('end', () => {
  process.stdout.write('', () => process.exit(0));
});
