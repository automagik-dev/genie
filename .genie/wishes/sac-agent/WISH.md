# Wish: SAC Agent — Co-Pilot Call Cockpit

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `sac-agent` |
| **Date** | 2026-03-26 |
| **Design** | [DESIGN.md](../../brainstorms/sac-agent/DESIGN.md) |

## Summary

Build a co-pilot cockpit (Next.js + CLI) where Genie does the thinking and an ElevenLabs agent does the talking on SAC phone calls. The outbound call API places the call. The monitor WebSocket (`/conversations/{id}/monitor`) gives us full visibility (transcripts, events) and control (`contextual_update`, `end_call`, `transfer_to_number`). No audio handling. No bridge. Desktop-first on LAN. First mission: Itaú Cartões.

## Scope

### IN
- Next.js 15 app at `tools/ligar/`
- ElevenLabs outbound call API to place calls
- Monitor WebSocket for real-time events + commands
- Commands: `contextual_update` (steer agent), `end_call`, `transfer_to_number` (takeover)
- Desktop cockpit UI: call controls, DTMF pad, live transcript, say/guide input, takeover button
- CLI for Genie: `ligar call`, `ligar monitor`, `ligar say`, `ligar context`, `ligar dtmf`, `ligar status`, `ligar hangup`, `ligar takeover`
- Shared HTTP API + SSE — UI and CLI hit the same server
- LAN access (`http://10.114.x.x:3000`)

### OUT
- Audio bridge / audio processing / Twilio Stream (ElevenLabs handles it all)
- Twilio Client SDK / WebRTC (takeover uses `transfer_to_number` instead)
- Server-side tool webhooks (no public URL needed)
- ngrok / tunnel / proxy
- Mobile optimization / PWA / Tauri
- Multiple simultaneous calls
- Call recording / playback
- Omni integration

## Decisions

| Decision | Rationale |
|----------|-----------|
| Outbound call API + monitor WebSocket | Two API calls give us everything: call placement + full visibility/control. No audio path involvement. |
| `transfer_to_number` for takeover | Native ElevenLabs command. Transfers call to Felipe's phone. No Twilio Client SDK, no WebRTC, no browser mic setup. |
| `contextual_update` for steering | Genie sends context, agent absorbs silently. The thinking/talking separation. |
| Voice-based IVR navigation first | Agent speaks "três" instead of DTMF tone. Simpler. Fall back to Twilio DTMF if IVR requires it. |
| No Twilio Client SDK | `transfer_to_number` replaces it entirely. One less SDK, no browser audio complexity. |
| SSE for transcript streaming | Monitor WS events → server → SSE → browser + CLI. Simple, works everywhere. |

## Success Criteria

- [ ] `npm run dev` starts cockpit, accessible on LAN
- [ ] Enter Itaú number, click Call → phone rings
- [ ] `ligar call "+5511..."` → same from CLI
- [ ] Monitor WebSocket connects and streams events
- [ ] Browser + CLI show live transcript (< 3s delay)
- [ ] `ligar context "CPF é 123.456.789-00"` → agent uses it when asked
- [ ] Agent navigates IVR (voice or DTMF fallback)
- [ ] `ligar takeover` → call transfers to Felipe's phone
- [ ] `ligar hangup` → call ends via `end_call` command
- [ ] Both co-pilots see the same transcript simultaneously

## Execution Strategy

### Wave 1 (parallel — skeleton)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Next.js project + API stubs + session + config |
| 2 | engineer | Desktop UI: CallPanel, DTMFPad, Transcript, ChatInput, TakeoverButton |

### Wave 2 (after Wave 1 — core)
| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer | ElevenLabs: outbound call API + monitor WebSocket + event handling + commands |
| 4 | engineer | CLI: all commands, SSE monitor |

### Wave 3 (after Wave 2 — ship)
| Group | Agent | Description |
|-------|-------|-------------|
| 5 | engineer | E2E wiring, error handling, README, LAN config |
| review | reviewer | Review against criteria |

## Execution Groups

### Group 1: Next.js Project + API Stubs + State
**Goal:** Running server with all endpoints stubbed.

**Deliverables:**
1. `package.json` — next 15, react, elevenlabs, twilio (DTMF fallback), ws, tailwindcss
2. `src/app/layout.tsx` + `globals.css` — dark layout
3. `src/app/page.tsx` — cockpit page
4. API route stubs:
   - `POST /api/call` — start call
   - `POST /api/context` — send contextual_update
   - `POST /api/dtmf` — send DTMF (fallback)
   - `POST /api/hangup` — end_call
   - `POST /api/takeover` — transfer_to_number
   - `GET /api/status` — call state
   - `GET /api/transcript` — SSE stream
5. `src/lib/session.ts` — in-memory: conversationId, callSid, status (idle/calling/active/ended), transcript[], instructions
6. `src/lib/config.ts` — env var loader: refuses to start if `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID`, or `ELEVENLABS_PHONE_NUMBER_ID` are missing. Never logs or exposes key values in error messages.
7. `.env.example`, `tsconfig.json`, `next.config.ts`, `tailwind.config.ts`

**Acceptance Criteria:**
- [ ] `npm run dev` on port 3000, accessible on LAN
- [ ] All routes respond
- [ ] TypeScript compiles
- [ ] Server refuses to start with clear message if required env vars are missing

**Validation:**
```bash
cd tools/ligar && npm run build
```

**depends-on:** none

---

### Group 2: Desktop Cockpit UI
**Goal:** Functional dark cockpit for desktop.

**Deliverables:**
1. `CallPanel.tsx` — phone number input, [Call], [Hang Up], status badge (idle/calling/active/ended)
2. `DTMFPad.tsx` — 4x3 keypad → POST /api/dtmf
3. `Transcript.tsx` — scrolling chat log: 📞 SAC / 🤖 Agent / ⚙️ System, timestamps, auto-scroll
4. `ChatInput.tsx` — text input with [Guide] button (→ POST /api/context). All steering goes through contextual_update.
5. `TakeoverButton.tsx` — [Take Over Call] → POST /api/takeover. Shows Felipe's phone number from config.
6. `page.tsx` — layout: left sidebar (call controls + DTMF), main area (transcript + chat input), takeover at top right

**Acceptance Criteria:**
- [ ] All panels on one screen
- [ ] Controls disabled when no active call
- [ ] Call button shows loading state during API request, prevents double-click
- [ ] Transcript auto-scrolls on new entries
- [ ] Dark theme

**Validation:**
```bash
cd tools/ligar && npm run build
```

**depends-on:** none

---

### Group 3: ElevenLabs Integration (Outbound Call + Monitor WebSocket)
**Goal:** Place calls and have full real-time visibility + control via the monitor WebSocket.

**Deliverables:**
1. `src/lib/elevenlabs.ts`:
   - `placeCall(toNumber, overrides?)` → `POST /v1/convai/twilio/outbound-call` with agent_id, agent_phone_number_id, to_number, conversation_initiation_client_data (dynamic_variables for instructions/account info). Returns conversation_id + callSid.
   - `connectMonitor(conversationId)` → opens WebSocket to `wss://api.elevenlabs.io/v1/convai/conversations/{id}/monitor` with xi-api-key header. Parses incoming events, emits to session transcript.
   - `sendContextualUpdate(text)` → `{ command_type: "contextual_update", parameters: { contextual_update: text } }`
   - `sendEndCall()` → `{ command_type: "end_call" }`
   - `sendTransferToNumber(phoneNumber)` → `{ command_type: "transfer_to_number", parameters: { phone_number } }`
2. `POST /api/call` → calls placeCall(), then connectMonitor(), updates session
3. `POST /api/context` → calls sendContextualUpdate()
4. `POST /api/hangup` → calls sendEndCall(), closes monitor WS, updates session
5. `POST /api/takeover` → calls sendTransferToNumber(FELIPE_PHONE_NUMBER)
6. `POST /api/dtmf` → Twilio `calls(callSid).update({ sendDigits })` as fallback
7. `GET /api/transcript` — SSE endpoint: replays session.transcript, then streams new entries as monitor WS events arrive
8. `GET /api/status` → `{ status, conversationId, callSid, transcriptLines, duration }`

**Acceptance Criteria:**
- [ ] Outbound call API places a real call
- [ ] Monitor WebSocket connects and receives transcript events
- [ ] contextual_update reaches the agent
- [ ] end_call terminates the call
- [ ] transfer_to_number transfers to Felipe's phone
- [ ] SSE streams transcript to connected clients
- [ ] DTMF fallback works via Twilio API

**Validation:**
```bash
cd tools/ligar && npx tsc --noEmit
```

**depends-on:** Group 1

---

### Group 4: CLI for Genie
**Goal:** Genie's interface to the cockpit.

**Deliverables:**
1. `cli.ts` — single Node.js file, zero deps beyond Node 18+ fetch:
   - `call <number> [--instructions "..."] [--account "..."]` → POST /api/call
   - `monitor` → GET /api/transcript (SSE), tail -f style with ANSI colors
   - `context <text>` → POST /api/context (contextual_update)
   - `dtmf <digits>` → POST /api/dtmf
   - `status` → GET /api/status
   - `takeover` → POST /api/takeover (transfer to Felipe's phone)
   - `hangup` → POST /api/hangup
2. `LIGAR_URL` env var (default `http://localhost:3000`)
3. SSE parsing: read `text/event-stream`, format with ANSI colors (📞 red, 🤖 cyan, ⚙️ dim)
4. Error handling: server down, no active call, API errors

**Acceptance Criteria:**
- [ ] All commands work
- [ ] `monitor` streams live transcript
- [ ] Errors handled gracefully

**Validation:**
```bash
cd tools/ligar && node cli.ts --help
```

**depends-on:** Group 1

---

### Group 5: E2E Wiring + Ship
**Goal:** Everything works. Clean setup.

**Deliverables:**
1. `.env.example` — all vars with descriptions
2. `README.md` — setup: env vars, ElevenLabs phone number ID, agent configuration, first call walkthrough
3. `next.config.ts` — bind `0.0.0.0` for LAN access
4. Error handling:
   - ElevenLabs API errors → user-visible message with status code, no key leakage
   - Monitor WebSocket disconnect → auto-reconnect with backoff (1s, 2s, 4s), status badge shows "reconnecting"
   - No active call → controls disabled, clear "no active call" message on API attempts
5. Button states: loading spinners during API calls, disabled during wrong states
6. Session lifecycle cleanup:
   - Monitor WS `close` event → session status → ended, transcript finalized
   - Browser tab close / `beforeunload` → no cleanup needed (server manages session)
   - Stale session timeout: if no monitor events for 10 minutes, auto-set status to ended
   - Concurrent call guard: reject `/api/call` if session status is already `calling` or `active`
7. `package.json` scripts: `dev` (binds 0.0.0.0), `build`, `start`

**Acceptance Criteria:**
- [ ] `npm run dev` → accessible at `http://10.114.x.x:3000`
- [ ] Full flow: call → agent talks → steer via context → takeover → hangup
- [ ] Missing env vars → clear error on startup
- [ ] Monitor WS disconnect → UI shows reconnecting, auto-recovers
- [ ] Double call attempt → rejected with message
- [ ] README covers setup from zero

**Validation:**
```bash
cd tools/ligar && npm run build && echo "Ship it"
```

**depends-on:** Group 3, Group 4

---

## QA Criteria

- [ ] Place a real call — ElevenLabs agent speaks to SAC
- [ ] Monitor WebSocket streams transcript in real-time
- [ ] Genie and Felipe see the same live transcript
- [ ] `contextual_update` steers the agent's behavior
- [ ] Agent navigates IVR (voice or DTMF fallback)
- [ ] `transfer_to_number` transfers call to Felipe's phone
- [ ] `end_call` terminates cleanly
- [ ] LAN access works

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Outbound call API doesn't return conversation_id synchronously | Medium | Poll recent conversations list to find it by callSid/timestamp |
| Monitor WebSocket latency on transcript events | Low | Enterprise tier should have fast event delivery. Verify. |
| `transfer_to_number` requires `transfer_to_number` system tool on agent | Medium | Configure in ElevenLabs dashboard before first test |
| Itaú IVR doesn't accept voice input | Medium | Fall back to DTMF via Twilio API |
| Twilio `sendDigits` doesn't work on ElevenLabs-managed call | Medium | Test. Worst case: configure agent prompt to speak digits clearly |

**Assumptions:**
- ElevenLabs enterprise plan (confirmed) with monitoring enabled
- Agent has `transfer_to_number` system tool configured
- Twilio phone number imported into ElevenLabs dashboard
- `ELEVENLABS_PHONE_NUMBER_ID` available in dashboard
- Node.js 18+ on server
- LAN connectivity between machines

---

## API Reference

### ElevenLabs: Place Outbound Call

```
POST https://api.elevenlabs.io/v1/convai/twilio/outbound-call
Header: xi-api-key: <ELEVENLABS_API_KEY>
Content-Type: application/json
```

**Request:**
```json
{
  "agent_id": "agent_2101kmnhdwwye5wv06jqq8zcb9x7",
  "agent_phone_number_id": "<from ElevenLabs dashboard → Phone Numbers>",
  "to_number": "+551140043322",
  "conversation_initiation_client_data": {
    "dynamic_variables": {
      "user_instructions": "Desbloquear cartão de crédito Itaú. Cartão final 9012.",
      "account_info": "CPF: 123.456.789-00, Nome: Felipe",
      "language": "pt-BR"
    }
  },
  "call_recording_enabled": false,
  "telephony_call_config": {
    "ring_timeout": 60
  }
}
```

**Response (200):**
```json
{
  "success": true,
  "message": "Call initiated",
  "conversation_id": "conv_abc123",
  "callSid": "CA_xyz789"
}
```

**Response (422):** validation errors with field-level detail.

**Notes:**
- `agent_phone_number_id` is NOT the phone number itself — it's the ID from the ElevenLabs dashboard after importing your Twilio number
- `dynamic_variables` are injected into the agent's prompt wherever `{{variable_name}}` placeholders exist
- `conversation_id` is needed immediately to open the monitor WebSocket

---

### ElevenLabs: Monitor WebSocket

```
WSS wss://api.elevenlabs.io/v1/convai/conversations/{conversation_id}/monitor
Header: xi-api-key: <ELEVENLABS_API_KEY>
```

**Connection (JavaScript):**
```javascript
const ws = new WebSocket(
  `wss://api.elevenlabs.io/v1/convai/conversations/${conversationId}/monitor`,
  { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY } }
);
```

**Connection (Python):**
```python
import websockets
async with websockets.connect(
    f"wss://api.elevenlabs.io/v1/convai/conversations/{conversation_id}/monitor",
    extra_headers={"xi-api-key": os.getenv("ELEVENLABS_API_KEY")}
) as ws:
    pass
```

**Auth requirements:**
- API key with `ElevenLabs Agents Write` scope
- `EDITOR` level workspace access
- Enterprise plan

**Behavior:**
- ~100 most recent events cached on connect (replays history)
- No audio data — text events only
- Conversation must be active before connecting
- VAD scores and ping events are NOT forwarded to monitor

#### Events Received (Server → Monitor)

**user_transcript** — what the SAC person/IVR said:
```json
{
  "type": "user_transcript",
  "user_transcription_event": {
    "user_transcript": "Bem-vindo ao Itaú. Para cartões, digite 3."
  }
}
```

**agent_response** — what our agent said (sent with first audio chunk):
```json
{
  "type": "agent_response",
  "agent_response_event": {
    "agent_response": "Três."
  }
}
```

**agent_response_correction** — agent interrupted mid-sentence:
```json
{
  "type": "agent_response_correction",
  "agent_response_correction_event": {
    "original_agent_response": "Let me tell you about the complete history...",
    "corrected_agent_response": "Let me tell you about..."
  }
}
```

**client_tool_call** — agent wants to execute a function:
```json
{
  "type": "client_tool_call",
  "client_tool_call": {
    "tool_name": "getAccountInfo",
    "tool_call_id": "call_123456",
    "parameters": { "field": "cpf" }
  }
}
```

**agent_tool_response** — agent executed a tool:
```json
{
  "type": "agent_tool_response",
  "agent_tool_response": {
    "tool_name": "transfer_to_number",
    "tool_call_id": "call_789",
    "tool_type": "system",
    "is_error": false
  }
}
```

#### Commands Sent (Monitor → Server)

**contextual_update** — steer agent without interrupting:
```json
{
  "command_type": "contextual_update",
  "parameters": {
    "contextual_update": "The user's CPF is 123.456.789-00. Provide it when asked."
  }
}
```

**end_call** — terminate the call:
```json
{
  "command_type": "end_call"
}
```

**transfer_to_number** — transfer call to a phone number (requires `transfer_to_number` system tool on agent):
```json
{
  "command_type": "transfer_to_number",
  "parameters": {
    "phone_number": "+5534999666521"
  }
}
```

**enable_human_takeover** — switch to human operator mode (chat conversations only, NOT phone):
```json
{
  "command_type": "enable_human_takeover"
}
```

**send_human_message** — deliver operator message (after human takeover enabled):
```json
{
  "command_type": "send_human_message",
  "parameters": {
    "text": "How can I help you?"
  }
}
```

**disable_human_takeover** — return control to AI agent:
```json
{
  "command_type": "disable_human_takeover"
}
```

---

### ElevenLabs: Client-to-Server Events (WebSocket participant, NOT monitor)

These are for direct WebSocket conversation participants (not the monitor endpoint). Documented for reference — if we later need a direct WebSocket connection instead of monitor.

**contextual_update** — background info, doesn't interrupt:
```json
{ "type": "contextual_update", "text": "User is looking at pricing page" }
```

**user_message** — injected as user input, triggers response:
```json
{ "type": "user_message", "text": "I would like to upgrade my account" }
```

**user_activity** — resets turn timeout timer:
```json
{ "type": "user_activity" }
```

---

### Twilio: Send DTMF (Fallback)

```
POST https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Calls/{CallSid}.json
Auth: Basic (AccountSid:AuthToken)
```

**Request (form-encoded):**
```
Twiml=<Response><Play digits="3"/></Response>
```

**Or via SDK:**
```typescript
const twilio = require('twilio')(accountSid, authToken);
await twilio.calls(callSid).update({
  twiml: '<Response><Play digits="3"/></Response>'
});
```

**Note:** This interrupts the current TwiML execution. The call may need to be reconnected to the ElevenLabs agent after DTMF plays. Test whether ElevenLabs-managed calls survive this update.

---

### ElevenLabs Agent Dashboard Configuration

Before first use, configure the agent in the ElevenLabs dashboard:

1. **Agent → Advanced → Monitoring:** Enable monitoring (required for monitor WebSocket)
2. **Agent → Tools → System Tools:** Enable `transfer_to_number` (required for human takeover)
3. **Agent → Prompt:** Include dynamic variable placeholders:
   ```
   You are calling a Brazilian SAC (customer service) line on behalf of a user.

   USER INSTRUCTIONS: {{user_instructions}}
   ACCOUNT INFO: {{account_info}}
   LANGUAGE: {{language}}

   RULES:
   - Follow the user's instructions precisely
   - Speak in Brazilian Portuguese
   - Be polite but assertive
   - Navigate IVR menus by speaking the option clearly
   - When you reach a human attendant, introduce yourself and state the user's request
   - If asked for account details (CPF, card number, etc.), provide them from ACCOUNT INFO
   - If you cannot resolve the issue, use the transfer_to_number tool to transfer the call
   ```
4. **Agent → Phone Numbers:** Import Twilio number, note the `phone_number_id`
5. **Agent → Voice:** Select a Brazilian Portuguese voice
6. **Agent → Language:** Set to Portuguese (Brazil)

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create

```
tools/ligar/
├── package.json
├── tsconfig.json
├── next.config.ts
├── tailwind.config.ts
├── postcss.config.js
├── cli.ts                           # Genie's CLI
├── .env.example
├── .gitignore
├── README.md
├── src/
│   ├── app/
│   │   ├── layout.tsx
│   │   ├── page.tsx
│   │   ├── globals.css
│   │   └── api/
│   │       ├── call/route.ts
│   │       ├── context/route.ts
│   │       ├── dtmf/route.ts
│   │       ├── hangup/route.ts
│   │       ├── takeover/route.ts
│   │       ├── status/route.ts
│   │       └── transcript/route.ts  # SSE
│   ├── components/
│   │   ├── CallPanel.tsx
│   │   ├── DTMFPad.tsx
│   │   ├── Transcript.tsx
│   │   ├── TakeoverButton.tsx
│   │   └── ChatInput.tsx
│   ├── hooks/
│   │   └── useCallStatus.ts
│   └── lib/
│       ├── elevenlabs.ts            # Outbound call + monitor WS + commands
│       ├── twilio-server.ts         # DTMF fallback only
│       ├── session.ts               # In-memory state + transcript
│       └── config.ts                # Env vars
```
