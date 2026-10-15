export interface JevCandidate {
    readonly id: string;
    readonly text: string;
    readonly source: string;
}
export interface JevNoulQuestion {
    instructions: string;
    criteria?: {
        true?: string;
        false?: string;
    };
}
export interface JevScoreQuestion {
    instructions: string;
    criteria: readonly string[];
}
export interface JevExtractionRequest {
    endpoint: string;
    model: string;
    apiKey: string;
    state: unknown;
    /** Optional JSON-serializable local provenance; never transmitted. Defaults to evaluated state. */
    sourceSnapshot?: unknown;
    candidates: readonly JevCandidate[];
    signal?: AbortSignal;
    noul?: JevNoulQuestion;
    score?: JevScoreQuestion;
}
export interface JevChoiceAnswer {
    type: "choice";
    choice: string;
    probabilities: Record<string, number>;
    confidence: number;
}
export interface JevNoulAnswer {
    type: "noul";
    noul: number;
}
export interface JevScoreAnswer {
    type: "score";
    score: number;
    legend: Record<string, string>;
    probabilities: Record<string, number>;
    confidence: number;
}
export interface JevExtractionResult {
    model: string;
    answers: {
        selection: JevChoiceAnswer;
        noul?: JevNoulAnswer;
        score?: JevScoreAnswer;
    };
    usage: {
        input_tokens: number;
        output_tokens: number;
    };
    selection: {
        kind: "selected";
        candidate: JevCandidate;
    } | {
        kind: "abstained";
    };
    /** Local snapshot, not text generated or echoed by JEV. Source references never enter criteria. */
    candidates: readonly JevCandidate[];
    readonly sourceSnapshot: unknown;
}
export type JevErrorCode = "request" | "cancelled" | "transport" | "http" | "response";
export declare class JevExtractionError extends Error {
    readonly code: JevErrorCode;
    readonly status?: number | undefined;
    constructor(code: JevErrorCode, status?: number | undefined);
}
/** Explicit trusted manual caller only: caller must sanitize/redact state and candidate text before calling. */
export declare function extractWithJev(request: JevExtractionRequest): Promise<JevExtractionResult>;
//# sourceMappingURL=jev.d.ts.map