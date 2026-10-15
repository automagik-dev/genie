import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Microagent } from "../agents.js";
import type { BackendRequest } from "../backend.js";
export declare const PI_TOOL_NAMES: readonly ["read", "grep", "glob", "git", "emit_done"];
/** Pi never imports agent plugins or executes TOOLS.md Python functions. */
export declare function checkPiTools(agent: Microagent | undefined, request: Pick<BackendRequest, "config">): string | undefined;
export declare function createScopedPiTools(agent: Microagent | undefined, request: BackendRequest): Promise<ToolDefinition[]>;
//# sourceMappingURL=pi-tools.d.ts.map