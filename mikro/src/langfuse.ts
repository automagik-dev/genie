/**
 * Minimal Langfuse ingestion recorder for recursive RLM tree observability.
 *
 * This deliberately uses the public ingestion API directly instead of adding a
 * heavyweight SDK dependency. Missing env/config makes the recorder a no-op.
 */

import { randomUUID } from "node:crypto";
import type { UsageStats } from "./llm.js";

export interface LangfuseConfig {
  host?: string;
  publicKey?: string;
  secretKey?: string;
  fetchImpl?: typeof fetch;
  flushTimeoutMs?: number;
}

interface LangfuseEvent {
  id: string;
  type: string;
  timestamp: string;
  body: Record<string, unknown>;
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

export class LangfuseTraceRecorder {
  private host: string | null;
  private publicKey: string | null;
  private secretKey: string | null;
  private fetchImpl: typeof fetch;
  private flushTimeoutMs: number;
  private traceId: string | null = null;
  private queue: LangfuseEvent[] = [];

  constructor(config: LangfuseConfig = {}) {
    this.host = (config.host ?? process.env.LANGFUSE_HOST ?? "").replace(/\/$/, "") || null;
    this.publicKey = config.publicKey ?? process.env.LANGFUSE_PUBLIC_KEY ?? null;
    this.secretKey = config.secretKey ?? process.env.LANGFUSE_SECRET_KEY ?? null;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.flushTimeoutMs = config.flushTimeoutMs ?? 5_000;
  }

  get enabled(): boolean {
    return !!(this.host && this.publicKey && this.secretKey);
  }

  startTrace(data: { runId: string; query: string; model: string; userId?: string; metadata?: Record<string, unknown> }): void {
    if (!this.enabled) return;
    this.traceId = data.runId;
    this.enqueue("trace-create", {
      id: data.runId,
      name: "mikro recursive run",
      input: data.query,
      userId: data.userId,
      sessionId: data.runId,
      metadata: {
        organ: "mikro",
        model: data.model,
        ...(data.metadata ?? {}),
      },
      tags: ["mikro", "recursive-tree"],
    });
  }

  rootGenerationStart(data: RootGenerationStartData): string {
    const generationId = randomUUID();
    if (!this.enabled) return generationId;
    this.enqueue("generation-create", {
      id: generationId,
      traceId: this.traceId,
      name: data.name,
      model: data.model,
      input: data.input,
      startTime: new Date().toISOString(),
      metadata: {
        event: "root_generation_start",
        iteration: data.iteration,
      },
    });
    return generationId;
  }

  rootGenerationEnd(generationId: string, data: RootGenerationEndData): void {
    if (!this.enabled) return;
    const input = data.usage?.inputTokens ?? 0;
    const output = data.usage?.outputTokens ?? 0;
    const cacheRead = data.usage?.cacheReadTokens ?? 0;
    const cacheWrite = data.usage?.cacheWriteTokens ?? 0;
    this.enqueue("generation-update", {
      id: generationId,
      output: data.output,
      endTime: new Date().toISOString(),
      level: data.isError ? "ERROR" : "DEFAULT",
      statusMessage: data.errorMessage,
      usage: {
        input,
        output,
        total: input + output + cacheRead + cacheWrite,
      },
      usageDetails: {
        input,
        output,
        cache_read: cacheRead,
        cache_write: cacheWrite,
        total: input + output + cacheRead + cacheWrite,
      },
      costDetails: {
        total: data.usage?.totalCost ?? 0,
      },
      metadata: {
        event: "root_generation_end",
        duration_ms: data.durationMs,
        input_tokens: input,
        output_tokens: output,
        cache_read_tokens: cacheRead,
        cache_write_tokens: cacheWrite,
        total_cost: data.usage?.totalCost ?? 0,
        llm_calls: data.usage?.llmCalls ?? 0,
      },
    });
  }

  childStart(data: {
    parentRunId: string;
    childRunId?: string;
    correlationId: string;
    prompt: string;
    depth: number;
  }): string {
    const spanId = randomUUID();
    if (!this.enabled) return spanId;
    const traceId = this.traceId ?? data.parentRunId;
    this.enqueue("span-create", {
      id: spanId,
      traceId,
      name: "rlm_query child",
      input: data.prompt,
      metadata: {
        event: "child_start",
        parent_run_id: data.parentRunId,
        child_run_id: data.childRunId ?? null,
        child_correlation_id: data.correlationId,
        recursion_depth: data.depth,
      },
    });
    return spanId;
  }

  childEnd(spanId: string, data: {
    childRunId?: string;
    answerPreview: string;
    durationMs: number;
    usage?: UsageStats;
    isError?: boolean;
    errorMessage?: string;
  }): void {
    if (!this.enabled) return;
    this.enqueue("span-update", {
      id: spanId,
      output: data.answerPreview,
      endTime: new Date().toISOString(),
      level: data.isError ? "ERROR" : "DEFAULT",
      statusMessage: data.errorMessage,
      metadata: {
        event: "child_end",
        child_run_id: data.childRunId ?? null,
        duration_ms: data.durationMs,
        input_tokens: data.usage?.inputTokens ?? 0,
        output_tokens: data.usage?.outputTokens ?? 0,
        cache_read_tokens: data.usage?.cacheReadTokens ?? 0,
        cache_write_tokens: data.usage?.cacheWriteTokens ?? 0,
        total_cost: data.usage?.totalCost ?? 0,
        llm_calls: data.usage?.llmCalls ?? 0,
      },
    });
  }

  async flush(): Promise<void> {
    if (!this.enabled || this.queue.length === 0) return;
    const batch = this.queue.splice(0, this.queue.length);
    const auth = Buffer.from(`${this.publicKey}:${this.secretKey}`).toString("base64");
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => abortController.abort(), this.flushTimeoutMs);
    try {
      const res = await this.fetchImpl(`${this.host}/api/public/ingestion`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Basic ${auth}`,
        },
        body: JSON.stringify({ batch }),
        signal: abortController.signal,
      });
      if (!res.ok) {
        throw new Error(`Langfuse ingestion failed: ${res.status} ${await res.text().catch(() => "")}`.trim());
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`Langfuse ingestion timed out after ${this.flushTimeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  private enqueue(type: string, body: Record<string, unknown>): void {
    this.queue.push({
      id: randomUUID(),
      type,
      timestamp: new Date().toISOString(),
      body,
    });
  }
}
