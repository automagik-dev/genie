// chat-backend.stub-agent.mjs — a deterministic stub ACP AGENT (server side) used ONLY by
// chat-backend.test.ts to prove the transport + routing without a live LLM. It speaks real
// ACP over stdio via the vendor SDK's AgentSideConnection, so the client half under test is
// exercised for real. Not shipped, not imported by any src module — a test fixture.
//
// Behavior knobs via argv/env:
//   argv[2] = mode: 'echo' (default) | 'permission' | 'slow'
//   GENIE_STUB_MARKER = path to touch on startup (proves lazy-spawn: the file must NOT
//                       exist until the first @mention actually spawns this process).
import { writeFileSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { AgentSideConnection, PROTOCOL_VERSION, ndJsonStream } from '@agentclientprotocol/sdk';

const mode = process.argv[2] ?? 'echo';
const marker = process.env.GENIE_STUB_MARKER;
if (marker) writeFileSync(marker, `${process.pid}\n`);

const output = Writable.toWeb(process.stdout);
const input = Readable.toWeb(process.stdin);
const stream = ndJsonStream(output, input);

class StubAgent {
  constructor(conn) {
    this.conn = conn;
    this.seq = 0;
  }
  async initialize(_params) {
    return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: { loadSession: false } };
  }
  async newSession(_params) {
    return { sessionId: `stub-${++this.seq}` };
  }
  async prompt(params) {
    const sessionId = params.sessionId;
    const userText = (params.prompt ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
    if (mode === 'permission') {
      // A read-only face must DENY: request permission and assert the client cancels.
      const res = await this.conn.requestPermission({
        sessionId,
        toolCall: { toolCallId: 't1', title: 'write file', kind: 'edit' },
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ],
      });
      const outcome = res?.outcome?.outcome ?? 'unknown';
      await this.conn.sessionUpdate({
        sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `permission:${outcome}` } },
      });
      return { stopReason: 'end_turn' };
    }
    // echo/slow: stream the received prompt back so the test can assert transcript+seed arrived.
    const reply = `echo:${userText}`;
    for (const ch of chunk(reply, 8)) {
      await this.conn.sessionUpdate({
        sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ch } },
      });
    }
    return { stopReason: 'end_turn' };
  }
}

function* chunk(s, n) {
  for (let i = 0; i < s.length; i += n) yield s.slice(i, i + n);
}

// eslint-disable-next-line no-new
new AgentSideConnection((conn) => new StubAgent(conn), stream);
