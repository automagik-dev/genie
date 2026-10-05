/**
 * SDK public surface — Wish B Groups 1 + 2 cumulative.
 *
 * Group 1 shipped event types + emitter.
 * Group 2 adds session / permissions / validate primitives + session
 * lifecycle events. `runAgent()` wiring lands in a later slice per
 * `.genie/wishes/rlmx-sdk-upgrade/WISH.md`.
 */
export { ALL_AGENT_EVENT_TYPES, WISH_SPEC_EVENT_TYPES, isAgentEvent, iso, makeEvent, } from "./events.js";
export type { AgentEvent, AgentEventType, AgentStartEvent, EmitDoneEvent, ErrorEvent, IterationOutputEvent, IterationStartEvent, MessageEvent, RecurseEvent, SessionCloseEvent, SessionCloseReason, SessionOpenEvent, ToolCallAfterEvent, ToolCallBeforeEvent, ToolCallObservationEvent, ToolCallObservationStatus, ValidationEvent, } from "./events.js";
export { createEmitter } from "./emitter.js";
export type { EmitterAndStream, EventEmitter, EventStream, } from "./emitter.js";
export { createRecursionBridge } from "./recursion-bridge.js";
export type { ChildEndData, ChildStartData, RecursionBridge, RecursionBridgeContext, } from "./recursion-bridge.js";
export { createFileSessionStore, isSessionState, pauseAgent, resumeAgent, } from "./session.js";
export type { BudgetSnapshot, HistoryTurn, SessionState, SessionStore, } from "./session.js";
export { ALLOW, composeHooks, runPermissionChain } from "./permissions.js";
export type { PermissionDecision, PermissionHook, PermissionHookContext, } from "./permissions.js";
export { MAX_VALIDATE_ATTEMPTS, buildRetryHint, parseValidateMd, shouldRetry, validateAgainstSchema, } from "./validate.js";
export type { ValidateResult, ValidateSchema } from "./validate.js";
export { runAgent } from "./agent.js";
export type { AgentConfig, IterationDriver, IterationRequest, IterationStep, ToolCallOutcome, ToolResolver, } from "./agent.js";
export { formatRlmPrompt, NoExposableToolsError, rlmDriver, } from "./rlm-driver.js";
export type { RlmDriverConfig, RlmDriverToolsConfig, } from "./rlm-driver.js";
export { loadAgentSpec, parseAgentSpec, resolveAgentPath, } from "./agent-spec.js";
export type { AgentBudget, AgentScope, AgentSpec } from "./agent-spec.js";
export { createToolRegistry, toolRegistryAsResolver, UnknownToolError, } from "./tool-registry.js";
export type { ToolContext, ToolHandler, ToolRegistry, ToolSchema } from "./tool-registry.js";
export { InvalidPluginError, MissingPluginError, loadPluginTools, } from "./tool-loader.js";
export type { LoadOptions, LoadResult } from "./tool-loader.js";
export { DEFAULT_PYTHON_BIN, DEFAULT_TIMEOUT_MS as PYTHON_DEFAULT_TIMEOUT_MS, loadPythonPlugins, makePythonPluginHandler, PythonPluginError, PythonPluginTimeoutError, } from "./python-plugin.js";
export type { PythonLoadResult, PythonPluginExecResult, PythonPluginOptions, } from "./python-plugin.js";
export { createMetricsRecorder } from "./metrics.js";
export type { IterationMetrics, MetricsRecorder } from "./metrics.js";
//# sourceMappingURL=index.d.ts.map