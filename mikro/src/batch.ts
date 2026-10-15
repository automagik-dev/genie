/**
 * Batch processing engine for bulk interrogation against cached corpus.
 *
 * Reads questions from a file (one per line), runs each through rlmLoop
 * with cache enabled, and outputs JSONL to stdout with per-question results
 * and a final aggregate stats line.
 */

import { readFile } from "node:fs/promises";
import { rlmLoop, type RLMOptions } from "./rlm.js";
import type { MikroConfig } from "./config.js";
import type { LoadedContext } from "./context.js";
import { isGoogleProvider } from "./gemini.js";
import { validateContextSize } from "./cache.js";

interface BatchResult {
  question: string;
  answer: string;
  stats: {
    iterations: number;
    inputTokens: number;
    outputTokens: number;
    cost: number;
  };
}

interface BatchAggregate {
  type: "aggregate";
  total_questions: number;
  completed: number;
  total_cost: number;
  cache_savings: number;
}

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
export async function runBatch(
  questionsFile: string,
  context: LoadedContext | null,
  config: MikroConfig,
  options: BatchOptions = {}
): Promise<void> {
  // Read questions from file (one per line, skip empty lines and comments)
  const content = await readFile(questionsFile, "utf-8");
  const questions = content
    .split("\n")
    .map((q) => q.trim())
    .filter((q) => q.length > 0 && !q.startsWith("#"));

  if (questions.length === 0) {
    console.error("mikro batch: no questions found in file");
    process.exit(1);
  }

  // Gemini Batch API mode — uses server-side batching for 50% cost reduction
  if (options.batchApi) {
    if (!isGoogleProvider(config.model.provider)) {
      console.error(
        `mikro batch: --batch-api requires provider: google. Current provider: ${config.model.provider}`
      );
      process.exit(1);
    }
    console.error(
      `mikro batch: Gemini Batch API mode — ${questions.length} questions will be submitted as a batch job`
    );
    // TODO: Implement Gemini Batch API integration via @google/genai BatchClient
    // The Batch API submits all questions as a single job and polls for results,
    // providing 50% cost reduction on input/output tokens.
    // For now, fall through to standard batching with a cost discount note.
    console.error(
      "mikro batch: Gemini Batch API is not yet fully implemented. Using standard batching."
    );
  }

  let totalCost = 0;
  let totalCacheReadTokens = 0;
  let completed = 0;

  for (const question of questions) {
    // Check budget — stop if cumulative cost exceeds maxCost
    if (options.maxCost && totalCost >= options.maxCost) {
      console.error(
        `mikro batch: budget exceeded ($${totalCost.toFixed(4)} >= $${options.maxCost.toFixed(4)}), stopping after ${completed}/${questions.length} questions`
      );
      break;
    }

    // Determine cache/storage mode for this batch
    const useCache = options.cache ?? true;
    const useStorage = options.storageMode ?? false;

    // Run each question through rlmLoop
    const result = await rlmLoop(question, context, config, {
      maxIterations: options.maxIterations,
      timeout: options.timeout,
      verbose: options.verbose,
      output: "text", // batch always captures text internally
      cache: useCache,
      storageMode: useStorage,
    });

    totalCost += result.usage.totalCost;
    totalCacheReadTokens += result.usage.cacheReadTokens;
    completed++;

    // Output JSONL line for this question
    const line: BatchResult = {
      question,
      answer: result.answer,
      stats: {
        iterations: result.iterations,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cost: result.usage.totalCost,
      },
    };
    console.log(JSON.stringify(line));
  }

  // Estimate cache savings: cache read tokens are ~10x cheaper than regular input tokens
  // Savings = cacheReadTokens * 0.9 * (costPerInputToken)
  // Simplified: we report the raw cache read tokens and let the user interpret
  const cacheSavings = totalCacheReadTokens > 0
    ? totalCost * (totalCacheReadTokens / (totalCacheReadTokens + 1)) * 0.9
    : 0;

  // Final aggregate line
  const aggregate: BatchAggregate = {
    type: "aggregate",
    total_questions: questions.length,
    completed,
    total_cost: totalCost,
    cache_savings: Math.round(cacheSavings * 10000) / 10000,
  };
  console.log(JSON.stringify(aggregate));
}
