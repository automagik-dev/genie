/**
 * Batch processing engine for bulk interrogation against cached corpus.
 *
 * Reads questions from a file (one per line), runs each through rlmLoop
 * with cache enabled, and outputs JSONL to stdout with per-question results
 * and a final aggregate stats line.
 */
import { type RLMOptions } from "./rlm.js";
import type { MikroConfig } from "./config.js";
import type { LoadedContext } from "./context.js";
export interface BatchOptions extends Partial<RLMOptions> {
    maxCost?: number;
    parallel?: number;
    /** Use Gemini Batch API for 50% cost reduction. Requires provider: google. */
    batchApi?: boolean;
    /** When true, use pgserve storage for large context handling. */
    storageMode?: boolean;
}
/**
 * Run a batch of questions from a file against the RLM loop.
 *
 * Each question is run with cache enabled so context is shared across all
 * questions via provider-level prompt caching. Results are emitted as JSONL
 * to stdout (one JSON object per line), with a final aggregate stats line.
 */
export declare function runBatch(questionsFile: string, context: LoadedContext | null, config: MikroConfig, options?: BatchOptions): Promise<void>;
//# sourceMappingURL=batch.d.ts.map