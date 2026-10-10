/**
 * Session persistence — auto-save every mikro run to ~/.mikro/sessions/<runId>/.
 *
 * Each session directory contains:
 *   meta.json        — run metadata (runId, query, context, timestamp, version)
 *   usage.json       — token usage and cost statistics
 *   answer.txt       — final answer text
 *   config.yaml      — snapshot of the MikroConfig used
 *   trajectory.jsonl  — copy of the JSONL log (if --log was specified)
 */
/** Data required to persist a session. */
export interface SessionData {
    runId: string;
    query: string;
    contextPath: string | null;
    model: string;
    answer: string;
    usage: {
        inputTokens: number;
        outputTokens: number;
        cachedTokens: number;
        totalCost: number;
        iterations: number;
        timeMs: number;
        model: string;
    };
    config: Record<string, unknown>;
    logPath: string | null;
}
/**
 * Save session artifacts to ~/.mikro/sessions/<runId>/.
 * Returns the session directory path.
 */
export declare function saveSession(data: SessionData): Promise<string>;
//# sourceMappingURL=session.d.ts.map