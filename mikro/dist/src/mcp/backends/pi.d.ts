import type { Microagent } from "../agents.js";
import { type BackendRequest, type MicroagentResult, type RuntimeBackend } from "../backend.js";
/** A protocol-free Pi run, not the RLM driver or an ambient Pi CLI session. */
export declare class PiBackend implements RuntimeBackend {
    run(agent: Microagent | undefined, request: BackendRequest, emit: (message: string) => void): Promise<MicroagentResult>;
}
//# sourceMappingURL=pi.d.ts.map