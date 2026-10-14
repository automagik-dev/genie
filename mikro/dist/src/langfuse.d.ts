/**
 * Minimal Langfuse ingestion recorder for recursive RLM tree observability.
 *
 * This deliberately uses the public ingestion API directly instead of adding a
 * heavyweight SDK dependency. Missing env/config makes the recorder a no-op.
 */
import type { UsageStats } from "./llm.js";
export interface LangfuseConfig {
    host?: string;
    publicKey?: string;
    secretKey?: string;
    fetchImpl?: typeof fetch;
    flushTimeoutMs?: number;
}
export interface RootGenerationStartData {
    name: string;
    input: unknown;
    model: string;
    iteration: number;
}
export interface RootGenerationEndData {
    output: unknown;
    durationMs: number;
    usage?: UsageStats;
    isError?: boolean;
    errorMessage?: string;
}
export declare class LangfuseTraceRecorder {
    private host;
    private publicKey;
    private secretKey;
    private fetchImpl;
    private flushTimeoutMs;
    private traceId;
    private queue;
    constructor(config?: LangfuseConfig);
    get enabled(): boolean;
    startTrace(data: {
        runId: string;
        query: string;
        model: string;
        userId?: string;
        metadata?: Record<string, unknown>;
    }): void;
    rootGenerationStart(data: RootGenerationStartData): string;
    rootGenerationEnd(generationId: string, data: RootGenerationEndData): void;
    childStart(data: {
        parentRunId: string;
        childRunId?: string;
        correlationId: string;
        prompt: string;
        depth: number;
    }): string;
    childEnd(spanId: string, data: {
        childRunId?: string;
        answerPreview: string;
        durationMs: number;
        usage?: UsageStats;
        isError?: boolean;
        errorMessage?: string;
    }): void;
    flush(): Promise<void>;
    private enqueue;
}
//# sourceMappingURL=langfuse.d.ts.map