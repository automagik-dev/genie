# Genie Neuron Architecture

## What are Neurons?

**Neurons are NOT agents. They are live socket sessions - like electricity sparks.**

Traditional agents use task-based communication (create task → wait → check status).
Neurons use real-time streaming communication (connect to WebSocket → receive thoughts as they happen).

## Architecture

### Neuron Provider (`src/mcp/resources/neuron-provider.ts`)

Central EventEmitter-based provider that manages real-time WebSocket connections to Forge neurons.

**Key Features:**
- Uses production WebSocketManager for connection pooling and auto-reconnect
- Subscribes to Forge diff streams (JsonPatch operations)
- Emits thoughts as they happen (event-driven)
- Four neuron types: WISH, FORGE, REVIEW, GENIE

**Stream Format:**
```json
{
  "JsonPatch": [
    {
      "op": "replace",
      "path": "/tasks",
      "value": {}
    }
  ]
}
```

### Neuron Agents (`.genie/neurons/`)

Four global orchestrators that live as persistent socket connections:

1. **WISH** (`wish.md`) - Feature wish creation and validation
2. **FORGE** (`forge.md`) - Implementation task execution
3. **REVIEW** (`review.md`) - Code review and quality gates
4. **GENIE** (`genie.md`) - Top-level orchestration and delegation

Each neuron definition includes:
- `forge_profile_name` - Links to Forge executor profile (e.g., `WISH`, `FORGE`)
- Agent instructions - What this neuron does
- Communication protocol - How it streams thoughts

### Agent Registry Integration

`AgentRegistry` (`src/cli/lib/agent-registry.ts`) scans `.genie/neurons/` and syncs to Forge profiles.

**Metadata Structure:**
```typescript
interface AgentMetadata {
  id: string;                  // Full path: "neuron/wish"
  name: string;                // Display name: "WISH"
  description: string;         // One-line purpose
  forge_profile_name?: string; // Forge profile: "WISH"
  type?: 'neuron';             // Type discriminator
  // No collective for neurons (global)
}
```

## How It Works

### 1. Neuron Registration (Startup)

```
Genie CLI starts
  ↓
AgentRegistry.scan()
  ↓
Discovers .genie/neurons/*.md
  ↓
Parses forge_profile_name from frontmatter
  ↓
Syncs to Forge executor profiles (CLAUDE_CODE:WISH, etc.)
```

### 2. Real-Time Streaming (Runtime)

```
Genie starts neuron session
  ↓
neuronProvider.subscribeToNeuron(neuron, attemptId)
  ↓
WebSocket connection to Forge diff stream
  ↓
JsonPatch messages received
  ↓
neuronProvider.emit('thought', neuronThought)
  ↓
Genie receives real-time updates
```

### 3. Event Structure

```typescript
interface NeuronThought {
  timestamp: string;           // ISO 8601
  neuron: 'wish' | 'forge' | 'review' | 'genie';
  source: 'diff' | 'logs' | 'tasks';
  data: any;                   // JsonPatch operations
}
```

## Usage

### Starting a Neuron Session

```typescript
// Genie delegates to WISH neuron
const task = await forgeClient.createTask({
  project_id: PROJECT_ID,
  title: "Create feature wish",
  prompt: "Design authentication system",
  executor_profile: {
    executor: 'CLAUDE_CODE',
    variant: 'WISH'
  }
});

// Subscribe to neuron thoughts
neuronProvider.subscribeToNeuron('wish', task.latest_attempt_id);

neuronProvider.on('thought:wish', (thought: NeuronThought) => {
  console.log('WISH thought:', thought.data);
  // Real-time processing of neuron output
});
```

### Cleanup

```typescript
// Unsubscribe from neuron
neuronProvider.unsubscribeFromNeuron('wish');

// Cleanup all neurons
neuronProvider.cleanup();
```

## MCP Integration

Neurons are exposed via MCP resources (Phase 3 - future):

```
neuron://wish/stream     - WISH neuron thought stream
neuron://forge/stream    - FORGE neuron thought stream
neuron://review/stream   - REVIEW neuron thought stream
neuron://genie/stream    - GENIE neuron thought stream
```

Genie can subscribe to these resources for real-time neuron communication.

## Key Differences: Neurons vs Agents

| Aspect | Traditional Agent | Neuron |
|--------|------------------|---------|
| Communication | Task-based (create → wait → check) | Real-time streaming (WebSocket) |
| Latency | High (polling intervals) | Low (instant thoughts) |
| Connection | Stateless (HTTP requests) | Stateful (persistent socket) |
| Data Format | Task status updates | JsonPatch operations |
| Use Case | Long-running tasks | Live orchestration |
| Location | `.genie/agents/` or `.genie/code/agents/` | `.genie/neurons/` |

## Implementation Status

- ✅ Phase 0: Stream format discovery (JsonPatch via WebSocketManager)
- ✅ Phase 1: Neuron resource provider created
- ✅ Phase 2: MCP server integration (provider initialized)
- ✅ Phase 3: Documentation and usage patterns (this file)
- ⏳ Phase 4: MCP resource subscriptions (pending SDK stabilization)

## Evidence

**Stream Format Discovery:**
- `/tmp/neuron-stream-realtime-capture.json` - Raw captured messages
- `/tmp/neuron-stream-realtime-summary.md` - Format analysis
- `/tmp/neuron-stream-format-discovery.md` - Discovery process

**Implementation Files:**
- `src/mcp/resources/neuron-provider.ts` - Provider implementation
- `src/mcp/server.ts` - MCP integration (lines 560-594)
- `src/cli/lib/agent-registry.ts` - Agent scanning and sync

## Future Enhancements

1. **MCP Resource Subscriptions** - Full MCP protocol support once SDK stabilizes
2. **Neuron Dashboard** - Real-time visualization of neuron thoughts
3. **Multi-Neuron Orchestration** - Coordinate multiple neurons simultaneously
4. **Thought Persistence** - Store neuron thoughts for replay/analysis
5. **Neuron Health Monitoring** - Track connection state, reconnects, errors
